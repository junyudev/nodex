import { useIntl, type IntlShape } from "@/lib/i18n";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "motion/react";
import { NodexTooltip } from "@/components/ui/tooltip";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import type {
  CodexConversationChildMembership,
  CodexConversationItem,
} from "../../../../lib/types";
import { formatCodexModelLabel } from "../../../../lib/codex-thread-settings";
import {
  normalizeMultiAgentActionPayload,
  type CodexMultiAgentActionName,
  type CodexMultiAgentActionPayload,
  type CodexMultiAgentReceiverThread,
  type CodexMultiAgentActionStatus,
  type CodexMultiAgentAgentState,
} from "../../../../../shared/codex-transcript-special-items";
import type { ThreadOpenSubagentPayload, ThreadOpenThreadContext } from "../../thread-stage-types";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "./thread-motion";
import { useMeasuredElementHeight } from "./use-measured-element-height";
import { CodexShimmerText } from "./codex-shimmer-text";
import { SubagentGlyphIcon } from "./subagent-avatar";
import { ThreadActivityShell, ThreadRichActivityHeader } from "./tools/tool-primitives";

function getHeaderLabel(
  intl: IntlShape,
  action: CodexMultiAgentActionName,
  status: CodexMultiAgentActionStatus,
): string {
  if (status === "interrupted")
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.interrupted",
      defaultMessage: "Interrupted",
    });
  if (action === "spawnAgent") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.creating",
        defaultMessage: "Creating",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.created",
        defaultMessage: "Created",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.createError",
      defaultMessage: "Failed to create",
    });
  }
  if (action === "sendInput" || action === "sendMessage" || action === "followupTask") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.messaging",
        defaultMessage: "Messaging",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.messaged",
        defaultMessage: "Messaged",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.messageError",
      defaultMessage: "Failed to message",
    });
  }
  if (action === "resumeAgent") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.resuming",
        defaultMessage: "Resuming",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.resumed",
        defaultMessage: "Resumed",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.resumeError",
      defaultMessage: "Failed to resume",
    });
  }
  if (action === "closeAgent") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.closing",
        defaultMessage: "Closing",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.closed",
        defaultMessage: "Closed",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.closeError",
      defaultMessage: "Failed to close",
    });
  }
  if (action === "interruptAgent") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.interrupting",
        defaultMessage: "Interrupting",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.interrupted",
        defaultMessage: "Interrupted",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.interruptError",
      defaultMessage: "Failed to interrupt",
    });
  }
  if (action === "listAgents") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.listing",
        defaultMessage: "Listing",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.listed",
        defaultMessage: "Listed",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.listError",
      defaultMessage: "Failed to list",
    });
  }
  if (status === "inProgress")
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.waiting",
      defaultMessage: "Waiting",
    });
  if (status === "completed")
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.waited",
      defaultMessage: "Waited",
    });
  return intl.formatMessage({
    id: "conversation.multiAgentActionSurface.waitError",
    defaultMessage: "Failed to wait",
  });
}

function getRowActionLabel(
  intl: IntlShape,
  action: CodexMultiAgentActionName,
  status: CodexMultiAgentActionStatus,
): string {
  if (status === "interrupted")
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.interrupted",
      defaultMessage: "Interrupted",
    });
  if (action === "sendInput" || action === "sendMessage" || action === "followupTask") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.messaging",
        defaultMessage: "Messaging",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.messaged",
        defaultMessage: "Messaged",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.rowMessageError",
      defaultMessage: "Failed messaging",
    });
  }
  if (action === "spawnAgent") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.creating",
        defaultMessage: "Creating",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.created",
        defaultMessage: "Created",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.rowCreateError",
      defaultMessage: "Failed creating",
    });
  }
  if (action === "resumeAgent") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.resuming",
        defaultMessage: "Resuming",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.resumed",
        defaultMessage: "Resumed",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.rowResumeError",
      defaultMessage: "Failed resuming",
    });
  }
  if (action === "closeAgent") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.closing",
        defaultMessage: "Closing",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.closed",
        defaultMessage: "Closed",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.rowCloseError",
      defaultMessage: "Failed closing",
    });
  }
  if (action === "interruptAgent") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.interrupting",
        defaultMessage: "Interrupting",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.interrupted",
        defaultMessage: "Interrupted",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.interruptError",
      defaultMessage: "Failed to interrupt",
    });
  }
  if (action === "listAgents") {
    if (status === "inProgress")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.listing",
        defaultMessage: "Listing",
      });
    if (status === "completed")
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.listed",
        defaultMessage: "Listed",
      });
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.listError",
      defaultMessage: "Failed to list",
    });
  }
  if (status === "inProgress")
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.waiting",
      defaultMessage: "Waiting",
    });
  if (status === "completed")
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.waited",
      defaultMessage: "Waited",
    });
  return intl.formatMessage({
    id: "conversation.multiAgentActionSurface.rowWaitError",
    defaultMessage: "Failed waiting",
  });
}

function getPromptSendInputActionLabel(
  intl: IntlShape,
  status: CodexMultiAgentActionStatus,
): string {
  if (status === "interrupted")
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.interrupted",
      defaultMessage: "Interrupted",
    });
  if (status === "inProgress")
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.messaging",
      defaultMessage: "Messaging",
    });
  if (status === "completed")
    return intl.formatMessage({
      id: "conversation.multiAgentActionSurface.messaged",
      defaultMessage: "Messaged",
    });
  return intl.formatMessage({
    id: "conversation.multiAgentActionSurface.messageError",
    defaultMessage: "Failed to message",
  });
}

function getAgentStateLabel(intl: IntlShape, status: CodexMultiAgentAgentState["status"]): string {
  switch (status) {
    case "pendingInit":
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.pendingInit",
        defaultMessage: "pending init",
      });
    case "running":
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.stateRunning",
        defaultMessage: "running",
      });
    case "interrupted":
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.stateInterrupted",
        defaultMessage: "interrupted",
      });
    case "shutdown":
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.stateShutdown",
        defaultMessage: "shutdown",
      });
    case "completed":
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.stateCompleted",
        defaultMessage: "completed",
      });
    case "errored":
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.stateErrored",
        defaultMessage: "errored",
      });
    case "notFound":
      return intl.formatMessage({
        id: "conversation.multiAgentActionSurface.notFound",
        defaultMessage: "not found",
      });
  }
}

function getAgentDisplayName(receiverThread: CodexMultiAgentReceiverThread | undefined): string {
  return receiverThread?.thread?.nickname?.trim().replace(/^@/u, "") ?? "";
}

function getAgentRole(
  receiverThread: CodexMultiAgentReceiverThread | undefined,
  membership: CodexConversationChildMembership | undefined,
): string | null {
  const role =
    receiverThread?.thread?.agentRole?.trim() ??
    membership?.agentRole?.trim() ??
    membership?.thread?.agentRole?.trim();
  if (!role || role === "default") return null;
  return role;
}

function getAgentOpenStatus(
  state: CodexMultiAgentAgentState | undefined,
): ThreadOpenSubagentPayload["status"] {
  if (!state) return "done";
  if (state.status === "pendingInit") return "waiting";
  if (state.status === "running") return "active";
  return "done";
}

function normalizeNullableText(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function getAgentStateSuffix(
  intl: IntlShape,
  state: CodexMultiAgentAgentState | undefined,
): string {
  if (!state) return "";
  const stateLabel = getAgentStateLabel(intl, state.status);
  const message = state.message?.trim() ?? "";
  if (message.length === 0)
    return intl.formatMessage(
      { id: "conversation.multiAgentActionSurface.state", defaultMessage: " ({state})" },
      { state: stateLabel },
    );
  return intl.formatMessage(
    {
      id: "conversation.multiAgentActionSurface.stateWithDetail",
      defaultMessage: " ({state}: {message})",
    },
    { state: stateLabel, message },
  );
}

function listTargetThreadIds(payload: CodexMultiAgentActionPayload): string[] {
  return Array.from(
    new Set([
      ...payload.receiverThreads.map((entry) => entry.threadId),
      ...Object.keys(payload.agentsStates),
    ]),
  ).sort();
}

function countTargets(items: CodexMultiAgentActionPayload[]): number {
  const threadIds = new Set(items.flatMap((item) => listTargetThreadIds(item)));
  return threadIds.size > 0 ? threadIds.size : items.length;
}

function getCountLabel(intl: IntlShape, count: number): string {
  if (count <= 0) return "";
  return intl.formatMessage(
    {
      id: "conversation.multiAgentActionSurface.agentCount",
      defaultMessage: "{count, plural, one { an agent} other { # agents}}",
    },
    { count },
  );
}

function resolveGroupStatus(items: CodexMultiAgentActionPayload[]): CodexMultiAgentActionStatus {
  if (items.some((item) => item.status === "inProgress")) return "inProgress";
  if (items.some((item) => item.status === "failed")) return "failed";
  if (items.some((item) => item.status === "interrupted")) return "interrupted";
  return "completed";
}

interface MultiAgentRenderedRow {
  key: string;
  node: ReactNode;
}

type OpenMultiAgentThread = (
  threadId: string,
  context?: ThreadOpenThreadContext,
) => void | Promise<void>;

function getSpawnModelByThreadId(
  items: CodexMultiAgentActionPayload[],
  parentModel: string | null,
): Map<string, string> {
  const models = new Map<string, string>();
  for (const item of items) {
    const model = normalizeNullableText(item.model) ?? normalizeNullableText(parentModel);
    if (item.action !== "spawnAgent" || !model) continue;

    for (const { threadId: targetThreadId } of item.receiverThreads) {
      const threadId = targetThreadId.trim();
      if (threadId.length === 0) continue;
      models.set(threadId, model);
    }
  }
  return models;
}

function AgentLabel({
  membership,
  onOpenThread,
  receiverThread,
  spawnModel,
  state,
  threadId,
}: {
  membership: CodexConversationChildMembership | undefined;
  onOpenThread?: OpenMultiAgentThread;
  receiverThread: CodexMultiAgentReceiverThread | undefined;
  spawnModel: string | null;
  state: CodexMultiAgentAgentState | undefined;
  threadId: string;
}) {
  const intl = useIntl();
  const displayName = getAgentDisplayName(receiverThread);
  const role = getAgentRole(receiverThread, membership);
  const resolvedSpawnModel = spawnModel;
  const modelLabel = resolvedSpawnModel ? formatCodexModelLabel(resolvedSpawnModel, []) : null;
  const label = onOpenThread ? (
    <NodexTooltip
      disabled={modelLabel === null}
      tooltipContent={
        modelLabel === null
          ? null
          : intl.formatMessage(
              {
                id: "conversation.multiAgentActionSurface.usesModel",
                defaultMessage: "Uses {model}",
              },
              { model: modelLabel },
            )
      }
    >
      <button
        type="button"
        aria-label={intl.formatMessage(
          {
            id: "conversation.multiAgentActionSurface.openSubagent",
            defaultMessage: "Open subagent {name}",
          },
          { name: displayName },
        )}
        className="cursor-interaction bg-transparent p-0 align-baseline font-medium"
        data-testid="multi-agent-action-agent-button"
        onClick={() => {
          void onOpenThread(threadId, {
            subagent: {
              agentRole: role,
              conversationId: threadId,
              diffStats: null,
              displayName,
              spawnModel: resolvedSpawnModel,
              status: getAgentOpenStatus(state),
              statusSummary: state?.message ?? null,
            },
          });
        }}
      >
        {displayName}
      </button>
    </NodexTooltip>
  ) : (
    <span className="font-medium">{displayName}</span>
  );

  return (
    <span data-testid="multi-agent-action-agent">
      {label}
      {role ? <span>{` (${role})`}</span> : null}
    </span>
  );
}

function useElementOverflow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return undefined;

    const update = () => {
      setOverflows(element.scrollWidth - element.clientWidth > 1);
    };
    update();

    const mutation = new MutationObserver(update);
    mutation.observe(element, { childList: true, characterData: true, subtree: true });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(element);
    return () => {
      mutation.disconnect();
      observer?.disconnect();
    };
  }, [ref]);

  return overflows;
}

function InlinePrompt({ prompt }: { prompt: string }) {
  const promptRef = useRef<HTMLSpanElement | null>(null);
  const overflows = useElementOverflow(promptRef);
  const promptNode = (
    <span
      ref={promptRef}
      className="min-w-0 flex-1 truncate text-token-conversation-summary-trailing"
      data-testid="multi-agent-action-inline-prompt"
    >
      {prompt}
    </span>
  );

  return (
    <NodexTooltip
      tooltipContent={<span className="whitespace-pre-wrap">{prompt}</span>}
      disabled={!overflows}
    >
      {promptNode}
    </NodexTooltip>
  );
}

function InlineRow({ children }: { children: ReactNode }) {
  return (
    <span className="flex min-w-0 items-baseline gap-1 overflow-hidden whitespace-nowrap">
      {children}
    </span>
  );
}

function getReceiverThreadMap(
  payload: CodexMultiAgentActionPayload,
): Map<string, CodexMultiAgentReceiverThread> {
  return new Map(payload.receiverThreads.map((entry) => [entry.threadId, entry]));
}

function getChildMembershipMap(
  childMemberships: readonly CodexConversationChildMembership[],
): Map<string, CodexConversationChildMembership> {
  return new Map(childMemberships.map((membership) => [membership.threadId, membership]));
}

function makeRowKey(
  prefix: string,
  item: CodexMultiAgentActionPayload,
  fallbackIndex: number,
  suffix?: string,
): string {
  const id = item.id ?? `${item.action}-${fallbackIndex}`;
  return suffix ? `${prefix}-${id}-${suffix}` : `${prefix}-${id}`;
}

function renderRows(
  intl: IntlShape,
  items: CodexMultiAgentActionPayload[],
  onOpenThread: OpenMultiAgentThread | undefined,
  childMemberships: readonly CodexConversationChildMembership[],
  parentModel: string | null,
): MultiAgentRenderedRow[] {
  const rows: MultiAgentRenderedRow[] = [];
  const spawnModelByThreadId = getSpawnModelByThreadId(items, parentModel);
  const childMembershipByThreadId = getChildMembershipMap(childMemberships);

  for (const [itemIndex, item] of items.entries()) {
    const receiverThreads = getReceiverThreadMap(item);
    const targetThreadIds = listTargetThreadIds(item).filter(
      (id) => getAgentDisplayName(receiverThreads.get(id)).length > 0,
    );
    const rawPrompt = item.prompt ?? "";
    const hasPrompt = rawPrompt.trim().length > 0;
    const isSpawnWithInstructions =
      item.action === "spawnAgent" && item.status === "completed" && hasPrompt;
    const isSendInputWithPrompt =
      (item.action === "sendInput" ||
        item.action === "sendMessage" ||
        item.action === "followupTask") &&
      hasPrompt;

    if (targetThreadIds.length === 0) {
      rows.push({
        key: makeRowKey("row-generic", item, itemIndex),
        node: getRowActionLabel(intl, item.action, item.status),
      });
      continue;
    }

    for (const threadId of targetThreadIds) {
      const agent = (
        <AgentLabel
          membership={childMembershipByThreadId.get(threadId)}
          onOpenThread={onOpenThread}
          receiverThread={receiverThreads.get(threadId)}
          spawnModel={spawnModelByThreadId.get(threadId) ?? null}
          state={item.agentsStates[threadId]}
          threadId={threadId}
        />
      );
      const stateSuffix =
        item.action === "closeAgent" || item.action === "resumeAgent"
          ? ""
          : getAgentStateSuffix(intl, item.agentsStates[threadId]);

      if (isSpawnWithInstructions) {
        rows.push({
          key: makeRowKey("row", item, itemIndex, threadId),
          node: (
            <InlineRow>
              {intl.formatMessage(
                {
                  id: "conversation.multiAgentActionSurface.createdWithInstructions",
                  defaultMessage:
                    "<label>Created</label> {agent} <label>with the instructions:</label> {prompt}",
                },
                {
                  label: (chunks) => <span>{chunks}</span>,
                  agent,
                  prompt: <InlinePrompt prompt={rawPrompt} />,
                },
              )}
            </InlineRow>
          ),
        });
        continue;
      }

      if (isSendInputWithPrompt) {
        rows.push({
          key: makeRowKey("row", item, itemIndex, threadId),
          node: (
            <InlineRow>
              <span>{getPromptSendInputActionLabel(intl, item.status)}</span> <span>{agent}: </span>
              <InlinePrompt prompt={rawPrompt} />
            </InlineRow>
          ),
        });
        continue;
      }

      rows.push({
        key: makeRowKey("row", item, itemIndex, threadId),
        node: (
          <>
            {getRowActionLabel(intl, item.action, item.status)} {agent}
            {stateSuffix}
          </>
        ),
      });
    }

    if (!isSpawnWithInstructions && !isSendInputWithPrompt && hasPrompt) {
      rows.push({
        key: makeRowKey("meta-prompt", item, itemIndex),
        node: (
          <>
            {intl.formatMessage({
              id: "conversation.multiAgentActionSurface.input",
              defaultMessage: "Input:",
            })}{" "}
            <span
              className="break-words whitespace-pre-wrap"
              data-testid="multi-agent-action-meta-prompt"
            >
              {rawPrompt}
            </span>
          </>
        ),
      });
    }
  }

  return rows;
}

const EMPTY_CHILD_MEMBERSHIPS: readonly CodexConversationChildMembership[] = [];

export function MultiAgentActionSurface({
  childMemberships = EMPTY_CHILD_MEMBERSHIPS,
  items,
  onOpenThread,
  parentModel = null,
}: {
  childMemberships?: readonly CodexConversationChildMembership[];
  items: CodexConversationItem[];
  parentModel?: string | null;
  onOpenThread?: OpenMultiAgentThread;
}) {
  const intl = useIntl();
  const [expanded, setExpanded] = useState(false);
  const reducedMotion = useResolvedReducedMotion();
  const { elementHeightPx, elementRef } = useMeasuredElementHeight();
  const normalizedItems = items
    .map((item) => normalizeMultiAgentActionPayload(item.rawItem))
    .filter(
      (item): item is CodexMultiAgentActionPayload => item !== null && item.action !== "wait",
    );
  if (normalizedItems.length === 0) return null;

  const primaryItem = normalizedItems[0];
  if (!primaryItem) return null;

  const resolvedStatus = resolveGroupStatus(normalizedItems);
  const isInProgress = resolvedStatus === "inProgress";
  const rowModels = renderRows(intl, normalizedItems, onOpenThread, childMemberships, parentModel);
  const targetCount = countTargets(normalizedItems);
  const countLabel = getCountLabel(intl, targetCount);

  const summary = (
    <span className="text-size-chat truncate text-token-conversation-summary-trailing">
      <CodexShimmerText
        active={isInProgress}
        className="text-token-conversation-summary-leading group-hover/activity-header:text-token-foreground"
      >
        {getHeaderLabel(intl, primaryItem.action, resolvedStatus)}
      </CodexShimmerText>
      {countLabel}
    </span>
  );
  const body = (
    <motion.div
      initial={false}
      animate={{
        height: expanded ? elementHeightPx : 0,
        opacity: expanded ? 1 : 0,
      }}
      transition={reducedMotion ? { duration: 0 } : CODEX_THREAD_ACCORDION_TRANSITION}
      className={expanded ? "overflow-visible" : "overflow-hidden"}
      style={{
        pointerEvents: expanded ? "auto" : "none",
        visibility: expanded ? "visible" : "hidden",
      }}
    >
      <div
        ref={expanded ? elementRef : null}
        className="flex flex-col gap-[var(--conversation-grouped-item-gap,4px)] pt-1"
        data-testid="multi-agent-action-rows"
      >
        {rowModels.map((row) => (
          <div
            key={row.key}
            className="text-token-conversation-body [&_*]:text-token-non-assistant-body-descendant text-size-chat min-w-0"
          >
            {row.node}
          </div>
        ))}
      </div>
    </motion.div>
  );

  return (
    <ThreadActivityShell
      body={body}
      header={
        <ThreadRichActivityHeader
          disclosure={{
            expanded,
            onToggle: () => setExpanded((current) => !current),
          }}
          icon={<SubagentGlyphIcon className="icon-xs shrink-0 text-token-conversation-body" />}
          summary={summary}
          testId="multi-agent-action-header"
        />
      }
    />
  );
}
