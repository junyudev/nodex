import {
  parseAutomationHeartbeatInput,
  parseAutomationHeartbeatReply,
  type AutomationHeartbeatReply,
} from "../../../../shared/automation-heartbeat";
import { projectCodexMarkdownToPlainText } from "../../../../shared/codex-markdown-text";
import type { CodexCanonicalItem } from "../../../../shared/types";
import type { CodexTranscriptTurnDetails } from "../../../../shared/codex-transcript-projection";
import type { VisibleConversationTurnEntry } from "../selectors";

export interface QuietHeartbeat {
  readonly message: string;
  readonly atMs: number | null;
}

export interface QuietHeartbeatGroup {
  readonly firstKey: string;
  readonly count: number;
  readonly latest: QuietHeartbeat;
}

function quietHeartbeat(
  reply: AutomationHeartbeatReply | null | undefined,
  atMs: number | null | undefined,
) {
  if (reply?.decision !== "DONT_NOTIFY") return null;
  return {
    message: reply.message || projectCodexMarkdownToPlainText(reply.body),
    atMs: typeof atMs === "number" && Number.isFinite(atMs) ? atMs : null,
  };
}

/** Derive the receipt from sparse addresses without materializing a transcript Turn. */
export function projectCanonicalQuietHeartbeat(
  details: CodexTranscriptTurnDetails,
  itemIds: readonly (string | undefined)[],
  readItem: (id: string) => CodexCanonicalItem | null,
): QuietHeartbeat | null {
  if (details.status !== "completed" || details.error) return null;

  const knownOpeningId = details.itemsPagination?.openingUserMessageId;
  const openingId = knownOpeningId === undefined ? itemIds[0] : knownOpeningId;
  const opening = openingId ? readItem(openingId) : undefined;
  if (
    !parseAutomationHeartbeatInput(details.params.input) &&
    !parseAutomationHeartbeatInput(details.itemsPagination?.oldestUserInput ?? []) &&
    !(opening?.type === "userMessage" && parseAutomationHeartbeatInput(opening.content))
  )
    return null;

  for (const id of itemIds.toReversed()) {
    if (!id) continue;
    const item = readItem(id);
    if (item?.type !== "agentMessage" || item.delivery === "async" || item.phase === "commentary")
      continue;
    const status = details.lifecycleStatusByItemId?.[id];
    if (status && status !== "completed") return null;
    return quietHeartbeat(
      parseAutomationHeartbeatReply(item.text),
      (opening?.type === "userMessage" ? opening.startedAtMs : undefined) ??
        details.turnStartedAtMs,
    );
  }
  return null;
}

export function projectVisibleQuietHeartbeat(
  entry: VisibleConversationTurnEntry,
): QuietHeartbeat | null {
  const { turn } = entry;
  if (turn.status !== "completed" || turn.errorMessage || entry.requests.length) return null;
  const opening = turn.items.find((item) => item.role === "user" && !item.hookFeedback);
  if (!opening?.heartbeatPrompt) return null;
  const reply = turn.items.findLast(
    (item) =>
      item.role === "assistant" && !item.asyncQuestion && item.assistantPhase !== "commentary",
  );
  if (reply?.status && reply.status !== "completed") return null;
  return quietHeartbeat(
    reply?.heartbeatReply,
    opening.startedAtMs ?? turn.turnStartedAtMs ?? turn.startedAt,
  );
}

/** Every non-beat row (including a history gap) breaks adjacency. */
export function groupQuietHeartbeats<T extends { readonly layoutKey: string }>(
  rows: readonly T[],
  readBeat: (row: T) => QuietHeartbeat | null,
): ReadonlyMap<string, QuietHeartbeatGroup> {
  const groups = new Map<string, QuietHeartbeatGroup>();
  let keys: string[] = [];
  let latest: QuietHeartbeat | null = null;
  function finishGroup() {
    if (keys.length > 1 && latest) {
      const group = { firstKey: keys[0]!, count: keys.length, latest };
      for (const key of keys) groups.set(key, group);
    }
    keys = [];
  }
  for (const row of rows) {
    const beat = readBeat(row);
    if (!beat) {
      finishGroup();
      continue;
    }
    keys.push(row.layoutKey);
    latest = beat;
  }
  finishGroup();
  return groups;
}
