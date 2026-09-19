import {
  buildRollbackResponseFromConversation,
  withCanonicalState,
  ensureCanonicalResumeFixture,
} from "../../test/canonical-conversation-fixture";
import { mutateCodexConversationEvent } from "../../../shared/codex-conversation-state/codex-conversation-reducer";
import type { CodexPreparedTurnExecution } from "../../../shared/codex-conversation-state/codex-turn-execution";
import { encodeCodexNativeRequestFailure } from "../../../shared/codex-native-request-outcome";
import { rendererQueuedMessageStorage } from "./renderer-queued-message-storage";
import type { ThreadRollbackResponse } from "@nodex/codex-app-server-protocol/v2";
import { useDefaultCodexAppServerManager } from "./local-conversation-store";
import { residentConversationTurns } from "../../../shared/codex-conversation-state/codex-turn-mutation";
import { applyPatches, produceWithPatches, enablePatches } from "immer";
import type {
  ConversationCoordinationHost,
  ConversationCoordinationEvent,
} from "../../../shared/codex-client-coordination";
import type { ConversationCoordinationBroadcast } from "../../../shared/codex-coordination-view";
import { buildAgentActivityV2CorpusThread } from "../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
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
  CodexQueuedFollowUpProjection,
  CodexSelectedSubagentHydrateResult,
  CodexSideChatStartResult,
  CodexSubagentOverviewWindow,
  CodexThreadSummary,
} from "../../lib/types";
import type { ServerNotification } from "@nodex/codex-app-server-protocol";
import serverNotificationJsonSchema from "@nodex/codex-app-server-protocol/runtime-schemas/ServerNotification.schema.json";
import { createGeneratedCodexSchema } from "../../../shared/generated-codex-schema";
import type {
  Thread,
  ThreadGoal,
  Turn,
  TurnStartResponse,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexAppServerManager as CodexAppServerManagerInstance } from "./local-conversation-store";
import { projectCodexConversationDocument } from "../../../shared/codex-conversation-document";
import { type CodexCanonicalLiveTurnParams } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { getCodexFileChangeList, getCodexFileChangePaths } from "../../../shared/codex-file-change";
import { render, settleAsyncRender, textContent } from "../../test/dom";

let invokeCalls: string[] = [];
let invokeRecords: Array<{
  channel: string;
  args: unknown[];
}> = [];
/** Observe the generated request carried by either native request entry point. */
function recordedNativeRequests(): typeof invokeRecords {
  return invokeRecords.flatMap((record) => {
    if (record.channel === "codex:app-server:request") return [record];
    if (record.channel === "codex:thread-owner:app-server-request")
      return [{ ...record, channel: "codex:app-server:request" }];
    if (record.channel !== "codex:turn:native:execute") return [record];
    const input = record.args[0] as {
      request: import("@nodex/codex-app-server-protocol/v2").TurnStartParams;
    };
    return [
      {
        channel: "codex:app-server:request",
        args: [{ request: { method: "turn/start", params: input.request } }],
      },
    ];
  });
}
let queuedMessageFixtureState: import("../../../shared/codex-queued-message").CodexQueuedMessageState =
  {};
let nativeResumeResponseGate: Promise<void> | null = null;
let nativeResumeAcceptanceGate: Promise<void> | null = null;
let nativeSupportsPaginatedHistory = true;
let nativeSupportsThreadQueue = false;
let nativeResumeHistoryModeOverride: Thread["historyMode"] | null = null;
let nativeGoalHydrationGate: Promise<void> | null = null;
let nativeUnsubscribeHandler: (() => Promise<unknown>) | null = null;
let nativeSteerFixture:
  | import("../../../shared/codex-conversation-state/codex-owner-steer").CanonicalOwnerSteerInput
  | null = null;
let queuedMessageFixtureId = 0;
let queuedStorageWrite = Promise.resolve();
let hostMessageListener: ((message: CodexHostMessage) => void) | null = null;
const codexEventListeners = new Set<(event: CodexEvent) => void>();
let rendererClientRequestListener: ((message: unknown) => void) | null = null;
let threadListByProject: Record<string, CodexThreadSummary[]> = {};
let snapshotByThread: Record<string, CodexConversationSnapshot | null> = {};
let startThreadForSessionResult: unknown = null;
let freshThreadAdoptionResult: CodexConversationSnapshot | null = null;
let sideChatStartResult: CodexSideChatStartResult | null = null;
let resumeThreadResult: CodexConversationSnapshot | Promise<CodexConversationSnapshot> | null =
  null;
let resumeThreadError: Error | null = null;
let deferFollowerSnapshot = false;
let resumeThreadRole: "owner" | "follower" = "owner";
let resumeThreadOwnerClientId = "renderer-owner";
let resumeThreadRevision = 0;
let resumeThreadGeneration = 1;
let ownerEditRollbackResult: ThreadRollbackResponse | null = null;
let nativeTurnsListResult:
  | import("@nodex/codex-app-server-protocol/v2").ThreadTurnsListResponse
  | null = null;
let ownerTurnStartResult: TurnStartResponse | null = null;
let ownerTurnStartError: Error | null = null;
let ownerTurnStartHandler: (() => void) | null = null;
let ownerTurnStartGate: (() => Promise<void>) | null = null;
const ownerTurnExecutionOverride: { value?: CodexPreparedTurnExecution } = {};
let ownerSettingsGate: (() => Promise<void>) | null = null;
let ownerTurnSteerHandler: ((params: unknown) => unknown | Promise<unknown>) | null = null;
let ownerCompactionHandler: (() => Promise<unknown>) | null = null;
let ownerInterruptHandler: (() => Promise<unknown>) | null = null;
let queuedFollowUpCommandHandler:
  | ((channel: string, args: unknown[]) => unknown | Promise<unknown>)
  | null = null;
let serverQueueRequestHandler:
  | ((method: string, params: unknown) => unknown | Promise<unknown>)
  | null = null;
let followerActionResult: unknown = null;
let followerActionError: Error | null = null;
let followerActionHandler: ((input: unknown) => unknown | Promise<unknown>) | null = null;
let ownerStreamPublishHandler: ((input: unknown) => unknown | Promise<unknown>) | null = null;
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

function readFollowerConversationId(
  input: { request?: { params?: unknown } } | undefined,
): unknown {
  const params = input?.request?.params;
  if (!params || typeof params !== "object") return undefined;
  if ("conversationId" in params) return params.conversationId;
  return "threadId" in params ? params.threadId : undefined;
}

enablePatches();
const testFollowers = new Map<string, Set<string>>();
function emitTestFollowing(
  conversationId: string,
  clientId: string,
  following: boolean,
  hostId = "local",
): void {
  const followers = testFollowers.get(conversationId) ?? new Set<string>();
  if (following) followers.add(clientId);
  else followers.delete(clientId);
  testFollowers.set(conversationId, followers);
  coordinationBroadcast?.("threadStreamFollowingChanged", {
    sourceClientId: clientId,
    params: { hostId, conversationId, following },
  });
}
function setTestFollowers(
  conversationId: string,
  clients: readonly string[],
  hostId = "local",
): void {
  for (const clientId of testFollowers.get(conversationId) ?? [])
    if (!clients.includes(clientId)) emitTestFollowing(conversationId, clientId, false, hostId);
  for (const clientId of clients) emitTestFollowing(conversationId, clientId, true, hostId);
}
const nativeFixtureDocuments = new Map<
  string,
  import("../../../shared/types").CodexCanonicalConversationState
>();
const nativeTestManagers = new Set<CodexAppServerManagerInstance>();
function NativeFixtureRegistration() {
  trackNativeTestManager(useDefaultCodexAppServerManager());
  return null;
}
function trackNativeTestManager(
  manager: CodexAppServerManagerInstance,
): CodexAppServerManagerInstance {
  nativeTestManagers.add(manager);
  return manager;
}
let fixtureGetManager: ((hostId: string) => CodexAppServerManagerInstance) | undefined;
let coordinationBroadcast:
  | ((method: ConversationCoordinationBroadcast, event: ConversationCoordinationEvent) => void)
  | undefined;
vi.mock("./conversation-coordination-connection", () => ({
  connectConversationCoordination: (
    getManager: (hostId: string) => CodexAppServerManagerInstance,
    broadcast: typeof coordinationBroadcast,
  ) => {
    fixtureGetManager = getManager;
    coordinationBroadcast = (method, event) => {
      broadcast?.(method, event);
      for (const manager of nativeTestManagers) manager.receiveCoordination(method, event);
    };
    const record = async (method: string, input: unknown) => {
      invokeRecords.push({ channel: `peer:${method}`, args: [input] });
    };
    const host: ConversationCoordinationHost = {
      threadArchived: (input) => record("threadArchived", input),
      threadUnarchived: (input) => record("threadUnarchived", input),
      threadQueuedFollowUpsChanged: (input) => record("threadQueuedFollowUpsChanged", input),
      setThreadOwnership: (input) => record("setThreadOwnership", input),
      threadStreamStateChanged: async (input) => {
        await record("threadStreamStateChanged", input.params);
        if (ownerStreamPublishHandler) await ownerStreamPublishHandler(input.params);
      },
      threadStreamFollowingChanged: async (input) => {
        await record("threadStreamFollowingChanged", input);
        if (!input.params.following || resumeThreadRole !== "follower" || deferFollowerSnapshot)
          return;
        const conversation = ensureCanonicalResumeFixture(
          await Promise.resolve(resumeThreadResult),
        );
        if (conversation?.canonicalState)
          queueMicrotask(() =>
            coordinationBroadcast?.("threadStreamStateChanged", {
              sourceClientId: resumeThreadOwnerClientId,
              params: {
                hostId: "local",
                conversationId: conversation.threadId,
                change: {
                  type: "snapshot",
                  revision: Math.max(1, resumeThreadRevision),
                  conversationState: conversation.canonicalState,
                },
              },
            }),
          );
      },
      threadStreamFollowingStatusRequested: (input) =>
        record("threadStreamFollowingStatusRequested", input),
      findThreadOwner: async () =>
        resumeThreadRole === "follower" ? resumeThreadOwnerClientId : null,
      requestThreadFollower: async (input) => {
        await record("requestThreadFollower", input);
        if (followerActionError) throw followerActionError;
        const result = followerActionHandler
          ? await followerActionHandler(input)
          : followerActionResult;
        return {
          type: "response",
          requestId: "peer-test",
          resultType: "success",
          method: input.request.method,
          handledByClientId: resumeThreadOwnerClientId,
          result,
        };
      },
    };
    return {
      ready: Promise.resolve(host),
      readStateReady: Promise.resolve(undefined),
      [Symbol.dispose]: () => {
        coordinationBroadcast = undefined;
      },
    };
  },
}));

vi.mock("./local-conversation-operations", async () => {
  const deps = await import("./local-conversation-deps");
  return { runConversationOperation: deps.runConversationOperation };
});

vi.mock("./local-conversation-deps", () => ({
  subscribeWindowFocusChanges: () => () => {},
  runConversationOperation: async (channel: string, ...args: unknown[]) => {
    const execute = async () => {
      invokeCalls.push(channel);
      invokeRecords.push({ channel, args });
      const threadId = typeof args[0] === "string" ? args[0] : undefined;
      if (channel === "codex:thread:resume:accept") {
        await nativeResumeAcceptanceGate;
        return true;
      }
      if (
        channel === "codex:app-server:request" &&
        (args[0] as { request?: { method?: string } }).request?.method === "thread/unsubscribe"
      )
        return nativeUnsubscribeHandler ? nativeUnsubscribeHandler() : {};
      if (channel === "codex:queued-messages:read") return queuedMessageFixtureState;
      if (channel === "codex:queued-messages:write") {
        queuedMessageFixtureState = args[0] as typeof queuedMessageFixtureState;
        return;
      }
      if (channel === "codex:queued-messages:acquire-send") return true;
      if (channel === "codex:queued-messages:prepare-native") {
        const message =
          args[1] as import("../../../shared/codex-queued-message").CodexQueuedMessage;
        const preparationContext = args[3] as
          | import("../../../shared/codex-queued-message").CodexQueuedNativePreparationContext
          | undefined;
        const conversation = [...nativeTestManagers]
          .map((manager) => manager.readConversation(String(args[0])))
          .find(Boolean);
        if (!conversation)
          throw new Error("Queued native preparation requires a loaded conversation");
        const clientUserMessageId = preparationContext?.clientUserMessageId ?? message.id;
        const params = buildFreshLaunchCanonicalParams({
          conversation,
          threadId: String(args[0]),
          clientUserMessageId,
          prompt: message.context.prompt,
        });
        const steer = {
          conversationId: String(args[0]),
          clientUserMessageId,
          input: params.input,
          restoreMessage: {
            id: message.id,
            cwd: message.cwd,
            context: { commentAttachments: message.context.commentAttachments },
          },
        };
        nativeSteerFixture = steer;
        return { start: { request: params, context: {} }, steer, requiresIdle: false };
      }
      if (channel === "codex:queued-messages:prepare") {
        const opts = args[2] as
          | import("../../../shared/codex-queued-message").CodexQueuedMessagePrepareOptions
          | undefined;
        const input = opts?.promptInput;
        const conversation = [...nativeTestManagers]
          .map((manager) => manager.readConversation(String(args[0])))
          .find(Boolean);
        const cwd = conversation?.cwd ?? "/";
        return {
          id: `queued-native-${++queuedMessageFixtureId}`,
          cwd,
          createdAt: Date.now(),
          context: {
            prompt: String(args[1]),
            fileAttachments: input?.fileAttachments ?? [],
            addedFiles: input?.addedFiles ?? [],
            commentAttachments: input?.commentAttachments ?? [],
            imageAttachments: input?.images ?? [],
            workspaceRoots: opts?.workspaceRoots ?? [cwd],
          },
          submissionOptions: {
            serviceTier: opts?.serviceTier ?? null,
            collaborationMode:
              opts?.collaborationMode == null
                ? null
                : {
                    mode: opts.collaborationMode,
                    settings: {
                      model: conversation?.latestThreadSettings?.model ?? "gpt-test-fixture",
                      reasoning_effort:
                        conversation?.latestThreadSettings?.reasoningEffort ?? "high",
                      developer_instructions: null,
                    },
                  },
            agentMode: opts?.permissionMode,
            permissionSelection: opts?.permissionSelection,
            permissionProfileId: opts?.permissionProfileId,
            usePermissionSelection: opts?.usePermissionSelection,
            shouldSendPermissionOverrides:
              opts?.shouldSendPermissionOverrides ?? opts?.permissionMode !== undefined,
          },
        };
      }
      if (channel === "codex:turn:native-steer:prepare") {
        const input = args[0] as { threadId: string; prompt: string };
        nativeSteerFixture = {
          conversationId: input.threadId,
          clientUserMessageId: crypto.randomUUID(),
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
          restoreMessage: { context: { commentAttachments: [] } },
        };
        return nativeSteerFixture;
      }
      if (channel === "codex:turn:native-steer:inspect") return nativeSteerFixture;
      if (channel === "codex:turn:native-fresh:prepare") {
        const started = startThreadForSessionResult as {
          freshLaunch: { canonicalParams: CodexCanonicalLiveTurnParams };
        };
        return { request: { ...started.freshLaunch.canonicalParams, threadId }, context: {} };
      }
      if (channel === "codex:turn:native:prepare")
        return { request: (args[0] as { originalRequest: unknown }).originalRequest, context: {} };
      if (channel === "codex:turn:native:inspect") {
        const request = (
          args[0] as { request: import("@nodex/codex-app-server-protocol/v2").TurnStartParams }
        ).request;
        const conversation = [...nativeTestManagers]
          .map((manager) => manager.readConversation(request.threadId))
          .find(Boolean);
        if (!conversation)
          throw new Error("Native Turn preparation requires a resident conversation");
        const params = buildFreshLaunchCanonicalParams({
          conversation,
          threadId: request.threadId,
          clientUserMessageId: request.clientUserMessageId ?? "test-client",
          prompt: request.input
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .join("\n"),
        });
        return {
          request,
          model: request.collaborationMode != null ? null : (request.model ?? params.model),
          reasoningEffort:
            request.collaborationMode != null
              ? null
              : request.effort === undefined
                ? params.effort
                : request.effort,
          shouldUpdateReasoningEffort:
            request.effort !== undefined ||
            conversation.canonicalState?.latestThreadSettings != null,
          collaborationMode: request.collaborationMode ?? params.collaborationMode,
          permissions: conversation.canonicalState!.currentPermissions!,
          previousPermissions: conversation.canonicalState!.currentPermissions,
          ...ownerTurnExecutionOverride.value,
          params: {
            ...params,
            input: request.input,
            model: request.model ?? params.model,
            effort: request.effort ?? params.effort,
            serviceTier: request.serviceTier ?? params.serviceTier,
            collaborationMode: request.collaborationMode ?? params.collaborationMode,
          },
        };
      }
      if (channel === "codex:app-server:host-context")
        return {
          hostId: args[0],
          generation: resumeThreadGeneration,
          sourceEpoch: "test-native",
          supportsPaginatedHistory: nativeSupportsPaginatedHistory,
          supportsTurnApprovalsReviewer: false,
          supportsThreadRevert: false,
          supportsThreadQueue: nativeSupportsThreadQueue,
          accountContext: { hostId: args[0], accountId: null, userId: null },
        };
      if (channel === "codex:thread:history-hydration:prepare") {
        const pending = resumeThreadResult instanceof Promise ? null : resumeThreadResult;
        const summary =
          pending?.threadId === threadId ? pending : snapshotByThread[String(threadId)];
        return {
          summary,
          context: {
            hostId: "local",
            model: "gpt-test-fixture",
            reasoningEffort: "high",
            cwd: "/repo",
            approvalPolicy: "on-request",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
            activePermissionProfile: null,
            runtimeWorkspaceRoots: ["/repo"],
          },
        };
      }
      if (channel === "codex:thread:resume:prepare") {
        if (resumeThreadError) throw resumeThreadError;
        const pendingConversation = await Promise.resolve(resumeThreadResult);
        const conversation =
          pendingConversation?.threadId === threadId
            ? pendingConversation
            : snapshotByThread[String(threadId)];
        if (!conversation) throw new Error("Native resume fixture unavailable");
        const overrides = (args[2] ??
          {}) as import("../../../shared/codex-conversation-state/codex-resume-permissions").CanonicalResumeOverrides;
        const resumeOptions = (args[3] ??
          {}) as import("../../../shared/codex-conversation-state/codex-resume-request").ConversationResumePreparationOptions;
        return {
          receiptId: `resume:${threadId}`,
          nativeRequestId: `native:${threadId}`,
          hostId: "local",
          generation: resumeThreadGeneration,
          supportsPaginatedHistory: nativeSupportsPaginatedHistory,
          requestedCwd: overrides.cwd ?? conversation.cwd ?? null,
          params: {
            threadId,
            excludeTurns: true,
            ...overrides,
            ...(resumeOptions.serviceTier === undefined
              ? {}
              : { serviceTier: resumeOptions.serviceTier }),
            ...(nativeSupportsPaginatedHistory &&
            conversation.canonicalState?.historyMode === "paginated"
              ? {}
              : {
                  initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" },
                }),
          },
          summary: conversation,
        };
      }
      if (
        channel === "codex:app-server:request" &&
        (args[0] as { request?: { method?: string } }).request?.method === "thread/resume"
      ) {
        const target = (args[0] as { request: { params: { threadId: string } } }).request.params
          .threadId;
        if (nativeResumeResponseGate) await nativeResumeResponseGate;
        const pendingConversation = await Promise.resolve(resumeThreadResult);
        const conversation =
          pendingConversation?.threadId === target ? pendingConversation : snapshotByThread[target];
        if (!conversation) throw new Error("Native resume fixture unavailable");
        emitTestFollowing(conversation.threadId, "test-follower", true);
        const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
        for (const [index, request] of (
          conversation.canonicalRequests ??
          conversation.canonicalState?.requests ??
          []
        ).entries()) {
          dispatchCodexAppServerMessage("native-request", {
            type: "nativeRequest",
            hostId: "local",
            generation: resumeThreadGeneration,
            occurrenceId: `resume-request:${conversation.threadId}:${index}`,
            occurrenceToken: index + 1,
            request,
          });
        }
        const raw = buildRollbackResponseFromConversation(conversation).thread;
        const base = buildAgentActivityV2CorpusThread([]);
        const thread = {
          ...base,
          ...raw,
          status: typeof raw.status === "string" ? { type: raw.status } : raw.status,
          historyMode:
            nativeResumeHistoryModeOverride ?? conversation.canonicalState?.historyMode ?? "legacy",
          turns: raw.turns,
        };
        return {
          thread,
          model: conversation.latestThreadSettings?.model ?? "gpt-test-fixture",
          modelProvider: thread.modelProvider,
          serviceTier: null,
          cwd: thread.cwd,
          runtimeWorkspaceRoots: [thread.cwd],
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
          activePermissionProfile: null,
          reasoningEffort: "high",
          multiAgentMode: "explicitRequestOnly",
          turnsBackwardsCursor: null,
          itemsBackwardsCursor: null,
          initialTurnsPage: {
            data: [...thread.turns].reverse(),
            nextCursor: conversation.turnPagination?.olderCursor ?? null,
            backwardsCursor: null,
          },
        };
      }

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

      if (channel === "codex:thread:fresh-owner:adopt") {
        const conversation = ensureCanonicalResumeFixture(freshThreadAdoptionResult);
        if (!conversation) {
          throw new Error("Fresh thread adoption fixture is unavailable");
        }

        setTestFollowers(conversation.threadId, ["test-follower"], "local");
        return {
          hostId: "local",
          generation: resumeThreadGeneration,
          response: buildNativeThreadStartFixture(conversation),
        };
      }

      if (
        channel === "codex:app-server:request" &&
        (args[0] as { request?: { method?: string } }).request?.method === "model/list"
      ) {
        return {
          data: [
            {
              id: "gpt-5.3-codex",
              model: "gpt-5.3-codex",
              displayName: "GPT-5.3 Codex",
              hidden: false,
              isDefault: true,
              defaultReasoningEffort: "high",
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "Balanced" },
                { reasoningEffort: "high", description: "Deep" },
              ],
            },
          ],
          nextCursor: null,
        };
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

      if (channel === "codex:thread:native-session:prepare")
        return {
          receiptId: "native-session-fixture",
          hostId: "local",
          generation: resumeThreadGeneration,
          request: { cwd: "/workspace/project" },
        };
      if (channel === "codex:thread:native-fork:prepare") {
        return {
          receiptId: "native-fork-fixture",
          hostId: "local",
          generation: resumeThreadGeneration,
          sourceTitle: "Source conversation",
        };
      }
      if (channel === "codex:thread:native-fork:execute") {
        const child = buildConversation("thread-forked", "project-1");
        snapshotByThread[child.threadId] = child;
        return buildNativeThreadStartFixture(child);
      }
      if (channel === "codex:thread:native-fork:accept") {
        return {
          threadId: "thread-forked",
          summary: snapshotByThread["thread-forked"],
          composerIntent: { prompt: "Continue from older turn" },
        };
      }
      if (channel === "codex:thread:native-session:execute") {
        const started = (await Promise.resolve(startThreadForSessionResult)) as {
          kind: string;
          detail?: CodexConversationSnapshot;
        };
        if (started.kind !== "started" || !started.detail)
          throw new Error("Native session start fixture unavailable");
        return buildNativeThreadStartFixture(
          snapshotByThread[started.detail.threadId] ??
            (Array.isArray(started.detail.turns)
              ? started.detail
              : {
                  ...buildConversation(
                    started.detail.threadId,
                    started.detail.projectId ?? "project-1",
                  ),
                  ...started.detail,
                }),
        );
      }
      if (channel === "codex:thread:native-session:accept") return startThreadForSessionResult;
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
        const input = args[0] as {
          rootThreadId: string;
        };
        return {
          rootThreadId: input.rootThreadId,
          revision: 0,
          generation: 1,
          completeness: "complete",
          active: { rows: [], knownCount: 0, totalCount: 0, continuation: null },
          done: { rows: [], knownCount: 0, totalCount: 0, continuation: null },
        } satisfies CodexSubagentOverviewWindow;
      }

      if (
        channel === "codex:thread-owner:app-server-request" ||
        channel === "codex:turn:native:execute" ||
        channel === "codex:turn:native-fresh:execute" ||
        channel === "codex:turn:native-steer:execute" ||
        channel === "codex:app-server:request"
      ) {
        const input = (
          channel === "codex:turn:native:execute" || channel === "codex:turn:native-fresh:execute"
            ? {
                request: {
                  method: "turn/start",
                  params: (args[0] as { request: unknown }).request,
                },
              }
            : args[0]
        ) as {
          request?: {
            method?: string;
            params?: {
              expectedTurnId?: string;
            };
          };
        };
        if (input.request?.method === "thread/turns/list") return nativeTurnsListResult;
        if (input.request?.method?.startsWith("thread/queue/") && serverQueueRequestHandler) {
          return await serverQueueRequestHandler(input.request.method, input.request.params);
        }
        if (
          input.request?.method === "thread/revert" ||
          input.request?.method === "thread/rollback"
        ) {
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
          return ownerInterruptHandler ? await ownerInterruptHandler() : true;
        }
        if (input.request?.method === "thread/compact/start") {
          return ownerCompactionHandler ? await ownerCompactionHandler() : {};
        }
        if (input.request?.method === "thread/settings/update") {
          await ownerSettingsGate?.();
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
        if (input.request?.method === "thread/goal/get") {
          if (nativeGoalHydrationGate) await nativeGoalHydrationGate;
          const conversation = await Promise.resolve(resumeThreadResult);
          return { goal: conversation?.threadGoal ?? null };
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
            goal: {
              threadId: goalParams?.threadId ?? "thread-1",
              objective: goalParams?.objective ?? "Ship it",
              status: goalParams?.status ?? "active",
              tokenBudget: goalParams?.tokenBudget ?? null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          };
        }
        if (input.request?.method === "thread/fork") {
          const params = input.request.params as
            | {
                message?: string;
              }
            | undefined;
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
        const input = args[0] as
          | {
              expectedTurnId?: string;
            }
          | undefined;
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

      if (channel === "peer:threadStreamStateChanged") {
        if (ownerStreamPublishHandler) {
          return await ownerStreamPublishHandler(args[0]);
        }
        return true;
      }

      if (channel === "codex:thread-follower:snapshot-applied") {
        return true;
      }

      if (channel === "codex:dynamic-tool-call:respond") {
        return { success: false, contentItems: [] };
      }

      if (channel === "codex:app-server:respond") {
        const input = args[0] as {
          threadId?: string;
          requestId?: CodexProtocolRequestId;
          effect?: { requestId?: CodexProtocolRequestId };
        };
        if (ownerRequestResponseHandler) {
          return await ownerRequestResponseHandler(channel, [
            input.threadId,
            input.requestId ?? input.effect?.requestId,
            input,
          ]);
        }
        return true;
      }

      if (channel === "peer:requestThreadFollower") {
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
    };
    if (
      channel !== "codex:app-server:request" &&
      channel !== "codex:turn:native:execute" &&
      channel !== "codex:turn:native-steer:execute" &&
      channel !== "codex:turn:native-fresh:execute" &&
      channel !== "codex:thread:native-session:execute" &&
      channel !== "codex:thread:native-fork:execute"
    )
      return execute();
    try {
      return { type: "result", result: await execute() };
    } catch (error) {
      return {
        type: "error",
        error: {
          ...encodeCodexNativeRequestFailure(error),
          code: encodeCodexNativeRequestFailure(error).code ?? -32603,
        },
      };
    }
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
    codexEventListeners.add(listener);
    return () => {
      codexEventListeners.delete(listener);
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

function replayCanonicalPublications(
  records: typeof invokeRecords,
  initial: import("../../../shared/types").CodexCanonicalConversationState | null | undefined,
) {
  if (!initial) throw new Error("Missing initial canonical publication document");
  let state = initial;
  return records.map((record) => {
    const { change } = record.args[0] as {
      change:
        | { type: "snapshot"; conversationState: typeof state }
        | { type: "patches"; patches: CodexConversationStateUpdate[] };
    };
    state =
      change.type === "snapshot" ? change.conversationState : applyPatches(state, change.patches);
    const turn = residentConversationTurns(state)[0];
    const item = turn?.items.find((item) => item.type === "agentMessage");
    return {
      text: item?.type === "agentMessage" ? item.text : null,
      status: item ? turn?.lifecycleStatusByItemId?.[item.id] : undefined,
    };
  });
}

type TestStreamFixtureEvent = {
  readonly hostId: string;
  readonly conversationId: string;
  readonly sourceClientId: string | null;
  readonly version?: number;
  readonly change:
    | {
        readonly type: "snapshot";
        readonly revision: number;
        readonly conversationState:
          | CodexConversationSnapshot
          | import("../../../shared/types").CodexCanonicalConversationState;
      }
    | {
        readonly type: "patches";
        readonly revision: number;
        readonly baseRevision: number;
        readonly patches: CodexConversationStateUpdate[];
      };
};
function canonicalFixture(
  value:
    | CodexConversationSnapshot
    | import("../../../shared/types").CodexCanonicalConversationState,
): import("../../../shared/types").CodexCanonicalConversationState {
  if ("id" in value) return value;
  const state = ensureCanonicalResumeFixture(value)?.canonicalState;
  if (!state) throw new Error("Canonical fixture missing");
  return state;
}
function buildCanonicalFixturePatches(
  before: CodexConversationSnapshot,
  next: CodexConversationSnapshot,
): CodexConversationStateUpdate[] {
  const previous = canonicalFixture(before);
  const state =
    next.canonicalState && next.canonicalState !== before.canonicalState
      ? next.canonicalState
      : canonicalFixture(withCanonicalState(next));
  return produceWithPatches(previous, () => state)[1];
}
function resetLocalConversationStoreTestHarness(reset: () => void): void {
  delete ownerTurnExecutionOverride.value;
  ownerSettingsGate = null;
  nativeSupportsPaginatedHistory = true;
  nativeSupportsThreadQueue = false;
  nativeResumeHistoryModeOverride = null;
  nativeGoalHydrationGate = null;
  testFollowers.clear();
  nativeTestManagers.clear();
  nativeFixtureDocuments.clear();
  queuedFollowUpCommandHandler = null;
  serverQueueRequestHandler = null;
  selectedSubagentHydrateResult = null;
  selectedSubagentHydrateHandler = null;
  codexEventListeners.clear();
  reset();
  queuedMessageFixtureState = {};
  queuedMessageFixtureId = 0;
  queuedStorageWrite = Promise.resolve();
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (_name: string, callback: () => Promise<void>) => {
        const result = queuedStorageWrite.then(callback);
        queuedStorageWrite = result.catch(() => {});
        return result;
      },
    },
  });
  rendererQueuedMessageStorage.invalidate();
}
function dispatchTestThreadStreamStateChanged(
  _dispatch: unknown,
  event: TestStreamFixtureEvent,
): void {
  if (_dispatch && typeof _dispatch === "object" && "receiveCoordination" in _dispatch) {
    const target = _dispatch as CodexAppServerManagerInstance;
    void target.setThreadStreamFollowing(event.conversationId, true);
    const change =
      event.change.type === "snapshot"
        ? { ...event.change, conversationState: canonicalFixture(event.change.conversationState) }
        : event.change;
    target.receiveCoordination("threadStreamStateChanged", {
      sourceClientId: event.sourceClientId ?? "main",
      params: { hostId: event.hostId, conversationId: event.conversationId, change },
    });
    return;
  }
  const registered = fixtureGetManager?.(event.hostId);
  if (registered) void registered.setThreadStreamFollowing(event.conversationId, true);
  for (const manager of nativeTestManagers)
    void manager.setThreadStreamFollowing(event.conversationId, true);
  const change =
    event.change.type === "snapshot"
      ? { ...event.change, conversationState: canonicalFixture(event.change.conversationState) }
      : event.change;
  coordinationBroadcast?.("threadStreamStateChanged", {
    sourceClientId: event.sourceClientId ?? "main",
    params: { hostId: event.hostId, conversationId: event.conversationId, change },
  });
}

function disconnectFixtureOwner(manager: CodexAppServerManagerInstance, threadId: string): void {
  const role = manager.getStreamRole(threadId);
  if (role?.role !== "follower") throw new Error("Expected a followed fixture before recovery");
  manager.receiveCoordination("clientStatusChanged", {
    sourceClientId: role.ownerClientId,
    params: { clientId: role.ownerClientId, clientType: "app", status: "disconnected" },
  });
  expect(manager.readConversationStreamRole(threadId)).toBeNull();
}

/** Recover a retained document through a real peer disconnect before testing native ownership. */
async function resumeAfterFixtureOwnerDisconnect(
  manager: CodexAppServerManagerInstance,
  threadId: string,
): Promise<void> {
  await act(async () => {
    disconnectFixtureOwner(manager, threadId);
    await manager.requestThreadStreamResume(threadId);
  });
  expect(manager.readConversationStreamRole(threadId)).toBe("owner");
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

function buildNativeThreadStartFixture(conversation: CodexConversationSnapshot) {
  const raw = buildRollbackResponseFromConversation(conversation).thread;
  const thread = {
    ...buildAgentActivityV2CorpusThread([]),
    ...raw,
    status: typeof raw.status === "string" ? { type: raw.status } : raw.status,
  };
  return {
    thread,
    model: conversation.latestThreadSettings?.model ?? "gpt-test-fixture",
    modelProvider: thread.modelProvider,
    serviceTier: null,
    cwd: thread.cwd,
    runtimeWorkspaceRoots: [thread.cwd],
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    activePermissionProfile: null,
    reasoningEffort: "high",
    multiAgentMode: "explicitRequestOnly",
  };
}

function buildFreshLaunchCanonicalParams(input: {
  readonly conversation: CodexConversationSnapshot;
  readonly threadId: string;
  readonly clientUserMessageId: string;
  readonly prompt: string;
}): CodexCanonicalLiveTurnParams {
  const canonical = input.conversation.canonicalState;
  const permissions = canonical?.currentPermissions;
  if (!canonical || !permissions) {
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
    cwd: canonical.cwd,
    approvalPolicy: permissions.approvalPolicy,
    approvalsReviewer: permissions.approvalsReviewer,
    sandboxPolicy: permissions.sandboxPolicy,
    permissions: permissions.activePermissionProfile?.id ?? null,
    runtimeWorkspaceRoots: permissions.runtimeWorkspaceRoots
      ? [...permissions.runtimeWorkspaceRoots]
      : null,
    useAppServerPermissionDefault: false,
    model: canonical.latestModel,
    serviceTier: null,
    effort: canonical.latestReasoningEffort,
    multiAgentMode: "explicitRequestOnly",
    summary: "none",
    personality: null,
    outputSchema: null,
    collaborationMode: null,
    attachments: [],
    commentAttachments: [],
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
      questions: null,
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
    manager?: Pick<CodexAppServerManagerInstance, "receiveCoordination">;
  } = {},
): Promise<void> {
  const event = {
    sourceClientId: "queue-owner",
    params: {
      hostId: "local",
      conversationId: options.threadId ?? "thread-1",
      messages: projection.entries.map((row) => ({
        id: row.clientUserMessageId,
        cwd: null,
        createdAt: row.createdAtMs,
        context: {
          prompt: row.prompt,
          fileAttachments: row.promptInput?.fileAttachments ?? [],
          addedFiles: row.promptInput?.addedFiles ?? [],
          commentAttachments: row.promptInput?.commentAttachments ?? [],
          imageAttachments: row.promptInput?.images ?? [],
        },
        submissionOptions: { serviceTier: row.serviceTier, summary: row.summary },
        ...(row.pause ? { pausedReason: row.pause.reason } : {}),
      })),
    },
  };
  if (options.manager) options.manager.receiveCoordination("threadQueuedFollowUpsChanged", event);
  else coordinationBroadcast?.("threadQueuedFollowUpsChanged", event);
  await flushAsyncWork();
}

describe("local-conversation-store", () => {
  test("answers current-time server requests through the renderer without response tracing", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: 1,
        occurrenceId: "current-time:1",
        occurrenceToken: 1,
        hostId: "local",
        request: {
          id: "time-1",
          method: "currentTime/read",
          params: { threadId: "thread-ignored" },
        },
      });
      await flushAsyncWork();

      const responseCall = invokeRecords.find(
        (record) => record.channel === "codex:app-server:respond",
      );
      expect(responseCall?.args[0]).toMatchObject({
        hostId: "local",
        generation: 1,
        occurrenceId: "current-time:1",
        occurrenceToken: 1,
        effect: {
          type: "respond",
          method: "currentTime/read",
          requestId: "time-1",
          response: { currentTimeAt: expect.any(Number) },
        },
      });
      expect(responseCall?.args[0]).not.toHaveProperty("requestMethod");
      expect(responseCall?.args[0]).not.toHaveProperty("trace");
    } finally {
      manager.destroy();
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    }
  });

  test("resume keeps the requested legacy tail when response metadata switches to paginated", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    nativeResumeHistoryModeOverride = "paginated";
    resumeThreadRole = "owner";
    resumeThreadResult = {
      ...buildConversation("legacy-mode", "project-1"),
      turnPagination: {
        olderCursor: "legacy-older",
        backwardsCursor: null,
        oldestLoadedTurnId: null,
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 0,
        itemsView: "full",
      },
    };
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      invokeRecords = [];
      await manager.requestThreadStreamResume("legacy-mode");
      await flushAsyncWork();
      expect(
        recordedNativeRequests().find(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method ===
              "thread/resume",
        )?.args[0],
      ).toMatchObject({
        request: {
          params: { initialTurnsPage: { limit: 5, itemsView: "full", sortDirection: "desc" } },
        },
      });
      const canonical = manager.readConversation("legacy-mode")?.canonicalState;
      expect(canonical?.historyMode).toBe("paginated");
      expect(canonical?.turnsPagination).toMatchObject({
        olderCursor: "legacy-older",
        hasLoadedOldest: false,
      });
      expect(canonical?.turnHistory?.history.isComplete).toBe(false);
      expect(
        recordedNativeRequests().filter(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method ===
              "thread/turns/list",
        ),
      ).toHaveLength(0);
    } finally {
      manager.destroy();
      resumeThreadResult = null;
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    }
  });

  test.each([
    "complete",
    "failed-goal",
    "newer-goal",
    "superseded",
    "reconnect",
    "native-retired",
    "retired",
  ] as const)(
    "legacy resume defers its remaining history until current goal hydration: %s",
    async (outcome) => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      nativeSupportsPaginatedHistory = false;
      let finishGoal!: () => void;
      let failGoal!: (error: Error) => void;
      let finishNewGoal: (() => void) | undefined;
      nativeGoalHydrationGate = new Promise<void>((resolve, reject) => {
        finishGoal = resolve;
        failGoal = reject;
      });
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      resumeThreadRole = "owner";
      resumeThreadResult = {
        ...buildConversation("legacy-tail", "project-1"),
        turnPagination: {
          olderCursor: "older-tail",
          backwardsCursor: null,
          oldestLoadedTurnId: null,
          isLoadingOlder: false,
          hasLoadedOldest: false,
          loadedTurnCount: 0,
          itemsView: "full",
        },
      };
      nativeTurnsListResult = {
        data: [buildProtocolTurn({ id: "older-turn", status: "completed" })],
        nextCursor: null,
        backwardsCursor: null,
      };
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      const activity = manager.retainActiveConversation("legacy-tail");
      const historyReads = () =>
        recordedNativeRequests().filter(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (record.args[0] as { request?: { method?: string } }).request?.method ===
              "thread/turns/list",
        );
      try {
        invokeRecords = [];
        await manager.requestThreadStreamResume("legacy-tail", {
          isReconnectRecovery: outcome === "reconnect",
        });
        expect(manager.readConversation("legacy-tail")?.resumeState).toBe("resumed");
        expect(
          manager.readConversation("legacy-tail")?.canonicalState?.turnsPagination,
        ).toMatchObject({
          olderCursor: "older-tail",
          isLoadingOlder: false,
          hasLoadedOldest: false,
        });
        expect(historyReads()).toHaveLength(0);
        expect(
          invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
        ).toBe(true);
        const newerGoal: NonNullable<CodexConversationSnapshot["threadGoal"]> = {
          threadId: "legacy-tail",
          objective: "Keep the new goal",
          status: "paused",
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 2,
        };
        if (outcome === "newer-goal") {
          const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
          dispatchCodexAppServerMessage("native-notification", {
            type: "nativeNotification",
            hostId: "local",
            generation: resumeThreadGeneration,
            occurrenceId: "legacy-newer-goal",
            occurrenceToken: 1,
            notification: {
              method: "thread/goal/updated",
              params: { threadId: "legacy-tail", turnId: null, goal: newerGoal },
            },
          });
        }
        if (outcome === "retired") manager.destroy();
        if (outcome === "native-retired") manager.retireNativeHostContext();
        if (outcome === "superseded") {
          manager.markAllConversationsNeedResumeAfterReconnect();
          nativeGoalHydrationGate = new Promise<void>((resolve) => {
            finishNewGoal = resolve;
          });
          await manager.requestThreadStreamResume("legacy-tail");
        }
        if (outcome === "failed-goal") failGoal(new Error("goal service unavailable"));
        else finishGoal();
        await flushAsyncWork(4);
        if (outcome === "superseded") {
          expect(historyReads()).toHaveLength(0);
          finishNewGoal?.();
          await flushAsyncWork(4);
        }
        if (outcome === "reconnect" || outcome === "native-retired" || outcome === "retired") {
          expect(historyReads()).toHaveLength(0);
          return;
        }
        expect(historyReads()).toHaveLength(1);
        expect(historyReads()[0]?.args[0]).toMatchObject({
          request: {
            method: "thread/turns/list",
            params: { threadId: "legacy-tail", cursor: "older-tail", limit: 5 },
          },
        });
        expect(manager.readConversation("legacy-tail")?.turns.map((turn) => turn.turnId)).toContain(
          "older-turn",
        );
        expect(
          manager.readConversation("legacy-tail")?.canonicalState?.turnsPagination?.hasLoadedOldest,
        ).toBe(true);
        if (outcome === "newer-goal")
          expect(manager.readConversation("legacy-tail")?.canonicalState?.threadGoal).toEqual(
            newerGoal,
          );
        if (outcome === "failed-goal")
          expect(warning).toHaveBeenCalledWith("Failed to hydrate thread goal after resume", {
            threadId: "legacy-tail",
            error: expect.any(Error),
          });
      } finally {
        finishGoal();
        finishNewGoal?.();
        activity[Symbol.dispose]();
        manager.destroy();
        resumeThreadResult = null;
        nativeTurnsListResult = null;
        resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
        warning.mockRestore();
      }
    },
  );

  test("global peer lifecycle reannounces active hosts and retires the disconnected owner", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadRole = "owner";
    const bootstrap = new CodexAppServerManager("bootstrap");
    const activities: Disposable[] = [];
    try {
      await bootstrap.setThreadStreamFollowing("bootstrap-thread", true);
      if (!fixtureGetManager || !coordinationBroadcast) throw new Error("Peer fixture unavailable");
      const managers = [fixtureGetManager("local"), fixtureGetManager("remote-host")];
      for (const manager of managers) activities.push(manager.retainActiveConversation("thread"));
      await flushAsyncWork();
      invokeRecords = [];
      coordinationBroadcast("clientStatusChanged", {
        sourceClientId: "router",
        params: { clientId: "new-peer", clientType: "app", status: "connected" },
      });
      await flushAsyncWork();
      expect(
        invokeRecords
          .filter((record) => record.channel === "peer:threadStreamFollowingChanged")
          .map((record) => record.args[0]),
      ).toEqual([
        {
          params: { conversationId: "thread", hostId: "local", following: true },
          targetClientIds: ["new-peer"],
        },
        {
          params: { conversationId: "thread", hostId: "remote-host", following: true },
          targetClientIds: ["new-peer"],
        },
      ]);
      invokeRecords = [];
      coordinationBroadcast("clientStatusChanged", {
        sourceClientId: "router",
        params: { clientId: "self-peer", clientType: "app", status: "connected", isSelf: true },
      });
      await flushAsyncWork();
      expect(
        invokeRecords
          .filter((record) => record.channel === "peer:threadStreamFollowingChanged")
          .map((record) => record.args[0]),
      ).toEqual([
        {
          params: { conversationId: "thread", hostId: "local", following: true },
          targetClientIds: undefined,
        },
        {
          params: { conversationId: "thread", hostId: "remote-host", following: true },
          targetClientIds: undefined,
        },
      ]);
      for (const manager of managers) {
        const hostId = manager.getHostId();
        coordinationBroadcast("threadStreamStateChanged", {
          sourceClientId: "new-peer",
          params: {
            hostId,
            conversationId: "thread",
            change: {
              type: "snapshot",
              revision: 1,
              conversationState: {
                ...canonicalFixture(buildConversation("thread", "project-1")),
                hostId,
              },
            },
          },
        });
      }
      expect(managers.map((manager) => manager.getStreamRole("thread"))).toEqual([
        { role: "follower", ownerClientId: "new-peer" },
        { role: "follower", ownerClientId: "new-peer" },
      ]);
      coordinationBroadcast("clientStatusChanged", {
        sourceClientId: "router",
        params: { clientId: "new-peer", clientType: "app", status: "disconnected" },
      });
      expect(managers.map((manager) => manager.readConversation("thread")?.resumeState)).toEqual([
        "needs_resume",
        "needs_resume",
      ]);
      const receivers = managers.map((manager) => vi.spyOn(manager, "receiveCoordination"));
      const reset = { sourceClientId: "router", params: {} };
      coordinationBroadcast("ipcConnectionReset", reset);
      for (const receive of receivers) {
        expect(receive).toHaveBeenCalledExactlyOnceWith("ipcConnectionReset", reset);
        receive.mockRestore();
      }
    } finally {
      for (const activity of activities) activity[Symbol.dispose]();
      bootstrap.destroy();
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    }
  });

  test("control actions follow the conversation owner host instead of the default manager", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      setLocalConversationComposerIntent,
      useCodexAppServerControl,
    } = await import("./local-conversation-store");
    const { createMaitaiStore, MaitaiProvider } = await import("../../lib/maitai");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const controlRef: { current: ReturnType<typeof useCodexAppServerControl> | null } = {
      current: null,
    };
    function Probe() {
      controlRef.current = useCodexAppServerControl("project-1", "remote-thread", "remote-host");
      return null;
    }

    const view = render(
      createElement(MaitaiProvider, {
        store: createMaitaiStore(),
        children: createElement(
          LocalConversationProvider,
          null,
          createElement(NativeFixtureRegistration),
          createElement(Probe),
        ),
      }),
    );
    await settleAsyncRender();
    if (!fixtureGetManager) throw new Error("Peer fixture unavailable");
    const localManager = trackNativeTestManager(fixtureGetManager("local"));
    const remoteManager = trackNativeTestManager(fixtureGetManager("remote-host"));
    const remoteActivity = remoteManager.retainActiveConversation("remote-thread");
    try {
      const control = controlRef.current;
      if (!control) throw new Error("Control fixture unavailable");
      control.setComposerIntent("remote-thread", {
        prompt: "Route before hydration",
        focusNonce: 1,
      });
      expect(remoteManager.readComposerIntent("remote-thread")?.prompt).toBe(
        "Route before hydration",
      );
      expect(localManager.readComposerIntent("remote-thread")).toBeNull();

      await flushAsyncWork();
      remoteManager.receiveCoordination("threadStreamStateChanged", {
        sourceClientId: "remote-owner",
        params: {
          hostId: "remote-host",
          conversationId: "remote-thread",
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: {
              ...canonicalFixture(buildConversation("remote-thread", "project-1")),
              hostId: "remote-host",
            },
          },
        },
      });
      await settleAsyncRender();

      setLocalConversationComposerIntent("remote-thread", {
        prompt: "Route through hydrated ownership",
        focusNonce: 2,
      });

      expect(remoteManager.readComposerIntent("remote-thread")?.prompt).toBe(
        "Route through hydrated ownership",
      );
      expect(localManager.readComposerIntent("remote-thread")).toBeNull();
    } finally {
      remoteActivity[Symbol.dispose]();
      view.unmount();
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    }
  });

  test("does not acquire activity after its manager is destroyed", async () => {
    const { CodexAppServerManager } = await import("./local-conversation-store");
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    manager.destroy();
    const before = invokeRecords.length;
    expect(() => manager.retainActiveConversation("closed")).toThrow("disposed");
    await flushAsyncWork();
    expect(invokeRecords.slice(before)).toEqual([]);
  });

  test("releases passive history only after the last view closes without unsubscribing another owner", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      snapshotByThread["passive"] = {
        ...buildConversation("passive", "project-1"),
        resumeState: "resumed",
        statusType: "idle",
        turns: [
          {
            threadId: "passive",
            turnId: "turn",
            status: "completed",
            itemIds: ["message"],
            items: [
              {
                threadId: "passive",
                turnId: "turn",
                itemId: "message",
                type: "agentMessage",
                kind: "assistantMessage",
                markdownText: "history",
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        ],
      } as CodexConversationSnapshot;
      const activity = manager.retainActiveConversation("passive");
      const secondView = manager.retainActiveConversation("passive");
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "passive",
        sourceClientId: "other-owner",
        change: { type: "snapshot", revision: 1, conversationState: snapshotByThread["passive"]! },
      });
      expect(manager.readConversation("passive")?.turns).toHaveLength(1);
      activity[Symbol.dispose]();
      await flushAsyncWork();
      expect(manager.readConversation("passive")?.turns).toHaveLength(1);
      secondView[Symbol.dispose]();
      await flushAsyncWork();
      expect(manager.readConversation("passive")?.turns).toHaveLength(0);
      expect(manager.readConversation("passive")?.resumeState).toBe("needs_resume");
      expect(
        manager.readConversation("passive")?.canonicalState?.turnsPagination?.hasLoadedOldest,
      ).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test.each([false, true])(
    "native unsubscribe retains history only if reactivated during I/O: %s",
    async (reactivate) => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      vi.useFakeTimers();
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      let resolveUnsubscribe!: () => void;
      const unsubscribed = new Promise<void>((resolve) => {
        resolveUnsubscribe = resolve;
      });
      nativeUnsubscribeHandler = () => unsubscribed;
      let activity: Disposable | undefined;
      try {
        resumeThreadResult = {
          ...buildConversation("expired", "project-1"),
          turns: [
            { threadId: "expired", turnId: "turn", status: "completed", itemIds: [], items: [] },
          ],
        };
        await manager.requestThreadStreamResume("expired");
        setTestFollowers("expired", []);
        invokeRecords = [];
        await vi.advanceTimersByTimeAsync(10_800_001);
        expect(
          invokeRecords.filter(
            (record) =>
              record.channel === "codex:app-server:request" &&
              (record.args[0] as { request?: { method?: string } }).request?.method ===
                "thread/unsubscribe",
          ),
        ).toHaveLength(1);
        if (reactivate) activity = manager.retainActiveConversation("expired");
        resolveUnsubscribe();
        await vi.advanceTimersByTimeAsync(1);
        expect(manager.readConversation("expired")?.resumeState).toBe("needs_resume");
        expect(manager.readConversation("expired")?.turns).toHaveLength(reactivate ? 1 : 0);
        expect(manager.getStreamRole("expired")).toBeNull();
      } finally {
        resolveUnsubscribe();
        activity?.[Symbol.dispose]();
        nativeUnsubscribeHandler = null;
        resumeThreadResult = null;
        manager.destroy();
        vi.useRealTimers();
      }
    },
  );

  test("keeps live state local without followers and supplies a fresh snapshot when one attaches", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      resumeThreadResult = buildConversation("thread-local-only", "project-1");
      await manager.requestThreadStreamResume("thread-local-only");
      setTestFollowers("thread-local-only", [], "local");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-1:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "thread/name/updated",
          params: { threadId: "thread-local-only", threadName: "Latest local state" },
        },
      });
      await flushAsyncWork();
      expect(
        invokeRecords.filter((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toHaveLength(0);
      expect((await manager.requestThreadStreamSnapshot("thread-local-only"))?.threadName).toBe(
        "Latest local state",
      );
      emitTestFollowing("thread-local-only", "test-follower", true, "local");
      await flushAsyncWork();
      const publishes = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      expect(publishes).toHaveLength(1);
      expect(publishes[0]?.args[0]).toMatchObject({
        change: { type: "snapshot", conversationState: { title: "Latest local state" } },
      });
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-2:2",
        occurrenceToken: 2,
        hostId: "local",
        notification: {
          method: "thread/name/updated",
          params: { threadId: "thread-local-only", threadName: "Changed while followed" },
        },
      });
      await flushAsyncWork();
      expect(
        invokeRecords.filter((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toHaveLength(2);
      setTestFollowers("thread-local-only", ["new-follower"], "local");
      await flushAsyncWork();
      const catchup = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      expect(catchup).toHaveLength(3);
      expect(catchup[1]?.args[0]).toMatchObject({
        change: {
          type: "patches",
          patches: expect.arrayContaining([
            expect.objectContaining({ value: "Changed while followed" }),
          ]),
        },
      });
      expect(catchup[2]?.args[0]).toMatchObject({
        change: { type: "snapshot", conversationState: { title: "Changed while followed" } },
      });
    } finally {
      manager.destroy();
      resumeThreadResult = null;
    }
  });

  test("a manager retains prose from more than 1024 command keys across conversations", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    const threadIds = ["thread-frame-a", "thread-frame-b"];
    try {
      for (const threadId of threadIds) {
        const items = Array.from({ length: 513 }, (_, index) =>
          buildAssistantMessage(threadId, "turn", `message-${index}`, ""),
        );
        resumeThreadResult = {
          ...buildConversation(threadId, "project-1"),
          turns: [
            {
              threadId,
              turnId: "turn",
              status: "inProgress",
              itemIds: items.map((item) => item.itemId),
              items,
            },
          ],
        };
        await manager.requestThreadStreamResume(threadId);
      }
      await act(async () => {
        for (const threadId of threadIds) {
          for (let index = 0; index < 513; index += 1) {
            dispatchCodexAppServerMessage("native-notification", {
              type: "nativeNotification",
              generation: resumeThreadGeneration,
              occurrenceId: `native-3:${index + 1}`,
              occurrenceToken: index + 1,
              hostId: "local",
              notification: {
                method: "item/agentMessage/delta",
                params: { threadId, turnId: "turn", itemId: `message-${index}`, delta: "x" },
              },
            });
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
        await flushAsyncWork(4);
      });
      for (const threadId of threadIds) {
        expect(manager.readConversationStreamRole(threadId)).toBe("owner");
        expect(
          manager.readConversation(threadId)?.turns[0]?.items.map((item) => item.markdownText),
        ).toEqual(Array.from({ length: 513 }, () => "x"));
      }
    } finally {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      (record) => record.channel === "codex:thread:native-session:prepare",
    );
    const startInput = startCall?.args[0] as
      | {
          promptInput?: {
            text?: string;
            textAttachments?: Array<{
              text?: string;
            }>;
          };
        }
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    await manager.startThreadForSession({
      firstSubmission: createCodexFirstSubmissionIdentity(),
      projectId: "project-1",
      sessionId: "session-1",
      prompt: "Build title parity",
      skipAutoTitleGeneration: true,
    });
    await settleAsyncRender();

    const startCall = invokeRecords.find(
      (record) => record.channel === "codex:thread:native-session:prepare",
    );
    const startInput = startCall?.args[0] as
      | {
          skipAutoTitleGeneration?: boolean;
        }
      | undefined;
    expect(startInput?.skipAutoTitleGeneration).toBe(true);
    expect(invokeRecords.some((record) => record.channel === "codex:thread:title:generate")).toBe(
      false,
    );
  });

  test("installs the native session start response before accepting its durable summary", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        (record) => record.channel === "codex:thread:native-session:prepare",
      );
      const snapshotCallIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:native-session:execute",
      );
      const startInput = invokeRecords[startCallIndex]?.args[0] as
        | {
            permissionMode?: string;
          }
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
    let acceptedReplica = canonicalFixture(adoptedConversation);
    let acceptedRevision: number | undefined;
    let acceptedPublicationCount = 0;
    let publicationError: unknown = null;
    ownerStreamPublishHandler = (input) => {
      try {
        const { change } = input as {
          change:
            | { type: "snapshot"; revision: number; conversationState: typeof acceptedReplica }
            | {
                type: "patches";
                revision: number;
                baseRevision: number;
                patches: CodexConversationStateUpdate[];
              };
        };
        if (change.type === "snapshot") acceptedReplica = change.conversationState;
        else {
          if (acceptedRevision !== undefined) expect(change.baseRevision).toBe(acceptedRevision);
          expect(change.revision).toBe(change.baseRevision + 1);
          acceptedReplica = applyPatches(acceptedReplica, change.patches);
        }
        acceptedRevision = change.revision;
        acceptedPublicationCount += 1;
      } catch (error) {
        publicationError = error;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      expect(residentConversationTurns(optimistic?.canonicalState)).toHaveLength(1);
      expect(optimistic?.canonicalState?.threadRuntimeStatus).toEqual({
        type: "active",
        activeFlags: [],
      });
      expect(optimistic?.updatedAt).toBe(optimistic?.canonicalState?.updatedAt);
      expect(optimistic?.canonicalState?.recencyAt).toBe(optimistic?.canonicalState?.updatedAt);
      expect(optimistic?.canonicalState?.updatedAt).toBe(
        residentConversationTurns(optimistic?.canonicalState)[0]?.turnStartedAtMs,
      );
      expect(
        residentConversationTurns(optimistic?.canonicalState)[0]?.params.clientUserMessageId,
      ).toBe(clientUserMessageId);
      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:prepare")).toBe(
        false,
      );
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:snapshot:request"),
      ).toBe(false);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:turn:native-fresh:execute" &&
            (record.args[0] as { threadId: string; launchId: string }).threadId === threadId &&
            (record.args[0] as { launchId: string }).launchId === launchId,
        ),
      ).toBe(true);

      expect(
        residentConversationTurns(manager.readConversation(threadId)?.canonicalState)[0]?.turnId,
      ).toBe(null);

      setTestFollowers(threadId, ["fresh-observer"]);
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
            residentConversationTurns(manager.readConversation(threadId)?.canonicalState)[0]
              ?.turnId === "turn-owner-start"
          ) {
            break;
          }
        }
      });
      expect(
        residentConversationTurns(manager.readConversation(threadId)?.canonicalState)[0]?.turnId,
      ).toBe("turn-owner-start");
      await flushAsyncWork(3);
      expect(publicationError).toBeNull();
      expect(acceptedPublicationCount).toBeGreaterThanOrEqual(2);
      expect(residentConversationTurns(acceptedReplica)[0]?.turnId).toBe("turn-owner-start");
    } finally {
      probe.unmount();
      releaseTurnStart();
      freshThreadAdoptionResult = null;
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
    ownerTurnStartError = new Error("first turn was rejected");

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      expect(manager.readConversation(threadId)?.turns).toEqual([]);
    } finally {
      freshThreadAdoptionResult = null;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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

  test("routes a new worktree launch through the owning manager host", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    startThreadForSessionResult = {
      kind: "pending",
      pendingWorktreeId: "ssh:builder:pending-session-start",
      clientThreadId: "client-new-thread:pending-session-start",
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("ssh:builder"));
    try {
      await manager.startThreadForSession({
        firstSubmission: createCodexFirstSubmissionIdentity(),
        projectId: "project-1",
        sessionId: "session-1",
        prompt: "Build on the selected host",
        runInTarget: "newWorktree",
      });

      const startCall = invokeRecords.find(
        (record) => record.channel === "codex:thread:start-for-session",
      );
      expect(startCall?.args[0]).toMatchObject({ executionHostId: "ssh:builder" });
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
    await settleAsyncRender();
    expect(textContent(container)).toBe("none:none:none");

    await act(async () => {
      hostMessageListener?.({
        type: "sharedObjectUpdated",
        hostId: "local",
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    const active = sessionFirstSubmissionOwner.begin({
      backend: "codex",
      originProjectId: "project-1",
      originSessionId: "session-1",
      prompt: "Newest attempt",
    });

    const publishProgress = (launchId: string, phase: "startingThread" | "failed") => {
      dispatchCodexAppServerMessage("shared-object-updated", {
        hostId: "local",
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
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
    await settleAsyncRender();

    expect(
      invokeCalls
        .filter((channel) => channel !== "codex:queued-messages:read")
        .sort()
        .join(","),
    ).toBe(
      "codex:account:read,codex:app-server:host-context,codex:app-server:request,codex:connection:status,codex:dictation:state:read,codex:dictation:state:read",
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
        createElement(NativeFixtureRegistration),
        createElement("div", null, createElement(ConversationProbe), createElement(SummaryProbe)),
      ),
    );
    await settleAsyncRender();

    conversationRenderCount = 0;
    summaryRenderCount = 0;

    await act(async () => {
      const snapshot = buildConversation("thread-2", "project-2");
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-2",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: snapshot,
        },
        version: 1,
        sourceClientId: "test-owner",
      });
    });
    await settleAsyncRender();

    expect(String(conversationRenderCount)).toBe("0");
    expect(String(summaryRenderCount)).toBe("0");

    await act(async () => {
      const snapshot = buildConversation("thread-1", "project-1");
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-1",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: snapshot,
        },
        version: 1,
        sourceClientId: "test-owner",
      });
    });
    await settleAsyncRender();

    expect(readLocalConversation("thread-1")?.threadId ?? "none").toBe("thread-1");
    expect(summaryRenderCount).toBe(1);

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
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-1",
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCanonicalFixturePatches(previousConversation, nextConversation),
        },
        version: 2,
        sourceClientId: "test-owner",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
        hostId: "local",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCanonicalFixturePatches(baseConversation, nextConversation),
        },
        sourceClientId: "test-owner",
      });

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("hello");
    } finally {
      manager.destroy();
    }
  });

  test("applies follower prose before same-stack completion and renders the final state", async () => {
    invokeCalls = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { LocalConversationProvider, __resetLocalConversationStoreForTests, useConversation } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const renderStates: string[] = [];
    let managerRef: CodexAppServerManagerInstance | null = null;
    function Probe() {
      managerRef = useDefaultCodexAppServerManager();
      const conversation = useConversation("thread-1");
      const item = conversation?.turns[0]?.items[0];
      if (item) {
        renderStates.push(`${item.status ?? "none"}:${item.markdownText ?? ""}`);
      }
      return createElement("div", null, item?.markdownText ?? "");
    }

    const rendered = render(
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
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

      const baseState = canonicalFixture(baseConversation);
      const [startedState] = produceWithPatches(baseState, (draft) => {
        mutateCodexConversationEvent(
          draft,
          {
            type: "notification",
            notification: {
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                startedAtMs: 1,
                item: {
                  id: "assistant-1",
                  type: "agentMessage",
                  text: "",
                  phase: null,
                  memoryCitation: null,
                  delivery: null,
                  questions: null,
                },
              },
            },
          },
          { now: () => 1, createId: () => "fixture-item" },
        );
      });
      baseConversation.canonicalState = startedState;
      streamingConversation.canonicalState = produceWithPatches(startedState, (draft) => {
        mutateCodexConversationEvent(
          draft,
          {
            type: "notification",
            notification: {
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread-1",
                turnId: "turn-1",
                itemId: "assistant-1",
                delta: "hello",
              },
            },
          },
          { now: () => 2, createId: () => "fixture-item" },
        );
      })[0];
      completedConversation.canonicalState = produceWithPatches(
        streamingConversation.canonicalState,
        (draft) => {
          mutateCodexConversationEvent(
            draft,
            {
              type: "notification",
              notification: {
                method: "item/completed",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  completedAtMs: 3,
                  item: {
                    id: "assistant-1",
                    type: "agentMessage",
                    text: "hello",
                    phase: null,
                    memoryCitation: null,
                    delivery: null,
                    questions: null,
                  },
                },
              },
            },
            { now: () => 3, createId: () => "fixture-item" },
          );
        },
      )[0];

      await act(async () => {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
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
          hostId: "local",
          conversationId: "thread-1",
          version: 2,
          change: {
            type: "patches",
            baseRevision: 1,
            revision: 2,
            patches: buildCanonicalFixturePatches(baseConversation, streamingConversation),
          },
          sourceClientId: "owner-window",
        });
        const intermediate = (managerRef as CodexAppServerManagerInstance | null)?.readConversation(
          "thread-1",
        )?.turns[0]?.items[0];
        expect(intermediate?.markdownText).toBe("hello");
        expect(intermediate?.status).toBe("inProgress");
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread-1",
          version: 3,
          change: {
            type: "patches",
            baseRevision: 2,
            revision: 3,
            patches: buildCanonicalFixturePatches(streamingConversation, completedConversation),
          },
          sourceClientId: "owner-window",
        });
      });
      await settleAsyncRender();

      expect(renderStates.includes("completed:hello")).toBe(true);
    } finally {
      rendered.unmount();
    }
  });

  test("followers open live questions from validated owner patches but never from hydration", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      const base = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          { threadId: "thread-1", turnId: "turn-1", status: "inProgress", itemIds: [], items: [] },
        ],
      });
      const canonical = base.canonicalState!;
      const turn = canonical.turns[0]!;
      const withQuestion = (id: string) => ({
        ...base,
        canonicalState: {
          ...canonical,
          turns: [
            {
              ...turn,
              items: [
                {
                  type: "agentMessage" as const,
                  id,
                  delivery: "async" as const,
                  phase: "final_answer" as const,
                  text: "Which scope?",
                  memoryCitation: null,
                  questions: [{ title: "Which scope?", options: null }],
                },
              ],
            },
          ],
        },
      });
      const hydrated = withQuestion("history-question");
      await act(async () => {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread-1",
          sourceClientId: "owner-a",
          version: 1,
          change: { type: "snapshot", revision: 1, conversationState: hydrated },
        });
      });
      expect(manager.asyncQuestions.read("thread-1").openIds).toEqual([]);
      const live = withQuestion("live-question");
      await act(async () => {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread-1",
          sourceClientId: "owner-a",
          version: 2,
          change: {
            type: "patches",
            baseRevision: 1,
            revision: 2,
            patches: buildCanonicalFixturePatches(hydrated, live),
          },
        });
      });
      expect(manager.asyncQuestions.read("thread-1").selectedId).toBe(
        '["request_user_input_async","live-question",0]',
      );
      manager.asyncQuestions.close("thread-1");
      await act(async () => {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread-1",
          sourceClientId: "owner-a",
          version: 3,
          change: { type: "snapshot", revision: 3, conversationState: live },
        });
      });
      expect(manager.asyncQuestions.read("thread-1").openIds).toEqual([]);
    } finally {
      manager.destroy();
    }
  });

  test("two managers share owner stream state and recover owner loss from bundle 40400-40680", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = { ok: true };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const followerManager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      // The owner is the sender in this fixture; routed stream publications reach only its follower window.
      ownerManager = trackNativeTestManager(new CodexAppServerManager("local"));
      await ownerManager.requestThreadStreamResume("thread-1");
      await flushAsyncWork();
      emitTestFollowing("thread-1", "second-window", true);
      await flushAsyncWork();

      const ownerSnapshotPublish = invokeRecords.findLast(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      expect(Boolean(ownerSnapshotPublish)).toBe(true);
      const ownerSnapshotInput = ownerSnapshotPublish?.args[0] as
        | {
            change?: TestStreamFixtureEvent["change"];
          }
        | undefined;
      if (ownerSnapshotInput?.change?.type !== "snapshot") {
        throw new Error("Missing owner bootstrap snapshot");
      }
      dispatchTestThreadStreamStateChanged(followerManager, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: ownerSnapshotInput.change,
        sourceClientId: "owner-a",
      });
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-5:10",
        occurrenceToken: 10,
        hostId: "local",
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

      await flushAsyncWork();
      const ownerRequestPublish = invokeRecords.find(
        (record) =>
          record.channel === "peer:threadStreamStateChanged" &&
          (
            record.args[0] as
              | {
                  change?: {
                    type?: string;
                  };
                }
              | undefined
          )?.change?.type === "patches",
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

      dispatchTestThreadStreamStateChanged(followerManager, {
        hostId: "local",
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
        (record) => record.channel === "peer:requestThreadFollower",
      );
      const responsePayload = responseAction?.args[0] as
        | {
            request?: {
              method?: string;
              params?: {
                requestId?: string;
                response?: {
                  answers?: Record<string, { answers?: string[] }>;
                };
              };
            };
          }
        | undefined;
      expect(responded).toBe(true);
      expect(responsePayload?.request?.method).toBe("thread-follower-submit-user-input");
      expect(responsePayload?.request?.params?.requestId).toBe("input-1");
      expect(responsePayload?.request?.params?.response?.answers?.q1?.answers?.[0]).toBe("A");
      expect(invokeRecords.some((record) => record.channel === "codex:user-input:respond")).toBe(
        false,
      );
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-6:11",
        occurrenceToken: 11,
        hostId: "local",
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
        return (
          record.channel === "peer:threadStreamStateChanged" &&
          (record.args[0] as { change?: { type?: string } }).change?.type === "patches"
        );
      })?.args[0] as
        | {
            change?: TestStreamFixtureEvent["change"];
          }
        | undefined;
      if (!ownerLivePublish?.change) {
        throw new Error("Missing owner live publication");
      }
      dispatchTestThreadStreamStateChanged(followerManager, {
        hostId: "local",
        conversationId: "thread-1",
        version: 3,
        change: ownerLivePublish.change,
        sourceClientId: "owner-a",
      });

      expect(ownerManager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "live",
      );
      expect(followerManager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "live",
      );

      followerActionResult = { interruptedTurnId: "turn-1" };
      const interrupted = await followerManager.interruptTurn("thread-1", "turn-1");
      const followerAction = invokeRecords.find(
        (record) => record.channel === "peer:requestThreadFollower",
      );
      const followerPayload = followerAction?.args[0] as
        | {
            request?: {
              method?: string;
              params?: {
                type?: string;
                turnId?: string;
              };
            };
          }
        | undefined;
      expect(interrupted).toBe(true);
      expect(followerPayload?.request).toMatchObject({
        method: "thread-follower-interrupt-turn",
        params: { conversationId: "thread-1", mode: "user-stop", expectedTurnId: "turn-1" },
      });

      coordinationBroadcast?.("clientStatusChanged", {
        sourceClientId: "owner-a",
        params: { clientId: "owner-a", clientType: "app", status: "disconnected" },
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
      change: TestStreamFixtureEvent["change"];
      sourceClientId: string | null;
    }> = [];
    const dispatchStreamState = (
      conversationId: string,
      change: TestStreamFixtureEvent["change"],
      sourceClientId: string | null = ownerClientId,
    ) => {
      hostMessageVersion += 1;
      streamEvents.push({
        conversationId,
        change,
        sourceClientId,
      });
      dispatchTestThreadStreamStateChanged(followerManager, {
        hostId: "local",
        conversationId,
        version: hostMessageVersion,
        change,
        sourceClientId,
      });
    };
    const followerManager = trackNativeTestManager(new CodexAppServerManager("local"));
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
          change?: TestStreamFixtureEvent["change"];
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
      // The owner is the sender in this fixture; routed stream publications reach only its follower window.
      ownerManager = trackNativeTestManager(new CodexAppServerManager("local"));
      followerActionHandler = async (input) => {
        if (!ownerManager) throw new Error("Missing owner action target");
        const payload = input as {
          request: Parameters<CodexAppServerManagerInstance["handleThreadFollowerRequest"]>[0];
        };
        return (await ownerManager.handleThreadFollowerRequest(payload.request)).result;
      };
      await ownerManager.requestThreadStreamResume("thread-1");
      await flushAsyncWork(2);

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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-7:19",
        occurrenceToken: 19,
        hostId: "local",
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-replacement",
            item: {
              questions: null,
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-8:20",
        occurrenceToken: 20,
        hostId: "local",
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

      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-9:30",
        occurrenceToken: 30,
        hostId: "local",
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-10:40",
        occurrenceToken: 40,
        hostId: "local",
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-replacement",
            item: {
              questions: null,
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-11:41",
        occurrenceToken: 41,
        hostId: "local",
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

      coordinationBroadcast?.("clientStatusChanged", {
        sourceClientId: ownerClientId,
        params: { clientId: ownerClientId, clientType: "app", status: "disconnected" },
      });
      expect(followerManager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(ownerManager.readConversation("thread-1")?.resumeState).toBe("resumed");
      expect(streamEvents.some((event) => event.sourceClientId === null)).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:edit-last-user-turn"),
      ).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:turn:start")).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:turn:native-steer:execute"),
      ).toBe(true);
      const queuedWrites = invokeRecords.filter(
        (record) =>
          record.channel === "peer:requestThreadFollower" &&
          (record.args[0] as { request: { method: string } }).request.method ===
            "thread-follower-set-queued-follow-ups-state",
      );
      expect(queuedWrites).toHaveLength(2);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
        hostId: "local",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 0,
          revision: 2,
          patches: buildCanonicalFixturePatches(baseConversation, nextConversation),
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
        hostId: "local",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCanonicalFixturePatches(baseConversation, nextConversation),
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "patches",
          baseRevision: 0,
          revision: 1,
          patches: buildCanonicalFixturePatches(baseConversation, nextConversation),
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

  test("drops patch application failures without requesting a replacement snapshot", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
        hostId: "local",
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
            record.channel === "codex:thread:stream-resync:request" ||
            (record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1"),
        ),
      ).toBe(false);
    } finally {
      manager.destroy();
    }
  });

  test("an incoming snapshot replaces an owner and a later snapshot can rewind its state", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    resumeThreadResult = buildConversation("thread-1", "project-1");
    try {
      await manager.requestThreadStreamResume("thread-1");
      expect(manager.getStreamRole("thread-1")?.role).toBe("owner");
      for (const [revision, sourceClientId, title, expectedTitle] of [
        [9, "peer-a", "**First** [snapshot](https://example.com)", "First snapshot"],
        [1, "peer-b", "Replacement snapshot", "Replacement snapshot"],
      ] as const) {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread-1",
          version: revision,
          sourceClientId,
          change: {
            type: "snapshot",
            revision,
            conversationState: { ...resumeThreadResult, threadName: title },
          },
        });
        expect(manager.getStreamRole("thread-1")?.role).toBe("follower");
        expect(manager.readConversation("thread-1")?.threadName).toBe(expectedTitle);
      }
    } finally {
      resumeThreadResult = null;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCanonicalFixturePatches(baseConversation, staleMainConversation),
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-12:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
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
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("owner");
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toEqual(expect.any(Number));
      expect(publishInput?.change?.revision).toBe(Number(publishInput?.change?.baseRevision) + 1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("native resume replays buffered metadata before publishing its completed snapshot", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = buildConversation("buffered", "project-1");
    let release!: () => void;
    nativeResumeResponseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    invokeRecords = [];
    try {
      const resume = manager.requestThreadStreamResume("buffered");
      await flushAsyncWork();
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "buffered-name",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "thread/name/updated",
          params: { threadId: "buffered", threadName: "Arrived during resume" },
        },
      });
      expect(manager.readConversation("buffered")).toBeNull();
      release();
      await resume;
      const published = invokeRecords
        .filter((record) => record.channel === "peer:threadStreamStateChanged")
        .map(
          (record) =>
            record.args[0] as {
              change: {
                type: string;
                conversationState?: import("../../../shared/types").CodexCanonicalConversationState;
              };
            },
        )
        .filter((record) => record.change.type === "snapshot");
      expect(published.at(-1)?.change.conversationState?.title).toBe("Arrived during resume");
      expect(manager.readConversation("buffered")?.threadName).toBe("Arrived during resume");
      const accept = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:resume:accept",
      );
      const finalSnapshot = invokeRecords.findLastIndex(
        (record) =>
          record.channel === "peer:threadStreamStateChanged" &&
          (record.args[0] as { change: { type: string } }).change.type === "snapshot",
      );
      expect(accept).toBeGreaterThanOrEqual(0);
      expect(finalSnapshot).toBeGreaterThan(accept);
    } finally {
      release();
      nativeResumeResponseGate = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("resume settles ownership after durable acceptance and publishes without another await", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const threadId = "resume-acceptance-owner";
    resumeThreadResult = withCanonicalState(buildConversation(threadId, "project-1"));
    let release!: () => void;
    nativeResumeAcceptanceGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    invokeRecords = [];
    try {
      const resume = manager.requestThreadStreamResume(threadId);
      await waitForCondition(
        () => invokeRecords.some((record) => record.channel === "codex:thread:resume:accept"),
        1000,
      );
      dispatchTestThreadStreamStateChanged(manager, {
        hostId: "local",
        conversationId: threadId,
        sourceClientId: "other-recovering-window",
        change: { type: "snapshot", revision: 8, conversationState: resumeThreadResult },
      });
      expect(manager.readConversationStreamRole(threadId)).toBe("follower");
      const beforePublication = invokeRecords.length;
      release();
      expect((await resume)?.resumeState).toBe("resumed");
      expect(manager.readConversationStreamRole(threadId)).toBe("owner");
      const snapshot = invokeRecords
        .slice(beforePublication)
        .findLast(
          (record) =>
            record.channel === "peer:threadStreamStateChanged" &&
            (record.args[0] as { change: { type: string } }).change.type === "snapshot",
        );
      expect(snapshot?.args[0]).toMatchObject({
        conversationId: threadId,
        change: {
          type: "snapshot",
          conversationState: { id: threadId, resumeState: "resumed" },
        },
      });
    } finally {
      release();
      nativeResumeAcceptanceGate = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("renderer waits for a recovering owner before reusing its accepted baseline", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadRole = "follower";
    deferFollowerSnapshot = true;
    resumeThreadOwnerClientId = "renderer-existing-owner";
    resumeThreadRevision = 12;
    const acceptedBaseline = withCanonicalState(
      buildConversation("thread-resume-follower", "project-1"),
    );
    resumeThreadResult = acceptedBaseline;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    const view = manager.retainActiveConversation("thread-resume-follower");
    try {
      await waitForCondition(
        () =>
          invokeRecords.some((record) => record.channel === "peer:threadStreamFollowingChanged"),
        1000,
      );
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-resume-follower",
        sourceClientId: "renderer-existing-owner",
        change: {
          type: "snapshot",
          revision: 12,
          conversationState: {
            ...acceptedBaseline,
            resumeState: "resuming",
            canonicalState: { ...acceptedBaseline.canonicalState!, resumeState: "resuming" },
          },
        },
      });
      expect(await manager.requestThreadStreamResume("thread-resume-follower")).toBeNull();
      expect(manager.readConversation("thread-resume-follower")?.resumeState).toBe("resuming");
      expect(manager.readConversationStreamRole("thread-resume-follower")).toBe("follower");
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-resume-follower",
        version: 13,
        sourceClientId: "renderer-existing-owner",
        change: { type: "snapshot", revision: 13, conversationState: acceptedBaseline },
      });
      const result = await manager.requestThreadStreamResume("thread-resume-follower");

      expect(result?.threadId).toBe("thread-resume-follower");
      expect(manager.readConversationStreamRole("thread-resume-follower")).toBe("follower");
      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:prepare")).toBe(
        false,
      );
      expect(
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
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
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-resume-follower",
        version: 14,
        sourceClientId: "renderer-existing-owner",
        change: {
          type: "patches",
          baseRevision: 13,
          revision: 14,
          patches: buildCanonicalFixturePatches(acceptedBaseline, nextConversation),
        },
      });
      expect(manager.readConversation("thread-resume-follower")?.threadName).toBe(
        "Follower received the first patch after resume",
      );
    } finally {
      view[Symbol.dispose]();
      deferFollowerSnapshot = false;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
          record.channel === "codex:thread:resume:prepare" && record.args[0] === child.threadId,
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

  test("selected subagent hydration reports a missing native resume result", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await expect(
        manager.hydrateSelectedSubagent({
          rootThreadId: "thread-root",
          threadId: "thread-unavailable",
        }),
      ).resolves.toMatchObject({
        threadId: "thread-unavailable",
        outcome: "failed",
        canInteract: false,
        errorMessage: "Native resume fixture unavailable",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      const input = rawInput as {
        rootThreadId: string;
        threadId: string;
      };
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        invokeRecords.filter((record) => record.channel === "codex:thread:resume:prepare"),
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
        invokeRecords.filter((record) => record.channel === "codex:thread:resume:prepare"),
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        invokeRecords.filter((record) => record.channel === "codex:thread:resume:prepare"),
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
      const input = rawInput as {
        rootThreadId: string;
        threadId: string;
      };
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        invokeRecords.filter((record) => record.channel === "codex:thread:resume:prepare"),
      ).toHaveLength(1);
    } finally {
      selectedSubagentHydrateHandler = null;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      resumeThreadResult = { ...localView, requests: [] };
      await manager.requestThreadStreamResume(localView.threadId);
      const request = localView.requests[0];
      if (request?.type !== "nodexAgentAuthorization")
        throw new Error("Missing authorization fixture");
      const response = manager.requestNodexAgentAuthorization(request);
      invokeRecords = [];
      setTestFollowers(localView.threadId, ["new-viewer"]);
      await flushAsyncWork();
      const publish = invokeRecords.find(
        (record) => record.channel === "peer:threadStreamStateChanged",
      )?.args[0] as
        | {
            change?: {
              type?: string;
              conversationState?: import("../../../shared/types").CodexCanonicalConversationState;
            };
          }
        | undefined;
      expect(
        manager.readConversation(localView.threadId)?.requests.map((request) => request.requestId),
      ).toEqual(["nodex-auth-private"]);
      expect(publish?.change?.type).toBe("snapshot");
      expect(publish?.change?.conversationState?.requests).toEqual([]);
      await manager.respondNodexAgentAuthorization(
        request.requestId,
        { decision: "deny" },
        localView.threadId,
      );
      expect(await response).toEqual({ decision: "deny" });
    } finally {
      resumeThreadResult = null;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
          record.channel === "codex:thread:resume:prepare" &&
          record.args[0] === "thread-resume-single-flight",
      ).length;
      expect(resumeRequestCount).toBe(1);

      resolveResume(baseConversation);
      const [firstResult, secondResult] = await Promise.all([first, second]);
      const nativeResumeCount = invokeRecords.filter(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "thread/resume",
      ).length;
      const ownerSnapshotPublishCount = invokeRecords.filter((record) => {
        if (record.channel !== "peer:threadStreamStateChanged") return false;
        const input = record.args[0] as {
          change?: {
            type?: string;
          };
        };
        return input.change?.type === "snapshot";
      }).length;

      expect(firstResult?.threadId ?? "").toBe("thread-resume-single-flight");
      expect(secondResult?.threadId ?? "").toBe("thread-resume-single-flight");
      expect(nativeResumeCount).toBe(1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchCodexAppServerMessage("shared-object-updated", {
        hostId: "local",
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
        hostId: "local",
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

  test("native resume failure releases its prepared receipt and leaves cached history resumable", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    resumeThreadResult = buildConversation("resume-failed", "project-1");
    let rejectResponse!: (error: Error) => void;
    nativeResumeResponseGate = new Promise<void>((_resolve, reject) => {
      rejectResponse = reject;
    });
    try {
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "resume-failed",
        sourceClientId: "previous-owner",
        change: { type: "snapshot", revision: 1, conversationState: resumeThreadResult },
      });
      disconnectFixtureOwner(manager, "resume-failed");
      invokeRecords = [];
      const result = manager.requestThreadStreamResume("resume-failed").then(
        () => null,
        (error) => error,
      );
      await flushAsyncWork();
      rejectResponse(new Error("Native resume failed"));
      expect(await result).toMatchObject({ message: "Native resume failed" });
      expect(
        invokeRecords.find((record) => record.channel === "codex:thread:resume:release")?.args[0],
      ).toBe("resume:resume-failed");
      expect(manager.readConversation("resume-failed")?.resumeState).toBe("needs_resume");
      expect(manager.readConversationAttachmentState("resume-failed")).toMatchObject({
        status: "failed",
        message: "Native resume failed",
      });
      expect(
        invokeRecords.filter((record) => record.channel === "codex:thread:resume:accept"),
      ).toEqual([]);
      expect(
        invokeRecords.filter((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toEqual([]);
    } finally {
      nativeResumeResponseGate = null;
      resumeThreadResult = null;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-14:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const publishInput = publishRecord?.args[0] as
        | {
            conversationId?: string;
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("hello");
      expect(publishInput?.conversationId).toBe("thread-1");
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toEqual(expect.any(Number));
      expect(publishInput?.change?.revision).toBe(Number(publishInput?.change?.baseRevision) + 1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test.each(["resolved", "reply"] as const)(
    "owner request %s preserves requests independently of loaded history",
    async (completion) => {
      invokeRecords = [];
      hostMessageListener = null;
      threadListByProject = {};
      resumeThreadResult = null;
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      try {
        const baseConversation: CodexConversationSnapshot = {
          ...buildConversation("thread-1", "project-1"),
          turns: [],
        };
        resumeThreadResult = baseConversation;
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread-1",
          version: 1,
          change: { type: "snapshot", revision: 1, conversationState: baseConversation },
          sourceClientId: null,
        });
        await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
        invokeRecords = [];

        dispatchCodexAppServerMessage("native-request", {
          type: "nativeRequest",
          generation: resumeThreadGeneration,
          occurrenceId: "native-15:1",
          occurrenceToken: 1,
          hostId: "local",
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
        await flushAsyncWork(4);
        expect(
          manager.readConversation("thread-1")?.canonicalRequests?.map((request) => request.id),
        ).toEqual(["input-without-canonical"]);
        expect(
          manager.readConversation("thread-1")?.requests.map((request) => request.requestId),
        ).toEqual(["input-without-canonical"]);
        expect(
          residentConversationTurns(manager.readConversation("thread-1")?.canonicalState),
        ).toEqual([]);
        if (completion === "reply") {
          await manager.respondUserInput("input-without-canonical", { q1: ["A"] }, "thread-1");
        } else {
          dispatchCodexAppServerMessage("native-notification", {
            type: "nativeNotification",
            generation: resumeThreadGeneration,
            occurrenceId: "native-16:2",
            occurrenceToken: 2,
            hostId: "local",
            notification: {
              method: "serverRequest/resolved",
              params: {
                threadId: "thread-1",
                requestId: "input-without-canonical",
              },
            },
          });
        }
        await flushAsyncWork(4);

        const conversation = manager.readConversation("thread-1");
        expect(conversation?.canonicalState?.requests).toEqual([]);
        expect(conversation?.canonicalRequests).toEqual([]);
        expect(conversation?.requests).toEqual([]);
        expect(conversation?.turns).toEqual([]);
        expect(conversation?.resumeState).toBe(baseConversation.resumeState);
        expect(
          invokeRecords.some((record) => record.channel === "codex:thread:resume:prepare"),
        ).toBe(false);
      } finally {
        resumeThreadResult = null;
        manager.destroy();
      }
    },
  );

  test("native events cannot reconstruct a conversation after resume preparation fails", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    resumeThreadError = new Error("Native resume unavailable");
    try {
      await expect(manager.requestThreadStreamResume("missing")).rejects.toThrow(
        "Native resume unavailable",
      );
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        hostId: "local",
        generation: resumeThreadGeneration,
        occurrenceId: "unattached",
        occurrenceToken: 1,
        notification: {
          method: "item/agentMessage/delta",
          params: {
            threadId: "missing",
            turnId: "turn",
            itemId: "answer",
            delta: "must not reconstruct",
          },
        },
      });
      await flushAsyncWork();
      expect(manager.readConversation("missing")).toBeNull();
      expect(manager.readConversationAttachmentState("missing")).toMatchObject({
        status: "failed",
        message: "Native resume unavailable",
      });
      expect(manager.getStreamRole("missing")).toBeNull();
      expect(
        invokeRecords.filter((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toEqual([]);
    } finally {
      resumeThreadError = null;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-18:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-19:2",
        occurrenceToken: 2,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-20:3",
        occurrenceToken: 3,
        hostId: "local",
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
        | {
            summary?: string[];
            content?: string[];
          }
        | undefined;
      const canonicalPlan = residentConversationTurns(conversation?.canonicalState)[0]?.items.find(
        (item) => item.id === "plan-1" && item.type === "plan",
      );
      const canonicalReasoning = residentConversationTurns(
        conversation?.canonicalState,
      )[0]?.items.find((item) => item.id === "reasoning-1" && item.type === "reasoning");
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );

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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-21:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-22:2",
        occurrenceToken: 2,
        hostId: "local",
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-23:3",
        occurrenceToken: 3,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const clearRecord = invokeRecords.find(
        (record) =>
          (record.channel === "codex:app-server:request" ||
            record.channel === "codex:thread-owner:app-server-request") &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "thread/goal/clear",
      );
      const firstPublish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;
      expect(conversation?.threadGoal ?? null).toBe(null);
      expect(conversation?.completedThreadGoal?.status ?? "").toBe("complete");
      expect(conversation?.canonicalState?.threadGoal ?? null).toBe(null);
      expect(conversation?.canonicalState?.completedThreadGoal?.status ?? "").toBe("complete");
      expect(String(publishRecords.length)).toBe("3");
      expect(firstPublish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(firstPublish?.change?.revision).toBe(Number(firstPublish?.change?.baseRevision) + 1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-24:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              questions: null,
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-25:2",
        occurrenceToken: 2,
        hostId: "local",
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              questions: null,
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const firstPublish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;
      const secondPublish = publishRecords[1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;
      expect(String(publishRecords.length)).toBe("2");
      expect(firstPublish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(firstPublish?.change?.revision).toBe(Number(firstPublish?.change?.baseRevision) + 1);
      expect(secondPublish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(secondPublish?.change?.revision).toBe(Number(secondPublish?.change?.baseRevision) + 1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-26:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-27:2",
        occurrenceToken: 2,
        hostId: "local",
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
      const hidden = residentConversationTurns(manager.readConversation("thread-1")?.canonicalState)
        .find((turn) => turn.turnId === "turn-1")
        ?.items.find((item) => item.id === "review-mode-marker");
      expect(turn?.items.length ?? -1).toBe(0);
      expect(typeof turn?.firstTurnWorkItemStartedAtMs).toBe("number");
      expect(hidden?.type).toBe("exitedReviewMode");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-28:1",
        occurrenceToken: 1,
        hostId: "local",
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
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState)
          .find((turn) => turn.turnId === "turn-1")
          ?.items.find((item) => item.id === "target")?.type,
      ).toBe("enteredReviewMode");

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-29:2",
        occurrenceToken: 2,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-30:3",
        occurrenceToken: 3,
        hostId: "local",
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
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState)
          .find((turn) => turn.turnId === "turn-1")
          ?.items.find((item) => item.id === "target")?.type,
      ).toBe("commandExecution");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-31:1",
        occurrenceToken: 1,
        hostId: "local",
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

  test("a follower preserves a hidden completed placeholder when the owner starts a distinct turn", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      const hydrated = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "placeholder",
            status: "completed",
            itemIds: [],
            items: [],
          },
        ],
      }).canonicalState!;
      const before = {
        ...hydrated,
        turns: [
          {
            ...hydrated.turns[0]!,
            turnId: null,
            items: [
              { id: "hidden", type: "exitedReviewMode" as const, review: "Completed review" },
            ],
          },
        ],
      };
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-1",
        sourceClientId: "owner-a",
        change: { type: "snapshot", revision: 1, conversationState: before },
      });
      const [, patches] = produceWithPatches(before, (draft) => {
        mutateCodexConversationEvent(
          draft,
          {
            type: "notification",
            notification: {
              method: "item/started",
              params: {
                threadId: "thread-1",
                turnId: "next",
                startedAtMs: 200,
                item: {
                  type: "agentMessage",
                  id: "answer",
                  text: "New response",
                  phase: null,
                  memoryCitation: null,
                  delivery: null,
                  questions: null,
                },
              },
            },
          },
          { now: () => 200, createId: () => "fixture" },
        );
      });
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-1",
        sourceClientId: "owner-a",
        change: { type: "patches", baseRevision: 1, revision: 2, patches },
      });
      const state = manager.readConversation("thread-1")?.canonicalState;
      expect(residentConversationTurns(state).map((turn) => turn.turnId)).toEqual([null, "next"]);
      expect(residentConversationTurns(state)[0]?.items[0]?.type).toBe("exitedReviewMode");
      expect(manager.readConversation("thread-1")?.turns[1]?.items[0]?.markdownText).toBe(
        "New response",
      );
    } finally {
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      resumeThreadResult = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        statusType: "active",
        turns: [
          { threadId: "thread-1", turnId: "turn-1", status: "inProgress", itemIds: [], items: [] },
        ],
      });
      await manager.requestThreadStreamResume("thread-1");
      await manager.steerTurn({
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        prompt: heartbeatText,
      });
      const steeringId = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.items.find((item) => item.type === "steeringUserMessage")?.id;
      expect(steeringId).toBeDefined();
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-33:1",
        occurrenceToken: 1,
        hostId: "local",
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
      expect(afterMatchingHeartbeat.map((item) => item.itemId)).toEqual([steeringId]);

      const differentHeartbeatText = heartbeatText.replace(
        "check fixture",
        "check another fixture",
      );
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-34:2",
        occurrenceToken: 2,
        hostId: "local",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      await act(async () => {
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          hostId: "local",
          generation: resumeThreadGeneration,
          occurrenceId: "started-before-deltas",
          occurrenceToken: 100,
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              startedAtMs: Date.now(),
              item: {
                id: "assistant-1",
                type: "agentMessage",
                text: "",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
              },
            },
          },
        });
        await flushAsyncWork();
      });
      invokeRecords = [];
      const beforeDeltas = manager.readConversation("thread-1")?.canonicalState;
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-35:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-36:2",
        occurrenceToken: 2,
        hostId: "local",
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              questions: null,
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const publicationStates = replayCanonicalPublications(publishRecords, beforeDeltas);
      expect(
        publicationStates.some((state) => state.text === delta && state.status === "inProgress"),
      ).toBe(true);
      expect(publicationStates.at(-1)).toEqual({ text: delta, status: "completed" });
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        turns: [],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-37:1",
        occurrenceToken: 1,
        hostId: "local",
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-38:2",
        occurrenceToken: 2,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const firstPublish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;
      const secondPublish = publishRecords[1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;
      expect(String(publishRecords.length)).toBe("2");
      expect(firstPublish?.change?.type).toBe("patches");
      expect(firstPublish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(firstPublish?.change?.revision).toBe(Number(firstPublish?.change?.baseRevision) + 1);
      expect(secondPublish?.change?.type).toBe("patches");
      expect(secondPublish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(secondPublish?.change?.revision).toBe(Number(secondPublish?.change?.baseRevision) + 1);
      expect(manager.readConversation("thread-1")?.statusType).toBe("idle");
      expect(manager.readConversation("thread-1")?.turns[0]?.status).toBe("completed");
      expect(manager.readConversation("thread-1")?.turns[0]?.durationMs).toBe(42);
      expect(
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState)[0]?.status,
      ).toBe("completed");
      expect(
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState)[0]
          ?.durationMs,
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      const baseConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-1", "project-1"),
        statusType: "idle",
        statusActiveFlags: [],
      };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-39:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
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
      expect(manager.readConversation("thread-1")?.statusType).toBe("active");
      expect(manager.readConversation("thread-1")?.statusActiveFlags[0]).toBe("waitingOnApproval");
      expect(manager.readConversation("thread-1")?.threadRuntimeStatus?.type).toBe("active");
      const runtimeStatus = manager.readConversation("thread-1")?.threadRuntimeStatus;
      expect(runtimeStatus?.type === "active" ? runtimeStatus.activeFlags[0] : null).toBe(
        "waitingOnApproval",
      );
      expect(manager.readConversation("thread-1")?.canonicalState?.threadRuntimeStatus.type).toBe(
        "active",
      );
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toEqual(expect.any(Number));
      expect(publishInput?.change?.revision).toBe(Number(publishInput?.change?.baseRevision) + 1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      const beforeUpdatedAt = manager.readConversation("thread-1")?.updatedAt;
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-40:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
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
      expect(manager.readConversation("thread-1")?.turns[0]?.diff).toBe(
        "diff --git a/file.ts b/file.ts",
      );
      expect(
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState)[0]?.diff,
      ).toBe("diff --git a/file.ts b/file.ts");
      expect(manager.readConversation("thread-1")?.updatedAt).toBe(beforeUpdatedAt);
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toEqual(expect.any(Number));
      expect(publishInput?.change?.revision).toBe(Number(publishInput?.change?.baseRevision) + 1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-41:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "thread/name/updated",
          params: {
            threadId: "thread-1",
            threadName: "New name",
          },
        },
      });
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-42:2",
        occurrenceToken: 2,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-43:3",
        occurrenceToken: 3,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const lastPublish = publishRecords[publishRecords.length - 1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              revision?: number;
              baseRevision?: number;
            };
          }
        | undefined;

      expect(conversation?.threadName).toBe("New name");
      expect(conversation?.latestThreadSettings?.model).toBe("gpt-5.4-codex");
      expect(conversation?.latestThreadSettings?.reasoningEffort).toBe("high");
      expect(conversation?.latestThreadSettings?.collaborationMode?.mode).toBe("plan");
      expect(conversation?.latestThreadSettings?.personality).toBe("pragmatic");
      expect(conversation?.latestTokenUsageInfo?.total.totalTokens).toBe(100);
      expect(conversation?.canonicalState?.latestTokenUsageInfo?.total.totalTokens).toBe(100);
      expect(conversation?.canonicalState?.title).toBe("New name");
      expect(conversation?.canonicalState?.latestThreadSettings?.model).toBe("gpt-5.4-codex");
      expect(conversation?.modelProvider).toBe("openai-next");
      expect(conversation?.cwd).toBe("/repo-next");
      expect(conversation?.updatedAt).toBe(baseConversation.updatedAt);
      expect((conversation?.turns[0]?.tokenUsage ?? null) === null).toBe(true);
      expect(publishRecords).toHaveLength(3);
      expect(lastPublish?.change?.type).toBe("patches");
      expect(lastPublish?.change?.revision).toBe(Number(lastPublish?.change?.baseRevision) + 1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner collaboration items carry receiver metadata without receiver history", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      for (const threadId of ["collab-parent", "collab-child"]) {
        resumeThreadResult = withCanonicalState({
          ...buildConversation(threadId, "project-1"),
          threadName: threadId,
          turns: [
            {
              threadId,
              turnId: `${threadId}-turn`,
              status: "inProgress",
              itemIds: [],
              items: [],
            },
          ],
        });
        await manager.requestThreadStreamResume(threadId);
      }
      const childState = manager.readConversation("collab-child")?.canonicalState;
      if (!childState) throw new Error("Expected loaded child");
      await act(async () => {
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-44:1",
          occurrenceToken: 1,
          hostId: "local",
          notification: {
            method: "thread/started",
            params: {
              thread: {
                ...buildRollbackResponseFromConversation(
                  buildConversation("collab-child", "project-1"),
                ).thread,
                name: "Raw server title",
                turns: [],
              },
            },
          },
        });
        await flushAsyncWork();
      });
      await act(async () => {
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-45:1",
          occurrenceToken: 1,
          hostId: "local",
          notification: {
            method: "item/started",
            params: {
              threadId: "collab-parent",
              turnId: "collab-parent-turn",
              startedAtMs: 1000,
              item: {
                id: "spawn-child",
                type: "collabAgentToolCall",
                tool: "spawnAgent",
                status: "inProgress",
                senderThreadId: "collab-parent",
                receiverThreadIds: ["collab-child"],
                prompt: "Inspect the child",
                model: null,
                reasoningEffort: null,
                agentsStates: {},
              },
            },
          },
        });
        await flushAsyncWork();
      });
      const item = residentConversationTurns(
        manager.readConversation("collab-parent")?.canonicalState,
      )
        .flatMap((turn) => turn.items)
        .find((entry) => entry.id === "spawn-child");
      if (item?.type !== "collabAgentToolCall" || !("receiverThreads" in item)) {
        throw new Error("Expected a materialized collaboration item");
      }
      expect(item.receiverThreads[0]?.thread?.name).toBe("Raw server title");
      expect(manager.readConversation("collab-child")?.threadName).toBe("collab-child");
      expect(item.receiverThreads[0]?.thread?.turns).toEqual([]);
      expect(
        residentConversationTurns(manager.readConversation("collab-child")?.canonicalState),
      ).toHaveLength(1);
      await act(async () => {
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-46:2",
          occurrenceToken: 2,
          hostId: "local",
          notification: {
            method: "thread/started",
            params: {
              thread: {
                ...buildRollbackResponseFromConversation(
                  buildConversation("collab-child", "project-1"),
                ).thread,
                name: "Updated raw title",
                agentNickname: "Updated nickname",
                turns: [],
              },
            },
          },
        });
        await flushAsyncWork();
      });
      const refreshed = residentConversationTurns(
        manager.readConversation("collab-parent")?.canonicalState,
      )
        .flatMap((turn) => turn.items)
        .find((entry) => entry.id === "spawn-child");
      if (refreshed?.type !== "collabAgentToolCall" || !("receiverThreads" in refreshed)) {
        throw new Error("Expected refreshed receiver");
      }
      expect(refreshed.receiverThreads[0]?.thread?.name).toBe("Updated raw title");
      expect(manager.readConversation("collab-child")?.agentNickname).toBe("Updated nickname");
      expect(manager.readConversation("collab-child")?.threadName).toBe("collab-child");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      const initialized = withCanonicalState(baseConversation).canonicalState;
      if (!initialized) throw new Error("Expected initialized conversation");
      baseConversation.canonicalState = { ...initialized, latestThreadSettings: null };
      resumeThreadResult = baseConversation;

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      const resumedState = manager.readConversation("thread-1")?.canonicalState;
      expect(resumedState?.latestThreadSettings).not.toBeNull();
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-47:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "thread/started",
          params: {
            thread: {
              model: "incoming-model",
              reasoningEffort: "high",
              id: "thread-1",
              environments: null,
              extra: null,
              sessionId: "incoming-session",
              forkedFromId: "fork-origin",
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
              recencyAt: 19,
              status: { type: "idle" },
              path: "/incoming/rollout.jsonl",
              cwd: "/tmp/new",
              cliVersion: "test",
              originator: null,
              source: "cli",
              canAcceptDirectInput: true,
              threadSource: null,
              agentNickname: null,
              agentRole: null,
              gitInfo: null,
              name: "Started title",
              daybreakEnabled: null,
              turns: [],
            },
          },
        },
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const publishRecord = invokeRecords.find(
        (record) => record.channel === "peer:threadStreamStateChanged",
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
      expect(conversation?.canonicalState?.title).toBe("Started title");
      expect(conversation?.canonicalState).toMatchObject({
        latestModel: resumedState?.latestModel,
        latestReasoningEffort: resumedState?.latestReasoningEffort,
        sessionId: "incoming-session",
        forkedFromId: "fork-origin",
        recencyAt: 19000,
        rolloutPath: "/incoming/rollout.jsonl",
        source: "cli",
      });
      expect(String(residentConversationTurns(conversation?.canonicalState).length ?? -1)).toBe(
        "1",
      );
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.baseRevision).toEqual(expect.any(Number));
      expect(publishInput?.change?.revision).toBe(Number(publishInput?.change?.baseRevision) + 1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        statusType: "active",
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-48:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-49:2",
        occurrenceToken: 2,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-50:3",
        occurrenceToken: 3,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-51:4",
        occurrenceToken: 4,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );

      expect(todoItem?.semanticKind).toBe("todoList");
      expect(todoItem?.markdownText).toBe("1. [x] Inspect bundle\n2. [ ] Patch Nodex");
      expect(errorItem?.semanticKind).toBe("systemError");
      expect(errorItem?.additionalDetails).toBe("exit 1");
      expect(reroutedItem?.status).toBe("completed");
      expect(turn?.itemIds.includes(todoItem?.itemId ?? "")).toBe(true);
      expect(turn?.itemIds.includes(errorItem?.itemId ?? "")).toBe(true);
      expect(
        residentConversationTurns(conversation?.canonicalState)[0]?.items.some(
          (item) => item.id === todoItem?.itemId && item.type === "todo-list",
        ),
      ).toBe(true);
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(command?.approvalRequestId ?? null).toBe(null);
      expect(duplicateCommand?.approvalRequestId ?? null).toBe(null);
      expect(String(conversation?.statusActiveFlags.length ?? -1)).toBe("1");
      expect(publishRecords).toHaveLength(4);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-52:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-53:2",
        occurrenceToken: 2,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-54:3",
        occurrenceToken: 3,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
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
      expect(publishRecords).toHaveLength(3);

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
        (record) => record.channel === "peer:threadStreamStateChanged",
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
      expect(resolvedPublishRecords).toHaveLength(6);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");

      const dispatchApproval = (id: string | number, sequence: number) => {
        dispatchCodexAppServerMessage("native-request", {
          type: "nativeRequest",
          generation: resumeThreadGeneration,
          occurrenceId: `native-55:${sequence}`,
          occurrenceToken: sequence,
          hostId: "local",
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-56:3",
        occurrenceToken: 3,
        hostId: "local",
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-57:4",
        occurrenceToken: 4,
        hostId: "local",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");

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
        dispatchCodexAppServerMessage("native-request", {
          type: "nativeRequest",
          generation: resumeThreadGeneration,
          occurrenceId: `native-58:${sequence}`,
          occurrenceToken: sequence,
          hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-59:3",
        occurrenceToken: 3,
        hostId: "local",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");

      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-60:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-61:2",
        occurrenceToken: 2,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-62:3",
        occurrenceToken: 3,
        hostId: "local",
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
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: `native-63:${resolvedSequence}`,
          occurrenceToken: resolvedSequence,
          hostId: "local",
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
        JSON.stringify(
          (
            permissionItem?.rawItem as
              | {
                  response?: unknown;
                }
              | undefined
          )?.response,
        ),
      ).toBe(JSON.stringify({ permissions: {}, scope: "turn" }));
      expect(
        (
          mcpItem?.rawItem as
            | {
                action?: string | null;
              }
            | undefined
        )?.action,
      ).toBe("accept");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
          hostId: "local",
          conversationId: threadId,
          version: 1,
          change: { type: "snapshot", revision: 1, conversationState: conversation },
          sourceClientId: "test-owner",
        });
        await resumeAfterFixtureOwnerDisconnect(manager, threadId);
        dispatchCodexAppServerMessage("native-request", {
          type: "nativeRequest",
          generation: resumeThreadGeneration,
          occurrenceId: "native-64:1",
          occurrenceToken: 1,
          hostId: "local",
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
        (record) => record.channel === "codex:app-server:respond",
      );
      expect((responseCall?.args[0] as { threadId?: string } | undefined)?.threadId).toBe(
        "thread-owner-scope-second",
      );
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

  test("follower request replies use method-specific owner IPC without waiting for stream revision", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = { ok: true };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
      expect(resolved).toBe(true);
      expect(accepted).toBe(true);
      expect(manager.readConversation("thread-1")?.requests.length).toBe(1);

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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

      const action = invokeRecords.find((record) => record.channel === "peer:requestThreadFollower")
        ?.args[0] as
        | {
            request?: {
              method?: string;
              params?: {
                conversationId?: string;
                requestId?: string | number;
                decision?: string;
              };
            };
          }
        | undefined;
      expect(resolved).toBe(true);
      expect(accepted).toBe(true);
      expect(action?.request?.method).toBe("thread-follower-command-approval-decision");
      expect(action?.request?.params?.conversationId).toBe("thread-1");
      expect(action?.request?.params?.requestId).toBe("approval-follower");
      expect(action?.request?.params?.decision).toBe("decline");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: input.threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await resumeAfterFixtureOwnerDisconnect(manager, input.threadId);

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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-65:1",
        occurrenceToken: 1,
        hostId: "local",
        request: firstRequest,
      });
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-66:2",
        occurrenceToken: 2,
        hostId: "local",
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

      expect(invokeRecords.some((record) => record.channel === "codex:app-server:respond")).toBe(
        false,
      );
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
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    const threadId = "thread-owner-resolved-before-action";
    const conversation = buildConversation(threadId, "project-1");
    resumeThreadResult = conversation;
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: conversation,
        },
        sourceClientId: "test-owner",
      });
      await resumeAfterFixtureOwnerDisconnect(manager, threadId);
      invokeRecords = [];

      const result = await manager.handleThreadFollowerRequest({
        method: "thread-follower-command-approval-decision",
        params: { conversationId: threadId, requestId: "already-resolved", decision: "decline" },
      });

      expect(result).toEqual({
        method: "thread-follower-command-approval-decision",
        result: { ok: true },
      });
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
    followerActionResult = { ok: true };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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

      const routed = invokeRecords.find((record) => record.channel === "peer:requestThreadFollower")
        ?.args[0] as
        | {
            request?: {
              method?: string;
              params?: {
                decision?: string;
              };
            };
          }
        | undefined;
      expect(routed?.request?.method).toBe(
        wrongKind === "command"
          ? "thread-follower-command-approval-decision"
          : "thread-follower-file-approval-decision",
      );
      expect(routed?.request?.params?.decision).toBe("decline");
      expect(manager.readConversation(input.threadId)?.canonicalRequests?.length).toBe(2);
      expect(manager.readConversation(input.threadId)?.requests.length).toBe(2);
      expect(invokeRecords.some((record) => record.channel === "codex:app-server:respond")).toBe(
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

  test("owner unmatched resolved preserves the canonical request and rebuilds its presentation", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      await flushAsyncWork();
      const before = manager.readConversation("thread-1");
      let transitions = 0;
      const stop = manager.addConversationCallback("thread-1", () => {
        transitions += 1;
      });
      try {
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-67:1",
          occurrenceToken: 1,
          hostId: "local",
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
      expect(after?.requests[0]?.requestId).toBe("canonical-1");
      expect(after?.turns[0]?.items[0]?.approvalRequestId).toBe("canonical-1");
      expect(after?.canonicalRequests?.[0]?.id).toBe("canonical-1");
      expect(after?.canonicalRequests === before?.canonicalRequests).toBe(false);
      expect(transitions).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner dynamic tool-call response carries its native occurrence without stream patches", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-dynamic",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-dynamic");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-68:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const dynamicToolRecords = invokeRecords.filter(
        (record) => record.channel === "codex:dynamic-tool-call:respond",
      );
      const conversation = manager.readConversation("thread-dynamic");

      expect(String(dynamicToolRecords.length)).toBe("1");
      expect(dynamicToolRecords[0]?.args).toMatchObject([
        "thread-dynamic",
        "dynamic-1",
        {
          permissionMode: "custom",
          serviceTierSelector: { type: "standard" },
          nativeOccurrence: {
            type: "nativeRequest",
            hostId: "local",
            generation: resumeThreadGeneration,
            occurrenceId: "native-68:1",
            occurrenceToken: 1,
            request: { id: "dynamic-1", method: "item/tool/call" },
          },
        },
      ]);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await resumeAfterFixtureOwnerDisconnect(manager, threadId);
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-69:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "codex:app-server:respond",
      );
      expect(onboardingCall?.args[0]).toMatchObject({
        request: { params: { threadId } },
        effect: {
          method: "item/tool/call",
          requestId: "onboarding-owner-1",
          response: { success: true },
        },
      });
      expect(
        (
          onboardingCall?.args[0] as
            | { effect?: { response?: { contentItems?: Array<{ text?: string }> } } }
            | undefined
        )?.effect?.response?.contentItems?.[0]?.text,
      ).toBe(JSON.stringify({ answers: { first_task: { answers: ["Audit"] } } }));
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("0");
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(String(conversation?.turns[0]?.items.length ?? -1)).toBe("0");

      invokeRecords = [];
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-70:2",
        occurrenceToken: 2,
        hostId: "local",
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
        (record) => record.channel === "codex:app-server:respond",
      );
      expect(optionCall?.args[0]).toMatchObject({
        threadId,
        requestId: "option-picker-owner-2",
        method: "item/tool/requestOptionPicker",
        response: optionResponse,
      });
      expect(String(manager.readConversation(threadId)?.canonicalRequests?.length ?? -1)).toBe("0");

      invokeRecords = [];
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-71:3",
        occurrenceToken: 3,
        hostId: "local",
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
        (record) => record.channel === "codex:app-server:respond",
      );
      expect(setupCall?.args[0]).toMatchObject({
        request: { params: { threadId } },
        effect: {
          method: "item/tool/call",
          requestId: "setup-role-owner-3",
          response: { success: true },
        },
      });
      expect(
        (
          setupCall?.args[0] as
            | { effect?: { response?: { contentItems?: Array<{ text?: string }> } } }
            | undefined
        )?.effect?.response?.contentItems?.[0]?.text,
      ).toBe(JSON.stringify(roleResponse));
      expect(String(conversation?.canonicalRequests?.length ?? -1)).toBe("0");
      expect(String(conversation?.requests.length ?? -1)).toBe("0");
      expect(String(conversation?.turns[0]?.items.length ?? -1)).toBe("0");
      expect(
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toBe(true);
    } finally {
      ownerRequestResponseHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower onboarding routes to its owner while picker and setup replies use native occurrences", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    followerActionResult = { ok: true };
    followerActionError = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      resumeThreadRole = "follower";
      resumeThreadOwnerClientId = "owner-a";
      resumeThreadResult = baseConversation;
      await manager.setThreadStreamFollowing(threadId, true);
      await flushAsyncWork();
      await manager.requestThreadStreamResume(threadId);
      for (const [index, request] of baseConversation.canonicalRequests!.entries()) {
        dispatchCodexAppServerMessage("native-request", {
          type: "nativeRequest",
          hostId: "local",
          generation: resumeThreadGeneration,
          occurrenceId: `special-follower:${index}`,
          occurrenceToken: index + 1,
          request,
        });
      }
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
        .filter((record) => record.channel === "peer:requestThreadFollower")
        .map(
          (record) =>
            record.args[0] as {
              conversationId?: string;
              request?: {
                method?: string;
                params?: {
                  type?: string;
                  conversationId?: string;
                  requestId?: string;
                  answers?: Record<string, string[]>;
                  response?: unknown;
                };
              };
            },
        );
      expect(followerActions).toHaveLength(1);
      expect(followerActions).toMatchObject([
        {
          hostId: "local",
          targetClientId: "owner-a",
          request: {
            method: "thread-follower-submit-user-input",
            params: {
              conversationId: threadId,
              requestId: "onboarding-follower-1",
              response: { answers: { first_task: { answers: ["Audit"] } } },
            },
          },
        },
      ]);
      expect(
        invokeRecords
          .filter((record) => record.channel === "codex:app-server:respond")
          .map((record) => record.args[0]),
      ).toMatchObject([
        {
          occurrenceId: "special-follower:1",
          occurrenceToken: 2,
          method: "item/tool/requestOptionPicker",
          response: optionResponse,
        },
        {
          occurrenceId: "special-follower:2",
          occurrenceToken: 3,
          effect: {
            method: "item/tool/call",
            response: {
              success: true,
              contentItems: [{ type: "inputText", text: JSON.stringify(taskResponse) }],
            },
          },
        },
      ]);
      expect(
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toBe(false);
      expect(
        JSON.stringify(
          manager.readConversation(threadId)?.canonicalRequests?.map((request) => request.id) ?? [],
        ),
      ).toBe(JSON.stringify(["onboarding-follower-1"]));
      expect(String(manager.readConversation(threadId)?.turns[0]?.items.length ?? -1)).toBe("0");
    } finally {
      followerActionResult = null;
      followerActionError = null;
      resumeThreadResult = null;
      resumeThreadRole = "owner";
      resumeThreadOwnerClientId = "renderer-owner";
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

    const writes: Array<[string, boolean]> = [];
    const manager = trackNativeTestManager(
      new CodexAppServerManager("local", {
        saveReadState: async (id, unread) => {
          writes.push([id, unread]);
        },
      }),
    );
    const threadId = "thread-standalone-unread";
    const managerInternals = manager as unknown as {
      streamState: {
        getRevision: (targetThreadId: string) => number | null;
      };
    };
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 17,
          conversationState: withCanonicalState({
            ...buildConversation(threadId, "project-1"),
            hasUnreadTurn: false,
            unreadMessageCount: 3,
          }),
        },
        sourceClientId: "test-owner",
      });
      invokeRecords = [];

      await manager.markConversationAsRead(threadId);
      expect(writes).toEqual([]);

      await manager.markConversationAsUnread(threadId);
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(true);
      expect(manager.readConversation(threadId)?.canonicalState?.hasUnreadTurn).toBe(true);
      expect(manager.readThreadSummary(threadId)?.hasUnreadTurn).toBe(true);
      expect(managerInternals.streamState.getRevision(threadId)).toBe(17);
      expect(writes).toEqual([[threadId, true]]);
      expect(
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toBe(false);

      dispatchCodexAppServerMessage("thread-read-state-changed", {
        hostId: "local",
        conversationId: threadId,
        hasUnreadTurn: false,
      });
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(false);
      expect(manager.readConversation(threadId)?.canonicalState?.hasUnreadTurn).toBe(false);
      expect(manager.readConversation(threadId)?.unreadMessageCount).toBe(0);
      expect(manager.readThreadSummary(threadId)?.hasUnreadTurn).toBe(false);
      expect(managerInternals.streamState.getRevision(threadId)).toBe(17);
      expect(writes).toHaveLength(1);

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

  test("saves unread changes for unloaded conversations from the session state", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const writes: Array<[string, boolean]> = [];
    const manager = trackNativeTestManager(
      new CodexAppServerManager("local", {
        saveReadState: async (id, unread) => {
          writes.push([id, unread]);
        },
      }),
    );
    try {
      manager.receiveReadStateSnapshot(["unloaded"]);
      await manager.markConversationAsRead("unloaded");
      await manager.markConversationAsRead("unloaded");
      await manager.markConversationAsUnread("other-unloaded");
      await manager.markConversationAsUnread("other-unloaded");
      expect(writes).toEqual([
        ["unloaded", false],
        ["other-unloaded", true],
      ]);
      expect(manager.readConversation("unloaded")).toBeNull();
      expect(manager.readConversation("other-unloaded")).toBeNull();
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: threadId,
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "test-owner",
      });
      await resumeAfterFixtureOwnerDisconnect(manager, threadId);
      ownerStreamPublishHandler = (input) => {
        publishInputs.push(input as (typeof publishInputs)[number]);
        if (publishInputs.length !== 1) return true;
        return new Promise<boolean>((resolve) => {
          publishResolvers.push(resolve);
        });
      };

      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-72:1",
        occurrenceToken: 1,
        hostId: "local",
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
        hostId: "local",
        conversationId: threadId,
        hasUnreadTurn: false,
      });
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(false);

      publishResolvers.shift()?.(true);
      await flushAsyncWork(4);

      expect(publishInputs.length).toBe(1);
      expect(manager.readConversation(threadId)?.hasUnreadTurn).toBe(false);

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-73:2",
        occurrenceToken: 2,
        hostId: "local",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      const beforeUpdatedAt = manager.readConversation("thread-1")?.updatedAt;
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-74:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const publish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;

      expect(conversation?.turns[0]?.safetyBuffering?.showBufferingUi).toBe(true);
      expect(conversation?.turns[0]?.safetyBuffering?.useCases[0]).toBe("latency");
      expect(conversation?.turns[0]?.safetyBuffering?.reasons[0]).toBe("warming");
      expect(conversation?.turns[0]?.safetyBuffering?.fasterModel).toBe("gpt-5.4-mini");
      expect(
        residentConversationTurns(conversation?.canonicalState)[0]?.safetyBuffering?.fasterModel,
      ).toBe("gpt-5.4-mini");
      expect(conversation?.updatedAt).toBe(beforeUpdatedAt);
      expect(String(publishRecords.length)).toBe("1");
      expect(publish?.change?.type).toBe("patches");
      expect(publish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(publish?.change?.revision).toBe(Number(publish?.change?.baseRevision) + 1);
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

    // Generated wire timestamps are JSON numbers, including fields typed bigint by ts-rs.
    const notificationSchema = createGeneratedCodexSchema<ServerNotification>(
      serverNotificationJsonSchema,
    );
    const decodeHook = (value: unknown) => {
      const notification = notificationSchema.parse(value);
      if (notification.method !== "hook/started" && notification.method !== "hook/completed") {
        throw new Error("Expected a Hook lifecycle notification");
      }
      return notification;
    };
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      const beforeHooks = manager.readConversation("thread-1")!.canonicalState!;
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-75:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: decodeHook({
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
              displayOrder: 1,
              status: "running",
              statusMessage: "Preparing context",
              startedAt: 10,
              completedAt: null,
              durationMs: null,
              entries: [{ kind: "context", text: "Added AGENTS.md" }],
            },
          },
        }),
      });
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-76:2",
        occurrenceToken: 2,
        hostId: "local",
        notification: decodeHook({
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
              displayOrder: 1,
              status: "completed",
              statusMessage: "Preparing context",
              startedAt: 10,
              completedAt: 20,
              durationMs: 10,
              entries: [{ kind: "context", text: "Added AGENTS.md" }],
            },
          },
        }),
      });
      await flushAsyncWork();

      const conversation = manager.readConversation("thread-1");
      const hookItems =
        conversation?.turns[0]?.items.filter((item) => item.itemId === "hook-run-1") ?? [];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const lastPublish = publishRecords[publishRecords.length - 1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;

      expect(hookItems).toEqual([]);
      expect(conversation?.turns[0]?.hookRuns?.[0]?.run.status).toBe("completed");
      expect(conversation?.turns[0]?.hookRuns?.[0]?.run.entries[0]?.text).toBe("Added AGENTS.md");
      expect(residentConversationTurns(conversation?.canonicalState)[0]?.hookRuns?.[0]?.id).toBe(
        "hook-run-1",
      );
      expect(String(publishRecords.length)).toBe("2");
      expect(lastPublish?.change?.type).toBe("patches");
      expect(lastPublish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(lastPublish?.change?.revision).toBe(Number(lastPublish?.change?.baseRevision) + 1);
      let follower = JSON.parse(JSON.stringify(beforeHooks)) as typeof beforeHooks;
      for (const record of publishRecords) {
        const publication = record.args[0] as {
          change: { type: string; patches: import("immer").Patch[] };
        };
        const received = JSON.parse(
          JSON.stringify(publication.change),
        ) as typeof publication.change;
        if (received.type !== "patches") throw new Error("Expected a Hook lifecycle patch");
        follower = applyPatches(follower, received.patches);
      }
      expect(follower).toEqual(JSON.parse(JSON.stringify(conversation?.canonicalState)));
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-77:1",
        occurrenceToken: 1,
        hostId: "local",
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
        | {
            status?: string;
            startedAtMs?: number;
          }
        | undefined;

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-78:2",
        occurrenceToken: 2,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const lastPublish = publishRecords[publishRecords.length - 1]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
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
      expect(lastPublish?.change?.type).toBe("patches");
      expect(lastPublish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(lastPublish?.change?.revision).toBe(Number(lastPublish?.change?.baseRevision) + 1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-79:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      expect(String(warningItems.length)).toBe("0");
      expect(String(publishRecords.length)).toBe("0");

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-80:2",
        occurrenceToken: 2,
        hostId: "local",
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
      const warningRaw = warningItem?.rawItem as
        | {
            type?: string;
          }
        | undefined;
      publishRecords = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const publish = publishRecords[0]?.args[0] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;

      expect(String(warningItems.length)).toBe("1");
      expect(warningItem?.type).toBe("autoReviewInterruptionWarning");
      expect(warningItem?.markdownText).toBe(
        "Automatic approval review rejected too many approval requests for this turn",
      );
      expect(warningRaw?.type).toBe("autoReviewInterruptionWarning");
      expect(String(publishRecords.length)).toBe("1");
      expect(publish?.change?.type).toBe("patches");
      expect(publish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(publish?.change?.revision).toBe(Number(publish?.change?.baseRevision) + 1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-81:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        hostId: "local",
        generation: resumeThreadGeneration,
        occurrenceId: "raf-started",
        occurrenceToken: 100,
        notification: {
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            startedAtMs: Date.now(),
            item: {
              id: "assistant-1",
              type: "agentMessage",
              text: "",
              phase: null,
              memoryCitation: null,
              delivery: null,
              questions: null,
            },
          },
        },
      });
      await flushAsyncWork();
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-82:1",
        occurrenceToken: 1,
        hostId: "local",
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
      await flushAsyncWork();

      const nextItem = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
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

  test("owner prose advances and publishes consecutive revisions without awaiting a peer acknowledgement", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-83:1",
        occurrenceToken: 1,
        hostId: "local",
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
      await flushAsyncWork();
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("first ");
      expect(String(publishInputs.length)).toBe("1");

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-84:2",
        occurrenceToken: 2,
        hostId: "local",
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
      await flushAsyncWork();
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "first second",
      );
      expect(publishInputs).toHaveLength(2);

      publishResolvers.shift()?.(true);
      await flushAsyncWork(3);
      const secondPublish = publishInputs[1] as
        | {
            ownerNotificationSequence?: number;
            change?: {
              type?: string;
              baseRevision?: number;
              revision?: number;
            };
          }
        | undefined;
      expect(String(publishInputs.length)).toBe("2");
      expect(secondPublish?.change?.type).toBe("patches");
      expect(secondPublish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(secondPublish?.change?.revision).toBe(Number(secondPublish?.change?.baseRevision) + 1);
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

  test("peer publication failure preserves the native owner document", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      await flushAsyncWork();
      invokeCalls = [];
      invokeRecords = [];
      ownerStreamPublishHandler = (input) => {
        publishInputs.push(input);
        throw new Error("Peer transport disconnected");
      };

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-86:1",
        occurrenceToken: 1,
        hostId: "local",
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
      expect(publishInputs).toHaveLength(1);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("hello");
      expect(manager.readConversation("thread-1")?.resumeState).toBe("resumed");
      expect(manager.getStreamRole("thread-1")?.role).toBe("owner");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: partialConversation,
        },
        sourceClientId: "owner-a",
      });
      coordinationBroadcast?.("clientStatusChanged", {
        sourceClientId: "owner-a",
        params: { clientId: "owner-a", clientType: "app", status: "disconnected" },
      });
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-87:1",
        occurrenceToken: 1,
        hostId: "local",
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

    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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

      coordinationBroadcast?.("clientStatusChanged", {
        sourceClientId: resumeThreadOwnerClientId,
        params: { clientId: resumeThreadOwnerClientId, clientType: "app", status: "connected" },
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

  test("connected status preserves a follower until a new owner snapshot is received", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    snapshotByThread = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      const nextOwnerConversation: CodexConversationSnapshot = {
        ...ownerConversation,
        turns: [],
      };

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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

      coordinationBroadcast?.("clientStatusChanged", {
        sourceClientId: resumeThreadOwnerClientId,
        params: { clientId: resumeThreadOwnerClientId, clientType: "app", status: "connected" },
      });
      await flushAsyncWork();
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "owner text",
      );
      expect(manager.getStreamRole("thread-1")?.role).toBe("follower");
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "snapshot",
          revision: 2,
          conversationState: nextOwnerConversation,
        },
        sourceClientId: "main",
      });
      await flushAsyncWork(2);

      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:snapshot:request" && record.args[0] === "thread-1",
        ),
      ).toBe(false);
      expect(manager.readConversation("thread-1")?.turns).toEqual([]);
      expect(manager.getStreamRole("thread-1")?.role).toBe("follower");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      await act(async () => {
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          hostId: "local",
          generation: resumeThreadGeneration,
          occurrenceId: "started-before-deltas",
          occurrenceToken: 100,
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              startedAtMs: Date.now(),
              item: {
                id: "assistant-1",
                type: "agentMessage",
                text: "",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
              },
            },
          },
        });
        await flushAsyncWork();
      });
      invokeRecords = [];
      const beforeDeltas = manager.readConversation("thread-1")?.canonicalState;

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-88:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-89:2",
        occurrenceToken: 2,
        hostId: "local",
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              questions: null,
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

      const partialAckRecords = invokeRecords.filter(
        (record) => record.channel === "codex:thread-owner:notification:ack",
      );

      expect(partialItem?.markdownText).toBe("abcdefghijklmnopqrstuvwx");
      expect(partialItem?.status).toBe("inProgress");
      expect(String(requestAnimationFrameCallCount)).toBe("2");
      expect(String(partialAckRecords.length)).toBe("0");

      animationFrameCallbacks.shift()?.(32);
      await flushAsyncWork(3);

      const completedItem = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const publicationStates = replayCanonicalPublications(publishRecords, beforeDeltas);
      expect(completedItem?.markdownText).toBe(delta);
      expect(completedItem?.status).toBe("completed");
      expect(String(requestAnimationFrameCallCount)).toBe("2");
      expect(
        publicationStates.some((state) => state.status === "inProgress" && state.text !== delta),
      ).toBe(true);
      expect(publicationStates.at(-1)).toEqual({ text: delta, status: "completed" });
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

  test("peer IPC reconnection preserves queued native text for both owned conversations", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
          hostId: "local",
          conversationId: threadId,
          version: 1,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: conversation,
          },
          sourceClientId: null,
        });
        await resumeAfterFixtureOwnerDisconnect(manager, threadId);
      }
      invokeRecords = [];

      for (const [threadId, delta] of [
        ["thread-1", "first"],
        ["thread-2", "preserve"],
      ] as const) {
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-92:1",
          occurrenceToken: 1,
          hostId: "local",
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
      coordinationBroadcast?.("ipcConnectionReset", {
        sourceClientId: "main",
        params: {},
      });

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(manager.readConversation("thread-2")?.turns[0]?.items[0]?.markdownText).toBe("");
      expect(String(animationFrameCallbacks.length)).toBe("1");

      animationFrameCallbacks.shift()?.(16);
      await flushAsyncWork(3);

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("first");
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

  test("endpoint loss discards queued command output without applying or ACKing it", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-95:1",
        occurrenceToken: 1,
        hostId: "local",
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
      resumeThreadGeneration += 1;
      const { dispatchCodexAppServerMessage: dispatchNativeLifetime } =
        await import("./app-server-message-bus");
      dispatchNativeLifetime("shared-object-updated", {
        hostId: "local",
        object: {
          objectType: "connection",
          objectId: "connection",
          value: { status: "connected", retries: 0 },
        },
      });
      await flushAsyncWork();
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

  test("malformed native reasoning notification does not block later metadata updates", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      const conversation = buildConversation("thread-1", "project-1");
      resumeThreadResult = conversation;
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: conversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-96:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "item/reasoning/summaryPartAdded",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
          } as never,
        },
      });
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-97:2",
        occurrenceToken: 2,
        hostId: "local",
        notification: {
          method: "thread/name/updated",
          params: { threadId: "thread-1", threadName: "After malformed notification" },
        },
      });
      await flushAsyncWork(3);

      expect(manager.readConversation("thread-1")?.canonicalState?.title).toBe(
        "After malformed notification",
      );
      expect(
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toBe(true);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner short assistant delta publishes before same-stack completion and renders final text", async () => {
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

    const rendered = render(
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
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
          hostId: "local",
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
        await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      });
      await act(async () => {
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          hostId: "local",
          generation: resumeThreadGeneration,
          occurrenceId: "started-before-deltas",
          occurrenceToken: 100,
          notification: {
            method: "item/started",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              startedAtMs: Date.now(),
              item: {
                id: "assistant-1",
                type: "agentMessage",
                text: "",
                phase: null,
                memoryCitation: null,
                delivery: null,
                questions: null,
              },
            },
          },
        });
        await flushAsyncWork();
      });
      invokeRecords = [];
      const beforeDeltas = manager.readConversation("thread-1")?.canonicalState;
      renderStates.length = 0;
      requestAnimationFrameCallCount = 0;
      animationFrameCallbacks.length = 0;

      await act(async () => {
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-98:1",
          occurrenceToken: 1,
          hostId: "local",
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
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-99:2",
          occurrenceToken: 2,
          hostId: "local",
          notification: {
            method: "item/completed",
            params: {
              completedAtMs: 1,
              threadId: "thread-1",
              turnId: "turn-1",
              item: {
                questions: null,
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const publicationStates = replayCanonicalPublications(publishRecords, beforeDeltas);
      expect(completedItem?.markdownText).toBe(delta);
      expect(completedItem?.status).toBe("completed");
      expect(renderStates.includes(`completed:${delta}`)).toBe(true);
      expect(
        publicationStates.some((state) => state.text === delta && state.status === "inProgress"),
      ).toBe(true);
      expect(publicationStates.at(-1)).toEqual({ text: delta, status: "completed" });
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-100:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-101:2",
        occurrenceToken: 2,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-102:3",
        occurrenceToken: 3,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-103:4",
        occurrenceToken: 4,
        hostId: "local",
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
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toBe(false);
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
        const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
            hostId: "local",
            conversationId: threadId,
            version: 1,
            change: {
              type: "snapshot",
              revision: 1,
              conversationState: baseConversation,
            },
            sourceClientId: null,
          });
          await resumeAfterFixtureOwnerDisconnect(manager, threadId);
          invokeRecords = [];

          dispatchCodexAppServerMessage("native-notification", {
            type: "nativeNotification",
            generation: resumeThreadGeneration,
            occurrenceId: "native-104:1",
            occurrenceToken: 1,
            hostId: "local",
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
          dispatchCodexAppServerMessage("native-notification", {
            type: "nativeNotification",
            generation: resumeThreadGeneration,
            occurrenceId: "native-105:2",
            occurrenceToken: 2,
            hostId: "local",
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

  test.each([
    { copies: 1, flushBeforeCompletion: false, completion: "item" },
    { copies: 1, flushBeforeCompletion: false, completion: "turn" },
    { copies: 2, flushBeforeCompletion: false, completion: "item" },
    { copies: 2, flushBeforeCompletion: true, completion: "item" },
  ])(
    "completed command output stays authoritative: %j",
    async ({ copies, flushBeforeCompletion, completion }) => {
      invokeCalls = [];
      invokeRecords = [];
      hostMessageListener = null;
      threadListByProject = {};
      resumeThreadResult = null;
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      try {
        const command = buildCommandExecutionItem("thread-1", "turn-1", "cmd-1");
        resumeThreadResult = {
          ...buildConversation("thread-1", "project-1"),
          turns: [
            {
              threadId: "thread-1",
              turnId: "turn-1",
              status: "inProgress",
              itemIds: ["cmd-1"],
              items: [command],
            },
          ],
        };
        await manager.requestThreadStreamResume("thread-1");
        vi.useFakeTimers();
        const line = '{"ok":true,"rows":[["Page"]],"snapshot":"query-fixture"}\n';
        const output = line.repeat(copies);
        await act(async () => {
          for (let sequence = 1; sequence <= copies; sequence += 1) {
            dispatchCodexAppServerMessage("native-notification", {
              type: "nativeNotification",
              generation: resumeThreadGeneration,
              occurrenceId: `native-106:${sequence}`,
              occurrenceToken: sequence,
              hostId: "local",
              notification: {
                method: "item/commandExecution/outputDelta",
                params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: line },
              },
            });
          }
          if (flushBeforeCompletion) {
            await vi.advanceTimersByTimeAsync(70);
            expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput).toBe(
              output,
            );
          }
          dispatchCodexAppServerMessage("native-notification", {
            type: "nativeNotification",
            generation: resumeThreadGeneration,
            occurrenceId: `native-107:${copies + 1}`,
            occurrenceToken: copies + 1,
            hostId: "local",
            notification:
              completion === "turn"
                ? {
                    method: "turn/completed",
                    params: {
                      threadId: "thread-1",
                      turn: buildProtocolTurn({ id: "turn-1", status: "completed" }),
                    },
                  }
                : {
                    method: "item/completed",
                    params: {
                      threadId: "thread-1",
                      turnId: "turn-1",
                      completedAtMs: Date.now(),
                      item: {
                        type: "commandExecution",
                        id: "cmd-1",
                        command: "query",
                        cwd: "/workspace/project",
                        processId: null,
                        pluginId: null,
                        scriptPath: null,
                        source: "agent",
                        status: "completed",
                        commandActions: [],
                        aggregatedOutput: output,
                        exitCode: 0,
                        durationMs: 1,
                      },
                    },
                  },
          });
          await Promise.resolve();
        });
        expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput).toBe(
          output,
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(70);
        });
        expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput).toBe(
          output,
        );
        const completed = manager.readConversation("thread-1");
        const completedItem = residentConversationTurns(completed?.canonicalState)[0]?.items[0];
        expect(
          completedItem?.type === "commandExecution" ? completedItem.aggregatedOutput : undefined,
        ).toBe(output);
        manager.destroy();
        vi.useRealTimers();
        resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
        resumeThreadResult = completed;
        const restored = trackNativeTestManager(new CodexAppServerManager("local"));
        try {
          await restored.requestThreadStreamResume("thread-1");
          expect(restored.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput).toBe(
            output,
          );
        } finally {
          restored.destroy();
        }
      } finally {
        resumeThreadResult = null;
        manager.destroy();
        vi.useRealTimers();
      }
    },
  );

  test("an owner accepts only sequenced output even when a fallback delivery races adoption", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      resumeThreadResult = {
        ...buildConversation("thread-1", "project-1"),
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-1",
            status: "inProgress",
            itemIds: ["cmd-1"],
            items: [buildCommandExecutionItem("thread-1", "turn-1", "cmd-1", "committed\n")],
          },
        ],
      };
      await manager.requestThreadStreamResume("thread-1");
      vi.useFakeTimers();
      await act(async () => {
        const notification = {
          method: "item/commandExecution/outputDelta" as const,
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1", delta: "committed\n" },
        };
        dispatchCodexAppServerMessage("mcp-notification", { hostId: "local", notification });
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-108:1",
          occurrenceToken: 1,
          hostId: "local",
          notification: { ...notification, params: { ...notification.params, delta: "next\n" } },
        });
        await vi.advanceTimersByTimeAsync(70);
      });
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput).toBe(
        "committed\nnext\n",
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
      vi.useRealTimers();
    }
  });

  test("owner command output updates stay local while delivery is acknowledged", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-109:1",
        occurrenceToken: 1,
        hostId: "local",
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

      await new Promise((resolve) => setTimeout(resolve, 70));
      await flushAsyncWork(4);

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );

      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.aggregatedOutput).toBe(
        "owner output\n",
      );
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.toolCall).toBeUndefined();
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.updatedAt).toBe(1);
      const canonicalCommand = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.items[0];
      expect(
        canonicalCommand?.type === "commandExecution" ? canonicalCommand.aggregatedOutput : null,
      ).toBe("owner output\n");
      expect(publishRecords).toHaveLength(0);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner terminal interactions retain parsed command actions locally", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-110:1",
        occurrenceToken: 1,
        hostId: "local",
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
      const partialCanonicalCommand = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.items[0];
      expect(
        partialCanonicalCommand?.type === "commandExecution"
          ? partialCanonicalCommand.commandActions.length
          : -1,
      ).toBe(0);
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-111:2",
        occurrenceToken: 2,
        hostId: "local",
        notification: {
          method: "item/commandExecution/terminalInteraction",
          params: {
            threadId: "thread-1",
            turnId: "changed-notification-turn",
            itemId: "cmd-1",
            processId: "proc-1",
            stdin: "t\n",
          },
        },
      });
      await flushAsyncWork(4);

      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const item = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const canonicalCommand = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.items[0];
      const commandAction = item?.commandActions?.[0];
      expect(publishRecords).toHaveLength(0);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        hostId: "local",
        generation: resumeThreadGeneration,
        occurrenceId: "initial-mcp-progress",
        occurrenceToken: 100,
        notification: {
          method: "item/mcpToolCall/progress",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "mcp-1", message: "Ready" },
        },
      });
      await flushAsyncWork();
      const beforeConversation = manager.readConversation("thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-112:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-113:2",
        occurrenceToken: 2,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-114:3",
        occurrenceToken: 3,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const item = manager.readConversation("thread-1")?.turns[0]?.items[0];

      expect(manager.readConversation("thread-1") === beforeConversation).toBe(true);
      expect(String(publishRecords.length)).toBe("0");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      const beforeItem = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const beforeCanonicalItem = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.items[0];
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-115:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );

      expect(turn?.hookRuns?.length ?? -1).toBe(0);
      expect(turn?.firstTurnWorkItemStartedAtMs ?? null).toBe(null);
      expect(turn?.items[0] === beforeItem).toBe(true);
      const canonicalTurn = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0];
      expect(canonicalTurn?.hookRuns?.length ?? -1).toBe(0);
      expect(canonicalTurn?.items[0] === beforeCanonicalItem).toBe(true);
      expect(publishRecords.length).toBe(1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-116:1",
        occurrenceToken: 1,
        hostId: "local",
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

      expect(conversation?.turns[0]?.turnId).toBe("turn-rebound");
      expect(conversation?.turns[0]?.status).toBe("inProgress");
      expect(typeof conversation?.turns[0]?.turnStartedAtMs).toBe("number");
      expect(conversation?.turns[0]?.items.length).toBe(0);
      expect(residentConversationTurns(conversation?.canonicalState)[0]?.turnId).toBe(
        "turn-rebound",
      );
      expect(residentConversationTurns(conversation?.canonicalState)[0]?.items.length).toBe(0);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-117:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              questions: null,
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      resumeThreadResult = buildConversation("thread-1", "project-1");
      await manager.requestThreadStreamResume("thread-1");
      await manager.compactThread("thread-1");
      await flushAsyncWork();
      expect(
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState).at(-1)
          ?.turnId,
      ).toBeNull();
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-118:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              questions: null,
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
        (
          conversation?.turns[0] as unknown as
            | {
                turnId: unknown;
              }
            | undefined
        )?.turnId ?? null,
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      resumeThreadResult = buildConversation("thread-1", "project-1");
      await manager.requestThreadStreamResume("thread-1");
      await manager.compactThread("thread-1");
      await flushAsyncWork();
      expect(
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState).at(-1)
          ?.turnId,
      ).toBeNull();
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-119:1",
        occurrenceToken: 1,
        hostId: "local",
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

  test.each([false, true])(
    "owner-local file patches stay out of unrelated publishes with inFlight=%s",
    async (inFlight) => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      let release = () => {};
      try {
        const base = withCanonicalState({
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
        resumeThreadResult = base;
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread-1",
          version: 1,
          change: { type: "snapshot", revision: 1, conversationState: base },
          sourceClientId: null,
        });
        await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
        await flushAsyncWork();
        let follower = manager.readConversation("thread-1")!.canonicalState!;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        let count = 0;
        ownerStreamPublishHandler = async (raw) => {
          const publication = raw as {
            change:
              | { type: "snapshot"; conversationState: typeof follower }
              | { type: "patches"; patches: import("immer").Patch[] };
          };
          count += 1;
          if (inFlight && count === 1) await pending;
          follower =
            publication.change.type === "snapshot"
              ? publication.change.conversationState
              : applyPatches(follower, publication.change.patches);
          return true;
        };
        const rename = (sequence: number, name: string) =>
          dispatchCodexAppServerMessage("native-notification", {
            type: "nativeNotification",
            generation: resumeThreadGeneration,
            occurrenceId: `native-120:${sequence}`,
            occurrenceToken: sequence,
            hostId: "local",
            notification: {
              method: "thread/name/updated",
              params: { threadId: "thread-1", threadName: name },
            },
          });
        if (inFlight) rename(1, "before local patch");
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: `native-121:${inFlight ? 2 : 1}`,
          occurrenceToken: inFlight ? 2 : 1,
          hostId: "local",
          notification: {
            method: "item/fileChange/patchUpdated",
            params: { threadId: "thread-1", turnId: "turn-1", itemId: "patch", changes: [] },
          },
        });
        release();
        await flushAsyncWork(6);
        rename(inFlight ? 3 : 2, "after local patch");
        await flushAsyncWork(6);
        expect(
          residentConversationTurns(
            manager.readConversation("thread-1")?.canonicalState,
          )[0]?.items.some((item) => item.id === "patch"),
        ).toBe(true);
        expect(follower.title).toBe("after local patch");
        expect(
          residentConversationTurns(follower)[0]?.items.some((item) => item.id === "patch"),
        ).toBe(false);
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: `native-122:${inFlight ? 4 : 3}`,
          occurrenceToken: inFlight ? 4 : 3,
          hostId: "local",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              completedAtMs: 200,
              item: { type: "fileChange", id: "patch", changes: [], status: "completed" },
            },
          },
        });
        await flushAsyncWork(6);
        expect(
          residentConversationTurns(follower)[0]?.items.find((item) => item.id === "patch"),
        ).toMatchObject({ type: "fileChange", status: "completed" });
      } finally {
        release();
        ownerStreamPublishHandler = null;
        resumeThreadResult = null;
        manager.destroy();
      }
    },
  );

  test.each([false, true])(
    "owner-local command deltas stay out of unrelated publishes with inFlight=%s",
    async (inFlight) => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      let release = () => {};
      try {
        const base = withCanonicalState({
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
        resumeThreadResult = base;
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread-1",
          version: 1,
          change: { type: "snapshot", revision: 1, conversationState: base },
          sourceClientId: null,
        });
        await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
        await flushAsyncWork();
        let follower = manager.readConversation("thread-1")!.canonicalState!;
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        let count = 0;
        ownerStreamPublishHandler = async (raw) => {
          const publication = raw as {
            change:
              | { type: "snapshot"; conversationState: typeof follower }
              | { type: "patches"; patches: import("immer").Patch[] };
          };
          count += 1;
          if (inFlight && count === 1) await pending;
          follower =
            publication.change.type === "snapshot"
              ? publication.change.conversationState
              : applyPatches(follower, publication.change.patches);
          return true;
        };
        const rename = (sequence: number, name: string) =>
          dispatchCodexAppServerMessage("native-notification", {
            type: "nativeNotification",
            generation: resumeThreadGeneration,
            occurrenceId: `native-123:${sequence}`,
            occurrenceToken: sequence,
            hostId: "local",
            notification: {
              method: "thread/name/updated",
              params: { threadId: "thread-1", threadName: name },
            },
          });
        if (inFlight) rename(1, "before local patch");
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: `native-124:${inFlight ? 2 : 1}`,
          occurrenceToken: inFlight ? 2 : 1,
          hostId: "local",
          notification: {
            method: "item/commandExecution/outputDelta",
            params: {
              threadId: "thread-1",
              turnId: "stale-turn",
              itemId: "cmd-1",
              delta: "local output\n",
            },
          },
        });
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: `native-125:${inFlight ? 3 : 2}`,
          occurrenceToken: inFlight ? 3 : 2,
          hostId: "local",
          notification: {
            method: "item/commandExecution/terminalInteraction",
            params: {
              threadId: "thread-1",
              turnId: "stale-turn",
              itemId: "cmd-1",
              processId: "proc-1",
              stdin: "pwd\n",
            },
          },
        });
        await new Promise((resolve) => setTimeout(resolve, 70));
        release();
        await flushAsyncWork(6);
        rename(inFlight ? 4 : 3, "after local patch");
        await flushAsyncWork(6);
        const ownerCommand = residentConversationTurns(
          manager.readConversation("thread-1")?.canonicalState,
        )[0]?.items[0];
        if (ownerCommand?.type !== "commandExecution") throw new Error("Missing owner command");
        expect(ownerCommand.aggregatedOutput).toBe("local output\n");
        expect(ownerCommand.commandActions).toEqual([{ type: "unknown", command: "pwd" }]);
        expect(follower.title).toBe("after local patch");
        expect(residentConversationTurns(follower)[0]?.items[0]).toMatchObject({
          type: "commandExecution",
          aggregatedOutput: "",
          commandActions: [],
        });
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: `native-126:${inFlight ? 5 : 4}`,
          occurrenceToken: inFlight ? 5 : 4,
          hostId: "local",
          notification: {
            method: "item/completed",
            params: {
              threadId: "thread-1",
              turnId: "turn-1",
              completedAtMs: 200,
              item: { ...ownerCommand, status: "completed" },
            },
          },
        });
        await flushAsyncWork(6);
        expect(
          residentConversationTurns(follower)[0]?.items.find((item) => item.id === "cmd-1"),
        ).toMatchObject({
          type: "commandExecution",
          status: "completed",
          aggregatedOutput: "local output\n",
          commandActions: [{ type: "unknown", command: "pwd" }],
        });
      } finally {
        release();
        ownerStreamPublishHandler = null;
        resumeThreadResult = null;
        manager.destroy();
      }
    },
  );

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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      await flushAsyncWork();
      const beforeItem = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const patchObservedAt = Date.now();
      invokeRecords = [];
      const changes = [
        {
          path: "src/app.ts",
          kind: { type: "update" as const, move_path: null },
          diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new",
        },
      ];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-127:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const rawItem = item?.rawItem as
        | {
            changes?: unknown;
            status?: string;
            extension?: unknown;
          }
        | undefined;
      expect(turn?.status).toBe("completed");
      expect(turn?.turnStartedAtMs).toBe(104);
      expect(turn?.firstTurnWorkItemStartedAtMs).toBeGreaterThanOrEqual(patchObservedAt);
      expect(item?.itemId ?? "").toBe("patch-live");
      expect(item?.status ?? "").toBe("declined");
      expect(item?.createdAt).toBe(beforeItem?.createdAt);
      expect(item?.updatedAt).toBe(beforeItem?.updatedAt);
      expect(`${item?.kind}:${item?.semanticKind}`).toBe("fileChange:patch");
      expect(getCodexFileChangePaths(item?.fileChange?.changes).join(",")).toBe("src/app.ts");
      expect(getCodexFileChangeList(item?.fileChange?.changes)[0]?.type ?? "").toBe("update");
      expect(rawItem?.changes === changes).toBe(true);
      expect(rawItem?.status).toBe("declined");
      expect(rawItem?.extension === rawExtension).toBe(true);
      expect(manager.readConversation("thread-1")?.updatedAt).toBe(103);
      expect(publishRecords.length).toBe(0);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      const changes: never[] = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-128:1",
        occurrenceToken: 1,
        hostId: "local",
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
      const canonicalItem = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.items[0];
      const publishRecords = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      expect(turn?.items.length).toBe(0);
      expect(turn?.itemIds).toEqual(["shared-item"]);
      expect(item).toBeUndefined();
      expect(rawItem).toBeUndefined();
      expect(canonicalItem?.type).toBe("fileChange");
      expect(canonicalItem?.type === "fileChange" && canonicalItem.changes === changes).toBe(true);
      expect(publishRecords.length).toBe(0);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-129:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-130:2",
        occurrenceToken: 2,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );

      expect(turn?.items.map((item) => item.itemId).join(",")).toBe("before,after");
      expect(target).toBeUndefined();
      expect(targetRaw).toBeUndefined();
      expect(
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState)[0]?.items[1]
          ?.type,
      ).toBe("fileChange");
      expect(patchPublishes.length).toBe(0);

      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-131:3",
        occurrenceToken: 3,
        hostId: "local",
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

  test("owner fileChange patchUpdated rebinds the latest placeholder without publishing intermediate changes", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      resumeThreadResult = buildConversation("thread-1", "project-1");
      await manager.requestThreadStreamResume("thread-1");
      await manager.compactThread("thread-1");
      await flushAsyncWork();
      expect(
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState).at(-1)
          ?.turnId,
      ).toBeNull();
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-132:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      expect(String(conversation?.turns.length ?? -1)).toBe("1");
      expect(conversation?.turns[0]?.turnId).toBe("turn-real");
      expect(conversation?.turns[0]?.items.some((item) => item.itemId === "patch-live")).toBe(true);
      expect(
        getCodexFileChangePaths(
          conversation?.turns[0]?.items.find((item) => item.itemId === "patch-live")?.fileChange
            ?.changes,
        ).join(","),
      ).toBe("poem.md");
      expect(publishRecords.length).toBe(0);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner fileChange patchUpdated ignores an ordinary missing named turn", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-133:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      expect(manager.readConversation("thread-1") === beforeConversation).toBe(true);
      expect(manager.readConversation("thread-1")?.turns[0]?.turnId).toBe("turn-existing");
      expect(manager.readConversation("thread-1")?.turns[0]?.items.length).toBe(0);
      expect(publishRecords.length).toBe(0);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-134:1",
        occurrenceToken: 1,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
      );

      expect(turn?.turnId).toBe("turn-real");
      expect(turn?.status).toBe("inProgress");
      expect(typeof turn?.turnStartedAtMs).toBe("number");
      expect(turn?.firstTurnWorkItemStartedAtMs ?? null).toBe(null);
      expect(turn?.items.length).toBe(0);
      expect(turn?.itemIds.length).toBe(0);
      expect(conversation?.updatedAt).toBe(71);
      expect(publishRecords.length).toBe(1);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test.each([false, true])(
    "follower targeted interrupt preserves turn identity and goal pause failure: %s",
    async (pauseFailed) => {
      invokeCalls = [];
      invokeRecords = [];
      hostMessageListener = null;
      rendererClientRequestListener = null;
      threadListByProject = {};
      followerActionResult = {
        interruptedTurnId: "turn-1",
        ...(pauseFailed ? { goalPauseError: "Failed to pause thread goal" } : {}),
      };
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
          hostId: "local",
          conversationId: "thread-1",
          version: 1,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: baseConversation,
          },
          sourceClientId: "owner-a",
        });

        const interrupted = manager.interruptTurn("thread-1", "turn-1");
        if (pauseFailed)
          await expect(interrupted).rejects.toMatchObject({
            message: "Failed to pause thread goal",
            interruptedTurnId: "turn-1",
          });
        else expect(await interrupted).toBe(true);
        const followerRecord = invokeRecords.find(
          (record) => record.channel === "peer:requestThreadFollower",
        );
        const followerPayload = followerRecord?.args[0] as
          | {
              request?: {
                method?: string;
                params?: {
                  type?: string;
                  turnId?: string;
                };
              };
            }
          | undefined;
        expect(Boolean(followerRecord)).toBe(true);
        expect(followerPayload?.request).toMatchObject({
          method: "thread-follower-interrupt-turn",
          params: { conversationId: "thread-1", mode: "user-stop", expectedTurnId: "turn-1" },
        });
        expect(invokeRecords.some((record) => record.channel === "codex:turn:interrupt")).toBe(
          false,
        );
        expect(manager.readConversation("thread-1")?.turns[0]?.status).toBe("inProgress");
      } finally {
        followerActionResult = null;
        manager.destroy();
      }
    },
  );

  test("follower targeted interrupt recovery preserves the expected-turn race guard", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "owner-a",
      });

      resumeThreadResult = baseConversation;
      const interrupted = await manager.interruptTurn("thread-1", "stale-turn");

      expect(interrupted).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        true,
      );
      expect(
        recordedNativeRequests().some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (record.args[0] as { request: { method: string } }).request.method === "turn/interrupt",
        ),
      ).toBe(false);
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:thread:resume:prepare" && record.args[0] === "thread-1",
        ),
      ).toBe(true);
    } finally {
      resumeThreadResult = null;
      followerActionError = null;
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower start steer settings and compact use their native owner request contracts", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    const latestFollowerAction = () =>
      invokeRecords.filter((record) => record.channel === "peer:requestThreadFollower").at(-1)
        ?.args[0] as
        | {
            conversationId?: string;
            request?: { method?: string; params?: Record<string, unknown> };
          }
        | undefined;

    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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

      followerActionResult = { result: { turnId: "turn-new" } };
      const presentationTicket = { ticketId: "01991e60-b800-7000-8000-000000000011" };
      const startResult = await manager.startTurn(
        "thread-1",
        "Continue",
        {
          permissionMode: "auto",
        },
        presentationTicket,
      );
      let routed = latestFollowerAction();
      expect(
        (
          startResult as {
            turnId?: string;
          } | null
        )?.turnId,
      ).toBe("turn-new");
      expect(readFollowerConversationId(routed)).toBe("thread-1");
      expect(routed?.request?.method).toBe("thread-follower-start-turn");
      expect(routed?.request?.params?.turnStart).toMatchObject({
        request: { threadId: "thread-1", input: [{ type: "text", text: "Continue" }] },
      });
      expect(
        invokeRecords.find((record) => record.channel === "codex:turn:native:prepare")?.args[0],
      ).toMatchObject({ presentationTicket });

      followerActionResult = { result: { turnId: "turn-1" } };
      const steerResult = await manager.steerTurn({
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        prompt: "  keep going  ",
        presentationTicket,
      });
      routed = latestFollowerAction();
      expect(steerResult?.turnId).toBe("turn-1");
      expect(routed?.request?.method).toBe("thread-follower-steer-turn");
      expect(routed?.request?.params).toMatchObject({
        conversationId: "thread-1",
        clientUserMessageId: expect.any(String),
        input: [{ type: "text", text: "  keep going  " }],
      });

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
      expect(settings.reasoningEffort).toBe("high");
      expect(routed?.request).toMatchObject({
        method: "thread-follower-update-thread-settings",
        params: {
          conversationId: "thread-1",
          threadSettings: {
            effort: "high",
            collaborationMode: { mode: "plan", settings: { reasoning_effort: "high" } },
          },
        },
      });

      followerActionResult = null;
      await manager.compactThread("thread-1");
      routed = latestFollowerAction();
      expect(readFollowerConversationId(routed)).toBe("thread-1");
      expect(routed?.request?.method).toBe("thread-follower-compact-thread");

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

  test("follower queue edits send whole captured messages to the current owner", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
      await manager.enqueueQueuedFollowUp("thread-1", "second queued prompt");
      await manager.reorderQueuedFollowUps("thread-1", ["queued-native-2", "queued-native-1"]);
      await manager.removeQueuedFollowUp("thread-1", "queued-native-1");
      const requests = invokeRecords
        .filter((record) => record.channel === "peer:requestThreadFollower")
        .map(
          (record) =>
            record.args[0] as {
              targetClientId: string;
              request: {
                method: string;
                params: {
                  conversationId: string;
                  state: import("../../../shared/codex-queued-message").CodexQueuedMessageState;
                };
              };
            },
        );
      expect(requests).toHaveLength(4);
      expect(
        requests.every(
          (request) =>
            request.targetClientId === "owner-a" &&
            request.request.method === "thread-follower-set-queued-follow-ups-state" &&
            request.request.params.conversationId === "thread-1",
        ),
      ).toBe(true);
      expect(
        requests.map((request) =>
          request.request.params.state["thread-1"]?.map((message) => message.id),
        ),
      ).toEqual([
        ["queued-native-1"],
        ["queued-native-1", "queued-native-2"],
        ["queued-native-2", "queued-native-1"],
        ["queued-native-2"],
      ]);
      expect(requests[0]?.request.params.state["thread-1"]?.[0]).toMatchObject({
        context: { prompt: "first queued prompt", fileAttachments: [], imageAttachments: [] },
        submissionOptions: { serviceTier: "fast" },
      });
      expect(
        manager.readConversation("thread-1")?.queuedFollowUps.entries.map((row) => row.prompt),
      ).toEqual(["second queued prompt"]);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower settings completes with its owner response before the replicated settings arrive", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    let resolved = false;
    let resolvedReasoningEffort = "";
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
      expect(resolved).toBe(true);
      expect(resolvedReasoningEffort).toBe("high");
      expect(manager.readConversation("thread-1")?.latestThreadSettings?.reasoningEffort).toBe(
        "high",
      );

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
      expect(manager.readConversation("thread-1")?.latestThreadSettings?.reasoningEffort).toBe(
        "high",
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower queue enqueue stays optimistic while its owner state write is pending", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    invokeRecords = [];
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    let acknowledge!: () => void;
    const acknowledgment = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    followerActionHandler = async () => {
      await acknowledgment;
      return {};
    };
    try {
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-1",
        sourceClientId: "owner-a",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
      });
      let resolved = false;
      const enqueue = manager.enqueueQueuedFollowUp("thread-1", "Queue this").then(() => {
        resolved = true;
      });
      await flushAsyncWork();
      expect(resolved).toBe(false);
      expect(
        manager.readConversation("thread-1")?.queuedFollowUps.entries.map((row) => row.prompt),
      ).toEqual(["Queue this"]);
      expect(
        invokeRecords.filter((record) => record.channel === "peer:requestThreadFollower"),
      ).toHaveLength(1);
      acknowledge();
      await enqueue;
      expect(resolved).toBe(true);
      expect(
        manager.readConversation("thread-1")?.queuedFollowUps.entries.map((row) => row.prompt),
      ).toEqual(["Queue this"]);
    } finally {
      acknowledge();
      followerActionHandler = null;
      manager.destroy();
    }
  });

  test("owner queue edits persist captured messages separately from the active transcript", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = withCanonicalState({
      ...buildConversation("thread-1", "project-1"),
      turns: [
        { threadId: "thread-1", turnId: "active", status: "inProgress", itemIds: [], items: [] },
      ],
    });
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      const before = manager.readConversation("thread-1")?.canonicalState;
      invokeRecords = [];
      await manager.enqueueQueuedFollowUp("thread-1", "first queued prompt", {
        serviceTier: "fast",
      });
      expect(queuedMessageFixtureState["thread-1"]?.[0]).toMatchObject({
        id: "queued-native-1",
        context: { prompt: "first queued prompt" },
        submissionOptions: { serviceTier: "fast" },
      });
      expect(
        manager.readConversation("thread-1")?.queuedFollowUps.entries.map((row) => row.prompt),
      ).toEqual(["first queued prompt"]);
      expect(manager.readConversation("thread-1")?.canonicalState).toBe(before);
      expect(
        invokeRecords.find((record) => record.channel === "peer:threadQueuedFollowUpsChanged")
          ?.args[0],
      ).toMatchObject({
        conversationId: "thread-1",
        messages: [{ id: "queued-native-1", context: { prompt: "first queued prompt" } }],
      });
      await manager.removeQueuedFollowUp("thread-1", "queued-native-1");
      expect(queuedMessageFixtureState["thread-1"]).toBeUndefined();
      expect(manager.readConversation("thread-1")?.queuedFollowUps.entries).toEqual([]);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-135:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-136:2",
        occurrenceToken: 2,
        hostId: "local",
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

  test("unloaded conversation resumes ownership before publishing its pending turn", async () => {
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
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      invokeRecords = [];

      await manager.startTurn("thread-1", "Continue", { permissionMode: "auto" });

      const channels = invokeRecords.map((record) => record.channel);
      const resumeIndex = channels.indexOf("codex:thread:resume:prepare");
      const turnStartIndex = recordedNativeRequests().findIndex(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "turn/start",
      );
      expect(resumeIndex).toBeGreaterThanOrEqual(0);
      expect(turnStartIndex).toBeGreaterThan(resumeIndex);
      expect(channels.includes("codex:turn:start")).toBe(false);
      expect(manager.getStreamRole("thread-1")?.role).toBe("owner");
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

  test("unloaded conversation resumes ownership before native steering", async () => {
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
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      invokeRecords = [];

      await manager.steerTurn({
        threadId: "thread-1",
        expectedTurnId: "turn-active",
        prompt: "Continue now",
      });

      const channels = invokeRecords.map((record) => record.channel);
      const resumeIndex = channels.indexOf("codex:thread:resume:prepare");
      const steerIndex = channels.indexOf("codex:turn:native-steer:execute");
      expect(resumeIndex).toBeGreaterThanOrEqual(0);
      expect(steerIndex).toBeGreaterThan(resumeIndex);
      expect(
        recordedNativeRequests().some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (
              record.args[0] as {
                request?: {
                  method?: string;
                };
              }
            ).request?.method === "turn/steer",
        ),
      ).toBe(false);
      expect(manager.getStreamRole("thread-1")?.role).toBe("owner");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      await Promise.all([
        manager.resumeInterruptedTurn("thread-1", { permissionMode: "auto" }),
        manager.resumeInterruptedTurn("thread-1", { permissionMode: "auto" }),
      ]);

      const resumeRequests = recordedNativeRequests().filter(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "turn/start",
      );
      const request = resumeRequests[0]?.args[0] as
        | {
            request?: {
              params?: {
                threadId?: string;
                clientUserMessageId?: string;
              };
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
      expect(residentConversationTurns(conversation?.canonicalState).at(-1)?.params.input).toEqual(
        [],
      );
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      const startDeferred: {
        resolve?: () => void;
      } = {};
      ownerTurnStartGate = () =>
        new Promise<void>((resolve) => {
          startDeferred.resolve = resolve;
        });
      const publishDeferred: {
        resolve?: (accepted: boolean) => void;
      } = {};
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
      const startRequest = recordedNativeRequests().find(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "turn/start",
      )?.args[0] as
        | {
            request?: {
              params?: {
                clientUserMessageId?: string;
                input?: unknown[];
              };
            };
          }
        | undefined;
      const optimisticUser = optimistic?.items.find((item) => item.semanticKind === "userMessage");
      expect(optimisticUser?.markdownText).toBe("Visible immediately");
      expect(startRequest?.request?.params?.input).toEqual([
        {
          type: "text",
          text: "Visible immediately",
          text_elements: [],
        },
      ]);
      expect(startRequest?.request?.params?.clientUserMessageId).toBe(
        optimisticUser?.rawItem && typeof optimisticUser.rawItem === "object"
          ? (
              optimisticUser.rawItem as {
                clientId?: string;
              }
            ).clientId
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

  test("owner follow-up user row is rendered before transport settles", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    let renderedTurnCount = 0;
    let transportStarted = false;
    let canonicalTurnCountAtTransportStart = -1;
    const startDeferred: {
      resolve?: () => void;
    } = {};
    ownerTurnStartHandler = () => {
      transportStarted = true;
      canonicalTurnCountAtTransportStart = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      ).length;
    };
    ownerTurnStartGate = () =>
      new Promise<void>((resolve) => {
        startDeferred.resolve = resolve;
      });

    function FollowUpProbe() {
      renderedTurnCount = useSyncExternalStore(
        (listener) => manager.addConversationCallback("thread-1", listener),
        () => manager.readConversation("thread-1")?.turns.length ?? 0,
      );
      return createElement("div", null, String(renderedTurnCount));
    }

    const probe = render(createElement(FollowUpProbe));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await settleAsyncRender();
      const startPromise = manager.startTurn("thread-1", "Follow up immediately", {
        permissionMode: "auto",
      });

      await act(async () => {
        for (let index = 0; index < 20; index += 1) {
          await settleAsyncRender();
          if (transportStarted) break;
        }
      });

      expect(transportStarted).toBe(true);
      expect(canonicalTurnCountAtTransportStart).toBe(1);
      expect(textContent(probe.container)).toBe("1");
      if (!startDeferred.resolve) throw new Error("Expected deferred owner start");
      startDeferred.resolve();
      await act(async () => {
        await startPromise;
      });
    } finally {
      probe.unmount();
      ownerTurnStartHandler = null;
      ownerTurnStartGate = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  for (const caller of ["local", "follower"] as const) {
    test(`${caller} submission waits for owner settings before inspecting a Turn`, async () => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      resumeThreadResult = { ...buildConversation("thread-1", "project-1"), turns: [] };
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      let releaseSettings!: () => void;
      let enteredSettings!: () => void;
      const settingsGate = new Promise<void>((resolve) => {
        releaseSettings = resolve;
      });
      const settingsEntered = new Promise<void>((resolve) => {
        enteredSettings = resolve;
      });
      ownerSettingsGate = async () => {
        enteredSettings();
        await settingsGate;
      };
      try {
        await manager.requestThreadStreamResume("thread-1");
        const settings = manager.setThreadSettingsForConversation("thread-1", {
          model: "model-after-settings",
          reasoningEffort: "low",
        });
        await settingsEntered;
        invokeRecords = [];
        const submission =
          caller === "local"
            ? manager.startTurn("thread-1", "Use the saved model", { collaborationMode: "plan" })
            : manager.handleThreadFollowerRequest({
                method: "thread-follower-start-turn",
                params: {
                  conversationId: "thread-1",
                  turnStart: {
                    request: {
                      threadId: "thread-1",
                      clientUserMessageId: "peer-settings-test",
                      input: [{ type: "text", text: "Use the saved model", text_elements: [] }],
                    },
                  },
                },
              });
        await flushAsyncWork();
        expect(invokeRecords.some((record) => record.channel === "codex:turn:native:inspect")).toBe(
          false,
        );
        releaseSettings();
        await settings;
        await submission;
        const turn = residentConversationTurns(
          manager.readConversation("thread-1")?.canonicalState,
        ).at(-1);
        expect(turn?.params.collaborationMode?.settings.model ?? turn?.params.model).toBe(
          "model-after-settings",
        );
        expect(
          turn?.params.collaborationMode?.settings.reasoning_effort ?? turn?.params.effort,
        ).toBe("low");
      } finally {
        releaseSettings();
        ownerSettingsGate = null;
        resumeThreadResult = null;
        manager.destroy();
      }
    });
  }

  for (const rejected of [false, true]) {
    test(`owner execution keeps later settings and restores permissions only on rejection: ${rejected}`, async () => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      resumeThreadResult = { ...buildConversation("thread-1", "project-1"), turns: [] };
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      try {
        await manager.requestThreadStreamResume("thread-1");
        await manager.setThreadSettingsForConversation("thread-1", {
          model: "next-turn-setting",
          reasoningEffort: "high",
        });
        const before = manager.readConversation("thread-1")!.canonicalState!;
        const execution: CodexPreparedTurnExecution = {
          model: "execution-only-model",
          reasoningEffort: null,
          shouldUpdateReasoningEffort: true,
          collaborationMode: {
            mode: "plan",
            settings: {
              model: "execution-only-model",
              reasoning_effort: null,
              developer_instructions: "Retain instructions",
            },
          },
          permissions: {
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "dangerFullAccess" },
          },
          previousPermissions: before.currentPermissions,
        };
        ownerTurnExecutionOverride.value = execution;
        ownerTurnStartHandler = () => {
          const admitted = manager.readConversation("thread-1")!.canonicalState!;
          expect(admitted.latestModel).toBe(execution.model);
          expect(admitted.latestReasoningEffort).toBeNull();
          expect(admitted.latestCollaborationMode).toEqual(execution.collaborationMode);
          expect(admitted.currentPermissions).toEqual(execution.permissions);
          expect(admitted.latestThreadSettings).toEqual(before.latestThreadSettings);
        };
        ownerTurnStartGate = async () => {
          await manager.setThreadSettingsForConversation("thread-1", { model: "newer-setting" });
        };
        ownerTurnStartError = rejected ? new Error("Native rejected execution") : null;
        const submission = manager.startTurn("thread-1", "Use execution settings");
        if (rejected) await expect(submission).rejects.toThrow("Native rejected execution");
        else await submission;
        const after = manager.readConversation("thread-1")!.canonicalState!;
        expect(after.latestThreadSettings?.model).toBe("newer-setting");
        expect(after.currentPermissions).toEqual(
          rejected ? before.currentPermissions : execution.permissions,
        );
        if (rejected) {
          expect(residentConversationTurns(after)).toEqual([]);
          expect(after.threadRuntimeStatus.type).toBe("idle");
        }
      } finally {
        delete ownerTurnExecutionOverride.value;
        ownerTurnStartError = null;
        ownerTurnStartHandler = null;
        ownerTurnStartGate = null;
        resumeThreadResult = null;
        manager.destroy();
      }
    });
  }

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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      const params = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.params;
      const startRequest = recordedNativeRequests().find(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "turn/start",
      )?.args[0] as
        | {
            request?: {
              params?: {
                collaborationMode?: import("@nodex/codex-app-server-protocol").CollaborationMode;
                model?: string;
                effort?: string;
                serviceTier?: string | null;
              };
            };
          }
        | undefined;

      expect(params?.collaborationMode?.mode).toBe("default");
      expect(params?.collaborationMode?.settings.model).toBe("gpt-5.6-sol");
      expect(params?.collaborationMode?.settings.reasoning_effort).toBe("xhigh");
      expect(params?.serviceTier).toBe("fast");
      expect(startRequest?.request?.params).toMatchObject({
        collaborationMode: {
          mode: "default",
          settings: { model: "gpt-5.6-sol", reasoning_effort: "xhigh" },
        },
        model: "gpt-5.6-sol",
        effort: "xhigh",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await flushAsyncWork();
      const beforeStart = manager.readConversation("thread-1")?.canonicalState;
      if (!beforeStart) throw new Error("Expected owner conversation before start");
      invokeRecords = [];

      const result = (await manager.startTurn("thread-1", "Continue", {
        permissionMode: "auto",
      })) as {
        turnId?: string;
        streamRevision?: number;
      } | null;

      const publishInput = invokeRecords.find(
        (record) => record.channel === "peer:threadStreamStateChanged",
      )?.args[0] as
        | {
            change?: {
              type?: string;
              revision?: number;
              baseRevision?: number;
              patches?: CodexConversationStateUpdate[];
            };
          }
        | undefined;
      const publishInputs = invokeRecords
        .filter((record) => record.channel === "peer:threadStreamStateChanged")
        .map(
          (record) =>
            record.args[0] as {
              change?: {
                type?: string;
                revision?: number;
                baseRevision?: number;
                patches?: CodexConversationStateUpdate[];
                conversationState?: CodexConversationSnapshot;
              };
            },
        );
      const optimistic = applyPatches(beforeStart, publishInput?.change?.patches ?? []);
      const rebound = applyPatches(optimistic, publishInputs[1]?.change?.patches ?? []);
      const optimisticTurn = residentConversationTurns(optimistic)[0];
      const reboundTurn = residentConversationTurns(rebound)[0];
      expect(result).toMatchObject({ turn: { id: "turn-owner-start" } });
      expect(publishInput?.change?.type).toBe("patches");
      expect(publishInput?.change?.revision).toBe(Number(publishInput?.change?.baseRevision) + 1);
      expect(optimisticTurn?.turnId).toBeNull();
      expect(optimisticTurn?.params.input).toMatchObject([{ type: "text", text: "Continue" }]);
      expect(optimisticTurn?.params.clientUserMessageId).toEqual(expect.any(String));
      expect(reboundTurn?.turnId).toBe("turn-owner-start");
      expect(reboundTurn?.params.clientUserMessageId).toBe(
        optimisticTurn?.params.clientUserMessageId,
      );
      expect(rebound.updatedAt).toBe(optimistic.updatedAt);
      expect(manager.readConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe(
        "Continue",
      );
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.startTurn("thread-1", "Edited prompt", { permissionMode: "auto" });

      const optimisticUser = manager.readConversation("thread-1")?.turns[0]?.items[0];
      const rawOptimisticUser =
        optimisticUser?.rawItem && typeof optimisticUser.rawItem === "object"
          ? (optimisticUser.rawItem as {
              clientId?: string;
            })
          : null;
      const clientId = rawOptimisticUser?.clientId;
      if (!clientId) {
        throw new Error("Expected optimistic client user-message identity");
      }

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-137:1",
        occurrenceToken: 1,
        hostId: "local",
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-138:2",
        occurrenceToken: 2,
        hostId: "local",
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
      expect(
        residentConversationTurns(conversation?.canonicalState)[0]?.items.map((item) => item.id),
      ).toEqual(["server-user-echo"]);

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-139:3",
        occurrenceToken: 3,
        hostId: "local",
        notification: {
          method: "item/started",
          params: {
            startedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-owner-start",
            item: {
              questions: null,
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      ownerTurnStartHandler = () => {
        const optimisticUser = manager.readConversation("thread-1")?.turns[0]?.items[0];
        const clientId =
          optimisticUser?.rawItem && typeof optimisticUser.rawItem === "object"
            ? (
                optimisticUser.rawItem as {
                  clientId?: string;
                }
              ).clientId
            : null;
        if (!clientId) throw new Error("Expected optimistic client user-message identity");

        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-140:1",
          occurrenceToken: 1,
          hostId: "local",
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
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-141:2",
          occurrenceToken: 2,
          hostId: "local",
          notification: {
            method: "item/started",
            params: {
              startedAtMs: 1,
              threadId: "thread-1",
              turnId: "turn-owner-start",
              item: {
                questions: null,
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
        dispatchCodexAppServerMessage("native-notification", {
          type: "nativeNotification",
          generation: resumeThreadGeneration,
          occurrenceId: "native-142:3",
          occurrenceToken: 3,
          hostId: "local",
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

  test("owner start rejection removes its empty placeholder and restores its prior runtime status", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await flushAsyncWork();
      const beforeStart = manager.readConversation("thread-1")?.canonicalState;
      if (!beforeStart) throw new Error("Expected owner conversation before failed start");
      invokeRecords = [];

      let caught: unknown = null;
      try {
        await manager.startTurn("thread-1", "Continue", { permissionMode: "auto" });
      } catch (error) {
        caught = error;
      }

      const publishInputs = invokeRecords
        .filter((record) => record.channel === "peer:threadStreamStateChanged")
        .map(
          (record) =>
            record.args[0] as {
              change?: {
                patches?: CodexConversationStateUpdate[];
              };
            },
        );
      const optimistic = applyPatches(beforeStart, publishInputs[0]?.change?.patches ?? []);
      const failed = manager.readConversation("thread-1");

      expect(caught).toMatchObject({ message: ownerTurnStartError?.message });
      expect(optimistic?.threadRuntimeStatus?.type).toBe("active");
      expect(failed?.threadRuntimeStatus?.type).toBe("idle");
      expect(failed?.statusType).toBe("idle");
      expect(failed?.turns).toEqual([]);
      expect(failed?.canonicalState?.currentPermissions).toEqual(beforeStart.currentPermissions);
      expect(failed?.canonicalState?.latestThreadSettings).toEqual(
        beforeStart.latestThreadSettings,
      );
      expect(failed?.updatedAt).toBe(optimistic?.updatedAt);
    } finally {
      resumeThreadResult = null;
      ownerTurnStartError = null;
      manager.destroy();
    }
  });

  test("endpoint loss fences old Turn callbacks from the recovered owner", async () => {
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

    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      manager.retainActiveConversation("thread-1");
      await manager.requestThreadStreamResume("thread-1");
      const startPromise = manager.startTurn("thread-1", "Continue", {
        permissionMode: "auto",
      });
      const retired = expect(startPromise).rejects.toThrow("App server request lifetime retired");
      await flushAsyncWork(3);
      expect(manager.readConversation("thread-1")?.turns[0]?.status).toBe("inProgress");

      resumeThreadGeneration += 1;
      const { dispatchCodexAppServerMessage: dispatchNativeLifetime } =
        await import("./app-server-message-bus");
      dispatchNativeLifetime("shared-object-updated", {
        hostId: "local",
        object: {
          objectType: "connection",
          objectId: "connection",
          value: { status: "connected", retries: 0 },
        },
      });
      await flushAsyncWork();
      await retired;
      expect(manager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      resumeThreadResult = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        threadRuntimeStatus: { type: "idle" },
        turns: [],
      });
      await manager.requestThreadStreamResume("thread-1");
      await flushAsyncWork(3);
      const recovered = manager.readConversation("thread-1")?.canonicalState;
      expect(manager.readConversation("thread-1")?.resumeState).toBe("resumed");
      ownerTurnStartError = new Error("endpoint generation lost");
      releaseTurnStart();
      await flushAsyncWork(3);

      expect(manager.readConversation("thread-1")?.canonicalState).toEqual(recovered);
      expect(manager.readConversation("thread-1")?.resumeState).toBe("resumed");
    } finally {
      releaseTurnStart();
      resumeThreadResult = null;
      ownerTurnStartError = null;
      ownerTurnStartGate = null;
      manager.destroy();
    }
  });

  test("owner queue storage stays independent while goal clear awaits its native notification", async () => {
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
          turnId: "turn-active",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      await waitForCondition(
        () => manager.readConversation("thread-1")?.canonicalState?.threadGoal?.status === "active",
        1000,
      );
      const before = manager.readConversation("thread-1")?.canonicalState;
      await manager.enqueueQueuedFollowUp("thread-1", "Queue this");
      expect(
        manager.readConversation("thread-1")?.queuedFollowUps.entries.map((row) => row.prompt),
      ).toEqual(["Queue this"]);
      expect(manager.readConversation("thread-1")?.canonicalState).toBe(before);
      await manager.clearThreadGoal("thread-1");
      expect(manager.readConversation("thread-1")?.canonicalState?.threadGoal?.status).toBe(
        "active",
      );
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        hostId: "local",
        generation: resumeThreadGeneration,
        occurrenceId: "queue-goal-clear",
        occurrenceToken: 1,
        notification: { method: "thread/goal/cleared", params: { threadId: "thread-1" } },
      });
      await flushAsyncWork();
      expect(manager.readConversation("thread-1")?.canonicalState?.threadGoal).toBeNull();
      expect(
        manager.readConversation("thread-1")?.queuedFollowUps.entries.map((row) => row.prompt),
      ).toEqual(["Queue this"]);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("resuming an interrupted queue preserves unrelated persisted send failures", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [
        { threadId: "thread-1", turnId: "active", status: "inProgress", itemIds: [], items: [] },
      ],
    };
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.enqueueQueuedFollowUp("thread-1", "Interrupted message");
      await manager.enqueueQueuedFollowUp("thread-1", "Failed message");
      queuedMessageFixtureState = {
        "thread-1": queuedMessageFixtureState["thread-1"]!.map((message, index) => ({
          ...message,
          pausedReason:
            index === 0 ? "Interrupted before the steer was accepted." : "Connection refused",
        })),
      };
      rendererQueuedMessageStorage.invalidate();
      await flushAsyncWork();
      await manager.resumeQueuedFollowUps("thread-1");
      await flushAsyncWork();
      expect(queuedMessageFixtureState["thread-1"]?.map((message) => message.pausedReason)).toEqual(
        [undefined, "Connection refused"],
      );
      expect(
        manager.readConversation("thread-1")?.queuedFollowUps.entries.map((entry) => entry.pause),
      ).toEqual([null, { kind: "failed", reason: "Connection refused" }]);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner send-now removes a captured queued message after native steering succeeds", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.enqueueQueuedFollowUp("thread-1", "send this now");
      const row = manager.readConversation("thread-1")?.queuedFollowUps.entries[0];
      if (!row) throw new Error("Expected captured queued message");
      const runtimeWorkspaceRoots =
        manager.readConversation("thread-1")?.canonicalState?.currentPermissions
          ?.runtimeWorkspaceRoots;
      invokeRecords = [];
      await manager.sendQueuedFollowUpNow("thread-1", row.followUpId);
      await flushAsyncWork();
      expect(
        invokeRecords.find((record) => record.channel === "codex:queued-messages:prepare-native")
          ?.args[3],
      ).toEqual({
        runtimeWorkspaceRoots,
        usePermissionSelection: false,
      });
      const native = invokeRecords.find(
        (record) => record.channel === "codex:turn:native-steer:execute",
      );
      expect(native?.args[0]).toMatchObject({
        clientUserMessageId: row.followUpId,
        request: {
          method: "turn/steer",
          params: {
            threadId: "thread-1",
            expectedTurnId: "turn-active",
            input: [{ type: "text", text: "send this now" }],
          },
        },
      });
      expect(manager.readConversation("thread-1")?.queuedFollowUps.entries).toEqual([]);
      expect(queuedMessageFixtureState["thread-1"] ?? []).toEqual([]);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("enabled server queue owns new follow-ups when the persisted queue is empty", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    nativeSupportsThreadQueue = true;
    const serverItems: Array<{
      id: string;
      clientUserMessageId: string;
      input: Array<{ type: "text"; text: string; text_elements: [] }>;
    }> = [];
    serverQueueRequestHandler = async (method, params) => {
      if (method === "thread/queue/list") return { data: [...serverItems], nextCursor: null };
      if (method === "thread/queue/add") {
        const input = params as {
          clientUserMessageId: string;
          input: Array<{ type: "text"; text: string; text_elements?: [] }>;
        };
        const queuedSubmission = {
          id: "server-queued-1",
          clientUserMessageId: input.clientUserMessageId,
          input: input.input.map((entry) => ({
            ...entry,
            text_elements: entry.text_elements ?? [],
          })),
        };
        serverItems.push(queuedSubmission);
        return { queuedSubmission };
      }
      throw new Error(`Unexpected server queue method: ${method}`);
    };
    resumeThreadResult = buildConversation("thread-1", "project-1");
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      await manager.enqueueQueuedFollowUp("thread-1", "server queued prompt");
      expect(queuedMessageFixtureState["thread-1"] ?? []).toEqual([]);
      expect(
        recordedNativeRequests()
          .map((record) => (record.args[0] as { request?: { method?: string } }).request?.method)
          .filter((method) => method?.startsWith("thread/queue/")),
      ).toEqual(["thread/queue/list", "thread/queue/add"]);
      expect(
        manager.readConversation("thread-1")?.queuedFollowUps.entries.map((entry) => entry.prompt),
      ).toEqual(["server queued prompt"]);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("a nonempty persisted queue keeps precedence when the server queue gate is enabled", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    nativeSupportsThreadQueue = true;
    queuedMessageFixtureState = {
      "thread-1": [
        {
          id: "local-existing",
          cwd: "/project-1",
          createdAt: 1,
          context: {
            prompt: "local existing",
            fileAttachments: [],
            addedFiles: [],
            commentAttachments: [],
            imageAttachments: [],
            workspaceRoots: ["/project-1"],
          },
        },
      ],
    };
    rendererQueuedMessageStorage.invalidate();
    serverQueueRequestHandler = async (method) => {
      throw new Error(`Server queue must stay unselected: ${method}`);
    };
    resumeThreadResult = buildConversation("thread-1", "project-1");
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      await manager.enqueueQueuedFollowUp("thread-1", "second local prompt");
      expect(
        queuedMessageFixtureState["thread-1"]?.map((message) => message.context.prompt),
      ).toEqual(["local existing", "second local prompt"]);
      expect(
        recordedNativeRequests().some((record) =>
          (
            record.args[0] as { request?: { method?: string } } | undefined
          )?.request?.method?.startsWith("thread/queue/"),
        ),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("server queue refreshes from the current native generation notification", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    nativeSupportsThreadQueue = true;
    let serverItems = [
      {
        id: "server-first",
        clientUserMessageId: "client-first",
        input: [{ type: "text" as const, text: "first server item", text_elements: [] }],
      },
    ];
    serverQueueRequestHandler = async (method) => {
      if (method === "thread/queue/list") return { data: serverItems, nextCursor: null };
      if (method === "thread/queue/delete") return { deleted: false };
      throw new Error(`Unexpected server queue method: ${method}`);
    };
    resumeThreadResult = buildConversation("thread-1", "project-1");
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.removeQueuedFollowUp("thread-1", "missing");
      expect(
        manager.readConversation("thread-1")?.queuedFollowUps.entries.map((entry) => entry.prompt),
      ).toEqual(["first server item"]);
      serverItems = [
        {
          id: "server-second",
          clientUserMessageId: "client-second",
          input: [{ type: "text", text: "second server item", text_elements: [] }],
        },
      ];
      const listCallsBeforeStale = recordedNativeRequests().filter(
        (record) =>
          (record.args[0] as { request?: { method?: string } } | undefined)?.request?.method ===
          "thread/queue/list",
      ).length;
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        hostId: "local",
        generation: resumeThreadGeneration + 1,
        occurrenceId: "stale-server-queue-change",
        occurrenceToken: 1,
        notification: { method: "thread/queue/changed", params: { threadId: "thread-1" } },
      });
      await flushAsyncWork();
      expect(
        recordedNativeRequests().filter(
          (record) =>
            (record.args[0] as { request?: { method?: string } } | undefined)?.request?.method ===
            "thread/queue/list",
        ),
      ).toHaveLength(listCallsBeforeStale);
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        hostId: "local",
        generation: resumeThreadGeneration,
        occurrenceId: "current-server-queue-change",
        occurrenceToken: 2,
        notification: { method: "thread/queue/changed", params: { threadId: "thread-1" } },
      });
      await waitForCondition(
        () =>
          manager.readConversation("thread-1")?.queuedFollowUps.entries[0]?.prompt ===
          "second server item",
        500,
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("server queue clears interrupted pause when a new resident turn starts", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    nativeSupportsThreadQueue = true;
    queuedMessageFixtureState = {};
    rendererQueuedMessageStorage.invalidate();
    const serverItems = [
      {
        id: "server-paused",
        clientUserMessageId: "server-paused-client",
        input: [{ type: "text" as const, text: "resume after interruption", text_elements: [] }],
      },
    ];
    serverQueueRequestHandler = async (method) => {
      if (method === "thread/queue/list") return { data: [...serverItems], nextCursor: null };
      throw new Error(`Unexpected server queue method: ${method}`);
    };
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.removeQueuedFollowUp("thread-1", "missing");
      expect(manager.readConversation("thread-1")?.queuedFollowUps.entries).toMatchObject([
        {
          prompt: "resume after interruption",
          pause: { kind: "interrupted" },
        },
      ]);

      await manager.resumeInterruptedTurn("thread-1", { permissionMode: "auto" });

      expect(manager.readConversation("thread-1")?.turns.at(-1)?.status).toBe("inProgress");
      expect(manager.readConversation("thread-1")?.queuedFollowUps.entries).toMatchObject([
        {
          prompt: "resume after interruption",
          pause: null,
        },
      ]);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("streaming server send-now steers with the server client message id then deletes the queue item", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    nativeSupportsThreadQueue = true;
    const serverItems = [
      {
        id: "server-queued",
        clientUserMessageId: "server-client-user-message",
        input: [{ type: "text" as const, text: "steer from server queue", text_elements: [] }],
      },
    ];
    serverQueueRequestHandler = async (method, params) => {
      if (method === "thread/queue/list") return { data: [...serverItems], nextCursor: null };
      if (method === "thread/queue/delete") {
        expect(params).toMatchObject({
          threadId: "thread-1",
          queuedSubmissionId: "server-queued",
        });
        return { deleted: true };
      }
      throw new Error(`Unexpected server queue method: ${method}`);
    };
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      await manager.sendQueuedFollowUpNow("thread-1", "server-queued");
      const preparation = invokeRecords.find(
        (record) => record.channel === "codex:queued-messages:prepare-native",
      );
      expect(preparation?.args[3]).toMatchObject({
        clientUserMessageId: "server-client-user-message",
      });
      const steer = invokeRecords.find(
        (record) => record.channel === "codex:turn:native-steer:execute",
      );
      expect(steer?.args[0]).toMatchObject({
        clientUserMessageId: "server-client-user-message",
        request: {
          method: "turn/steer",
          params: { threadId: "thread-1", expectedTurnId: "turn-active" },
        },
      });
      const steerIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:turn:native-steer:execute",
      );
      const deleteIndex = invokeRecords.findIndex((record) => {
        if (record.channel !== "codex:app-server:request") return false;
        return (
          (record.args[0] as { request?: { method?: string } }).request?.method ===
          "thread/queue/delete"
        );
      });
      expect(steerIndex).toBeGreaterThanOrEqual(0);
      expect(deleteIndex).toBeGreaterThan(steerIndex);
      expect(manager.readConversation("thread-1")?.queuedFollowUps.entries).toEqual([]);
      expect(queuedMessageFixtureState["thread-1"] ?? []).toEqual([]);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("idle server send-now starts the server queue item without renderer preparation", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    nativeSupportsThreadQueue = true;
    const serverItems = [
      {
        id: "server-idle",
        clientUserMessageId: "server-idle-client",
        input: [{ type: "text" as const, text: "start from server queue", text_elements: [] }],
      },
    ];
    serverQueueRequestHandler = async (method, params) => {
      if (method === "thread/queue/list") return { data: [...serverItems], nextCursor: null };
      if (method === "thread/queue/start") {
        expect(params).toMatchObject({
          threadId: "thread-1",
          queuedSubmissionId: "server-idle",
        });
        return { turn: { id: "server-started-turn", items: [], status: "inProgress" } };
      }
      throw new Error(`Unexpected server queue method: ${method}`);
    };
    resumeThreadResult = buildConversation("thread-1", "project-1");
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      await manager.sendQueuedFollowUpNow("thread-1", "server-idle");
      expect(
        invokeRecords.some((record) => record.channel === "codex:queued-messages:prepare-native"),
      ).toBe(false);
      expect(
        recordedNativeRequests().some(
          (record) =>
            (record.args[0] as { request?: { method?: string } }).request?.method ===
            "thread/queue/start",
        ),
      ).toBe(true);
      expect(manager.readConversation("thread-1")?.queuedFollowUps.entries).toEqual([]);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("queued execution uses the static permission-selection default", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.enqueueQueuedFollowUp("thread-1", "use static execution config");
      const message = queuedMessageFixtureState["thread-1"]?.[0];
      if (!message) throw new Error("Expected queued message");
      invokeRecords = [];
      await manager.sendQueuedFollowUpNow("thread-1", message.id);
      expect(
        invokeRecords.find((record) => record.channel === "codex:queued-messages:prepare-native")
          ?.args[3],
      ).toMatchObject({ usePermissionSelection: false });
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("captured permission selection is preserved for queued execution", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.enqueueQueuedFollowUp("thread-1", "captured execution config", {
        usePermissionSelection: false,
      });
      const message = queuedMessageFixtureState["thread-1"]?.[0];
      if (!message) throw new Error("Expected queued message");
      invokeRecords = [];
      await manager.sendQueuedFollowUpNow("thread-1", message.id);
      expect(
        invokeRecords.find((record) => record.channel === "codex:queued-messages:prepare-native")
          ?.args[3],
      ).toEqual({
        runtimeWorkspaceRoots:
          manager.readConversation("thread-1")?.canonicalState?.currentPermissions
            ?.runtimeWorkspaceRoots,
        usePermissionSelection: false,
      });
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("queued messages remain executable without a remote feature refresh", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      await manager.enqueueQueuedFollowUp("thread-1", "send when config is ready");
      await flushAsyncWork();
      expect(queuedMessageFixtureState["thread-1"]).toHaveLength(1);
      const message = queuedMessageFixtureState["thread-1"]?.[0];
      if (!message) throw new Error("Expected queued message");
      invokeRecords = [];
      await manager.sendQueuedFollowUpNow("thread-1", message.id);
      expect(
        invokeRecords.find((record) => record.channel === "codex:queued-messages:prepare-native")
          ?.args[3],
      ).toMatchObject({ usePermissionSelection: false });
      expect(queuedMessageFixtureState["thread-1"] ?? []).toEqual([]);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("native reconnects preserve the static queued permission default", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadGeneration = 1;
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await act(async () => {
        dispatchCodexAppServerMessage("shared-object-updated", {
          hostId: "local",
          object: {
            objectType: "connection",
            objectId: "connection",
            value: {
              status: "connected",
              retries: 0,
              native: {
                generation: 1,
                sourceEpoch: "test-native",
                transportKind: "websocket",
              },
            },
          },
        });
        await flushAsyncWork();
      });

      resumeThreadGeneration = 2;
      await act(async () => {
        dispatchCodexAppServerMessage("shared-object-updated", {
          hostId: "local",
          object: {
            objectType: "connection",
            objectId: "connection",
            value: {
              status: "connected",
              retries: 1,
              native: {
                generation: 2,
                sourceEpoch: "test-native",
                transportKind: "websocket",
              },
            },
          },
        });
      });
      resumeThreadGeneration = 3;
      await act(async () => {
        dispatchCodexAppServerMessage("shared-object-updated", {
          hostId: "local",
          object: {
            objectType: "connection",
            objectId: "connection",
            value: {
              status: "connected",
              retries: 2,
              native: {
                generation: 3,
                sourceEpoch: "test-native",
                transportKind: "websocket",
              },
            },
          },
        });
        await flushAsyncWork();
      });
      await waitForCondition(
        () => manager.readConversation("thread-1")?.resumeState === "resumed",
        500,
      );

      await manager.enqueueQueuedFollowUp("thread-1", "use the static default");
      const message = queuedMessageFixtureState["thread-1"]?.[0];
      if (!message) throw new Error("Expected queued message");
      invokeRecords = [];
      await manager.sendQueuedFollowUpNow("thread-1", message.id);
      expect(
        invokeRecords.find((record) => record.channel === "codex:queued-messages:prepare-native")
          ?.args[3],
      ).toMatchObject({ usePermissionSelection: false });
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("queued workspace roots preserve an explicit empty set", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.enqueueQueuedFollowUp("thread-1", "empty roots are explicit");
      const message = queuedMessageFixtureState["thread-1"]?.[0];
      if (!message) throw new Error("Expected queued message");
      queuedMessageFixtureState = {
        "thread-1": [{ ...message, context: { ...message.context, workspaceRoots: [] } }],
      };
      rendererQueuedMessageStorage.invalidate();
      await flushAsyncWork();
      invokeRecords = [];
      await manager.sendQueuedFollowUpNow("thread-1", message.id);
      expect(
        invokeRecords.find((record) => record.channel === "codex:queued-messages:prepare-native")
          ?.args[3],
      ).toEqual({ runtimeWorkspaceRoots: [], usePermissionSelection: false });
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("queued workspace roots pause when any captured root is empty", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
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
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await manager.enqueueQueuedFollowUp("thread-1", "invalid root pauses");
      const message = queuedMessageFixtureState["thread-1"]?.[0];
      if (!message) throw new Error("Expected queued message");
      queuedMessageFixtureState = {
        "thread-1": [
          {
            ...message,
            context: { ...message.context, workspaceRoots: [" ".trim()] },
          },
        ],
      };
      rendererQueuedMessageStorage.invalidate();
      await flushAsyncWork();
      invokeRecords = [];
      await manager.sendQueuedFollowUpNow("thread-1", message.id);
      expect(
        invokeRecords.some((record) => record.channel === "codex:queued-messages:prepare-native"),
      ).toBe(false);
      expect(queuedMessageFixtureState["thread-1"]?.[0]?.pausedReason).toBe(
        "workspace-unavailable",
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("resume manager retains internal workspace and collaboration context off the thread/resume wire", async () => {
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    resumeThreadResult = {
      ...buildConversation("thread-1", "project-1"),
      turns: [],
    };
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      const collaborationMode = {
        mode: "plan" as const,
        settings: {
          model: "gpt-test-fixture",
          reasoning_effort: "high" as const,
          developer_instructions: null,
        },
      };
      await manager.requestThreadStreamResume("thread-1", {
        serviceTier: "fast",
        workspaceRoots: ["/captured-root"],
        collaborationMode,
        useAppServerPermissionDefault: false,
      });
      const resumePreparationOptions = invokeRecords
        .filter((record) => record.channel === "codex:thread:resume:prepare")
        .map((record) => record.args[3]);
      expect(resumePreparationOptions).toContainEqual(
        expect.objectContaining({
          serviceTier: "fast",
          useAppServerPermissionDefault: false,
          workspaceRoots: ["/captured-root"],
          collaborationMode,
        }),
      );
      const wireResume = recordedNativeRequests().find(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (record.args[0] as { request?: { method?: string } }).request?.method === "thread/resume",
      );
      const wireParams = (wireResume?.args[0] as { request?: { params?: Record<string, unknown> } })
        ?.request?.params;
      expect(wireParams).toBeDefined();
      expect(wireParams).not.toHaveProperty("workspaceRoots");
      expect(wireParams).not.toHaveProperty("collaborationMode");
      expect(wireParams?.serviceTier).toBe("fast");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];
      const publishDeferred: {
        resolve?: (accepted: boolean) => void;
      } = {};
      let publishCount = 0;
      ownerStreamPublishHandler = () => {
        publishCount += 1;
        if (publishCount > 1) return true;
        return new Promise<boolean>((resolve) => {
          publishDeferred.resolve = resolve;
        });
      };
      const steerDeferred: {
        resolve?: (result: { turnId: string }) => void;
      } = {};
      const exactSteerParams: Array<{
        expectedTurnId?: string;
        prompt?: string;
        intent?: {
          steerId?: string;
          recoveryRow?: {
            clientUserMessageId?: string;
            prompt?: string;
          };
        };
      }> = [];
      ownerTurnSteerHandler = (params) => {
        exactSteerParams.push(params as (typeof exactSteerParams)[number]);
        return new Promise<{
          turnId: string;
        }>((resolve) => {
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
      const pending = residentConversationTurns(
        optimisticConversation?.canonicalState,
      )[0]?.items.find((item) => item.type === "steeringUserMessage");
      expect(pending).toMatchObject({ status: "pending", targetTurnId: "turn-active" });
      expect(optimisticSteer?.markdownText).toBe("adjust the active turn");
      expect(exactSteerParams[0]).toMatchObject({
        expectedTurnId: "turn-active",
        input: [{ type: "text", text: "adjust the active turn" }],
      });
      expect(
        invokeRecords.some((record) => record.channel === "codex:turn:native-steer:execute"),
      ).toBe(true);
      expect(
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
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
        residentConversationTurns(
          manager.readConversation("thread-1")?.canonicalState,
        )[0]?.items.at(-1)?.type,
      ).toBe("steeringUserMessage");
      expect(
        recordedNativeRequests().some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (
              record.args[0] as {
                request?: {
                  method?: string;
                };
              }
            ).request?.method === "turn/steer",
        ),
      ).toBe(false);
    } finally {
      ownerTurnSteerHandler = null;
      ownerStreamPublishHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  for (const failure of ["no-client-found", "timeout", "request denied"] as const) {
    test(`steering owner recovery handles ${failure} without duplicate submission`, async () => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      const requests: unknown[] = [];
      const snapshot = withCanonicalState({
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
      resumeThreadResult = snapshot;
      followerActionHandler = (input) => {
        if (
          (input as { request?: { method?: string } }).request?.method ===
          "thread-follower-steer-turn"
        )
          throw new Error(failure);
        return null;
      };
      ownerTurnSteerHandler = (params) => {
        requests.push(params);
        return { turnId: "turn-active" };
      };
      try {
        await act(async () => {
          dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
            hostId: "local",
            conversationId: "thread-1",
            version: 1,
            sourceClientId: "owner-a",
            change: { type: "snapshot", revision: 1, conversationState: snapshot },
          });
          const steering = manager.steerTurn({
            threadId: "thread-1",
            prompt: "preserve my submission",
          });
          if (failure === "no-client-found") {
            await expect(steering).resolves.toEqual({ turnId: "turn-active" });
            expect(requests).toEqual([
              expect.objectContaining({
                expectedTurnId: "turn-active",
                clientUserMessageId: nativeSteerFixture?.clientUserMessageId,
                input: [{ type: "text", text: "preserve my submission", text_elements: [] }],
              }),
            ]);
            expect(manager.getStreamRole("thread-1")?.role).toBe("owner");
          } else {
            await expect(steering).rejects.toThrow(failure);
            expect(requests).toEqual([]);
            expect(manager.getStreamRole("thread-1")?.role).toBe("follower");
          }
        });
      } finally {
        followerActionHandler = null;
        ownerTurnSteerHandler = null;
        resumeThreadResult = null;
        manager.destroy();
      }
    });
  }

  for (const mismatch of [false, true]) {
    test(`native steering selects the latest Turn and preserves identity across mismatch=${mismatch}`, async () => {
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

      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      try {
        await manager.requestThreadStreamResume("thread-1");
        invokeRecords = [];
        const requests: Array<{
          expectedTurnId?: string;
          prompt?: string;
          intent?: {
            steerId?: string;
            recoveryRow?: {
              clientUserMessageId?: string;
              prompt?: string;
            };
          };
        }> = [];
        ownerTurnSteerHandler = (params) => {
          requests.push(params as (typeof requests)[number]);
          if (mismatch && requests.length === 1)
            throw new Error(
              'ExpectedTurnMismatch { expected: "turn-actual", actual: "turn-corrected" }',
            );
          return { turnId: mismatch ? "turn-corrected" : "turn-actual" };
        };

        const result = await manager.steerTurn({
          threadId: "thread-1",
          expectedTurnId: "turn-stale",
          prompt: "same prepared steer",
        });

        expect(result?.turnId).toBe(mismatch ? "turn-corrected" : "turn-actual");
        expect(requests.map((request) => request.expectedTurnId)).toEqual(
          mismatch ? ["turn-actual", "turn-corrected"] : ["turn-actual"],
        );
        expect(requests[0]).toMatchObject({
          input: [{ type: "text", text: "same prepared steer" }],
        });
        const canonicalTurns =
          residentConversationTurns(manager.readConversation("thread-1")?.canonicalState) ?? [];
        expect(canonicalTurns[0]?.items.some((item) => item.type === "steeringUserMessage")).toBe(
          false,
        );
        expect(
          canonicalTurns[1]?.items.find((item) => item.type === "steeringUserMessage"),
        ).toMatchObject({
          clientUserMessageId: nativeSteerFixture?.clientUserMessageId,
          targetTurnId: mismatch ? "turn-corrected" : "turn-actual",
        });
      } finally {
        ownerTurnSteerHandler = null;
        resumeThreadResult = null;
        manager.destroy();
      }
    });
  }

  for (const invalidation of ["owner-replacement", "conversation-replacement"] as const) {
    test(`native interruption cannot complete into ${invalidation}`, async () => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      const snapshot = () =>
        withCanonicalState({
          ...buildConversation("thread-1", "project-1"),
          statusType: "active",
          turns: [
            {
              threadId: "thread-1",
              turnId: "active",
              status: "inProgress",
              itemIds: [],
              items: [],
            },
          ],
        });
      let finish: (() => void) | undefined;
      ownerInterruptHandler = () =>
        new Promise((resolve) => {
          finish = () => resolve({});
        });
      resumeThreadResult = snapshot();
      try {
        await act(async () => {
          await manager.requestThreadStreamResume("thread-1");
          const pending = manager.interruptTurn("thread-1", "active").then(
            (value) => ({ accepted: true, value }),
            (error: unknown) => ({ accepted: false, error }),
          );
          await flushAsyncWork();
          expect(finish).toBeDefined();
          resumeThreadResult = snapshot();
          if (invalidation === "conversation-replacement") {
            dispatchCodexAppServerMessage("thread-deleted", {
              hostId: "local",
              threadId: "thread-1",
            });
          } else {
            dispatchTestThreadStreamStateChanged(manager, {
              hostId: "local",
              conversationId: "thread-1",
              version: 2,
              sourceClientId: "owner-b",
              change: { type: "snapshot", revision: 2, conversationState: resumeThreadResult },
            });
            disconnectFixtureOwner(manager, "thread-1");
          }
          await manager.requestThreadStreamResume("thread-1");
          const recovered = structuredClone(manager.readConversation("thread-1")?.canonicalState);
          invokeRecords = [];
          finish!();
          expect(await pending).toMatchObject({ accepted: false });
          expect(manager.readConversation("thread-1")?.canonicalState).toEqual(recovered);
          expect(
            invokeRecords.some((record) => record.channel === "codex:thread:node-repl:cleanup"),
          ).toBe(false);
        });
      } finally {
        finish?.();
        ownerInterruptHandler = null;
        resumeThreadResult = null;
        manager.destroy();
      }
    });
  }

  for (const outcome of ["success", "failure"] as const) {
    test(`context compaction cannot deliver late ${outcome} into a replacement owner`, async () => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      const snapshot = (turnId: string) =>
        withCanonicalState({
          ...buildConversation("thread-1", "project-1"),
          statusType: "active",
          turns: [{ threadId: "thread-1", turnId, status: "inProgress", itemIds: [], items: [] }],
        });
      let finish: (() => void) | undefined;
      ownerCompactionHandler = () =>
        new Promise((resolve, reject) => {
          finish = () =>
            outcome === "success" ? resolve({}) : reject(new Error("Old compaction failed"));
        });
      resumeThreadResult = snapshot("old-turn");
      try {
        await act(async () => {
          await manager.requestThreadStreamResume("thread-1");
          const pending = manager.compactThread("thread-1").then(
            () => ({ accepted: true }),
            (error: unknown) => ({ accepted: false, error }),
          );
          await flushAsyncWork();
          expect(finish).toBeDefined();
          resumeThreadResult = snapshot("new-turn");
          if (outcome === "failure") {
            dispatchCodexAppServerMessage("thread-deleted", {
              hostId: "local",
              threadId: "thread-1",
            });
          } else {
            dispatchTestThreadStreamStateChanged(manager, {
              hostId: "local",
              conversationId: "thread-1",
              version: 2,
              sourceClientId: "owner-b",
              change: { type: "snapshot", revision: 2, conversationState: resumeThreadResult },
            });
            disconnectFixtureOwner(manager, "thread-1");
          }
          await manager.requestThreadStreamResume("thread-1");
          ownerCompactionHandler = null;
          await manager.compactThread("thread-1");
          const recovered = structuredClone(manager.readConversation("thread-1")?.canonicalState);
          finish!();
          expect(await pending).toMatchObject({ accepted: false });
          expect(manager.readConversation("thread-1")?.canonicalState).toEqual(recovered);
        });
      } finally {
        ownerCompactionHandler = null;
        resumeThreadResult = null;
        manager.destroy();
      }
    });
  }

  for (const invalidation of ["owner-replacement", "conversation-replacement"] as const) {
    test(`native steering cannot complete into ${invalidation}`, async () => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      const snapshot = (turnId: string) =>
        withCanonicalState({
          ...buildConversation("thread-1", "project-1"),
          statusType: "active",
          turns: [{ threadId: "thread-1", turnId, status: "inProgress", itemIds: [], items: [] }],
        });
      let finish: ((result: { turnId: string }) => void) | undefined;
      ownerTurnSteerHandler = () =>
        new Promise((resolve) => {
          finish = resolve;
        });
      resumeThreadResult = snapshot("turn-old");
      try {
        await act(async () => {
          await manager.requestThreadStreamResume("thread-1");
          const pending = manager.steerTurn({ threadId: "thread-1", prompt: "late steering" }).then(
            (value) => ({ accepted: true, value }),
            (error: unknown) => ({ accepted: false, error }),
          );
          await flushAsyncWork();
          expect(finish).toBeDefined();
          resumeThreadResult = snapshot("turn-new");
          if (invalidation === "conversation-replacement") {
            dispatchCodexAppServerMessage("thread-deleted", {
              hostId: "local",
              threadId: "thread-1",
            });
          } else {
            dispatchTestThreadStreamStateChanged(manager, {
              hostId: "local",
              conversationId: "thread-1",
              version: 2,
              sourceClientId: "owner-b",
              change: { type: "snapshot", revision: 2, conversationState: resumeThreadResult },
            });
            disconnectFixtureOwner(manager, "thread-1");
          }
          await manager.requestThreadStreamResume("thread-1");
          await flushAsyncWork();
          expect(manager.getStreamRole("thread-1")?.role).toBe("owner");
          const recovered = structuredClone(manager.readConversation("thread-1")?.canonicalState);
          finish!({ turnId: "turn-old" });
          expect(await pending).toMatchObject({ accepted: false });
          expect(manager.readConversation("thread-1")?.canonicalState).toEqual(recovered);
        });
      } finally {
        ownerTurnSteerHandler = null;
        resumeThreadResult = null;
        manager.destroy();
      }
    });
  }

  test("an unknown steer outcome retains its pending message until a late server echo accepts it", async () => {
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
          turnId: "turn-active",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
    });
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await flushAsyncWork();
      vi.useFakeTimers();
      let resolveSteer!: (result: { turnId: string }) => void;
      ownerTurnSteerHandler = () =>
        new Promise((resolve) => {
          resolveSteer = resolve;
        });
      let settled = false;
      const steering = manager
        .steerTurn({
          threadId: "thread-1",
          expectedTurnId: "turn-active",
          prompt: "Delayed answer",
        })
        .finally(() => {
          settled = true;
        });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(settled).toBe(false);
      expect(
        manager.readConversation("thread-1")?.canonicalState?.unconfirmedTurnSubmissions,
      ).toHaveLength(1);
      const pending = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.items.find((item) => item.type === "steeringUserMessage");
      expect(pending).toMatchObject({ status: "pending" });
      if (pending?.type !== "steeringUserMessage") throw new Error("Missing pending steer");
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-143:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "item/completed",
          params: {
            completedAtMs: 1,
            threadId: "thread-1",
            turnId: "turn-active",
            item: {
              id: "late-echo",
              type: "userMessage",
              clientId: pending.clientUserMessageId,
              content: [{ type: "text", text: "Delayed answer", text_elements: [] }],
            },
          },
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      const accepted = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.items.find((item) => item.id === pending.id);
      expect(accepted).toMatchObject({
        status: "accepted",
        clientUserMessageId: pending.clientUserMessageId,
      });
      resolveSteer({ turnId: "turn-active" });
      await expect(steering).resolves.toEqual({ turnId: "turn-active" });
    } finally {
      vi.useRealTimers();
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
    followerActionResult = { ok: true };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            ...buildConversation("thread-1", "project-1"),
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
                id: "file-approval-1",
                method: "item/fileChange/requestApproval",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "file-1",
                  startedAtMs: 2,
                },
              },
              {
                id: "input-1",
                method: "item/tool/requestUserInput",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "input-call",
                  isBlocking: true,
                  autoResolutionMs: null,
                  questions: [
                    {
                      id: "q1",
                      header: "Question",
                      question: "Pick one",
                      isOther: false,
                      isSecret: false,
                      options: null,
                    },
                  ],
                },
              },
              {
                id: "mcp-1",
                method: "mcpServer/elicitation/request",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  serverName: "server",
                  mode: "form",
                  _meta: null,
                  message: "Confirm",
                  requestedSchema: { type: "object", properties: {} },
                },
              },
              {
                id: "permission-1",
                method: "item/permissions/requestApproval",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "permission-call",
                  environmentId: null,
                  startedAtMs: 5,
                  cwd: "/repo",
                  reason: "Need access",
                  permissions: { network: { enabled: true }, fileSystem: null },
                },
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
        .filter((record) => record.channel === "peer:requestThreadFollower")
        .map(
          (record) =>
            record.args[0] as {
              request?: {
                method?: string;
                params?: {
                  conversationId?: string;
                  requestId?: string;
                  decision?: string;
                  response?: {
                    action?: string;
                    scope?: string;
                    answers?: Record<string, { answers?: string[] }>;
                  };
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
      expect(followerActions[0]?.request?.method).toBe("thread-follower-command-approval-decision");
      expect(followerActions[0]?.request?.params?.conversationId).toBe("thread-1");
      expect(followerActions[0]?.request?.params?.requestId).toBe("approval-1");
      expect(followerActions[0]?.request?.params?.decision).toBe("decline");
      expect(followerActions[1]?.request?.method).toBe("thread-follower-file-approval-decision");
      expect(followerActions[1]?.request?.params?.requestId).toBe("file-approval-1");
      expect(followerActions[1]?.request?.params?.decision).toBe("decline");
      expect(followerActions[2]?.request?.method).toBe("thread-follower-submit-user-input");
      expect(followerActions[2]?.request?.params?.requestId).toBe("input-1");
      expect(followerActions[2]?.request?.params?.response?.answers?.q1?.answers?.[0]).toBe("A");
      expect(followerActions[3]?.request?.method).toBe(
        "thread-follower-submit-mcp-server-elicitation-response",
      );
      expect(followerActions[3]?.request?.params?.requestId).toBe("mcp-1");
      expect(followerActions[3]?.request?.params?.response?.action).toBe("decline");
      expect(followerActions[4]?.request?.method).toBe(
        "thread-follower-permissions-request-approval-response",
      );
      expect(followerActions[4]?.request?.params?.requestId).toBe("permission-1");
      expect(followerActions[4]?.request?.params?.response?.scope).toBe("turn");
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
    followerActionResult = { ok: true };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
        .filter((record) => record.channel === "peer:requestThreadFollower")
        .map(
          (record) =>
            record.args[0] as {
              conversationId?: string;
              request?: {
                method?: string;
                params?: {
                  conversationId?: string;
                  requestId?: string;
                  decision?: string;
                  response?: {
                    action?: string;
                    scope?: string;
                    answers?: Record<string, { answers?: string[] }>;
                  };
                };
              };
            },
        );

      expect(approvalAccepted).toBe(true);
      expect(inputAccepted).toBe(true);
      expect(mcpAccepted).toBe(true);
      expect(permissionAccepted).toBe(true);
      expect(String(followerActions.length)).toBe("4");
      expect(readFollowerConversationId(followerActions[0])).toBe("thread-1");
      expect(followerActions[0]?.request?.method).toBe("thread-follower-command-approval-decision");
      expect(followerActions[0]?.request?.params?.conversationId).toBe("thread-1");
      expect(followerActions[0]?.request?.params?.requestId).toBe("approval-missed");
      expect(followerActions[0]?.request?.params?.decision).toBe("decline");
      expect(followerActions[1]?.request?.method).toBe("thread-follower-submit-user-input");
      expect(followerActions[1]?.request?.params?.conversationId).toBe("thread-1");
      expect(followerActions[1]?.request?.params?.requestId).toBe("input-missed");
      expect(followerActions[1]?.request?.params?.response?.answers?.q1?.answers?.[0]).toBe("A");
      expect(followerActions[2]?.request?.method).toBe(
        "thread-follower-submit-mcp-server-elicitation-response",
      );
      expect(followerActions[2]?.request?.params?.conversationId).toBe("thread-1");
      expect(followerActions[2]?.request?.params?.requestId).toBe("mcp-missed");
      expect(followerActions[2]?.request?.params?.response?.action).toBe("decline");
      expect(followerActions[3]?.request?.method).toBe(
        "thread-follower-permissions-request-approval-response",
      );
      expect(followerActions[3]?.request?.params?.conversationId).toBe("thread-1");
      expect(followerActions[3]?.request?.params?.requestId).toBe("permission-missed");
      expect(followerActions[3]?.request?.params?.response?.scope).toBe("turn");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: {
            ...buildConversation("thread-1", "project-1"),
            resumeState: "resumed",
            canonicalRequests: [
              {
                id: "approval-1",
                method: "item/commandExecution/requestApproval",
                params: {
                  kind: "command",
                  startedAtMs: 1,
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "cmd-1",
                  environmentId: null,
                },
              },
              {
                id: "input-1",
                method: "item/tool/requestUserInput",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "input-call",
                  isBlocking: true,
                  autoResolutionMs: null,
                  questions: [
                    {
                      id: "q1",
                      header: "Question",
                      question: "Pick one",
                      isOther: false,
                      isSecret: false,
                      options: null,
                    },
                  ],
                },
              },
              {
                id: "mcp-1",
                method: "mcpServer/elicitation/request",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  serverName: "server",
                  mode: "form",
                  message: "Confirm",
                  requestedSchema: { type: "object", properties: {} },
                  _meta: null,
                },
              },
              {
                id: "permission-1",
                method: "item/permissions/requestApproval",
                params: {
                  threadId: "thread-1",
                  turnId: "turn-1",
                  itemId: "permissions",
                  cwd: "/repo",
                  environmentId: null,
                  startedAtMs: 1,
                  reason: "Need access",
                  permissions: { network: { enabled: true }, fileSystem: null },
                },
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
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        true,
      );
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
      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:prepare")).toBe(
        false,
      );
      expect(manager.readConversation("thread-1")?.resumeState).toBe("resumed");
      expect(manager.readConversationStreamRole("thread-1")).toBe("follower");
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-144:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-145:2",
        occurrenceToken: 2,
        hostId: "local",
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
        (record) => record.channel === "peer:threadStreamStateChanged",
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
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("stores and answers an owner elicitation with empty resident history", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      const unreadyConversation: CodexConversationSnapshot = {
        ...buildConversation("thread-owner-request-race", "project-1"),
        turns: [],
      };
      resumeThreadResult = unreadyConversation;
      await manager.requestThreadStreamResume("thread-owner-request-race");

      resumeThreadResult = {
        ...buildConversation("thread-owner-request-race", "project-1"),
        turns: unreadyConversation.turns,
      };
      invokeRecords = [];
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-146:1",
        occurrenceToken: 1,
        hostId: "local",
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
      expect(conversation?.canonicalState).toBeDefined();
      expect(conversation?.canonicalRequests?.map((request) => request.id)).toEqual([
        "mcp-owner-request-race",
      ]);
      expect(conversation?.requests[0]?.type).toBe("mcpServerElicitation");
      expect(conversation?.requests[0]?.requestId).toBe("mcp-owner-request-race");
      await manager.respondMcpElicitation(
        "mcp-owner-request-race",
        { action: "accept", content: {}, _meta: null },
        "thread-owner-request-race",
      );
      await flushAsyncWork(4);
      const replied = manager.readConversation("thread-owner-request-race");
      expect(replied?.canonicalState).toBeDefined();
      expect(replied?.canonicalRequests).toEqual([]);
      expect(replied?.requests).toEqual([]);
      expect(replied?.turns).toEqual(unreadyConversation.turns);

      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:prepare")).toBe(
        false,
      );
      expect(
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");
      const hydratedPlan = manager
        .readConversation("thread-1")
        ?.turns[0]?.items.find((item) => item.itemId === "plan-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-147:1",
        occurrenceToken: 1,
        hostId: "local",
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
              durationMs: 1000,
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
      expect(implementationItem?.createdAt).toBe(hydratedPlan?.createdAt);
      expect(implementationItem?.updatedAt).toBe(hydratedPlan?.updatedAt);
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-148:2",
        occurrenceToken: 2,
        hostId: "local",
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
              durationMs: 1000,
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-149:3",
        occurrenceToken: 3,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-150:4",
        occurrenceToken: 4,
        hostId: "local",
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
              durationMs: 1000,
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-151:5",
        occurrenceToken: 5,
        hostId: "local",
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
        (
          implementationItem?.rawItem as
            | {
                isCompleted?: boolean;
              }
            | undefined
        )?.isCompleted,
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

  test("follower completes its local plan implementation without a remote request", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
      expect(accepted).toBe(true);
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
      expect(
        residentConversationTurns(manager.readConversation("thread-1")?.canonicalState)[0]
          ?.items[0],
      ).toMatchObject({ type: "planImplementation", isCompleted: true });
      expect(manager.readConversation("thread-1")?.requests).toEqual([]);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("plan implementation removal handles an available empty document and a missing document", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      expect(await manager.removePlanImplementationRequest("thread-1", "turn-plan")).toBe(true);
      expect(await manager.removePlanImplementationRequest("missing", "turn-plan")).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("local plan removal preserves other turns and does not invent missing completion fields", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const base = canonicalFixture({
      ...buildConversation("thread-1", "project-1"),
      turns: ["target", "other"].map((turnId) => ({
        threadId: "thread-1",
        turnId,
        status: "completed" as const,
        itemIds: [],
        items: [],
      })),
    });
    const [canonical] = produceWithPatches(base, (draft) => {
      for (const turn of draft.turns) {
        turn.items = [
          {
            type: "planImplementation",
            id: `plan-${turn.turnId}`,
            turnId: turn.turnId!,
            planContent: "Keep this plan",
            isCompleted: false,
          },
        ];
      }
      const target = draft.turns[0]!;
      target.items.push({
        type: "planImplementation",
        id: "missing-field",
        turnId: "target",
        planContent: "Unspecified completion",
        isCompleted: false,
      });
      Reflect.deleteProperty(target.items[1]!, "isCompleted");
      draft.requests = ["target", "other"].map((turnId) => ({
        id: `request-${turnId}`,
        method: "item/plan/requestImplementation",
        params: { threadId: "thread-1", turnId, planContent: "Keep this plan" },
      }));
    });
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-1",
        sourceClientId: "owner-a",
        change: { type: "snapshot", revision: 1, conversationState: canonical },
      });
      await manager.removePlanImplementationRequest("thread-1", "target");
      const state = manager.readConversation("thread-1")!.canonicalState!;
      const turns = residentConversationTurns(state);
      expect(turns[0]?.items[0]).toMatchObject({ id: "plan-target", isCompleted: true });
      expect(Object.hasOwn(turns[0]!.items[1]!, "isCompleted")).toBe(false);
      expect(turns[1]?.items[0]).toMatchObject({ id: "plan-other", isCompleted: false });
      expect(state.requests.map((request) => request.id)).toEqual(["request-other"]);
    } finally {
      manager.destroy();
    }
  });

  test("owner plan implementation removal completes its canonical item and publishes the mutation", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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

      const result = await manager.removePlanImplementationRequest("thread-1", "turn-plan");
      await flushAsyncWork();
      const conversation = manager.readConversation("thread-1");
      const item = conversation?.turns[0]?.items[0];
      const publishIndex = invokeRecords.findIndex(
        (record) => record.channel === "peer:threadStreamStateChanged",
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

      expect(result).toBe(true);
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
      const canonicalPlan = residentConversationTurns(conversation?.canonicalState)[0]?.items.find(
        (candidate) => candidate.type === "planImplementation",
      );
      expect(canonicalPlan?.type === "planImplementation" && canonicalPlan.isCompleted).toBe(true);
      expect(
        invokeRecords.some(
          (record) => record.channel === "codex:thread:plan-implementation:remove",
        ),
      ).toBe(false);
      expect(publishIndex >= 0).toBe(true);
      expect(publishedSnapshot?.type).toBe("patches");
      expect((publishedSnapshot?.patches?.length ?? 0) > 0).toBe(true);
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
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
    followerActionError = null;
    let rejectedStartTurn = false;
    followerActionHandler = async (input) => {
      const request = input as { request?: { method?: string } };
      if (request.request?.method === "thread-follower-start-turn" && !rejectedStartTurn) {
        rejectedStartTurn = true;
        throw new Error("no-client-found: thread stream owner disconnected");
      }
      return followerActionResult;
    };
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
      expect(channels.includes("peer:requestThreadFollower")).toBe(true);
      expect(channels.includes("codex:thread:resume:prepare")).toBe(true);
      expect(
        recordedNativeRequests().some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (
              record.args[0] as {
                request?: {
                  method?: string;
                };
              }
            ).request?.method === "turn/start",
        ),
      ).toBe(true);
      expect(channels.includes("codex:turn:start")).toBe(false);
      expect(manager.getStreamRole("thread-1")?.role).toBe("owner");
    } finally {
      followerActionError = null;
      followerActionHandler = null;
      followerActionResult = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  for (const takeover of [false, true]) {
    test(`a failed follower request only clears its dispatched owner (${takeover})`, async () => {
      const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
        await import("./local-conversation-store");
      const { dispatchCodexAppServerMessage } = await import("./app-server-message-bus");
      resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
      const manager = trackNativeTestManager(new CodexAppServerManager("local"));
      let rejectRequest: (error: Error) => void = () => {};
      followerActionHandler = () =>
        new Promise((_resolve, reject) => {
          rejectRequest = reject;
        });
      const snapshot = (threadId: string, owner: string) => {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: threadId,
          version: 1,
          sourceClientId: owner,
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: {
              ...buildConversation(threadId, "project-1"),
              resumeState: "resumed",
              requests: [
                {
                  type: "approval",
                  kind: "command",
                  requestId: `approval-${threadId}`,
                  projectId: "project-1",
                  threadId,
                  turnId: "turn",
                  itemId: "cmd",
                  createdAt: 1,
                },
              ],
            },
          },
        });
      };
      try {
        await act(async () => {
          snapshot("thread-1", "owner-a");
          snapshot("thread-2", "owner-a");
          const pending = manager.respondApproval(
            "approval-thread-1",
            { kind: "command", decision: "decline" },
            "thread-1",
          );
          await flushAsyncWork();
          if (takeover) snapshot("thread-1", "owner-b");
          rejectRequest(new Error("no-client-found"));
          expect(await pending).toBe(false);
          expect(manager.readConversationStreamRole("thread-1")).toBe("follower");
          expect(manager.readConversation("thread-1")?.resumeState).toBe("resumed");
          expect(manager.readConversationStreamRole("thread-2")).toBe("follower");
          expect(manager.readConversation("thread-2")?.resumeState).toBe("resumed");
          if (takeover) {
            coordinationBroadcast?.("clientStatusChanged", {
              sourceClientId: "owner-a",
              params: { clientId: "owner-a", clientType: "app", status: "disconnected" },
            });
            expect(manager.readConversation("thread-1")?.resumeState).toBe("resumed");
            expect(manager.readConversationStreamRole("thread-1")).toBe("follower");
            expect(manager.readConversation("thread-2")?.resumeState).toBe("needs_resume");
          }
        });
      } finally {
        followerActionHandler = null;
        manager.destroy();
      }
    });
  }

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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      const baseConversation: CodexConversationSnapshot = withCanonicalState({
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
      });
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: "owner-a",
      });
      coordinationBroadcast?.("clientStatusChanged", {
        sourceClientId: "owner-a",
        params: { clientId: "owner-a", clientType: "app", status: "disconnected" },
      });
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 2,
        change: {
          type: "patches",
          baseRevision: 1,
          revision: 2,
          patches: buildCanonicalFixturePatches(baseConversation, staleOwnerConversation),
        },
        sourceClientId: "owner-a",
      });
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(manager.readConversation("thread-1")?.canonicalState?.resumeState).toBe(
        "needs_resume",
      );
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

    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      manager.retainActiveConversation("thread-1");
      await manager.requestThreadStreamResume("thread-1");
      expect(manager.getStreamRole("thread-1")?.role).toBe("owner");

      resumeThreadGeneration += 1;
      const { dispatchCodexAppServerMessage: dispatchNativeLifetime } =
        await import("./app-server-message-bus");
      dispatchNativeLifetime("shared-object-updated", {
        hostId: "local",
        object: {
          objectType: "connection",
          objectId: "connection",
          value: { status: "connected", retries: 0 },
        },
      });
      await flushAsyncWork();
      await flushAsyncWork();

      expect(manager.readConversation("thread-1")?.resumeState).toBe("needs_resume");
      expect(manager.readConversationAttachmentState("thread-1").status).toBe("idle");
      expect(manager.readConversationStreamRole("thread-1")).toBeNull();
    } finally {
      resumeThreadResult = null;
      resumeThreadRevision = 0;
      manager.destroy();
    }
  });

  test("owner user-stop declines supported request families without waiting for their replies", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    let releaseReplies!: (accepted: boolean) => void;
    const replies = new Promise<boolean>((resolve) => {
      releaseReplies = resolve;
    });
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
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: baseConversation,
        },
        sourceClientId: null,
      });
      await resumeAfterFixtureOwnerDisconnect(manager, "thread-1");

      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-152:1",
        occurrenceToken: 1,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-153:2",
        occurrenceToken: 2,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-154:3",
        occurrenceToken: 3,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-155:4",
        occurrenceToken: 4,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-156:5",
        occurrenceToken: 5,
        hostId: "local",
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
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-157:6",
        occurrenceToken: 6,
        hostId: "local",
        request: {
          id: "setup-1",
          method: "item/tool/requestSetupCodexContextPicker",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
          },
        },
      });
      dispatchCodexAppServerMessage("native-request", {
        type: "nativeRequest",
        generation: resumeThreadGeneration,
        occurrenceId: "native-158:7",
        occurrenceToken: 7,
        hostId: "local",
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
        "6",
      );
      invokeRecords = [];

      ownerRequestResponseHandler = () => replies;
      const interrupted = await manager.interruptTurn("thread-1");
      await flushAsyncWork(3);

      const responseOrder = invokeRecords.flatMap((record) => {
        if (record.channel === "codex:app-server:respond") {
          const input = record.args[0] as {
            requestId?: string | number;
            effect?: { requestId?: string | number };
          };
          return [String(input.requestId ?? input.effect?.requestId)];
        }
        if (
          record.channel === "codex:app-server:request" &&
          (record.args[0] as { request: { method: string } }).request.method === "turn/interrupt"
        )
          return ["turn/interrupt"];
        return [];
      });
      expect(interrupted).toBe(true);
      expect(responseOrder.toSorted()).toEqual(
        [
          "command-1",
          "file-1",
          "permission-1",
          "user-1",
          "option-1",
          "mcp-1",
          "turn/interrupt",
        ].toSorted(),
      );
      expect(
        manager.readConversation("thread-1")?.canonicalRequests?.map((request) => request.id),
      ).toEqual([]);
      releaseReplies(true);
      await flushAsyncWork();
    } finally {
      releaseReplies(true);
      ownerRequestResponseHandler = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner peer dispatches typed interrupt requests through native execution", async () => {
    invokeCalls = [];
    invokeRecords = [];
    hostMessageListener = null;
    rendererClientRequestListener = null;
    threadListByProject = {};
    resumeThreadResult = null;
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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

      const result = await manager.handleThreadFollowerRequest({
        method: "thread-follower-interrupt-turn",
        params: { conversationId: "thread-1", expectedTurnId: "turn-1", mode: "user-stop" },
      });

      expect(result).toEqual({
        method: "thread-follower-interrupt-turn",
        result: { ok: true, interruptedTurnId: "turn-1" },
      });
      expect(
        recordedNativeRequests().some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (
              record.args[0] as {
                request?: {
                  method?: string;
                };
              }
            ).request?.method === "turn/interrupt",
        ),
      ).toBe(true);
      expect(invokeRecords.some((record) => record.channel === "codex:turn:interrupt")).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await waitForCondition(
        () => manager.readConversation("thread-1")?.canonicalState?.threadGoal?.status === "active",
        1000,
      );
      invokeRecords = [];

      const result = await manager.interruptTurn("thread-1");

      const ownerRequests = recordedNativeRequests()
        .filter((record) => record.channel === "codex:app-server:request")
        .map(
          (record) =>
            (
              record.args[0] as {
                request?: {
                  method?: string;
                  params?: {
                    threadId?: string;
                    status?: string;
                    turnId?: string;
                  };
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

  test("owner idle status preserves an active goal until an explicit goal command", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-159:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "thread/status/changed",
          params: {
            threadId: "thread-1",
            status: { type: "idle" },
          },
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 350));

      const goalSetRequests = recordedNativeRequests().filter(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "thread/goal/set",
      );
      expect(goalSetRequests).toEqual([]);
      expect(manager.readConversation("thread-1")?.statusType).toBe("idle");
      expect(manager.readConversation("thread-1")?.canonicalState?.threadGoal?.status).toBe(
        "active",
      );
      await manager.setThreadGoal({ threadId: "thread-1", status: "paused" });
      expect(manager.readConversation("thread-1")?.canonicalState?.threadGoal?.status).toBe(
        "paused",
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("owner idle status does not start a subagent scan to reactivate its goal", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-160:1",
        occurrenceToken: 1,
        hostId: "local",
        notification: {
          method: "thread/status/changed",
          params: { threadId: "thread-1", status: { type: "idle" } },
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(
        recordedNativeRequests().some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (
              record.args[0] as {
                request?: {
                  method?: string;
                };
              }
            ).request?.method === "thread/goal/set",
        ),
      ).toBe(false);
      expect(
        invokeRecords.some((record) => record.channel === "codex:subagents:overview:read"),
      ).toBe(false);
    } finally {
      subagentOverviewResult = null;
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("the coordination view resolves the current manager stream role", async () => {
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

    const { ConversationCoordinationViewTarget } =
      await import("../../../shared/codex-coordination-view");
    let manager: {
      requestThreadStreamResume: (threadId: string) => Promise<CodexConversationSnapshot | null>;
      getStreamRole: (threadId: string) => { role: "owner" | "follower" } | null;
      handleThreadFollowerRequest: (request: {
        method: string;
        params: unknown;
      }) => Promise<{ method: string; result: unknown }>;
    } | null = null;
    function Probe() {
      manager = useDefaultCodexAppServerManager();
      return createElement("div");
    }

    render(
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
    await settleAsyncRender();
    if (!manager) throw new Error("Expected manager");

    await act(async () => {
      await manager?.requestThreadStreamResume("thread-1");
    });

    const view = new ConversationCoordinationViewTarget(
      () => {
        if (!manager) throw new Error("Manager unavailable");
        return manager;
      },
      () => {},
    );
    expect(await view.getThreadRole({ hostId: "local", conversationId: "thread-1" })).toBe("owner");
    expect(await view.getThreadRole({ hostId: "local", conversationId: "unloaded-thread" })).toBe(
      "follower",
    );
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
        response: {
          decision: "allow_project";
        },
        conversationId: string,
      ) => Promise<boolean>;
    } | null = null;
    function Probe() {
      manager = useDefaultCodexAppServerManager();
      return createElement("div");
    }

    render(
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
    await settleAsyncRender();
    if (!manager) throw new Error("Expected manager");
    const activeManager = manager as {
      readConversation: (threadId: string) => CodexConversationSnapshot | null;
      respondNodexAgentAuthorization: (
        requestId: string,
        response: {
          decision: "allow_project";
        },
        conversationId: string,
      ) => Promise<boolean>;
    };
    dispatchCodexAppServerMessage("shared-object-updated", {
      hostId: "local",
      object: { objectType: "threadSummary", objectId: "thread-1", value: mainOwnedConversation },
    });
    dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
      hostId: "local",
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
          tool: "edit_document",
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
      1000,
    );

    expect(
      invokeRecords.filter((record) => record.channel === "codex:renderer-client:response"),
    ).toEqual([]);
    expect(
      activeManager
        .readConversation("thread-1")
        ?.requests.some((request) => request.requestId === "nodex-auth-1"),
    ).toBe(true);
    dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
      hostId: "local",
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
      1000,
    );

    dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
      hostId: "local",
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
      1000,
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

  test("follower persisted search hydrates its local canonical island with native reads", async () => {
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    const { createEmptyCodexHistoryTopology } =
      await import("../../../shared/codex-conversation-state/codex-history-topology");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    invokeRecords = [];
    const canonical = {
      ...canonicalFixture(buildConversation("thread-search", "project-1")),
      turnHistory: {
        kind: "canonical" as const,
        history:
          createEmptyCodexHistoryTopology<import("../../../shared/types").CodexCanonicalTurnState>(
            11,
          ),
      },
    };
    nativeTurnsListResult = {
      data: [
        buildProtocolTurn({
          id: "turn-older",
          status: "completed",
          startedAt: 1,
          items: [
            {
              id: "item-selected",
              type: "agentMessage",
              text: "needle",
              phase: null,
              memoryCitation: null,
              questions: null,
              delivery: null,
            },
          ],
        }),
      ],
      nextCursor: null,
      backwardsCursor: null,
    };
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-search",
        sourceClientId: "owner-a",
        change: { type: "snapshot", revision: 1, conversationState: canonical },
      });
      const input = {
        threadId: "thread-search",
        hostId: "local",
        hostGeneration: resumeThreadGeneration,
        topologyGeneration: 11,
        occurrence: {
          turnId: "turn-older",
          itemId: "item-selected",
          snippet: "needle",
          snippetMatchRange: { start: 0, end: 6 },
          turnCursor: "cursor-turn-older",
        },
      };
      await expect(manager.hydratePersistedHistoryOccurrence(input)).resolves.toMatchObject({
        status: "found",
        turnId: "turn-older",
        itemId: "item-selected",
        topologyGeneration: 11,
      });
      const reads = invokeRecords
        .filter((record) => record.channel === "codex:app-server:request")
        .map(
          (record) => (record.args[0] as { request: { method: string; params: unknown } }).request,
        );
      expect(reads).toHaveLength(2);
      expect(reads).toMatchObject(
        ["desc", "asc"].map((sortDirection) => ({
          method: "thread/turns/list",
          params: {
            threadId: "thread-search",
            cursor: "cursor-turn-older",
            limit: 5,
            sortDirection,
            itemsView: "full",
          },
        })),
      );
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "peer:requestThreadFollower" ||
            record.channel === "codex:thread:resume:prepare",
        ),
      ).toBe(false);
      expect(manager.readConversationStreamRole("thread-search")).toBe("follower");
      expect(manager.readConversation("thread-search")?.turns[0]?.items[0]?.markdownText).toBe(
        "needle",
      );
      expect(
        manager.readConversation("thread-search")?.canonicalState?.turnHistory?.history.islands,
      ).toHaveLength(1);
    } finally {
      nativeTurnsListResult = null;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
        (record) => record.channel === "peer:requestThreadFollower",
      );
      expect(followerRecords).toHaveLength(1);
      expect(followerRecords[0]?.args[0]).toMatchObject({
        targetClientId: "owner-a",
        request: {
          method: "thread-follower-edit-last-user-turn",
          params: {
            conversationId: "thread-1",
            turnId: "turn-older",
            message: "Rewrite older prompt",
          },
        },
      });
      await editPromise;
      expect(
        invokeRecords.some((record) => record.channel === "codex:thread:edit-last-user-turn"),
      ).toBe(false);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower edit completes with the owner response while replacement replication is independent", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
        hostId: "local",
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
      expect(resolved).toBe(true);

      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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

  test("follower forks through native preparation with the stable turn identity", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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

      const result = await forkPromise;
      expect(
        invokeRecords.find((record) => record.channel === "codex:thread:native-fork:prepare")?.args,
      ).toEqual(["thread-1", "turn-older"]);
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
      expect(result.threadId).toBe("thread-forked");
      expect(manager.readConversation("thread-forked")?.canonicalState).toBeDefined();
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        (record) => record.channel === "codex:thread:resume:prepare",
      );
      const forkIndex = invokeRecords.findIndex(
        (record) => record.channel === "codex:thread:native-fork:execute",
      );
      expect(resumeIndex).toBeGreaterThanOrEqual(0);
      expect(forkIndex).toBeGreaterThan(resumeIndex);
      expect(
        invokeRecords.find((record) => record.channel === "codex:thread:native-fork:prepare")?.args,
      ).toEqual(["thread-1", "turn-older"]);
      expect(result.threadId).toBe("thread-forked");
      expect(Boolean(result.composerIntent)).toBe(true);
      expect(result.composerIntent?.prompt).toBe("Continue from older turn");
      expect(invokeRecords.some((record) => record.channel === "codex:thread:fork-from-turn")).toBe(
        false,
      );
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower goal objective requires its owning manager", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      await flushAsyncWork();
      const before = manager.readConversation("thread-1")?.canonicalState;
      invokeRecords = [];
      await expect(
        manager.setThreadGoal({ threadId: "thread-1", objective: "ship parity" }),
      ).rejects.toThrow("while following another owner");
      expect(manager.readConversation("thread-1")?.canonicalState).toBe(before);
      expect(invokeRecords).toEqual([]);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("thread goal status updates use native protocol params without requiring a loaded owner", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.setThreadGoal({
        threadId: "thread-standalone",
        status: "paused",
      });
      const goalRecord = recordedNativeRequests().find(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "thread/goal/set",
      );
      const params = (
        goalRecord?.args[0] as
          | {
              request?: {
                params?: {
                  threadId?: string;
                  objective?: unknown;
                  status?: unknown;
                };
              };
            }
          | undefined
      )?.request?.params;

      expect(params?.threadId).toBe("thread-standalone");
      expect(params?.status).toBe("paused");
      expect(Object.prototype.hasOwnProperty.call(params ?? {}, "objective")).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:prepare")).toBe(
        false,
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      invokeRecords = [];

      const goal = await manager.setThreadGoal({
        threadId: "thread-1",
        status: "paused",
      });
      const ownerRecord = recordedNativeRequests().find(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "thread/goal/set",
      );
      const ownerInput = ownerRecord?.args[0] as
        | {
            request?: {
              params?: {
                threadId?: string;
                objective?: unknown;
                status?: unknown;
              };
            };
          }
        | undefined;
      const params = ownerInput?.request?.params;

      expect(goal?.status ?? "").toBe("paused");
      expect(manager.readConversation("thread-1")?.threadGoal?.status ?? "").toBe("paused");
      expect(manager.readConversation("thread-1")?.canonicalState?.threadGoal?.status ?? "").toBe(
        "paused",
      );
      expect(params?.threadId).toBe("thread-1");
      expect(params?.status).toBe("paused");
      expect(Object.prototype.hasOwnProperty.call(params ?? {}, "objective")).toBe(false);
      expect(invokeRecords.some((record) => record.channel === "codex:thread:goal:set")).toBe(
        false,
      );
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      expect(
        (
          turn as
            | {
                turnId?: string | null;
              }
            | undefined
        )?.turnId ?? null,
      ).toBe(null);
      expect(turn?.status ?? "").toBe("completed");
      expect(turn?.turnStartedAtMs ?? 0).toBe(1000);
      expect(item?.kind ?? "").toBe("userMessage");
      expect(item?.itemId ?? "").toBe("turn-index-0:input");
      expect(item?.markdownText ?? "").toBe("ship parity");
      expect(item?.goal ?? false).toBe(true);
      expect(item?.rawItem ?? null).toBe(null);
      expect(
        String(residentConversationTurns(conversation?.canonicalState)[0]?.items.length ?? -1),
      ).toBe("0");
      const rawInput = residentConversationTurns(conversation?.canonicalState)[0]?.params.input[0];
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      const ownerRequests = recordedNativeRequests()
        .filter((record) => record.channel === "codex:app-server:request")
        .map(
          (record) =>
            record.args[0] as {
              request?: {
                method?: string;
                params?: {
                  threadId?: string;
                  model?: string;
                  reasoningEffort?: string;
                  collaborationMode?: import("@nodex/codex-app-server-protocol").CollaborationMode;
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
      expect(settingsRequest?.params?.model).toBe("gpt-5.9-codex");
      expect(settingsRequest?.params?.collaborationMode?.settings.reasoning_effort).toBe("high");
      expect(settingsRequest?.params?.collaborationMode?.mode).toBe("plan");
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
        manager.readConversation("thread-1")?.canonicalState?.latestThreadSettings?.model ?? "",
      ).toBe("gpt-5.9-codex");
      expect(
        manager.readConversation("thread-1")?.canonicalState?.threadGoal?.objective ?? "",
      ).toBe("ship parity");
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("follower thread goal status updates use the native status-only request", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
      expect(goal?.status).toBe("paused");
      const request = recordedNativeRequests().find(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (record.args[0] as { request: { method: string } }).request.method === "thread/goal/set",
      );
      expect((request?.args[0] as { request: unknown }).request).toMatchObject({
        method: "thread/goal/set",
        params: { threadId: "thread-1", status: "paused" },
      });
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower goal objective rejects settings changes before native execution", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread-1", "project-1"),
        },
        sourceClientId: "owner-a",
      });

      await flushAsyncWork();
      const before = manager.readConversation("thread-1")?.canonicalState;
      invokeRecords = [];
      await expect(
        manager.setThreadGoal({
          threadId: "thread-1",
          objective: "ship parity",
          appendTranscriptItem: false,
          threadSettings: {
            model: "gpt-5.9-codex",
            reasoningEffort: "high",
            collaborationMode: "plan",
          },
        }),
      ).rejects.toThrow("while following another owner");
      expect(manager.readConversation("thread-1")?.canonicalState).toBe(before);
      expect(invokeRecords).toEqual([]);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1", {
        showThreadGoalResumeConfirmation: true,
      });
      invokeRecords = [];
      expect(manager.getStreamRole("thread-1")?.role).toBe("owner");

      await manager.dismissThreadGoalResumeConfirmation("thread-1");

      expect(manager.readConversation("thread-1")?.threadGoal?.status ?? "").toBe("paused");
      expect(manager.readConversation("thread-1")?.threadGoalResumeConfirmation ?? null).toBe(null);
      expect(manager.readConversation("thread-1")?.canonicalState?.threadGoal?.status ?? "").toBe(
        "paused",
      );
      expect(
        manager.readConversation("thread-1")?.canonicalState?.threadGoalResumeConfirmation ?? null,
      ).toBe(null);
      expect(
        invokeRecords.some((record) => record.channel === "peer:threadStreamStateChanged"),
      ).toBe(true);
      expect(
        recordedNativeRequests().some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (
              record.args[0] as {
                request?: {
                  method?: string;
                };
              }
            ).request?.method === "thread/goal/clear",
        ),
      ).toBe(false);
      expect(
        recordedNativeRequests().some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (
              record.args[0] as {
                request?: {
                  method?: string;
                };
              }
            ).request?.method === "thread/goal/set",
        ),
      ).toBe(false);
    } finally {
      resumeThreadResult = null;
      manager.destroy();
    }
  });

  test("goal resume confirmation dismiss clears the local prompt while preserving the goal", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
      expect(manager.readConversation("thread-1")?.canonicalState?.threadGoal).toEqual(goal);
      expect(
        manager.readConversation("thread-1")?.canonicalState?.threadGoalResumeConfirmation,
      ).toBeNull();
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "peer:requestThreadFollower" ||
            record.channel === "codex:app-server:request",
        ),
      ).toBe(false);
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower goal clear uses the native thread request", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
      const native = recordedNativeRequests().find(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (record.args[0] as { request: { method: string } }).request.method ===
            "thread/goal/clear",
      );
      expect((native?.args[0] as { request: unknown }).request).toMatchObject({
        method: "thread/goal/clear",
        params: { threadId: "thread-1" },
      });
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
    } finally {
      followerActionResult = null;
      manager.destroy();
    }
  });

  test("follower memory mode update uses the native thread request", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
      const native = recordedNativeRequests().find(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (record.args[0] as { request: { method: string } }).request.method ===
            "thread/memoryMode/set",
      );
      expect((native?.args[0] as { request: unknown }).request).toMatchObject({
        method: "thread/memoryMode/set",
        params: { threadId: "thread-1" },
      });
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
    } finally {
      manager.destroy();
    }
  });

  test("owner background-terminal cleanup updates local canonical state after its native request", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      await manager.requestThreadStreamResume("thread-1");
      await flushAsyncWork();
      invokeRecords = [];
      const publishCountBefore = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      ).length;
      await manager.cleanBackgroundTerminals("thread-1");

      const conversation = manager.readConversation("thread-1");
      const publishCountAfter = invokeRecords.filter(
        (record) => record.channel === "peer:threadStreamStateChanged",
      ).length;
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (record.args[0] as { request: { method: string } }).request.method ===
              "thread/backgroundTerminals/clean",
        ),
      ).toBe(true);
      expect(invokeRecords.some((record) => record.channel === "peer:requestThreadFollower")).toBe(
        false,
      );
      expect(publishCountAfter).toBe(publishCountBefore);
      expect(conversation?.backgroundTerminalRows.length ?? -1).toBe(0);
      expect(conversation?.turns[0]?.interruptedCommandExecutionItemIds?.[0]).toBe("cmd-1");
      expect(
        residentConversationTurns(conversation?.canonicalState)[0]
          ?.interruptedCommandExecutionItemIds?.[0],
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        (record) => record.channel === "codex:thread:resume:prepare",
      );
      const rollbackIndex = recordedNativeRequests().findIndex(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "thread/rollback",
      );
      const startIndex = recordedNativeRequests().findIndex(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "turn/start",
      );
      expect(resumeIndex >= 0).toBe(true);
      expect(rollbackIndex > resumeIndex).toBe(true);
      expect(startIndex > rollbackIndex).toBe(true);
      const rollbackItems = manager.readConversation("thread-1")?.turns[0]?.items ?? [];
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
      expect(result.streamRevision).toBeGreaterThan(0);
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

  test("edit on a Main-owned document routes the stable target to that manager", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread-1",
        version: 1,
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: currentConversation,
        },
        sourceClientId: "main",
      });
      invokeRecords = [];

      const result = await manager.editLastUserTurn(
        "thread-1",
        "turn-latest",
        "Rewrite latest prompt",
      );

      expect(
        invokeRecords.find((record) => record.channel === "peer:requestThreadFollower")?.args[0],
      ).toMatchObject({
        targetClientId: "main",
        request: {
          method: "thread-follower-edit-last-user-turn",
          params: {
            conversationId: "thread-1",
            turnId: "turn-latest",
            message: "Rewrite latest prompt",
          },
        },
      });
      expect(invokeRecords.some((record) => record.channel === "codex:thread:resume:prepare")).toBe(
        false,
      );
      expect(manager.getStreamRole("thread-1")?.role).toBe("follower");
      expect(result.threadId).toBe("thread-1");
    } finally {
      resumeThreadResult = null;
      ownerEditRollbackResult = null;
      manager.destroy();
    }
  });

  test("owner edit replicates rollback, optimistic replacement, and native turn identity in order", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      await flushAsyncWork();
      const beforeEdit = manager.readConversation("thread-1");
      if (!beforeEdit) throw new Error("Expected owner conversation before edit");
      invokeRecords = [];

      ownerTurnStartHandler = () => {
        const turns = residentConversationTurns(
          manager.readConversation("thread-1")?.canonicalState,
        );
        expect(turns).toHaveLength(2);
        expect(turns[0]?.turnId).toBe("turn-older");
        expect(turns[1]?.turnId).toBeNull();
      };
      const result = await manager.editLastUserTurn(
        "thread-1",
        "turn-latest",
        "Rewrite latest prompt",
      );

      const rollbackIndex = recordedNativeRequests().findIndex(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "thread/rollback",
      );
      const publishIndex = invokeRecords.findIndex(
        (record) => record.channel === "peer:threadStreamStateChanged",
      );
      const startIndex = recordedNativeRequests().findIndex(
        (record) =>
          record.channel === "codex:app-server:request" &&
          (
            record.args[0] as {
              request?: {
                method?: string;
              };
            }
          ).request?.method === "turn/start",
      );
      let replicated = beforeEdit.canonicalState!;
      const stages = invokeRecords.flatMap((record, index) => {
        if (record.channel !== "peer:threadStreamStateChanged") return [];
        const { change } = record.args[0] as {
          change:
            | { type: "snapshot"; conversationState: typeof replicated }
            | { type: "patches"; patches: import("immer").Patch[] };
        };
        replicated =
          change.type === "snapshot"
            ? change.conversationState
            : applyPatches(replicated, change.patches);
        return [{ index, turns: residentConversationTurns(replicated) }];
      });
      expect(rollbackIndex).toBeGreaterThanOrEqual(0);
      expect(publishIndex).toBeGreaterThan(rollbackIndex);
      const rollbackStage = stages.find((stage) => stage.turns.length === 1);
      const optimisticStage = stages.find(
        (stage) => stage.turns.length === 2 && stage.turns.at(-1)?.turnId == null,
      );
      const reboundStage = stages.find(
        (stage) => stage.turns.at(-1)?.turnId === "turn-owner-start",
      );
      expect(rollbackStage?.turns.map((turn) => turn.turnId)).toEqual(["turn-older"]);
      expect(optimisticStage?.index).toBeGreaterThan(rollbackStage!.index);
      expect(startIndex).toBeGreaterThan(rollbackIndex);
      expect(reboundStage?.index).toBeGreaterThan(optimisticStage!.index);
      expect(replicated).toEqual(manager.readConversation("thread-1")?.canonicalState);
      expect(result.streamRevision).toBeGreaterThan(0);
      expect(manager.readConversation("thread-1")?.turns.at(-1)?.items[0]?.markdownText).toBe(
        "Rewrite latest prompt",
      );
    } finally {
      ownerTurnStartHandler = null;
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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

  test("owner edit revalidates after settings preparation when a native turn starts", async () => {
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-161:1",
        occurrenceToken: 1,
        hostId: "local",
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
        "Cannot edit a message while a turn is in progress.",
      );
      expect(
        invokeRecords.some(
          (record) =>
            record.channel === "codex:app-server:request" &&
            (
              record.args[0] as {
                request?: {
                  method?: string;
                };
              }
            )?.request?.method === "thread/rollback",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
      await flushAsyncWork();
      invokeRecords = [];

      const removalResult = await manager.removePlanImplementationRequest("thread-1", "turn-plan");
      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-162:7",
        occurrenceToken: 7,
        hostId: "local",
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
        .filter((record) => record.channel === "peer:threadStreamStateChanged")
        .map(
          (record) =>
            record.args[0] as {
              ownerNotificationSequence?: number;
              change?: {
                type?: string;
                baseRevision?: number;
                revision?: number;
              };
            },
        );
      const removalPublish = publishInputs[0];
      const prosePublish = publishInputs[1];
      const conversation = manager.readConversation("thread-1");
      const planItem = conversation?.turns[0]?.items[0];
      const assistantItem = conversation?.turns[1]?.items[0];

      expect(removalResult).toBe(true);
      expect(removalPublish?.change?.type).toBe("patches");
      expect(removalPublish?.change?.revision).toBe(
        Number(removalPublish?.change?.baseRevision) + 1,
      );
      expect(prosePublish?.change?.type).toBe("patches");
      expect(prosePublish?.change?.baseRevision).toEqual(expect.any(Number));
      expect(prosePublish?.change?.revision).toBe(Number(prosePublish?.change?.baseRevision) + 1);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      resumeThreadResult = withCanonicalState({
        ...buildConversation("thread-1", "project-1"),
        statusType: "active",
        turns: [
          {
            threadId: "thread-1",
            turnId: "turn-new",
            status: "inProgress",
            itemIds: [],
            items: [],
          },
        ],
      });
      await manager.requestThreadStreamResume("thread-1");
      await manager.steerTurn({
        threadId: "thread-1",
        expectedTurnId: "turn-new",
        prompt: "Changed prompt",
      });
      const steeringId = residentConversationTurns(
        manager.readConversation("thread-1")?.canonicalState,
      )[0]?.items.find((item) => item.type === "steeringUserMessage")?.id;
      expect(steeringId).toBeDefined();
      invokeRecords = [];

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-163:1",
        occurrenceToken: 1,
        hostId: "local",
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
      expect(turn?.items).toHaveLength(2);
      expect(turn?.items[0]).toMatchObject({
        itemId: steeringId,
        markdownText: "Changed prompt",
        steeringStatus: "accepted",
      });
      expect(turn?.items[1]).toMatchObject({
        itemId: "user-real",
        semanticKind: "steered",
        acceptedUserMessageItemId: "user-real",
      });
      expect(turn?.itemIds).toEqual([steeringId, "user-real"]);
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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

      dispatchCodexAppServerMessage("native-notification", {
        type: "nativeNotification",
        generation: resumeThreadGeneration,
        occurrenceId: "native-164:1",
        occurrenceToken: 1,
        hostId: "local",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
        hostId: "local",
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
        hostId: "local",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      for (const threadId of ["thread-1", "thread-2"]) {
        dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
          hostId: "local",
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
        hostId: "local",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
        hostId: "local",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
        hostId: "local",
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
        hostId: "local",
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
        hostId: "local",
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
        hostId: "local",
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
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
    await settleAsyncRender();
    expect(textContent(container)).toBe("custom:none:empty");

    await act(async () => {
      hostMessageListener?.({
        type: "sharedObjectUpdated",
        hostId: "local",
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
        hostId: "local",
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
        hostId: "local",
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
        createElement(NativeFixtureRegistration),
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
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
    await settleAsyncRender();
    rerender(
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
    await settleAsyncRender();

    expect(textContent(container)).toBe("0");
    expect(invokeCalls.filter((call) => call === "codex:threads:list")).toEqual([]);
  });

  test("applies a relayed completed snapshot and an optional-field removal on a follower", async () => {
    const {
      __resetLocalConversationStoreForTests,
      LocalConversationProvider,
      readLocalConversation,
    } = await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    render(
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement("div"),
      ),
    );
    await settleAsyncRender();

    const before = projectCodexConversationDocument({
      ...buildConversation("thread-1", "project-1"),
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-boot",
          status: "completed",
          errorMessage: "A prior failure",
          diff: undefined,
          itemIds: ["answer-boot"],
          items: [
            {
              threadId: "thread-1",
              turnId: "turn-boot",
              itemId: "answer-boot",
              type: "agentMessage",
              kind: "assistantMessage",
              markdownText: "BOOT_OK",
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        },
      ],
    });
    const next = projectCodexConversationDocument({
      ...before,
      turns: [{ ...before.turns[0]!, errorMessage: undefined }],
    });
    const deliver = async (change: TestStreamFixtureEvent["change"]) => {
      await act(async () => {
        dispatchTestThreadStreamStateChanged(undefined, {
          hostId: "local",
          conversationId: "thread-1",
          version: change.revision,
          sourceClientId: "renderer-owner",
          change,
        });
        await Promise.resolve();
      });
      await settleAsyncRender();
    };

    await deliver({ type: "snapshot", revision: 1, conversationState: before });
    expect(readLocalConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("BOOT_OK");
    await deliver({
      type: "patches",
      baseRevision: 1,
      revision: 2,
      patches: buildCanonicalFixturePatches(before, next),
    });
    expect(readLocalConversation("thread-1")?.turns[0]?.errorMessage).toBeUndefined();
    expect(readLocalConversation("thread-1")?.turns[0]?.items[0]?.markdownText).toBe("BOOT_OK");
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

    render(
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement("div"),
      ),
    );
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
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "thread-1",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: snapshot,
        },
        version: 1,
        sourceClientId: "test-owner",
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
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
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
      dispatchTestThreadStreamStateChanged(undefined, {
        hostId: "local",
        conversationId: "side-thread-1",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: snapshot,
        },
        version: 1,
        sourceClientId: "test-owner",
      });
    });
    await settleAsyncRender();

    const conversation = readLocalConversation("side-thread-1");
    expect(conversation?.source?.sideConversation === true).toBe(true);
    expect(conversation?.ephemeral === true).toBe(true);
    expect(textContent(container)).toBe("0");
  });

  test("attaches a newly forked side chat through the canonical renderer owner lifecycle", async () => {
    invokeCalls = [];
    invokeRecords = [];
    const { CodexAppServerManager, __resetLocalConversationStoreForTests } =
      await import("./local-conversation-store");
    resetLocalConversationStoreTestHarness(__resetLocalConversationStoreForTests);
    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
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
            record.channel === "codex:thread:resume:prepare" &&
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
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
    await settleAsyncRender();
    rerender(
      createElement(
        LocalConversationProvider,
        null,
        createElement(NativeFixtureRegistration),
        createElement(Probe),
      ),
    );
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

    const manager = trackNativeTestManager(new CodexAppServerManager("local"));
    try {
      manager.hydrateThreadSummaries("project-1", [buildThreadSummary("thread-1", "project-1")]);
      dispatchTestThreadStreamStateChanged(dispatchCodexAppServerMessage, {
        hostId: "local",
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
        hostId: "local",
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
        hostId: "local",
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
      for (const listener of codexEventListeners)
        listener({ type: "threadDeleted", threadId: "thread-durable-delete" });
      expect(manager.readThreadSummary("thread-durable-delete")).toBe(null);
      expect(manager.readConversation("thread-durable-delete")).toBe(null);
    } finally {
      manager.destroy();
    }
  });
});
