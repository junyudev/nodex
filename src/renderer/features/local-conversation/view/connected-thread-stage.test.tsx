import { toast } from "@/components/ui/toast";
import type { ThreadReadStateChange } from "../../../../shared/codex-thread-read-state";
import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2";
import { buildAgentActivityV2CorpusThread } from "../../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { createCommandKeymapState } from "../../../../shared/command-keybindings";
import { useState, type ReactNode } from "react";
import { beforeEach, describe, expect, vi, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { NodexTooltipProvider as TooltipProvider } from "../../../components/ui/tooltip";
import { installAsyncRequestAnimationFrame, installWindowApi } from "../../../test/browser-globals";
import { render, settleAsyncRender, textContent } from "../../../test/dom";
import { createTestQueryClient, TestQueryProvider } from "../../../test/query";
import { queryKeys } from "../../../lib/query-keys";
import { RendererStateProvider } from "../../../app-providers";
import {
  WorkbenchSessionScopePath,
  SelectedAppShellHeaderContent,
  useSelectedConversationSkillsReloadControl,
} from "../../../lib/workbench-ui-scopes";
import { NodexModalHost } from "../../../lib/modal-registry";
import type {
  CodexConnectionState,
  CodexConversationItem,
  CodexConversationSnapshot,
  CodexHostMessage,
  CodexThreadSummary,
} from "../../../lib/types";
import { withCanonicalState } from "../../../test/canonical-conversation-fixture";
import type { ConversationCoordinationHost } from "../../../../shared/codex-client-coordination";
import {
  __resetLocalConversationStoreForTests,
  LocalConversationProvider,
  type CodexAppServerManager,
} from "../local-conversation-store";
import type { ThreadStageActions, ConversationProviderPresentation } from "../thread-stage-types";
import { ConversationRuntimeContext, type ConversationRuntime } from "../conversation-runtime";
import { NativeConversationHistoryOwner } from "../native-conversation-history-owner";
import { createNativeConversationHistoryRuntime } from "../native-conversation-history-adapter";
import type { FloatingComposerPlacement } from "@/features/floating-composer/floating-composer";
import { sessionFirstSubmissionOwner } from "../../conversation-launch/session-first-submission-owner";
// Load the fixed stage graph during collection, before any test owns an async act scope.
import { ConnectedThreadStage } from "./connected-thread-stage";

let invokeCalls: Array<{
  channel: string;
  args: unknown[];
  threadId?: string;
  active?: boolean;
  presented?: boolean;
}> = [];
let readStateWrites: ThreadReadStateChange[] = [];
let overviewChild = false;
beforeEach(() => {
  const previousApi = window.api;
  installWindowApi({
    ...previousApi,
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "codex:thread-handoffs:list") return { revision: 0, operations: [] };
      if (channel === "thread-execution:location") {
        return { hostId: "local", cwd: "/tmp/project", managedWorktreePath: null };
      }
      return await previousApi?.invoke(channel, ...args);
    },
  });
  vi.mocked(toast.danger).mockClear();
  readStateWrites = [];
  overviewChild = false;
  coordination.resumeError = null;
  coordination.generation = 1;
  coordination.hostAvailable = true;
  coordination.ownerAvailable = true;
});

vi.mock("../renderer-thread-read-state", () => ({
  connectRendererThreadReadState: () => ({
    async set(change: ThreadReadStateChange) {
      readStateWrites.push(change);
      return { status: "ok" as const };
    },
    [Symbol.dispose]() {},
  }),
}));

let hostMessageListener: ((message: CodexHostMessage) => void) | null = null;

const coordination = vi.hoisted(() => ({
  getManager: null as ((hostId: string) => CodexAppServerManager) | null,
  resumeError: null as Error | null,
  generation: 1,
  hostAvailable: true,
  ownerAvailable: true,
}));

vi.mock("../conversation-coordination-connection", () => ({
  connectConversationCoordination: (getManager: (hostId: string) => CodexAppServerManager) => {
    coordination.getManager = getManager;
    const host: ConversationCoordinationHost = {
      findThreadOwner: async (input) => {
        invokeCalls.push({
          channel: "peer:findThreadOwner",
          args: [input],
          threadId: input.conversationId,
        });
        return coordination.ownerAvailable ? "test-owner" : null;
      },
      setThreadOwnership: async () => {},
      threadArchived: async () => {},
      threadUnarchived: async () => {},
      threadQueuedFollowUpsChanged: async () => {},
      threadStreamStateChanged: async () => {},
      threadStreamFollowingChanged: async (input) => {
        invokeCalls.push({
          channel: "peer:threadStreamFollowingChanged",
          args: [input],
          threadId: input.params.conversationId,
          active: input.params.following,
        });
      },
      threadStreamFollowingStatusRequested: async () => {},
      requestThreadFollower: async () => {
        throw new Error("Unexpected follower mutation");
      },
    };
    return {
      ready: Promise.resolve(host),
      readStateReady: Promise.resolve(undefined),
      [Symbol.dispose]: () => {},
    };
  },
}));

function createConnectedThreadStageQueryClient() {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.settings.commandKeymap(), createCommandKeymapState({}, "macOS"));
  client.setQueryData(queryKeys.codexComposerPlugins.list(["/tmp/project"]), []);
  client.setQueryData(queryKeys.codexComposerSkills.list(["/tmp/project"]), []);
  client.setQueryData(queryKeys.codexComposerSites.list(), {
    available: false,
    sites: [],
  });
  client.setQueryData(queryKeys.codexComposerChatGptConversations.list(""), {
    available: false,
    conversations: [],
  });
  client.setQueryData(queryKeys.mcp.apps(), []);
  client.setQueryData(queryKeys.mcp.statuses(), {
    data: [],
    nextCursor: null,
  });
  return client;
}

function ConnectedThreadStageQueryProvider({
  children,
  client: providedClient,
}: {
  readonly children: ReactNode;
  readonly client?: ReturnType<typeof createTestQueryClient>;
}) {
  const [client] = useState(() => providedClient ?? createConnectedThreadStageQueryClient());
  return <TestQueryProvider client={client}>{children}</TestQueryProvider>;
}

function ThreadStageScope({ children }: { children: ReactNode }) {
  return (
    <RendererStateProvider>
      <WorkbenchSessionScopePath
        thread={{
          stableKey: "session:connected-thread-stage-test",
          phase: "attached",
          projectSessionId: "connected-thread-stage-test",
          clientThreadId: null,
          threadId: "thread_1",
        }}
        route={{ routeKey: "/thread", kind: "thread" }}
        selected
      >
        {children}
      </WorkbenchSessionScopePath>
    </RendererStateProvider>
  );
}

vi.mock("../local-conversation-deps", () => ({
  runConversationOperation: async (channel: string, ...args: unknown[]) => {
    const firstArg = args[0];
    invokeCalls.push({
      channel,
      args,
      threadId:
        typeof firstArg === "string"
          ? firstArg
          : typeof firstArg === "object" &&
              firstArg !== null &&
              typeof (firstArg as { threadId?: unknown }).threadId === "string"
            ? (firstArg as { threadId: string }).threadId
            : undefined,
      active:
        typeof firstArg === "object" &&
        firstArg !== null &&
        typeof (firstArg as { active?: unknown }).active === "boolean"
          ? (firstArg as { active: boolean }).active
          : undefined,
      presented:
        typeof firstArg === "object" &&
        firstArg !== null &&
        typeof (firstArg as { presented?: unknown }).presented === "boolean"
          ? (firstArg as { presented: boolean }).presented
          : undefined,
    });
    if (channel === "codex:account:read") {
      return {
        account: null,
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

    if (channel === "codex:app-server:host-context") {
      if (!coordination.hostAvailable) throw new Error("Native host is not ready");
      return {
        hostId: "local",
        generation: coordination.generation,
        sourceEpoch: "stage-fixture",
        supportsPaginatedHistory: true,
        supportsTurnApprovalsReviewer: false,
        supportsSearchOccurrences: false,
        appServerVersion: null,
        supportsThreadRevert: false,
        accountContext: { identity: { kind: "loggedOut" }, executionHostKey: "local" },
      };
    }

    if (channel === "codex:subagents:overview:read") {
      const rows = overviewChild
        ? [
            {
              threadId: "thread_child",
              parentThreadId: "thread_middle",
              displayName: "Worker 1",
              actorName: "Worker 1",
              agentRole: null,
              spawnModel: null,
              objective: null,
              status: "active",
              statusSummary: null,
              startedAtMs: null,
              lastActivityAtMs: null,
              completedAtMs: null,
              diffStats: null,
              canOpen: true,
              canInteract: false,
            },
          ]
        : [];
      return {
        rootThreadId: (firstArg as { rootThreadId: string }).rootThreadId,
        revision: 1,
        generation: 1,
        completeness: "complete",
        active: { rows, knownCount: rows.length, totalCount: rows.length, continuation: null },
        done: { rows: [], knownCount: 0, totalCount: 0, continuation: null },
      };
    }
    if (channel === "codex:thread:history-hydration:prepare") {
      const response = buildResumeResponse(firstArg as string);
      return {
        summary: { ...buildThreadSummary(false), threadId: firstArg },
        context: {
          hostId: "local",
          model: response.model,
          reasoningEffort: response.reasoningEffort,
          cwd: response.cwd,
          approvalPolicy: response.approvalPolicy,
          approvalsReviewer: response.approvalsReviewer,
          sandboxPolicy: response.sandbox,
          activePermissionProfile: response.activePermissionProfile,
          runtimeWorkspaceRoots: response.runtimeWorkspaceRoots,
        },
      };
    }
    if (channel === "codex:thread:resume:prepare") {
      if (coordination.resumeError) throw coordination.resumeError;
      return {
        receiptId: `resume:${firstArg}`,
        nativeRequestId: `native-resume:${firstArg}`,
        hostId: "local",
        generation: coordination.generation,
        supportsPaginatedHistory: true,
        requestedCwd: null,
        params: { threadId: firstArg },
        summary: { ...buildThreadSummary(false), threadId: firstArg },
      };
    }

    if (channel === "codex:app-server:request") {
      const { method, params } = (
        args[0] as { request: { method: string; params: { threadId?: string; turnId?: string } } }
      ).request;
      if (method === "model/list")
        return { type: "result", result: { data: [], nextCursor: null } };
      if (method === "thread/turns/list")
        return {
          type: "result",
          result: {
            data: [
              {
                ...buildAgentActivityV2CorpusThread().turns[0],
                id: `${params.threadId}:history`,
                items: [
                  {
                    type: "agentMessage",
                    id: "history-message",
                    text: `History for ${params.threadId}`,
                    phase: "final_answer",
                    memoryCitation: null,
                    delivery: null,
                    questions: null,
                  },
                ],
              },
            ],
            nextCursor: null,
            backwardsCursor: null,
          },
        };
      if (method === "thread/read")
        return { type: "result", result: { thread: buildResumeResponse(params.threadId!).thread } };
      if (method === "thread/items/list")
        return {
          type: "result",
          result: {
            data: [
              {
                turnId: params.turnId,
                startedAtMs: 1,
                completedAtMs: 2,
                item: {
                  type: "agentMessage",
                  id: "history-message",
                  text: `History for ${params.threadId}`,
                  phase: "final_answer",
                  memoryCitation: null,
                  delivery: null,
                  questions: null,
                },
              },
            ],
            nextCursor: null,
            backwardsCursor: null,
          },
        };
      if (method === "thread/resume")
        return { type: "result", result: buildResumeResponse(params.threadId!) };
      if (method === "thread/goal/get") return { type: "result", result: { goal: null } };
      if (method === "thread/unsubscribe") return { type: "result", result: {} };
      return { type: "result", result: await window.api?.invoke(channel, ...args) };
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
  subscribeCodexEvents: () => () => undefined,
  getWindowFocusState: async () => document.hasFocus(),
  subscribeWindowFocusChanges: () => () => {},
}));

function buildResumeResponse(threadId: string): ThreadResumeResponse {
  const thread = {
    ...buildAgentActivityV2CorpusThread(),
    id: threadId,
    cwd: "/tmp/project",
    status: { type: "idle" as const },
    turns: [],
  };
  return {
    thread,
    model: "model-one",
    modelProvider: "openai",
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
    disabledPluginIds: [],
    collaborationMode: null,
    initialTurnsPage: { data: [], nextCursor: null, backwardsCursor: null },
    turnsBackwardsCursor: null,
    itemsBackwardsCursor: null,
  };
}

function buildThreadSummary(archived: boolean): CodexThreadSummary {
  return {
    threadId: archived ? "thread_archived" : "thread_active",
    projectId: "project_1",
    source: null,
    threadName: archived ? "Archived" : "Active",
    threadPreview: "",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "idle",
    statusActiveFlags: [],
    archived,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-03-21T00:00:00.000Z",
  };
}

function buildConversation(
  threadId: string,
  overrides: Partial<CodexConversationSnapshot> = {},
): CodexConversationSnapshot {
  const userItem: CodexConversationItem = {
    threadId,
    turnId: "turn_ready",
    itemId: "user_ready",
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    markdownText: "Remove the redundant transitions.",
    createdAt: 1,
    updatedAt: 1,
  };

  return {
    threadId,
    projectId: "project_1",
    source: overrides.source ?? null,
    threadName: "Ready thread",
    threadPreview: "Remove redundant transitions.",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "active",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-03-21T00:00:00.000Z",
    resumeState: "resumed",
    turns: [
      {
        threadId,
        turnId: "turn_ready",
        status: "inProgress",
        itemIds: [userItem.itemId],
        items: [userItem],
      },
    ],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
    backgroundTerminalRows: [],
    capabilityFlags: {
      canEditUserTurns: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
    ...overrides,
  };
}

function dispatchTestThreadStreamSnapshot(
  _dispatch: unknown,
  event: {
    hostId: string;
    conversationId: string;
    sourceClientId?: string | null;
    version?: number;
    change: { type: "snapshot"; revision: number; conversationState: CodexConversationSnapshot };
  },
): void {
  const manager = coordination.getManager?.(event.hostId);
  if (!manager) throw new Error("Conversation coordination has not connected");
  void manager.setThreadStreamFollowing(event.conversationId, true);
  const conversationState = withCanonicalState(event.change.conversationState).canonicalState;
  if (!conversationState) throw new Error("Canonical conversation fixture missing");
  manager.receiveCoordination("threadStreamStateChanged", {
    sourceClientId: event.sourceClientId ?? "test-owner",
    params: {
      hostId: event.hostId,
      conversationId: event.conversationId,
      change: { ...event.change, conversationState },
    },
  });
}

function buildActions(): ThreadStageActions {
  const noopAsync = async () => undefined;
  return {
    onCollaborationModeChange: () => {},
    onModelChange: () => {},
    onReasoningEffortChange: () => {},

    onQueueingEnabledChange: () => {},
    onSendPrompt: noopAsync,
    onSteerPrompt: noopAsync,
    onInterruptTurn: noopAsync,
    onRespondUserInput: noopAsync,
    onRespondMcpElicitation: noopAsync,
    onResolvePlanImplementationRequest: noopAsync,
    onEnqueueQueuedFollowUp: noopAsync,
    onSendCapturedFollowUp: noopAsync,
    onRemoveQueuedFollowUp: noopAsync,
    onReorderQueuedFollowUps: noopAsync,
    onSendQueuedFollowUpNow: noopAsync,
    onEditQueuedFollowUp: noopAsync,
    onEditUserTurn: noopAsync,
    onForkFromTurn: noopAsync,
    onUnarchiveThread: noopAsync,
    onOpenTurnDiffReview: () => {},
    onOpenThread: () => {},
    onStopBackgroundTerminals: noopAsync,
    onNewThreadProjectChange: () => {},
  };
}

async function renderStage(
  summary: CodexThreadSummary,
  options: {
    backgroundAgentDetail?: boolean;
    executionAvailable?: boolean;
    decisionRecord?: boolean;
    routeActive?: boolean;
    rightPanelComposerOverlayEnabled?: boolean;
    rightPanelComposerOverlayTarget?: HTMLElement;
    rightPanelComposerOverlayPlacement?: FloatingComposerPlacement;
    threadBodyVisible?: boolean;
    runtime?: ConversationRuntime;
    sessionId?: string;
    provider?: ConversationProviderPresentation;
    projectId?: string | null;
    summaryPanelOpen?: boolean;
    onOpenThread?: ThreadStageActions["onOpenThread"];
    onOpenSubagentsPanel?: ThreadStageActions["onOpenSubagentsPanel"];
    onForkThread?: ThreadStageActions["onForkThread"];
    queryClient?: ReturnType<typeof createTestQueryClient>;
    skillsControlProbe?: boolean;
  } = {},
) {
  __resetLocalConversationStoreForTests();

  const view = render(
    <ConnectedThreadStageQueryProvider client={options.queryClient}>
      <ThreadStageScope>
        <TooltipProvider>
          <LocalConversationProvider>
            <ConversationRuntimeContext.Provider value={options.runtime ?? null}>
              <ConnectedThreadStage
                sessionId={options.sessionId}
                projectId={options.projectId === undefined ? "project_1" : options.projectId}
                projectWorkspacePath="/tmp/project"
                isNewThreadTab={false}
                newThreadTarget={null}
                newThreadProjectSelector={null}
                newThreadStartInSelector={null}
                threadStartProgress={null}
                activeThreadId={summary.threadId}
                activeThreadSummary={summary}
                availableModels={[]}
                collaborationModes={[]}
                selectedCollaborationMode="default"
                selectedModel=""
                selectedReasoningEffort="medium"
                reasoningEffortOptions={[]}

                isQueueingEnabled={false}
                composerEnterBehavior="enter"
                searchOpenTick={0}
                backgroundAgentDetail={options.backgroundAgentDetail === true}
                executionAvailable={options.executionAvailable}
                decisionRecord={options.decisionRecord}
                routeActive={options.routeActive}
                rightPanelComposerOverlayEnabled={options.rightPanelComposerOverlayEnabled}
                rightPanelComposerOverlayTarget={options.rightPanelComposerOverlayTarget}
                rightPanelComposerOverlayPlacement={options.rightPanelComposerOverlayPlacement}
                threadBodyVisible={options.threadBodyVisible}
                provider={options.provider}
                summaryPanelMounted={options.summaryPanelOpen}
                summaryPanelOpen={options.summaryPanelOpen}
                actions={{
                  ...buildActions(),
                  ...(options.onOpenThread ? { onOpenThread: options.onOpenThread } : {}),
                  ...(options.onForkThread ? { onForkThread: options.onForkThread } : {}),
                  ...(options.onOpenSubagentsPanel
                    ? { onOpenSubagentsPanel: options.onOpenSubagentsPanel }
                    : {}),
                }}
              />
            </ConversationRuntimeContext.Provider>
          </LocalConversationProvider>
          {options.skillsControlProbe ? <SkillsReloadProbe /> : null}
          {options.onOpenSubagentsPanel || options.onForkThread ? (
            <SelectedAppShellHeaderContent />
          ) : null}
          {options.summaryPanelOpen ? <NodexModalHost /> : null}
        </TooltipProvider>
      </ThreadStageScope>
    </ConnectedThreadStageQueryProvider>,
  );
  await settleAsyncRender();
  return view;
}

function SkillsReloadProbe() {
  const control = useSelectedConversationSkillsReloadControl();
  return (
    <button
      type="button"
      disabled={!control}
      onClick={() => {
        void control?.reload();
      }}
      aria-label="Reload active skills"
    />
  );
}

test("imported native history pages remain readable without a Composer or execution owner", async () => {
  const summary = buildThreadSummary(false);
  const page = (sequence: number) => ({
    backend: "claude" as const,
    threadId: summary.threadId,
    sessionId: "imported-native-session",
    status: "closed" as const,
    error: null,
    revision: 1,
    history: { hasOlder: sequence === 2, oldestSequence: sequence, cursor: "older-native-page" },
    turns: [
      {
        sequence,
        clientUserMessageId: null,
        nativeUserMessageId: `native-user:${sequence}`,
        promptText: `Imported question ${sequence}`,
        stopReason: "end_turn",
        updates: [
          {
            kind: "message" as const,
            key: `answer:${sequence}`,
            messageId: `answer:${sequence}`,
            role: "agent" as const,
            text: `Imported answer ${sequence}`,
          },
        ],
      },
    ],
  });
  const read = vi.fn().mockResolvedValueOnce(page(2)).mockResolvedValueOnce(page(1));
  const owner = new NativeConversationHistoryOwner(summary, read);
  const runtime = createNativeConversationHistoryRuntime({
    summary,
    sessionId: "product-native-import",
    backend: "claude",
    owner,
    retain: owner.retain,
  });
  const view = await renderStage(summary, {
    runtime,
    executionAvailable: false,
    provider: {
      kind: "claudeAgent",
      label: "Claude",
      selection: "claudeAgent",
      commands: [],
    },
  });
  await view.findByText("Imported answer 2");
  expect(view.container.querySelector('[contenteditable="true"]')).toBeNull();
  expect(runtime.role(summary.threadId)).toBe("follower");
  await view.findByText("Imported answer 1");
  expect(read).toHaveBeenNthCalledWith(2, {
    threadId: summary.threadId,
    before: "older-native-page",
    limit: 50,
  });
  expect(invokeCalls.some((call) => call.channel === "peer:findThreadOwner")).toBe(false);
  view.unmount();
  expect(owner.getSnapshot().view).toBeNull();
});

describe("ConnectedThreadStage archived resume behavior", () => {
  test.each(["child", "archived", "unavailable", "decision"] as const)(
    "loads readonly Runtime Codex history through its Session owner (%s)",
    async (surface) => {
      invokeCalls = [];
      const summary = {
        ...buildThreadSummary(surface === "archived"),
        source: surface === "child" ? { parentThreadId: "engine-parent" } : null,
      };
      const conversation = withCanonicalState(
        buildConversation(summary.threadId, { statusType: "idle", source: summary.source }),
      );
      const loadHistory = vi.fn(async () => {});
      const attachment = { status: "attached" } as const;
      const connection = { status: "connected", retries: 0 } as const;
      const children: ReturnType<ConversationRuntime["children"]> = [];
      const runtime: ConversationRuntime = {
        kind: "codex",
        hostId: "local",
        sessionId: "runtime-session",
        read: (id) => (id === summary.threadId ? conversation : null),
        subscribe: () => () => {},
        children: () => children,
        attachment: () => attachment,
        connection: () => connection,
        role: () => "follower",
        primaryRequest: () => null,
        retain: () => () => {},
        loadHistory,
        resume: vi.fn(async () => {}),
        markRead: async () => {},
        setPresented: async () => {},
      };
      const view = await renderStage(summary, {
        runtime,
        backgroundAgentDetail: surface === "child",
        executionAvailable: surface !== "unavailable",
        decisionRecord: surface === "decision",
      });
      await waitFor(() => expect(loadHistory).toHaveBeenCalledWith(summary.threadId));
      if (surface !== "archived") await view.findByText("Remove the redundant transitions.");
      expect(runtime.resume).not.toHaveBeenCalled();
      // A decision run reads as Nodex's record and never offers a composer.
      expect(view.queryByText(/kept as a record and takes no messages/u) !== null).toBe(
        surface === "decision",
      );
      if (surface === "decision")
        expect(view.container.querySelector('[contenteditable="true"]')).toBeNull();
      expect(
        invokeCalls.filter((call) =>
          ["codex:thread:history-hydration:prepare", "codex:thread:resume:prepare"].includes(
            call.channel,
          ),
        ),
      ).toEqual([]);
      await act(async () => view.unmount());
    },
  );
  test.each(["conversationEntityGeneration", "historyTopologyGeneration"] as const)(
    "rebinds history when %s changes without waiting for the previous reader",
    async (generationField) => {
      const boundary = {
        generation: 1,
        islandId: "runtime",
        edge: "older" as const,
        boundaryId: "runtime:older",
        progressKey: "older-page",
        handle: { cursor: "older-page", oldestLoadedTurnId: null },
      };
      const gap = {
        kind: "gap" as const,
        key: "runtime:gap",
        estimatedHeightPx: 144 as const,
        olderBoundary: null,
        newerBoundary: boundary,
      };
      let conversation: CodexConversationSnapshot = {
        ...buildConversation("thread_active", { statusType: "idle" }),
        conversationEntityGeneration: 1,
        historyTopologyGeneration: 1,
        historyRows: [gap],
      };
      const pendingPage = () => {
        let resolve = (_status: "applied" | "stale") => {};
        let reject = (_cause: Error) => {};
        const promise = new Promise<"applied" | "stale">((accept, fail) => {
          resolve = accept;
          reject = fail;
        });
        return { promise, resolve, reject };
      };
      const oldPage = pendingPage();
      const currentPage = pendingPage();
      const loadOld = vi.fn(() => oldPage.promise);
      const loadCurrent = vi.fn(() => currentPage.promise);
      const bindHistory = vi.fn((id: string) => {
        if (id !== "thread_active") return null;
        const loadBoundary = conversation[generationField] === 1 ? loadOld : loadCurrent;
        return { loadBoundary };
      });
      const listeners = new Set<() => void>();
      const emptyChildren: ReturnType<ConversationRuntime["children"]> = [];
      const attachment = { status: "attached" } as const;
      const connection = { status: "connected", retries: 0 } as const;
      const runtime: ConversationRuntime = {
        kind: "codex",
        hostId: "local",
        history: bindHistory,
        read: (id) => (id === "thread_active" ? conversation : null),
        subscribe: (_id, listener) => {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        attachment: () => attachment,
        connection: () => connection,
        role: () => "follower",
        primaryRequest: () => null,
        children: () => emptyChildren,
        retain: () => () => {},
        loadHistory: async () => {},
        resume: async () => {},
        markRead: async () => {},
        setPresented: async () => {},
      };
      const view = await renderStage(buildThreadSummary(false), { runtime });
      try {
        await waitFor(() => expect(loadOld).toHaveBeenCalledExactlyOnceWith(boundary));
        const currentBoundary =
          generationField === "historyTopologyGeneration"
            ? { ...boundary, generation: 2 }
            : boundary;
        await act(async () => {
          conversation = {
            ...conversation,
            [generationField]: 2,
            historyRows: [{ ...gap, newerBoundary: currentBoundary }],
          };
          for (const listener of listeners) listener();
          await Promise.resolve();
        });
        await waitFor(() => expect(loadCurrent).toHaveBeenCalledExactlyOnceWith(currentBoundary));
        await act(async () => {
          oldPage.reject(new Error("The retired reader failed"));
          await Promise.resolve();
        });
        await settleAsyncRender();
        expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
        expect(view.getByText("Loading history")).not.toBeNull();
        await act(async () => {
          conversation = { ...conversation, historyRows: [] };
          for (const listener of listeners) listener();
          currentPage.resolve("applied");
          await Promise.resolve();
        });
        await waitFor(() => expect(view.queryByText("Loading history")).toBeNull());
        expect(loadOld).toHaveBeenCalledOnce();
        expect(loadCurrent).toHaveBeenCalledOnce();
      } finally {
        await act(async () => {
          oldPage.resolve("stale");
          currentPage.resolve("stale");
          view.unmount();
          await Promise.resolve();
        });
      }
    },
  );
  test("follows the conversation while its view is retained and releases it on unmount", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;

    const view = await renderStage(buildThreadSummary(false));
    await act(async () => {
      await settleAsyncRender();
    });

    expect(
      invokeCalls.some(
        (call) =>
          call.channel === "peer:threadStreamFollowingChanged" &&
          call.threadId === "thread_active" &&
          call.active === true,
      ),
    ).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          call.channel === "codex:thread:presentation:set" &&
          call.threadId === "thread_active" &&
          call.presented === true,
      ),
    ).toBe(true);

    await act(async () => {
      view.unmount();
      await settleAsyncRender();
    });

    expect(
      invokeCalls.some(
        (call) =>
          call.channel === "peer:threadStreamFollowingChanged" &&
          call.threadId === "thread_active" &&
          call.active === false,
      ),
    ).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          call.channel === "codex:thread:presentation:set" &&
          call.threadId === "thread_active" &&
          call.presented === false,
      ),
    ).toBe(true);
  });

  test("registers a descendant outside immediate memberships behind a visible background request card", async () => {
    overviewChild = true;
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;
    const view = await renderStage(buildThreadSummary(false));
    const { dispatchCodexAppServerMessage } = await import("../app-server-message-bus");

    await act(async () => {
      dispatchTestThreadStreamSnapshot(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread_active",
        version: 1,
        sourceClientId: "test-owner",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread_active"),
        },
      });
      dispatchCodexAppServerMessage("shared-object-updated", {
        hostId: "local",
        object: {
          objectType: "conversationChildMemberships",
          objectId: "thread_active",
          value: {
            parentThreadId: "thread_active",
            childMemberships: [
              {
                threadId: "thread_child",
                parentThreadId: "thread_middle",
                pendingRequest: {
                  request: {
                    type: "approval",
                    requestId: "background-approval",
                    kind: "command",
                    projectId: "project_1",
                    threadId: "thread_child",
                    turnId: "turn_ready",
                    itemId: "command-background",
                    createdAt: 3,
                  },
                  requestItem: null,
                },
                role: "backgroundChild",
                actorName: "Worker 1",
              },
            ],
          },
        },
      });
      await settleAsyncRender();
    });

    await waitFor(() => {
      if (
        !invokeCalls.some(
          (call) =>
            call.channel === "codex:thread:presentation:set" &&
            call.threadId === "thread_child" &&
            call.presented === true,
        )
      ) {
        throw new Error("Expected background request conversation presentation.");
      }
    });

    expect(coordination.getManager?.("local").readConversation("thread_child")).toBeNull();
    expect(
      invokeCalls.filter(
        (call) =>
          call.threadId === "thread_child" &&
          ["codex:thread:history-hydration:prepare", "codex:thread:resume:prepare"].includes(
            call.channel,
          ),
      ),
    ).toEqual([]);
    await act(async () => {
      dispatchCodexAppServerMessage("shared-object-updated", {
        hostId: "local",
        object: {
          objectType: "conversationChildMemberships",
          objectId: "thread_active",
          value: {
            parentThreadId: "thread_active",
            childMemberships: [
              {
                threadId: "thread_child",
                parentThreadId: "thread_middle",
                role: "backgroundChild",
                actorName: "Worker 1",
                pendingRequest: null,
              },
            ],
          },
        },
      });
      await settleAsyncRender();
    });
    await waitFor(() =>
      expect(
        invokeCalls.some(
          (call) =>
            call.channel === "codex:thread:presentation:set" &&
            call.threadId === "thread_child" &&
            call.presented === false,
        ),
      ).toBe(true),
    );

    await act(async () => {
      view.unmount();
      await settleAsyncRender();
    });
    expect(
      invokeCalls.some(
        (call) =>
          call.channel === "codex:thread:presentation:set" &&
          call.threadId === "thread_child" &&
          call.presented === false,
      ),
    ).toBe(true);
  });

  test.each(["websocket", "stdio"] as const)(
    "the retained foreground view resumes after %s reconnect without attempting offline hydration",
    async (transportKind) => {
      installAsyncRequestAnimationFrame();
      invokeCalls = [];
      const view = await renderStage(buildThreadSummary(false));
      const manager = coordination.getManager!("local");
      const { dispatchCodexAppServerMessage } = await import("../app-server-message-bus");
      const resumes = () =>
        invokeCalls.filter(
          (call) =>
            call.channel === "codex:app-server:request" &&
            (call.args[0] as { request: { method: string } }).request.method === "thread/resume",
        );
      const connection = (status: "connected" | "disconnected", generation: number) =>
        dispatchCodexAppServerMessage("shared-object-updated", {
          hostId: "local",
          object: {
            objectType: "connection",
            objectId: "connection",
            value: {
              status,
              retries: 1,
              native: { generation, sourceEpoch: "stage-fixture", transportKind },
            },
          },
        });
      await waitFor(() =>
        expect(manager.readConversation("thread_active")?.resumeState).toBe("resumed"),
      );
      const initialResumes = resumes().length;
      await act(async () => {
        connection("connected", 1);
      });
      await act(async () => {
        coordination.hostAvailable = false;
        connection("disconnected", 1);
      });
      expect(manager.getStreamRole("thread_active")?.role ?? null).toBe(
        transportKind === "websocket" ? "owner" : null,
      );
      coordination.generation = 2;
      await act(async () => {
        coordination.hostAvailable = true;
        connection("connected", 2);
      });
      // The foreground recovery fallback waits ten seconds. The mounted view must resume first.
      await waitFor(() => {
        expect(resumes()).toHaveLength(initialResumes + 1);
        expect(manager.readConversation("thread_active")?.resumeState).toBe("resumed");
      });
      expect(resumes().at(-1)?.args[0]).toMatchObject({ scheduling: { priority: "critical" } });
      expect(manager.getStreamRole("thread_active")?.role).toBe("owner");
      await act(async () => {
        view.unmount();
      });
    },
  );

  test("settles a failed resume visibly without retrying in a render loop", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;
    coordination.resumeError = new Error("Thread could not be restored");

    const view = await renderStage(buildThreadSummary(false));
    await act(async () => {
      await settleAsyncRender();
      await settleAsyncRender();
    });

    const resumeCount = () =>
      invokeCalls.filter(
        (call) =>
          call.channel === "codex:thread:resume:prepare" && call.threadId === "thread_active",
      ).length;
    expect(resumeCount()).toBe(1);
    expect(textContent(await view.findByRole("alert"))).toContain("Thread could not be restored");

    await act(async () => {
      await settleAsyncRender();
      await settleAsyncRender();
    });
    expect(resumeCount()).toBe(1);

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Retry" }));
      await settleAsyncRender();
    });
    expect(resumeCount()).toBe(2);
  });
});

describe("ConnectedThreadStage read-state control plane", () => {
  test("does not immediately clear an explicit mark-unread state without new thread activity", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    readStateWrites = [];
    hostMessageListener = null;
    const hasFocusDescriptor = Object.getOwnPropertyDescriptor(document, "hasFocus");
    const hasFocus = vi.fn(() => true);
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: hasFocus,
    });
    const view = await renderStage(buildThreadSummary(false));
    const { dispatchCodexAppServerMessage } = await import("../app-server-message-bus");

    try {
      await act(async () => {
        dispatchTestThreadStreamSnapshot(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread_active",
          version: 1,
          sourceClientId: "test-owner",
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: buildConversation("thread_active", {
              hasUnreadTurn: false,
            }),
          },
        });
        await settleAsyncRender();
      });
      await waitFor(() => {
        expect(hasFocus).toHaveBeenCalled();
        expect(
          coordination.getManager?.("local").readConversation("thread_active")?.turns.at(-1)
            ?.turnId,
        ).toBe("turn_ready");
      });
      await settleAsyncRender();
      invokeCalls = [];
      readStateWrites = [];

      await act(async () => {
        dispatchCodexAppServerMessage("thread-read-state-changed", {
          hostId: "local",
          conversationId: "thread_active",
          hasUnreadTurn: true,
        });
        await settleAsyncRender();
      });

      expect(readStateWrites.length > 0).toBe(false);
    } finally {
      view.unmount();
      if (hasFocusDescriptor) {
        Object.defineProperty(document, "hasFocus", hasFocusDescriptor);
      } else {
        Reflect.deleteProperty(document, "hasFocus");
      }
    }
  });
});

describe("ConnectedThreadStage new-chat home", () => {
  test("replaces the provisional first submission with its canonical row before releasing it", async () => {
    installAsyncRequestAnimationFrame();
    sessionFirstSubmissionOwner.dispose();
    const submission = sessionFirstSubmissionOwner.begin({
      backend: "codex",
      originProjectId: "project_1",
      originSessionId: "session_1",
      prompt: "Keep one row through canonical handoff.",
    });
    sessionFirstSubmissionOwner.update(submission.launchId, {
      threadId: "thread_active",
      phase: "startingTurn",
    });

    const view = await renderStage(buildThreadSummary(false));
    const { dispatchCodexAppServerMessage } = await import("../app-server-message-bus");
    // Hold presentation frames explicitly: elapsed wall time cannot prove this handoff boundary.
    const frames = new Map<number, FrameRequestCallback>();
    let frameId = 0;
    const requestFrame = vi
      .spyOn(globalThis, "requestAnimationFrame")
      .mockImplementation((callback) => {
        frames.set(++frameId, callback);
        return frameId;
      });
    const cancelFrame = vi
      .spyOn(globalThis, "cancelAnimationFrame")
      .mockImplementation((handle) => {
        frames.delete(handle);
      });
    const advancePresentationFrame = async () => {
      await act(async () => {
        for (const [handle, callback] of [...frames]) {
          if (!frames.delete(handle)) continue;
          callback(performance.now());
        }
        await Promise.resolve();
      });
    };
    try {
      expect(view.container.querySelectorAll('[data-user-message-bubble="true"]')).toHaveLength(1);

      const canonical = buildConversation("thread_active");
      const canonicalUserItem = canonical.turns[0]?.items[0];
      if (!canonicalUserItem) throw new Error("Expected canonical user item fixture.");
      await act(async () => {
        dispatchTestThreadStreamSnapshot(dispatchCodexAppServerMessage, {
          hostId: "local",
          conversationId: "thread_active",
          version: 1,
          sourceClientId: "test-owner",
          change: {
            type: "snapshot",
            revision: 1,
            conversationState: {
              ...canonical,
              turns: [
                {
                  ...canonical.turns[0]!,
                  items: [
                    {
                      ...canonicalUserItem,
                      markdownText: "Canonical first submission is visible.",
                      rawItem: {
                        id: canonicalUserItem.itemId,
                        type: "userMessage",
                        clientId: submission.clientUserMessageId,
                        content: [
                          {
                            type: "text",
                            text: "Canonical first submission is visible.",
                            text_elements: [],
                          },
                        ],
                      },
                    },
                  ],
                },
              ],
            },
          },
        });
        await settleAsyncRender();
      });

      expect(view.container.querySelectorAll('[data-user-message-bubble="true"]')).toHaveLength(1);
      await waitFor(() =>
        expect(
          view.container.querySelector('[data-user-message-bubble="true"]')?.textContent,
        ).toContain("Canonical first submission is visible."),
      );
      expect(sessionFirstSubmissionOwner.getSnapshot().submissions).toHaveLength(1);
      await advancePresentationFrame();
      expect(sessionFirstSubmissionOwner.getSnapshot().submissions).toHaveLength(1);
      await advancePresentationFrame();
      expect(sessionFirstSubmissionOwner.getSnapshot().submissions).toHaveLength(0);
      expect(view.container.querySelectorAll('[data-user-message-bubble="true"]')).toHaveLength(1);
      expect(
        view.container.querySelector('[data-user-message-bubble="true"]')?.textContent,
      ).toContain("Canonical first submission is visible.");
    } finally {
      view.unmount();
      sessionFirstSubmissionOwner.dispose();
      requestFrame.mockRestore();
      cancelFrame.mockRestore();
    }
  });
});

vi.mock("@/components/ui/toast", () => ({
  toast: { danger: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
