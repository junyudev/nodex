import { describe, expect, vi, test } from "vite-plus/test";
import { createElement, useLayoutEffect, useMemo, useSyncExternalStore } from "react";
import { act } from "@testing-library/react";
import { createCodexQueuedFollowUp } from "../../../shared/codex-queued-follow-up-state";
import { createCodexFirstSubmissionIdentity } from "../../../shared/codex-first-submission";
import type {
  CodexConnectionState,
  CodexConversationStateUpdate,
  CodexConversationItem,
  CodexConversationSnapshot,
  CodexEvent,
  CodexHostMessage,
  CodexProtocolRequestId,
  CodexQueueOwnerUpdateRequest,
  CodexQueuedFollowUpProjection,
  CodexSelectedSubagentHydrateResult,
  CodexSideChatStartResult,
  CodexSubagentOverviewWindow,
  CodexThreadStreamStateChange,
  CodexThreadSummary,
  CodexThreadHistoryEditResult,
} from "../../lib/types";
import type {
  ThreadGoal,
  ThreadSettings,
  Turn,
  TurnStartResponse,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexAppServerManager as CodexAppServerManagerInstance } from "./local-conversation-store";
import {
  applyCodexConversationStateUpdates,
  buildCodexConversationStateUpdates,
} from "../../../shared/codex-conversation-patches";
import {
  buildCodexThreadStreamCheckpoint,
  hashCodexConversationReplica,
} from "../../../shared/codex-owner-follower-replication";
import {
  createCodexCanonicalHydratedConversationState,
  type CodexCanonicalLiveTurnParams,
} from "../../../shared/codex-conversation-state/codex-conversation-state";
import { getCodexFileChangeList, getCodexFileChangePaths } from "../../../shared/codex-file-change";
import { render, settleAsyncRender, textContent } from "../../test/dom";
import type { CodexThreadStreamStateChangedEvent } from "./app-server-message-bus";
import type { CodexPersistedHistoryOccurrenceHydrateResult } from "../../../shared/codex-persisted-history-search";
import {
  applyCodexConversationHistoryMutation,
  buildCodexConversationHistoryMutation,
  type CodexConversationHistoryPageRequest,
  type CodexConversationHistoryPageResult,
} from "../../../shared/codex-conversation-history-page";
import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
} from "../../../shared/codex-conversation-state/codex-history-topology";

let invokeCalls: string[] = [];
let invokeRecords: Array<{ channel: string; args: unknown[] }> = [];
let hostMessageListener: ((message: CodexHostMessage) => void) | null = null;
let codexEventListener: ((event: CodexEvent) => void) | null = null;
let rendererClientRequestListener: ((message: unknown) => void) | null = null;
let threadListByProject: Record<string, CodexThreadSummary[]> = {};
let snapshotByThread: Record<string, CodexConversationSnapshot | null> = {};
let startThreadForSessionResult: unknown = null;
let freshThreadAdoptionResult: CodexConversationSnapshot | null = null;
let freshThreadAdoptionRevision = 0;
let sideChatStartResult: CodexSideChatStartResult | null = null;
let resumeThreadResult: CodexConversationSnapshot | Promise<CodexConversationSnapshot> | null =
  null;
let resumeThreadError: Error | null = null;
let resumeThreadRole: "owner" | "follower" = "owner";
let resumeThreadOwnerClientId = "renderer-owner";
let resumeThreadRevision = 0;
let resumeThreadGeneration = 1;
let historyPageResult:
  | Promise<CodexConversationHistoryPageResult>
  | CodexConversationHistoryPageResult
  | null = null;
let persistedHistoryHydrationResult: CodexPersistedHistoryOccurrenceHydrateResult | null = null;
let ownerEditRollbackResult: CodexThreadHistoryEditResult | null = null;
let ownerTurnStartResult: TurnStartResponse | null = null;
let ownerTurnStartError: Error | null = null;
let ownerTurnStartHandler: (() => void) | null = null;
let ownerTurnStartGate: (() => Promise<void>) | null = null;
let ownerTurnSteerHandler: ((params: unknown) => unknown | Promise<unknown>) | null = null;
let queuedFollowUpCommandHandler:
  | ((channel: string, args: unknown[]) => unknown | Promise<unknown>)
  | null = null;
let followerActionResult: unknown = null;
let followerActionError: Error | null = null;
let followerActionHandler: ((input: unknown) => unknown | Promise<unknown>) | null = null;
let ownerStreamPublishHandler: ((input: unknown) => unknown | Promise<unknown>) | null = null;
let ownerNotificationAckHandler: ((input: unknown) => boolean | Promise<boolean>) | null = null;
let ownerRequestResponseHandler:
  | ((channel: string, args: unknown[]) => boolean | Promise<boolean>)
  | null = null;
let selectedSubagentHydrateResult: CodexSelectedSubagentHydrateResult | null = null;
let selectedSubagentHydrateHandler:
  | ((
      input: unknown,
    ) => CodexSelectedSubagentHydrateResult | Promise<CodexSelectedSubagentHydrateResult>)
  | null = null;
let subagentOverviewResult: CodexSubagentOverviewWindow | null = null;
const generatedThreadTitleResult: unknown = { title: null };
const generatedThreadTitleError: Error | null = null;

vi.mock("./local-conversation-deps", () => ({
  runConversationOperation: async (channel: string, ...args: unknown[]) => {
    invokeCalls.push(channel);
    invokeRecords.push({ channel, args });
    const threadId = typeof args[0] === "string" ? args[0] : undefined;
    if (channel === "codex:account:read") {
      return {
        account: { type: "chatgpt", email: "dev@example.com", planType: "Plus" },
        requiresOpenAiAuth: false,
        pendingLogin: null,
        rateLimits: null,
      };
    }

    if (channel === "codex:connection:status") {
      return {
        status: "connected",
        retries: 0,
      } satisfies CodexConnectionState;
    }

    if (channel === "codex:thread:snapshot:request" && typeof threadId === "string") {
      if (Object.prototype.hasOwnProperty.call(snapshotByThread, threadId)) {
        return snapshotByThread[threadId];
      }
      if (threadId === "thread-child") {
        return buildConversation("thread-child", "project-1");
      }
      return null;
    }

    if (channel === "codex:thread:resume:request") {
      if (resumeThreadError) {
        throw resumeThreadError;
      }
      const conversation = ensureCanonicalResumeFixture(await Promise.resolve(resumeThreadResult));
      return conversation
        ? resumeThreadRole === "owner"
          ? {
              role: "owner",
              conversation,
              revision: resumeThreadRevision,
              threadGeneration: resumeThreadGeneration,
              checkpoint: buildTestCheckpoint(conversation, resumeThreadRevision),
            }
          : {
              role: "follower",
              conversation,
              revision: resumeThreadRevision,
              threadGeneration: resumeThreadGeneration,
              ownerClientId: resumeThreadOwnerClientId,
              checkpoint: buildTestCheckpoint(conversation, resumeThreadRevision),
            }
        : null;
    }

    if (channel === "codex:thread:fresh-owner:adopt") {
      const conversation = ensureCanonicalResumeFixture(freshThreadAdoptionResult);
      if (!conversation) {
        throw new Error("Fresh thread adoption fixture is unavailable");
      }
      return {
        role: "owner",
        conversation,
        revision: freshThreadAdoptionRevision,
        threadGeneration: resumeThreadGeneration,
        checkpoint: buildTestCheckpoint(conversation, freshThreadAdoptionRevision),
      };
    }

    if (channel === "codex:model:list") {
      return [
        {
          id: "gpt-5.3-codex",
          displayName: "GPT-5.3 Codex",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "high", description: "Deep" },
          ],
        },
      ];
    }

    if (channel === "codex:permission:state:get") {
      return {
        mode: "custom",
        effectivePreset: "custom",
        availableModes: ["auto", "guardian-approvals", "full-access", "custom"],
        approvalPolicy: null,
        approvalsReviewer: "user",
        sandboxMode: null,
        sandbox: null,
        autoReviewAvailable: false,
        configTarget: { source: "none" },
      };
    }

    if (channel === "codex:threads:list" && typeof threadId === "string") {
      return {
        items: threadListByProject[threadId] ?? [],
        nextCursor: null,
        authority: {
          storeEpoch: "test",
          projectionRevision: 1,
        },
      };
    }

    if (channel === "codex:thread:start-for-session") {
      return startThreadForSessionResult;
    }

    if (channel === "codex:thread:side-chat:start") {
      if (!sideChatStartResult) throw new Error("Side chat start fixture is unavailable");
      return sideChatStartResult;
    }

    if (channel === "codex:thread:side-chat:discard") {
      return true;
    }

    if (channel === "codex:thread:history-page:load") {
      if (!historyPageResult) throw new Error("History-page fixture is unavailable");
      return await Promise.resolve(historyPageResult);
    }

    if (channel === "codex:thread:history-search:hydrate") {
      if (!persistedHistoryHydrationResult) {
        throw new Error("Persisted-history hydration fixture is unavailable");
      }
      return persistedHistoryHydrationResult;
    }

    if (channel === "codex:subagents:selected:hydrate") {
      if (selectedSubagentHydrateHandler) {
        return await selectedSubagentHydrateHandler(args[0]);
      }
      if (!selectedSubagentHydrateResult) {
        throw new Error("Selected subagent hydration fixture is unavailable");
      }
      return selectedSubagentHydrateResult;
    }

    if (channel === "codex:subagents:overview:read") {
      if (subagentOverviewResult) return subagentOverviewResult;
      const input = args[0] as { rootThreadId: string };
      return {
        rootThreadId: input.rootThreadId,
        revision: 0,
        generation: 1,
        completeness: "complete",
        active: { rows: [], knownCount: 0, totalCount: 0, continuation: null },
        done: { rows: [], knownCount: 0, totalCount: 0, continuation: null },
      } satisfies CodexSubagentOverviewWindow;
    }

    if (channel === "codex:thread-owner:app-server-request") {
      const input = args[0] as {
        request?: {
          method?: string;
          params?: {
            expectedTurnId?: string;
          };
        };
      };
      if (input.request?.method === "thread/revert") {
        return ownerEditRollbackResult;
      }
      if (
        input.request?.method === "turn/start" ||
        input.request?.method === "turn/resume-interrupted" ||
        input.request?.method === "thread/session-first-turn/start"
      ) {
        ownerTurnStartHandler?.();
        await ownerTurnStartGate?.();
        if (ownerTurnStartError) {
          throw ownerTurnStartError;
        }
        if (ownerTurnStartResult) {
          return ownerTurnStartResult;
        }
        const turnId = "turn-owner-start";
        return {
          turn: {
            id: turnId,
            items: [],
            itemsView: "full",
            status: "inProgress",
            error: null,
            startedAt: 1,
            completedAt: null,
            durationMs: null,
          },
        } satisfies TurnStartResponse;
      }
      if (input.request?.method === "turn/steer") {
        if (ownerTurnSteerHandler) {
          return await ownerTurnSteerHandler(input.request.params);
        }
        return { turnId: input.request.params?.expectedTurnId ?? "turn-steered" };
      }
      if (input.request?.method === "turn/interrupt") {
        return true;
      }
      if (input.request?.method === "thread/settings/update") {
        return {
          model: "gpt-5.3-codex",
          reasoningEffort: "high",
          collaborationMode: {
            mode: "plan",
            settings: {
              model: "gpt-5.3-codex",
              reasoning_effort: "high",
              developer_instructions: null,
            },
          },
          personality: null,
        };
      }
      if (input.request?.method === "thread/goal/set") {
        const goalParams = input.request.params as
          | {
              threadId?: string;
              objective?: string | null;
              status?:
                | "active"
                | "paused"
                | "blocked"
                | "usageLimited"
                | "budgetLimited"
                | "complete"
                | null;
              tokenBudget?: number | null;
            }
          | undefined;
        return {
          threadId: goalParams?.threadId ?? "thread-1",
          objective: goalParams?.objective ?? "Ship it",
          status: goalParams?.status ?? "active",
          tokenBudget: goalParams?.tokenBudget ?? null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        };
      }
      if (input.request?.method === "thread/fork") {
        const params = input.request.params as { message?: string } | undefined;
        return {
          threadId: "thread-forked",
          composerIntent: {
            prompt: params?.message ?? "",
            focusNonce: 1,
          },
        };
      }
      return null;
    }

    if (channel === "codex:turn:start") {
      return null;
    }

    if (channel === "codex:turn:steer") {
      const input = args[0] as { expectedTurnId?: string } | undefined;
      if (ownerTurnSteerHandler) {
        return await ownerTurnSteerHandler(input);
      }
      return { turnId: input?.expectedTurnId ?? "turn-steered" };
    }

    if (channel.startsWith("codex:thread:follow-up:")) {
      if (queuedFollowUpCommandHandler) {
        return await queuedFollowUpCommandHandler(channel, args);
      }
      return true;
    }

    if (channel === "codex:thread-owner:stream-state:publish") {
      if (ownerStreamPublishHandler) {
        return await ownerStreamPublishHandler(args[0]);
      }
      return true;
    }

    if (channel === "codex:thread:resume-buffer:release") {
      return true;
    }

    if (channel === "codex:thread-owner:notification:ack") {
      if (ownerNotificationAckHandler) {
        return await ownerNotificationAckHandler(args[0]);
      }
      return true;
    }

    if (
      channel === "codex:thread-follower:snapshot-applied" ||
      channel === "codex:thread:stream-resync:request"
    ) {
      return true;
    }

    if (channel === "codex:dynamic-tool-call:respond") {
      return { success: false, contentItems: [] };
    }

    if (channel === "codex:thread-follower:action") {
      if (followerActionError) {
        throw followerActionError;
      }
      if (followerActionHandler) {
        return await followerActionHandler(args[0]);
      }
      return followerActionResult;
    }

    if (channel === "codex:renderer-client:response") {
      return true;
    }

    if (channel === "codex:thread:title:generate") {
      if (generatedThreadTitleError) {
        throw generatedThreadTitleError;
      }
      return generatedThreadTitleResult;
    }

    if (channel === "codex:thread:name:set-generated" || channel === "codex:thread:name:set") {
      return true;
    }

    if (channel === "codex:thread:plan-implementation:remove") {
      return true;
    }

    if (channel === "codex:turn:interrupt") {
      return true;
    }

    if (channel === "codex:thread:background-terminals:clean-silent") {
      return true;
    }

    if (
      channel === "codex:approval:respond" ||
      channel === "codex:user-input:respond" ||
      channel === "codex:mcp-elicitation:respond" ||
      channel === "codex:permission-request:respond" ||
      channel === "codex:option-picker:respond" ||
      channel === "codex:setup-context-picker:respond" ||
      channel === "codex:setup-codex-step:respond"
    ) {
      if (ownerRequestResponseHandler) {
        return await ownerRequestResponseHandler(channel, args);
      }
      return true;
    }

    return null;
  },
  subscribeCodexHostMessages: (listener: (message: CodexHostMessage) => void) => {
    hostMessageListener = listener;
    return () => {
      if (hostMessageListener === listener) {
        hostMessageListener = null;
      }
    };
  },
  subscribeCodexEvents: (listener: (event: CodexEvent) => void) => {
    codexEventListener = listener;
    return () => {
      if (codexEventListener === listener) codexEventListener = null;
    };
  },
  subscribeCodexRendererClientRequests: (listener: (message: unknown) => void) => {
    rendererClientRequestListener = listener;
    return () => {
      if (rendererClientRequestListener === listener) {
        rendererClientRequestListener = null;
      }
    };
  },
}));

function buildThreadSummary(threadId: string, projectId: string): CodexThreadSummary {
  return {
    threadId,
    projectId,
    source: null,
    threadName: threadId,
    threadPreview: threadId,
    modelProvider: "openai",
    cwd: `/tmp/${projectId}`,
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    hasUnreadTurn: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: "2026-03-30T00:00:00.000Z",
  };
}

function buildConversation(threadId: string, projectId: string): CodexConversationSnapshot {
  return {
    ...buildThreadSummary(threadId, projectId),
    resumeState: "resumed",
    turns: [],
    requests: [],
    pendingSteers: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditLastUserTurn: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
  };
}

function buildTestCheckpoint(
  conversation: CodexConversationSnapshot,
  revision: number,
  ownerEpoch = 1,
) {
  return buildCodexThreadStreamCheckpoint({ ownerEpoch, revision, conversation });
}

type TestThreadStreamDispatch = (
  type: "thread-stream-state-changed",
  event: CodexThreadStreamStateChangedEvent,
) => void;

interface TestThreadStreamReplica {
  readonly conversation: CodexConversationSnapshot;
  readonly checkpoint: ReturnType<typeof buildTestCheckpoint>;
  readonly sourceClientId: string | null;
}

const testThreadStreamReplicas = new Map<string, TestThreadStreamReplica>();

function resetLocalConversationStoreTestHarness(reset: () => void): void {
  testThreadStreamReplicas.clear();
  queuedFollowUpCommandHandler = null;
  persistedHistoryHydrationResult = null;
  historyPageResult = null;
  selectedSubagentHydrateResult = null;
  selectedSubagentHydrateHandler = null;
  codexEventListener = null;
  reset();
}

function dispatchTestThreadStreamStateChanged(
  dispatch: TestThreadStreamDispatch,
  event: Omit<CodexThreadStreamStateChangedEvent, "checkpoint" | "baseCheckpoint"> &
    Partial<Pick<CodexThreadStreamStateChangedEvent, "checkpoint" | "baseCheckpoint">>,
): void {
  const sourceClientId = event.sourceClientId?.trim() || null;
  const current = testThreadStreamReplicas.get(event.conversationId);
  if (event.change.type === "snapshot") {
    const ownerEpoch =
      event.checkpoint?.ownerEpoch ??
      (current?.sourceClientId === sourceClientId
        ? current.checkpoint.ownerEpoch
        : (current?.checkpoint.ownerEpoch ?? 0) + 1);
    const checkpoint =
      event.checkpoint ??
      buildTestCheckpoint(event.change.conversationState, event.change.revision, ownerEpoch);
    testThreadStreamReplicas.set(event.conversationId, {
      conversation: event.change.conversationState,
      checkpoint,
      sourceClientId,
    });
    dispatch("thread-stream-state-changed", {
      ...event,
      checkpoint,
      baseCheckpoint: event.baseCheckpoint ?? null,
    });
    return;
  }

  const baseConversation =
    current?.conversation ?? buildConversation(event.conversationId, "project-1");
  const ownerEpoch =
    event.checkpoint?.ownerEpoch ??
    event.baseCheckpoint?.ownerEpoch ??
    current?.checkpoint.ownerEpoch ??
    1;
  const baseCheckpoint =
    event.baseCheckpoint ??
    buildTestCheckpoint(baseConversation, event.change.baseRevision, ownerEpoch);
  let nextConversation = baseConversation;
  let applied = false;
  try {
    if (event.change.type === "historyMutation") {
      const result = applyCodexConversationHistoryMutation(baseConversation, event.change.mutation);
      if (result.ok) {
        nextConversation = result.conversation;
        applied = true;
      }
    } else {
      nextConversation = applyCodexConversationStateUpdates(baseConversation, event.change.patches);
      applied = true;
    }
  } catch {
    // Invalid-patch fixtures still need a well-formed envelope so production
    // reaches and rejects the patch application boundary under test.
  }
  const checkpoint =
    event.checkpoint ?? buildTestCheckpoint(nextConversation, event.change.revision, ownerEpoch);
  if (
    applied &&
    current?.sourceClientId === sourceClientId &&
    current.checkpoint.revision === event.change.baseRevision
  ) {
    testThreadStreamReplicas.set(event.conversationId, {
      conversation: nextConversation,
      checkpoint,
      sourceClientId,
    });
  }
  dispatch("thread-stream-state-changed", {
    ...event,
    baseCheckpoint,
    checkpoint,
  });
}

function ConversationUserMessages({
  manager,
  threadId,
  onCommit,
}: {
  manager: CodexAppServerManagerInstance;
  threadId: string;
  onCommit?: (messages: string[]) => void;
}) {
  const conversation = useSyncExternalStore(
    (onStoreChange) => manager.addConversationCallback(threadId, () => onStoreChange()),
    () => manager.readConversation(threadId),
  );
  const messages = useMemo(
    () =>
      conversation?.turns
        .flatMap((turn) => turn.items)
        .filter((item) => item.semanticKind === "userMessage")
        .map((item) => item.markdownText ?? "") ?? [],
    [conversation],
  );
  useLayoutEffect(() => {
    onCommit?.(messages);
  }, [messages, onCommit]);
  return createElement(
    "div",
    null,
    messages.map((message) => createElement("p", { key: message }, message)),
  );
}

function buildRollbackResponseFromConversation(
  conversation: CodexConversationSnapshot,
): CodexThreadHistoryEditResult {
  return {
    thread: {
      id: conversation.threadId,
      sessionId: `session-${conversation.threadId}`,
      forkedFromId: null,
      parentThreadId: conversation.source?.parentThreadId ?? null,
      preview: conversation.threadPreview,
      ephemeral: conversation.ephemeral ?? false,
      modelProvider: conversation.modelProvider,
      createdAt: conversation.createdAt / 1000,
      updatedAt: conversation.updatedAt / 1000,
      recencyAt: conversation.updatedAt / 1000,
      status:
        conversation.statusType === "active"
          ? { type: "active", activeFlags: conversation.statusActiveFlags }
          : conversation.statusType,
      path: null,
      cwd: conversation.cwd ?? "",
      cliVersion: "test",
      source: "codex-app-server",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: conversation.threadName,
      turns: conversation.turns.map((turn) => ({
        id: turn.turnId,
        items: turn.items.map((item) => {
          if (item.rawItem && typeof item.rawItem === "object") {
            return item.rawItem;
          }
          return {
            id: item.itemId,
            type: item.kind === "userMessage" ? "userMessage" : "agentMessage",
            ...(item.kind === "userMessage"
              ? {
                  clientId: null,
                  content: [{ type: "text", text: item.markdownText ?? "", text_elements: [] }],
                }
              : {
                  text: item.markdownText ?? "",
                  phase: null,
                  memoryCitation: null,
                  delivery: null,
                }),
          };
        }) as never[],
        itemsView: "full",
        status: turn.status,
        error: turn.errorMessage
          ? { message: turn.errorMessage, codexErrorInfo: null, additionalDetails: null }
          : null,
        startedAt: (turn.startedAt ?? turn.turnStartedAtMs ?? conversation.createdAt) / 1000,
        completedAt: turn.completedAt ? turn.completedAt / 1000 : null,
        durationMs: turn.durationMs ?? null,
      })),
    },
    turnPagination: conversation.turnPagination ?? {
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: conversation.turns[0]?.turnId ?? null,
      isLoadingOlder: false,
      hasLoadedOldest: true,
      loadedTurnCount: conversation.turns.length,
      itemsView: "full",
    },
    turnItemsPaginationById: conversation.turnItemsPaginationById,
  } as unknown as CodexThreadHistoryEditResult;
}

function withCanonicalState(conversation: CodexConversationSnapshot): CodexConversationSnapshot {
  const thread = buildRollbackResponseFromConversation(conversation).thread;
  const canonical = createCodexCanonicalHydratedConversationState(thread, {
    model: "gpt-test-fixture",
    reasoningEffort: "high",
    cwd: conversation.cwd ?? "/workspace/project",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    runtimeWorkspaceRoots: [conversation.cwd ?? "/workspace/project"],
    pendingRequests: conversation.canonicalRequests,
    hasUnreadTurn: conversation.hasUnreadTurn,
  });
  const latestConversationSettings = conversation.latestThreadSettings;
  const latestCollaborationMode = latestConversationSettings?.collaborationMode ?? {
    mode: "default" as const,
    settings: {
      model: latestConversationSettings?.model ?? "gpt-test-fixture",
      reasoning_effort: latestConversationSettings?.reasoningEffort ?? "high",
      developer_instructions: null,
    },
  };
  const latestThreadSettings = {
    cwd: conversation.cwd ?? "/workspace/project",
    approvalPolicy: "on-request" as const,
    approvalsReviewer: "user" as const,
    sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
    activePermissionProfile: null,
    model: latestConversationSettings?.model ?? "gpt-test-fixture",
    modelProvider: conversation.modelProvider ?? "openai",
    serviceTier: null,
    effort: latestConversationSettings?.reasoningEffort ?? "high",
    summary: null,
    collaborationMode: latestCollaborationMode,
    multiAgentMode: "explicitRequestOnly" as const,
    personality: latestConversationSettings?.personality ?? null,
  } satisfies ThreadSettings;
  const canonicalTurns = canonical.turns.map((turn, index) => {
    const projected = conversation.turns[index];
    if (!projected) return turn;
    return {
      ...turn,
      protocol: { ...turn.protocol, id: projected.turnId },
      sidecar: {
        ...turn.sidecar,
        turnStartedAtMs: projected.turnStartedAtMs ?? null,
        completedAtMs: projected.completedAt ?? null,
        firstTurnWorkItemStartedAtMs: projected.firstTurnWorkItemStartedAtMs ?? null,
        finalAssistantStartedAtMs: projected.finalAssistantStartedAtMs ?? null,
        commandExecutionStartedAtMsById: projected.commandExecutionStartedAtMsById,
        interruptedCommandExecutionItemIds: projected.interruptedCommandExecutionItemIds,
        hookRuns: projected.hookRuns,
      },
    };
  });
  const projectedTurns = conversation.turns.map((turn, turnIndex) => {
    const canonicalTurn = canonicalTurns[turnIndex];
    if (!canonicalTurn) return turn;
    return {
      ...turn,
      items: turn.items.map((item) => {
        const ownerItemId = item.commandExecutionItemId ?? item.itemId;
        const rawRecord =
          typeof item.rawItem === "object" && item.rawItem !== null
            ? (item.rawItem as { id?: unknown; type?: unknown })
            : null;
        const rawOwner = canonicalTurn.items.find(
          (candidate) =>
            candidate.id === ownerItemId &&
            (typeof rawRecord?.type !== "string" || candidate.type === rawRecord.type),
        );
        if (!rawOwner) return item;
        return {
          ...item,
          rawItemId: rawOwner.id,
          rawItemType: rawOwner.type,
        };
      }),
    };
  });
  return {
    ...conversation,
    turns: projectedTurns,
    canonicalState: {
      ...canonical,
      sidecar: {
        ...canonical.sidecar,
        latestThreadSettings,
        hydrationContext: canonical.sidecar.hydrationContext
          ? {
              ...canonical.sidecar.hydrationContext,
              latestThreadSettings: {
                ...latestThreadSettings,
                permissions: null,
              },
            }
          : null,
        threadGoal: conversation.threadGoal ?? null,
        completedThreadGoal: conversation.completedThreadGoal ?? null,
        threadGoalResumeConfirmation: conversation.threadGoalResumeConfirmation ?? null,
      },
      turns: canonicalTurns,
    },
  };
}

function ensureCanonicalResumeFixture(
  value: CodexConversationSnapshot | null,
): CodexConversationSnapshot | null {
  if (value === null) return null;
  const candidate = value as Partial<CodexConversationSnapshot>;
  if (
    typeof candidate.threadId !== "string" ||
    !Array.isArray(candidate.turns) ||
    typeof candidate.resumeState !== "string"
  ) {
    throw new Error("Resume fixture is not a complete conversation snapshot");
  }
  if (candidate.canonicalState !== undefined) {
    return candidate as CodexConversationSnapshot;
  }
  return withCanonicalState(candidate as CodexConversationSnapshot);
}

function buildFreshLaunchCanonicalParams(input: {
  readonly conversation: CodexConversationSnapshot;
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly prompt: string;
}): CodexCanonicalLiveTurnParams {
  const hydration = input.conversation.canonicalState?.sidecar.hydrationContext;
  if (!hydration) {
    throw new Error("Expected canonical fresh-thread hydration");
  }
  return {
    threadId: input.threadId,
    clientUserMessageId: input.clientUserMessageId,
    input: [
      {
        type: "text",
        text: input.prompt,
        text_elements: [],
      },
    ],
    cwd: hydration.cwd,
    approvalPolicy: hydration.currentPermissions.approvalPolicy,
    approvalsReviewer: hydration.currentPermissions.approvalsReviewer,
    sandboxPolicy: hydration.currentPermissions.sandboxPolicy,
    permissions: hydration.currentPermissions.activePermissionProfile?.id ?? null,
    runtimeWorkspaceRoots: [...hydration.currentPermissions.runtimeWorkspaceRoots],
    useAppServerPermissionDefault: false,
    model: hydration.latestModel,
    serviceTier: null,
    effort: hydration.latestReasoningEffort,
    multiAgentMode: "explicitRequestOnly",
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode: null,
    attachments: [],
    commentAttachments: [],
  };
}

function buildExactOlderHistoryPageFixture(input: {
  readonly partial: CodexConversationSnapshot;
  readonly loaded: CodexConversationSnapshot;
}): {
  readonly request: CodexConversationHistoryPageRequest;
  readonly before: CodexConversationSnapshot;
  readonly after: CodexConversationSnapshot;
  readonly page: CodexConversationHistoryPageResult;
} {
  const conversationGeneration = input.partial.conversationEntityGeneration ?? 1;
  const topologyGeneration = input.partial.historyTopologyGeneration ?? 1;
  const historyMutationRevision = input.partial.historyMutationRevision ?? 0;
  const oldestLoadedTurnId =
    input.partial.turns.find((turn) => turn.turnId !== null)?.turnId ?? null;
  const boundary: CodexHistoryBoundaryRef = {
    generation: topologyGeneration,
    islandId: `tail:${topologyGeneration}`,
    edge: "older",
    boundaryId: `older:${topologyGeneration}`,
    progressKey: JSON.stringify(["cursor:older", oldestLoadedTurnId]),
  };
  const contentRows = (conversation: CodexConversationSnapshot): readonly CodexHistoryRow[] =>
    conversation.turns.flatMap((turn) =>
      turn.turnId === null
        ? []
        : [
            {
              kind: "content" as const,
              key: `history-content:${turn.turnId}`,
              turnKey: turn.turnId,
              entityKey: turn.turnId,
            },
          ],
    );
  const before = withCanonicalState({
    ...input.partial,
    conversationEntityGeneration: conversationGeneration,
    historyTopologyGeneration: topologyGeneration,
    historyMutationRevision,
    historyRows: [
      {
        kind: "gap",
        key: `history-gap:${boundary.boundaryId}:${boundary.progressKey}`,
        olderBoundary: null,
        newerBoundary: boundary,
        estimatedHeightPx: 144,
      },
      ...contentRows(input.partial),
    ],
    turnPagination: {
      olderCursor: "cursor:older",
      backwardsCursor: null,
      oldestLoadedTurnId,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: input.partial.turns.length,
      itemsView: "full",
    },
    turnItemsPaginationById: input.partial.turnItemsPaginationById ?? {},
  });
  const projectedAfter = withCanonicalState({
    ...input.loaded,
    conversationEntityGeneration: conversationGeneration,
    historyTopologyGeneration: topologyGeneration,
    historyMutationRevision: historyMutationRevision + 1,
    historyRows: contentRows(input.loaded),
    turnPagination: {
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: input.loaded.turns.find((turn) => turn.turnId !== null)?.turnId ?? null,
      isLoadingOlder: false,
      hasLoadedOldest: true,
      loadedTurnCount: input.loaded.turns.length,
      itemsView: "full",
    },
    turnItemsPaginationById: input.loaded.turnItemsPaginationById ?? {},
  });
  const unchangedTurnIds = new Set(
    input.loaded.turns.flatMap((turn) => {
      if (turn.turnId === null) return [];
      const previous = input.partial.turns.find((candidate) => candidate.turnId === turn.turnId);
      return previous === turn ? [turn.turnId] : [];
    }),
  );
  const beforeTurnsById = new Map(
    before.turns.flatMap((turn) => (turn.turnId === null ? [] : ([[turn.turnId, turn]] as const))),
  );
  const beforeCanonicalTurnsById = new Map(
    before.canonicalState?.turns.flatMap((turn) =>
      turn.protocol.id === null ? [] : ([[turn.protocol.id, turn]] as const),
    ) ?? [],
  );
  const after: CodexConversationSnapshot = {
    ...projectedAfter,
    turns: projectedAfter.turns.map((turn) =>
      turn.turnId !== null && unchangedTurnIds.has(turn.turnId)
        ? (beforeTurnsById.get(turn.turnId) ?? turn)
        : turn,
    ),
    canonicalState: projectedAfter.canonicalState
      ? {
          ...projectedAfter.canonicalState,
          turns: projectedAfter.canonicalState.turns.map((turn) =>
            turn.protocol.id !== null && unchangedTurnIds.has(turn.protocol.id)
              ? (beforeCanonicalTurnsById.get(turn.protocol.id) ?? turn)
              : turn,
          ),
        }
      : projectedAfter.canonicalState,
  };
  const request: CodexConversationHistoryPageRequest = {
    threadId: before.threadId,
    expectedConversationGeneration: conversationGeneration,
    expectedHistoryMutationRevision: historyMutationRevision,
    target: { kind: "turnBoundary", boundary },
  };
  return {
    request,
    before,
    after,
    page: {
      status: "applied",
      mutation: buildCodexConversationHistoryMutation({
        before,
        after,
        origin: { kind: "page", request },
      }),
    },
  };
}

function buildAssistantMessage(
  threadId: string,
  turnId: string,
  itemId: string,
  markdownText: string,
): CodexConversationItem {
  return {
    threadId,
    turnId,
    itemId,
    rawItemId: itemId,
    rawItemType: "agentMessage",
    type: "message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    status: "completed",
    role: "assistant",
    markdownText,
    rawItem: {
      id: itemId,
      type: "agentMessage",
      text: markdownText,
      phase: null,
      memoryCitation: null,
      delivery: null,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildProtocolTurn(overrides: Pick<Turn, "id"> & Partial<Turn>): Turn {
  return {
    items: [],
    itemsView: "full",
    status: "inProgress",
    error: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    ...overrides,
  };
}

function buildUserMessage(
  threadId: string,
  turnId: string,
  itemId: string,
  markdownText: string,
): CodexConversationItem {
  return {
    threadId,
    turnId,
    itemId,
    rawItemId: itemId,
    rawItemType: "userMessage",
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    status: "completed",
    role: "user",
    markdownText,
    rawItem: {
      id: itemId,
      type: "userMessage",
      clientId: null,
      content: [{ type: "text", text: markdownText, text_elements: [] }],
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildCommandExecutionItem(
  threadId: string,
  turnId: string,
  itemId: string,
  aggregatedOutput = "",
): CodexConversationItem {
  return {
    threadId,
    turnId,
    itemId,
    rawItemId: itemId,
    rawItemType: "commandExecution",
    entryId: itemId,
    type: "command_execution",
    kind: "commandExecution",
    semanticKind: "exec",
    status: "inProgress",
    command: "bun test",
    cwd: "/workspace/project",
    processId: null,
    commandActions: [],
    aggregatedOutput,
    exitCode: null,
    durationMs: null,
    rawItem: {
      type: "commandExecution",
      id: itemId,
      command: "bun test",
      cwd: "/workspace/project",
      processId: null,
      source: "agent",
      status: "inProgress",
      commandActions: [],
      aggregatedOutput,
      exitCode: null,
      durationMs: null,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildMcpToolCallItem(
  threadId: string,
  turnId: string,
  itemId: string,
): CodexConversationItem {
  return {
    threadId,
    turnId,
    itemId,
    rawItemId: itemId,
    rawItemType: "mcpToolCall",
    entryId: itemId,
    type: "mcp_tool_call",
    kind: "toolCall",
    semanticKind: "mcpToolCall",
    status: "inProgress",
    mcpToolCall: {
      callId: itemId,
      functionName: "docs__search",
      pluginId: null,
      readOnlyHint: true,
      mcpAppResourceUri: undefined,
      source: null,
      invocation: {
        server: "docs",
        tool: "search",
        arguments: {
          query: "streaming parity",
        },
      },
      result: null,
      durationMs: null,
      completed: false,
    },
    rawItem: {
      type: "mcpToolCall",
      id: itemId,
      server: "docs",
      tool: "search",
      status: "inProgress",
      arguments: { query: "streaming parity" },
      appContext: null,
      pluginId: null,
      result: null,
      error: null,
      durationMs: null,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

async function flushAsyncWork(ticks = 2): Promise<void> {
  for (let index = 0; index < ticks; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function dispatchQueueOwnerProjection(
  projection: CodexQueuedFollowUpProjection,
  options: {
    threadId?: string;
    threadGeneration?: number;
    transcript?: CodexQueueOwnerUpdateRequest["transcript"];
    requestId?: string;
    manager?: Pick<CodexAppServerManagerInstance, "applyQueueOwnerUpdate">;
  } = {},
): Promise<void> {
  const requestId = options.requestId ?? `queue-owner-update-${projection.projectionRevision}`;
  const params = {
    threadId: options.threadId ?? "thread-1",
    threadGeneration: options.threadGeneration ?? resumeThreadGeneration,
    ownerEpoch: 1,
    projectionRevision: projection.projectionRevision,
    projection,
    transcript: options.transcript ?? { kind: "none" as const },
  };
  if (options.manager) {
    const result = await options.manager.applyQueueOwnerUpdate(params);
    if (result.kind === "rejected") {
      throw new Error(`Queue-owner update ${requestId} was rejected: ${result.reason}`);
    }
    return;
  }
  if (!rendererClientRequestListener) {
    throw new Error("Expected renderer queue-owner request listener");
  }

  rendererClientRequestListener({
    requestId,
    method: "codex-queue-owner-update",
    params,
  });
  await waitForCondition(
    () =>
      invokeRecords.some(
        (record) =>
          record.channel === "codex:renderer-client:response" &&
          (record.args[0] as { requestId?: string }).requestId === requestId,
      ),
    1_000,
  );
  const response = invokeRecords.find(
    (record) =>
      record.channel === "codex:renderer-client:response" &&
      (record.args[0] as { requestId?: string }).requestId === requestId,
  )?.args[0] as { type?: string; error?: { message?: string } } | undefined;
  if (!response) {
    throw new Error(`Queue-owner update ${requestId} did not complete`);
  }
  if (response.type === "error") {
    throw new Error(response.error?.message ?? `Queue-owner update ${requestId} failed`);
  }
}

describe("local-conversation-store", () => {
  test("dedupes one exact history-page target and applies its bounded mutation", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const partial = {
      ...buildConversation("thread-older", "project-1"),
      turns: [
        {
          threadId: "thread-older",
          turnId: "turn-latest",
          status: "completed" as const,
          itemIds: [],
          items: [],
        },
      ],
    };
    const fixture = buildExactOlderHistoryPageFixture({
      partial,
      loaded: {
        ...partial,
        turns: [
          {
            threadId: "thread-older",
            turnId: "turn-older",
            status: "completed",
            itemIds: [],
            items: [],
          },
          ...partial.turns,
        ],
      },
    });
    resumeThreadResult = fixture.before;
    await manager.requestThreadStreamResume("thread-older");
    let resolvePage: (page: CodexConversationHistoryPageResult) => void = () => {};
    historyPageResult = new Promise<CodexConversationHistoryPageResult>((resolve) => {
      resolvePage = resolve;
    });
    invokeRecords = [];

    const firstLoad = manager.requestHistoryPage(fixture.request);
    const secondLoad = manager.requestHistoryPage(fixture.request);
    await flushAsyncWork();

    expect(
      String(invokeCalls.filter((call) => call === "codex:thread:history-page:load").length),
    ).toBe("1");

    resolvePage(fixture.page);
    await firstLoad;
    await secondLoad;

    const conversation = manager.readConversation("thread-older");
    expect(conversation?.turns.map((turn) => turn.turnId)).toEqual(["turn-older", "turn-latest"]);
    expect(conversation?.historyMutationRevision).toBe(1);
    manager.destroy();
    resumeThreadResult = null;
    historyPageResult = null;
  });

  test("fails closed before ACK when one owner frame exceeds the distinct-key budget", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    ownerNotificationAckHandler = null;
    ownerStreamPublishHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    let ackCount = 0;
    let publishCount = 0;
    try {
      resumeThreadResult = buildConversation("thread-frame-pressure", "project-1");
      await manager.requestThreadStreamResume("thread-frame-pressure");
      invokeRecords = [];
      ownerNotificationAckHandler = () => {
        ackCount += 1;
        return true;
      };
      ownerStreamPublishHandler = () => {
        publishCount += 1;
        return true;
      };

      for (let index = 0; index < 1_025; index += 1) {
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: index + 1,
          notification: {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-frame-pressure",
              turnId: "turn-pressure",
              itemId: `assistant-pressure-${index}`,
              delta: "x",
            },
          },
        });
      }

      expect(manager.readConversationStreamRole("thread-frame-pressure")).toBeNull();
      expect(manager.readConversation("thread-frame-pressure")?.resumeState).toBe("needs_resume");
      expect(ackCount).toBe(0);
      expect(publishCount).toBe(0);

      // The overflow clears both queue and sequence ownership. A previously queued sequence must
      // not become ACK-eligible when the abandoned frame callback/timer eventually runs.
      await new Promise((resolve) => setTimeout(resolve, 25));
      await flushAsyncWork(3);
      expect(ackCount).toBe(0);
      expect(publishCount).toBe(0);
      expect(
        invokeRecords.filter((record) => record.channel === "codex:thread-owner:notification:ack"),
      ).toHaveLength(0);
      expect(
        invokeRecords.filter(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toHaveLength(0);
    } finally {
      ownerNotificationAckHandler = null;
      ownerStreamPublishHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("fails closed when a stalled owner ACK reaches the sequence high-water mark", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    ownerStreamPublishHandler = null;
    ownerNotificationAckHandler = () => new Promise<boolean>(() => {});
    const {
      CodexAppServerManager,
      CODEX_OWNER_NOTIFICATION_MAX_PENDING_SEQUENCES_PER_CONVERSATION,
      __resetLocalConversationStoreForTests,
    } = await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      resumeThreadResult = buildConversation("thread-ack-pressure", "project-1");
      await manager.requestThreadStreamResume("thread-ack-pressure");
      invokeRecords = [];

      for (
        let sequence = 1;
        sequence <= CODEX_OWNER_NOTIFICATION_MAX_PENDING_SEQUENCES_PER_CONVERSATION + 1;
        sequence += 1
      ) {
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence,
          notification: {
            method: "item/reasoning/summaryPartAdded",
            params: {
              threadId: "thread-ack-pressure",
              turnId: "turn-pressure",
              itemId: `reasoning-${sequence}`,
              summaryIndex: 0,
            },
          },
        });
      }

      expect(manager.readConversationStreamRole("thread-ack-pressure")).toBeNull();
      expect(manager.readConversation("thread-ack-pressure")?.resumeState).toBe("needs_resume");
      expect(
        invokeRecords.filter((record) => record.channel === "codex:thread-owner:notification:ack"),
      ).toHaveLength(1);
    } finally {
      ownerNotificationAckHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("leaves session-start auto-title generation to main", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    startThreadForSessionResult = {
      kind: "started",
      detail: {
        ...buildConversation("thread-auto", "project-1"),
        threadName: null,
        threadPreview: "Fallback preview",
        cwd: "/tmp/project-1",
      },
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    await manager.startThreadForSession({
      firstSubmission: createCodexFirstSubmissionIdentity(),
      projectId: "project-1",
      sessionId: "session-1",
      prompt: "ignored raw prompt",
      promptInput: {
        text: "Context\n## My request for Codex:\nBuild title parity",
        textAttachments: [{ text: "Pasted requirements" }],
      },
    });
    await settleAsyncRender();

    const startCall = invokeRecords.find(
      (record) => record.channel === "codex:thread:start-for-session",
    );
    const startInput = startCall?.args[0] as
      | { promptInput?: { text?: string; textAttachments?: Array<{ text?: string }> } }
      | undefined;

    expect(startInput?.promptInput?.text).toBe(
      "Context\n## My request for Codex:\nBuild title parity",
    );
    expect(startInput?.promptInput?.textAttachments?.[0]?.text).toBe("Pasted requirements");
    expect(invokeRecords.some((record) => record.channel === "codex:thread:title:generate")).toBe(
      false,
    );
    expect(
      invokeRecords.some((record) => record.channel === "codex:thread:name:set-generated"),
    ).toBe(false);
  });

  test("forwards skipAutoTitleGeneration without renderer-side generation", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    startThreadForSessionResult = {
      kind: "started",
      detail: {
        ...buildConversation("thread-skip", "project-1"),
        threadName: null,
        threadPreview: "",
      },
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    await manager.startThreadForSession({
      firstSubmission: createCodexFirstSubmissionIdentity(),
      projectId: "project-1",
      sessionId: "session-1",
      prompt: "Build title parity",
      skipAutoTitleGeneration: true,
    });
    await settleAsyncRender();

    const startCall = invokeRecords.find(
      (record) => record.channel === "codex:thread:start-for-session",
    );
    const startInput = startCall?.args[0] as { skipAutoTitleGeneration?: boolean } | undefined;

    expect(startInput?.skipAutoTitleGeneration).toBe(true);
    expect(invokeRecords.some((record) => record.channel === "codex:thread:title:generate")).toBe(
      false,
    );
  });

  test("requests and applies the started session thread snapshot after success", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    snapshotByThread = {
      "thread-snapshot": {
        ...buildConversation("thread-snapshot", "project-1"),
        threadName: "Snapshot applied",
      },
    };
    startThreadForSessionResult = {
      kind: "started",
      detail: {
        ...buildThreadSummary("thread-snapshot", "project-1"),
        threadName: "Start detail",
      },
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.startThreadForSession({
        firstSubmission: createCodexFirstSubmissionIdentity(),
        projectId: "project-1",
        sessionId: "session-1",
        prompt: "Build direct handoff",
        runInTarget: "localProject",
      });
      await settleAsyncRender();

      const startCallIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:start-for-session",
      );
      const snapshotCallIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread:snapshot:request" &&
          record.args[0] === "thread-snapshot",
      );
      const startInput = invokeRecords[startCallIndex]?.args[0] as
        | { permissionMode?: string }
        | undefined;

      expect(startCallIndex >= 0).toBe(true);
      expect(snapshotCallIndex > startCallIndex).toBe(true);
      expect(startInput?.permissionMode).toBe("custom");
      expect(manager.readConversation("thread-snapshot")?.threadName).toBe("Snapshot applied");
    } finally {
      snapshotByThread = {};
      manager.destroy();
    }
  });

  test("loads and updates the projectless permission scope through the same manager path", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.loadPermissionState(null);
      expect(invokeRecords).toContainEqual({
        channel: "codex:permission:state:get",
        args: [null],
      });

      await manager.setPermissionMode(null, "full-access");
      expect(invokeRecords).toContainEqual({
        channel: "codex:permission:mode:set",
        args: [null, "full-access"],
      });
    } finally {
      manager.destroy();
    }
  });

  test("adopts a fresh thread as owner and commits its first optimistic turn before transport settles", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const threadId = "thread-fresh-owner";
    const launchId = "01991e60-b800-7000-8000-000000000011";
    const clientUserMessageId = "01991e60-b800-7000-8000-000000000012";
    const adoptedConversation = withCanonicalState(buildConversation(threadId, "project-1"));
    const canonicalParams = buildFreshLaunchCanonicalParams({
      conversation: adoptedConversation,
      threadId,
      clientUserMessageId,
      prompt: "Start without a blank transcript",
    });
    startThreadForSessionResult = {
      kind: "started",
      detail: adoptedConversation,
      freshLaunch: {
        launchId,
        threadId,
        clientUserMessageId,
        canonicalParams,
      },
    };
    freshThreadAdoptionResult = adoptedConversation;
    freshThreadAdoptionRevision = 3;
    let acceptedReplica = adoptedConversation;
    let acceptedCheckpoint = buildTestCheckpoint(acceptedReplica, freshThreadAdoptionRevision);
    let acceptedPublicationCount = 0;
    let publicationError: unknown = null;
    ownerStreamPublishHandler = (input) => {
      try {
        const publication = input as {
          baseCheckpoint: ReturnType<typeof buildTestCheckpoint>;
          checkpoint: ReturnType<typeof buildTestCheckpoint>;
          change: CodexThreadStreamStateChange;
        };
        expect(publication.baseCheckpoint).toEqual(acceptedCheckpoint);
        const nextReplica = (() => {
          if (publication.change.type === "snapshot") {
            return publication.change.conversationState;
          }
          if (publication.change.type === "historyMutation") {
            const applied = applyCodexConversationHistoryMutation(
              acceptedReplica,
              publication.change.mutation,
            );
            if (!applied.ok) throw new Error(`History mutation failed: ${applied.reason}`);
            return applied.conversation;
          }
          return applyCodexConversationStateUpdates(acceptedReplica, publication.change.patches);
        })();
        expect(publication.checkpoint.revision).toBe(acceptedCheckpoint.revision + 1);
        expect(publication.checkpoint.canonicalHash).toBe(
          hashCodexConversationReplica(nextReplica),
        );
        acceptedReplica = nextReplica;
        acceptedCheckpoint = publication.checkpoint;
        acceptedPublicationCount += 1;
        return { accepted: true, checkpoint: publication.checkpoint };
      } catch (error) {
        publicationError = error;
        return false;
      }
    };
    let releaseTurnStart = () => {};
    const turnStartGate = new Promise<void>((resolve) => {
      releaseTurnStart = resolve;
    });
    let transportStarted = false;
    let renderedTurnCount = 0;
    let renderedTurnCountAtTransportStart = -1;
    ownerTurnStartHandler = () => {
      transportStarted = true;
      renderedTurnCountAtTransportStart = renderedTurnCount;
    };
    ownerTurnStartGate = () => turnStartGate;

    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    function OptimisticTurnProbe() {
      const visibleThreadId = useSyncExternalStore(
        (listener) => manager.subscribeControl(listener),
        () => {
          const progress = manager.readThreadStartProgress("project-1", "session-1");
          if (progress?.phase !== "ready") return null;
          return progress.threadId ?? null;
        },
      );
      renderedTurnCount = useSyncExternalStore(
        (listener) =>
          visibleThreadId
            ? manager.addConversationCallback(visibleThreadId, () => {
                listener();
              })
            : () => {},
        () =>
          visibleThreadId ? (manager.readConversation(visibleThreadId)?.turns.length ?? 0) : 0,
      );
      return createElement("div", null, String(renderedTurnCount));
    }
    const probe = render(createElement(OptimisticTurnProbe));
    await settleAsyncRender();
    try {
      let startPromise: ReturnType<typeof manager.startThreadForSession> | null = null;
      await act(async () => {
        startPromise = manager.startThreadForSession({
          firstSubmission: { launchId, clientUserMessageId },
          projectId: "project-1",
          sessionId: "session-1",
          prompt: "Start without a blank transcript",
          runInTarget: "localProject",
        });
        for (let index = 0; index < 20; index += 1) {
          if (transportStarted) break;
          await settleAsyncRender();
        }
      });

      const optimistic = manager.readConversation(threadId);
      expect(transportStarted).toBe(true);
      expect(renderedTurnCountAtTransportStart).toBe(1);
      expect(manager.readConversationStreamRole(threadId)).toBe("owner");
      expect(optimistic?.canonicalState?.turns).toHaveLength(1);
      expect(optimistic?.canonicalState?.turns[0]?.sidecar.params.clientUserMessageId).toBe(
        clientUserMessageId,
      );
      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:request")).toBe(
        false,
      );
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:snapshot:request"),
      ).toBe(false);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread-owner:app-server-request" &&
            (
              record.args[0] as {
                request?: { method?: string };
              }
            ).request?.method === "thread/session-first-turn/start",
        ),
      ).toBe(true);

      expect(manager.readConversation(threadId)?.canonicalState?.turns[0]?.protocol.id).toBe(null);

      await act(async () => {
        releaseTurnStart();
        if (!startPromise) {
          throw new Error("Expected fresh-thread start promise");
        }
        await expect(startPromise).resolves.toMatchObject({
          kind: "started",
        });
        for (let index = 0; index < 20; index += 1) {
          await settleAsyncRender();
          if (
            manager.readConversation(threadId)?.canonicalState?.turns[0]?.protocol.id ===
            "turn-owner-start"
          ) {
            break;
          }
        }
      });
      expect(manager.readConversation(threadId)?.canonicalState?.turns[0]?.protocol.id).toBe(
        "turn-owner-start",
      );
      await flushAsyncWork(3);
      expect(publicationError).toBeNull();
      expect(acceptedPublicationCount).toBeGreaterThanOrEqual(2);
      expect(acceptedReplica.canonicalState?.turns[0]?.protocol.id).toBe("turn-owner-start");
    } finally {
      probe.unmount();
      releaseTurnStart();
      freshThreadAdoptionResult = null;
      freshThreadAdoptionRevision = 0;
      ownerTurnStartHandler = null;
      ownerTurnStartGate = null;
      ownerStreamPublishHandler = null;
      manager.destroy();
    }
  });

  test("keeps fresh first-turn failure observable by the submission caller", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const threadId = "thread-fresh-owner-failure";
    const adoptedConversation = withCanonicalState(buildConversation(threadId, "project-1"));
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { sessionFirstSubmissionOwner } =
      await import("../conversation-launch/session-first-submission-owner");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    sessionFirstSubmissionOwner.dispose();
    const submission = sessionFirstSubmissionOwner.begin({
      backend: "codex",
      originProjectId: "project-1",
      originSessionId: "session-1",
      prompt: "Keep a failed first submission recoverable",
    });
    const canonicalParams = buildFreshLaunchCanonicalParams({
      conversation: adoptedConversation,
      threadId,
      clientUserMessageId: submission.clientUserMessageId,
      prompt: "Keep a failed first submission recoverable",
    });
    startThreadForSessionResult = {
      kind: "started",
      detail: adoptedConversation,
      freshLaunch: {
        launchId: submission.launchId,
        threadId,
        clientUserMessageId: submission.clientUserMessageId,
        canonicalParams,
      },
    };
    freshThreadAdoptionResult = adoptedConversation;
    freshThreadAdoptionRevision = 2;
    ownerTurnStartError = new Error("first turn was rejected");

    const manager = new CodexAppServerManager("default");
    try {
      await expect(
        manager.startThreadForSession({
          firstSubmission: submission,
          projectId: "project-1",
          sessionId: "session-1",
          prompt: "Keep a failed first submission recoverable",
          runInTarget: "localProject",
        }),
      ).rejects.toThrow("first turn was rejected");
      await flushAsyncWork(3);

      expect(
        sessionFirstSubmissionOwner
          .getSnapshot()
          .submissions.find((candidate) => candidate.launchId === submission.launchId),
      ).toMatchObject({
        threadId,
        phase: "failed",
        failure: {
          stage: "startingTurn",
          message: "first turn was rejected",
        },
      });
      expect(manager.readThreadStartProgress("project-1", "session-1")).toMatchObject({
        launchId: submission.launchId,
        threadId,
        phase: "failed",
      });
      expect(manager.readConversation(threadId)?.turns[0]?.status).toBe("failed");
    } finally {
      freshThreadAdoptionResult = null;
      freshThreadAdoptionRevision = 0;
      ownerTurnStartError = null;
      sessionFirstSubmissionOwner.dispose();
      manager.destroy();
    }
  });

  test("returns pending worktree identity without requesting a thread snapshot or seeding direct progress", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    startThreadForSessionResult = {
      kind: "pending",
      pendingWorktreeId: "local:pending-session-start",
      clientThreadId: "client-new-thread:pending-session-start",
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const result = await manager.startThreadForSession({
        firstSubmission: createCodexFirstSubmissionIdentity(),
        projectId: "project-1",
        sessionId: "session-1",
        prompt: "Build in a retained worktree",
        runInTarget: "newWorktree",
      });

      expect(result.kind).toBe("pending");
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:snapshot:request"),
      ).toBe(false);
      expect(manager.readThreadStartProgress("project-1", "session-1")).toBe(null);
    } finally {
      manager.destroy();
    }
  });

  test("seeds session thread start progress before invoking main", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    let resolveStart: (value: {
      kind: "started";
      detail: CodexConversationSnapshot;
    }) => void = () => {
      throw new Error("Expected pending start resolver");
    };
    startThreadForSessionResult = new Promise<{
      kind: "started";
      detail: CodexConversationSnapshot;
    }>((resolve) => {
      resolveStart = resolve;
    });
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const startPromise = manager.startThreadForSession({
      firstSubmission: createCodexFirstSubmissionIdentity(),
      projectId: "project-1",
      sessionId: "session-1",
      prompt: "Start immediately",
      runInTarget: "localProject",
    });

    const seeded = manager.readThreadStartProgress("project-1", "session-1");
    expect(Boolean(seeded)).toBe(true);
    expect(seeded?.phase).toBe("startingThread");
    expect(seeded?.runInTarget).toBe("localProject");
    expect(seeded?.message).toBe("Sending message…");

    resolveStart({
      kind: "started",
      detail: buildConversation("thread-start", "project-1"),
    });
    await startPromise;
  });

  test("shared thread start progress updates keep target metadata across selectors", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      useCodexThreadStartProgress,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    function Probe() {
      const progress = useCodexThreadStartProgress("project-1", "session-1");
      return createElement(
        "div",
        null,
        `${progress?.runInTarget ?? "none"}:${progress?.threadId ?? "none"}:${progress?.phase ?? "none"}`,
      );
    }

    const { container } = render(
      createElement(LocalConversationProvider, null, createElement(Probe)),
    );
    await settleAsyncRender();
    expect(textContent(container)).toBe("none:none:none");

    await act(async () => {
      hostMessageListener?.({
        type: "sharedObjectUpdated",
        hostId: "default",
        object: {
          objectType: "threadStartProgress",
          objectId: "project-1:session-1",
          value: {
            launchId: "01991e60-b800-7000-8000-000000000101",
            projectId: "project-1",
            sessionId: "session-1",
            runInTarget: "newWorktree",
            threadId: "thread-1",
            phase: "startingThread",
            message: "Sending message…",
            updatedAt: 10,
          },
        },
      });
    });
    await settleAsyncRender();

    expect(textContent(container)).toBe("newWorktree:thread-1:startingThread");
  });

  test("ignores delayed progress from a superseded first submission", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    const { sessionFirstSubmissionOwner } =
      await import("../conversation-launch/session-first-submission-owner");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = new CodexAppServerManager("default");
    const active = sessionFirstSubmissionOwner.begin({
      backend: "codex",
      originProjectId: "project-1",
      originSessionId: "session-1",
      prompt: "Newest attempt",
    });

    const publishProgress = (launchId: string, phase: "startingThread" | "failed") => {
      dispatchCodexAppServerMessage("shared-object-updated", {
        hostId: "default",
        object: {
          objectType: "threadStartProgress",
          objectId: "project-1:session-1",
          value: {
            launchId,
            projectId: "project-1",
            sessionId: "session-1",
            runInTarget: "localProject",
            threadId: null,
            phase,
            message: phase === "failed" ? "Old failure" : "Sending message…",
            updatedAt: Date.now(),
          },
        },
      });
    };

    try {
      publishProgress("01991e60-b800-7000-8000-000000000199", "failed");
      expect(manager.readThreadStartProgress("project-1", "session-1")).toBeNull();
      publishProgress(active.launchId, "startingThread");
      expect(manager.readThreadStartProgress("project-1", "session-1")?.phase).toBe(
        "startingThread",
      );
    } finally {
      sessionFirstSubmissionOwner.dispose();
      manager.destroy();
    }
  });

  test("hydrates account and connection through the external store bootstrap", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      useCodexAvailableModels,
      useLocalConversationAccount,
      useLocalConversationConnection,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    function Probe() {
      const account = useLocalConversationAccount();
      const connection = useLocalConversationConnection();
      const models = useCodexAvailableModels();
      const accountEmail = account?.account?.type === "chatgpt" ? account.account.email : "none";
      return createElement(
        "div",
        null,
        `${connection.status}:${accountEmail}:${models[0]?.id ?? "none"}`,
      );
    }

    const { container } = render(
      createElement(LocalConversationProvider, null, createElement(Probe)),
    );
    await settleAsyncRender();

    expect([...invokeCalls].sort().join(",")).toBe(
      "codex:account:read,codex:connection:status,codex:dictation:state:read,codex:dictation:state:read,codex:model:list",
    );
    expect(textContent(container)).toBe("connected:dev@example.com:gpt-5.3-codex");
  });

  test("conversation selectors stay isolated to the selected thread", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const {
      __resetLocalConversationStoreForTests,
      hydrateLocalConversationThreadSummaries,
      LocalConversationProvider,
      readLocalConversation,
      useConversation,
      useProjectThreadSummaries,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    hydrateLocalConversationThreadSummaries("project-1", [
      buildThreadSummary("thread-1", "project-1"),
    ]);

    let conversationRenderCount = 0;
    let summaryRenderCount = 0;

    function ConversationProbe() {
      conversationRenderCount += 1;
      const conversation = useConversation("thread-1");
      return createElement("div", { "data-conversation": conversation?.threadId ?? "none" });
    }

    function SummaryProbe() {
      summaryRenderCount += 1;
      const summaries = useProjectThreadSummaries("project-1");
      return createElement("div", { "data-summary-count": String(summaries.length) });
    }

    render(
      createElement(
        LocalConversationProvider,
        null,
        createElement("div", null, createElement(ConversationProbe), createElement(SummaryProbe)),
      ),
    );
    await settleAsyncRender();

    conversationRenderCount = 0;
    summaryRenderCount = 0;

    await act(async () => {
      const snapshot = buildConversation("thread-2", "project-2");
      hostMessageListener?.({
        type: "threadStreamStateChanged",
        hostId: "default",
        conversationId: "thread-2",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: snapshot,
        },
        version: 1,
        sourceClientId: "test-owner",
        checkpoint: buildTestCheckpoint(snapshot, 1),
        baseCheckpoint: null,
      });
    });
    await settleAsyncRender();

    expect(String(conversationRenderCount)).toBe("0");
    expect(String(summaryRenderCount)).toBe("0");

    await act(async () => {
      const snapshot = buildConversation("thread-1", "project-1");
      hostMessageListener?.({
        type: "threadStreamStateChanged",
        hostId: "default",
        conversationId: "thread-1",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: snapshot,
        },
        version: 1,
        sourceClientId: "test-owner",
        checkpoint: buildTestCheckpoint(snapshot, 1),
        baseCheckpoint: null,
      });
    });
    await settleAsyncRender();

    expect(readLocalConversation("thread-1")?.threadId ?? "none").toBe("thread-1");
    expect(String(summaryRenderCount)).toBe("0");

    conversationRenderCount = 0;
    summaryRenderCount = 0;

    await act(async () => {
      const previousConversation = buildConversation("thread-1", "project-1");
      const nextConversation: CodexConversationSnapshot = {
        ...previousConversation,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      hostMessageListener?.({
        type: "threadStreamStateChanged",
        hostId: "default",
        conversationId: "thread-1",
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCodexConversationStateUpdates(previousConversation, nextConversation),
        },
        version: 2,
        sourceClientId: "test-owner",
        baseCheckpoint: buildTestCheckpoint(previousConversation, 1),
        checkpoint: buildTestCheckpoint(nextConversation, 2),
      });
    });
    await settleAsyncRender();

    expect(readLocalConversation("thread-1")?.turns.length ?? 0).toBe(1);
    expect(String(summaryRenderCount)).toBe("0");
  });

  test("applies assistant text patches into renderer conversation state", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      const nextConversation: CodexConversationSnapshot = {
        ...baseConversation,
        turns: [
          {
            ...baseConversation.turns[0]!,
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "hello")],
          },
        ],
      };

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCodexConversationStateUpdates(baseConversation, nextConversation),
        },
        sourceClientId: "test-owner",
      });

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("hello");
    } finally {
      manager.destroy();
    }
  });

  test("commits follower streaming prose patches before same-stack completion patches", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { LocalConversationProvider, __resetLocalConversationStoreForTests, useConversation } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const renderStates: string[] = [];
    function Probe() {
      const conversation = useConversation("thread-1");
      const item = conversation?.turns[0]?.items[0];
      if (item) {
        renderStates.push(`${item.status ?? "none"}:${item.markdownText ?? ""}`);
      }
      return createElement("div", null, item?.markdownText ?? "");
    }

    const rendered = render(createElement(LocalConversationProvider, null, createElement(Probe)));
    try {
      await settleAsyncRender();
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      const streamingConversation: CodexConversationSnapshot = {
        ...baseConversation,
        turns: [
          {
            ...baseConversation.turns[0]!,
            items: [
              {
                ...baseConversation.turns[0]!.items[0]!,
                markdownText: "hello",
              },
            ],
          },
        ],
      };
      const completedConversation: CodexConversationSnapshot = {
        ...streamingConversation,
        turns: [
          {
            ...streamingConversation.turns[0]!,
            status: "completed",
            items: [
              {
                ...streamingConversation.turns[0]!.items[0]!,
                status: "completed",
              },
            ],
          },
        ],
      };

      await act(async () => {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "default",
          conversationId: "thread-1",
          version: 1,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: baseConversation,
          },
          sourceClientId: "owner-window",
        });
      });
      await settleAsyncRender();
      renderStates.length = 0;

      await act(async () => {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "default",
          conversationId: "thread-1",
          version: 2,
          change: {
            type: "patches",
            baseRevision: 1,
            revision: 2,
            patches: buildCodexConversationStateUpdates(baseConversation, streamingConversation),
          },
          sourceClientId: "owner-window",
        });
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "default",
          conversationId: "thread-1",
          version: 3,
          change: {
            type: "patches",
            baseRevision: 2,
            revision: 3,
            patches: buildCodexConversationStateUpdates(
              streamingConversation,
              completedConversation,
            ),
          },
          sourceClientId: "owner-window",
        });
      });
      await settleAsyncRender();

      expect(renderStates.includes("inProgress:hello")).toBe(true);
      expect(renderStates.includes("completed:hello")).toBe(true);
    } finally {
      rendered.unmount();
    }
  });

  test("two managers share owner stream state and recover owner loss from bundle 40400-40680", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = true;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const followerManager = new CodexAppServerManager("default");
    let ownerManager: InstanceType<typeof CodexAppServerManager> | null = null;
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      });
      resumeThreadResult = baseConversation;
      ownerManager = new CodexAppServerManager("default");
      await ownerManager.requestThreadStreamResume("thread-1");

      const ownerSnapshotPublish = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      expect(Boolean(ownerSnapshotPublish)).toBe(true);
      const ownerSnapshotInput = ownerSnapshotPublish?.args[0] as
        | {
            change?: CodexThreadStreamStateChange;
            baseCheckpoint?: ReturnType<typeof buildTestCheckpoint> | null;
            checkpoint?: ReturnType<typeof buildTestCheckpoint>;
          }
        | undefined;
      if (ownerSnapshotInput?.change?.type !== "snapshot" || !ownerSnapshotInput.checkpoint) {
        throw new Error("Missing owner bootstrap snapshot");
      }
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: ownerSnapshotInput.change,
        sourceClientId: "owner-a",
        baseCheckpoint: ownerSnapshotInput.baseCheckpoint ?? null,
        checkpoint: ownerSnapshotInput.checkpoint,
      });
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 10,
        request: {
          id: "input-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "q1",
                header: "Choice",
                question: "Pick one",
                isOther: false,
                isSecret: false,
                options: [{ label: "A", description: "First" }],
              },
            ],
          },
        },
      });

      const ownerRequestPublish = invokeRecords.find(
        (record) =>
          record.channel === "codex:thread-owner:stream-state:publish" &&
          (record.args[0] as { change?: { type?: string } } | undefined)?.change?.type ===
            "patches",
      );
      const ownerRequestChange = (
        ownerRequestPublish?.args[0] as
          | {
              change?: {
                type: "patches";
                baseRevision: number;
                revision: number;
                patches: CodexConversationStateUpdate[];
              };
            }
          | undefined
      )?.change;
      expect(Boolean(ownerRequestPublish)).toBe(true);
      expect(ownerManager.readConversation("thread-1")?.requests[0]?.requestId).toBe("input-1");
      expect(followerManager.readConversation("thread-1")?.requests.length ?? -1).toBe(0);

      if (!ownerRequestChange) {
        throw new Error("Missing owner request patch");
      }

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: ownerRequestChange,
        sourceClientId: "owner-a",
      });

      const followerRequestConversation = followerManager.readConversation("thread-1");
      expect(followerRequestConversation?.requests[0]?.requestId).toBe("input-1");
      expect(followerRequestConversation?.requests[0]?.type).toBe("userInput");
      expect(
        Boolean(
          followerRequestConversation?.turns[0]?.items.some(
            (item) => item.itemId === "user-input-response-input-1" && item.status === "inProgress",
          ),
        ),
      ).toBe(true);
      invokeRecords = [];

      const responded = await followerManager.respondUserInput("input-1", { q1: ["A"] });
      const responseAction = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const responsePayload = responseAction?.args[0] as
        | {
            action?: { type?: string; requestId?: string; answers?: Record<string, string[]> };
          }
        | undefined;
      expect(responded).toBe(true);
      expect(responsePayload?.action?.type).toBe("respondUserInput");
      expect(responsePayload?.action?.requestId).toBe("input-1");
      expect(responsePayload?.action?.answers?.q1?.[0]).toBe("A");
      expect(invokeRecords.some((record) => record.channel === "codex:user-input:respond")).toBe(
        false,
      );
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 11,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "live",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 25));
      await flushAsyncWork(4);
      const ownerLivePublish = invokeRecords.find((record) => {
        if (record.channel !== "codex:thread-owner:stream-state:publish") return false;
        return (
          (record.args[0] as { ownerNotificationSequence?: number }).ownerNotificationSequence ===
          11
        );
      })?.args[0] as
        | {
            change?: CodexThreadStreamStateChange;
            baseCheckpoint?: ReturnType<typeof buildTestCheckpoint> | null;
            checkpoint?: ReturnType<typeof buildTestCheckpoint>;
          }
        | undefined;
      if (!ownerLivePublish?.change || !ownerLivePublish.checkpoint) {
        throw new Error("Missing owner live publication");
      }
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 3,
        change: ownerLivePublish.change,
        sourceClientId: "owner-a",
        baseCheckpoint: ownerLivePublish.baseCheckpoint ?? null,
        checkpoint: ownerLivePublish.checkpoint,
      });

      expect(ownerManager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "live",
      );
      expect(followerManager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "live",
      );

      const interrupted = await followerManager.interruptTurn("thread-1", "turn-1");
      const followerAction = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const followerPayload = followerAction?.args[0] as
        | {
            action?: { type?: string; turnId?: string };
          }
        | undefined;
      expect(interrupted).toBe(true);
      expect(followerPayload?.action?.type).toBe("interruptTurn");
      expect("turnId" in (followerPayload?.action ?? {})).toBe(false);

      dispatchCodexAppServerMessage("thread-owner-unavailable", {
        hostId: "default",
        ownerClientId: "owner-a",
        conversationIds: ["thread-1"],
      });

      expect(followerManager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(ownerManager.readConversation("thread-1")?.resumeState).toBe("resumed");
    } finally {
      resumeThreadResult = null;
      followerActionResult = null;
      ownerManager?.destroy();
      followerManager.destroy();
    }
  });

  test("two managers run owner/follower release-gate flow without source-null visible patches", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    snapshotByThread = {};
    resumeThreadResult = null;
    ownerEditRollbackResult = null;
    ownerTurnStartResult = null;
    followerActionResult = null;
    followerActionError = null;
    followerActionHandler = null;
    ownerStreamPublishHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const ownerClientId = "owner-a";
    let hostMessageVersion = 0;
    const streamEvents: Array<{
      conversationId: string;
      change: CodexThreadStreamStateChange;
      sourceClientId: string | null;
    }> = [];
    const dispatchStreamState = (
      conversationId: string,
      change: CodexThreadStreamStateChange,
      sourceClientId: string | null = ownerClientId,
    ) => {
      hostMessageVersion += 1;
      streamEvents.push({
        conversationId,
        change,
        sourceClientId,
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId,
        version: hostMessageVersion,
        change,
        sourceClientId,
      });
    };
    const followerManager = new CodexAppServerManager("default");
    let ownerManager: InstanceType<typeof CodexAppServerManager> | null = null;
    try {
      const planItem: CodexConversationItem = {
        threadId: "thread-1",
        turnId: "turn-plan",
        itemId: "implement-plan:turn-plan",
        type: "planImplementation",
        kind: "planImplementation",
        semanticKind: "planImplementation",
        status: "inProgress",
        markdownText: "1. Ship the parity plan",
        rawItem: {
          id: "implement-plan:turn-plan",
          type: "planImplementation",
          turnId: "turn-plan",
          planContent: "1. Ship the parity plan",
          isCompleted: false,
        },
        createdAt: 1,
        updatedAt: 1,
      };
      const initialConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-plan",
            status: "completed",
            itemIds: ["implement-plan:turn-plan"],
            items: [planItem],
          },
          {
            threadId: "thread-1",
            turnId: "turn-user",
            status: "completed",
            itemIds: ["user-original"],
            items: [buildUserMessage("thread-1", "turn-user", "user-original", "Original prompt")],
          },
        ],
        requests: [
          {
            type: "implementPlan",
            requestId: "implement-plan:turn-plan",
            projectId: "project-1",
            threadId: "thread-1",
            turnId: "turn-plan",
            itemId: "implement-plan:turn-plan",
            planContent: "1. Ship the parity plan",
            createdAt: 1,
          },
        ],
      });
      const rollbackConversation: CodexConversationSnapshot = {
        ...initialConversation,
        turns: [initialConversation.turns[0]!],
      };
      ownerEditRollbackResult = buildRollbackResponseFromConversation(rollbackConversation);
      ownerTurnStartResult = {
        turn: {
          id: "turn-replacement",
          items: [],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      };
      resumeThreadResult = initialConversation;
      ownerStreamPublishHandler = (input) => {
        const publish = input as {
          conversationId?: string;
          change?: CodexThreadStreamStateChange;
        };
        if (!publish.conversationId || !publish.change) {
          return false;
        }
        dispatchStreamState(publish.conversationId, publish.change);
        return true;
      };

      dispatchStreamState("thread-1", {
        type: "snapshot",
        revision: 1,
        conversationState: initialConversation,
      });
      ownerManager = new CodexAppServerManager("default");
      followerActionHandler = async (input) => {
        const payload = input as {
          action?: Parameters<
            InstanceType<typeof CodexAppServerManager>["handleThreadOwnerActionRequest"]
          >[0];
        };
        if (!ownerManager || !payload.action) {
          throw new Error("Missing owner action target");
        }
        return await ownerManager.handleThreadOwnerActionRequest(payload.action);
      };
      await ownerManager.requestThreadStreamResume("thread-1");
      await flushAsyncWork(2);
      let queueProjectionRevision = 0;
      queuedFollowUpCommandHandler = async (channel, args) => {
        if (!ownerManager) throw new Error("Expected queue projection owner");
        queueProjectionRevision += 1;
        const entries =
          channel === "codex:thread:follow-up:enqueue"
            ? [
                createCodexQueuedFollowUp({
                  followUpId: "follow-up-routed",
                  clientUserMessageId: "client-follow-up-routed",
                  threadId: String(args[0]),
                  prompt: String(args[1]),
                  createdAtMs: 20,
                }),
              ]
            : [];
        await dispatchQueueOwnerProjection(
          {
            status: "ready",
            ledgerRevision: queueProjectionRevision,
            projectionRevision: queueProjectionRevision,
            entries,
            inFlightFollowUpId: null,
            editingFollowUpId: null,
            error: null,
          },
          { manager: ownerManager },
        );
        return true;
      };

      const editResult = await followerManager.editLastUserTurn(
        "thread-1",
        "turn-user",
        "Rewrite prompt",
      );
      await flushAsyncWork(2);
      expect(editResult.threadId).toBe("thread-1");
      expect(
        followerManager.readConversation("thread-1")?.turns.at(-1)?.items[0]?.markdownText,
      ).toBe("Rewrite prompt");
      expect(ownerManager.readConversation("thread-1")?.turns.at(-1)?.turnId).toBe(
        "turn-replacement",
      );

      const removedPlan = await followerManager.removePlanImplementationRequest(
        "thread-1",
        "turn-plan",
      );
      await flushAsyncWork(2);
      expect(removedPlan).toBe(true);
      expect(String(followerManager.readConversation("thread-1")?.requests.length ?? -1)).toBe("0");
      expect(followerManager.readConversation("thread-1")?.turns[0]?.items[0]?.status).toBe(
        "completed",
      );

      await followerManager.enqueueQueuedFollowUp("thread-1", "Queued follow-up");
      await flushAsyncWork(2);
      const queuedFollowUpId =
        followerManager.readConversation("thread-1")?.queuedFollowUps.entries[0]?.followUpId ??
        null;
      expect(Boolean(queuedFollowUpId)).toBe(true);
      if (!queuedFollowUpId) {
        throw new Error("Missing queued follow-up id");
      }
      await followerManager.removeQueuedFollowUp("thread-1", queuedFollowUpId);
      await flushAsyncWork(2);
      expect(
        String(followerManager.readConversation("thread-1")?.queuedFollowUps.entries.length ?? -1),
      ).toBe("0");

      animationFrameCallbacks.length = 0;
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 19,
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-replacement",
            item: {
              id: "assistant-replacement",
              type: "agentMessage",
              text: "",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });
      await flushAsyncWork(2);
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 20,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-replacement",
            itemId: "assistant-replacement",
            delta: "partial",
          },
        },
      });
      if (animationFrameCallbacks.length > 0) {
        while (animationFrameCallbacks.length > 0) {
          animationFrameCallbacks.shift()?.(16);
        }
      } else {
        await new Promise((resolve) => setTimeout(resolve, 90));
      }
      await flushAsyncWork(2);
      expect(ownerManager.readConversation("thread-1")?.turns.at(-1)?.items[1]?.markdownText).toBe(
        "partial",
      );
      expect(
        followerManager.readConversation("thread-1")?.turns.at(-1)?.items[1]?.markdownText,
      ).toBe("partial");

      const steerResult = await followerManager.steerTurn({
        threadId: "thread-1",
        prompt: "Steer this active turn",
      });
      await flushAsyncWork(2);
      expect(steerResult?.turnId).toBe("turn-replacement");
      expect(String(followerManager.readConversation("thread-1")?.pendingSteers.length ?? -1)).toBe(
        "0",
      );

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 30,
        request: {
          id: "input-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-replacement",
            itemId: "assistant-replacement",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "q1",
                header: "Choice",
                question: "Pick one",
                isOther: false,
                isSecret: false,
                options: [{ label: "A", description: "First" }],
              },
            ],
          },
        },
      });
      await flushAsyncWork(2);
      expect(followerManager.readConversation("thread-1")?.requests[0]?.requestId).toBe("input-1");
      const answered = await followerManager.respondUserInput("input-1", { q1: ["A"] }, "thread-1");
      await flushAsyncWork(3);
      expect(answered).toBe(true);
      expect(String(followerManager.readConversation("thread-1")?.requests.length ?? -1)).toBe("0");

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 40,
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-replacement",
            item: {
              id: "assistant-replacement",
              type: "agentMessage",
              text: "partial final",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });
      await flushAsyncWork(2);
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 41,
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: buildProtocolTurn({
              id: "turn-replacement",
              status: "completed",
            }),
          },
        },
      });
      await flushAsyncWork(3);
      const completedTurn = followerManager.readConversation("thread-1")?.turns.at(-1);
      const completedAssistant = completedTurn?.items.find(
        (item) => item.itemId === "assistant-replacement",
      );
      expect(completedTurn?.status).toBe("completed");
      expect(completedAssistant?.status).toBe("completed");
      expect(completedAssistant?.markdownText).toBe("partial final");

      if (!ownerManager.readConversation("thread-1")) {
        throw new Error("Missing owner conversation before normal start");
      }
      ownerTurnStartResult = {
        turn: {
          id: "turn-normal",
          items: [],
          itemsView: "full",
          status: "inProgress",
          error: null,
          startedAt: 1,
          completedAt: null,
          durationMs: null,
        },
      };
      await followerManager.startTurn("thread-1", "Normal start");
      await flushAsyncWork(2);
      expect(followerManager.readConversation("thread-1")?.turns.at(-1)?.turnId).toBe(
        "turn-normal",
      );
      expect(
        followerManager.readConversation("thread-1")?.turns.at(-1)?.items[0]?.markdownText,
      ).toBe("Normal start");

      dispatchCodexAppServerMessage("thread-owner-unavailable", {
        hostId: "default",
        ownerClientId,
        conversationIds: ["thread-1"],
      });
      expect(followerManager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(ownerManager.readConversation("thread-1")?.resumeState).toBe("resumed");
      expect(streamEvents.some((event) => event.sourceClientId === null)).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:edit-last-user-turn"),
      ).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:turn:start")).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:turn:steer")).toBe(true);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:follow-up:enqueue"),
      ).toBe(true);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:follow-up:remove"),
      ).toBe(true);
    } finally {
      followerActionHandler = null;
      ownerStreamPublishHandler = null;
      followerActionResult = null;
      followerActionError = null;
      resumeThreadResult = null;
      ownerEditRollbackResult = null;
      ownerTurnStartResult = null;
      queuedFollowUpCommandHandler = null;
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      ownerManager?.destroy();
      followerManager.destroy();
    }
  });

  test("drops patches with a mismatched base revision from bundle 40608-40613", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "")],
          },
        ],
      };
      const nextConversation: CodexConversationSnapshot = {
        ...baseConversation,
        turns: [
          {
            ...baseConversation.turns[0]!,
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "stale")],
          },
        ],
      };

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 0,
          revision: 2,
          patches: buildCodexConversationStateUpdates(baseConversation, nextConversation),
        },
        sourceClientId: "test-owner",
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("drops patches from a stale owner client from bundle 40608-40613", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "")],
          },
        ],
      };
      const nextConversation: CodexConversationSnapshot = {
        ...baseConversation,
        turns: [
          {
            ...baseConversation.turns[0]!,
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "wrong owner")],
          },
        ],
      };

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "owner-a",
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCodexConversationStateUpdates(baseConversation, nextConversation),
        },
        sourceClientId: "owner-b",
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("drops a foreign stream patch after the local renderer established owner authority", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "")],
          },
        ],
      };
      const nextConversation: CodexConversationSnapshot = {
        ...baseConversation,
        turns: [
          {
            ...baseConversation.turns[0]!,
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "should not apply")],
          },
        ],
      };

      resumeThreadResult = baseConversation;
      resumeThreadRole = "owner";
      await manager.requestThreadStreamResume("thread-1");
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "patches",
          baseRevision: 0,
          revision: 1,
          patches: buildCodexConversationStateUpdates(baseConversation, nextConversation),
        },
        sourceClientId: "test-owner",
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("drops patch application failures without source-null resync from bundle 40616-40632", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "")],
          },
        ],
      };
      const invalidPatches: CodexConversationStateUpdate[] = [
        {
          op: "replace",
          path: ["turns", 99, "status"],
          value: "completed",
        },
      ];

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "owner-a",
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: invalidPatches,
        },
        sourceClientId: "owner-a",
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.turns[0]?.status).toBe("inProgress");
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("owner ignores source-null stream patches from bundle 40580-40620", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "")],
          },
        ],
      };
      const staleMainConversation: CodexConversationSnapshot = {
        ...baseConversation,
        turns: [
          {
            ...baseConversation.turns[0]!,
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "stale main")],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCodexConversationStateUpdates(baseConversation, staleMainConversation),
        },
        sourceClientId: null,
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "owner",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));
      await flushAsyncWork(4);

      const publishRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecord?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("owner");
      expect(publishInput?.ownerNotificationSequence).toBe(1);
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toBe(1);
      expect(publishInput?.change?.revision).toBe(2);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("renderer resume releases buffered events before publishing owner snapshot from bundle 47780-47810", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-resume-owner", "project-1"),
        turns: [
          {
            threadId: "thread-resume-owner",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              buildAssistantMessage("thread-resume-owner", "turn-1", "assistant-1", "hydrated"),
            ],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      const observedResumedRoles: Array<string | null> = [];
      const unsubscribe = manager.addConversationCallback("thread-resume-owner", (conversation) => {
        if (conversation.resumeState === "resumed") {
          observedResumedRoles.push(manager.readConversationStreamRole("thread-resume-owner"));
        }
      });

      const result = await manager.requestThreadStreamResume("thread-resume-owner");
      unsubscribe();
      const releaseIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:resume-buffer:release",
      );
      const snapshotPublishIndex = invokeRecords.findIndex((record) => {
        if (record.channel !== "codex:thread-owner:stream-state:publish") return false;
        const input = record.args[0] as {
          ownerNotificationSequence?: number;
          change?: { type?: string };
        };
        return input.ownerNotificationSequence === undefined && input.change?.type === "snapshot";
      });
      const snapshotPublish = invokeRecords[snapshotPublishIndex]?.args[0] as
        | {
            change?: {
              revision?: number;
              conversationState?: CodexConversationSnapshot;
            };
          }
        | undefined;
      const pendingRequestReplayIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread-owner:pending-requests:replay",
      );

      expect(result?.threadId ?? "").toBe("thread-resume-owner");
      expect(observedResumedRoles).toContain("owner");
      expect(observedResumedRoles).not.toContain(null);
      expect(manager.readConversationAttachmentState("thread-resume-owner").status).toBe(
        "attached",
      );
      expect(releaseIndex >= 0).toBe(true);
      expect(snapshotPublishIndex >= 0).toBe(true);
      expect(releaseIndex < snapshotPublishIndex).toBe(true);
      expect(snapshotPublishIndex < pendingRequestReplayIndex).toBe(true);
      expect(snapshotPublish?.change?.revision).toBe(1);
      expect(snapshotPublish?.change?.conversationState?.resumeState).toBe("resumed");
      expect(snapshotPublish?.change?.conversationState?.turns[0]?.items[0]?.markdownText).toBe(
        "hydrated",
      );

      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-resume-owner",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: " tail",
          },
        },
      });
      await waitForCondition(
        () =>
          invokeRecords.some((record) => {
            if (record.channel !== "codex:thread-owner:stream-state:publish") return false;
            const input = record.args[0] as {
              ownerNotificationSequence?: number;
              change?: { type?: string; baseRevision?: number; revision?: number };
            };
            return input.ownerNotificationSequence === 1 && input.change?.type === "patches";
          }),
        160,
      );
      const patchPublish = invokeRecords.find((record) => {
        if (record.channel !== "codex:thread-owner:stream-state:publish") return false;
        const input = record.args[0] as {
          ownerNotificationSequence?: number;
          change?: { type?: string };
        };
        return input.ownerNotificationSequence === 1 && input.change?.type === "patches";
      })?.args[0] as
        | {
            change?: { baseRevision?: number; revision?: number };
          }
        | undefined;
      expect(patchPublish?.change?.baseRevision).toBe(1);
      expect(patchPublish?.change?.revision).toBe(2);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("renderer resume attaches to an accepted owner baseline as a follower", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadRole = "follower";
    resumeThreadOwnerClientId = "renderer-existing-owner";
    resumeThreadRevision = 12;
    const acceptedBaseline = withCanonicalState(
      buildConversation("thread-resume-follower", "project-1"),
    );
    resumeThreadResult = acceptedBaseline;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const result = await manager.requestThreadStreamResume("thread-resume-follower");

      expect(result?.threadId).toBe("thread-resume-follower");
      expect(manager.readConversationStreamRole("thread-resume-follower")).toBe("follower");
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:resume-buffer:release"),
      ).toBe(false);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(false);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:pending-requests:replay",
        ),
      ).toBe(false);

      const nextConversation = {
        ...acceptedBaseline,
        threadName: "Follower received the first patch after resume",
      };
      dispatchCodexAppServerMessage("thread-stream-state-changed", {
        hostId: "default",
        conversationId: "thread-resume-follower",
        version: 13,
        sourceClientId: "renderer-existing-owner",
        baseCheckpoint: buildTestCheckpoint(acceptedBaseline, 12),
        checkpoint: buildTestCheckpoint(nextConversation, 13),
        change: {
          type: "patches",
          baseRevision: 12,
          revision: 13,
          patches: buildCodexConversationStateUpdates(acceptedBaseline, nextConversation),
        },
      });
      expect(manager.readConversation("thread-resume-follower")?.threadName).toBe(
        "Follower received the first patch after resume",
      );
    } finally {
      resumeThreadRole = "owner";
      resumeThreadOwnerClientId = "renderer-owner";
      resumeThreadRevision = 0;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("selected subagent hydration returns ready only after its renderer attachment is applied", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadError = null;
    resumeThreadRole = "owner";
    resumeThreadRevision = 7;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const child = buildConversation("thread-selected", "project-1");
    selectedSubagentHydrateResult = {
      rootThreadId: "thread-root",
      threadId: child.threadId,
      revision: 11,
      fidelity: "attachedSparse",
      checkpoint: "[1,2,3]",
      canInteract: true,
      outcome: "ready",
      errorMessage: null,
    };
    let resolveResume: (conversation: CodexConversationSnapshot) => void = () => {
      throw new Error("resume gate was not initialized");
    };
    resumeThreadResult = new Promise<CodexConversationSnapshot>((resolve) => {
      resolveResume = resolve;
    });

    const manager = new CodexAppServerManager("default");
    try {
      let settled = false;
      const hydration = manager.hydrateSelectedSubagent({
        rootThreadId: "thread-root",
        threadId: child.threadId,
      });
      void hydration.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await flushAsyncWork();

      const hydrateIndices = invokeRecords.flatMap((record, index) =>
        record.channel === "codex:subagents:selected:hydrate" ? [index] : [],
      );
      const attachIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread:resume:request" && record.args[0] === child.threadId,
      );
      expect(hydrateIndices).toHaveLength(1);
      expect(attachIndex).toBeGreaterThan(hydrateIndices[0]!);
      expect(settled).toBe(false);
      expect(manager.readConversation(child.threadId)).toBeNull();

      resolveResume(child);
      await expect(hydration).resolves.toMatchObject({
        threadId: child.threadId,
        outcome: "ready",
        canInteract: true,
      });
      expect(manager.readConversation(child.threadId)?.threadId).toBe(child.threadId);
      expect(manager.readConversationStreamRole(child.threadId)).toBe("owner");
      expect(manager.readConversationAttachmentState(child.threadId).status).toBe("attached");
      const completedHydrateIndices = invokeRecords.flatMap((record, index) =>
        record.channel === "codex:subagents:selected:hydrate" ? [index] : [],
      );
      expect(completedHydrateIndices).toHaveLength(2);
      expect(completedHydrateIndices[1]).toBeGreaterThan(attachIndex);
    } finally {
      selectedSubagentHydrateResult = null;
      resumeThreadResult = null;
      resumeThreadRevision = 0;
      manager.destroy();
    }
  });

  test("selected subagent hydration downgrades ready when renderer attachment is unavailable", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    resumeThreadError = null;
    resumeThreadRole = "owner";
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    selectedSubagentHydrateResult = {
      rootThreadId: "thread-root",
      threadId: "thread-unavailable",
      revision: 12,
      fidelity: "residentSparse",
      checkpoint: "[1,2,4]",
      canInteract: true,
      outcome: "ready",
      errorMessage: null,
    };

    const manager = new CodexAppServerManager("default");
    try {
      await expect(
        manager.hydrateSelectedSubagent({
          rootThreadId: "thread-root",
          threadId: "thread-unavailable",
        }),
      ).resolves.toMatchObject({
        threadId: "thread-unavailable",
        outcome: "unavailable",
        canInteract: false,
        errorMessage: "This subagent could not attach to this window.",
      });
      expect(manager.readConversation("thread-unavailable")).toBeNull();
      expect(manager.readConversationStreamRole("thread-unavailable")).toBeNull();
    } finally {
      selectedSubagentHydrateResult = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("selected subagent hydration converts renderer attachment errors into failed outcomes", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    resumeThreadError = new Error("renderer attachment failed");
    resumeThreadRole = "owner";
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    selectedSubagentHydrateResult = {
      rootThreadId: "thread-root",
      threadId: "thread-failed",
      revision: 13,
      fidelity: "attachedSparse",
      checkpoint: "[1,2,5]",
      canInteract: true,
      outcome: "ready",
      errorMessage: null,
    };

    const manager = new CodexAppServerManager("default");
    try {
      await expect(
        manager.hydrateSelectedSubagent({
          rootThreadId: "thread-root",
          threadId: "thread-failed",
        }),
      ).resolves.toMatchObject({
        threadId: "thread-failed",
        outcome: "failed",
        canInteract: false,
        errorMessage: "renderer attachment failed",
      });
      expect(manager.readConversation("thread-failed")).toBeNull();
      expect(manager.readConversationStreamRole("thread-failed")).toBeNull();
      expect(manager.readConversationAttachmentState("thread-failed").status).toBe("failed");
    } finally {
      selectedSubagentHydrateResult = null;
      resumeThreadResult = null;
      resumeThreadError = null;
      manager.destroy();
    }
  });

  test("selected subagent hydration revalidates interaction authority without reattaching", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadError = null;
    resumeThreadRole = "owner";
    resumeThreadRevision = 14;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const child = buildConversation("thread-authority", "project-1");
    resumeThreadResult = child;
    let authorityReads = 0;
    selectedSubagentHydrateHandler = async (rawInput) => {
      const input = rawInput as { rootThreadId: string; threadId: string };
      authorityReads += 1;
      return {
        rootThreadId: input.rootThreadId,
        threadId: input.threadId,
        revision: authorityReads,
        fidelity: "attachedSparse",
        checkpoint: `[${authorityReads}]`,
        canInteract: authorityReads === 1,
        outcome: "ready",
        errorMessage: null,
      };
    };

    const manager = new CodexAppServerManager("default");
    try {
      await expect(
        manager.hydrateSelectedSubagent({
          rootThreadId: "thread-root",
          threadId: child.threadId,
        }),
      ).resolves.toMatchObject({
        rootThreadId: "thread-root",
        threadId: child.threadId,
        revision: 2,
        outcome: "ready",
        canInteract: false,
      });
      expect(
        invokeRecords.filter((record) => record.channel === "codex:thread:resume:request"),
      ).toHaveLength(1);

      await expect(
        manager.refreshSelectedSubagentAuthority({
          rootThreadId: "thread-root",
          threadId: child.threadId,
        }),
      ).resolves.toMatchObject({
        revision: 3,
        outcome: "ready",
        canInteract: false,
      });
      expect(
        invokeRecords.filter((record) => record.channel === "codex:thread:resume:request"),
      ).toHaveLength(1);
    } finally {
      selectedSubagentHydrateHandler = null;
      resumeThreadResult = null;
      resumeThreadRevision = 0;
      manager.destroy();
    }
  });

  test("selected subagent hydration rejects a mismatched identity before renderer attachment", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadError = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    selectedSubagentHydrateHandler = async () => ({
      rootThreadId: "wrong-root",
      threadId: "wrong-child",
      revision: 15,
      fidelity: "attachedSparse",
      checkpoint: "wrong-checkpoint",
      canInteract: true,
      outcome: "ready",
      errorMessage: null,
    });

    const manager = new CodexAppServerManager("default");
    try {
      await expect(
        manager.hydrateSelectedSubagent({
          rootThreadId: "thread-root",
          threadId: "thread-selected",
        }),
      ).resolves.toMatchObject({
        rootThreadId: "thread-root",
        threadId: "thread-selected",
        outcome: "failed",
        canInteract: false,
      });
      expect(
        invokeRecords.filter((record) => record.channel === "codex:thread:resume:request"),
      ).toHaveLength(0);
    } finally {
      selectedSubagentHydrateHandler = null;
      manager.destroy();
    }
  });

  test("selected subagent hydration rejects a mismatched post-attachment authority", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadError = null;
    resumeThreadRole = "owner";
    resumeThreadRevision = 16;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const child = buildConversation("thread-selected", "project-1");
    resumeThreadResult = child;
    let authorityReads = 0;
    selectedSubagentHydrateHandler = async (rawInput) => {
      const input = rawInput as { rootThreadId: string; threadId: string };
      authorityReads += 1;
      return {
        rootThreadId: authorityReads === 1 ? input.rootThreadId : "wrong-root",
        threadId: input.threadId,
        revision: authorityReads,
        fidelity: "attachedSparse",
        checkpoint: `[${authorityReads}]`,
        canInteract: true,
        outcome: "ready",
        errorMessage: null,
      };
    };

    const manager = new CodexAppServerManager("default");
    try {
      await expect(
        manager.hydrateSelectedSubagent({
          rootThreadId: "thread-root",
          threadId: child.threadId,
        }),
      ).resolves.toMatchObject({
        rootThreadId: "thread-root",
        threadId: child.threadId,
        outcome: "failed",
        canInteract: false,
      });
      expect(
        invokeRecords.filter((record) => record.channel === "codex:thread:resume:request"),
      ).toHaveLength(1);
    } finally {
      selectedSubagentHydrateHandler = null;
      resumeThreadResult = null;
      resumeThreadRevision = 0;
      manager.destroy();
    }
  });

  test("renderer resume converges a stale activation checkpoint before becoming attached", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadRevision = 4;
    const initial = {
      ...withCanonicalState(buildConversation("thread-resume-recovery", "project-1")),
      hasUnreadTurn: true,
    } satisfies CodexConversationSnapshot;
    const recovery = { ...initial, hasUnreadTurn: false } satisfies CodexConversationSnapshot;
    resumeThreadResult = initial;
    let publicationCount = 0;
    ownerStreamPublishHandler = (rawInput) => {
      const input = rawInput as {
        baseCheckpoint: ReturnType<typeof buildTestCheckpoint>;
        checkpoint: ReturnType<typeof buildTestCheckpoint>;
        change: Extract<CodexThreadStreamStateChange, { type: "snapshot" }>;
      };
      publicationCount += 1;
      if (publicationCount === 1) {
        return {
          accepted: false,
          reason: "checkpoint-mismatch" as const,
          recovery: {
            checkpoint: buildTestCheckpoint(recovery, 5),
            conversationState: recovery,
          },
        };
      }
      expect(input.baseCheckpoint).toEqual(buildTestCheckpoint(recovery, 5));
      expect(input.change.conversationState.hasUnreadTurn).toBe(false);
      return { accepted: true, checkpoint: input.checkpoint };
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = new CodexAppServerManager("default");

    try {
      await expect(manager.requestThreadStreamResume(initial.threadId)).resolves.toMatchObject({
        threadId: initial.threadId,
        hasUnreadTurn: false,
      });
      expect(publicationCount).toBe(2);
      expect(manager.readConversationAttachmentState(initial.threadId).status).toBe("attached");
    } finally {
      ownerStreamPublishHandler = null;
      resumeThreadResult = null;
      resumeThreadRevision = 0;
      manager.destroy();
    }
  });

  test("owner publication strips renderer-private authorization overlays from the shared document", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const localView: CodexConversationSnapshot = {
      ...buildConversation("thread-private-overlay", "project-1"),
      requests: [
        {
          type: "nodexAgentAuthorization",
          requestId: "nodex-auth-private",
          projectId: "project-1",
          threadId: "thread-private-overlay",
          turnId: "turn-1",
          itemId: "tool-1",
          tool: "update_page",
          effect: "write",
          preview: {
            title: "Update Page",
            summary: "Append one block.",
            details: [],
          },
          createdAt: 1,
        },
      ],
    };

    try {
      const baseCheckpoint = buildTestCheckpoint(localView, 0);
      const checkpoint = buildTestCheckpoint(localView, 1);
      const result = await (
        manager as unknown as {
          dispatchOwnerStreamSnapshot: (
            conversationId: string,
            baseCheckpoint: ReturnType<typeof buildTestCheckpoint>,
            checkpoint: ReturnType<typeof buildTestCheckpoint>,
            conversation: CodexConversationSnapshot,
          ) => Promise<{ accepted: boolean }>;
        }
      ).dispatchOwnerStreamSnapshot(
        "thread-private-overlay",
        baseCheckpoint,
        checkpoint,
        localView,
      );
      const publish = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      )?.args[0] as
        | {
            change?: { type?: string; conversationState?: CodexConversationSnapshot };
          }
        | undefined;

      expect(result.accepted).toBe(true);
      expect(localView.requests).toHaveLength(1);
      expect(publish?.change?.type).toBe("snapshot");
      expect(publish?.change?.conversationState?.requests).toEqual([]);
    } finally {
      manager.destroy();
    }
  });

  test("renderer resume reuses one in-flight IPC request per thread", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-resume-single-flight", "project-1"),
        turns: [
          {
            threadId: "thread-resume-single-flight",
            turnId: "turn-1",
            status: "completed",
            itemIds: ["assistant-1"],
            items: [
              buildAssistantMessage("thread-resume-single-flight", "turn-1", "assistant-1", "done"),
            ],
          },
        ],
      };
      let resolveResume: (conversation: CodexConversationSnapshot) => void = () => {
        throw new Error("resume gate was not initialized");
      };
      resumeThreadResult = new Promise<CodexConversationSnapshot>((resolve) => {
        resolveResume = resolve;
      });

      const first = manager.requestThreadStreamResume("thread-resume-single-flight");
      const second = manager.requestThreadStreamResume("thread-resume-single-flight");
      await flushAsyncWork();

      const resumeRequestCount = invokeRecords.filter(
        (record) =>
          record.channel === "codex:thread:resume:request" &&
          record.args[0] === "thread-resume-single-flight",
      ).length;
      expect(resumeRequestCount).toBe(1);

      resolveResume(baseConversation);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      const releaseCount = invokeRecords.filter(
        (record) =>
          record.channel === "codex:thread:resume-buffer:release" &&
          record.args[0] === "thread-resume-single-flight",
      ).length;
      const ownerSnapshotPublishCount = invokeRecords.filter((record) => {
        if (record.channel !== "codex:thread-owner:stream-state:publish") return false;
        const input = record.args[0] as {
          change?: { type?: string };
        };
        return input.change?.type === "snapshot";
      }).length;

      expect(firstResult?.threadId ?? "").toBe("thread-resume-single-flight");
      expect(secondResult?.threadId ?? "").toBe("thread-resume-single-flight");
      expect(releaseCount).toBe(1);
      expect(ownerSnapshotPublishCount).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("shared child relationships can arrive before the parent conversation", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchCodexAppServerMessage("shared-object-updated", {
        hostId: "default",
        object: {
          objectType: "conversationChildMemberships",
          objectId: "thread-parent",
          value: {
            parentThreadId: "thread-parent",
            childMemberships: [
              {
                threadId: "thread-child",
                parentThreadId: "thread-parent",
                role: "backgroundChild",
                actorName: "Nash",
                thread: {
                  nickname: "@Nash",
                  agentRole: "worker",
                  model: "gpt-5-codex",
                },
              },
            ],
          },
        },
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-parent")).toBeNull();
      expect(manager.readConversationChildMemberships("thread-parent")[0]?.thread?.nickname).toBe(
        "@Nash",
      );

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-parent",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-parent", "project-1"),
        },
        sourceClientId: "test-owner",
      });
      await flushAsyncWork();

      expect(manager.readConversationChildMemberships("thread-parent")[0]?.thread?.agentRole).toBe(
        "worker",
      );
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-child",
        ),
      ).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("renderer resume failure releases buffer and rolls back to needs_resume from bundle 47815-47835", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    resumeThreadError = new Error("resume failed");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-resume-failed", "project-1"),
        resumeState: "needs_resume",
        turns: [],
      };

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-resume-failed",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });

      let threw = false;
      try {
        await manager.requestThreadStreamResume("thread-resume-failed");
      } catch {
        threw = true;
      }

      const releaseIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:resume-buffer:release",
      );
      const finalSnapshotPublish = invokeRecords.find((record) => {
        if (record.channel !== "codex:thread-owner:stream-state:publish") return false;
        const input = record.args[0] as {
          ownerNotificationSequence?: number;
          change?: { type?: string };
        };
        return input.ownerNotificationSequence === undefined && input.change?.type === "snapshot";
      });

      expect(threw).toBe(true);
      expect(releaseIndex >= 0).toBe(true);
      expect(manager.readConversation("thread-resume-failed")?.resumeState).toBe("needs_resume");
      const attachment = manager.readConversationAttachmentState("thread-resume-failed");
      expect(attachment.status).toBe("failed");
      if (attachment.status === "failed") {
        expect(attachment.message).toContain("resume failed");
      }
      expect(Boolean(finalSnapshotPublish)).toBe(false);
    } finally {
      resumeThreadResult = null;
      resumeThreadError = null;
      manager.destroy();
    }
  });

  test("owner thread notifications update local text and publish revisioned patches", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "")],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "hello",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 70));

      const publishRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecord?.args[0] as
        | {
            conversationId?: string;
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("hello");
      expect(publishInput?.conversationId).toBe("thread-1");
      expect(publishInput?.ownerNotificationSequence).toBe(1);
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toBe(1);
      expect(publishInput?.change?.revision).toBe(2);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner request ingress and resolution fail closed without a canonical document", async () => {
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        canonicalState: null,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: { type: "snapshot", revision: 1, conversationState: baseConversation },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: {
          id: "input-without-canonical",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "input-call-1",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "q1",
                header: "Choice",
                question: "Pick one",
                isOther: false,
                isSecret: false,
                options: [{ label: "A", description: "First" }],
              },
            ],
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "serverRequest/resolved",
          params: {
            threadId: "thread-1",
            requestId: "input-without-canonical",
          },
        },
      });
      await flushAsyncWork(4);

      const conversation = manager.readConversation("thread-1");
      const acknowledgements = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:notification:ack")
        .map((record) => (record.args[0] as { sequence?: number }).sequence);
      expect(conversation?.canonicalState ?? null).toBe(null);
      expect(String(conversation?.canonicalRequests?.length ?? 0)).toBe("0");
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(String(conversation?.turns[0]?.items.length ?? -1)).toBe("0");
      expect(conversation?.resumeState).toBe("needs_resume");
      expect(JSON.stringify(acknowledgements)).toBe(JSON.stringify([1, 2]));
      const ownerPublications = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      expect(ownerPublications.length).toBeGreaterThan(0);
      expect(
        ownerPublications.every(
          (record) =>
            (record.args[0] as { change?: { type?: string } }).change?.type === "snapshot",
        ),
      ).toBe(true);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner frame reduction fails closed when resume has no canonical document", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        canonicalState: null,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: { type: "snapshot", revision: 1, conversationState: baseConversation },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "must not reconstruct",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));

      const conversation = manager.readConversation("thread-1");
      const ack = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      )?.args[0] as { sequence?: number } | undefined;
      expect(conversation?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(conversation?.resumeState).toBe("needs_resume");
      expect(ack?.sequence).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner plan and reasoning deltas publish prose patches from bundle 51692-51755", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["plan-1", "reasoning-1"],
            items: [
              {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "plan-1",
                type: "plan",
                kind: "plan",
                semanticKind: "proposedPlan",
                status: "inProgress",
                markdownText: "",
                rawItem: {
                  id: "plan-1",
                  type: "plan",
                  text: "",
                },
                createdAt: 1,
                updatedAt: 1,
              },
              {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "reasoning-1",
                type: "reasoning",
                kind: "reasoning",
                semanticKind: "reasoning",
                status: "inProgress",
                markdownText: "",
                rawItem: {
                  id: "reasoning-1",
                  type: "reasoning",
                  summary: [],
                  content: [],
                },
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/plan/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "plan-1",
            delta: "1. Inspect\n",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
            summaryIndex: 0,
            delta: "Thinking",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "item/reasoning/textDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
            contentIndex: 0,
            delta: "private chain",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 90));

      const conversation = manager.readConversation("thread-1");
      const plan = conversation?.turns[0]?.items.find((item) => item.itemId === "plan-1");
      const reasoning = conversation?.turns[0]?.items.find((item) => item.itemId === "reasoning-1");
      const rawReasoning = reasoning?.rawItem as
        | { summary?: string[]; content?: string[] }
        | undefined;
      const canonicalPlan = conversation?.canonicalState?.turns[0]?.items.find(
        (item) => item.id === "plan-1" && item.type === "plan",
      );
      const canonicalReasoning = conversation?.canonicalState?.turns[0]?.items.find(
        (item) => item.id === "reasoning-1" && item.type === "reasoning",
      );
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecords[0]?.args[0] as
        | { ownerNotificationSequence?: number }
        | undefined;

      expect(plan?.markdownText).toBe("1. Inspect\n");
      expect(reasoning?.markdownText).toBe("Thinking");
      expect(rawReasoning?.summary?.[0]).toBe("Thinking");
      expect(rawReasoning?.content?.[0]).toBe("private chain");
      expect(canonicalPlan?.type === "plan" ? canonicalPlan.text : null).toBe("1. Inspect\n");
      expect(canonicalReasoning?.type === "reasoning" ? canonicalReasoning.summary[0] : null).toBe(
        "Thinking",
      );
      expect(canonicalReasoning?.type === "reasoning" ? canonicalReasoning.content[0] : null).toBe(
        "private chain",
      );
      expect(String(publishRecords.length)).toBe("1");
      expect(publishInput?.ownerNotificationSequence).toBe(3);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner goal notifications publish patches and clear newly completed goals", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "thread/goal/updated",
          params: {
            turnId: null,
            threadId: "thread-1",
            goal: {
              threadId: "thread-1",
              objective: "Finish parity",
              status: "active",
              tokenBudget: 40000,
              tokensUsed: 10,
              timeUsedSeconds: 2,
              createdAt: 100,
              updatedAt: 101,
            },
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "thread/goal/updated",
          params: {
            turnId: null,
            threadId: "thread-1",
            goal: {
              threadId: "thread-1",
              objective: "Finish parity",
              status: "complete",
              tokenBudget: 40000,
              tokensUsed: 200,
              timeUsedSeconds: 30,
              createdAt: 100,
              updatedAt: 102,
            },
          },
        },
      });
      await flushAsyncWork();

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "thread/goal/cleared",
          params: {
            threadId: "thread-1",
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const clearRecord = invokeRecords.find(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method ===
            "thread/goal/clear",
      );
      const firstPublish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      const acknowledgedSequences = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:notification:ack")
        .map((record) => (record.args[0] as { sequence?: number }).sequence);

      expect(conversation?.threadGoal ?? null).toBe(null);
      expect(conversation?.completedThreadGoal?.status ?? "").toBe("complete");
      expect(conversation?.canonicalState?.sidecar.threadGoal ?? null).toBe(null);
      expect(conversation?.canonicalState?.sidecar.completedThreadGoal?.status ?? "").toBe(
        "complete",
      );
      expect(String(publishRecords.length)).toBe("3");
      expect(firstPublish?.ownerNotificationSequence).toBe(1);
      expect(firstPublish?.change?.baseRevision).toBe(1);
      expect(firstPublish?.change?.revision).toBe(2);
      expect(JSON.stringify(acknowledgedSequences)).toBe(JSON.stringify([3]));
      expect(clearRecord !== undefined).toBe(true);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner item lifecycle notifications publish started and completed patches", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      });
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-1",
              type: "agentMessage",
              text: "",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.status).toBe("inProgress");
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      const finalAssistantStartedAtMs =
        manager.readConversation("thread-1")?.turns[0]?.finalAssistantStartedAtMs;
      expect(typeof finalAssistantStartedAtMs).toBe("number");
      expect(
        typeof manager.readConversation("thread-1")?.turns[0]?.firstTurnWorkItemStartedAtMs,
      ).toBe("number");

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-1",
              type: "agentMessage",
              text: "done",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });
      await flushAsyncWork();

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const firstPublish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      const secondPublish = publishRecords[1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      expect(String(publishRecords.length)).toBe("2");
      expect(firstPublish?.ownerNotificationSequence).toBe(1);
      expect(firstPublish?.change?.baseRevision).toBe(1);
      expect(firstPublish?.change?.revision).toBe(2);
      expect(secondPublish?.ownerNotificationSequence).toBe(2);
      expect(secondPublish?.change?.baseRevision).toBe(2);
      expect(secondPublish?.change?.revision).toBe(3);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.status).toBe("completed");
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("done");
      expect(manager.readConversation("thread-1")?.turns[0]?.finalAssistantStartedAtMs).toBe(
        finalAssistantStartedAtMs,
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner lifecycle retains hidden review-mode identity without rendering a row", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const managerInternals = manager as unknown as {
      ownerHiddenLifecycleItemTypesByConversationId: Map<
        string,
        Map<string | null, Map<string, string>>
      >;
    };
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      });
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            startedAtMs: 100,
            item: {
              id: "review-mode-marker",
              type: "exitedReviewMode",
              review: "Review the current changes",
            },
          },
        },
      });
      await flushAsyncWork();
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            completedAtMs: 120,
            item: {
              id: "review-mode-marker",
              type: "exitedReviewMode",
              review: "Review the current changes",
            },
          },
        },
      });
      await flushAsyncWork();

      const turn = manager.readConversation("thread-1")?.turns[0];
      const hiddenTypes = managerInternals.ownerHiddenLifecycleItemTypesByConversationId
        .get("thread-1")
        ?.get("turn-1");
      expect(turn?.items.length ?? -1).toBe(0);
      expect(typeof turn?.firstTurnWorkItemStartedAtMs).toBe("number");
      expect(hiddenTypes?.get("review-mode-marker")).toBe("exitedReviewMode");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner round-trips a visible item through a hidden same-ID slot without reordering", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const managerInternals = manager as unknown as {
      ownerHiddenLifecycleItemTypesByConversationId: Map<
        string,
        Map<string | null, Map<string, string>>
      >;
    };
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["before", "target", "after"],
            items: ["before", "target", "after"].map((itemId) =>
              buildCommandExecutionItem("thread-1", "turn-1", itemId),
            ),
          },
        ],
      });
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            startedAtMs: 100,
            item: {
              id: "target",
              type: "enteredReviewMode",
              review: "Review target",
            },
          },
        },
      });
      await flushAsyncWork();

      let turn = manager.readConversation("thread-1")?.turns[0];
      expect(JSON.stringify(turn?.itemIds)).toBe(JSON.stringify(["before", "target", "after"]));
      expect(JSON.stringify(turn?.items.map((item) => item.itemId))).toBe(
        JSON.stringify(["before", "after"]),
      );
      expect(
        managerInternals.ownerHiddenLifecycleItemTypesByConversationId
          .get("thread-1")
          ?.get("turn-1")
          ?.get("target"),
      ).toBe("enteredReviewMode");

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            startedAtMs: 120,
            item: {
              id: "target",
              type: "commandExecution",
              command: "printf target",
              cwd: "/tmp",
              processId: null,
              pluginId: null,
              scriptPath: null,
              source: "agent",
              status: "inProgress",
              commandActions: [],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
          },
        },
      });
      await flushAsyncWork();
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            completedAtMs: 130,
            item: {
              id: "target",
              type: "commandExecution",
              command: "printf target",
              cwd: "/tmp",
              processId: null,
              pluginId: null,
              scriptPath: null,
              source: "agent",
              status: "completed",
              commandActions: [],
              aggregatedOutput: "target\n",
              exitCode: 0,
              durationMs: 10,
            },
          },
        },
      });
      await flushAsyncWork();

      turn = manager.readConversation("thread-1")?.turns[0];
      expect(JSON.stringify(turn?.items.map((item) => item.itemId))).toBe(
        JSON.stringify(["before", "target", "after"]),
      );
      expect(turn?.items[1]?.status).toBe("completed");
      expect(
        managerInternals.ownerHiddenLifecycleItemTypesByConversationId
          .get("thread-1")
          ?.get("turn-1")
          ?.has("target") ?? false,
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner rejects a hidden mismatched completion without removing the visible row", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["shared-id"],
            firstTurnWorkItemStartedAtMs: 1,
            items: [buildCommandExecutionItem("thread-1", "turn-1", "shared-id")],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            completedAtMs: 110,
            item: {
              id: "shared-id",
              type: "exitedReviewMode",
              review: "Mismatched hidden completion",
            },
          },
        },
      });
      await flushAsyncWork();

      const item = manager.readConversation("thread-1")?.turns[0]?.items[0];
      expect(item?.itemId).toBe("shared-id");
      expect(item?.kind).toBe("commandExecution");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner does not rebind a hidden-only completed null-ID turn as empty", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const managerInternals = manager as unknown as {
      ownerHiddenLifecycleItemTypesByConversationId: Map<
        string,
        Map<string | null, Map<string, string>>
      >;
    };
    try {
      const hydratedConversation = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: null as unknown as string,
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      });
      const canonicalTurn = hydratedConversation.canonicalState?.turns[0];
      if (!canonicalTurn) throw new Error("Expected canonical hidden-item fixture turn");
      const baseConversation: CodexConversationSnapshot = {
        ...hydratedConversation,
        canonicalState: {
          ...hydratedConversation.canonicalState!,
          turns: [
            {
              ...canonicalTurn,
              items: [
                {
                  id: "hidden-review-marker",
                  type: "exitedReviewMode",
                  review: "Hidden review marker",
                },
              ],
            },
          ],
        },
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      managerInternals.ownerHiddenLifecycleItemTypesByConversationId.set(
        "thread-1",
        new Map([[null, new Map([["hidden-review-marker", "exitedReviewMode"]])]]),
      );

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-after-hidden-placeholder",
            startedAtMs: 200,
            item: {
              id: "assistant-after-hidden-placeholder",
              type: "agentMessage",
              text: "",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });
      await flushAsyncWork();

      const turns = manager.readConversation("thread-1")?.turns ?? [];
      expect(turns.length).toBe(2);
      expect((turns[0] as { turnId: string | null } | undefined)?.turnId ?? null).toBe(null);
      expect(turns[1]?.turnId).toBe("turn-after-hidden-placeholder");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner suppresses a valid heartbeat start when it matches a pending steer", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const heartbeatText = [
      "<heartbeat>",
      "<current_time_iso>2026-07-10T00:00:00Z</current_time_iso>",
      "<instructions>check fixture</instructions>",
      "</heartbeat>",
    ].join("\n");
    const manager = new CodexAppServerManager("default");
    try {
      const hydratedConversation = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        pendingSteers: [
          {
            steerId: "steer-heartbeat",
            threadId: "thread-1",
            turnId: "turn-1",
            prompt: heartbeatText,
            createdAt: 1,
          },
        ],
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      });
      const canonicalTurn = hydratedConversation.canonicalState?.turns[0];
      if (!canonicalTurn) throw new Error("Expected canonical heartbeat fixture turn");
      const baseConversation: CodexConversationSnapshot = {
        ...hydratedConversation,
        canonicalState: {
          ...hydratedConversation.canonicalState!,
          turns: [
            {
              ...canonicalTurn,
              items: [
                {
                  type: "steeringUserMessage",
                  id: "steer-heartbeat",
                  targetTurnId: "turn-1",
                  targetTurnStartedAtMs: null,
                  status: "pending",
                  clientUserMessageId: "steer-heartbeat",
                  input: [{ type: "text", text: heartbeatText, text_elements: [] }],
                  attachments: [],
                  restoreMessage: {
                    queueRow: createCodexQueuedFollowUp({
                      followUpId: "follow-up-steer-heartbeat",
                      clientUserMessageId: "steer-heartbeat",
                      threadId: "thread-1",
                      prompt: heartbeatText,
                      createdAtMs: 1,
                    }),
                    context: { commentAttachments: [] },
                  },
                  compareKey: { rawText: heartbeatText, imageCount: 0 },
                },
              ],
            },
          ],
        },
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "heartbeat-matching-steer",
              type: "userMessage",
              clientId: null,
              content: [{ type: "text", text: heartbeatText, text_elements: [] }],
            },
          },
        },
      });
      await flushAsyncWork();
      const afterMatchingHeartbeat = manager.readConversation("thread-1")?.turns[0]?.items ?? [];
      expect(afterMatchingHeartbeat.map((item) => item.itemId)).toEqual(["steer-heartbeat"]);

      const differentHeartbeatText = heartbeatText.replace(
        "check fixture",
        "check another fixture",
      );
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "heartbeat-not-matching-steer",
              type: "userMessage",
              clientId: null,
              content: [
                {
                  type: "text",
                  text: differentHeartbeatText,
                  text_elements: [],
                },
              ],
            },
          },
        },
      });
      await flushAsyncWork();
      expect(
        manager
          .readConversation("thread-1")
          ?.turns[0]?.items.some((item) => item.itemId === "heartbeat-not-matching-steer"),
      ).toBe(true);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner item completion drains pending prose delta patches first", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "")],
          },
        ],
      });
      const delta = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta,
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-1",
              type: "agentMessage",
              text: delta,
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 120));

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const ownerSequences = publishRecords.map((record) => {
        const input = record.args[0] as { ownerNotificationSequence?: number } | undefined;
        return String(input?.ownerNotificationSequence ?? 0);
      });
      const deltaPublishIndex = ownerSequences.indexOf("1");
      const completedPublishIndex = ownerSequences.indexOf("2");
      expect(deltaPublishIndex >= 0).toBe(true);
      expect(completedPublishIndex > deltaPublishIndex).toBe(true);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(delta);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.status).toBe("completed");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner turn lifecycle notifications publish snapshots", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: buildProtocolTurn({
              id: "turn-1",
              status: "inProgress",
            }),
          },
        },
      });
      await flushAsyncWork();

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: buildProtocolTurn({
              id: "turn-1",
              status: "completed",
              durationMs: 42,
            }),
          },
        },
      });
      await flushAsyncWork();

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const firstPublish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      const secondPublish = publishRecords[1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      expect(String(publishRecords.length)).toBe("2");
      expect(firstPublish?.ownerNotificationSequence).toBe(1);
      expect(firstPublish?.change?.type).toBe("patches");
      expect(firstPublish?.change?.baseRevision).toBe(1);
      expect(firstPublish?.change?.revision).toBe(2);
      expect(secondPublish?.ownerNotificationSequence).toBe(2);
      expect(secondPublish?.change?.type).toBe("patches");
      expect(secondPublish?.change?.baseRevision).toBe(2);
      expect(secondPublish?.change?.revision).toBe(3);
      expect(manager.readConversation("thread-1")?.statusType).toBe("idle");
      expect(manager.readConversation("thread-1")?.turns[0]?.status).toBe("completed");
      expect(manager.readConversation("thread-1")?.turns[0]?.durationMs).toBe(42);
      expect(manager.readConversation("thread-1")?.canonicalState?.turns[0]?.protocol.status).toBe(
        "completed",
      );
      expect(
        manager.readConversation("thread-1")?.canonicalState?.turns[0]?.protocol.durationMs,
      ).toBe(42);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner thread status notifications publish patches", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        statusType: "idle",
        statusActiveFlags: [],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: {
              type: "active",
              activeFlags: ["waitingOnApproval"],
            },
          },
        },
      });
      await flushAsyncWork();

      const publishRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecord?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      expect(manager.readConversation("thread-1")?.statusType).toBe("active");
      expect(manager.readConversation("thread-1")?.statusActiveFlags[0]).toBe("waitingOnApproval");
      expect(manager.readConversation("thread-1")?.threadRuntimeStatus?.type).toBe("active");
      const runtimeStatus = manager.readConversation("thread-1")?.threadRuntimeStatus;
      expect(runtimeStatus?.type === "active" ? runtimeStatus.activeFlags[0] : null).toBe(
        "waitingOnApproval",
      );
      expect(manager.readConversation("thread-1")?.canonicalState?.protocol.status.type).toBe(
        "active",
      );
      expect(publishInput?.ownerNotificationSequence).toBe(1);
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toBe(1);
      expect(publishInput?.change?.revision).toBe(2);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner turn diff notifications publish patches", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      const beforeUpdatedAt = manager.readConversation("thread-1")?.updatedAt;
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "turn/diff/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            diff: "diff --git a/file.ts b/file.ts",
          },
        },
      });
      await flushAsyncWork();

      const publishRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecord?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      expect(manager.readConversation("thread-1")?.turns[0]?.diff).toBe(
        "diff --git a/file.ts b/file.ts",
      );
      expect(manager.readConversation("thread-1")?.canonicalState?.turns[0]?.sidecar.diff).toBe(
        "diff --git a/file.ts b/file.ts",
      );
      expect(manager.readConversation("thread-1")?.updatedAt).toBe(beforeUpdatedAt);
      expect(publishInput?.ownerNotificationSequence).toBe(1);
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toBe(1);
      expect(publishInput?.change?.revision).toBe(2);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner thread metadata notifications publish patches", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        threadName: "Old name",
        latestThreadSettings: {
          model: "gpt-5.3-codex",
          reasoningEffort: "medium",
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.3-codex",
              reasoning_effort: "medium",
              developer_instructions: null,
            },
          },
          personality: null,
        },
        latestCollaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-5.3-codex",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "thread-1",
            threadName: "New name",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "thread/settings/updated",
          params: {
            threadId: "thread-1",
            threadSettings: {
              cwd: "/repo-next",
              approvalPolicy: "on-request",
              approvalsReviewer: "user",
              sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: ["/repo-next"],
                networkAccess: false,
                excludeTmpdirEnvVar: false,
                excludeSlashTmp: false,
              },
              activePermissionProfile: null,
              model: "gpt-5.4-codex",
              modelProvider: "openai-next",
              serviceTier: "fast",
              effort: "high",
              summary: "concise",
              personality: "pragmatic",
              multiAgentMode: "explicitRequestOnly",
              collaborationMode: {
                mode: "plan",
                settings: {
                  model: "gpt-5.4-codex",
                  reasoning_effort: "high",
                  developer_instructions: null,
                },
              },
            },
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "thread/tokenUsage/updated",
          params: {
            turnId: "turn-1",
            threadId: "thread-1",
            tokenUsage: {
              total: {
                totalTokens: 100,
                inputTokens: 60,
                cachedInputTokens: 10,
                cacheWriteInputTokens: 0,
                outputTokens: 40,
                reasoningOutputTokens: 15,
              },
              last: {
                totalTokens: 20,
                inputTokens: 12,
                cachedInputTokens: 2,
                cacheWriteInputTokens: 0,
                outputTokens: 8,
                reasoningOutputTokens: 3,
              },
              modelContextWindow: 128000,
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const lastPublish = publishRecords[publishRecords.length - 1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; revision?: number };
          }
        | undefined;

      expect(conversation?.threadName).toBe("New name");
      expect(conversation?.latestThreadSettings?.model).toBe("gpt-5.4-codex");
      expect(conversation?.latestThreadSettings?.reasoningEffort).toBe("high");
      expect(conversation?.latestThreadSettings?.collaborationMode?.mode).toBe("plan");
      expect(conversation?.latestThreadSettings?.personality).toBe("pragmatic");
      expect(conversation?.latestTokenUsageInfo?.total.totalTokens).toBe(100);
      expect(conversation?.canonicalState?.sidecar.latestTokenUsageInfo?.total.totalTokens).toBe(
        100,
      );
      expect(conversation?.canonicalState?.protocol.name).toBe("New name");
      expect(conversation?.canonicalState?.sidecar.latestThreadSettings?.model).toBe(
        "gpt-5.4-codex",
      );
      expect(conversation?.modelProvider).toBe("openai-next");
      expect(conversation?.cwd).toBe("/repo-next");
      expect(conversation?.updatedAt).toBe(baseConversation.updatedAt);
      expect((conversation?.turns[0]?.tokenUsage ?? null) === null).toBe(true);
      expect(String(publishRecords.length)).toBe("2");
      expect(lastPublish?.ownerNotificationSequence).toBe(3);
      expect(lastPublish?.change?.type).toBe("patches");
      expect(lastPublish?.change?.revision).toBe(3);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner thread started notifications publish thread metadata from bundle 51037-51045", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        threadName: null,
        threadPreview: "Old preview",
        modelProvider: "openai",
        cwd: "/tmp/old",
        resumeState: "resuming",
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "thread/started",
          params: {
            thread: {
              id: "thread-1",
              extra: null,
              sessionId: "thread-1",
              forkedFromId: null,
              parentThreadId: null,
              preview: "Started preview",
              ephemeral: false,
              section: null,
              sectionEnteredAt: null,
              projectId: null,
              historyMode: "legacy",
              modelProvider: "openai-responses",
              createdAt: 10,
              updatedAt: 20,
              recencyAt: null,
              status: { type: "idle" },
              path: null,
              cwd: "/tmp/new",
              cliVersion: "test",
              source: "cli",
              canAcceptDirectInput: true,
              threadSource: null,
              agentNickname: null,
              agentRole: null,
              gitInfo: null,
              name: "Started title",
              turns: [],
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const publishRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecord?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;

      expect(conversation?.threadName).toBe("Started title");
      expect(conversation?.threadPreview).toBe("Started preview");
      expect(conversation?.modelProvider).toBe("openai-responses");
      expect(conversation?.cwd).toBe("/tmp/new");
      expect(conversation?.resumeState).toBe("resumed");
      expect(conversation?.statusType).toBe("idle");
      expect(String(conversation?.turns.length ?? -1)).toBe("1");
      expect(conversation?.canonicalState?.protocol.name).toBe("Started title");
      expect(conversation?.canonicalState?.protocol.preview).toBe("Started preview");
      expect(String(conversation?.canonicalState?.turns.length ?? -1)).toBe("1");
      expect(publishInput?.ownerNotificationSequence).toBe(1);
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toBe(1);
      expect(publishInput?.change?.revision).toBe(2);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner turn plan error and resolved request notifications publish patches", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const commandItem: CodexConversationItem = {
        ...buildCommandExecutionItem("thread-1", "turn-1", "cmd-1"),
        approvalRequestId: "approval-1",
      };
      const duplicateAttachedCommand: CodexConversationItem = {
        ...buildCommandExecutionItem("thread-1", "turn-1", "cmd-2"),
        approvalRequestId: "approval-1",
      };
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        statusActiveFlags: ["waitingOnApproval"],
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1", "cmd-2"],
            items: [commandItem, duplicateAttachedCommand],
          },
        ],
        requests: [
          {
            type: "approval",
            requestId: "approval-1",
            kind: "command",
            projectId: "project-1",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            createdAt: 1,
          },
        ],
        canonicalRequests: [
          {
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: {
              kind: "command",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "cmd-1",
              startedAtMs: 1,
              environmentId: null,
            },
          },
          {
            id: "approval-1",
            method: "item/commandExecution/requestApproval",
            params: {
              kind: "command",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "cmd-2",
              startedAtMs: 2,
              environmentId: null,
            },
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "turn/plan/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            explanation: "Plan",
            plan: [
              { step: "Inspect bundle", status: "completed" },
              { step: "Patch Nodex", status: "inProgress" },
            ],
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            error: {
              message: "Tool failed",
              codexErrorInfo: null,
              additionalDetails: "exit 1",
              misalignment: null,
            },
            willRetry: false,
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "model/rerouted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            fromModel: "gpt-a",
            toModel: "gpt-b",
            reason: "highRiskCyberActivity",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 4,
        notification: {
          method: "serverRequest/resolved",
          params: {
            threadId: "thread-1",
            requestId: "approval-1",
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const turn = conversation?.turns[0];
      const todoItem = turn?.items.find((item) => item.semanticKind === "todoList");
      const errorItem = turn?.items.find((item) => item.semanticKind === "systemError");
      const reroutedItem = turn?.items.find((item) => item.semanticKind === "modelRerouted");
      const command = turn?.items.find((item) => item.itemId === "cmd-1");
      const duplicateCommand = turn?.items.find((item) => item.itemId === "cmd-2");
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const ackRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );

      expect(todoItem?.semanticKind).toBe("todoList");
      expect(todoItem?.markdownText).toBe("1. [x] Inspect bundle\n2. [ ] Patch Nodex");
      expect(errorItem?.semanticKind).toBe("systemError");
      expect(errorItem?.additionalDetails).toBe("exit 1");
      expect(reroutedItem?.status).toBe("completed");
      expect(turn?.itemIds.includes(todoItem?.itemId ?? "")).toBe(true);
      expect(turn?.itemIds.includes(errorItem?.itemId ?? "")).toBe(true);
      expect(
        conversation?.canonicalState?.turns[0]?.items.some(
          (item) => item.id === todoItem?.itemId && item.type === "todo-list",
        ),
      ).toBe(true);
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(command?.approvalRequestId ?? null).toBe(null);
      expect(duplicateCommand?.approvalRequestId ?? null).toBe(null);
      expect(String(conversation?.statusActiveFlags.length ?? -1)).toBe("1");
      expect(String(publishRecords.length)).toBe("2");
      expect(
        (
          publishRecords[publishRecords.length - 1]?.args[0] as
            | { ownerNotificationSequence?: number }
            | undefined
        )?.ownerNotificationSequence,
      ).toBe(4);
      expect(String(ackRecords.length)).toBe("0");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner server requests publish request-plane patches from bundle 51920-52380", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const commandItem = buildCommandExecutionItem("thread-1", "turn-1", "cmd-1");
      const duplicateAttachedCommand: CodexConversationItem = {
        ...buildCommandExecutionItem("thread-1", "turn-1", "cmd-2"),
        approvalRequestId: "approval-1",
      };
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1", "cmd-2"],
            items: [commandItem, duplicateAttachedCommand],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: {
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            startedAtMs: 10,
            approvalId: null,
            environmentId: null,
            reason: "Need command access",
            command: "bun test",
            cwd: "/repo",
            commandActions: null,
            additionalPermissions: null,
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
            availableDecisions: null,
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 2,
        request: {
          id: "input-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "input-call-1",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "q1",
                header: "Question",
                question: "Pick one",
                isOther: false,
                isSecret: false,
                options: [{ label: "A", description: "Option A" }],
              },
            ],
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 3,
        request: {
          id: "permission-1",
          method: "item/permissions/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "permission-call-1",
            environmentId: "env-1",
            startedAtMs: 12,
            cwd: "/repo",
            reason: "Need network access",
            permissions: {
              network: {
                enabled: true,
              },
              fileSystem: null,
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const command = conversation?.turns[0]?.items.find((item) => item.itemId === "cmd-1");
      const userInputItem = conversation?.turns[0]?.items.find(
        (item) => item.itemId === "user-input-response-input-1",
      );
      const permissionItem = conversation?.turns[0]?.items.find(
        (item) => item.itemId === "permission-request-permission-1",
      );
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );

      expect(String(conversation?.requests.length ?? -1)).toBe("3");
      expect(
        JSON.stringify(conversation?.canonicalRequests?.map((request) => request.id) ?? []),
      ).toBe(JSON.stringify(["approval-1", "input-1", "permission-1"]));
      expect(JSON.stringify(conversation?.canonicalState?.requests ?? [])).toBe(
        JSON.stringify(conversation?.canonicalRequests ?? []),
      );
      expect(conversation?.hasUnreadTurn).toBe(true);
      expect(conversation?.requests[0]?.type).toBe("approval");
      expect(conversation?.requests[1]?.type).toBe("userInput");
      expect(conversation?.requests[2]?.type).toBe("permissionRequest");
      expect(command?.approvalRequestId).toBe("approval-1");
      expect(userInputItem?.kind).toBe("userInputResponse");
      expect(userInputItem?.status).toBe("inProgress");
      expect(String(userInputItem?.userInputQuestions?.length ?? -1)).toBe("1");
      expect(JSON.stringify(userInputItem?.rawItem)).toBe(
        JSON.stringify({
          id: "user-input-response-input-1",
          type: "userInputResponse",
          requestId: "input-1",
          turnId: "turn-1",
          questions: [
            {
              id: "q1",
              header: "Question",
              question: "Pick one",
              options: [{ description: "Option A", label: "A" }],
            },
          ],
          answers: {},
          completed: false,
        }),
      );
      expect(permissionItem?.semanticKind).toBe("permissionRequest");
      expect(permissionItem?.status).toBe("inProgress");
      expect(permissionItem?.markdownText).toBe("Need network access");
      expect(String(publishRecords.length)).toBe("2");
      expect(
        (
          publishRecords[publishRecords.length - 1]?.args[0] as
            | { ownerNotificationSequence?: number }
            | undefined
        )?.ownerNotificationSequence,
      ).toBe(3);

      await manager.respondUserInput("input-1", { q1: ["A"] });
      await manager.respondApproval("approval-1", { kind: "command", decision: "decline" });
      await manager.respondPermissionRequest("permission-1", { permissions: {}, scope: "turn" });
      await flushAsyncWork();

      const resolvedConversation = manager.readConversation("thread-1");
      const resolvedCommand = resolvedConversation?.turns[0]?.items.find(
        (item) => item.itemId === "cmd-1",
      );
      const duplicateResolvedCommand = resolvedConversation?.turns[0]?.items.find(
        (item) => item.itemId === "cmd-2",
      );
      const resolvedUserInputItem = resolvedConversation?.turns[0]?.items.find(
        (item) => item.itemId === "user-input-response-input-1",
      );
      const resolvedPermissionItem = resolvedConversation?.turns[0]?.items.find(
        (item) => item.itemId === "permission-request-permission-1",
      );
      const resolvedPublishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      expect(String(resolvedConversation?.requests.length ?? -1)).toBe("0");
      expect(String(resolvedConversation?.canonicalRequests?.length ?? -1)).toBe("0");
      expect(String(resolvedConversation?.canonicalState?.requests.length ?? -1)).toBe("0");
      expect(resolvedConversation?.hasUnreadTurn).toBe(true);
      expect(resolvedCommand?.approvalRequestId ?? null).toBe(null);
      expect(duplicateResolvedCommand?.approvalRequestId ?? null).toBe(null);
      expect(resolvedUserInputItem?.status).toBe("completed");
      expect(resolvedUserInputItem?.userInputAnswers?.q1?.[0]).toBe("A");
      expect(resolvedPermissionItem?.status).toBe("completed");
      expect(JSON.stringify(resolvedPermissionItem?.rawItem)).toBe(
        JSON.stringify({
          id: "permission-request-permission-1",
          type: "permissionRequest",
          requestId: "permission-1",
          turnId: "turn-1",
          reason: "Need network access",
          permissions: {
            network: {
              enabled: true,
            },
            fileSystem: null,
          },
          completed: true,
          response: {
            permissions: {},
            scope: "turn",
          },
        }),
      );
      expect(String(resolvedPublishRecords.length)).toBe("5");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner request state keeps numeric and textual ids distinct through resolved", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const commandItem = buildCommandExecutionItem("thread-1", "turn-1", "cmd-1");
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1"],
            items: [commandItem],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");

      const dispatchApproval = (id: string | number, sequence: number) => {
        dispatchCodexAppServerMessage("thread-owner-request", {
          hostId: "default",
          sequence,
          request: {
            id,
            method: "item/commandExecution/requestApproval",
            params: {
              kind: "command",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "cmd-1",
              startedAtMs: sequence,
              approvalId: null,
              environmentId: null,
              reason: `approval ${typeof id}`,
              command: "bun test",
              cwd: "/repo",
              commandActions: null,
              additionalPermissions: null,
              proposedExecpolicyAmendment: null,
              proposedNetworkPolicyAmendments: null,
              availableDecisions: null,
            },
          },
        });
      };
      dispatchApproval(73, 1);
      dispatchApproval("73", 2);
      await flushAsyncWork();

      let conversation = manager.readConversation("thread-1");
      expect(
        JSON.stringify(conversation?.canonicalRequests?.map((request) => request.id) ?? []),
      ).toBe(JSON.stringify([73, "73"]));
      expect(
        JSON.stringify(conversation?.canonicalState?.requests.map((request) => request.id) ?? []),
      ).toBe(JSON.stringify([73, "73"]));
      expect(JSON.stringify(conversation?.requests.map((request) => request.requestId) ?? [])).toBe(
        JSON.stringify([73, "73"]),
      );

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "serverRequest/resolved",
          params: { threadId: "thread-1", requestId: 73 },
        },
      });
      await flushAsyncWork();
      conversation = manager.readConversation("thread-1");
      expect(
        JSON.stringify(conversation?.canonicalRequests?.map((request) => request.id) ?? []),
      ).toBe(JSON.stringify(["73"]));
      expect(
        JSON.stringify(conversation?.canonicalState?.requests.map((request) => request.id) ?? []),
      ).toBe(JSON.stringify(["73"]));
      expect(conversation?.turns[0]?.items[0]?.approvalRequestId).toBe("73");

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 4,
        notification: {
          method: "serverRequest/resolved",
          params: { threadId: "thread-1", requestId: "73" },
        },
      });
      await flushAsyncWork();
      conversation = manager.readConversation("thread-1");
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("0");
      expect(String(conversation?.canonicalState?.requests.length ?? -1)).toBe("0");
      expect(conversation?.turns[0]?.items[0]?.approvalRequestId ?? null).toBe(null);
      expect(conversation?.hasUnreadTurn).toBe(true);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner request ingress replies and resolved notifications preserve transcript timestamps", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerRequestResponseHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const commandItem: CodexConversationItem = {
        ...buildCommandExecutionItem("thread-1", "turn-1", "cmd-1"),
        createdAt: 300,
        updatedAt: 400,
      };
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        createdAt: 100,
        updatedAt: 200,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1"],
            items: [commandItem],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");

      const baseline = manager.readConversation("thread-1");
      const baselineCreatedAt = baseline?.createdAt;
      const baselineUpdatedAt = baseline?.updatedAt;
      const baselineItemCreatedAt = baseline?.turns[0]?.items[0]?.createdAt;
      const baselineItemUpdatedAt = baseline?.turns[0]?.items[0]?.updatedAt;
      const assertTimestampsUnchanged = () => {
        const conversation = manager.readConversation("thread-1");
        const item = conversation?.turns[0]?.items[0];
        expect(conversation?.createdAt).toBe(baselineCreatedAt);
        expect(conversation?.updatedAt).toBe(baselineUpdatedAt);
        expect(item?.createdAt).toBe(baselineItemCreatedAt);
        expect(item?.updatedAt).toBe(baselineItemUpdatedAt);
      };
      const dispatchApproval = (requestId: string, sequence: number) => {
        dispatchCodexAppServerMessage("thread-owner-request", {
          hostId: "default",
          sequence,
          request: {
            id: requestId,
            method: "item/commandExecution/requestApproval",
            params: {
              kind: "command",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "cmd-1",
              startedAtMs: 10,
              approvalId: null,
              environmentId: null,
              reason: "Need command access",
              command: "bun test",
              cwd: "/repo",
              commandActions: null,
              additionalPermissions: null,
              proposedExecpolicyAmendment: null,
              proposedNetworkPolicyAmendments: null,
              availableDecisions: null,
            },
          },
        });
      };

      dispatchApproval("approval-local", 1);
      await flushAsyncWork();
      assertTimestampsUnchanged();

      expect(
        await manager.respondApproval(
          "approval-local",
          { kind: "command", decision: "decline" },
          "thread-1",
        ),
      ).toBe(true);
      await flushAsyncWork();
      assertTimestampsUnchanged();

      dispatchApproval("approval-resolved", 2);
      await flushAsyncWork();
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "serverRequest/resolved",
          params: {
            threadId: "thread-1",
            requestId: "approval-resolved",
          },
        },
      });
      await flushAsyncWork();
      assertTimestampsUnchanged();
    } finally {
      ownerRequestResponseHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner local interactive replies win when resolved arrives before IPC settles", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerRequestResponseHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        createdAt: 100,
        updatedAt: 200,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            turnStartedAtMs: 50,
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: {
          id: "user-race",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "input-call-1",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "q1",
                header: "Choice",
                question: "Pick one",
                isOther: false,
                isSecret: false,
                options: [{ label: "A", description: "First" }],
              },
            ],
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 2,
        request: {
          id: "permission-race",
          method: "item/permissions/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "permission-call-1",
            environmentId: "env-1",
            startedAtMs: 12,
            cwd: "/repo",
            reason: "Need network",
            permissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 3,
        request: {
          id: "mcp-race",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            mode: "openai/form",
            serverName: "Context7",
            message: "Allow this call?",
            requestedSchema: { type: "object", properties: {} },
            _meta: null,
          },
        },
      });
      await flushAsyncWork();

      const pendingConversation = manager.readConversation("thread-1");
      const pendingItems = pendingConversation?.turns[0]?.items ?? [];
      const pendingTimestamps = Object.fromEntries(
        pendingItems.map((item) => [item.itemId, `${item.createdAt}:${item.updatedAt}`]),
      );
      let resolvedSequence = 4;
      ownerRequestResponseHandler = async (_channel, args) => {
        await Promise.resolve();
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: resolvedSequence,
          notification: {
            method: "serverRequest/resolved",
            params: {
              threadId: String(args[0]),
              requestId: args[1] as CodexProtocolRequestId,
            },
          },
        });
        resolvedSequence += 1;
        return true;
      };

      expect(await manager.respondUserInput("user-race", { q1: ["A"] }, "thread-1")).toBe(true);
      expect(
        await manager.respondPermissionRequest(
          "permission-race",
          {
            permissions: {},
            scope: "turn",
          },
          "thread-1",
        ),
      ).toBe(true);
      expect(
        await manager.respondMcpElicitation(
          "mcp-race",
          {
            action: "accept",
            content: {},
            _meta: null,
          },
          "thread-1",
        ),
      ).toBe(true);
      await flushAsyncWork(4);

      const conversation = manager.readConversation("thread-1");
      const items = conversation?.turns[0]?.items ?? [];
      const userItem = items.find((item) => item.itemId === "user-input-response-user-race");
      const permissionItem = items.find(
        (item) => item.itemId === "permission-request-permission-race",
      );
      const mcpItem = items.find((item) => item.itemId === "mcp-server-elicitation-mcp-race");
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("0");
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(userItem?.userInputAnswers?.q1?.[0]).toBe("A");
      expect(
        JSON.stringify((permissionItem?.rawItem as { response?: unknown } | undefined)?.response),
      ).toBe(JSON.stringify({ permissions: {}, scope: "turn" }));
      expect((mcpItem?.rawItem as { action?: string | null } | undefined)?.action).toBe("accept");
      expect(conversation?.createdAt).toBe(100);
      expect(conversation?.updatedAt).toBe(200);
      for (const item of [userItem, permissionItem, mcpItem]) {
        expect(`${item?.createdAt}:${item?.updatedAt}`).toBe(pendingTimestamps[item?.itemId ?? ""]);
      }
    } finally {
      ownerRequestResponseHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner replies scope duplicate scalar request ids to the explicit conversation", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const requestId = "shared-owner-request-id";
    try {
      for (const [threadId, turnId] of [
        ["thread-owner-scope-first", "turn-owner-scope-first"],
        ["thread-owner-scope-second", "turn-owner-scope-second"],
      ] as const) {
        const conversation: CodexConversationSnapshot = {
          ...buildConversation(threadId, "project-1"),
          turns: [{ threadId, turnId, status: "inProgress", itemIds: [], items: [] }],
        };
        resumeThreadResult = conversation;
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "default",
          conversationId: threadId,
          version: 1,
          change: { type: "snapshot", revision: 1, conversationState: conversation },
          sourceClientId: "test-owner",
        });
        await manager.requestThreadStreamResume(threadId);
        dispatchCodexAppServerMessage("thread-owner-request", {
          hostId: "default",
          sequence: 1,
          request: {
            id: requestId,
            method: "item/commandExecution/requestApproval",
            params: {
              kind: "command",
              threadId,
              turnId,
              itemId: `command-${turnId}`,
              startedAtMs: 1,
              approvalId: null,
              environmentId: null,
              reason: "Conversation-scoped reply",
              command: "bun test",
              cwd: "/repo",
              commandActions: null,
              additionalPermissions: null,
              proposedExecpolicyAmendment: null,
              proposedNetworkPolicyAmendments: null,
              availableDecisions: null,
            },
          },
        });
      }
      await flushAsyncWork();
      invokeRecords = [];

      expect(
        await manager.respondApproval(
          requestId,
          { kind: "command", decision: "decline" },
          "thread-owner-scope-second",
        ),
      ).toBe(true);

      const responseCall = invokeRecords.find(
        (record) => record.channel === "codex:approval:respond",
      );
      expect(responseCall?.args[0]).toBe("thread-owner-scope-second");
      expect(manager.readConversation("thread-owner-scope-first")?.canonicalRequests?.length).toBe(
        1,
      );
      expect(manager.readConversation("thread-owner-scope-first")?.requests.length).toBe(1);
      expect(manager.readConversation("thread-owner-scope-second")?.canonicalRequests?.length).toBe(
        0,
      );
      expect(manager.readConversation("thread-owner-scope-second")?.requests.length).toBe(0);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower request replies wait for the owner stream revision before resolving", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = { accepted: true, streamRevision: 2 };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    let resolved = false;
    let accepted = false;
    const commandItem: CodexConversationItem = {
      ...buildCommandExecutionItem("thread-1", "turn-1", "cmd-follower-approval"),
      approvalRequestId: "approval-follower",
    };
    const pendingConversation: CodexConversationSnapshot = {
      ...buildConversation("thread-1", "project-1"),
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "inProgress",
          itemIds: ["cmd-follower-approval"],
          items: [commandItem],
        },
      ],
      requests: [
        {
          type: "approval",
          requestId: "approval-follower",
          kind: "command",
          projectId: "project-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "cmd-follower-approval",
          createdAt: 1,
        },
      ],
      canonicalRequests: [
        {
          id: "approval-follower",
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-follower-approval",
            startedAtMs: 1,
            environmentId: null,
          },
        },
      ],
    };

    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: pendingConversation,
        },
        sourceClientId: "owner-a",
      });

      const responsePromise = manager
        .respondApproval("approval-follower", { kind: "command", decision: "decline" }, "thread-1")
        .then((result) => {
          resolved = true;
          accepted = result;
        });
      await flushAsyncWork();
      expect(resolved).toBe(false);

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "snapshot",
          revision: 2,
          conversationState: {
            ...pendingConversation,
            turns: [
              {
                ...pendingConversation.turns[0]!,
                items: [{ ...commandItem, approvalRequestId: null }],
              },
            ],
            requests: [],
            canonicalRequests: [],
          },
        },
        sourceClientId: "owner-a",
      });
      await responsePromise;

      const action = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      )?.args[0] as
        | {
            action?: {
              type?: string;
              conversationId?: string;
              requestId?: string | number;
              response?: { kind?: "command" | "file"; decision?: string };
            };
          }
        | undefined;
      expect(resolved).toBe(true);
      expect(accepted).toBe(true);
      expect(action?.action?.type).toBe("respondApproval");
      expect(action?.action?.conversationId).toBe("thread-1");
      expect(action?.action?.requestId).toBe("approval-follower");
      expect(action?.action?.response?.kind).toBe("command");
      expect(manager.readConversation("thread-1")?.requests.length).toBe(0);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("owner approval reducer blocks both routes behind an opposite first same-id envelope", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerRequestResponseHandler = async () => false;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const runCollision = async (input: {
      threadId: string;
      requestId: string;
      firstKind: "command" | "file";
    }) => {
      const turnId = `turn-${input.requestId}`;
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation(input.threadId, "project-1"),
        turns: [
          {
            threadId: input.threadId,
            turnId,
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: input.threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await manager.requestThreadStreamResume(input.threadId);

      const commandRequest = {
        id: input.requestId,
        method: "item/commandExecution/requestApproval" as const,
        params: {
          kind: "command" as const,
          threadId: input.threadId,
          turnId,
          itemId: `command-${input.requestId}`,
          startedAtMs: 1,
          approvalId: null,
          environmentId: null,
          reason: "Command route",
          command: "bun test",
          cwd: "/repo",
          commandActions: null,
          additionalPermissions: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
          availableDecisions: null,
        },
      };
      const fileRequest = {
        id: input.requestId,
        method: "item/fileChange/requestApproval" as const,
        params: {
          threadId: input.threadId,
          turnId,
          itemId: `file-${input.requestId}`,
          startedAtMs: 1,
          reason: "File route",
          grantRoot: "/repo",
        },
      };
      const firstRequest = input.firstKind === "command" ? commandRequest : fileRequest;
      const secondRequest = input.firstKind === "command" ? fileRequest : commandRequest;
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: firstRequest,
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 2,
        request: secondRequest,
      });
      await flushAsyncWork();
      invokeRecords = [];

      const wrongKind = input.firstKind === "command" ? "file" : "command";
      expect(
        await manager.respondApproval(
          input.requestId,
          { kind: wrongKind, decision: "decline" },
          input.threadId,
        ),
      ).toBe(false);

      const responseCall = invokeRecords.find(
        (record) => record.channel === "codex:approval:respond",
      );
      expect(responseCall?.args[2]).toEqual({ kind: wrongKind, decision: "decline" });
      expect(
        JSON.stringify(
          manager
            .readConversation(input.threadId)
            ?.canonicalRequests?.map((request) => request.method) ?? [],
        ),
      ).toBe(JSON.stringify([firstRequest.method, secondRequest.method]));
      expect(manager.readConversation(input.threadId)?.requests.length).toBe(2);
      expect(manager.readConversation(input.threadId)?.resumeState).toBe("resumed");
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(false);
    };

    try {
      await runCollision({
        threadId: "thread-owner-file-first-route",
        requestId: "owner-file-first-route",
        firstKind: "file",
      });
      await runCollision({
        threadId: "thread-owner-command-first-route",
        requestId: "owner-command-first-route",
        firstKind: "command",
      });
    } finally {
      ownerRequestResponseHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner response actions no-op after the request has already resolved", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const threadId = "thread-owner-resolved-before-action";
    const conversation = buildConversation(threadId, "project-1");
    resumeThreadResult = conversation;
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: conversation,
        },
        sourceClientId: "test-owner",
      });
      await manager.requestThreadStreamResume(threadId);
      invokeRecords = [];

      const result = await manager.handleThreadOwnerActionRequest({
        type: "respondApproval",
        conversationId: threadId,
        requestId: "already-resolved",
        response: { kind: "command", decision: "decline" },
      });

      expect(JSON.stringify(result)).toBe(JSON.stringify({ accepted: true }));
      expect(manager.readConversation(threadId)?.resumeState).toBe("resumed");
      expect(invokeRecords.some((record) => record.channel === "codex:approval:respond")).toBe(
        false,
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower approval actions preserve the requested route kind for both opposite-first collisions", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = { accepted: true };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const runCollision = async (input: {
      threadId: string;
      requestId: string;
      firstKind: "command" | "file";
    }) => {
      const turnId = `turn-${input.requestId}`;
      const commandRequest = {
        id: input.requestId,
        method: "item/commandExecution/requestApproval" as const,
        params: {
          kind: "command" as const,
          threadId: input.threadId,
          turnId,
          itemId: `command-${input.requestId}`,
          startedAtMs: 1,
          approvalId: null,
          environmentId: null,
          reason: "Command route",
          command: "bun test",
          cwd: "/repo",
          commandActions: null,
          additionalPermissions: null,
          proposedExecpolicyAmendment: null,
          proposedNetworkPolicyAmendments: null,
          availableDecisions: null,
        },
      };
      const fileRequest = {
        id: input.requestId,
        method: "item/fileChange/requestApproval" as const,
        params: {
          threadId: input.threadId,
          turnId,
          itemId: `file-${input.requestId}`,
          startedAtMs: 1,
          reason: "File route",
          grantRoot: "/repo",
        },
      };
      const firstRequest = input.firstKind === "command" ? commandRequest : fileRequest;
      const secondRequest = input.firstKind === "command" ? fileRequest : commandRequest;
      const secondKind = input.firstKind === "command" ? "file" : "command";
      const pendingConversation: CodexConversationSnapshot = {
        ...buildConversation(input.threadId, "project-1"),
        turns: [
          {
            threadId: input.threadId,
            turnId,
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
        canonicalRequests: [firstRequest, secondRequest],
        requests: [
          {
            type: "approval",
            requestId: input.requestId,
            kind: input.firstKind,
            projectId: "project-1",
            threadId: input.threadId,
            turnId,
            itemId: firstRequest.params.itemId,
            createdAt: 1,
          },
          {
            type: "approval",
            requestId: input.requestId,
            kind: secondKind,
            projectId: "project-1",
            threadId: input.threadId,
            turnId,
            itemId: secondRequest.params.itemId,
            createdAt: 2,
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: input.threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: pendingConversation,
        },
        sourceClientId: "owner-a",
      });
      invokeRecords = [];

      const wrongKind = input.firstKind === "command" ? "file" : "command";
      expect(
        await manager.respondApproval(
          input.requestId,
          { kind: wrongKind, decision: "decline" },
          input.threadId,
        ),
      ).toBe(true);

      const routed = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      )?.args[0] as
        | {
            action?: { type?: string; response?: { kind?: "command" | "file" } };
          }
        | undefined;
      expect(routed?.action?.type).toBe("respondApproval");
      expect(routed?.action?.response?.kind).toBe(wrongKind);
      expect(manager.readConversation(input.threadId)?.canonicalRequests?.length).toBe(2);
      expect(manager.readConversation(input.threadId)?.requests.length).toBe(2);
      expect(invokeRecords.some((record) => record.channel === "codex:approval:respond")).toBe(
        false,
      );
    };

    try {
      await runCollision({
        threadId: "thread-follower-file-first-route",
        requestId: "follower-file-first-route",
        firstKind: "file",
      });
      await runCollision({
        threadId: "thread-follower-command-first-route",
        requestId: "follower-command-first-route",
        firstKind: "command",
      });
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("owner unmatched resolved keeps orphan request view but emits a canonical array transition", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const commandItem: CodexConversationItem = {
        ...buildCommandExecutionItem("thread-1", "turn-1", "cmd-1"),
        approvalRequestId: "orphan-view",
      };
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1"],
            items: [commandItem],
          },
        ],
        requests: [
          {
            type: "approval",
            requestId: "orphan-view",
            kind: "command",
            projectId: "project-1",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            createdAt: 1,
          },
        ],
        canonicalRequests: [
          {
            id: "canonical-1",
            method: "item/commandExecution/requestApproval",
            params: {
              kind: "command",
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "cmd-1",
              startedAtMs: 1,
              environmentId: null,
            },
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await manager.requestThreadStreamResume("thread-1");
      const before = manager.readConversation("thread-1");
      let transitions = 0;
      const stop = manager.addConversationCallback("thread-1", () => {
        transitions += 1;
      });
      try {
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: 1,
          notification: {
            method: "serverRequest/resolved",
            params: {
              threadId: "thread-1",
              requestId: "missing",
            },
          },
        });
        await flushAsyncWork();
      } finally {
        stop();
      }

      const after = manager.readConversation("thread-1");
      expect(after?.requests[0]?.requestId).toBe("orphan-view");
      expect(after?.turns[0]?.items[0]?.approvalRequestId).toBe("orphan-view");
      expect(after?.canonicalRequests?.[0]?.id).toBe("canonical-1");
      expect(after?.canonicalRequests === before?.canonicalRequests).toBe(false);
      expect(transitions).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner dynamic tool-call request invokes main and acks without stream patches from bundle 51920-52390", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-dynamic", "project-1"),
        turns: [
          {
            threadId: "thread-dynamic",
            turnId: "turn-dynamic",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-dynamic",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await manager.requestThreadStreamResume("thread-dynamic");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: {
          id: "dynamic-1",
          method: "item/tool/call",
          params: {
            threadId: "thread-dynamic",
            turnId: "turn-dynamic",
            callId: "call-dynamic",
            namespace: "codex_app",
            tool: "list_projects",
            arguments: {},
          },
        },
      });
      await flushAsyncWork();

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const ackRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      const dynamicToolRecords = invokeRecords.filter(
        (record) => record.channel === "codex:dynamic-tool-call:respond",
      );
      const conversation = manager.readConversation("thread-dynamic");

      expect(String(dynamicToolRecords.length)).toBe("1");
      expect(JSON.stringify(dynamicToolRecords[0]?.args)).toBe(
        JSON.stringify([
          "thread-dynamic",
          "dynamic-1",
          {
            permissionMode: "custom",
            serviceTierSelector: { type: "standard" },
          },
        ]),
      );
      expect(String(ackRecords.length)).toBe("1");
      expect(
        (ackRecords[0]?.args[0] as { conversationId?: string; sequence?: number } | undefined)
          ?.conversationId,
      ).toBe("thread-dynamic");
      expect(
        (ackRecords[0]?.args[0] as { conversationId?: string; sequence?: number } | undefined)
          ?.sequence,
      ).toBe(1);
      expect(String(publishRecords.length)).toBe("0");
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner onboarding, option-picker, and setup-step replies remove only their canonical raw requests", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerRequestResponseHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const threadId = "thread-special-dynamic-owner";
    const turnId = "turn-special-dynamic-owner";
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation(threadId, "project-1"),
        turns: [
          {
            threadId,
            turnId,
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await manager.requestThreadStreamResume(threadId);
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: {
          id: "onboarding-owner-1",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call-onboarding-owner-1",
            namespace: "codex_app",
            tool: "request_onboarding_input",
            arguments: {
              questions: [
                {
                  id: "first_task",
                  header: "Start",
                  question: "What should Codex do first?",
                  options: [{ label: "Audit" }, { label: "Build" }],
                },
              ],
            },
          },
        },
      });
      await flushAsyncWork();
      expect(manager.readConversation(threadId)?.canonicalRequests?.[0]?.id).toBe(
        "onboarding-owner-1",
      );
      expect(String(manager.readConversation(threadId)?.turns[0]?.items.length ?? -1)).toBe("0");

      invokeRecords = [];
      expect(
        await manager.respondUserInput("onboarding-owner-1", { first_task: ["Audit"] }, threadId),
      ).toBe(true);
      let conversation = manager.readConversation(threadId);
      const onboardingCall = invokeRecords.find(
        (record) => record.channel === "codex:user-input:respond",
      );
      expect(JSON.stringify(onboardingCall?.args)).toBe(
        JSON.stringify([threadId, "onboarding-owner-1", { first_task: ["Audit"] }]),
      );
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("0");
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(String(conversation?.turns[0]?.items.length ?? -1)).toBe("0");

      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 2,
        request: {
          id: "option-picker-owner-2",
          method: "item/tool/requestOptionPicker",
          params: {
            threadId,
            turnId,
            question: "Choose the next slice",
            options: [{ label: "Surface" }],
          },
        },
      });
      await flushAsyncWork();
      const optionResponse = {
        action: "submit" as const,
        selectedOptions: ["Surface"],
        freeformAnswer: null,
      };
      expect(
        await manager.respondOptionPicker(threadId, "option-picker-owner-2", optionResponse),
      ).toBe(true);
      const optionCall = invokeRecords.find(
        (record) => record.channel === "codex:option-picker:respond",
      );
      expect(JSON.stringify(optionCall?.args)).toBe(
        JSON.stringify([threadId, "option-picker-owner-2", optionResponse]),
      );
      expect(String(manager.readConversation(threadId)?.canonicalRequests?.length ?? -1)).toBe("0");

      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 3,
        request: {
          id: "setup-role-owner-3",
          method: "item/tool/call",
          params: {
            threadId,
            turnId,
            callId: "call-setup-role-owner-3",
            namespace: "codex_app",
            tool: "setup_codex_step",
            arguments: { step: "role" },
          },
        },
      });
      await flushAsyncWork();
      expect(manager.readConversation(threadId)?.canonicalRequests?.[0]?.id).toBe(
        "setup-role-owner-3",
      );

      invokeRecords = [];
      const roleResponse = {
        step: "role" as const,
        action: "submit" as const,
        selectedRoles: ["engineer"],
      };
      expect(
        await manager.respondSetupCodexStep(threadId, "setup-role-owner-3", roleResponse),
      ).toBe(true);
      conversation = manager.readConversation(threadId);
      const setupCall = invokeRecords.find(
        (record) => record.channel === "codex:setup-codex-step:respond",
      );
      expect(JSON.stringify(setupCall?.args)).toBe(
        JSON.stringify([threadId, "setup-role-owner-3", roleResponse]),
      );
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("0");
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(String(conversation?.turns[0]?.items.length ?? -1)).toBe("0");
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(true);
    } finally {
      ownerRequestResponseHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower onboarding and setup-step replies preserve raw state until the owner publishes", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = true;
    followerActionError = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const threadId = "thread-special-dynamic-follower";
    const turnId = "turn-special-dynamic-follower";
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation(threadId, "project-1"),
        hasUnreadTurn: true,
        turns: [
          {
            threadId,
            turnId,
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
        canonicalRequests: [
          {
            id: "onboarding-follower-1",
            method: "item/tool/call",
            params: {
              threadId,
              turnId,
              callId: "call-onboarding-follower-1",
              namespace: "codex_app",
              tool: "request_onboarding_input",
              arguments: {
                questions: [
                  {
                    id: "first_task",
                    question: "What should Codex do first?",
                    options: [{ label: "Audit" }, { label: "Build" }],
                  },
                ],
              },
            },
          },
          {
            id: "option-picker-follower-2",
            method: "item/tool/requestOptionPicker",
            params: {
              threadId,
              turnId,
              question: "Choose the next slice",
              options: [{ label: "Surface" }],
            },
          },
          {
            id: "setup-task-follower-3",
            method: "item/tool/call",
            params: {
              threadId,
              turnId,
              callId: "call-setup-task-follower-3",
              namespace: "codex_app",
              tool: "setup_codex_step",
              arguments: { step: "task" },
            },
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 8,
          conversationState: baseConversation,
        },
        sourceClientId: "owner-a",
      });

      expect(
        await manager.respondUserInput(
          "onboarding-follower-1",
          { first_task: ["Audit"] },
          threadId,
        ),
      ).toBe(true);
      const optionResponse = {
        action: "submit" as const,
        selectedOptions: ["Surface"],
        freeformAnswer: null,
      };
      expect(
        await manager.respondOptionPicker(threadId, "option-picker-follower-2", optionResponse),
      ).toBe(true);
      const taskResponse = {
        step: "task" as const,
        action: "skip" as const,
        answers: { first_task: { answers: ["Ship parity"] } },
      };
      expect(
        await manager.respondSetupCodexStep(threadId, "setup-task-follower-3", taskResponse),
      ).toBe(true);

      const followerActions = invokeRecords
        .filter((record) => record.channel === "codex:thread-follower:action")
        .map(
          (record) =>
            record.args[0] as {
              conversationId?: string;
              action?: {
                type?: string;
                conversationId?: string;
                requestId?: string;
                answers?: Record<string, string[]>;
                response?: unknown;
              };
            },
        );
      expect(String(followerActions.length)).toBe("3");
      expect(JSON.stringify(followerActions[0])).toBe(
        JSON.stringify({
          conversationId: threadId,
          action: {
            type: "respondUserInput",
            conversationId: threadId,
            requestId: "onboarding-follower-1",
            answers: { first_task: ["Audit"] },
          },
        }),
      );
      expect(JSON.stringify(followerActions[1])).toBe(
        JSON.stringify({
          conversationId: threadId,
          action: {
            type: "respondOptionPicker",
            conversationId: threadId,
            requestId: "option-picker-follower-2",
            response: optionResponse,
          },
        }),
      );
      expect(JSON.stringify(followerActions[2])).toBe(
        JSON.stringify({
          conversationId: threadId,
          action: {
            type: "respondSetupCodexStep",
            conversationId: threadId,
            requestId: "setup-task-follower-3",
            response: taskResponse,
          },
        }),
      );
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:user-input:respond" ||
            record.channel === "codex:option-picker:respond" ||
            record.channel === "codex:setup-codex-step:respond",
        ),
      ).toBe(false);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(false);
      expect(
        JSON.stringify(
          manager.readConversation(threadId)?.canonicalRequests?.map((request) => request.id) ?? [],
        ),
      ).toBe(
        JSON.stringify([
          "onboarding-follower-1",
          "option-picker-follower-2",
          "setup-task-follower-3",
        ]),
      );
      expect(String(manager.readConversation(threadId)?.turns[0]?.items.length ?? -1)).toBe("0");
    } finally {
      followerActionResult = null;
      followerActionError = null;
      manager.destroy();
    }
  });

  test("local and standalone unread changes do not advance the renderer stream revision", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const threadId = "thread-standalone-unread";
    const managerInternals = manager as unknown as {
      streamState: { getRevision: (targetThreadId: string) => number | null };
    };
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 17,
          conversationState: {
            ...buildConversation(threadId, "project-1"),
            hasUnreadTurn: false,
            unreadMessageCount: 3,
          },
        },
        sourceClientId: "test-owner",
      });
      invokeRecords = [];

      await manager.markConversationAsRead(threadId);
      expect(
        invokeRecords.some((record) => record.channel === "codex:conversation-unread:set"),
      ).toBe(false);

      await manager.markConversationAsUnread(threadId);
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(true);
      expect(manager.readThreadSummary(threadId)?.hasUnreadTurn).toBe(true);
      expect(managerInternals.streamState.getRevision(threadId)).toBe(17);
      expect(
        JSON.stringify(
          invokeRecords
            .filter((record) => record.channel === "codex:conversation-unread:set")
            .map((record) => record.args),
        ),
      ).toBe(JSON.stringify([[threadId, true]]));
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(false);

      dispatchCodexAppServerMessage("thread-read-state-changed", {
        hostId: "default",
        conversationId: threadId,
        hasUnreadTurn: false,
      });
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(false);
      expect(manager.readConversation(threadId)?.unreadMessageCount).toBe(0);
      expect(manager.readThreadSummary(threadId)?.hasUnreadTurn).toBe(false);
      expect(managerInternals.streamState.getRevision(threadId)).toBe(17);
      expect(
        String(
          invokeRecords.filter((record) => record.channel === "codex:conversation-unread:set")
            .length,
        ),
      ).toBe("1");

      dispatchCodexAppServerMessage("thread-read-state-changed", {
        hostId: "other-host",
        conversationId: threadId,
        hasUnreadTurn: true,
      });
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(false);
      expect(managerInternals.streamState.getRevision(threadId)).toBe(17);
    } finally {
      manager.destroy();
    }
  });

  test("standalone read state survives an older in-flight owner request patch", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerStreamPublishHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const threadId = "thread-unread-owner-race";
    const publishInputs: Array<{
      change?: {
        type?: string;
        baseRevision?: number;
        revision?: number;
        patches?: CodexConversationStateUpdate[];
      };
    }> = [];
    const publishResolvers: Array<(accepted: boolean) => void> = [];
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation(threadId, "project-1"),
        hasUnreadTurn: true,
        turns: [
          {
            threadId,
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await manager.requestThreadStreamResume(threadId);
      ownerStreamPublishHandler = (input) => {
        publishInputs.push(input as (typeof publishInputs)[number]);
        if (publishInputs.length !== 1) return true;
        return new Promise<boolean>((resolve) => {
          publishResolvers.push(resolve);
        });
      };

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: {
          id: "input-unread-race",
          method: "item/tool/requestUserInput",
          params: {
            threadId,
            turnId: "turn-1",
            itemId: "input-unread-race",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "q1",
                header: "Continue",
                question: "Continue?",
                isOther: false,
                isSecret: false,
                options: [{ label: "Yes", description: "Continue" }],
              },
            ],
          },
        },
      });
      await flushAsyncWork();
      expect(publishInputs.length).toBe(1);

      dispatchCodexAppServerMessage("thread-read-state-changed", {
        hostId: "default",
        conversationId: threadId,
        hasUnreadTurn: false,
      });
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(false);

      publishResolvers.shift()?.(true);
      await flushAsyncWork(4);

      expect(publishInputs.length).toBe(1);
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(false);

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "model/safetyBuffering/updated",
          params: {
            threadId,
            turnId: "turn-1",
            model: "gpt-5.4-codex",
            useCases: ["latency"],
            reasons: ["warming"],
            showBufferingUi: true,
            fasterModel: "gpt-5.4-mini",
          },
        },
      });
      await flushAsyncWork(4);

      expect(publishInputs.length).toBe(2);
      expect(publishInputs[1]?.change?.baseRevision).toBe(publishInputs[0]?.change?.revision);
      const unreadPatch = publishInputs[1]?.change?.patches?.find(
        (patch) => patch.path.join(".") === "hasUnreadTurn",
      );
      expect(unreadPatch).toBe(undefined);
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(false);
    } finally {
      ownerStreamPublishHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner model safety buffering notification publishes canonical turn metadata", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      const beforeUpdatedAt = manager.readConversation("thread-1")?.updatedAt;
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "model/safetyBuffering/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            model: "gpt-5.4-codex",
            useCases: ["latency"],
            reasons: ["warming"],
            showBufferingUi: true,
            fasterModel: "gpt-5.4-mini",
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;

      expect(conversation?.turns[0]?.safetyBuffering?.showBufferingUi).toBe(true);
      expect(conversation?.turns[0]?.safetyBuffering?.useCases[0]).toBe("latency");
      expect(conversation?.turns[0]?.safetyBuffering?.reasons[0]).toBe("warming");
      expect(conversation?.turns[0]?.safetyBuffering?.fasterModel).toBe("gpt-5.4-mini");
      expect(conversation?.canonicalState?.turns[0]?.sidecar.safetyBuffering?.fasterModel).toBe(
        "gpt-5.4-mini",
      );
      expect(conversation?.updatedAt).toBe(beforeUpdatedAt);
      expect(String(publishRecords.length)).toBe("1");
      expect(publish?.ownerNotificationSequence).toBe(1);
      expect(publish?.change?.type).toBe("patches");
      expect(publish?.change?.baseRevision).toBe(1);
      expect(publish?.change?.revision).toBe(2);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner hook lifecycle notifications project one canonical hook occurrence", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "hook/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            run: {
              id: "hook-run-1",
              eventName: "preToolUse",
              handlerType: "command",
              executionMode: "sync",
              scope: "turn",
              sourcePath: "/workspace/.codex/hook.json",
              source: "project",
              displayOrder: 1n,
              status: "running",
              statusMessage: "Preparing context",
              startedAt: 10n,
              completedAt: null,
              durationMs: null,
              entries: [{ kind: "context", text: "Added AGENTS.md" }],
            },
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "hook/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            run: {
              id: "hook-run-1",
              eventName: "preToolUse",
              handlerType: "command",
              executionMode: "sync",
              scope: "turn",
              sourcePath: "/workspace/.codex/hook.json",
              source: "project",
              displayOrder: 1n,
              status: "completed",
              statusMessage: "Preparing context",
              startedAt: 10n,
              completedAt: 20n,
              durationMs: 10n,
              entries: [{ kind: "context", text: "Added AGENTS.md" }],
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const hookItems =
        conversation?.turns[0]?.items.filter((item) => item.itemId === "hook-run-1") ?? [];
      const hookItem = hookItems[0];
      const hookRun = hookItem?.rawItem as
        | { run?: { status?: string; entries?: Array<{ text?: string }> } }
        | undefined;
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const lastPublish = publishRecords[publishRecords.length - 1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;

      expect(String(hookItems.length)).toBe("1");
      expect(hookItem?.semanticKind).toBe("hook");
      expect(hookItem?.status).toBe("completed");
      expect(hookRun?.run?.status).toBe("completed");
      expect(hookRun?.run?.entries?.[0]?.text).toBe("Added AGENTS.md");
      expect(conversation?.canonicalState?.turns[0]?.sidecar.hookRuns?.[0]?.id).toBe("hook-run-1");
      expect(String(publishRecords.length)).toBe("2");
      expect(lastPublish?.ownerNotificationSequence).toBe(2);
      expect(lastPublish?.change?.type).toBe("patches");
      expect(lastPublish?.change?.baseRevision).toBe(2);
      expect(lastPublish?.change?.revision).toBe(3);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner automatic approval review notifications upsert one review item from bundle 48279-48302 and 51658-51660", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/autoApprovalReview/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            reviewId: "review-1",
            startedAtMs: 1,
            targetItemId: "item-command-1",
            review: {
              status: "inProgress",
              riskLevel: "medium",
              userAuthorization: "unknown",
              rationale: null,
            },
            action: {
              type: "command",
              source: "shell",
              command: "bun test",
              cwd: "/tmp/project",
            },
          },
        },
      });
      await flushAsyncWork();

      const startedConversation = manager.readConversation("thread-1");
      const startedItem = startedConversation?.turns[0]?.items.find(
        (item) => item.itemId === "automatic-approval-review:review-1",
      );
      const startedRaw = startedItem?.rawItem as
        | { status?: string; startedAtMs?: number }
        | undefined;

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/autoApprovalReview/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            reviewId: "review-1",
            startedAtMs: 1,
            completedAtMs: 2,
            targetItemId: "item-command-1",
            decisionSource: "agent",
            review: {
              status: "approved",
              riskLevel: "low",
              userAuthorization: "low",
              rationale: "This only runs tests.",
            },
            action: {
              type: "command",
              source: "shell",
              command: "bun test",
              cwd: "/tmp/project",
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const reviewItems =
        conversation?.turns[0]?.items.filter(
          (item) => item.itemId === "automatic-approval-review:review-1",
        ) ?? [];
      const reviewItem = reviewItems[0];
      const reviewRaw = reviewItem?.rawItem as
        | {
            status?: string;
            targetItemId?: string | null;
            startedAtMs?: number;
            completedAtMs?: number | null;
          }
        | undefined;
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const lastPublish = publishRecords[publishRecords.length - 1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;

      expect(String(reviewItems.length)).toBe("1");
      expect(startedItem?.status).toBe("inProgress");
      expect(startedRaw?.status).toBe("inProgress");
      expect(reviewItem?.semanticKind).toBe("automaticApprovalReview");
      expect(reviewItem?.status).toBe("completed");
      expect(reviewItem?.markdownText).toBe("This only runs tests.");
      expect(reviewRaw?.status).toBe("approved");
      expect(reviewRaw?.targetItemId).toBe("item-command-1");
      expect(String(reviewRaw?.startedAtMs)).toBe(String(startedRaw?.startedAtMs));
      expect(typeof reviewRaw?.completedAtMs).toBe("number");
      expect(String(publishRecords.length)).toBe("2");
      expect(lastPublish?.ownerNotificationSequence).toBe(2);
      expect(lastPublish?.change?.type).toBe("patches");
      expect(lastPublish?.change?.baseRevision).toBe(2);
      expect(lastPublish?.change?.revision).toBe(3);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner guardian warning appends an auto-review interruption item from bundle 48303-48324 and 51663-51664", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "guardianWarning",
          params: {
            threadId: "thread-1",
            message: "Unrelated guardian warning",
          },
        },
      });
      await flushAsyncWork();

      let conversation = manager.readConversation("thread-1");
      let warningItems =
        conversation?.turns[0]?.items.filter(
          (item) => item.semanticKind === "autoReviewInterruptionWarning",
        ) ?? [];
      let publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      expect(String(warningItems.length)).toBe("0");
      expect(String(publishRecords.length)).toBe("0");

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "guardianWarning",
          params: {
            threadId: "thread-1",
            message: "Automatic approval review rejected too many approval requests for this turn.",
          },
        },
      });
      await flushAsyncWork();

      conversation = manager.readConversation("thread-1");
      warningItems =
        conversation?.turns[0]?.items.filter(
          (item) => item.semanticKind === "autoReviewInterruptionWarning",
        ) ?? [];
      const warningItem = warningItems[0];
      const warningRaw = warningItem?.rawItem as { type?: string } | undefined;
      publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;

      expect(String(warningItems.length)).toBe("1");
      expect(warningItem?.type).toBe("autoReviewInterruptionWarning");
      expect(warningItem?.markdownText).toBe(
        "Automatic approval review rejected too many approval requests for this turn",
      );
      expect(warningRaw?.type).toBe("autoReviewInterruptionWarning");
      expect(String(publishRecords.length)).toBe("1");
      expect(publish?.ownerNotificationSequence).toBe(2);
      expect(publish?.change?.type).toBe("patches");
      expect(publish?.change?.baseRevision).toBe(1);
      expect(publish?.change?.revision).toBe(2);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner text queue hidden-window fallback flushes the full delta without rAF slicing", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    let requestAnimationFrameCalled = false;
    if (browserWindow) {
      browserWindow.requestAnimationFrame = (() => {
        requestAnimationFrameCalled = true;
        return 1;
      }) as Window["requestAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      const delta = "abcdefghijklmnopqrstuvwxyz0123456789";
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta,
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(requestAnimationFrameCalled).toBe(false);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(delta);
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      expect(String(publishRecords.length)).toBe("1");
    } finally {
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner assistant text delta publishes first frame on visible rAF", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    let requestAnimationFrameCallCount = 0;
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        requestAnimationFrameCallCount += 1;
        animationFrameCallbacks.push(callback);
        return 1;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      const delta = "abcdefghijklmnopqrstuvwxyz0123456789";
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta,
          },
        },
      });

      const item = manager.readConversation("thread-1")?.turns[0]?.items[0];
      expect(item?.markdownText).toBe("");
      expect(item?.status).toBe("inProgress");
      expect(String(requestAnimationFrameCallCount)).toBe("1");

      animationFrameCallbacks.shift()?.(16);

      const nextItem = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      expect(nextItem?.markdownText).toBe("abcdefghijklmnopqrstuvwx");
      expect(nextItem?.status).toBe("inProgress");
      expect(String(publishRecords.length)).toBe("1");
    } finally {
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner stream publish queue serializes prose patch IPC while local state advances", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerStreamPublishHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new CodexAppServerManager("default");
    const publishResolvers: Array<(accepted: boolean) => void> = [];
    const publishInputs: unknown[] = [];
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      ownerStreamPublishHandler = (input) => {
        publishInputs.push(input);
        if (publishInputs.length === 1) {
          return new Promise<boolean>((resolve) => {
            publishResolvers.push(resolve);
          });
        }
        return true;
      };

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "first ",
          },
        },
      });
      animationFrameCallbacks.shift()?.(16);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("first ");
      expect(String(publishInputs.length)).toBe("1");

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "second",
          },
        },
      });
      animationFrameCallbacks.shift()?.(32);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "first second",
      );
      expect(String(publishInputs.length)).toBe("1");

      publishResolvers.shift()?.(true);
      await flushAsyncWork(3);
      const secondPublish = publishInputs[1] as
        | {
            ownerNotificationSequence?: number;
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      expect(String(publishInputs.length)).toBe("2");
      expect(secondPublish?.ownerNotificationSequence).toBe(2);
      expect(secondPublish?.change?.type).toBe("patches");
      expect(secondPublish?.change?.baseRevision).toBe(2);
      expect(secondPublish?.change?.revision).toBe(3);
    } finally {
      ownerStreamPublishHandler = null;
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner history mutations wait for in-flight prose patch revisions", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    historyPageResult = null;
    ownerStreamPublishHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new CodexAppServerManager("default");
    const publishResolvers: Array<(accepted: boolean) => void> = [];
    const publishInputs: unknown[] = [];
    try {
      const latestTurn = {
        threadId: "thread-1",
        turnId: "turn-1",
        status: "inProgress" as const,
        itemIds: ["assistant-1"],
        items: [
          {
            ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
            status: "inProgress" as const,
          },
        ],
      };
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [latestTurn],
      };
      const completeConversation: CodexConversationSnapshot = {
        ...baseConversation,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-older",
            status: "completed",
            itemIds: [],
            items: [],
          },
          latestTurn,
        ],
      };
      const historyFixture = buildExactOlderHistoryPageFixture({
        partial: baseConversation,
        loaded: completeConversation,
      });
      resumeThreadResult = historyFixture.before;
      historyPageResult = historyFixture.page;
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      ownerStreamPublishHandler = (input) => {
        publishInputs.push(input);
        if (publishInputs.length === 1) {
          return new Promise<boolean>((resolve) => {
            publishResolvers.push(resolve);
          });
        }
        return true;
      };

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "hello",
          },
        },
      });
      animationFrameCallbacks.shift()?.(16);
      expect(String(publishInputs.length)).toBe("1");

      let historyPageResolved = false;
      const historyPagePromise = manager
        .handleThreadOwnerActionRequest({
          type: "loadHistoryPage",
          request: historyFixture.request,
        })
        .then((result) => {
          historyPageResolved = true;
          return result as { revision?: number };
        });
      await flushAsyncWork(3);

      expect(historyPageResolved).toBe(false);
      expect(String(publishInputs.length)).toBe("1");

      publishResolvers.shift()?.(true);
      const result = await historyPagePromise;
      await flushAsyncWork(2);

      const prosePatch = publishInputs[0] as
        | {
            change?: { type?: string; baseRevision?: number; revision?: number };
          }
        | undefined;
      const historyPublication = publishInputs[1] as
        | {
            change?: {
              type?: string;
              revision?: number;
              mutation?: {
                upsertTurns?: readonly { turnId?: string | null }[];
              };
            };
          }
        | undefined;
      expect(result.revision).toBe(3);
      expect(prosePatch?.change?.type).toBe("patches");
      expect(prosePatch?.change?.baseRevision).toBe(1);
      expect(prosePatch?.change?.revision).toBe(2);
      expect(historyPublication?.change?.type).toBe("historyMutation");
      expect(historyPublication?.change?.revision).toBe(3);
      expect(historyPublication?.change?.mutation?.upsertTurns?.map((turn) => turn.turnId)).toEqual(
        ["turn-older"],
      );
      expect(manager.readConversation("thread-1")?.turns).toHaveLength(2);
    } finally {
      ownerStreamPublishHandler = null;
      resumeThreadResult = null;
      historyPageResult = null;
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      manager.destroy();
    }
  });

  test("owner patch rejection adopts Main recovery before publishing a repair snapshot", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerStreamPublishHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });

    const manager = new CodexAppServerManager("default");
    const publishInputs: unknown[] = [];
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      const acceptedConversation = manager.readConversation("thread-1");
      if (!acceptedConversation) throw new Error("Missing accepted owner conversation");
      invokeCalls = [];
      invokeRecords = [];
      ownerStreamPublishHandler = (input) => {
        publishInputs.push(input);
        if (publishInputs.length !== 1) return true;
        const publication = input as {
          baseCheckpoint?: ReturnType<typeof buildTestCheckpoint> | null;
        };
        if (!publication.baseCheckpoint) {
          throw new Error("Missing rejected publication base checkpoint");
        }
        return {
          accepted: false,
          reason: "base-checkpoint-mismatch",
          recovery: {
            checkpoint: publication.baseCheckpoint,
            conversationState: acceptedConversation,
          },
        };
      };

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "hello",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      await flushAsyncWork(3);

      const repairPublish = publishInputs[1] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              revision?: number;
              conversationState?: CodexConversationSnapshot;
            };
          }
        | undefined;
      expect(invokeCalls.includes("codex:thread:snapshot:request")).toBe(false);
      expect(String(publishInputs.length)).toBe("2");
      expect(repairPublish?.ownerNotificationSequence).toBe(1);
      expect(repairPublish?.change?.type).toBe("snapshot");
      expect(repairPublish?.change?.conversationState?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(manager.readConversation("thread-1")?.resumeState).toBe("resumed");
    } finally {
      ownerStreamPublishHandler = null;
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner repair failure keeps Main recovery state and marks conversation needs resume", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerStreamPublishHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });

    const manager = new CodexAppServerManager("default");
    const publishInputs: unknown[] = [];
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      const acceptedConversation = manager.readConversation("thread-1");
      if (!acceptedConversation) throw new Error("Missing accepted owner conversation");
      invokeCalls = [];
      invokeRecords = [];
      ownerStreamPublishHandler = (input) => {
        publishInputs.push(input);
        if (publishInputs.length !== 1) return false;
        const publication = input as {
          baseCheckpoint?: ReturnType<typeof buildTestCheckpoint> | null;
        };
        if (!publication.baseCheckpoint) {
          throw new Error("Missing rejected publication base checkpoint");
        }
        return {
          accepted: false,
          reason: "base-checkpoint-mismatch",
          recovery: {
            checkpoint: publication.baseCheckpoint,
            conversationState: acceptedConversation,
          },
        };
      };

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "hello",
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 25));
      await flushAsyncWork(3);

      expect(invokeCalls.includes("codex:thread:snapshot:request")).toBe(false);
      expect(String(publishInputs.length)).toBe("2");
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(manager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
    } finally {
      ownerStreamPublishHandler = null;
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner reducer precondition failure preserves partial text without source-null resync", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    snapshotByThread = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const partialConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", "partial"),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      const staleConversation: CodexConversationSnapshot = {
        ...partialConversation,
        turns: [
          {
            ...partialConversation.turns[0]!,
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "stale")],
          },
        ],
      };
      snapshotByThread["thread-1"] = staleConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: partialConversation,
        },
        sourceClientId: "owner-a",
      });
      dispatchCodexAppServerMessage("thread-owner-unavailable", {
        hostId: "default",
        ownerClientId: "owner-a",
        conversationIds: ["thread-1"],
      });
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "thread-1",
            threadName: "Should not apply",
          },
        },
      });
      await flushAsyncWork(2);

      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "partial",
      );
      expect(manager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-owner:notification:ack"),
      ).toBe(true);
    } finally {
      snapshotByThread = {};
      manager.destroy();
    }
  });

  test("connected status refresh does not source-null resync active owner conversations", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    snapshotByThread = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const partialConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", "partial"),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      const staleConversation: CodexConversationSnapshot = {
        ...partialConversation,
        turns: [
          {
            ...partialConversation.turns[0]!,
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "stale")],
          },
        ],
      };
      resumeThreadResult = partialConversation;
      snapshotByThread["thread-1"] = staleConversation;

      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("client-status-changed", {
        hostId: "default",
        status: "connected",
      });
      await flushAsyncWork(2);

      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "partial",
      );
      expect(manager.readConversation("thread-1")?.resumeState).toBe("resumed");
    } finally {
      snapshotByThread = {};
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("connected status refresh and source-null snapshots do not downgrade real followers", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    snapshotByThread = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const ownerConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "owner text")],
          },
        ],
      };
      const sourceNullConversation: CodexConversationSnapshot = {
        ...ownerConversation,
        turns: [],
      };

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: ownerConversation,
        },
        sourceClientId: "owner-a",
      });
      invokeRecords = [];

      dispatchCodexAppServerMessage("client-status-changed", {
        hostId: "default",
        status: "connected",
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "snapshot",
          revision: 2,
          conversationState: sourceNullConversation,
        },
        sourceClientId: null,
      });
      await flushAsyncWork(2);

      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "owner text",
      );
    } finally {
      snapshotByThread = {};
      manager.destroy();
    }
  });

  test("owner item completion waits for visible rAF drain before applying completed item", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    let requestAnimationFrameCallCount = 0;
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        requestAnimationFrameCallCount += 1;
        animationFrameCallbacks.push(callback);
        return 1;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      });
      const delta = "abcdefghijklmnopqrstuvwxyz0123456789";
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta,
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-1",
              type: "agentMessage",
              text: delta,
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });

      const item = manager.readConversation("thread-1")?.turns[0]?.items[0];
      expect(item?.markdownText).toBe("");
      expect(item?.status).toBe("inProgress");
      expect(String(requestAnimationFrameCallCount)).toBe("1");

      animationFrameCallbacks.shift()?.(16);

      const partialItem = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const partialPublishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const partialAckRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      const partialPublishInput = partialPublishRecords[partialPublishRecords.length - 1]
        ?.args[0] as
        | {
            ownerNotificationSequence?: number;
          }
        | undefined;
      expect(partialItem?.markdownText).toBe("abcdefghijklmnopqrstuvwx");
      expect(partialItem?.status).toBe("inProgress");
      expect(String(requestAnimationFrameCallCount)).toBe("2");
      expect(partialPublishInput?.ownerNotificationSequence).toBe(undefined);
      expect(String(partialAckRecords.length)).toBe("0");

      animationFrameCallbacks.shift()?.(32);
      await flushAsyncWork(3);

      const completedItem = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const ownerSequences = publishRecords.map((record) => {
        const input = record.args[0] as { ownerNotificationSequence?: number } | undefined;
        return String(input?.ownerNotificationSequence ?? 0);
      });
      const completedPublishIndex = ownerSequences.indexOf("2");
      expect(completedItem?.markdownText).toBe(delta);
      expect(completedItem?.status).toBe("completed");
      expect(String(requestAnimationFrameCallCount)).toBe("2");
      expect(ownerSequences.indexOf("1") < 0).toBe(true);
      expect(completedPublishIndex >= 0).toBe(true);
    } finally {
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner no-op ACK cannot leapfrog a sliced assistant delta", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      };
      const delta = "abcdefghijklmnopqrstuvwxyz0123456789";
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta,
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/reasoning/summaryPartAdded",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
            summaryIndex: 0,
          },
        },
      });

      expect(String(invokeRecords.length)).toBe("0");
      animationFrameCallbacks.shift()?.(16);
      await flushAsyncWork(3);

      const partialPublishes = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const partialAcks = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      const partialPublish = partialPublishes[partialPublishes.length - 1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
          }
        | undefined;
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "abcdefghijklmnopqrstuvwx",
      );
      expect(partialPublish?.ownerNotificationSequence).toBe(undefined);
      expect(String(partialAcks.length)).toBe("0");

      animationFrameCallbacks.shift()?.(32);
      await flushAsyncWork(3);

      const publishes = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const finalPublish = publishes[publishes.length - 1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
          }
        | undefined;
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(delta);
      expect(finalPublish?.ownerNotificationSequence).toBe(2);
    } finally {
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner loss discards only that conversation's queued text delta", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new CodexAppServerManager("default");
    const buildStreamingConversation = (threadId: string): CodexConversationSnapshot => ({
      ...buildConversation(threadId, "project-1"),
      turns: [
        {
          threadId,
          turnId: `turn-${threadId}`,
          status: "inProgress",
          itemIds: [`assistant-${threadId}`],
          items: [
            {
              ...buildAssistantMessage(threadId, `turn-${threadId}`, `assistant-${threadId}`, ""),
              status: "inProgress",
            },
          ],
        },
      ],
    });
    try {
      for (const threadId of ["thread-1", "thread-2"]) {
        const conversation = buildStreamingConversation(threadId);
        resumeThreadResult = conversation;
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "default",
          conversationId: threadId,
          version: 1,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: conversation,
          },
          sourceClientId: null,
        });
        await manager.requestThreadStreamResume(threadId);
      }
      invokeRecords = [];

      for (const [threadId, delta] of [
        ["thread-1", "discard"],
        ["thread-2", "preserve"],
      ] as const) {
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: 1,
          notification: {
            method: "item/agentMessage/delta",
            params: {
              threadId,
              turnId: `turn-${threadId}`,
              itemId: `assistant-${threadId}`,
              delta,
            },
          },
        });
      }
      dispatchCodexAppServerMessage("thread-owner-unavailable", {
        hostId: "default",
        ownerClientId: "lost-owner",
        conversationIds: ["thread-1"],
      });

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(manager.readConversation("thread-2")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(String(animationFrameCallbacks.length)).toBe("1");

      animationFrameCallbacks.shift()?.(16);
      await flushAsyncWork(3);

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(manager.readConversation("thread-2")?.turns[0]?.items[0]?.markdownText).toBe(
        "preserve",
      );
    } finally {
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("rejected standalone owner ACK marks only that conversation unavailable", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerNotificationAckHandler = () => false;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const first = buildConversation("thread-1", "project-1");
      const second = buildConversation("thread-2", "project-1");
      for (const conversation of [first, second]) {
        resumeThreadResult = conversation;
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "default",
          conversationId: conversation.threadId,
          version: 1,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: conversation,
          },
          sourceClientId: null,
        });
        await manager.requestThreadStreamResume(conversation.threadId);
      }

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/reasoning/summaryPartAdded",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
            summaryIndex: 0,
          },
        },
      });
      await flushAsyncWork(3);

      expect(manager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(manager.readConversation("thread-2")?.resumeState).toBe("resumed");
    } finally {
      ownerNotificationAckHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("late ACK failure from a discarded owner generation cannot tear down the current one", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    let ackCallCount = 0;
    let resolveFirstAck: ((accepted: boolean) => void) | null = null;
    ownerNotificationAckHandler = () => {
      ackCallCount += 1;
      if (ackCallCount > 1) return true;
      return new Promise<boolean>((resolve) => {
        resolveFirstAck = resolve;
      });
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const conversation = buildConversation("thread-1", "project-1");
      resumeThreadResult = conversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: conversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");

      const sendNoop = (): void => {
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: 1,
          notification: {
            method: "item/reasoning/summaryPartAdded",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "reasoning-1",
              summaryIndex: 0,
            },
          },
        });
      };
      sendNoop();
      await flushAsyncWork();
      dispatchCodexAppServerMessage("thread-owner-unavailable", {
        hostId: "default",
        ownerClientId: "superseded-owner",
        conversationIds: ["thread-1"],
      });
      sendNoop();
      await flushAsyncWork(3);

      const releaseFirstAck = resolveFirstAck as ((accepted: boolean) => void) | null;
      releaseFirstAck?.(false);
      await flushAsyncWork(3);

      expect(String(ackCallCount)).toBe("2");
      expect(manager.readConversation("thread-1")?.resumeState).toBe("resumed");
    } finally {
      ownerNotificationAckHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner loss discards queued command output without applying or ACKing it", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const conversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1"],
            items: [buildCommandExecutionItem("thread-1", "turn-1", "cmd-1")],
          },
        ],
      };
      resumeThreadResult = conversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: conversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            delta: "must be discarded",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-unavailable", {
        hostId: "default",
        ownerClientId: "lost-owner",
        conversationIds: ["thread-1"],
      });
      await new Promise((resolve) => setTimeout(resolve, 70));

      const output = manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput;
      const ackRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      expect(output ?? "").toBe("");
      expect(String(ackRecords.length)).toBe("0");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("recognized malformed owner notifications complete instead of blocking later ACKs", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const conversation = buildConversation("thread-1", "project-1");
      resumeThreadResult = conversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: conversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/reasoning/summaryPartAdded",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
          } as never,
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/reasoning/summaryPartAdded",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
            summaryIndex: 0,
          },
        },
      });
      await flushAsyncWork(3);

      const ackSequences = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:notification:ack")
        .map((record) => (record.args[0] as { sequence?: number }).sequence)
        .filter((sequence): sequence is number => typeof sequence === "number");
      expect(String(ackSequences.at(-1) ?? 0)).toBe("2");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner short assistant delta commits an in-progress React frame before item completion", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const {
      LocalConversationProvider,
      __resetLocalConversationStoreForTests,
      useConversation,
      useDefaultCodexAppServerManager,
    } = await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    let requestAnimationFrameCallCount = 0;
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        requestAnimationFrameCallCount += 1;
        animationFrameCallbacks.push(callback);
        return requestAnimationFrameCallCount;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    let managerRef: CodexAppServerManagerInstance | null = null;
    const renderStates: string[] = [];
    function Probe() {
      managerRef = useDefaultCodexAppServerManager();
      const conversation = useConversation("thread-1");
      const item = conversation?.turns[0]?.items[0];
      if (item) {
        renderStates.push(`${item.status ?? "none"}:${item.markdownText ?? ""}`);
      }
      return createElement("div", null, item?.markdownText ?? "");
    }

    const rendered = render(createElement(LocalConversationProvider, null, createElement(Probe)));
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-1", "assistant-1", ""),
                status: "inProgress",
              },
            ],
          },
        ],
      });
      const delta = "short streaming";
      resumeThreadResult = baseConversation;
      await settleAsyncRender();
      const manager = managerRef as unknown as CodexAppServerManagerInstance | null;
      if (!manager) {
        throw new Error("Expected local conversation manager");
      }

      await act(async () => {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "default",
          conversationId: "thread-1",
          version: 1,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: baseConversation,
          },
          sourceClientId: null,
        });
      });
      await act(async () => {
        await manager.requestThreadStreamResume("thread-1");
      });
      invokeRecords = [];
      renderStates.length = 0;

      await act(async () => {
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: 1,
          notification: {
            method: "item/agentMessage/delta",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              itemId: "assistant-1",
              delta,
            },
          },
        });
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: 2,
          notification: {
            method: "item/completed",
            params: {
              completedAtMs: 1,
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                id: "assistant-1",
                type: "agentMessage",
                text: delta,
                phase: null,
                memoryCitation: null,
                delivery: null,
              },
            },
          },
        });
      });

      expect(String(requestAnimationFrameCallCount)).toBe("1");
      await act(async () => {
        await flushAsyncWork(3);
      });
      const completedItem = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const ownerSequences = publishRecords.map((record) => {
        const input = record.args[0] as { ownerNotificationSequence?: number } | undefined;
        return String(input?.ownerNotificationSequence ?? 0);
      });
      expect(completedItem?.markdownText).toBe(delta);
      expect(completedItem?.status).toBe("completed");
      expect(renderStates.includes(`inProgress:${delta}`)).toBe(true);
      expect(renderStates.includes(`completed:${delta}`)).toBe(true);
      expect(ownerSequences.indexOf("2") > ownerSequences.indexOf("1")).toBe(true);
    } finally {
      await act(async () => {
        rendered.unmount();
      });
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
    }
  });

  test("owner prose and reasoning deltas before item started do not synthesize items", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "assistant-1",
            delta: "hello",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/plan/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "plan-1",
            delta: "plan",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "item/reasoning/summaryTextDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
            summaryIndex: 0,
            delta: "summary",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 4,
        notification: {
          method: "item/reasoning/textDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
            contentIndex: 0,
            delta: "content",
          },
        },
      });

      animationFrameCallbacks.shift()?.(16);
      await flushAsyncWork(1);

      const turn = manager.readConversation("thread-1")?.turns[0];
      expect(turn?.itemIds.join(",")).toBe("");
      expect(String(turn?.items.length ?? -1)).toBe("0");
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-owner:notification:ack"),
      ).toBe(true);
    } finally {
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner turn/completed waits for visible rAF prose drain", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerStreamPublishHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const scenarios = [{ method: "turn/completed" as const, status: "completed" as const }];

    try {
      for (const scenario of scenarios) {
        const threadId = `thread-${scenario.status}`;
        const manager = new CodexAppServerManager("default");
        try {
          animationFrameCallbacks.length = 0;
          const baseConversation: CodexConversationSnapshot = {
            ...buildConversation(threadId, "project-1"),
            turns: [
              {
                threadId,
                turnId: "turn-1",
                status: "inProgress",
                itemIds: ["assistant-1", "mcp-1"],
                items: [
                  {
                    ...buildAssistantMessage(threadId, "turn-1", "assistant-1", ""),
                    status: "inProgress",
                  },
                  buildMcpToolCallItem(threadId, "turn-1", "mcp-1"),
                ],
              },
            ],
          };
          const delta = "abcdefghijklmnopqrstuvwxyz0123456789";
          resumeThreadResult = baseConversation;

          dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
            hostId: "default",
            conversationId: threadId,
            version: 1,
            change: {
              type: "snapshot",
              revision: 1,
              conversationState: baseConversation,
            },
            sourceClientId: null,
          });
          await manager.requestThreadStreamResume(threadId);
          invokeRecords = [];

          dispatchCodexAppServerMessage("thread-owner-notification", {
            hostId: "default",
            sequence: 1,
            notification: {
              method: "item/agentMessage/delta",
              params: {
                threadId,
                turnId: "turn-1",
                itemId: "assistant-1",
                delta,
              },
            },
          });
          dispatchCodexAppServerMessage("thread-owner-notification", {
            hostId: "default",
            sequence: 2,
            notification: {
              method: scenario.method,
              params: {
                threadId,
                turn: buildProtocolTurn({
                  id: "turn-1",
                  status: scenario.status,
                }),
              },
            },
          });

          expect(manager.readConversation(threadId)?.turns[0]?.status).toBe("inProgress");
          expect(manager.readConversation(threadId)?.turns[0]?.items[0]?.markdownText).toBe("");
          expect(
            manager.readConversation(threadId)?.turns[0]?.items[1]?.mcpToolCall?.completed,
          ).toBe(false);

          animationFrameCallbacks.shift()?.(16);
          expect(manager.readConversation(threadId)?.turns[0]?.status).toBe("inProgress");
          expect(manager.readConversation(threadId)?.turns[0]?.items[0]?.markdownText).toBe(
            "abcdefghijklmnopqrstuvwx",
          );

          animationFrameCallbacks.shift()?.(32);
          expect(manager.readConversation(threadId)?.turns[0]?.status).toBe(scenario.status);
          expect(manager.readConversation(threadId)?.turns[0]?.items[0]?.markdownText).toBe(delta);
          expect(
            manager.readConversation(threadId)?.turns[0]?.items[1]?.mcpToolCall?.completed,
          ).toBe(true);
        } finally {
          manager.destroy();
        }
      }
    } finally {
      ownerStreamPublishHandler = null;
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
    }
  });

  test("owner command output notifications publish before their sequence is acknowledged", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1"],
            items: [buildCommandExecutionItem("thread-1", "turn-1", "cmd-1")],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            delta: "owner output\n",
          },
        },
      });
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-owner:notification:ack"),
      ).toBe(false);

      await new Promise((resolve) => setTimeout(resolve, 70));
      await flushAsyncWork(4);

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput).toBe(
        "owner output\n",
      );
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.toolCall).toBeUndefined();
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.updatedAt).toBe(1);
      const canonicalCommand =
        manager.readConversation("thread-1")?.canonicalState?.turns[0]?.items[0];
      expect(
        canonicalCommand?.type === "commandExecution" ? canonicalCommand.aggregatedOutput : null,
      ).toBe("owner output\n");
      expect(String(publishRecords.length)).toBe("1");
      const publishInput = publishRecords[0]?.args[0] as
        | {
            change?: { type?: string };
            ownerNotificationSequence?: number;
          }
        | undefined;
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.ownerNotificationSequence).toBe(1);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-owner:notification:ack"),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner terminal interactions publish parsed command actions before acknowledgement", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1"],
            items: [buildCommandExecutionItem("thread-1", "turn-1", "cmd-1")],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/commandExecution/terminalInteraction",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            processId: "proc-1",
            stdin: "bun tes",
          },
        },
      });
      await flushAsyncWork();
      const partialCanonicalCommand =
        manager.readConversation("thread-1")?.canonicalState?.turns[0]?.items[0];
      expect(
        partialCanonicalCommand?.type === "commandExecution"
          ? partialCanonicalCommand.commandActions.length
          : -1,
      ).toBe(0);
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/commandExecution/terminalInteraction",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            processId: "proc-1",
            stdin: "t\n",
          },
        },
      });
      await flushAsyncWork(4);

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const ackRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      const ackSequences = ackRecords
        .map((record) => {
          const input = record.args[0] as { conversationId?: string; sequence?: number };
          return `${input.conversationId}:${input.sequence}`;
        })
        .join(",");
      const item = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const canonicalCommand =
        manager.readConversation("thread-1")?.canonicalState?.turns[0]?.items[0];
      const commandAction = item?.commandActions?.[0];
      const publishInput = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
          }
        | undefined;

      expect(String(publishRecords.length)).toBe("1");
      expect(ackSequences).toBe("thread-1:1");
      expect(publishInput?.ownerNotificationSequence).toBe(2);
      expect(commandAction?.type).toBe("unknown");
      expect(commandAction?.command).toBe("bun test");
      expect(item?.toolCall).toBeUndefined();
      expect(
        canonicalCommand?.type === "commandExecution"
          ? canonicalCommand.commandActions[0]?.command
          : null,
      ).toBe("bun test");
      expect(item?.updatedAt).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner no-op item notifications preserve ordinary MCP progress state without stream mutation", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            hookRuns: [],
            itemIds: ["mcp-1"],
            items: [buildMcpToolCallItem("thread-1", "turn-1", "mcp-1")],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      const beforeConversation = manager.readConversation("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/reasoning/summaryPartAdded",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
            summaryIndex: 1,
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/fileChange/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "patch-legacy-output",
            delta: "legacy apply_patch output",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "item/mcpToolCall/progress",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "mcp-1",
            message: "Searching docs",
          },
        },
      });
      await flushAsyncWork();

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const ackRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      const ackSequences = ackRecords
        .map((record) => {
          const input = record.args[0] as { conversationId?: string; sequence?: number };
          return `${input.conversationId}:${input.sequence}`;
        })
        .join(",");
      const item = manager.readConversation("thread-1")?.turns[0]?.items[0];

      expect(manager.readConversation("thread-1") === beforeConversation).toBe(true);
      expect(String(publishRecords.length)).toBe("0");
      expect(ackSequences).toBe("thread-1:1,thread-1:3");
      expect(item?.itemId).toBe("mcp-1");
      expect(item?.status).toBe("inProgress");
      expect(item?.mcpToolCall?.result).toBe(null);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner MCP progress publishes the one-time missing hookRuns repair", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const mcpItem = buildMcpToolCallItem("thread-1", "turn-1", "mcp-1");
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            firstTurnWorkItemStartedAtMs: null,
            itemIds: ["mcp-1"],
            items: [mcpItem],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      const beforeItem = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const beforeCanonicalItem =
        manager.readConversation("thread-1")?.canonicalState?.turns[0]?.items[0];
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/mcpToolCall/progress",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "mcp-1",
            message: "Connecting",
          },
        },
      });
      await flushAsyncWork(4);

      const turn = manager.readConversation("thread-1")?.turns[0];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
          }
        | undefined;

      expect(turn?.hookRuns?.length ?? -1).toBe(0);
      expect(turn?.firstTurnWorkItemStartedAtMs ?? null).toBe(null);
      expect(turn?.items[0] === beforeItem).toBe(true);
      const canonicalTurn = manager.readConversation("thread-1")?.canonicalState?.turns[0];
      expect(canonicalTurn?.sidecar.hookRuns?.length ?? -1).toBe(0);
      expect(canonicalTurn?.items[0] === beforeCanonicalItem).toBe(true);
      expect(publishRecords.length).toBe(1);
      expect(publishInput?.ownerNotificationSequence).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner delta persists completed-empty placeholder rebind even when its item is missing", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: null as unknown as string,
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/plan/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-rebound",
            itemId: "missing-plan",
            delta: "still drains",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));

      const conversation = manager.readConversation("thread-1");
      const publish = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      )?.args[0] as { ownerNotificationSequence?: number } | undefined;
      expect(conversation?.turns[0]?.turnId).toBe("turn-rebound");
      expect(conversation?.turns[0]?.status).toBe("inProgress");
      expect(typeof conversation?.turns[0]?.turnStartedAtMs).toBe("number");
      expect(conversation?.turns[0]?.items.length).toBe(0);
      expect(conversation?.canonicalState?.turns[0]?.protocol.id).toBe("turn-rebound");
      expect(conversation?.canonicalState?.turns[0]?.items.length).toBe(0);
      expect(publish?.ownerNotificationSequence).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner item started rebinds single completed empty placeholder turn", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: null,
            status: "completed",
            errorMessage: null,
            itemIds: [],
            items: [],
          } as unknown as CodexConversationSnapshot["turns"][number],
        ],
      });
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-1",
              type: "agentMessage",
              text: "",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      expect(String(conversation?.turns.length ?? -1)).toBe("1");
      expect(conversation?.turns[0]?.turnId).toBe("turn-1");
      expect(conversation?.turns[0]?.status).toBe("inProgress");
      expect(conversation?.turns[0]?.items[0]?.itemId).toBe("assistant-1");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner item started synthesizes missing turn when latest in-progress placeholder cannot rebind", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: null,
            status: "inProgress",
            itemIds: [],
            items: [],
          } as unknown as CodexConversationSnapshot["turns"][number],
        ],
      });
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "assistant-1",
              type: "agentMessage",
              text: "",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      expect(String(conversation?.turns.length ?? -1)).toBe("2");
      expect(
        (conversation?.turns[0] as unknown as { turnId: unknown } | undefined)?.turnId ?? null,
      ).toBe(null);
      expect(conversation?.turns[1]?.turnId).toBe("turn-1");
      expect(conversation?.turns[1]?.items[0]?.itemId).toBe("assistant-1");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner context compaction started rebinds latest in-progress placeholder turn", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: null,
            status: "inProgress",
            itemIds: [],
            items: [],
          } as unknown as CodexConversationSnapshot["turns"][number],
        ],
      });
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              id: "context-1",
              type: "contextCompaction",
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      expect(String(conversation?.turns.length ?? -1)).toBe("1");
      expect(conversation?.turns[0]?.turnId).toBe("turn-1");
      expect(conversation?.turns[0]?.items[0]?.semanticKind).toBe("contextCompaction");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner fileChange patchUpdated preserves terminal raw state and view timestamps", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const rawExtension = { source: "fixture-extension" };
      const existingChanges = [
        {
          path: "src/old.ts",
          kind: { type: "update" as const, move_path: null },
          diff: "old diff",
        },
      ];
      const existingItem: CodexConversationItem = {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "patch-live",
        entryId: "patch-live",
        type: "file_change",
        kind: "fileChange",
        semanticKind: "patch",
        status: "declined",
        fileChange: {
          changes: {
            "src/old.ts": {
              type: "update",
              unifiedDiff: "old diff",
              movePath: null,
            },
          },
        },
        rawItem: {
          type: "fileChange",
          id: "patch-live",
          changes: existingChanges,
          status: "declined",
          extension: rawExtension,
        },
        createdAt: 101,
        updatedAt: 102,
      };
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        updatedAt: 103,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "completed",
            turnStartedAtMs: 104,
            firstTurnWorkItemStartedAtMs: 105,
            itemIds: ["patch-live"],
            items: [existingItem],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      const changes = [
        {
          path: "src/app.ts",
          kind: { type: "update" as const, move_path: null },
          diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      ];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/fileChange/patchUpdated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "patch-live",
            changes,
          },
        },
      });
      await flushAsyncWork(4);

      const turn = manager.readConversation("thread-1")?.turns[0];
      const item = turn?.items[0] ?? null;
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecords[0]?.args[0] as
        | {
            change?: { type?: string };
            baseCheckpoint?: ReturnType<typeof buildTestCheckpoint> | null;
            checkpoint?: ReturnType<typeof buildTestCheckpoint>;
          }
        | undefined;
      const ackRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      const ackInput = ackRecord?.args[0] as { sequence?: number } | undefined;
      const rawItem = item?.rawItem as
        | {
            changes?: unknown;
            status?: string;
            extension?: unknown;
          }
        | undefined;
      expect(turn?.status).toBe("completed");
      expect(turn?.turnStartedAtMs).toBe(104);
      expect(turn?.firstTurnWorkItemStartedAtMs).toBe(105);
      expect(item?.itemId ?? "").toBe("patch-live");
      expect(item?.status ?? "").toBe("declined");
      expect(item?.createdAt).toBe(101);
      expect(item?.updatedAt).toBe(102);
      expect(`${item?.kind}:${item?.semanticKind}`).toBe("fileChange:patch");
      expect(getCodexFileChangePaths(item?.fileChange?.changes).join(",")).toBe("src/app.ts");
      expect(getCodexFileChangeList(item?.fileChange?.changes)[0]?.type ?? "").toBe("update");
      expect(rawItem?.changes === changes).toBe(true);
      expect(rawItem?.status).toBe("declined");
      expect(rawItem?.extension === rawExtension).toBe(true);
      expect(manager.readConversation("thread-1")?.updatedAt).toBe(103);
      expect(publishRecords.length).toBe(1);
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.checkpoint?.revision).toBe(
        (publishInput?.baseCheckpoint?.revision ?? 0) + 1,
      );
      expect(ackInput).toBeUndefined();
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner fileChange patchUpdated replaces a same-id wrong type and accepts empty changes", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const wrongType = buildAssistantMessage("thread-1", "turn-1", "shared-item", "replace me");
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            turnStartedAtMs: 11,
            firstTurnWorkItemStartedAtMs: 12,
            itemIds: ["shared-item"],
            items: [wrongType],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      const changes: never[] = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/fileChange/patchUpdated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "shared-item",
            changes,
          },
        },
      });
      await flushAsyncWork(4);

      const turn = manager.readConversation("thread-1")?.turns[0];
      const item = turn?.items[0];
      const rawItem = item?.rawItem as
        | {
            type?: string;
            changes?: unknown;
            status?: string;
          }
        | undefined;
      const canonicalItem =
        manager.readConversation("thread-1")?.canonicalState?.turns[0]?.items[0];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const ackRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      const ackInput = ackRecord?.args[0] as { sequence?: number } | undefined;

      expect(turn?.items.length).toBe(0);
      expect(turn?.itemIds).toEqual(["shared-item"]);
      expect(item).toBeUndefined();
      expect(rawItem).toBeUndefined();
      expect(canonicalItem?.type).toBe("fileChange");
      expect(canonicalItem?.type === "fileChange" && canonicalItem.changes === changes).toBe(true);
      const publishInput = publishRecords[0]?.args[0] as
        | {
            change?: { type?: string };
          }
        | undefined;
      expect(publishRecords.length).toBe(1);
      expect(publishInput?.change?.type).toBe("patches");
      expect(ackInput).toBeUndefined();
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner fileChange patchUpdated replaces a hidden identity at canonical order", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["before", "target", "after"],
            items: ["before", "target", "after"].map((itemId) =>
              buildCommandExecutionItem("thread-1", "turn-1", itemId),
            ),
          },
        ],
      });
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            startedAtMs: 100,
            item: {
              id: "target",
              type: "enteredReviewMode",
              review: "Review target",
            },
          },
        },
      });
      await flushAsyncWork(4);

      invokeRecords = [];
      const liveChanges: never[] = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/fileChange/patchUpdated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "target",
            changes: liveChanges,
          },
        },
      });
      await flushAsyncWork();

      let turn = manager.readConversation("thread-1")?.turns[0];
      let target = turn?.items.find((item) => item.itemId === "target");
      const targetRaw = target?.rawItem as
        | {
            type?: string;
            changes?: unknown;
          }
        | undefined;
      const patchPublishes = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );

      expect(turn?.items.map((item) => item.itemId).join(",")).toBe("before,after");
      expect(target).toBeUndefined();
      expect(targetRaw).toBeUndefined();
      expect(manager.readConversation("thread-1")?.canonicalState?.turns[0]?.items[1]?.type).toBe(
        "fileChange",
      );
      expect(patchPublishes.length).toBe(1);

      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            completedAtMs: 150,
            item: {
              id: "target",
              type: "fileChange",
              status: "completed",
              changes: [
                {
                  path: "src/final.ts",
                  kind: { type: "add" },
                  diff: "",
                },
              ],
            },
          },
        },
      });
      await flushAsyncWork(4);

      turn = manager.readConversation("thread-1")?.turns[0];
      target = turn?.items.find((item) => item.itemId === "target");
      expect(turn?.items.map((item) => item.itemId).join(",")).toBe("before,target,after");
      expect(target?.kind).toBe("fileChange");
      expect(target?.status).toBe("completed");
      expect(getCodexFileChangePaths(target?.fileChange?.changes).join(",")).toBe("src/final.ts");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner fileChange patchUpdated rebinds and publishes the latest placeholder", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: null,
            status: "inProgress",
            itemIds: [],
            items: [],
          } as unknown as CodexConversationSnapshot["turns"][number],
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/fileChange/patchUpdated",
          params: {
            threadId: "thread-1",
            turnId: "turn-real",
            itemId: "patch-live",
            changes: [
              {
                path: "poem.md",
                kind: { type: "add" },
                diff: "",
              },
            ],
          },
        },
      });
      await flushAsyncWork(4);

      const conversation = manager.readConversation("thread-1");
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecords[0]?.args[0] as
        | {
            change?: { type?: string };
          }
        | undefined;
      const ackRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      const ackInput = ackRecord?.args[0] as { sequence?: number } | undefined;

      expect(String(conversation?.turns.length ?? -1)).toBe("1");
      expect(conversation?.turns[0]?.turnId).toBe("turn-real");
      expect(conversation?.turns[0]?.items[0]?.itemId).toBe("patch-live");
      expect(
        getCodexFileChangePaths(conversation?.turns[0]?.items[0]?.fileChange?.changes).join(","),
      ).toBe("poem.md");
      expect(String(publishRecords.length)).toBe("1");
      expect(publishInput?.change?.type).toBe("patches");
      expect(ackInput).toBeUndefined();
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner fileChange patchUpdated drops and acks an ordinary missing named turn", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-existing",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      const beforeConversation = manager.readConversation("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/fileChange/patchUpdated",
          params: {
            threadId: "thread-1",
            turnId: "turn-missing",
            itemId: "patch-missing",
            changes: [],
          },
        },
      });
      await flushAsyncWork();

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const ackRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );
      const ackInput = ackRecord?.args[0] as { sequence?: number } | undefined;

      expect(manager.readConversation("thread-1") === beforeConversation).toBe(true);
      expect(manager.readConversation("thread-1")?.turns[0]?.turnId).toBe("turn-existing");
      expect(manager.readConversation("thread-1")?.turns[0]?.items.length).toBe(0);
      expect(publishRecords.length).toBe(0);
      expect(ackInput?.sequence).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner MCP progress rebinds and publishes the sole completed empty placeholder", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        updatedAt: 71,
        turns: [
          {
            threadId: "thread-1",
            turnId: null,
            status: "completed",
            turnStartedAtMs: null,
            itemIds: [],
            items: [],
          } as unknown as CodexConversationSnapshot["turns"][number],
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/mcpToolCall/progress",
          params: {
            threadId: "thread-1",
            turnId: "turn-real",
            itemId: "mcp-not-yet-started",
            message: "Connecting",
          },
        },
      });
      await flushAsyncWork(4);

      const conversation = manager.readConversation("thread-1");
      const turn = conversation?.turns[0];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishInput = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
          }
        | undefined;

      expect(turn?.turnId).toBe("turn-real");
      expect(turn?.status).toBe("inProgress");
      expect(typeof turn?.turnStartedAtMs).toBe("number");
      expect(turn?.firstTurnWorkItemStartedAtMs ?? null).toBe(null);
      expect(turn?.items.length).toBe(0);
      expect(turn?.itemIds.length).toBe(0);
      expect(conversation?.updatedAt).toBe(71);
      expect(publishRecords.length).toBe(1);
      expect(publishInput?.ownerNotificationSequence).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower interrupt routes to owner without follower turn id from bundle 50645-50660", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = true;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "working")],
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "owner-a",
      });

      const interrupted = await manager.interruptTurn("thread-1", "turn-1");

      expect(interrupted).toBe(true);
      const followerRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const followerPayload = followerRecord?.args[0] as
        | {
            action?: { type?: string; turnId?: string };
          }
        | undefined;
      expect(Boolean(followerRecord)).toBe(true);
      expect(followerPayload?.action?.type).toBe("interruptTurn");
      expect("turnId" in (followerPayload?.action ?? {})).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:turn:interrupt")).toBe(false);
      expect(manager.readConversation("thread-1")?.turns[0]?.status).toBe("inProgress");
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower interrupt timeout falls back without stale turn id from bundle 50645-50725", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionError = new Error("thread-follower-interrupt-turn-timeout");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-live",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-live", "assistant-1", "working")],
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "owner-a",
      });

      const interrupted = await manager.interruptTurn("thread-1", "stale-turn");

      const directInterruptRecord = invokeRecords.find(
        (record) => record.channel === "codex:turn:interrupt",
      );
      expect(interrupted).toBe(true);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-follower:action"),
      ).toBe(true);
      expect(Boolean(directInterruptRecord)).toBe(true);
      expect(directInterruptRecord?.args[0]).toBe("thread-1");
      expect(directInterruptRecord?.args.includes("stale-turn")).toBe(false);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:resume:request" && record.args[0] === "thread-1",
        ),
      ).toBe(true);
    } finally {
      followerActionError = null;
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower start steer settings and compact actions route through owner from bundle 64240-64280", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    const latestFollowerAction = () =>
      invokeRecords.filter((record) => record.channel === "codex:thread-follower:action").at(-1)
        ?.args[0] as
        | {
            conversationId?: string;
            action?: Record<string, unknown>;
          }
        | undefined;

    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: withCanonicalState({
            ...buildConversation("thread-1", "project-1"),
            turns: [
              {
                threadId: "thread-1",
                turnId: "turn-1",
                status: "inProgress",
                itemIds: [],
                items: [],
              },
            ],
          }),
        },
        sourceClientId: "owner-a",
      });

      followerActionResult = { turnId: "turn-new" };
      const startResult = await manager.startTurn("thread-1", "Continue", {
        permissionMode: "auto",
      });
      let routed = latestFollowerAction();
      expect((startResult as { turnId?: string } | null)?.turnId).toBe("turn-new");
      expect(routed?.conversationId).toBe("thread-1");
      expect(routed?.action?.type).toBe("startTurn");
      expect(routed?.action?.prompt).toBe("Continue");

      followerActionResult = { turnId: "turn-1" };
      const steerResult = await manager.steerTurn({
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        prompt: "  keep going  ",
      });
      routed = latestFollowerAction();
      const steerInput = routed?.action?.input as
        | { threadId?: string; expectedTurnId?: string; prompt?: string }
        | undefined;
      expect(steerResult?.turnId).toBe("turn-1");
      expect(routed?.conversationId).toBe("thread-1");
      expect(routed?.action?.type).toBe("steerTurn");
      expect(steerInput?.threadId).toBe("thread-1");
      expect(steerInput?.expectedTurnId).toBe("turn-1");
      expect(steerInput?.prompt).toBe("keep going");

      followerActionResult = {
        model: "gpt-5.4-codex",
        reasoningEffort: "high",
        collaborationMode: {
          mode: "plan",
          settings: {
            model: "gpt-5.4-codex",
            reasoning_effort: "high",
            developer_instructions: null,
          },
        },
      };
      const settings = await manager.setThreadSettingsForConversation("thread-1", {
        reasoningEffort: "high",
        collaborationMode: "plan",
      });
      routed = latestFollowerAction();
      const settingsPatch = routed?.action?.patch as
        | { reasoningEffort?: string; collaborationMode?: string }
        | undefined;
      expect(settings.reasoningEffort).toBe("high");
      expect(routed?.conversationId).toBe("thread-1");
      expect(routed?.action?.type).toBe("updateThreadSettings");
      expect(settingsPatch?.reasoningEffort).toBe("high");
      expect(settingsPatch?.collaborationMode).toBe("plan");

      followerActionResult = null;
      await manager.compactThread("thread-1");
      routed = latestFollowerAction();
      expect(routed?.conversationId).toBe("thread-1");
      expect(routed?.action?.type).toBe("compactThread");

      expect(invokeRecords.some((record) => record.channel === "codex:turn:start")).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:turn:steer")).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:settings:update"),
      ).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:thread:compact:start")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower queued follow-up actions route through owner from bundle 40902-40918", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      await manager.enqueueQueuedFollowUp("thread-1", "first queued prompt", {
        serviceTier: "fast",
      });
      await manager.removeQueuedFollowUp("thread-1", "follow-up-1");
      await manager.reorderQueuedFollowUps("thread-1", ["follow-up-2", "follow-up-1"]);
      await manager.sendQueuedFollowUpNow("thread-1", "follow-up-2");

      const followerActions = invokeRecords
        .filter((record) => record.channel === "codex:thread-follower:action")
        .map(
          (record) =>
            record.args[0] as {
              action?: {
                type?: string;
                threadId?: string;
                prompt?: string;
                followUpId?: string;
                orderedFollowUpIds?: string[];
                opts?: { serviceTier?: string | null };
              };
            },
        );
      expect(String(followerActions.length)).toBe("4");
      expect(followerActions[0]?.action?.type).toBe("enqueueQueuedFollowUp");
      expect(followerActions[0]?.action?.threadId).toBe("thread-1");
      expect(followerActions[0]?.action?.prompt).toBe("first queued prompt");
      expect(followerActions[0]?.action?.opts?.serviceTier).toBe("fast");
      expect(followerActions[1]?.action?.type).toBe("removeQueuedFollowUp");
      expect(followerActions[1]?.action?.followUpId).toBe("follow-up-1");
      expect(followerActions[2]?.action?.type).toBe("reorderQueuedFollowUps");
      expect(followerActions[2]?.action?.orderedFollowUpIds?.join(",")).toBe(
        "follow-up-2,follow-up-1",
      );
      expect(followerActions[3]?.action?.type).toBe("sendQueuedFollowUpNow");
      expect(followerActions[3]?.action?.followUpId).toBe("follow-up-2");
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:follow-up:enqueue"),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:follow-up:remove"),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:follow-up:reorder"),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:follow-up:send-now"),
      ).toBe(false);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower settings waits for owner-published settings revision before resolving", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = {
      model: "gpt-5.4-codex",
      reasoningEffort: "high",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.4-codex",
          reasoning_effort: "high",
          developer_instructions: null,
        },
      },
      streamRevision: 2,
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    let resolved = false;
    let resolvedReasoningEffort = "";
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      const settingsPromise = manager
        .setThreadSettingsForConversation("thread-1", {
          reasoningEffort: "high",
          collaborationMode: "plan",
        })
        .then((settings) => {
          resolved = true;
          resolvedReasoningEffort = settings.reasoningEffort ?? "";
        });
      await flushAsyncWork();
      expect(resolved).toBe(false);

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "snapshot",
          revision: 2,
          conversationState: {
            ...buildConversation("thread-1", "project-1"),
            latestThreadSettings: {
              model: "gpt-5.4-codex",
              reasoningEffort: "high",
              collaborationMode: {
                mode: "plan",
                settings: {
                  model: "gpt-5.4-codex",
                  reasoning_effort: "high",
                  developer_instructions: null,
                },
              },
              personality: null,
            },
            latestCollaborationMode: {
              mode: "plan",
              settings: {
                model: "gpt-5.4-codex",
                reasoning_effort: "high",
                developer_instructions: null,
              },
            },
          },
        },
        sourceClientId: "owner-a",
      });

      await settingsPromise;
      expect(resolved).toBe(true);
      expect(resolvedReasoningEffort).toBe("high");
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower queued follow-up enqueue waits for owner revision before resolving", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = { streamRevision: 2 };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    let resolved = false;
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      const enqueuePromise = manager.enqueueQueuedFollowUp("thread-1", "Queue this").then(() => {
        resolved = true;
      });
      await flushAsyncWork();
      expect(resolved).toBe(false);

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "snapshot",
          revision: 2,
          conversationState: {
            ...buildConversation("thread-1", "project-1"),
            queuedFollowUps: {
              status: "ready",
              ledgerRevision: 1,
              projectionRevision: 1,
              entries: [
                {
                  followUpId: "follow-up-1",
                  clientUserMessageId: "client-follow-up-1",
                  threadId: "thread-1",
                  prompt: "Queue this",
                  promptInput: { text: "Queue this" },
                  createdAtMs: 1,
                  collaborationMode: null,
                  serviceTier: null,
                  summary: null,
                  pause: null,
                  payloadRef: null,
                },
              ],
              inFlightFollowUpId: null,
              editingFollowUpId: null,
              error: null,
            },
          },
        },
        sourceClientId: "owner-a",
      });

      await enqueuePromise;
      expect(resolved).toBe(true);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("owner queued follow-up commands converge only through the Main-owned projection", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = buildConversation("thread-1", "project-1");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      await manager.enqueueQueuedFollowUp("thread-1", "  first queued prompt  ", {
        serviceTier: "fast",
      });

      expect(manager.readConversation("thread-1")?.queuedFollowUps.entries).toEqual([]);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:follow-up:enqueue"),
      ).toBe(true);

      const row = createCodexQueuedFollowUp({
        followUpId: "follow-up-main",
        clientUserMessageId: "client-follow-up-main",
        threadId: "thread-1",
        prompt: "first queued prompt",
        createdAtMs: 20,
        serviceTier: "fast",
      });
      await dispatchQueueOwnerProjection(
        {
          status: "ready",
          ledgerRevision: 1,
          projectionRevision: 1,
          entries: [row],
          inFlightFollowUpId: null,
          editingFollowUpId: null,
          error: null,
        },
        { manager },
      );

      const conversation = manager.readConversation("thread-1");
      expect(conversation?.queuedFollowUps.entries).toEqual([row]);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(true);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("Main queue projections rebase after an in-flight lifecycle publish", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    ownerStreamPublishHandler = null;
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    let resolveFirstPublish: (accepted: boolean) => void = () => {
      throw new Error("Expected an in-flight owner publish");
    };
    let publishCount = 0;
    try {
      await manager.requestThreadStreamResume("thread-1");
      ownerStreamPublishHandler = () => {
        publishCount += 1;
        if (publishCount !== 1) return true;
        return new Promise<boolean>((resolve) => {
          resolveFirstPublish = resolve;
        });
      };

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "model/safetyBuffering/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            model: "gpt-test",
            useCases: ["latency"],
            reasons: ["warming"],
            showBufferingUi: true,
            fasterModel: null,
          },
        },
      });
      await waitForCondition(() => publishCount === 1, 160);

      await Promise.all([
        manager.enqueueQueuedFollowUp("thread-1", "Next task"),
        manager.enqueueQueuedFollowUp("thread-1", "Then verify"),
      ]);
      const queueProjection = dispatchQueueOwnerProjection(
        {
          status: "ready",
          ledgerRevision: 2,
          projectionRevision: 2,
          entries: [
            createCodexQueuedFollowUp({
              followUpId: "follow-up-next",
              clientUserMessageId: "client-follow-up-next",
              threadId: "thread-1",
              prompt: "Next task",
              createdAtMs: 20,
            }),
            createCodexQueuedFollowUp({
              followUpId: "follow-up-verify",
              clientUserMessageId: "client-follow-up-verify",
              threadId: "thread-1",
              prompt: "Then verify",
              createdAtMs: 21,
            }),
          ],
          inFlightFollowUpId: null,
          editingFollowUpId: null,
          error: null,
        },
        { manager },
      );
      await flushAsyncWork();
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "turn/diff/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            diff: "late lifecycle diff",
          },
        },
      });
      expect(manager.readConversation("thread-1")?.turns[0]?.diff).toBe("late lifecycle diff");

      resolveFirstPublish(true);
      await queueProjection;
      await flushAsyncWork(3);

      const conversation = manager.readConversation("thread-1");
      expect(conversation?.turns[0]?.diff).toBe("late lifecycle diff");
      expect(conversation?.queuedFollowUps.entries.map((entry) => entry.prompt)).toEqual([
        "Next task",
        "Then verify",
      ]);
    } finally {
      ownerStreamPublishHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("source-null start resumes into renderer ownership before publishing the pending turn", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const sourceNullConversation = withCanonicalState({
      ...buildConversation("thread-1", "project-1"),
      turns: [],
    });
    resumeThreadResult = sourceNullConversation;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: sourceNullConversation,
        },
        sourceClientId: null,
      });
      invokeRecords = [];

      await manager.startTurn("thread-1", "Continue", { permissionMode: "auto" });

      const channels = invokeRecords.map((record) => record.channel);
      const resumeIndex = channels.indexOf("codex:thread:resume:request");
      const turnStartIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "turn/start",
      );
      expect(resumeIndex).toBeGreaterThanOrEqual(0);
      expect(turnStartIndex).toBeGreaterThan(resumeIndex);
      expect(channels.includes("codex:turn:start")).toBe(false);
      expect(manager.getThreadRoleForRendererClientRequest("thread-1")).toBe("owner");
      expect(
        manager
          .readConversation("thread-1")
          ?.turns[0]?.items.filter((item) => item.semanticKind === "userMessage"),
      ).toHaveLength(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("source-null steer resumes ownership before delegating execution to Main", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const sourceNullConversation = withCanonicalState({
      ...buildConversation("thread-1", "project-1"),
      statusType: "active",
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-active",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
    });
    resumeThreadResult = sourceNullConversation;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: sourceNullConversation,
        },
        sourceClientId: null,
      });
      invokeRecords = [];

      await manager.steerTurn({
        threadId: "thread-1",
        expectedTurnId: "turn-active",
        prompt: "Continue now",
      });

      const channels = invokeRecords.map((record) => record.channel);
      const resumeIndex = channels.indexOf("codex:thread:resume:request");
      const steerIndex = channels.indexOf("codex:turn:steer");
      expect(resumeIndex).toBeGreaterThanOrEqual(0);
      expect(steerIndex).toBeGreaterThan(resumeIndex);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread-owner:app-server-request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method === "turn/steer",
        ),
      ).toBe(false);
      expect(manager.getThreadRoleForRendererClientRequest("thread-1")).toBe("owner");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("interrupted Resume starts one userless turn through the renderer owner", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = withCanonicalState({
      ...buildConversation("thread-1", "project-1"),
      statusType: "idle",
      statusActiveFlags: [],
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-interrupted",
          status: "interrupted",
          itemIds: [],
          items: [],
        },
      ],
    });
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      await Promise.all([
        manager.resumeInterruptedTurn("thread-1", { permissionMode: "auto" }),
        manager.resumeInterruptedTurn("thread-1", { permissionMode: "auto" }),
      ]);

      const resumeRequests = invokeRecords.filter(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method ===
            "turn/resume-interrupted",
      );
      const request = resumeRequests[0]?.args[0] as
        | {
            request?: {
              params?: { threadId?: string; clientUserMessageId?: string };
            };
          }
        | undefined;
      const conversation = manager.readConversation("thread-1");

      expect(resumeRequests).toHaveLength(1);
      expect(request?.request?.params?.threadId).toBe("thread-1");
      expect(request?.request?.params?.clientUserMessageId).toBeTruthy();
      expect(conversation?.turns.at(-1)?.status).toBe("inProgress");
      expect(
        conversation?.turns.at(-1)?.items.filter((item) => item.semanticKind === "userMessage"),
      ).toHaveLength(0);
      expect(conversation?.canonicalState?.turns.at(-1)?.sidecar.params.input).toEqual([]);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("failed interrupted Resume restores the interrupted turn for retry", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = withCanonicalState({
      ...buildConversation("thread-1", "project-1"),
      statusType: "idle",
      statusActiveFlags: [],
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-interrupted",
          status: "interrupted",
          itemIds: [],
          items: [],
        },
      ],
    });
    ownerTurnStartError = new Error("Resume transport failed");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");

      await expect(
        manager.resumeInterruptedTurn("thread-1", {
          permissionMode: "auto",
        }),
      ).rejects.toThrow("Resume transport failed");

      const conversation = manager.readConversation("thread-1");
      expect(conversation?.statusType).toBe("idle");
      expect(conversation?.turns).toHaveLength(1);
      expect(conversation?.turns[0]?.turnId).toBe("turn-interrupted");
      expect(conversation?.turns[0]?.status).toBe("interrupted");
    } finally {
      ownerTurnStartError = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner start is visible before transport or publication settles", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [],
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      const startDeferred: { resolve?: () => void } = {};
      ownerTurnStartGate = () =>
        new Promise<void>((resolve) => {
          startDeferred.resolve = resolve;
        });
      const publishDeferred: { resolve?: (accepted: boolean) => void } = {};
      let publishCount = 0;
      ownerStreamPublishHandler = () => {
        publishCount += 1;
        if (publishCount > 1) return true;
        return new Promise<boolean>((resolve) => {
          publishDeferred.resolve = resolve;
        });
      };

      const startPromise = manager.startTurn("thread-1", "Visible immediately", {
        permissionMode: "auto",
      });
      await flushAsyncWork(3);

      const optimistic = manager.readConversation("thread-1")?.turns[0];
      const startRequest = invokeRecords.find(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "turn/start",
      )?.args[0] as
        | {
            request?: {
              params?: {
                clientUserMessageId?: string;
                preparedPrompt?: { inputItems?: unknown[] };
              };
            };
          }
        | undefined;
      const optimisticUser = optimistic?.items.find((item) => item.semanticKind === "userMessage");
      expect(optimisticUser?.markdownText).toBe("Visible immediately");
      expect(startRequest?.request?.params?.preparedPrompt?.inputItems).toEqual([
        {
          type: "text",
          text: "Visible immediately",
          text_elements: [],
        },
      ]);
      expect(startRequest?.request?.params?.clientUserMessageId).toBe(
        optimisticUser?.rawItem && typeof optimisticUser.rawItem === "object"
          ? (optimisticUser.rawItem as { clientId?: string }).clientId
          : undefined,
      );

      if (!startDeferred.resolve || !publishDeferred.resolve) {
        throw new Error("Expected deferred owner start and publication");
      }
      startDeferred.resolve();
      publishDeferred.resolve(true);
      await startPromise;
    } finally {
      ownerTurnStartGate = null;
      ownerStreamPublishHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner optimistic params and turn/start use the same explicit intelligence", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [],
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      await manager.startTurn("thread-1", "Implement", {
        permissionMode: "auto",
        collaborationMode: "default",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
      });

      const params = manager.readConversation("thread-1")?.canonicalState?.turns[0]?.sidecar.params;
      const startRequest = invokeRecords.find(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "turn/start",
      )?.args[0] as
        | {
            request?: {
              params?: {
                opts?: {
                  collaborationMode?: string;
                  model?: string;
                  reasoningEffort?: string;
                  serviceTier?: string | null;
                };
              };
            };
          }
        | undefined;

      expect(params?.collaborationMode?.mode).toBe("default");
      expect(params?.collaborationMode?.settings.model).toBe("gpt-5.6-sol");
      expect(params?.collaborationMode?.settings.reasoning_effort).toBe("xhigh");
      expect(params?.serviceTier).toBe("fast");
      expect(startRequest?.request?.params?.opts).toMatchObject({
        collaborationMode: "default",
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        serviceTier: "fast",
      });
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner start turn publishes params-owned user row snapshot from bundle 49055-49112", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [],
    };
    ownerTurnStartResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      const beforeStart = manager.readConversation("thread-1");
      if (!beforeStart) throw new Error("Expected owner conversation before start");
      invokeRecords = [];

      const result = (await manager.startTurn("thread-1", "Continue", {
        permissionMode: "auto",
      })) as {
        turnId?: string;
        streamRevision?: number;
      } | null;

      const publishInput = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      )?.args[0] as
        | {
            change?: { type?: string; revision?: number; patches?: CodexConversationStateUpdate[] };
          }
        | undefined;
      const publishInputs = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:stream-state:publish")
        .map(
          (record) =>
            record.args[0] as {
              change?: {
                type?: string;
                revision?: number;
                patches?: CodexConversationStateUpdate[];
                conversationState?: CodexConversationSnapshot;
              };
            },
        );
      const optimistic = applyCodexConversationStateUpdates(
        beforeStart,
        publishInput?.change?.patches ?? [],
      );
      const rebound = applyCodexConversationStateUpdates(
        optimistic,
        publishInputs[1]?.change?.patches ?? [],
      );
      const userItem = optimistic.turns[0]?.items[0];
      expect(result?.turnId).toBe("turn-owner-start");
      expect(result?.streamRevision).toBe(3);
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.revision).toBe(2);
      expect(userItem?.kind).toBe("userMessage");
      expect(userItem?.markdownText).toBe("Continue");
      expect(optimistic.turns[0]?.turnId).toBe(null);
      expect(optimistic.canonicalState?.turns[0]?.protocol.id).toBe(null);
      expect(optimistic.canonicalState?.turns[0]?.sidecar.params.clientUserMessageId).toBe(
        userItem?.rawItem && typeof userItem.rawItem === "object"
          ? (userItem.rawItem as { clientId?: string }).clientId
          : undefined,
      );
      expect(publishInputs[1]?.change?.revision).toBe(3);
      expect(rebound.turns[0]?.turnId).toBe("turn-owner-start");
      expect(rebound.updatedAt).toBe(optimistic.updatedAt);
      expect(rebound.canonicalState?.turns[0]?.protocol.id).toBe("turn-owner-start");
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.itemId).toBe(
        "turn-owner-start:input",
      );
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "Continue",
      );
      expect(invokeRecords.some((record) => record.channel === "codex:turn:start")).toBe(false);
    } finally {
      resumeThreadResult = null;
      ownerTurnStartResult = null;
      manager.destroy();
    }
  });

  test("owner start keeps one visible user row through the ordered app-server streaming prelude", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [],
    };
    ownerTurnStartResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.startTurn("thread-1", "Edited prompt", { permissionMode: "auto" });

      const optimisticUser = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const rawOptimisticUser =
        optimisticUser?.rawItem && typeof optimisticUser.rawItem === "object"
          ? (optimisticUser.rawItem as { clientId?: string })
          : null;
      const clientId = rawOptimisticUser?.clientId;
      if (!clientId) {
        throw new Error("Expected optimistic client user-message identity");
      }

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-owner-start",
            item: {
              id: "server-user-echo",
              type: "userMessage",
              clientId,
              content: [{ type: "text", text: "Edited prompt", text_elements: [] }],
            },
          },
        },
      });
      await flushAsyncWork();
      expect(
        manager
          .readConversation("thread-1")
          ?.turns[0]?.items.filter((item) => item.semanticKind === "userMessage"),
      ).toHaveLength(1);

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-owner-start",
            item: {
              id: "server-user-echo",
              type: "userMessage",
              clientId,
              content: [{ type: "text", text: "Edited prompt", text_elements: [] }],
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const visibleUserItems =
        conversation?.turns[0]?.items.filter((item) => item.semanticKind === "userMessage") ?? [];
      expect(visibleUserItems.map((item) => item.markdownText)).toEqual(["Edited prompt"]);
      expect(conversation?.canonicalState?.turns[0]?.items.map((item) => item.id)).toEqual([
        "server-user-echo",
      ]);

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-owner-start",
            item: {
              id: "assistant-streaming",
              type: "agentMessage",
              text: "",
              phase: null,
              memoryCitation: null,
              delivery: null,
            },
          },
        },
      });
      await flushAsyncWork();

      const streamingItems = manager.readConversation("thread-1")?.turns[0]?.items ?? [];
      expect(streamingItems.filter((item) => item.semanticKind === "userMessage")).toHaveLength(1);
      expect(streamingItems.map((item) => item.semanticKind)).toEqual([
        "userMessage",
        "assistantMessage",
      ]);
    } finally {
      resumeThreadResult = null;
      ownerTurnStartResult = null;
      manager.destroy();
    }
  });

  test("owner start keeps one user row when item lifecycle races ahead of turn started", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [],
    };
    ownerTurnStartResult = null;
    ownerTurnStartHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      ownerTurnStartHandler = () => {
        const optimisticUser = manager.readConversation("thread-1")?.turns[0]?.items[0];
        const clientId =
          optimisticUser?.rawItem && typeof optimisticUser.rawItem === "object"
            ? (optimisticUser.rawItem as { clientId?: string }).clientId
            : null;
        if (!clientId) throw new Error("Expected optimistic client user-message identity");

        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: 1,
          notification: {
            method: "item/completed",
            params: {
              completedAtMs: 1,
              threadId: "thread-1",
              turnId: "turn-owner-start",
              item: {
                id: "server-user-echo",
                type: "userMessage",
                clientId,
                content: [{ type: "text", text: "Racing prompt", text_elements: [] }],
              },
            },
          },
        });
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: 2,
          notification: {
            method: "item/started",
            params: {
              startedAtMs: 1,
              threadId: "thread-1",
              turnId: "turn-owner-start",
              item: {
                id: "assistant-streaming",
                type: "agentMessage",
                text: "",
                phase: null,
                memoryCitation: null,
                delivery: null,
              },
            },
          },
        });
        dispatchCodexAppServerMessage("thread-owner-notification", {
          hostId: "default",
          sequence: 3,
          notification: {
            method: "turn/started",
            params: {
              threadId: "thread-1",
              turn: buildProtocolTurn({
                id: "turn-owner-start",
                status: "inProgress",
              }),
            },
          },
        });
      };

      await manager.startTurn("thread-1", "Racing prompt", { permissionMode: "auto" });
      await flushAsyncWork(3);

      const conversation = manager.readConversation("thread-1");
      const userItems =
        conversation?.turns
          .flatMap((turn) => turn.items)
          .filter((item) => item.semanticKind === "userMessage") ?? [];
      expect(conversation?.turns).toHaveLength(1);
      expect(userItems.map((item) => item.markdownText)).toEqual(["Racing prompt"]);
      expect(conversation?.turns[0]?.items.map((item) => item.semanticKind)).toEqual([
        "userMessage",
        "assistantMessage",
      ]);
    } finally {
      ownerTurnStartHandler = null;
      resumeThreadResult = null;
      ownerTurnStartResult = null;
      manager.destroy();
    }
  });

  test("owner start failure keeps the fixed local error and restores its prior runtime status", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      threadRuntimeStatus: { type: "idle" },
      turns: [],
    };
    ownerTurnStartError = new Error("transport exploded");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      const beforeStart = manager.readConversation("thread-1");
      if (!beforeStart) throw new Error("Expected owner conversation before failed start");
      invokeRecords = [];

      let caught: unknown = null;
      try {
        await manager.startTurn("thread-1", "Continue", { permissionMode: "auto" });
      } catch (error) {
        caught = error;
      }

      const publishInputs = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:stream-state:publish")
        .map(
          (record) =>
            record.args[0] as {
              change?: { patches?: CodexConversationStateUpdate[] };
            },
        );
      const optimistic = applyCodexConversationStateUpdates(
        beforeStart,
        publishInputs[0]?.change?.patches ?? [],
      );
      const failed = manager.readConversation("thread-1");
      const failedItem = failed?.turns[0]?.items.find((item) => item.type === "error");

      expect(caught).toBe(ownerTurnStartError);
      expect(optimistic?.threadRuntimeStatus?.type).toBe("active");
      expect(failed?.threadRuntimeStatus?.type).toBe("idle");
      expect(failed?.statusType).toBe("idle");
      expect(failed?.turns[0]?.status).toBe("failed");
      expect(failed?.turns[0]?.errorMessage).toBe("Error submitting message");
      expect(failedItem?.markdownText).toBe("Error submitting message");
      expect(failed?.updatedAt).toBe(optimistic?.updatedAt);
    } finally {
      resumeThreadResult = null;
      ownerTurnStartError = null;
      manager.destroy();
    }
  });

  test("endpoint loss settles an optimistic owner turn after revoking its stream role", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      threadRuntimeStatus: { type: "idle" },
      turns: [],
    };
    ownerTurnStartError = null;
    let releaseTurnStart = () => {};
    const turnStartGate = new Promise<void>((resolve) => {
      releaseTurnStart = resolve;
    });
    ownerTurnStartGate = () => turnStartGate;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.setThreadViewActive("thread-1", true);
      await manager.requestThreadStreamResume("thread-1");
      const startPromise = manager.startTurn("thread-1", "Continue", {
        permissionMode: "auto",
      });
      await flushAsyncWork(3);
      expect(manager.readConversation("thread-1")?.turns[0]?.status).toBe("inProgress");

      dispatchCodexAppServerMessage("thread-stream-transport-reset", {
        hostId: "default",
        conversationIds: ["thread-1"],
      });
      ownerTurnStartError = new Error("endpoint generation lost");
      releaseTurnStart();
      await expect(startPromise).rejects.toThrow("endpoint generation lost");
      await flushAsyncWork(3);

      const failed = manager.readConversation("thread-1");
      expect(failed?.resumeState).toBe("needs_resume");
      expect(failed?.threadRuntimeStatus?.type).toBe("idle");
      expect(failed?.turns[0]?.status).toBe("failed");
      expect(failed?.turns[0]?.errorMessage).toBe("Error submitting message");
      expect(manager.readConversationAttachmentState("thread-1").status).toBe("idle");
    } finally {
      releaseTurnStart();
      resumeThreadResult = null;
      ownerTurnStartError = null;
      ownerTurnStartGate = null;
      manager.destroy();
    }
  });

  test("owner action handler delegates queue mutations to Main and revisions local mutations", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      threadGoal: {
        threadId: "thread-1",
        objective: "ship parity",
        status: "active",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const enqueueResult = (await manager.handleThreadOwnerActionRequest({
        type: "enqueueQueuedFollowUp",
        threadId: "thread-1",
        prompt: "Queue this",
      })) as { streamRevision?: number } | null;
      const clearGoalResult = (await manager.handleThreadOwnerActionRequest({
        type: "clearThreadGoal",
        threadId: "thread-1",
      })) as { streamRevision?: number } | null;

      expect(enqueueResult).toBeUndefined();
      expect(clearGoalResult?.streamRevision).toBe(2);
      expect(
        String(manager.readConversation("thread-1")?.queuedFollowUps.entries.length ?? -1),
      ).toBe("0");
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:follow-up:enqueue"),
      ).toBe(true);
      expect(manager.readConversation("thread-1")?.threadGoal).toBe(null);
      expect(manager.readConversation("thread-1")?.canonicalState?.sidecar.threadGoal ?? null).toBe(
        null,
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner queued follow-up send-now keeps the row until Main projects delivery", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 1,
        projectionRevision: 1,
        entries: [
          {
            followUpId: "follow-up-1",
            clientUserMessageId: "client-follow-up-1",
            threadId: "thread-1",
            prompt: "send this now",
            promptInput: { text: "send this now" },
            createdAtMs: 1,
            collaborationMode: null,
            serviceTier: null,
            summary: null,
            pause: null,
            payloadRef: null,
          },
        ],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      await manager.sendQueuedFollowUpNow("thread-1", "follow-up-1");

      expect(
        String(manager.readConversation("thread-1")?.queuedFollowUps.entries.length ?? -1),
      ).toBe("1");
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:follow-up:send-now"),
      ).toBe(true);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread-owner:app-server-request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method === "turn/start",
        ),
      ).toBe(false);

      const row = manager.readConversation("thread-1")?.queuedFollowUps.entries[0];
      if (!row) throw new Error("Expected queued follow-up row");
      await dispatchQueueOwnerProjection(
        {
          status: "ready",
          ledgerRevision: 1,
          projectionRevision: 2,
          entries: [row],
          inFlightFollowUpId: row.followUpId,
          editingFollowUpId: null,
          error: null,
        },
        { manager },
      );
      expect(manager.readConversation("thread-1")?.queuedFollowUps.inFlightFollowUpId).toBe(
        "follow-up-1",
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner steer is visible before transport or publication settles", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      statusType: "active",
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-active",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const publishDeferred: { resolve?: (accepted: boolean) => void } = {};
      let publishCount = 0;
      ownerStreamPublishHandler = () => {
        publishCount += 1;
        if (publishCount > 1) return true;
        return new Promise<boolean>((resolve) => {
          publishDeferred.resolve = resolve;
        });
      };
      const steerDeferred: { resolve?: (result: { turnId: string }) => void } = {};
      const exactSteerParams: Array<{
        expectedTurnId?: string;
        prompt?: string;
        intent?: {
          steerId?: string;
          recoveryRow?: { clientUserMessageId?: string; prompt?: string };
        };
      }> = [];
      ownerTurnSteerHandler = (params) => {
        exactSteerParams.push(params as (typeof exactSteerParams)[number]);
        return new Promise<{ turnId: string }>((resolve) => {
          steerDeferred.resolve = resolve;
        });
      };

      const steerPromise = manager.steerTurn({
        threadId: "thread-1",
        prompt: "adjust the active turn",
      });
      await flushAsyncWork(3);

      const optimisticConversation = manager.readConversation("thread-1");
      const optimisticSteer = optimisticConversation?.turns[0]?.items.find(
        (item) => item.steeringStatus === "pending",
      );
      expect(optimisticConversation?.pendingSteers).toHaveLength(1);
      expect(optimisticSteer?.markdownText).toBe("adjust the active turn");
      expect(exactSteerParams[0]?.expectedTurnId).toBe("turn-active");
      expect(exactSteerParams[0]?.prompt).toBe("adjust the active turn");
      expect(exactSteerParams[0]?.intent?.steerId).toBe(
        optimisticConversation?.pendingSteers[0]?.steerId,
      );
      expect(exactSteerParams[0]?.intent?.recoveryRow).toMatchObject({
        clientUserMessageId: optimisticConversation?.pendingSteers[0]?.steerId,
        prompt: "adjust the active turn",
      });
      expect(invokeRecords.some((record) => record.channel === "codex:turn:steer")).toBe(true);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(true);

      if (!steerDeferred.resolve || !publishDeferred.resolve) {
        throw new Error("Expected deferred owner steer and publication");
      }
      steerDeferred.resolve({ turnId: "turn-active" });
      publishDeferred.resolve(true);
      const result = await steerPromise;
      await flushAsyncWork(2);

      expect(result?.turnId).toBe("turn-active");
      expect(String(manager.readConversation("thread-1")?.pendingSteers.length ?? -1)).toBe("0");
      expect(
        manager.readConversation("thread-1")?.canonicalState?.turns[0]?.items.at(-1)?.type,
      ).toBe("steeringUserMessage");
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread-owner:app-server-request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method === "turn/steer",
        ),
      ).toBe(false);
    } finally {
      ownerTurnSteerHandler = null;
      ownerStreamPublishHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("Main steer retarget results move the optimistic item without changing identity", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = withCanonicalState({
      ...buildConversation("thread-1", "project-1"),
      statusType: "active",
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-stale",
          status: "inProgress",
          itemIds: [],
          items: [],
          turnStartedAtMs: 10,
        },
        {
          threadId: "thread-1",
          turnId: "turn-actual",
          status: "inProgress",
          itemIds: [],
          items: [],
          turnStartedAtMs: 20,
        },
      ],
    });
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      const requests: Array<{
        expectedTurnId?: string;
        prompt?: string;
        intent?: {
          steerId?: string;
          recoveryRow?: { clientUserMessageId?: string; prompt?: string };
        };
      }> = [];
      ownerTurnSteerHandler = (params) => {
        requests.push(params as (typeof requests)[number]);
        return { turnId: "turn-actual" };
      };

      const result = await manager.steerTurn({
        threadId: "thread-1",
        expectedTurnId: "turn-stale",
        prompt: "same prepared steer",
      });

      expect(result?.turnId).toBe("turn-actual");
      expect(requests.map((request) => request.expectedTurnId)).toEqual(["turn-stale"]);
      expect(requests[0]?.prompt).toBe("same prepared steer");
      const canonicalTurns = manager.readConversation("thread-1")?.canonicalState?.turns ?? [];
      expect(canonicalTurns[0]?.items.some((item) => item.type === "steeringUserMessage")).toBe(
        false,
      );
      expect(
        canonicalTurns[1]?.items.find((item) => item.type === "steeringUserMessage"),
      ).toMatchObject({
        id: requests[0]?.intent?.steerId,
        clientUserMessageId: requests[0]?.intent?.recoveryRow?.clientUserMessageId,
        targetTurnId: "turn-actual",
      });
    } finally {
      ownerTurnSteerHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower request responses route through owner from bundle 38687-38843", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = true;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            ...buildConversation("thread-1", "project-1"),
            requests: [
              {
                type: "approval",
                requestId: "approval-1",
                kind: "command",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "cmd-1",
                createdAt: 1,
              },
              {
                type: "approval",
                requestId: "file-approval-1",
                kind: "file",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "file-1",
                createdAt: 2,
              },
              {
                type: "userInput",
                requestId: "input-1",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "user-input-response-input-1",
                isBlocking: true,
                questions: [
                  {
                    id: "q1",
                    header: "Question",
                    question: "Pick one",
                    isOther: false,
                    isSecret: false,
                  },
                ],
                createdAt: 3,
              },
              {
                type: "mcpServerElicitation",
                requestId: "mcp-1",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "mcp-server-elicitation-mcp-1",
                kind: "generic",
                mode: "form",
                serverName: "server",
                message: "Confirm",
                createdAt: 4,
              },
              {
                type: "permissionRequest",
                requestId: "permission-1",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "permission-request-permission-1",
                cwd: "/repo",
                reason: "Need access",
                permissions: {
                  network: {
                    enabled: true,
                  },
                  fileSystem: null,
                },
                response: null,
                completed: false,
                createdAt: 5,
              },
            ],
          },
        },
        sourceClientId: "owner-a",
      });

      const approvalAccepted = await manager.respondApproval("approval-1", {
        kind: "command",
        decision: "decline",
      });
      const fileApprovalAccepted = await manager.respondApproval("file-approval-1", {
        kind: "file",
        decision: "decline",
      });
      const inputAccepted = await manager.respondUserInput("input-1", { q1: ["A"] });
      const mcpAccepted = await manager.respondMcpElicitation("mcp-1", "decline");
      const permissionAccepted = await manager.respondPermissionRequest("permission-1", {
        permissions: {},
        scope: "turn",
      });

      const followerActions = invokeRecords
        .filter((record) => record.channel === "codex:thread-follower:action")
        .map(
          (record) =>
            record.args[0] as {
              action?: {
                type?: string;
                conversationId?: string;
                requestId?: string;
                approvalResponse?: { kind?: "command" | "file"; decision?: string };
                answers?: Record<string, string[]>;
                response?: {
                  action?: string;
                  scope?: string;
                  kind?: "command" | "file";
                  decision?: string;
                };
              };
            },
        );
      expect(approvalAccepted).toBe(true);
      expect(fileApprovalAccepted).toBe(true);
      expect(inputAccepted).toBe(true);
      expect(mcpAccepted).toBe(true);
      expect(permissionAccepted).toBe(true);
      expect(String(followerActions.length)).toBe("5");
      expect(followerActions[0]?.action?.type).toBe("respondApproval");
      expect(followerActions[0]?.action?.conversationId).toBe("thread-1");
      expect(followerActions[0]?.action?.requestId).toBe("approval-1");
      expect(followerActions[0]?.action?.response?.kind).toBe("command");
      expect(followerActions[0]?.action?.response?.decision).toBe("decline");
      expect(followerActions[1]?.action?.type).toBe("respondApproval");
      expect(followerActions[1]?.action?.requestId).toBe("file-approval-1");
      expect(followerActions[1]?.action?.response?.kind).toBe("file");
      expect(followerActions[1]?.action?.response?.decision).toBe("decline");
      expect(followerActions[2]?.action?.type).toBe("respondUserInput");
      expect(followerActions[2]?.action?.requestId).toBe("input-1");
      expect(followerActions[2]?.action?.answers?.q1?.[0]).toBe("A");
      expect(followerActions[3]?.action?.type).toBe("respondMcpElicitation");
      expect(followerActions[3]?.action?.requestId).toBe("mcp-1");
      expect(followerActions[3]?.action?.response?.action).toBe("decline");
      expect(followerActions[4]?.action?.type).toBe("respondPermissionRequest");
      expect(followerActions[4]?.action?.requestId).toBe("permission-1");
      expect(followerActions[4]?.action?.response?.scope).toBe("turn");
      expect(invokeRecords.some((record) => record.channel === "codex:approval:respond")).toBe(
        false,
      );
      expect(invokeRecords.some((record) => record.channel === "codex:user-input:respond")).toBe(
        false,
      );
      expect(
        invokeRecords.some((record) => record.channel === "codex:mcp-elicitation:respond"),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:permission-request:respond"),
      ).toBe(false);
      expect(String(manager.readConversation("thread-1")?.requests.length ?? -1)).toBe("5");
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("stale follower request responses route by explicit conversation id before local request lookup", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = true;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            ...buildConversation("thread-1", "project-1"),
            requests: [],
          },
        },
        sourceClientId: "owner-a",
      });

      const approvalAccepted = await manager.respondApproval(
        "approval-missed",
        { kind: "command", decision: "decline" },
        "thread-1",
      );
      const inputAccepted = await manager.respondUserInput(
        "input-missed",
        { q1: ["A"] },
        "thread-1",
      );
      const mcpAccepted = await manager.respondMcpElicitation("mcp-missed", "decline", "thread-1");
      const permissionAccepted = await manager.respondPermissionRequest(
        "permission-missed",
        {
          permissions: {},
          scope: "turn",
        },
        "thread-1",
      );

      const followerActions = invokeRecords
        .filter((record) => record.channel === "codex:thread-follower:action")
        .map(
          (record) =>
            record.args[0] as {
              conversationId?: string;
              action?: {
                type?: string;
                conversationId?: string;
                requestId?: string;
                answers?: Record<string, string[]>;
                response?: { action?: string; scope?: string; decision?: string };
              };
            },
        );

      expect(approvalAccepted).toBe(true);
      expect(inputAccepted).toBe(true);
      expect(mcpAccepted).toBe(true);
      expect(permissionAccepted).toBe(true);
      expect(String(followerActions.length)).toBe("4");
      expect(followerActions[0]?.conversationId).toBe("thread-1");
      expect(followerActions[0]?.action?.type).toBe("respondApproval");
      expect(followerActions[0]?.action?.conversationId).toBe("thread-1");
      expect(followerActions[0]?.action?.requestId).toBe("approval-missed");
      expect(followerActions[0]?.action?.response?.decision).toBe("decline");
      expect(followerActions[1]?.action?.type).toBe("respondUserInput");
      expect(followerActions[1]?.action?.conversationId).toBe("thread-1");
      expect(followerActions[1]?.action?.requestId).toBe("input-missed");
      expect(followerActions[1]?.action?.answers?.q1?.[0]).toBe("A");
      expect(followerActions[2]?.action?.type).toBe("respondMcpElicitation");
      expect(followerActions[2]?.action?.conversationId).toBe("thread-1");
      expect(followerActions[2]?.action?.requestId).toBe("mcp-missed");
      expect(followerActions[2]?.action?.response?.action).toBe("decline");
      expect(followerActions[3]?.action?.type).toBe("respondPermissionRequest");
      expect(followerActions[3]?.action?.conversationId).toBe("thread-1");
      expect(followerActions[3]?.action?.requestId).toBe("permission-missed");
      expect(followerActions[3]?.action?.response?.scope).toBe("turn");
      expect(invokeRecords.some((record) => record.channel === "codex:approval:respond")).toBe(
        false,
      );
      expect(invokeRecords.some((record) => record.channel === "codex:user-input:respond")).toBe(
        false,
      );
      expect(
        invokeRecords.some((record) => record.channel === "codex:mcp-elicitation:respond"),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:permission-request:respond"),
      ).toBe(false);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower request response owner-unavailable path does not direct fallback from bundle 38687-38843 and 47201-47228", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    followerActionError = new Error("no-client-found: thread stream owner disconnected");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            ...buildConversation("thread-1", "project-1"),
            resumeState: "resumed",
            requests: [
              {
                type: "approval",
                requestId: "approval-1",
                kind: "command",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "cmd-1",
                createdAt: 1,
              },
              {
                type: "userInput",
                requestId: "input-1",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "user-input-response-input-1",
                isBlocking: true,
                questions: [
                  {
                    id: "q1",
                    header: "Question",
                    question: "Pick one",
                    isOther: false,
                    isSecret: false,
                  },
                ],
                createdAt: 2,
              },
              {
                type: "mcpServerElicitation",
                requestId: "mcp-1",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "mcp-server-elicitation-mcp-1",
                kind: "generic",
                mode: "form",
                serverName: "server",
                message: "Confirm",
                createdAt: 3,
              },
              {
                type: "permissionRequest",
                requestId: "permission-1",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "permission-request-permission-1",
                cwd: "/repo",
                reason: "Need access",
                permissions: {
                  network: {
                    enabled: true,
                  },
                  fileSystem: null,
                },
                response: null,
                completed: false,
                createdAt: 4,
              },
            ],
          },
        },
        sourceClientId: "owner-a",
      });

      const approvalAccepted = await manager.respondApproval(
        "approval-1",
        { kind: "command", decision: "decline" },
        "thread-1",
      );
      const inputAccepted = await manager.respondUserInput("input-1", { q1: ["A"] }, "thread-1");
      const mcpAccepted = await manager.respondMcpElicitation("mcp-1", "decline", "thread-1");
      const permissionAccepted = await manager.respondPermissionRequest(
        "permission-1",
        {
          permissions: {},
          scope: "turn",
        },
        "thread-1",
      );

      expect(approvalAccepted).toBe(false);
      expect(inputAccepted).toBe(false);
      expect(mcpAccepted).toBe(false);
      expect(permissionAccepted).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-follower:action"),
      ).toBe(true);
      expect(invokeRecords.some((record) => record.channel === "codex:approval:respond")).toBe(
        false,
      );
      expect(invokeRecords.some((record) => record.channel === "codex:user-input:respond")).toBe(
        false,
      );
      expect(
        invokeRecords.some((record) => record.channel === "codex:mcp-elicitation:respond"),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:permission-request:respond"),
      ).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:request")).toBe(
        false,
      );
      expect(manager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(String(manager.readConversation("thread-1")?.requests.length ?? -1)).toBe("4");
    } finally {
      followerActionError = null;
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("owner file approval and MCP elicitation requests publish request-plane patches from bundle 51926-52180", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: {
          id: "file-approval-1",
          method: "item/fileChange/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "file-change-1",
            startedAtMs: 11,
            reason: "Need write access",
            grantRoot: "/repo",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 2,
        request: {
          id: "mcp-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            mode: "openai/form",
            serverName: "Context7",
            message: "Allow this call?",
            requestedSchema: { type: "object", properties: {} },
            _meta: null,
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const mcpItem = conversation?.turns[0]?.items.find(
        (item) => item.itemId === "mcp-server-elicitation-mcp-1",
      );
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );

      expect(String(conversation?.requests.length ?? -1)).toBe("2");
      expect(conversation?.requests[0]?.type).toBe("approval");
      expect(conversation?.requests[0]?.requestId).toBe("file-approval-1");
      expect(conversation?.requests[1]?.type).toBe("mcpServerElicitation");
      expect(conversation?.requests[1]?.requestId).toBe("mcp-1");
      expect(mcpItem?.semanticKind).toBe("mcpServerElicitation");
      expect(mcpItem?.status).toBe("inProgress");
      expect(mcpItem?.markdownText).toBe("Allow this call?");
      expect(String(publishRecords.length)).toBe("2");
      expect(
        (
          publishRecords[publishRecords.length - 1]?.args[0] as
            | { ownerNotificationSequence?: number }
            | undefined
        )?.ownerNotificationSequence,
      ).toBe(2);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("recovers an owner request that arrives before the canonical conversation is ready", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const unreadyConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-owner-request-race", "project-1"),
        canonicalState: null,
        turns: [
          {
            threadId: "thread-owner-request-race",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = unreadyConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-owner-request-race",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: unreadyConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-owner-request-race");

      resumeThreadResult = {
        ...buildConversation("thread-owner-request-race", "project-1"),
        turns: unreadyConversation.turns,
      };
      invokeRecords = [];
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: {
          id: "mcp-owner-request-race",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-owner-request-race",
            turnId: "turn-1",
            mode: "form",
            serverName: "node_repl",
            message: "Allow Browser use to access https://example.com?",
            requestedSchema: { type: "object", properties: {} },
            _meta: null,
          },
        },
      });

      await waitForCondition(
        () =>
          manager
            .readConversation("thread-owner-request-race")
            ?.requests.some((request) => request.requestId === "mcp-owner-request-race") === true,
        500,
      );

      const conversation = manager.readConversation("thread-owner-request-race");
      expect(conversation?.resumeState).toBe("resumed");
      expect(conversation?.canonicalState?.protocol.id).toBe("thread-owner-request-race");
      expect(conversation?.requests[0]?.type).toBe("mcpServerElicitation");
      expect(conversation?.requests[0]?.requestId).toBe("mcp-owner-request-race");
      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:request")).toBe(
        true,
      );
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(true);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner completed plan creates the private implementation request and next turn retires it", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const planItem: CodexConversationItem = {
        threadId: "thread-1",
        turnId: "turn-plan",
        itemId: "plan-1",
        type: "plan",
        kind: "plan",
        semanticKind: "proposedPlan",
        status: "completed",
        markdownText: "  1. Inspect bundle\n2. Ship parity  ",
        rawItem: {
          id: "plan-1",
          type: "plan",
          text: "  1. Inspect bundle\n2. Ship parity  ",
        },
        createdAt: 30,
        updatedAt: 40,
      };
      const staleImplementationItems: CodexConversationItem[] = [
        "stale-plan-a",
        "stale-plan-b",
      ].map((itemId, index) => ({
        threadId: "thread-1",
        turnId: "turn-plan",
        itemId,
        type: "planImplementation",
        kind: "planImplementation",
        semanticKind: "planImplementation",
        status: "inProgress",
        markdownText: "1. Inspect bundle\n2. Ship parity",
        rawItem: {
          id: itemId,
          type: "planImplementation",
          turnId: "turn-plan",
          planContent: "1. Inspect bundle\n2. Ship parity",
          isCompleted: false,
        },
        createdAt: 10 + index,
        updatedAt: 20 + index,
      }));
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-plan",
            status: "inProgress",
            itemIds: ["plan-1", ...staleImplementationItems.map((item) => item.itemId)],
            items: [planItem, ...staleImplementationItems],
          },
        ],
        requests: [
          {
            type: "implementPlan",
            requestId: "orphan-plan",
            projectId: "project-1",
            threadId: "thread-1",
            turnId: "turn-orphan",
            itemId: "orphan-plan",
            planContent: "orphan",
            createdAt: 5,
          },
        ],
        canonicalRequests: [
          {
            id: "orphan-plan",
            method: "item/plan/requestImplementation",
            params: {
              threadId: "thread-1",
              turnId: "turn-orphan",
              planContent: "orphan",
            },
          },
        ],
      });
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: buildProtocolTurn({
              id: "turn-plan",
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1_000,
            }),
          },
        },
      });
      await flushAsyncWork(3);

      let conversation = manager.readConversation("thread-1");
      let implementationItem = conversation?.turns[0]?.items.find(
        (item) => item.itemId === "implement-plan:turn-plan",
      );
      const implementationItems =
        conversation?.turns[0]?.items.filter((item) => item.type === "planImplementation") ?? [];
      const planRequest = conversation?.requests.find((request) => request.turnId === "turn-plan");
      const canonicalPlanRequest = conversation?.canonicalRequests?.find(
        (request) =>
          request.method === "item/plan/requestImplementation" &&
          request.params.turnId === "turn-plan",
      );
      expect(implementationItems.length).toBe(1);
      expect(JSON.stringify(conversation?.turns[0]?.itemIds)).toBe(
        JSON.stringify(["plan-1", "implement-plan:turn-plan"]),
      );
      expect(implementationItem?.status).toBe("inProgress");
      expect(implementationItem?.markdownText).toBe("1. Inspect bundle\n2. Ship parity");
      expect(implementationItem?.createdAt).toBe(30);
      expect(implementationItem?.updatedAt).toBe(40);
      expect(JSON.stringify(implementationItem?.rawItem)).toBe(
        JSON.stringify({
          id: "implement-plan:turn-plan",
          type: "planImplementation",
          turnId: "turn-plan",
          planContent: "1. Inspect bundle\n2. Ship parity",
          isCompleted: false,
        }),
      );
      expect(planRequest?.type).toBe("implementPlan");
      expect(planRequest?.requestId).toBe("implement-plan:turn-plan");
      expect(canonicalPlanRequest?.method).toBe("item/plan/requestImplementation");
      expect(canonicalPlanRequest?.id).toBe("implement-plan:turn-plan");
      expect(String(conversation?.requests.length ?? -1)).toBe("2");
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("2");
      expect(conversation?.hasUnreadTurn).toBe(true);

      const firstImplementationItem = implementationItem;
      const firstCanonicalPlanRequest = canonicalPlanRequest;
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 2,
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: buildProtocolTurn({
              id: "turn-plan",
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1_000,
            }),
          },
        },
      });
      await flushAsyncWork(3);

      conversation = manager.readConversation("thread-1");
      implementationItem = conversation?.turns[0]?.items.find(
        (item) => item.itemId === "implement-plan:turn-plan",
      );
      const repeatedCanonicalPlanRequest = conversation?.canonicalRequests?.find(
        (request) =>
          request.method === "item/plan/requestImplementation" &&
          request.params.turnId === "turn-plan",
      );
      expect(
        conversation?.turns[0]?.items.filter((item) => item.type === "planImplementation").length,
      ).toBe(1);
      expect(implementationItem === firstImplementationItem).toBe(false);
      expect(repeatedCanonicalPlanRequest === firstCanonicalPlanRequest).toBe(false);
      expect(String(conversation?.requests.length ?? -1)).toBe("2");
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("2");

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 3,
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-plan",
            item: {
              id: "plan-whitespace",
              type: "plan",
              text: "  \n\t ",
            },
          },
        },
      });
      await flushAsyncWork(3);
      const conversationWithWhitespacePlan = manager.readConversation("thread-1");
      const implementationBeforeWhitespace = conversationWithWhitespacePlan?.turns[0]?.items.find(
        (item) => item.itemId === "implement-plan:turn-plan",
      );
      const requestBeforeWhitespace = conversationWithWhitespacePlan?.canonicalRequests?.find(
        (request) =>
          request.method === "item/plan/requestImplementation" &&
          request.params.turnId === "turn-plan",
      );
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 4,
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: buildProtocolTurn({
              id: "turn-plan",
              status: "completed",
              error: null,
              startedAt: 1,
              completedAt: 2,
              durationMs: 1_000,
            }),
          },
        },
      });
      await flushAsyncWork(3);

      conversation = manager.readConversation("thread-1");
      implementationItem = conversation?.turns[0]?.items.find(
        (item) => item.itemId === "implement-plan:turn-plan",
      );
      const requestAfterWhitespace = conversation?.canonicalRequests?.find(
        (request) =>
          request.method === "item/plan/requestImplementation" &&
          request.params.turnId === "turn-plan",
      );
      expect(JSON.stringify(implementationItem)).toBe(
        JSON.stringify(implementationBeforeWhitespace),
      );
      expect(requestBeforeWhitespace?.id).toBe("implement-plan:turn-plan");
      expect(requestAfterWhitespace?.id).toBe("implement-plan:turn-plan");
      expect(
        conversation?.canonicalRequests?.filter(
          (request) =>
            request.method === "item/plan/requestImplementation" &&
            request.params.turnId === "turn-plan",
        ).length,
      ).toBe(1);
      expect(implementationItem?.status).toBe("inProgress");
      expect(String(conversation?.requests.length ?? -1)).toBe("2");
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("2");

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 5,
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: buildProtocolTurn({
              id: "turn-next",
              status: "inProgress",
              error: null,
              startedAt: 3,
              completedAt: null,
              durationMs: null,
            }),
          },
        },
      });
      await flushAsyncWork(3);

      conversation = manager.readConversation("thread-1");
      implementationItem = conversation?.turns[0]?.items.find(
        (item) => item.itemId === "implement-plan:turn-plan",
      );
      expect(implementationItem?.status).toBe("completed");
      expect(
        (implementationItem?.rawItem as { isCompleted?: boolean } | undefined)?.isCompleted,
      ).toBe(true);
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("0");
      expect(conversation?.turns.at(-1)?.turnId).toBe("turn-next");
      expect(conversation?.hasUnreadTurn).toBe(true);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower plan implementation removal routes through owner from bundle 9700-9760", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = true;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            ...buildConversation("thread-1", "project-1"),
            turns: [
              {
                threadId: "thread-1",
                turnId: "turn-plan",
                status: "completed",
                itemIds: ["implement-plan:turn-plan"],
                items: [
                  {
                    threadId: "thread-1",
                    turnId: "turn-plan",
                    itemId: "implement-plan:turn-plan",
                    type: "planImplementation",
                    kind: "planImplementation",
                    semanticKind: "planImplementation",
                    status: "inProgress",
                    markdownText: "1. Ship the fix",
                    rawItem: {
                      id: "implement-plan:turn-plan",
                      type: "planImplementation",
                      turnId: "turn-plan",
                      planContent: "1. Ship the fix",
                      isCompleted: false,
                    },
                    createdAt: 1,
                    updatedAt: 1,
                  },
                ],
              },
            ],
            requests: [
              {
                type: "implementPlan",
                requestId: "implement-plan:turn-plan",
                projectId: "project-1",
                threadId: "thread-1",
                turnId: "turn-plan",
                itemId: "implement-plan:turn-plan",
                planContent: "1. Ship the fix",
                createdAt: 1,
              },
            ],
          },
        },
        sourceClientId: "owner-a",
      });

      const accepted = await manager.removePlanImplementationRequest("thread-1", "turn-plan");
      const followerAction = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      )?.args[0] as
        | {
            conversationId?: string;
            action?: { type?: string; threadId?: string; turnId?: string };
          }
        | undefined;

      expect(accepted).toBe(true);
      expect(followerAction?.conversationId).toBe("thread-1");
      expect(followerAction?.action?.type).toBe("removePlanImplementationRequest");
      expect(followerAction?.action?.threadId).toBe("thread-1");
      expect(followerAction?.action?.turnId).toBe("turn-plan");
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread:plan-implementation:remove",
        ),
      ).toBe(false);
      expect(String(manager.readConversation("thread-1")?.requests.length ?? -1)).toBe("1");
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower plan implementation removal waits for owner revision and returns accepted", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = { accepted: true, streamRevision: 2 };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    let resolved = false;
    let accepted = false;
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      const removePromise = manager
        .removePlanImplementationRequest("thread-1", "turn-plan")
        .then((result) => {
          resolved = true;
          accepted = result;
        });
      await flushAsyncWork();
      expect(resolved).toBe(false);

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "snapshot",
          revision: 2,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      await removePromise;
      expect(resolved).toBe(true);
      expect(accepted).toBe(true);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("owner plan implementation removal completes item before main sync from bundle 45740-45805", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      resumeThreadResult = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-plan",
            status: "completed",
            itemIds: ["implement-plan:turn-plan"],
            items: [
              {
                threadId: "thread-1",
                turnId: "turn-plan",
                itemId: "implement-plan:turn-plan",
                type: "planImplementation",
                kind: "planImplementation",
                semanticKind: "planImplementation",
                status: "inProgress",
                markdownText: "1. Ship the fix",
                rawItem: {
                  id: "implement-plan:turn-plan",
                  type: "planImplementation",
                  turnId: "turn-plan",
                  planContent: "1. Ship the fix",
                  isCompleted: false,
                },
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        ],
        requests: [
          {
            type: "implementPlan",
            requestId: "implement-plan:turn-plan",
            projectId: "project-1",
            threadId: "thread-1",
            turnId: "turn-plan",
            itemId: "implement-plan:turn-plan",
            planContent: "1. Ship the fix",
            createdAt: 1,
          },
        ],
        canonicalRequests: [
          {
            id: "implement-plan:turn-plan",
            method: "item/plan/requestImplementation",
            params: {
              threadId: "thread-1",
              turnId: "turn-plan",
              planContent: "1. Ship the fix",
            },
          },
        ],
      };
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const result = (await manager.handleThreadOwnerActionRequest({
        type: "removePlanImplementationRequest",
        threadId: "thread-1",
        turnId: "turn-plan",
      })) as { accepted?: boolean; streamRevision?: number } | null;
      const conversation = manager.readConversation("thread-1");
      const item = conversation?.turns[0]?.items[0];
      const publishIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const mainSyncIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:plan-implementation:remove",
      );
      const publishedSnapshot = (
        invokeRecords[publishIndex]?.args[0] as
          | {
              change?: {
                type?: string;
                patches?: CodexConversationStateUpdate[];
              };
            }
          | undefined
      )?.change;

      expect(result?.accepted).toBe(true);
      expect(result?.streamRevision).toBe(2);
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("0");
      expect(item?.status).toBe("completed");
      expect(JSON.stringify(item?.rawItem)).toBe(
        JSON.stringify({
          id: "implement-plan:turn-plan",
          type: "planImplementation",
          turnId: "turn-plan",
          planContent: "1. Ship the fix",
          isCompleted: true,
        }),
      );
      expect(String(conversation?.canonicalState?.requests.length ?? -1)).toBe("0");
      const canonicalPlan = conversation?.canonicalState?.turns[0]?.items.find(
        (candidate) => candidate.type === "planImplementation",
      );
      expect(canonicalPlan?.type === "planImplementation" && canonicalPlan.isCompleted).toBe(true);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread:plan-implementation:remove",
        ),
      ).toBe(true);
      expect(publishIndex >= 0).toBe(true);
      expect(publishedSnapshot?.type).toBe("patches");
      expect((publishedSnapshot?.patches?.length ?? 0) > 0).toBe(true);
      expect(mainSyncIndex > publishIndex).toBe(true);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-follower:action"),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower actions fall back to local owner path after no-client-found recovery", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    followerActionError = new Error("no-client-found: thread stream owner disconnected");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "owner-a",
      });

      await manager.startTurn("thread-1", "Continue", { permissionMode: "auto" });

      const channels = invokeRecords.map((record) => record.channel).join(",");
      expect(channels.includes("codex:thread-follower:action")).toBe(true);
      expect(channels.includes("codex:thread:resume:request")).toBe(true);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread-owner:app-server-request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method === "turn/start",
        ),
      ).toBe(true);
      expect(channels.includes("codex:turn:start")).toBe(false);
      expect(manager.getThreadRoleForRendererClientRequest("thread-1")).toBe("owner");
    } finally {
      followerActionError = null;
      followerActionResult = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("marks follower conversations needs_resume when the renderer owner is unavailable", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "working")],
          },
        ],
      };
      const staleOwnerConversation: CodexConversationSnapshot = {
        ...baseConversation,
        turns: [
          {
            ...baseConversation.turns[0]!,
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "stale owner")],
          },
        ],
      };

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "owner-a",
      });
      dispatchCodexAppServerMessage("thread-owner-unavailable", {
        hostId: "default",
        ownerClientId: "owner-a",
        conversationIds: ["thread-1"],
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCodexConversationStateUpdates(baseConversation, staleOwnerConversation),
        },
        sourceClientId: "owner-a",
      });
      const fallbackConversation: CodexConversationSnapshot = {
        ...baseConversation,
        resumeState: "needs_resume",
        turns: [
          {
            ...baseConversation.turns[0]!,
            items: [
              buildAssistantMessage("thread-1", "turn-1", "assistant-1", "canonical fallback"),
            ],
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 3,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: fallbackConversation,
        },
        sourceClientId: null,
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "working",
      );
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("revokes a visible owner role when the app-server transport generation is reset", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadError = null;
    resumeThreadRole = "owner";
    resumeThreadRevision = 1;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "working")],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      await manager.setThreadViewActive("thread-1", true);
      await manager.requestThreadStreamResume("thread-1");
      expect(manager.getThreadRoleForRendererClientRequest("thread-1")).toBe("owner");

      dispatchCodexAppServerMessage("thread-stream-transport-reset", {
        hostId: "default",
        conversationIds: ["thread-1"],
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(manager.readConversationAttachmentState("thread-1").status).toBe("idle");
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:stream-following:set" &&
            (record.args[0] as { reannounce?: boolean }).reannounce === true,
        ),
      ).toBe(true);
    } finally {
      resumeThreadResult = null;
      resumeThreadRevision = 0;
      manager.destroy();
    }
  });

  test("owner interrupt declines every pending raw request family before turn interrupt", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerRequestResponseHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1"],
            items: [buildCommandExecutionItem("thread-1", "turn-1", "cmd-1")],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await manager.requestThreadStreamResume("thread-1");

      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 1,
        request: {
          id: "command-1",
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            startedAtMs: 1,
            approvalId: null,
            environmentId: null,
            reason: "Need command access",
            command: "bun test",
            cwd: "/repo",
            commandActions: null,
            additionalPermissions: null,
            proposedExecpolicyAmendment: null,
            proposedNetworkPolicyAmendments: null,
            availableDecisions: null,
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 2,
        request: {
          id: "file-1",
          method: "item/fileChange/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "file-change-1",
            startedAtMs: 2,
            reason: "Need write access",
            grantRoot: "/repo",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 3,
        request: {
          id: "permission-1",
          method: "item/permissions/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "permission-call-1",
            environmentId: "env-1",
            startedAtMs: 3,
            cwd: "/repo",
            reason: "Need network",
            permissions: {
              network: { enabled: true },
              fileSystem: null,
            },
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 4,
        request: {
          id: "user-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "input-call-1",
            isBlocking: true,
            autoResolutionMs: null,
            questions: [
              {
                id: "q1",
                header: "Choice",
                question: "Pick one",
                isOther: false,
                isSecret: false,
                options: [{ label: "A", description: "First" }],
              },
            ],
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 5,
        request: {
          id: "option-1",
          method: "item/tool/requestOptionPicker",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            question: "Choose",
            options: [{ label: "Continue", description: "Continue" }],
            allowMultiple: false,
            submitLabel: "Submit",
            skipLabel: null,
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 6,
        request: {
          id: "setup-1",
          method: "item/tool/requestSetupCodexContextPicker",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      });
      dispatchCodexAppServerMessage("thread-owner-request", {
        hostId: "default",
        sequence: 7,
        request: {
          id: "mcp-1",
          method: "mcpServer/elicitation/request",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            mode: "openai/form",
            serverName: "Context7",
            message: "Allow this call?",
            requestedSchema: { type: "object", properties: {} },
            _meta: null,
          },
        },
      });
      await flushAsyncWork(4);
      expect(String(manager.readConversation("thread-1")?.canonicalRequests?.length ?? -1)).toBe(
        "7",
      );
      invokeRecords = [];

      const interrupted = await manager.handleThreadOwnerActionRequest({
        type: "interruptTurn",
        threadId: "thread-1",
        turnId: "turn-1",
      });
      await flushAsyncWork(3);

      const responseOrder = invokeRecords.flatMap((record) => {
        if (
          record.channel === "codex:approval:respond" ||
          record.channel === "codex:permission-request:respond" ||
          record.channel === "codex:user-input:respond" ||
          record.channel === "codex:option-picker:respond" ||
          record.channel === "codex:setup-context-picker:respond" ||
          record.channel === "codex:mcp-elicitation:respond"
        ) {
          return [`${record.channel}:${String(record.args[1])}`];
        }
        if (
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "turn/interrupt"
        ) {
          return ["turn/interrupt"];
        }
        return [];
      });
      expect(interrupted).toBe(true);
      expect(JSON.stringify(responseOrder)).toBe(
        JSON.stringify([
          "codex:approval:respond:command-1",
          "codex:approval:respond:file-1",
          "codex:permission-request:respond:permission-1",
          "codex:user-input:respond:user-1",
          "codex:option-picker:respond:option-1",
          "codex:setup-context-picker:respond:setup-1",
          "codex:mcp-elicitation:respond:mcp-1",
          "turn/interrupt",
        ]),
      );
      expect(String(manager.readConversation("thread-1")?.canonicalRequests?.length ?? -1)).toBe(
        "0",
      );
      expect(String(manager.readConversation("thread-1")?.requests.length ?? -1)).toBe("0");
    } finally {
      ownerRequestResponseHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner renderer-client action requests execute direct owner actions", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["assistant-1"],
            items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "working")],
          },
        ],
      };
      resumeThreadResult = baseConversation;
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const result = await manager.handleThreadOwnerActionRequest({
        type: "interruptTurn",
        threadId: "thread-1",
        turnId: "turn-1",
      });

      expect(result).toBe(true);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread-owner:app-server-request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method ===
              "turn/interrupt",
        ),
      ).toBe(true);
      expect(invokeRecords.some((record) => record.channel === "codex:turn:interrupt")).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-follower:action"),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner interrupt pauses active thread goal before turn interrupt", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      threadGoal: {
        threadId: "thread-1",
        objective: "finish the migration",
        status: "active",
        tokenBudget: null,
        tokensUsed: 12,
        timeUsedSeconds: 34,
        createdAt: 1,
        updatedAt: 1,
      },
      threadGoalResumeConfirmation: {
        threadId: "thread-1",
        objective: "stale prompt",
        status: "paused",
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "inProgress",
          itemIds: ["assistant-1"],
          items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "working")],
        },
      ],
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const result = await manager.handleThreadOwnerActionRequest({
        type: "interruptTurn",
        threadId: "thread-1",
        turnId: "turn-1",
      });

      const ownerRequests = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:app-server-request")
        .map(
          (record) =>
            (
              record.args[0] as {
                request?: {
                  method?: string;
                  params?: { threadId?: string; status?: string; turnId?: string };
                };
              }
            ).request,
        );

      expect(result).toBe(true);
      expect(ownerRequests[0]?.method).toBe("thread/goal/set");
      expect(ownerRequests[0]?.params?.threadId).toBe("thread-1");
      expect(ownerRequests[0]?.params?.status).toBe("paused");
      expect(ownerRequests[1]?.method).toBe("turn/interrupt");
      expect(ownerRequests[1]?.params?.turnId).toBe("turn-1");
      expect(manager.readConversation("thread-1")?.threadGoal?.status).toBe("paused");
      expect(manager.readConversation("thread-1")?.threadGoalResumeConfirmation ?? null).toBe(null);
      expect(invokeRecords.some((record) => record.channel === "codex:turn:interrupt")).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner idle status continues active thread goal after guard delay", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      statusType: "active",
      threadGoal: {
        threadId: "thread-1",
        objective: "finish the migration",
        status: "active",
        tokenBudget: null,
        tokensUsed: 12,
        timeUsedSeconds: 34,
        createdAt: 1,
        updatedAt: 1,
      },
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
          itemIds: ["assistant-1"],
          items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "done")],
        },
      ],
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "idle" },
          },
        },
      });

      await waitForCondition(
        () =>
          invokeRecords.some(
            (record) =>
              record.channel === "codex:thread-owner:app-server-request" &&
              (record.args[0] as { request?: { method?: string; params?: { status?: string } } })
                .request?.method === "thread/goal/set" &&
              (record.args[0] as { request?: { params?: { status?: string } } }).request?.params
                ?.status === "active",
          ),
        1_000,
      );

      const goalSetRequests = invokeRecords.filter(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method ===
            "thread/goal/set",
      );
      expect(goalSetRequests.length).toBe(1);
      expect(manager.readConversation("thread-1")?.statusType).toBe("idle");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner idle status waits for the complete subagent tree before continuing a goal", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    subagentOverviewResult = {
      rootThreadId: "thread-1",
      revision: 1,
      generation: 1,
      completeness: "incomplete",
      active: { rows: [], knownCount: 1, totalCount: null, continuation: null },
      done: { rows: [], knownCount: 0, totalCount: null, continuation: null },
    };
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      statusType: "active",
      threadGoal: {
        threadId: "thread-1",
        objective: "finish the migration",
        status: "active",
        tokenBudget: null,
        tokensUsed: 12,
        timeUsedSeconds: 34,
        createdAt: 1,
        updatedAt: 1,
      },
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
          itemIds: ["assistant-1"],
          items: [buildAssistantMessage("thread-1", "turn-1", "assistant-1", "done")],
        },
      ],
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "thread/status/changed",
          params: { threadId: "thread-1", status: { type: "idle" } },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread-owner:app-server-request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method ===
              "thread/goal/set",
        ),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:subagents:overview:read"),
      ).toBe(true);
    } finally {
      subagentOverviewResult = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("renderer client request bridge answers thread-role from current stream state", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
    };
    const {
      LocalConversationProvider,
      useDefaultCodexAppServerManager,
      __resetLocalConversationStoreForTests,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    let manager: {
      requestThreadStreamResume: (threadId: string) => Promise<CodexConversationSnapshot | null>;
    } | null = null;
    function Probe() {
      manager = useDefaultCodexAppServerManager();
      return createElement("div");
    }

    render(createElement(LocalConversationProvider, null, createElement(Probe)));
    await settleAsyncRender();
    if (!manager) throw new Error("Expected manager");

    await act(async () => {
      await manager?.requestThreadStreamResume("thread-1");
    });

    await act(async () => {
      rendererClientRequestListener?.({
        requestId: "role-1",
        method: "thread-role",
        params: {
          conversationId: "thread-1",
        },
      });
      await flushAsyncWork();
    });

    const responseRecord = invokeRecords.find(
      (record) => record.channel === "codex:renderer-client:response",
    );
    const response = responseRecord?.args[0] as
      | { type?: string; requestId?: string; result?: unknown }
      | undefined;
    expect(response?.type).toBe("success");
    expect(response?.requestId).toBe("role-1");
    expect(response?.result).toBe("owner");
    resumeThreadResult = null;
  });

  test("renderer queue owner updates fence revisions and publish projection with steer staging atomically", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadGeneration = 7;
    resumeThreadResult = withCanonicalState({
      ...buildConversation("thread-1", "project-1"),
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
    });
    const {
      LocalConversationProvider,
      useDefaultCodexAppServerManager,
      __resetLocalConversationStoreForTests,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    let manager: {
      requestThreadStreamResume: (threadId: string) => Promise<CodexConversationSnapshot | null>;
      readConversation: (threadId: string) => CodexConversationSnapshot | null;
    } | null = null;
    function Probe() {
      manager = useDefaultCodexAppServerManager();
      return createElement("div");
    }

    render(createElement(LocalConversationProvider, null, createElement(Probe)));
    await settleAsyncRender();
    if (!manager) throw new Error("Expected manager");
    const activeManager = manager as unknown as {
      requestThreadStreamResume: (threadId: string) => Promise<CodexConversationSnapshot | null>;
      readConversation: (threadId: string) => CodexConversationSnapshot | null;
    };
    await act(async () => {
      await activeManager.requestThreadStreamResume("thread-1");
    });
    invokeRecords = [];

    const queueRow = createCodexQueuedFollowUp({
      followUpId: "follow-up-1",
      clientUserMessageId: "client-steer-1",
      threadId: "thread-1",
      prompt: "Inspect the queue owner projection.",
      createdAtMs: 20,
    });
    const projection: CodexQueuedFollowUpProjection = {
      status: "ready",
      ledgerRevision: 4,
      projectionRevision: 5,
      entries: [queueRow],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    };
    const updateParams = {
      threadId: "thread-1",
      threadGeneration: 7,
      ownerEpoch: 1,
      projectionRevision: 5,
      projection,
      transcript: {
        kind: "stageSteer" as const,
        observedAtMs: 20,
        item: {
          type: "steeringUserMessage" as const,
          id: "steer-1",
          targetTurnId: "turn-1",
          targetTurnStartedAtMs: null,
          status: "pending" as const,
          clientUserMessageId: "client-steer-1",
          input: [{ type: "text" as const, text: queueRow.prompt, text_elements: [] }],
          attachments: [],
          restoreMessage: {
            queueRow,
            context: { commentAttachments: [] },
          },
          compareKey: { rawText: queueRow.prompt, imageCount: 0 },
        },
      },
    };

    let releaseQueuePublication = (): void => {};
    const queuePublicationGate = new Promise<void>((resolve) => {
      releaseQueuePublication = resolve;
    });
    ownerStreamPublishHandler = async () => {
      await queuePublicationGate;
      return true;
    };

    await act(async () => {
      rendererClientRequestListener?.({
        requestId: "queue-owner-update-1",
        method: "codex-queue-owner-update",
        params: updateParams,
      });
      await flushAsyncWork();
    });
    await waitForCondition(
      () =>
        invokeRecords.filter(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ).length === 1,
      1_000,
    );
    await act(async () => {
      rendererClientRequestListener?.({
        requestId: "queue-owner-update-idempotent",
        method: "codex-queue-owner-update",
        params: updateParams,
      });
      await flushAsyncWork();
    });
    expect(
      invokeRecords.some((record) => record.channel === "codex:renderer-client:response"),
    ).toBe(false);
    releaseQueuePublication();
    await waitForCondition(
      () =>
        invokeRecords.filter((record) => record.channel === "codex:renderer-client:response")
          .length === 2,
      1_000,
    );
    ownerStreamPublishHandler = null;

    const appliedConversation = activeManager.readConversation("thread-1");
    const appliedResponses = invokeRecords.filter(
      (record) => record.channel === "codex:renderer-client:response",
    );
    expect(appliedResponses.map((record) => record.args[0])).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "success",
          requestId: "queue-owner-update-1",
          result: expect.objectContaining({ kind: "applied", projectionRevision: 5 }),
        }),
        expect.objectContaining({
          type: "success",
          requestId: "queue-owner-update-idempotent",
          result: expect.objectContaining({ kind: "already-applied", projectionRevision: 5 }),
        }),
      ]),
    );
    expect(appliedConversation?.queuedFollowUps).toEqual(projection);
    expect(appliedConversation?.pendingSteers).toEqual([
      {
        steerId: "steer-1",
        threadId: "thread-1",
        turnId: "turn-1",
        prompt: queueRow.prompt,
        createdAt: 20,
      },
    ]);
    expect(
      appliedConversation?.canonicalState?.turns[0]?.items.some(
        (item) => item.type === "steeringUserMessage" && item.id === "steer-1",
      ),
    ).toBe(true);
    expect(
      invokeRecords.filter((record) => record.channel === "codex:thread-owner:stream-state:publish")
        .length,
    ).toBe(1);

    invokeRecords = [];
    await act(async () => {
      rendererClientRequestListener?.({
        requestId: "queue-owner-update-stale",
        method: "codex-queue-owner-update",
        params: {
          ...updateParams,
          projectionRevision: 4,
          projection: { ...projection, projectionRevision: 4 },
        },
      });
      rendererClientRequestListener?.({
        requestId: "queue-owner-update-generation-mismatch",
        method: "codex-queue-owner-update",
        params: {
          ...updateParams,
          threadGeneration: 8,
          projectionRevision: 6,
          projection: { ...projection, projectionRevision: 6 },
        },
      });
      await flushAsyncWork();
    });
    const rejectedResults = invokeRecords
      .filter((record) => record.channel === "codex:renderer-client:response")
      .map((record) => record.args[0]);
    expect(rejectedResults).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          requestId: "queue-owner-update-stale",
          result: {
            kind: "rejected",
            reason: "newer-projection-applied",
            currentProjectionRevision: 5,
          },
        }),
        expect.objectContaining({
          requestId: "queue-owner-update-generation-mismatch",
          result: {
            kind: "rejected",
            reason: "thread-generation-mismatch",
            currentProjectionRevision: 5,
          },
        }),
      ]),
    );
    expect(
      invokeRecords.some((record) => record.channel === "codex:thread-owner:stream-state:publish"),
    ).toBe(false);
    resumeThreadGeneration = 1;
    resumeThreadResult = null;
  });

  test("renderer-local Nodex authorization survives main-owned snapshots until the viewer responds", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const mainOwnedConversation: CodexConversationSnapshot = {
      ...buildConversation("thread-1", "project-1"),
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
    };
    resumeThreadResult = mainOwnedConversation;
    const {
      LocalConversationProvider,
      useDefaultCodexAppServerManager,
      __resetLocalConversationStoreForTests,
    } = await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    let manager: {
      readConversation: (threadId: string) => CodexConversationSnapshot | null;
      respondNodexAgentAuthorization: (
        requestId: string,
        response: { decision: "allow_project" },
        conversationId: string,
      ) => Promise<boolean>;
    } | null = null;
    function Probe() {
      manager = useDefaultCodexAppServerManager();
      return createElement("div");
    }

    render(createElement(LocalConversationProvider, null, createElement(Probe)));
    await settleAsyncRender();
    if (!manager) throw new Error("Expected manager");
    const activeManager = manager as {
      readConversation: (threadId: string) => CodexConversationSnapshot | null;
      respondNodexAgentAuthorization: (
        requestId: string,
        response: { decision: "allow_project" },
        conversationId: string,
      ) => Promise<boolean>;
    };
    dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
      hostId: "default",
      conversationId: "thread-1",
      version: 1,
      change: {
        type: "snapshot",
        revision: 1,
        conversationState: mainOwnedConversation,
      },
      sourceClientId: "test-owner",
    });
    await flushAsyncWork();
    invokeRecords = [];

    await act(async () => {
      rendererClientRequestListener?.({
        requestId: "renderer-auth-1",
        method: "nodex-agent-authorization",
        params: {
          type: "nodexAgentAuthorization",
          requestId: "nodex-auth-1",
          projectId: "project-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-1",
          tool: "update_page",
          effect: "write",
          preview: {
            title: "Append rollout plan",
            summary: "Append four Blocks.",
            details: [],
            markdownPreview: "## Rollout\n\n- Alpha cohort",
          },
          createdAt: 1,
        },
      });
      await flushAsyncWork();
    });

    await waitForCondition(
      () =>
        activeManager
          .readConversation("thread-1")
          ?.requests.some((request) => request.requestId === "nodex-auth-1") === true,
      1_000,
    );

    dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
      hostId: "default",
      conversationId: "thread-1",
      version: 2,
      change: {
        type: "snapshot",
        revision: 2,
        conversationState: {
          ...mainOwnedConversation,
          threadName: "Main-owned update",
        },
      },
      sourceClientId: "test-owner",
    });
    await flushAsyncWork();
    expect(
      activeManager
        .readConversation("thread-1")
        ?.requests.some((request) => request.requestId === "nodex-auth-1"),
    ).toBe(true);
    expect(
      invokeRecords.some((record) => record.channel === "codex:renderer-client:response"),
    ).toBe(false);

    await act(async () => {
      await activeManager.respondNodexAgentAuthorization(
        "nodex-auth-1",
        { decision: "allow_project" },
        "thread-1",
      );
      await flushAsyncWork();
    });

    const responseRecord = invokeRecords.find(
      (record) => record.channel === "codex:renderer-client:response",
    );
    expect(responseRecord?.args[0]).toEqual({
      type: "success",
      requestId: "renderer-auth-1",
      result: { decision: "allow_project" },
    });
    expect(
      activeManager
        .readConversation("thread-1")
        ?.requests.some((request) => request.requestId === "nodex-auth-1"),
    ).toBe(false);

    invokeRecords = [];
    await act(async () => {
      rendererClientRequestListener?.({
        requestId: "renderer-auth-2",
        method: "nodex-agent-authorization",
        params: {
          type: "nodexAgentAuthorization",
          requestId: "nodex-auth-2",
          projectId: "project-1",
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "call-2",
          tool: "create",
          effect: "write",
          preview: {
            title: "Create Card",
            summary: "Create one Card.",
            details: [],
          },
          createdAt: 2,
        },
      });
      await flushAsyncWork();
    });
    await waitForCondition(
      () =>
        activeManager
          .readConversation("thread-1")
          ?.requests.some((request) => request.requestId === "nodex-auth-2") === true,
      1_000,
    );

    dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
      hostId: "default",
      conversationId: "thread-1",
      version: 3,
      change: {
        type: "snapshot",
        revision: 3,
        conversationState: {
          ...mainOwnedConversation,
          turns: [
            {
              ...mainOwnedConversation.turns[0]!,
              status: "interrupted",
            },
          ],
        },
      },
      sourceClientId: "test-owner",
    });
    await waitForCondition(
      () => invokeRecords.some((record) => record.channel === "codex:renderer-client:response"),
      1_000,
    );
    const canceledResponse = invokeRecords.find(
      (record) => record.channel === "codex:renderer-client:response",
    );
    expect(canceledResponse?.args[0]).toEqual({
      type: "success",
      requestId: "renderer-auth-2",
      result: { decision: "deny" },
    });
    resumeThreadResult = null;
  });

  test("owner history-page action publishes one bounded mutation revision", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    historyPageResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const partialConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      };
      const completeConversation: CodexConversationSnapshot = {
        ...partialConversation,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-older",
            status: "completed",
            itemIds: [],
            items: [],
          },
          partialConversation.turns[0]!,
        ],
      };
      const historyFixture = buildExactOlderHistoryPageFixture({
        partial: partialConversation,
        loaded: completeConversation,
      });
      resumeThreadResult = historyFixture.before;
      historyPageResult = historyFixture.page;
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const result = (await manager.handleThreadOwnerActionRequest({
        type: "loadHistoryPage",
        request: historyFixture.request,
      })) as { revision?: number };
      const publishRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const publishPayload = publishRecord?.args[0] as
        | {
            conversationId?: string;
            change?: {
              type?: string;
              revision?: number;
              mutation?: { upsertTurns?: readonly { turnId?: string | null }[] };
            };
          }
        | undefined;

      expect(result.revision).toBe(2);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:history-page:load"),
      ).toBe(true);
      expect(Boolean(publishRecord)).toBe(true);
      expect(publishPayload?.conversationId).toBe("thread-1");
      expect(publishPayload?.change?.type).toBe("historyMutation");
      expect(publishPayload?.change?.revision).toBe(2);
      expect(publishPayload?.change?.mutation?.upsertTurns?.[0]?.turnId).toBe("turn-older");
      expect(manager.readConversation("thread-1")?.turns[0]?.turnId).toBe("turn-older");
    } finally {
      resumeThreadResult = null;
      historyPageResult = null;
      manager.destroy();
    }
  });

  test("owner exact-boundary action loads and publishes exactly one physical page", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const partial = {
        ...buildConversation("thread-page", "project-1"),
        turns: [
          {
            threadId: "thread-page",
            turnId: "turn-latest",
            status: "completed" as const,
            itemIds: [],
            items: [],
          },
        ],
      };
      const loaded: CodexConversationSnapshot = {
        ...partial,
        turns: [
          {
            threadId: "thread-page",
            turnId: "turn-one-page-older",
            status: "completed" as const,
            itemIds: [],
            items: [],
          },
          ...partial.turns,
        ],
      };
      const historyFixture = buildExactOlderHistoryPageFixture({ partial, loaded });
      resumeThreadResult = historyFixture.before;
      historyPageResult = historyFixture.page;
      await manager.requestThreadStreamResume("thread-page");
      invokeRecords = [];

      const result = (await manager.handleThreadOwnerActionRequest({
        type: "loadHistoryPage",
        request: historyFixture.request,
      })) as { revision?: number };

      expect(result.revision).toBe(2);
      expect(
        invokeRecords.filter((record) => record.channel === "codex:thread:history-page:load"),
      ).toHaveLength(1);
      expect(
        invokeRecords.filter(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toHaveLength(1);
      expect(manager.readConversation("thread-page")?.turns[0]?.turnId).toBe("turn-one-page-older");
    } finally {
      resumeThreadResult = null;
      historyPageResult = null;
      manager.destroy();
    }
  });

  test("owner persisted-history hydration publishes one bounded island mutation", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const partial = withCanonicalState({
        ...buildConversation("thread-search", "project-1"),
        conversationEntityGeneration: 1,
        historyTopologyGeneration: 11,
        historyMutationRevision: 0,
        historyRows: [],
        turnPagination: {
          olderCursor: "cursor:tail",
          backwardsCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: false,
          loadedTurnCount: 0,
          itemsView: "full",
        },
        turnItemsPaginationById: {},
      });
      const hydrated = withCanonicalState({
        ...partial,
        historyMutationRevision: 1,
        historyRows: [
          {
            kind: "content",
            key: "history-content:turn-older",
            turnKey: "turn-older",
            entityKey: "turn-older",
          },
        ],
        turns: [
          {
            threadId: "thread-search",
            turnId: "turn-older",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
        turnPagination: {
          ...partial.turnPagination!,
          oldestLoadedTurnId: "turn-older",
          loadedTurnCount: 1,
        },
      });
      const mutation = buildCodexConversationHistoryMutation({
        before: partial,
        after: hydrated,
        origin: {
          kind: "island",
          threadId: "thread-search",
          mutationId: "search:request-1",
          expectedConversationGeneration: 1,
          expectedTopologyGeneration: 11,
        },
      });
      resumeThreadResult = partial;
      persistedHistoryHydrationResult = {
        status: "found",
        threadId: "thread-search",
        turnId: "turn-older",
        itemId: "item-selected",
        topologyGeneration: 11,
        mutation,
      };
      await manager.requestThreadStreamResume("thread-search");
      invokeRecords = [];

      const result = (await manager.handleThreadOwnerActionRequest({
        type: "hydratePersistedHistoryOccurrence",
        input: {
          requestId: "search:request-1",
          threadId: "thread-search",
          hostId: "host-a",
          hostGeneration: 3,
          topologyGeneration: 11,
          occurrence: {
            turnId: "turn-older",
            itemId: "item-selected",
            snippet: "needle",
            snippetMatchRange: { start: 0, end: 6 },
            turnCursor: "cursor-turn-older",
          },
        },
      })) as { revision?: number; hydration?: { topologyGeneration?: number } };

      expect(result).toMatchObject({ revision: 2, hydration: { topologyGeneration: 11 } });
      expect(
        invokeRecords.filter((record) => record.channel === "codex:thread:history-search:hydrate"),
      ).toHaveLength(1);
      const publishes = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      expect(publishes).toHaveLength(1);
      const publication = publishes[0]?.args[0] as
        | {
            change?: {
              type?: string;
              mutation?: { upsertTurns?: readonly { turnId?: string | null }[] };
            };
          }
        | undefined;
      expect(publication?.change?.type).toBe("historyMutation");
      expect(publication?.change?.mutation?.upsertTurns?.[0]?.turnId).toBe("turn-older");
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:history-page:load"),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      persistedHistoryHydrationResult = null;
      manager.destroy();
    }
  });

  test("exact history-page requests return the page result after local mutation publication", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const partial = buildConversation("thread-copy", "project-1");
      const olderTurn = {
        threadId: "thread-copy",
        turnId: "turn-older",
        status: "completed" as const,
        itemIds: [],
        items: [],
      };
      const loaded = {
        ...partial,
        turns: [olderTurn, ...partial.turns],
      };
      const historyFixture = buildExactOlderHistoryPageFixture({ partial, loaded });
      resumeThreadResult = historyFixture.before;
      historyPageResult = historyFixture.page;
      await manager.requestThreadStreamResume("thread-copy");

      const result = await manager.requestHistoryPage(historyFixture.request);

      expect(result.status).toBe("applied");
      expect(manager.readConversation("thread-copy")?.turns[0]?.turnId).toBe("turn-older");
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:history-page:load"),
      ).toBe(true);
    } finally {
      resumeThreadResult = null;
      historyPageResult = null;
      manager.destroy();
    }
  });

  test("follower history loads route one exact target and wait for its published revision", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const partialConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      };
      const nextPageConversation: CodexConversationSnapshot = {
        ...partialConversation,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-older",
            status: "completed",
            itemIds: [],
            items: [],
          },
          partialConversation.turns[0]!,
        ],
      };
      const historyFixture = buildExactOlderHistoryPageFixture({
        partial: partialConversation,
        loaded: nextPageConversation,
      });
      followerActionResult = { revision: 2, page: historyFixture.page };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: historyFixture.before,
        },
        sourceClientId: "owner-a",
      });

      const loadPromise = manager.requestHistoryPage(historyFixture.request);
      await flushAsyncWork();
      const followerRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const followerPayload = followerRecord?.args[0] as
        | {
            action?: {
              type?: string;
              request?: CodexConversationHistoryPageRequest;
            };
          }
        | undefined;
      expect(Boolean(followerRecord)).toBe(true);
      expect(followerPayload?.action?.type).toBe("loadHistoryPage");
      expect(followerPayload?.action?.request).toEqual(historyFixture.request);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:history-page:load"),
      ).toBe(false);

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "historyMutation",
          baseRevision: 1,
          revision: 2,
          mutation: historyFixture.page.mutation,
        },
        sourceClientId: "owner-a",
      });

      const loaded = await loadPromise;
      expect(loaded.status).toBe("applied");
      expect(manager.readConversation("thread-1")?.turns[0]?.turnId).toBe("turn-older");
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower persisted-history hydration routes to its owner and waits for one revision", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    followerActionResult = {
      revision: 2,
      hydration: {
        status: "bounded-incomplete",
        threadId: "thread-search",
        turnId: "turn-older",
        itemId: "item-selected",
        topologyGeneration: 12,
        reason: "next-item-page-required",
      },
    };

    const manager = new CodexAppServerManager("default");
    try {
      const partial = buildConversation("thread-search", "project-1");
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-search",
        version: 1,
        change: { type: "snapshot", revision: 1, conversationState: partial },
        sourceClientId: "owner-a",
      });
      const input = {
        threadId: "thread-search",
        hostId: "host-a",
        hostGeneration: 3,
        topologyGeneration: 11,
        occurrence: {
          turnId: "turn-older",
          itemId: "item-selected",
          snippet: "needle",
          snippetMatchRange: { start: 0, end: 6 },
          turnCursor: "cursor-turn-older",
        },
      } as const;

      const hydration = manager.hydratePersistedHistoryOccurrence(input);
      await flushAsyncWork();
      const followerRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      expect(followerRecord?.args[0]).toMatchObject({
        conversationId: "thread-search",
        action: { type: "hydratePersistedHistoryOccurrence", input },
      });
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:history-search:hydrate"),
      ).toBe(false);

      const hydrated: CodexConversationSnapshot = {
        ...partial,
        historyTopologyGeneration: 12,
        turns: [
          {
            threadId: "thread-search",
            turnId: "turn-older",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-search",
        version: 2,
        change: { type: "snapshot", revision: 2, conversationState: hydrated },
        sourceClientId: "owner-a",
      });

      await expect(hydration).resolves.toMatchObject({
        status: "bounded-incomplete",
        topologyGeneration: 12,
        reason: "next-item-page-required",
      });
      expect(manager.readConversation("thread-search")?.turns[0]?.turnId).toBe("turn-older");
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower edit targets the stable turn identity without loading complete history", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = { streamRevision: 1 };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const partialConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: partialConversation,
        },
        sourceClientId: "owner-a",
      });

      const editPromise = manager.editLastUserTurn(
        "thread-1",
        "turn-older",
        "Rewrite older prompt",
      );
      await flushAsyncWork();

      const followerRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const editPayload = followerRecords[0]?.args[0] as
        | {
            action?: { type?: string; threadId?: string; turnId?: string; message?: string };
          }
        | undefined;
      expect(String(followerRecords.length)).toBe("1");
      expect(editPayload?.action?.type).toBe("editLastUserTurn");
      expect(editPayload?.action?.threadId).toBe("thread-1");
      expect(editPayload?.action?.turnId).toBe("turn-older");
      expect(editPayload?.action?.message).toBe("Rewrite older prompt");
      await editPromise;
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:edit-last-user-turn"),
      ).toBe(false);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower edit waits for owner replacement start revision before resolving", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = {
      revision: 2,
      threadId: "thread-1",
      composerIntent: { prompt: "Rewrite latest prompt", focusNonce: 1 },
      streamRevision: 3,
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    let resolved = false;
    try {
      const partialConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: ["user-latest"],
            items: [buildUserMessage("thread-1", "turn-latest", "user-latest", "Latest prompt")],
          },
        ],
      };
      const rollbackConversation: CodexConversationSnapshot = {
        ...partialConversation,
        turns: [],
      };
      const replacementConversation: CodexConversationSnapshot = {
        ...partialConversation,
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-replacement",
            status: "inProgress",
            itemIds: ["user-replacement"],
            items: [
              buildUserMessage(
                "thread-1",
                "turn-replacement",
                "user-replacement",
                "Rewrite latest prompt",
              ),
            ],
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: rollbackConversation,
        },
        sourceClientId: "owner-a",
      });

      const editPromise = manager
        .editLastUserTurn("thread-1", "turn-latest", "Rewrite latest prompt")
        .then(() => {
          resolved = true;
        });
      await flushAsyncWork();

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "snapshot",
          revision: 2,
          conversationState: partialConversation,
        },
        sourceClientId: "owner-a",
      });
      await flushAsyncWork();
      expect(resolved).toBe(false);

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 3,
        change: {
          type: "snapshot",
          revision: 3,
          conversationState: replacementConversation,
        },
        sourceClientId: "owner-a",
      });
      await editPromise;
      expect(resolved).toBe(true);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower fork targets the stable turn identity without loading complete history", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = { revision: 2 };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const partialConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: partialConversation,
        },
        sourceClientId: "owner-a",
      });

      const forkPromise = manager.forkConversationFromTurn(
        "thread-1",
        "turn-older",
        "Continue from older turn",
      );
      await flushAsyncWork();

      const followerRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const forkPayload = followerRecords[0]?.args[0] as
        | {
            action?: { type?: string; threadId?: string; turnId?: string; message?: string };
          }
        | undefined;
      expect(String(followerRecords.length)).toBe("1");
      await forkPromise;
      expect(forkPayload?.action?.type).toBe("forkConversationFromTurn");
      expect(forkPayload?.action?.threadId).toBe("thread-1");
      expect(forkPayload?.action?.turnId).toBe("turn-older");
      expect(forkPayload?.action?.message).toBe("Continue from older turn");
      expect(invokeRecords.some((record) => record.channel === "codex:thread:fork-from-turn")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("local fork without a stream role resumes owner before using the owner app-server facade", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      resumeThreadResult = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-older",
            status: "completed",
            itemIds: [],
            items: [],
          },
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      };

      const result = await manager.forkConversationFromTurn(
        "thread-1",
        "turn-older",
        "Continue from older turn",
      );

      const resumeIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:resume:request",
      );
      const forkIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "thread/fork",
      );
      const forkInput = invokeRecords[forkIndex]?.args[0] as
        | {
            conversationId?: string;
            request?: {
              params?: {
                threadId?: string;
                turnId?: string;
                message?: string;
              };
            };
          }
        | undefined;

      expect(resumeIndex >= 0).toBe(true);
      expect(forkIndex > resumeIndex).toBe(true);
      expect(forkInput?.conversationId).toBe("thread-1");
      expect(forkInput?.request?.params?.threadId).toBe("thread-1");
      expect(forkInput?.request?.params?.turnId).toBe("turn-older");
      expect(forkInput?.request?.params?.message).toBe("Continue from older turn");
      expect(result.threadId).toBe("thread-forked");
      expect(Boolean(result.composerIntent)).toBe(true);
      expect(result.composerIntent?.prompt).toBe("Continue from older turn");
      expect(invokeRecords.some((record) => record.channel === "codex:thread:fork-from-turn")).toBe(
        false,
      );
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-follower:action"),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower thread goal set routes through owner action from bundle 64259-64271", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = {
      threadId: "thread-1",
      objective: "ship parity",
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      const goal = await manager.setThreadGoal({
        threadId: "thread-1",
        objective: "ship parity",
      });
      const followerRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const followerInput = followerRecord?.args[0] as
        | {
            conversationId?: string;
            action?: { type?: string; threadId?: string; objective?: string; status?: string };
          }
        | undefined;

      expect(goal?.status ?? "").toBe("active");
      expect(followerInput?.conversationId).toBe("thread-1");
      expect(followerInput?.action?.type).toBe("setThreadGoal");
      expect(followerInput?.action?.objective).toBe("ship parity");
      expect(followerInput?.action?.status).toBe("active");
      expect(invokeRecords.some((record) => record.channel === "codex:thread:goal:set")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("no-role thread goal status updates adopt an owner and use protocol-shaped params", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    resumeThreadResult = buildConversation("thread-standalone", "project-1");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.setThreadGoal({
        threadId: "thread-standalone",
        status: "paused",
      });
      const goalRecord = invokeRecords.find(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method ===
            "thread/goal/set",
      );
      const params = (
        goalRecord?.args[0] as
          | {
              request?: { params?: { threadId?: string; objective?: unknown; status?: unknown } };
            }
          | undefined
      )?.request?.params;

      expect(params?.threadId).toBe("thread-standalone");
      expect(params?.status).toBe("paused");
      expect(Object.prototype.hasOwnProperty.call(params ?? {}, "objective")).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:request")).toBe(
        true,
      );
      expect(invokeRecords.some((record) => record.channel === "codex:thread:goal:set")).toBe(
        false,
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner thread goal status updates preserve status-only app-server request params", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    resumeThreadResult = buildConversation("thread-1", "project-1");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const goal = await manager.setThreadGoal({
        threadId: "thread-1",
        status: "paused",
      });
      const ownerRecord = invokeRecords.find(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method ===
            "thread/goal/set",
      );
      const ownerInput = ownerRecord?.args[0] as
        | {
            request?: { params?: { threadId?: string; objective?: unknown; status?: unknown } };
          }
        | undefined;
      const params = ownerInput?.request?.params;

      expect(goal?.status ?? "").toBe("paused");
      expect(manager.readConversation("thread-1")?.threadGoal?.status ?? "").toBe("paused");
      expect(
        manager.readConversation("thread-1")?.canonicalState?.sidecar.threadGoal?.status ?? "",
      ).toBe("paused");
      expect(params?.threadId).toBe("thread-1");
      expect(params?.status).toBe("paused");
      expect(Object.prototype.hasOwnProperty.call(params ?? {}, "objective")).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:thread:goal:set")).toBe(
        false,
      );
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-follower:action"),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner thread goal objective sets append a visible goal transcript turn by default", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    resumeThreadResult = buildConversation("thread-1", "project-1");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      await manager.setThreadGoal({
        threadId: "thread-1",
        objective: "ship parity",
      });
      await manager.setThreadGoal({
        threadId: "thread-1",
        objective: "ship parity",
      });

      const conversation = manager.readConversation("thread-1");
      const turn = conversation?.turns[0];
      const item = turn?.items[0];

      expect(conversation?.turns.length ?? 0).toBe(1);
      expect((turn as { turnId?: string | null } | undefined)?.turnId ?? null).toBe(null);
      expect(turn?.status ?? "").toBe("completed");
      expect(turn?.turnStartedAtMs ?? 0).toBe(1_000);
      expect(item?.kind ?? "").toBe("userMessage");
      expect(item?.itemId ?? "").toBe("turn-index-0:input");
      expect(item?.markdownText ?? "").toBe("ship parity");
      expect(item?.goal ?? false).toBe(true);
      expect(item?.rawItem ?? null).toBe(null);
      expect(String(conversation?.canonicalState?.turns[0]?.items.length ?? -1)).toBe("0");
      const rawInput = conversation?.canonicalState?.turns[0]?.sidecar.params.input[0];
      expect(rawInput?.type).toBe("text");
      expect(rawInput?.type === "text" ? rawInput.text : "").toBe("/goal ship parity");
      expect(manager.readConversation("thread-1")?.threadGoal?.status ?? "").toBe("active");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner thread goal set applies settings before goal and strips local action metadata", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    resumeThreadResult = buildConversation("thread-1", "project-1");
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const goal = await manager.setThreadGoal({
        threadId: "thread-1",
        objective: "ship parity",
        appendTranscriptItem: false,
        threadSettings: {
          model: "gpt-5.9-codex",
          reasoningEffort: "high",
          collaborationMode: "plan",
        },
      });
      const ownerRequests = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:app-server-request")
        .map(
          (record) =>
            record.args[0] as {
              request?: {
                method?: string;
                params?: {
                  threadId?: string;
                  patch?: { model?: string; reasoningEffort?: string; collaborationMode?: string };
                  objective?: string;
                  status?: string;
                  appendTranscriptItem?: unknown;
                  threadSettings?: unknown;
                };
              };
            },
        );
      const settingsRequest = ownerRequests[0]?.request;
      const goalRequest = ownerRequests[1]?.request;
      const goalParams = goalRequest?.params;

      expect(goal?.status ?? "").toBe("active");
      expect(settingsRequest?.method).toBe("thread/settings/update");
      expect(settingsRequest?.params?.threadId).toBe("thread-1");
      expect(settingsRequest?.params?.patch?.model).toBe("gpt-5.9-codex");
      expect(settingsRequest?.params?.patch?.reasoningEffort).toBe("high");
      expect(settingsRequest?.params?.patch?.collaborationMode).toBe("plan");
      expect(goalRequest?.method).toBe("thread/goal/set");
      expect(goalParams?.threadId).toBe("thread-1");
      expect(goalParams?.objective).toBe("ship parity");
      expect(goalParams?.status).toBe("active");
      expect(Object.prototype.hasOwnProperty.call(goalParams ?? {}, "appendTranscriptItem")).toBe(
        false,
      );
      expect(Object.prototype.hasOwnProperty.call(goalParams ?? {}, "threadSettings")).toBe(false);
      expect(manager.readConversation("thread-1")?.turns.length ?? 0).toBe(0);
      expect(
        manager.readConversation("thread-1")?.canonicalState?.sidecar.latestThreadSettings?.model ??
          "",
      ).toBe("gpt-5.3-codex");
      expect(
        manager.readConversation("thread-1")?.canonicalState?.sidecar.threadGoal?.objective ?? "",
      ).toBe("ship parity");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower thread goal status updates preserve status-only owner action params", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = {
      threadId: "thread-1",
      objective: "ship parity",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 50,
      timeUsedSeconds: 5,
      createdAt: 1,
      updatedAt: 2,
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      const goal = await manager.setThreadGoal({
        threadId: "thread-1",
        status: "paused",
      });
      const followerRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const followerInput = followerRecord?.args[0] as
        | {
            conversationId?: string;
            action?: { type?: string; threadId?: string; objective?: unknown; status?: string };
          }
        | undefined;

      expect(goal?.status ?? "").toBe("paused");
      expect(followerInput?.conversationId).toBe("thread-1");
      expect(followerInput?.action?.type).toBe("setThreadGoal");
      expect(followerInput?.action?.status).toBe("paused");
      expect(Object.prototype.hasOwnProperty.call(followerInput?.action ?? {}, "objective")).toBe(
        false,
      );
      expect(invokeRecords.some((record) => record.channel === "codex:thread:goal:set")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower thread goal set preserves local action metadata for the owner", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = {
      threadId: "thread-1",
      objective: "ship parity",
      status: "active",
      tokenBudget: null,
      tokensUsed: 50,
      timeUsedSeconds: 5,
      createdAt: 1,
      updatedAt: 2,
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      await manager.setThreadGoal({
        threadId: "thread-1",
        objective: "ship parity",
        appendTranscriptItem: false,
        threadSettings: {
          model: "gpt-5.9-codex",
          reasoningEffort: "high",
          collaborationMode: "plan",
        },
      });
      const followerRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const followerInput = followerRecord?.args[0] as
        | {
            action?: {
              appendTranscriptItem?: boolean;
              threadSettings?: {
                model?: string;
                reasoningEffort?: string;
                collaborationMode?: string;
              };
            };
          }
        | undefined;

      expect(followerInput?.action?.appendTranscriptItem).toBe(false);
      expect(followerInput?.action?.threadSettings?.model).toBe("gpt-5.9-codex");
      expect(followerInput?.action?.threadSettings?.reasoningEffort).toBe("high");
      expect(followerInput?.action?.threadSettings?.collaborationMode).toBe("plan");
      expect(invokeRecords.some((record) => record.channel === "codex:thread:goal:set")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("owner thread goal resume confirmation dismiss clears prompt without clearing goal", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    const goal: ThreadGoal = {
      threadId: "thread-1",
      objective: "ship parity",
      status: "paused",
      tokenBudget: null,
      tokensUsed: 50,
      timeUsedSeconds: 5,
      createdAt: 1,
      updatedAt: 2,
    };
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      threadGoal: goal,
      threadGoalResumeConfirmation: goal,
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      expect(manager.getThreadRoleForRendererClientRequest("thread-1")).toBe("owner");

      await manager.dismissThreadGoalResumeConfirmation("thread-1");

      expect(manager.readConversation("thread-1")?.threadGoal?.status ?? "").toBe("paused");
      expect(manager.readConversation("thread-1")?.threadGoalResumeConfirmation ?? null).toBe(null);
      expect(
        manager.readConversation("thread-1")?.canonicalState?.sidecar.threadGoal?.status ?? "",
      ).toBe("paused");
      expect(
        manager.readConversation("thread-1")?.canonicalState?.sidecar
          .threadGoalResumeConfirmation ?? null,
      ).toBe(null);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:stream-state:publish",
        ),
      ).toBe(true);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread-owner:app-server-request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method ===
              "thread/goal/clear",
        ),
      ).toBe(false);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread-owner:app-server-request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method ===
              "thread/goal/set",
        ),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower thread goal resume confirmation dismiss routes through owner action", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    const goal: ThreadGoal = {
      threadId: "thread-1",
      objective: "ship parity",
      status: "blocked",
      tokenBudget: null,
      tokensUsed: 50,
      timeUsedSeconds: 5,
      createdAt: 1,
      updatedAt: 2,
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            ...buildConversation("thread-1", "project-1"),
            threadGoal: goal,
            threadGoalResumeConfirmation: goal,
          },
        },
        sourceClientId: "owner-a",
      });

      await manager.dismissThreadGoalResumeConfirmation("thread-1");
      const followerRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const followerInput = followerRecord?.args[0] as
        | {
            conversationId?: string;
            action?: { type?: string; threadId?: string };
          }
        | undefined;

      expect(followerInput?.conversationId).toBe("thread-1");
      expect(followerInput?.action?.type).toBe("dismissThreadGoalResumeConfirmation");
      expect(followerInput?.action?.threadId).toBe("thread-1");
      expect(invokeRecords.some((record) => record.channel === "codex:thread:goal:clear")).toBe(
        false,
      );
      expect(invokeRecords.some((record) => record.channel === "codex:thread:goal:set")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower thread goal clear routes through owner action from bundle 64259-64271", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      await manager.clearThreadGoal("thread-1");
      const followerRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const followerInput = followerRecord?.args[0] as
        | {
            conversationId?: string;
            action?: { type?: string; threadId?: string };
          }
        | undefined;

      expect(followerInput?.conversationId).toBe("thread-1");
      expect(followerInput?.action?.type).toBe("clearThreadGoal");
      expect(invokeRecords.some((record) => record.channel === "codex:thread:goal:clear")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower thread memory mode set routes through owner action from bundle 64259-64271", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      await manager.setThreadMemoryMode({
        threadId: "thread-1",
        mode: "enabled",
      });
      const followerRecord = invokeRecords.find(
        (record) => record.channel === "codex:thread-follower:action",
      );
      const followerInput = followerRecord?.args[0] as
        | {
            conversationId?: string;
            action?: { type?: string; threadId?: string; mode?: string };
          }
        | undefined;

      expect(followerInput?.conversationId).toBe("thread-1");
      expect(followerInput?.action?.type).toBe("setThreadMemoryMode");
      expect(followerInput?.action?.mode).toBe("enabled");
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:memory-mode:set"),
      ).toBe(false);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower background-terminal cleanup is rejected from bundle 50754-50825", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      let message = "";
      try {
        await manager.cleanBackgroundTerminals("thread-1");
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe("Please continue this conversation on the window where it was started.");
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread:background-terminals:clean",
        ),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-follower:action"),
      ).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("owner background-terminal cleanup publishes its canonical cleanup", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-background",
          status: "completed",
          itemIds: ["cmd-1"],
          items: [buildCommandExecutionItem("thread-1", "turn-background", "cmd-1")],
        },
        {
          threadId: "thread-1",
          turnId: "turn-latest",
          status: "completed",
          itemIds: [],
          items: [],
        },
      ],
      backgroundTerminalRows: [
        {
          id: "cmd-1",
          turnId: "turn-older",
          command: "bun test",
          cwd: null,
          processId: null,
          previewLine: null,
        },
      ],
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      const publishCountBefore = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      ).length;
      await manager.cleanBackgroundTerminals("thread-1");

      const conversation = manager.readConversation("thread-1");
      const publishCountAfter = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      ).length;
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread:background-terminals:clean-silent",
        ),
      ).toBe(true);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread:background-terminals:clean",
        ),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-follower:action"),
      ).toBe(false);
      expect(publishCountAfter).toBe(publishCountBefore + 1);
      expect(conversation?.backgroundTerminalRows.length ?? -1).toBe(0);
      expect(conversation?.turns[0]?.interruptedCommandExecutionItemIds?.[0]).toBe("cmd-1");
      expect(
        conversation?.canonicalState?.turns[0]?.sidecar.interruptedCommandExecutionItemIds?.[0],
      ).toBe("cmd-1");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("local edit without a stream role resumes owner before using the owner app-server facade", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerEditRollbackResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const olderUser = buildUserMessage("thread-1", "turn-older", "user-older", "Older prompt");
      const rollbackSpecialItems: CodexConversationItem[] = [
        {
          ...olderUser,
          itemId: "hook-feedback",
          entryId: "hook-feedback",
          type: "hookPrompt",
          kind: "userMessage",
          semanticKind: "userMessage",
          markdownText: "Please include the boundary case.",
          hookFeedback: true,
          rawItem: {
            id: "hook-feedback",
            type: "hookPrompt",
            fragments: [{ text: "Please include the boundary case.", hookRunId: "hook-run" }],
          },
        },
        ...["one", "two"].map((name): CodexConversationItem => ({
          ...olderUser,
          itemId: `image-${name}`,
          entryId: `image-${name}`,
          type: "imageView",
          kind: "systemEvent",
          semanticKind: "imageView",
          markdownText: undefined,
          rawItem: { id: `image-${name}`, type: "imageView", path: `/tmp/${name}.png` },
        })),
        {
          ...olderUser,
          itemId: "sleep-between-images",
          entryId: "sleep-between-images",
          type: "sleep",
          kind: "systemEvent",
          semanticKind: "systemEvent",
          markdownText: undefined,
          rawItem: { id: "sleep-between-images", type: "sleep", durationMs: 1 },
        },
        {
          ...olderUser,
          itemId: "image-three",
          entryId: "image-three",
          type: "imageView",
          kind: "systemEvent",
          semanticKind: "imageView",
          markdownText: undefined,
          rawItem: { id: "image-three", type: "imageView", path: "/tmp/three.png" },
        },
        {
          ...olderUser,
          itemId: "generated-image",
          entryId: "generated-image",
          type: "imageGeneration",
          kind: "systemEvent",
          semanticKind: "generatedImage",
          markdownText: undefined,
          rawItem: {
            id: "generated-image",
            type: "imageGeneration",
            status: "completed",
            revisedPrompt: null,
            result: "aW1hZ2U=",
          },
        },
      ];
      const latestUser = buildUserMessage(
        "thread-1",
        "turn-latest",
        "user-latest",
        "Latest prompt",
      );
      const currentConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-older",
            status: "completed",
            itemIds: ["user-older", ...rollbackSpecialItems.map((item) => item.itemId)],
            items: [olderUser, ...rollbackSpecialItems],
          },
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: ["user-latest"],
            items: [latestUser],
          },
        ],
      };
      const rollbackConversation: CodexConversationSnapshot = {
        ...currentConversation,
        turns: [currentConversation.turns[0]!],
      };
      resumeThreadResult = currentConversation;
      ownerEditRollbackResult = buildRollbackResponseFromConversation(rollbackConversation);

      const result = await manager.editLastUserTurn(
        "thread-1",
        "turn-latest",
        "Rewrite latest prompt",
      );

      const resumeIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:resume:request",
      );
      const rollbackIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "thread/revert",
      );
      const startIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "turn/start",
      );
      const publishInputs = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:stream-state:publish")
        .map(
          (record) =>
            record.args[0] as {
              change?: {
                type?: string;
                revision?: number;
                conversationState?: CodexConversationSnapshot;
              };
            },
        );

      expect(resumeIndex >= 0).toBe(true);
      expect(rollbackIndex > resumeIndex).toBe(true);
      expect(startIndex > rollbackIndex).toBe(true);
      expect(String(publishInputs.length)).toBe("4");
      expect(publishInputs[0]?.change?.revision).toBe(1);
      expect(publishInputs[1]?.change?.revision).toBe(2);
      expect(publishInputs[2]?.change?.revision).toBe(3);
      expect(publishInputs[3]?.change?.revision).toBe(4);
      const rollbackItems = publishInputs[1]?.change?.conversationState?.turns[0]?.items ?? [];
      expect(rollbackItems.find((item) => item.itemId === "hook-feedback")?.hookFeedback).toBe(
        true,
      );
      expect(
        rollbackItems
          .filter((item) => item.semanticKind === "imageView")
          .map((item) => item.imageViewPaths),
      ).toEqual([["/tmp/one.png", "/tmp/two.png"], ["/tmp/three.png"]]);
      expect(
        rollbackItems.find((item) => item.itemId === "generated-image")?.generatedImage?.src,
      ).toBe("data:image/png;base64,aW1hZ2U=");
      expect(result.streamRevision).toBe(4);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:edit-last-user-turn"),
      ).toBe(false);
      expect(manager.readConversation("thread-1")?.turns.at(-1)?.items[0]?.markdownText).toBe(
        "Rewrite latest prompt",
      );
    } finally {
      resumeThreadResult = null;
      ownerEditRollbackResult = null;
      manager.destroy();
    }
  });

  test("source-null edit resumes owner before rollback instead of routing as follower", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerEditRollbackResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const olderUser = buildUserMessage("thread-1", "turn-older", "user-older", "Older prompt");
      const latestUser = buildUserMessage(
        "thread-1",
        "turn-latest",
        "user-latest",
        "Latest prompt",
      );
      const currentConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-older",
            status: "completed",
            itemIds: ["user-older"],
            items: [olderUser],
          },
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: ["user-latest"],
            items: [latestUser],
          },
        ],
      };
      const rollbackConversation: CodexConversationSnapshot = {
        ...currentConversation,
        turns: [currentConversation.turns[0]!],
      };
      resumeThreadResult = currentConversation;
      ownerEditRollbackResult = buildRollbackResponseFromConversation(rollbackConversation);

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: currentConversation,
        },
        sourceClientId: null,
      });
      invokeRecords = [];

      const result = await manager.editLastUserTurn(
        "thread-1",
        "turn-latest",
        "Rewrite latest prompt",
      );

      const resumeIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:resume:request",
      );
      const rollbackIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "thread/revert",
      );
      const startIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "turn/start",
      );
      const publishInputs = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:stream-state:publish")
        .map((record) => record.args[0] as { change?: { revision?: number } });

      expect(
        invokeRecords.some((record) => record.channel === "codex:thread-follower:action"),
      ).toBe(false);
      expect(resumeIndex >= 0).toBe(true);
      expect(rollbackIndex > resumeIndex).toBe(true);
      expect(startIndex > rollbackIndex).toBe(true);
      expect(publishInputs[0]?.change?.revision).toBe(1);
      expect(publishInputs.at(-1)?.change?.revision).toBe(4);
      expect(result.streamRevision).toBe(4);
      expect(manager.getThreadRoleForRendererClientRequest("thread-1")).toBe("owner");
      expect(manager.readConversation("thread-1")?.turns.at(-1)?.items[0]?.markdownText).toBe(
        "Rewrite latest prompt",
      );
    } finally {
      resumeThreadResult = null;
      ownerEditRollbackResult = null;
      manager.destroy();
    }
  });

  test("owner edit rolls back through owner snapshot before starting replacement turn", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerEditRollbackResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const olderUser = buildUserMessage("thread-1", "turn-older", "user-older", "Older prompt");
      const latestUser = buildUserMessage(
        "thread-1",
        "turn-latest",
        "user-latest",
        "Latest prompt",
      );
      const currentConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-older",
            status: "completed",
            itemIds: ["user-older"],
            items: [olderUser],
          },
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: ["user-latest"],
            items: [latestUser],
          },
        ],
      };
      const rollbackConversation: CodexConversationSnapshot = {
        ...currentConversation,
        turns: [currentConversation.turns[0]!],
      };
      resumeThreadResult = currentConversation;
      ownerEditRollbackResult = buildRollbackResponseFromConversation(rollbackConversation);

      await manager.requestThreadStreamResume("thread-1");
      const beforeEdit = manager.readConversation("thread-1");
      if (!beforeEdit) throw new Error("Expected owner conversation before edit");
      invokeRecords = [];

      const result = await manager.editLastUserTurn(
        "thread-1",
        "turn-latest",
        "Rewrite latest prompt",
      );

      const rollbackIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "thread/revert",
      );
      const publishIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread-owner:stream-state:publish",
      );
      const startIndex = invokeRecords.findIndex(
        (record) =>
          record.channel === "codex:thread-owner:app-server-request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "turn/start",
      );
      const publishInputs = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:stream-state:publish")
        .map(
          (record) =>
            record.args[0] as {
              change?: {
                type?: string;
                revision?: number;
                patches?: CodexConversationStateUpdate[];
                conversationState?: CodexConversationSnapshot;
              };
            },
        );
      const publishInput = publishInputs[0];
      const optimisticPublishInput = publishInputs[1];
      const rebindPublishInput = publishInputs[2];
      const rolledBack = publishInput?.change?.conversationState ?? beforeEdit;
      const optimistic = applyCodexConversationStateUpdates(
        rolledBack,
        optimisticPublishInput?.change?.patches ?? [],
      );
      const rebound = applyCodexConversationStateUpdates(
        optimistic,
        rebindPublishInput?.change?.patches ?? [],
      );
      const replacementTurn = optimistic.turns.at(-1);
      const replacementUser = replacementTurn?.items[0];
      const optimisticPublishRecordIndex = invokeRecords.findIndex(
        (record) => record.args[0] === optimisticPublishInput,
      );
      const rebindPublishRecordIndex = invokeRecords.findIndex(
        (record) => record.args[0] === rebindPublishInput,
      );
      const firstPublishRecordIndex = invokeRecords.findIndex(
        (record) => record.args[0] === publishInput,
      );
      const publishInputForType = publishInput as
        | {
            change?: {
              type?: string;
              revision?: number;
              conversationState?: CodexConversationSnapshot;
            };
          }
        | undefined;
      expect(rollbackIndex >= 0).toBe(true);
      expect(publishIndex > rollbackIndex).toBe(true);
      expect(optimisticPublishRecordIndex > firstPublishRecordIndex).toBe(true);
      expect(startIndex > optimisticPublishRecordIndex).toBe(true);
      expect(rebindPublishRecordIndex > startIndex).toBe(true);
      expect(result.streamRevision).toBe(4);
      expect(publishInputForType?.change?.type).toBe("snapshot");
      expect(publishInputForType?.change?.revision).toBe(2);
      expect(rolledBack.turns).toHaveLength(1);
      expect(rolledBack.canonicalState?.turns).toHaveLength(1);
      expect(
        rolledBack.canonicalState?.turns.some((turn) => turn.protocol.id === "turn-latest"),
      ).toBe(false);
      expect(optimisticPublishInput?.change?.type).toBe("patches");
      expect(optimisticPublishInput?.change?.revision).toBe(3);
      expect(optimistic.turns).toHaveLength(2);
      expect(rebindPublishInput?.change?.revision).toBe(4);
      expect(rebound.turns.at(-1)?.turnId).toBe("turn-owner-start");
      expect(replacementUser?.markdownText).toBe("Rewrite latest prompt");
      expect(manager.readConversation("thread-1")?.turns.length ?? -1).toBe(2);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:edit-last-user-turn"),
      ).toBe(false);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread-owner:edit-last-user-turn:rollback",
        ),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      ownerEditRollbackResult = null;
      manager.destroy();
    }
  });

  test("owner edit commits removal of the original user message before starting its replacement", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerEditRollbackResult = null;
    ownerTurnStartHandler = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const olderUser = buildUserMessage("thread-1", "turn-older", "user-older", "Older prompt");
      const latestUser = buildUserMessage(
        "thread-1",
        "turn-latest",
        "user-latest",
        "Latest prompt",
      );
      const currentConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-older",
            status: "completed",
            itemIds: ["user-older"],
            items: [olderUser],
          },
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: ["user-latest"],
            items: [latestUser],
          },
        ],
      };
      ownerEditRollbackResult = buildRollbackResponseFromConversation({
        ...currentConversation,
        turns: [currentConversation.turns[0]!],
      });
      resumeThreadResult = currentConversation;
      await manager.requestThreadStreamResume("thread-1");

      const committedMessages: string[][] = [];
      const view = render(
        createElement(ConversationUserMessages, {
          manager,
          threadId: "thread-1",
          onCommit: (messages) => committedMessages.push(messages),
        }),
      );
      expect(view.queryByText("Latest prompt")).not.toBeNull();
      committedMessages.length = 0;

      ownerTurnStartHandler = () => {
        expect(view.queryByText("Latest prompt")).toBeNull();
        expect(
          committedMessages.some(
            (messages) => messages.length === 1 && messages[0] === "Older prompt",
          ),
        ).toBe(true);
      };
      await act(async () => {
        await manager.editLastUserTurn("thread-1", "turn-latest", "Rewrite latest prompt");
      });

      expect(view.queryByText("Latest prompt")).toBeNull();
      expect(view.queryByText("Rewrite latest prompt")).not.toBeNull();
    } finally {
      ownerTurnStartHandler = null;
      resumeThreadResult = null;
      ownerEditRollbackResult = null;
      manager.destroy();
    }
  });

  test("owner edit revalidates the latest turn after pending stream publishes settle", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    ownerEditRollbackResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const latestUser = buildUserMessage(
        "thread-1",
        "turn-latest",
        "user-latest",
        "Latest prompt",
      );
      const currentConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-latest",
            status: "completed",
            itemIds: ["user-latest"],
            items: [latestUser],
          },
        ],
      };
      ownerEditRollbackResult = buildRollbackResponseFromConversation({
        ...currentConversation,
        turns: [],
      });
      resumeThreadResult = currentConversation;
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const editPromise = manager.editLastUserTurn(
        "thread-1",
        "turn-latest",
        "Rewrite latest prompt",
      );
      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "turn/started",
          params: {
            threadId: "thread-1",
            turn: buildProtocolTurn({
              id: "turn-new",
              status: "inProgress",
            }),
          },
        },
      });

      await expect(editPromise).rejects.toThrow(
        "Only the latest completed user turn can be edited",
      );
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:owner-app-server:request" &&
            (record.args[0] as { request?: { method?: string } })?.request?.method ===
              "thread/revert",
        ),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      ownerEditRollbackResult = null;
      manager.destroy();
    }
  });

  test("owner plan implementation removal remains in follower stream before subsequent prose patch", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const browserWindow = globalThis.window as
      | (Window & {
          requestAnimationFrame?: Window["requestAnimationFrame"];
          cancelAnimationFrame?: Window["cancelAnimationFrame"];
        })
      | undefined;
    const previousRequestAnimationFrame = browserWindow?.requestAnimationFrame;
    const previousCancelAnimationFrame = browserWindow?.cancelAnimationFrame;
    const previousVisibilityDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "visibilityState",
    );
    const animationFrameCallbacks: FrameRequestCallback[] = [];
    if (browserWindow) {
      browserWindow.requestAnimationFrame = ((callback: FrameRequestCallback) => {
        animationFrameCallbacks.push(callback);
        return animationFrameCallbacks.length;
      }) as Window["requestAnimationFrame"];
      browserWindow.cancelAnimationFrame = (() => {}) as Window["cancelAnimationFrame"];
    }
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });

    const manager = new CodexAppServerManager("default");
    try {
      resumeThreadResult = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-plan",
            status: "completed",
            itemIds: ["implement-plan:turn-plan"],
            items: [
              {
                threadId: "thread-1",
                turnId: "turn-plan",
                itemId: "implement-plan:turn-plan",
                type: "planImplementation",
                kind: "planImplementation",
                semanticKind: "planImplementation",
                status: "inProgress",
                markdownText: "1. Ship the fix",
                rawItem: {
                  id: "implement-plan:turn-plan",
                  type: "planImplementation",
                  turnId: "turn-plan",
                  planContent: "1. Ship the fix",
                  isCompleted: false,
                },
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
          {
            threadId: "thread-1",
            turnId: "turn-active",
            status: "inProgress",
            itemIds: ["assistant-active"],
            items: [
              {
                ...buildAssistantMessage("thread-1", "turn-active", "assistant-active", ""),
                status: "inProgress",
              },
            ],
          },
        ],
        requests: [
          {
            type: "implementPlan",
            requestId: "implement-plan:turn-plan",
            projectId: "project-1",
            threadId: "thread-1",
            turnId: "turn-plan",
            itemId: "implement-plan:turn-plan",
            planContent: "1. Ship the fix",
            createdAt: 1,
          },
        ],
      };
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const removalResult = (await manager.handleThreadOwnerActionRequest({
        type: "removePlanImplementationRequest",
        threadId: "thread-1",
        turnId: "turn-plan",
      })) as { accepted?: boolean; streamRevision?: number } | null;

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 7,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-active",
            itemId: "assistant-active",
            delta: "after removal",
          },
        },
      });
      animationFrameCallbacks.shift()?.(16);
      await flushAsyncWork(2);

      const publishInputs = invokeRecords
        .filter((record) => record.channel === "codex:thread-owner:stream-state:publish")
        .map(
          (record) =>
            record.args[0] as {
              ownerNotificationSequence?: number;
              change?: { type?: string; baseRevision?: number; revision?: number };
            },
        );
      const removalPublish = publishInputs[0];
      const prosePublish = publishInputs[1];
      const conversation = manager.readConversation("thread-1");
      const planItem = conversation?.turns[0]?.items[0];
      const assistantItem = conversation?.turns[1]?.items[0];

      expect(removalResult?.accepted).toBe(true);
      expect(removalResult?.streamRevision).toBe(2);
      expect(removalPublish?.change?.type).toBe("patches");
      expect(removalPublish?.change?.revision).toBe(2);
      expect(prosePublish?.ownerNotificationSequence).toBe(7);
      expect(prosePublish?.change?.type).toBe("patches");
      expect(prosePublish?.change?.baseRevision).toBe(2);
      expect(prosePublish?.change?.revision).toBe(3);
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(planItem?.status).toBe("completed");
      expect(assistantItem?.markdownText).toBe("after removal");
    } finally {
      if (browserWindow) {
        if (previousRequestAnimationFrame) {
          browserWindow.requestAnimationFrame = previousRequestAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "requestAnimationFrame");
        }
        if (previousCancelAnimationFrame) {
          browserWindow.cancelAnimationFrame = previousCancelAnimationFrame;
        } else {
          Reflect.deleteProperty(browserWindow, "cancelAnimationFrame");
        }
      }
      if (previousVisibilityDescriptor) {
        Object.defineProperty(document, "visibilityState", previousVisibilityDescriptor);
      }
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner item lifecycle accepts a pending steering row and inserts the exact completion marker", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const syntheticUser = buildUserMessage("thread-1", "turn-new", "item-1", "Changed prompt");
      const hydratedConversation = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-new",
            status: "inProgress",
            itemIds: ["item-1"],
            items: [syntheticUser],
          },
        ],
      });
      const canonicalTurn = hydratedConversation.canonicalState?.turns[0];
      if (!canonicalTurn) throw new Error("Expected canonical steering fixture turn");
      const currentConversation: CodexConversationSnapshot = {
        ...hydratedConversation,
        canonicalState: {
          ...hydratedConversation.canonicalState!,
          turns: [
            {
              ...canonicalTurn,
              items: [
                {
                  type: "steeringUserMessage",
                  id: "item-1",
                  targetTurnId: "turn-new",
                  targetTurnStartedAtMs: null,
                  status: "pending",
                  clientUserMessageId: "item-1",
                  input: [
                    {
                      type: "text",
                      text: "Changed prompt",
                      text_elements: [],
                    },
                  ],
                  attachments: [],
                  restoreMessage: {
                    queueRow: createCodexQueuedFollowUp({
                      followUpId: "follow-up-item-1",
                      clientUserMessageId: "item-1",
                      threadId: "thread-1",
                      prompt: "Changed prompt",
                      createdAtMs: 1,
                    }),
                    context: { commentAttachments: [] },
                  },
                  compareKey: { rawText: "Changed prompt", imageCount: 0 },
                },
              ],
            },
          ],
        },
      };
      resumeThreadResult = currentConversation;
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-new",
            item: {
              id: "user-real",
              type: "userMessage",
              clientId: null,
              content: [{ type: "text", text: "Changed prompt", text_elements: [] }],
            },
          },
        },
      });
      await flushAsyncWork();

      const turn = manager.readConversation("thread-1")?.turns[0];
      expect(String(turn?.items.length ?? -1)).toBe("3");
      expect(turn?.items[0]?.itemId).toBe("turn-new:input");
      expect(turn?.items[0]?.markdownText).toBe("Changed prompt");
      expect(turn?.items[1]?.itemId).toBe("item-1");
      expect(turn?.items[1]?.markdownText).toBe("Changed prompt");
      expect(turn?.items[1]?.steeringStatus).toBe("accepted");
      expect(turn?.items[2]?.itemId).toBe("user-real");
      expect(turn?.items[2]?.semanticKind).toBe("steered");
      expect(turn?.items[2]?.acceptedUserMessageItemId).toBe("user-real");
      expect(JSON.stringify(turn?.itemIds ?? [])).toBe(JSON.stringify(["item-1", "user-real"]));
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner turn completion derives latest editable capability from local transcript", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const user = buildUserMessage("thread-1", "turn-1", "user-1", "Prompt");
      const currentConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        capabilityFlags: {
          canEditLastUserTurn: false,
          canForkFromTurn: true,
          canSearch: true,
          canCollapseTurns: true,
        },
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["user-1"],
            items: [user],
          },
        ],
      };
      resumeThreadResult = currentConversation;
      await manager.requestThreadStreamResume("thread-1");
      expect(manager.readConversation("thread-1")?.capabilityFlags.canEditLastUserTurn).toBe(false);
      invokeRecords = [];

      dispatchCodexAppServerMessage("thread-owner-notification", {
        hostId: "default",
        sequence: 1,
        notification: {
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: buildProtocolTurn({
              id: "turn-1",
              status: "completed",
            }),
          },
        },
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.turns[0]?.status).toBe("completed");
      expect(manager.readConversation("thread-1")?.capabilityFlags.canEditLastUserTurn).toBe(true);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("does not let no-owner command output mutate an accepted follower replica", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: withCanonicalState({
            ...buildConversation("thread-1", "project-1"),
            turns: [
              {
                threadId: "thread-1",
                turnId: "turn-1",
                status: "inProgress",
                itemIds: ["cmd-1"],
                items: [buildCommandExecutionItem("thread-1", "turn-1", "cmd-1")],
              },
            ],
          }),
        },
        sourceClientId: "test-owner",
      });
      dispatchCodexAppServerMessage("mcp-notification", {
        hostId: "default",
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            delta: "1340 ",
          },
        },
      });
      dispatchCodexAppServerMessage("mcp-notification", {
        hostId: "default",
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            delta: "pass\n",
          },
        },
      });

      expect(
        manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput ?? "missing",
      ).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 70));

      const item = manager.readConversation("thread-1")?.turns[0]?.items[0];
      expect(item?.aggregatedOutput).toBe("");
      expect(item?.toolCall).toBeUndefined();
    } finally {
      manager.destroy();
    }
  });

  test("does not route no-owner command output into any followed conversation", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      for (const threadId of ["thread-1", "thread-2"]) {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "default",
          conversationId: threadId,
          version: 1,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: withCanonicalState({
              ...buildConversation(threadId, "project-1"),
              turns: [
                {
                  threadId,
                  turnId: "turn-1",
                  status: "inProgress",
                  itemIds: ["cmd-1"],
                  items: [buildCommandExecutionItem(threadId, "turn-1", "cmd-1")],
                },
              ],
            }),
          },
          sourceClientId: "test-owner",
        });
      }

      dispatchCodexAppServerMessage("mcp-notification", {
        hostId: "default",
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-2",
            turnId: "turn-1",
            itemId: "cmd-1",
            delta: "target output\n",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));

      expect(
        manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput ?? "missing",
      ).toBe("");
      expect(manager.readConversation("thread-2")?.turns[0]?.items[0]?.aggregatedOutput).toBe("");
    } finally {
      manager.destroy();
    }
  });

  test("no-owner command output cannot mutate a followed same-id command slot", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: withCanonicalState({
            ...buildConversation("thread-1", "project-1"),
            turns: [
              {
                threadId: "thread-1",
                turnId: "turn-1",
                status: "inProgress",
                itemIds: ["shared", "shared"],
                items: [
                  buildCommandExecutionItem("thread-1", "turn-1", "shared"),
                  buildAssistantMessage("thread-1", "turn-1", "shared", "assistant"),
                ],
              },
            ],
          }),
        },
        sourceClientId: "test-owner",
      });
      const assistantRawItem = manager.readConversation("thread-1")?.turns[0]?.items[1]?.rawItem;

      dispatchCodexAppServerMessage("mcp-notification", {
        hostId: "default",
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "stale-turn-id",
            itemId: "shared",
            delta: "exact command output\n",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));

      const items = manager.readConversation("thread-1")?.turns[0]?.items;
      expect(items?.[0]?.aggregatedOutput).toBe("");
      expect(items?.[0]?.updatedAt).toBe(1);
      expect(items?.[1]?.markdownText).toBe("assistant");
      expect(items?.[1]?.rawItem).toBe(assistantRawItem);
    } finally {
      manager.destroy();
    }
  });

  test("drops command output deltas for missing items", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: withCanonicalState({
            ...buildConversation("thread-1", "project-1"),
            turns: [
              {
                threadId: "thread-1",
                turnId: "turn-1",
                status: "inProgress",
                itemIds: [],
                items: [],
              },
            ],
          }),
        },
        sourceClientId: "test-owner",
      });

      dispatchCodexAppServerMessage("mcp-notification", {
        hostId: "default",
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-missing",
            delta: "dropped\n",
          },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 70));

      expect(String(manager.readConversation("thread-1")?.turns[0]?.items.length ?? -1)).toBe("0");
    } finally {
      manager.destroy();
    }
  });

  test("a newer accepted snapshot cannot duplicate queued no-owner command output", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1"],
            items: [buildCommandExecutionItem("thread-1", "turn-1", "cmd-1")],
          },
        ],
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });

      dispatchCodexAppServerMessage("mcp-notification", {
        hostId: "default",
        notification: {
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
            delta: "single append\n",
          },
        },
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "snapshot",
          revision: 2,
          conversationState: withCanonicalState({
            ...baseConversation,
            turns: [
              {
                ...baseConversation.turns[0]!,
                items: [
                  buildCommandExecutionItem("thread-1", "turn-1", "cmd-1", "single append\n"),
                ],
              },
            ],
          }),
        },
        sourceClientId: "test-owner",
      });
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput).toBe(
        "single append\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 70));

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput).toBe(
        "single append\n",
      );
    } finally {
      manager.destroy();
    }
  });

  test("control-plane selectors update without a separate reducer store", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      useCodexPermissionMode,
      useCodexThreadStartProgress,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    function Probe() {
      const permissionMode = useCodexPermissionMode("project-1");
      const progress = useCodexThreadStartProgress("project-1", "session-1");
      return createElement(
        "div",
        null,
        progress
          ? `${permissionMode}:${progress.phase}:${progress.outputText.length}:${progress.outputTruncated}`
          : `${permissionMode}:none:empty`,
      );
    }

    const { container } = render(
      createElement(LocalConversationProvider, null, createElement(Probe)),
    );
    await settleAsyncRender();
    expect(textContent(container)).toBe("custom:none:empty");

    await act(async () => {
      hostMessageListener?.({
        type: "sharedObjectUpdated",
        hostId: "default",
        object: {
          objectType: "threadStartProgress",
          objectId: "project-1:session-1",
          value: {
            launchId: "01991e60-b800-7000-8000-000000000101",
            projectId: "project-1",
            sessionId: "session-1",
            runInTarget: "newWorktree",
            threadId: "thread-1",
            phase: "runningSetup",
            message: "Running setup",
            outputDelta: "hello",
            updatedAt: 10,
          },
        },
      });
    });
    await settleAsyncRender();

    expect(textContent(container)).toBe("custom:runningSetup:5:false");

    await act(async () => {
      hostMessageListener?.({
        type: "sharedObjectUpdated",
        hostId: "default",
        object: {
          objectType: "threadStartProgress",
          objectId: "project-1:session-1",
          value: {
            launchId: "01991e60-b800-7000-8000-000000000101",
            projectId: "project-1",
            sessionId: "session-1",
            runInTarget: "newWorktree",
            threadId: "thread-1",
            phase: "runningSetup",
            message: "Running setup",
            outputDelta: "x".repeat(10 * 1024 * 1024),
            updatedAt: 11,
          },
        },
      });
    });
    await settleAsyncRender();
    expect(textContent(container)).toBe("custom:runningSetup:32000:true");

    await act(async () => {
      hostMessageListener?.({
        type: "sharedObjectUpdated",
        hostId: "default",
        object: {
          objectType: "threadStartProgress",
          objectId: "project-1:session-1",
          value: {
            launchId: "01991e60-b800-7000-8000-000000000101",
            projectId: "project-1",
            sessionId: "session-1",
            runInTarget: "newWorktree",
            threadId: "thread-1",
            phase: "startingThread",
            message: "Starting thread",
            clearOutput: true,
            updatedAt: 12,
          },
        },
      });
    });
    await settleAsyncRender();
    expect(textContent(container)).toBe("custom:startingThread:0:false");
  });

  test("project thread summary subscriptions lazily hydrate once per project", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {
      "project-1": [buildThreadSummary("thread-1", "project-1")],
    };
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      useProjectThreadSummaries,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    function Probe() {
      const summaries = useProjectThreadSummaries("project-1");
      return createElement("div", null, String(summaries.length));
    }

    const { container } = render(
      createElement(
        LocalConversationProvider,
        null,
        createElement("div", null, createElement(Probe), createElement(Probe)),
      ),
    );
    await settleAsyncRender();

    expect(textContent(container)).toBe("11");
    expect(String(invokeCalls.filter((call) => call === "codex:threads:list").length)).toBe("1");
  });

  test("does not hydrate a Project task lane without Project authority", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      useProjectThreadSummaries,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    function Probe() {
      const summaries = useProjectThreadSummaries(null);
      return createElement("div", null, String(summaries.length));
    }

    const { container, rerender } = render(
      createElement(LocalConversationProvider, null, createElement(Probe)),
    );
    await settleAsyncRender();
    rerender(createElement(LocalConversationProvider, null, createElement(Probe)));
    await settleAsyncRender();

    expect(textContent(container)).toBe("0");
    expect(invokeCalls.filter((call) => call === "codex:threads:list")).toEqual([]);
  });

  test("normalizes incoming conversation snapshots before storing them", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      readLocalConversation,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    render(createElement(LocalConversationProvider, null, createElement("div")));
    await settleAsyncRender();

    await act(async () => {
      const snapshot: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        threadName: undefined as unknown as string,
        threadPreview: undefined as unknown as string,
        pendingSteers: undefined as unknown as [],
        queuedFollowUps: undefined as unknown as CodexQueuedFollowUpProjection,
        backgroundTerminalRows: undefined as unknown as [],
        statusActiveFlags: undefined as unknown as [],
      };
      hostMessageListener?.({
        type: "threadStreamStateChanged",
        hostId: "default",
        conversationId: "thread-1",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: snapshot,
        },
        version: 1,
        sourceClientId: "test-owner",
        checkpoint: buildTestCheckpoint(snapshot, 1),
        baseCheckpoint: null,
      });
    });
    await settleAsyncRender();

    const conversation = readLocalConversation("thread-1");
    expect(conversation?.threadName ?? "missing").toBe("");
    expect(conversation?.threadPreview ?? "missing").toBe("");
    expect(String(conversation?.pendingSteers.length ?? -1)).toBe("0");
    expect(String(conversation?.queuedFollowUps.entries.length ?? -1)).toBe("0");
    expect(String(conversation?.backgroundTerminalRows.length ?? -1)).toBe("0");
    expect(String(conversation?.statusActiveFlags.length ?? -1)).toBe("0");
  });

  test("keeps side chat snapshots cached without adding them to project thread summaries", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {
      "project-1": [],
    };
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      readLocalConversation,
      useProjectThreadSummaries,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    function Probe() {
      const summaries = useProjectThreadSummaries("project-1");
      return createElement("div", null, String(summaries.length));
    }

    const { container } = render(
      createElement(LocalConversationProvider, null, createElement(Probe)),
    );
    await settleAsyncRender();

    await act(async () => {
      const snapshot = {
        ...buildConversation("side-thread-1", "project-1"),
        source: {
          parentThreadId: "thread-parent",
          sideConversation: true,
          sideConversationParentNavigationPath:
            "project:project-1/session:session-1/thread:thread-parent",
        },
        ephemeral: true,
        capabilityFlags: {
          canEditLastUserTurn: false,
          canForkFromTurn: false,
          canSearch: true,
          canCollapseTurns: true,
        },
      } satisfies CodexConversationSnapshot;
      hostMessageListener?.({
        type: "threadStreamStateChanged",
        hostId: "default",
        conversationId: "side-thread-1",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: snapshot,
        },
        version: 1,
        sourceClientId: "test-owner",
        checkpoint: buildTestCheckpoint(snapshot, 1),
        baseCheckpoint: null,
      });
    });
    await settleAsyncRender();

    const conversation = readLocalConversation("side-thread-1");
    expect(conversation?.source?.sideConversation === true).toBe(true);
    expect(conversation?.source?.sideConversationParentNavigationPath ?? "").toBe(
      "project:project-1/session:session-1/thread:thread-parent",
    );
    expect(conversation?.ephemeral === true).toBe(true);
    expect(textContent(container)).toBe("0");
  });

  test("attaches a newly forked side chat through the canonical renderer owner lifecycle", async () => {
    invokeCalls = [];
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = new CodexAppServerManager("default");
    const conversation = {
      ...buildConversation("side-thread-owner", "project-1"),
      source: { parentThreadId: "thread-parent", sideConversation: true },
      ephemeral: true,
    } satisfies CodexConversationSnapshot;
    sideChatStartResult = {
      parentThreadId: "thread-parent",
      threadId: conversation.threadId,
      conversation,
    };
    resumeThreadResult = conversation;

    try {
      const result = await manager.startSideChat({ parentThreadId: "thread-parent" });

      expect(result.threadId).toBe("side-thread-owner");
      expect(manager.readConversationStreamRole(result.threadId)).toBe("owner");
      expect(manager.readConversationAttachmentState(result.threadId).status).toBe("attached");
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:resume:request" &&
            record.args[0] === "side-thread-owner",
        ),
      ).toBe(true);
    } finally {
      sideChatStartResult = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("empty project thread results still count as hydrated", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {
      "project-empty": [],
    };
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      useProjectThreadSummaries,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    function Probe() {
      const summaries = useProjectThreadSummaries("project-empty");
      return createElement("div", null, String(summaries.length));
    }

    const { rerender } = render(
      createElement(LocalConversationProvider, null, createElement(Probe)),
    );
    await settleAsyncRender();
    rerender(createElement(LocalConversationProvider, null, createElement(Probe)));
    await settleAsyncRender();

    expect(String(invokeCalls.filter((call) => call === "codex:threads:list").length)).toBe("1");
  });

  test("drops cached conversation state for host and durable deleted-thread events", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = new CodexAppServerManager("default");
    try {
      manager.hydrateThreadSummaries("project-1", [buildThreadSummary("thread-1", "project-1")]);
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "test-owner",
      });

      expect(manager.readThreadSummary("thread-1")?.threadId).toBe("thread-1");
      expect(manager.readConversation("thread-1")?.threadId).toBe("thread-1");

      dispatchCodexAppServerMessage("thread-deleted", {
        hostId: "default",
        threadId: "thread-1",
      });

      expect(manager.readThreadSummary("thread-1")).toBe(null);
      expect(manager.readConversation("thread-1")).toBe(null);
      expect(JSON.stringify(manager.readProjectThreadSummaries("project-1"))).toBe(
        JSON.stringify([]),
      );

      manager.hydrateThreadSummaries("project-1", [
        buildThreadSummary("thread-durable-delete", "project-1"),
      ]);
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "default",
        conversationId: "thread-durable-delete",
        version: 2,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-durable-delete", "project-1"),
        },
        sourceClientId: "test-owner",
      });
      expect(manager.readConversation("thread-durable-delete")?.threadId).toBe(
        "thread-durable-delete",
      );
      codexEventListener?.({ type: "threadDeleted", threadId: "thread-durable-delete" });
      expect(manager.readThreadSummary("thread-durable-delete")).toBe(null);
      expect(manager.readConversation("thread-durable-delete")).toBe(null);
    } finally {
      manager.destroy();
    }
  });
});
