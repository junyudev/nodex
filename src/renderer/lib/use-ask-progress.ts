import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { components } from "@nodex/core-protocol";
import { acquireAgentRuntimeConversationOwner } from "../features/local-conversation/agent-runtime-conversation-owner";
import type { CodexCanonicalItem } from "../../shared/codex-conversation-state/codex-conversation-state";
import { agentRuntimeRuntime } from "./agent-runtime-runtime";
import { classifyAskCommandStep } from "./ask-progress-command";
import { defineMessages, useIntl } from "./i18n";
import { spaceQueryKey } from "./renderer-space";

const STEP_LIMIT = 5;
const SLOT_LIMIT = 40;
const noop = () => {};
const noSubscription = () => noop;
const noRun = () => null;

const labels = defineMessages({
  tool: { id: "pageAsk.step.tool", defaultMessage: "Use a tool" },
  command: { id: "pageAsk.step.command", defaultMessage: "Run a command" },
  search: { id: "pageAsk.step.search", defaultMessage: "Search for evidence" },
  read: { id: "pageAsk.step.read", defaultMessage: "Read the Page" },
  query: { id: "pageAsk.step.query", defaultMessage: "Query data" },
  visual: { id: "pageAsk.step.visual", defaultMessage: "Check the Visual" },
  write: { id: "pageAsk.step.write", defaultMessage: "Edit the Page" },
  reply: { id: "pageAsk.step.reply", defaultMessage: "Reply in the Discussion" },
});

function stepLabel(item: CodexCanonicalItem): keyof typeof labels | null {
  switch (item.type) {
    case "fileChange":
      return "write";
    case "webSearch":
      return "search";
    case "commandExecution":
      return classifyAskCommandStep(item.command);
    case "mcpToolCall":
    case "dynamicToolCall":
      if (item.tool.endsWith("discussions_reply")) return "reply";
      if (/web_?(?:search|fetch)$/iu.test(item.tool)) return "search";
      if (/^(?:query|sql_query)$/u.test(item.tool)) return "query";
      if (/\bsearch\b|search_/u.test(item.tool)) return "search";
      if (/^(?:fetch|read|discussions_show)$/u.test(item.tool)) return "read";
      if (item.tool === "visual_check") return "visual";
      if (/^(?:update_page|patch|create_page)$/u.test(item.tool)) return "write";
      return "tool";
    default:
      return null;
  }
}

export interface AskProgress {
  readonly state: components["schemas"]["DiscussionAskState"] | null;
  readonly startedAt: number | null;
  readonly steps: readonly {
    readonly id: string;
    readonly label: string;
    readonly done: boolean;
  }[];
}

/** Live execution facts for a single Ask. Its persisted final state comes from the Discussion. */
export function useAskProgress({
  sessionId,
  runId,
}: {
  sessionId: string | null | undefined;
  runId: string | null | undefined;
}): AskProgress {
  const intl = useIntl();
  const target = useQuery({
    queryKey: spaceQueryKey(["askProgress", "execution", sessionId]),
    enabled: Boolean(sessionId && runId),
    queryFn: () => agentRuntimeRuntime.inspect({ sessionId: sessionId! }),
  }).data;
  const threadId = target?.threadId;
  const lease = useMemo(
    () =>
      sessionId && runId && threadId
        ? acquireAgentRuntimeConversationOwner({ sessionId, threadId })
        : null,
    [sessionId, runId, threadId],
  );
  useEffect(() => lease?.retain(), [lease]);

  const owner = lease?.owner;
  const transcript = owner?.readOwner;
  const readKey = useCallback(
    () =>
      transcript?.readStructure()?.turns.find((turn) => turn.value.details.turnId === runId)
        ?.entityKey ?? null,
    [runId, transcript],
  );
  const entityKey = useSyncExternalStore(transcript?.subscribeStructure ?? noSubscription, readKey);
  const subscribeTurn = useCallback(
    (listener: () => void) =>
      entityKey && transcript ? transcript.subscribeTurn(entityKey, listener) : noop,
    [entityKey, transcript],
  );
  const readVersion = useCallback(
    () => (entityKey ? (transcript?.readTurnVersion(entityKey) ?? 0) : 0),
    [entityKey, transcript],
  );
  const version = useSyncExternalStore(subscribeTurn, readVersion);
  const readRun = useCallback(
    () =>
      owner?.getSnapshot().conversation?.snapshot.projection.runs.find((run) => run.id === runId) ??
      null,
    [owner, runId],
  );
  const run = useSyncExternalStore(owner?.subscribe ?? noSubscription, owner ? readRun : noRun);

  const steps = useMemo(() => {
    if (!transcript || !entityKey || version !== transcript.readTurnVersion(entityKey)) return [];
    const slots = transcript.readItemSlots(entityKey)?.entries.slice(-SLOT_LIMIT) ?? [];
    const result: AskProgress["steps"][number][] = [];
    for (const { itemId } of slots.toReversed()) {
      const item = transcript.readItem(entityKey, itemId);
      const label = item && stepLabel(item);
      if (!item || !label) continue;
      result.unshift({
        id: itemId,
        label: intl.formatMessage(labels[label]),
        done: !("status" in item) || item.status !== "inProgress",
      });
      if (result.length === STEP_LIMIT) break;
    }
    return result;
  }, [entityKey, intl, transcript, version]);

  const state =
    run?.status === "queued"
      ? "queued"
      : run?.status === "waiting"
        ? "needs_you"
        : run?.status === "failed"
          ? "failed"
          : run?.status === "interrupted" || run?.status === "cancelled"
            ? "stopped"
            : run?.status === "completed" || run?.status === "rolled_back" || !run
              ? null
              : "working";
  const startedAt = run?.startedAt ? Date.parse(run.startedAt) : null;
  return { state, startedAt, steps };
}
