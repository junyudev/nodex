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
import { WorkbenchSessionScopePath } from "../../../lib/workbench-ui-scopes";
import type {
  CodexConnectionState,
  CodexConversationItem,
  CodexConversationSnapshot,
  CodexHostMessage,
  CodexThreadSummary,
} from "../../../lib/types";
import { withCanonicalState } from "../../../test/canonical-conversation-fixture";
import type { ConversationCoordinationHost } from "../../../../shared/codex-client-coordination";
import type { CodexAppServerManager } from "../local-conversation-store";
import type { ThreadStageActions, ThreadStageRouteInput } from "../thread-stage-types";
import type { RightPanelComposerOverlayVisibility } from "./right-panel-composer-overlay";
import { sessionFirstSubmissionOwner } from "../../conversation-launch/session-first-submission-owner";

let invokeCalls: Array<{
  channel: string;
  args: unknown[];
  threadId?: string;
  active?: boolean;
  presented?: boolean;
}> = [];
let readStateWrites: ThreadReadStateChange[] = [];
beforeEach(() => {
  readStateWrites = [];
  coordination.resumeError = null;
  coordination.generation = 1;
  coordination.hostAvailable = true;
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
        return "test-owner";
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

function ConnectedThreadStageQueryProvider({ children }: { readonly children: ReactNode }) {
  const [client] = useState(createConnectedThreadStageQueryClient);
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
        supportsThreadRevert: false,
        accountContext: { identity: { kind: "loggedOut" }, executionHostKey: "local" },
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
        args[0] as { request: { method: string; params: { threadId?: string } } }
      ).request;
      if (method === "model/list")
        return { type: "result", result: { data: [], nextCursor: null } };
      if (method === "thread/read")
        return { type: "result", result: { thread: buildResumeResponse(params.threadId!).thread } };
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
  subscribeCodexRendererClientRequests: () => () => {},
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
      canEditLastUserTurn: true,
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
    onPermissionModeChange: () => {},
    onQueueingEnabledChange: () => {},
    onSendPrompt: noopAsync,
    onSteerPrompt: noopAsync,
    onInterruptTurn: noopAsync,
    onRespondApproval: noopAsync,
    onRespondUserInput: noopAsync,
    onRespondMcpElicitation: noopAsync,
    onResolvePlanImplementationRequest: noopAsync,
    onEnqueueQueuedFollowUp: noopAsync,
    onRemoveQueuedFollowUp: noopAsync,
    onReorderQueuedFollowUps: noopAsync,
    onSendQueuedFollowUpNow: noopAsync,
    onEditQueuedFollowUp: noopAsync,
    onEditLastUserTurn: noopAsync,
    onForkFromTurn: noopAsync,
    onUnarchiveThread: noopAsync,
    onOpenTurnDiffReview: () => {},
    onConsumeComposerIntent: () => {},
    onOpenThread: () => {},
    onCleanBackgroundTerminals: noopAsync,
    onNewThreadProjectChange: () => {},
  };
}

async function renderStage(
  summary: CodexThreadSummary,
  options: {
    backgroundAgentDetail?: boolean;
    routeActive?: boolean;
    rightPanelComposerOverlayEnabled?: boolean;
    rightPanelComposerOverlayVisibility?: RightPanelComposerOverlayVisibility;
    threadBodyVisible?: boolean;
  } = {},
) {
  const { __resetLocalConversationStoreForTests, LocalConversationProvider } =
    await import("../local-conversation-store");
  const { ConnectedThreadStage } = await import("./connected-thread-stage");
  __resetLocalConversationStoreForTests();

  const view = render(
    <ConnectedThreadStageQueryProvider>
      <ThreadStageScope>
        <TooltipProvider>
          <LocalConversationProvider>
            <ConnectedThreadStage
              projectId="project_1"
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
              permissionMode="auto"
              isQueueingEnabled={false}
              composerEnterBehavior="enter"
              searchOpenTick={0}
              backgroundAgentDetail={options.backgroundAgentDetail === true}
              routeActive={options.routeActive}
              rightPanelComposerOverlayEnabled={options.rightPanelComposerOverlayEnabled}
              rightPanelComposerOverlayVisibility={options.rightPanelComposerOverlayVisibility}
              threadBodyVisible={options.threadBodyVisible}
              actions={buildActions()}
            />
          </LocalConversationProvider>
        </TooltipProvider>
      </ThreadStageScope>
    </ConnectedThreadStageQueryProvider>,
  );
  await settleAsyncRender();
  return view;
}

async function renderPrimaryAndAuxiliaryThread(auxiliaryMode: "background-detail" | "side-chat") {
  const { __resetLocalConversationStoreForTests, LocalConversationProvider } =
    await import("../local-conversation-store");
  const { ConnectedThreadStage } = await import("./connected-thread-stage");
  __resetLocalConversationStoreForTests();

  const rootSummary = {
    ...buildThreadSummary(false),
    threadId: "thread_root",
  };
  const childSummary = {
    ...buildThreadSummary(false),
    threadId: "thread_child",
    source: { parentThreadId: "thread_root" },
  };
  const sharedProps = {
    projectId: "project_1",
    projectWorkspacePath: "/tmp/project",
    isNewThreadTab: false,
    newThreadTarget: null,
    newThreadProjectSelector: null,
    newThreadStartInSelector: null,
    threadStartProgress: null,
    availableModels: [],
    collaborationModes: [],
    selectedCollaborationMode: "default" as const,
    selectedModel: "",
    selectedReasoningEffort: "medium" as const,
    reasoningEffortOptions: [],
    permissionMode: "auto" as const,
    isQueueingEnabled: false,
    composerEnterBehavior: "enter" as const,
    searchOpenTick: 0,
    actions: buildActions(),
  };

  const { dispatchCodexAppServerMessage } = await import("../app-server-message-bus");
  const view = render(
    <ConnectedThreadStageQueryProvider>
      <ThreadStageScope>
        <TooltipProvider>
          <LocalConversationProvider>
            <ConnectedThreadStage
              {...sharedProps}
              sessionId="session_root"
              activeThreadId={rootSummary.threadId}
              activeThreadSummary={rootSummary}
            />
            <ConnectedThreadStage
              {...sharedProps}
              activeThreadId={childSummary.threadId}
              activeThreadSummary={childSummary}
              {...(auxiliaryMode === "background-detail"
                ? { backgroundAgentDetail: true }
                : {
                    composerScopeIdentity: "side-chat:thread_child",
                    sideChatContext: {
                      parentThreadId: rootSummary.threadId,
                      tabTitle: "Side chat",
                    },
                  })}
            />
          </LocalConversationProvider>
        </TooltipProvider>
      </ThreadStageScope>
    </ConnectedThreadStageQueryProvider>,
  );
  await act(async () => {
    // Let initial authority subscriptions settle before delivering their snapshots.
    await settleAsyncRender();
    for (const threadId of [rootSummary.threadId, childSummary.threadId]) {
      dispatchTestThreadStreamSnapshot(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: threadId,
        version: 1,
        sourceClientId: "test-owner",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation(threadId),
        },
      });
    }
    await settleAsyncRender();
  });
  return view;
}

async function renderNewThreadHome(overrides?: {
  threadStartProgress?: ThreadStageRouteInput["threadStartProgress"];
}) {
  const { __resetLocalConversationStoreForTests, LocalConversationProvider } =
    await import("../local-conversation-store");
  const { ConnectedThreadStage } = await import("./connected-thread-stage");
  __resetLocalConversationStoreForTests();
  installWindowApi({
    invoke: async (channel: string, ...args: unknown[]) => {
      if (channel === "codex-command-keymap-state") return createCommandKeymapState({}, "macOS");
      if (channel === "branch-metadata") {
        return {
          currentBranch: "dev-redesign",
          defaultBranch: "main",
          branches: ["dev-redesign", "main"],
        };
      }
      if (channel === "codex:permission:state:get") {
        return {
          mode: "full-access",
          effectivePreset: "full-access",
          availableModes: ["auto", "full-access", "custom"],
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxMode: "danger-full-access",
          sandbox: { type: "dangerFullAccess" },
          autoReviewAvailable: false,
          configTarget: null,
        };
      }
      if (
        channel === "codex:app-server:request" &&
        (args[0] as { request?: { method?: string } }).request?.method === "plugin/installed"
      ) {
        return {
          marketplaces: [
            {
              plugins: [
                {
                  id: "browser@openai-bundled",
                  name: "browser",
                  installed: true,
                  enabled: true,
                  interface: {
                    displayName: "Browser",
                    shortDescription: "Control the in-app browser with ChatGPT",
                    brandColor: "#4b8df8",
                  },
                },
              ],
            },
          ],
        };
      }
      if (channel === "codex:composer-plugins:list") {
        return [
          {
            id: "browser@openai-bundled",
            name: "Browser",
            displayName: "Browser",
            description: "Control the in-app browser with ChatGPT",
            defaultPrompt: null,
            installed: true,
            enabled: true,
            path: "plugin://browser@openai-bundled",
            iconUrl: null,
            iconUrlDark: null,
            brandColor: "#4b8df8",
          },
        ];
      }
      if (channel === "codex:composer-skills:list") return [];
      if (channel === "codex:composer-sites:list") {
        return { available: false, sites: [] };
      }
      if (channel === "codex:composer-chatgpt-conversations:list") {
        return { available: false, conversations: [] };
      }
      if (channel === "codex:mcp-server-statuses:list") {
        return { data: [], nextCursor: null };
      }
      if (channel === "codex:mcp-apps:list") {
        return [
          {
            id: "plugin-management",
            name: "Plugin Management",
            description: "Manage installed plugins",
            logoUrl: null,
            logoUrlDark: null,
            iconAssets: null,
            iconDarkAssets: null,
            distributionChannel: null,
            branding: null,
            appMetadata: null,
            labels: null,
            installUrl: null,
            isAccessible: true,
            isEnabled: true,
            pluginDisplayNames: [],
          },
        ];
      }
      if (channel === "subscribe-live-query" || channel === "unsubscribe-live-query") {
        return true;
      }
      return null;
    },
    on: () => () => {},
  });

  const view = render(
    <TestQueryProvider>
      <ThreadStageScope>
        <TooltipProvider>
          <LocalConversationProvider>
            <ConnectedThreadStage
              projectId="project_1"
              projectWorkspacePath="/tmp/nodex"
              isNewThreadTab
              newThreadTarget={{
                projectId: "project_1",
                projectName: "Nodex",
                sessionId: "session_1",
                threadTitle: "New thread",
                runInTarget: "localProject",
              }}
              newThreadProjectSelector={{
                projects: [
                  {
                    id: "project_1",
                    label: "Nodex",
                    appearance: { color: "green", marker: { kind: "icon", icon: "plant" } },
                    description: "/tmp/nodex",
                    primaryWorkspaceRoot: "/tmp/nodex",
                    searchText: "nodex /tmp/nodex",
                  },
                ],
                selectedProjectId: "project_1",
                disabled: false,
                canAddProject: true,
              }}
              newThreadStartInSelector={{
                target: {
                  runInTarget: "localProject",
                  runInEnvironmentPath: null,
                },
                disabled: false,
                worktreeAvailable: true,
                environments: [],
                environmentsLoading: false,
                environmentsError: false,
                selectedEnvironmentPath: null,
                defaultEnvironmentPath: null,
                environmentNeedsAttention: false,
                environmentRepairConfigPath: null,
              }}
              threadStartProgress={overrides?.threadStartProgress ?? null}
              activeThreadId={null}
              activeThreadSummary={null}
              availableModels={[
                {
                  id: "gpt-5.5",
                  model: "gpt-5.5",
                  displayName: "5.5",
                  description: "",
                  hidden: false,
                  isDefault: true,
                  defaultReasoningEffort: "xhigh",
                  inputModalities: ["text", "image"],
                  multiAgentVersion: null,
                  serviceTiers: [],
                  defaultServiceTier: null,
                  supportedReasoningEfforts: [
                    { reasoningEffort: "xhigh", description: "Extra High" },
                  ],
                },
              ]}
              collaborationModes={[]}
              selectedCollaborationMode="default"
              selectedModel="gpt-5.5"
              selectedReasoningEffort="xhigh"
              reasoningEffortOptions={[{ reasoningEffort: "xhigh", description: "Extra High" }]}
              permissionMode="full-access"
              isQueueingEnabled={false}
              composerEnterBehavior="enter"
              searchOpenTick={0}
              actions={buildActions()}
            />
          </LocalConversationProvider>
        </TooltipProvider>
      </ThreadStageScope>
    </TestQueryProvider>,
  );
  await settleAsyncRender();
  await act(async () => {
    await settleAsyncRender();
  });
  return view;
}

describe("ConnectedThreadStage archived resume behavior", () => {
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

  test("does not present a request surface hidden behind a full-width panel", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;

    const view = await renderStage(buildThreadSummary(false), {
      routeActive: true,
      threadBodyVisible: false,
      rightPanelComposerOverlayEnabled: false,
    });
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
    ).toBe(false);

    await act(async () => {
      view.unmount();
      await settleAsyncRender();
    });
  });

  test("presents the request surface through the right-panel composer overlay", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;

    const view = await renderStage(buildThreadSummary(false), {
      routeActive: true,
      threadBodyVisible: false,
      rightPanelComposerOverlayEnabled: true,
    });
    await act(async () => {
      await settleAsyncRender();
    });

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
  });

  test("releases the request presentation when the Session composer is hidden", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;

    const view = await renderStage(buildThreadSummary(false), {
      routeActive: true,
      threadBodyVisible: false,
      rightPanelComposerOverlayEnabled: true,
      rightPanelComposerOverlayVisibility: {
        kind: "controlled",
        visible: false,
        attention: "request",
        onVisibleChange: () => {},
      },
    });
    await act(async () => {
      await settleAsyncRender();
    });

    expect(
      invokeCalls.some(
        (call) =>
          call.channel === "codex:thread:presentation:set" &&
          call.threadId === "thread_active" &&
          call.presented === true,
      ),
    ).toBe(false);

    await act(async () => {
      view.unmount();
      await settleAsyncRender();
    });
  });

  test("registers the conversation behind a visible background request card", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;
    const view = await renderStage(buildThreadSummary(false));
    const { dispatchCodexAppServerMessage } = await import("../app-server-message-bus");

    await act(async () => {
      dispatchTestThreadStreamSnapshot(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: "thread_child",
        version: 1,
        sourceClientId: "test-owner",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation("thread_child", {
            source: { parentThreadId: "thread_active" },
            requests: [
              {
                type: "approval",
                requestId: "background-approval",
                kind: "command",
                projectId: "project_1",
                threadId: "thread_child",
                turnId: "turn_ready",
                itemId: "command-background",
                createdAt: 3,
              },
            ],
            canonicalRequests: [
              {
                method: "item/commandExecution/requestApproval",
                id: "background-approval",
                params: {
                  threadId: "thread_child",
                  turnId: "turn_ready",
                  itemId: "command-background",
                  kind: "command",
                  startedAtMs: 3,
                  environmentId: null,
                  command: "git status",
                  cwd: "/tmp/project",
                  reason: null,
                  commandActions: [],
                  availableDecisions: null,
                  proposedExecpolicyAmendment: null,
                  proposedNetworkPolicyAmendments: null,
                  networkApprovalContext: null,
                  additionalPermissions: null,
                },
              },
            ],
          }),
        },
      });
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
                parentThreadId: "thread_active",
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

  test("keeps background-agent detail read-only beside the primary thread composer", async () => {
    const view = await renderPrimaryAndAuxiliaryThread("background-detail");

    expect(
      view.container.querySelectorAll('[data-local-conversation-composer-shell="true"]'),
    ).toHaveLength(1);
  });

  test("gives a writable auxiliary thread its own composer scope", async () => {
    const view = await renderPrimaryAndAuxiliaryThread("side-chat");

    expect(
      view.container.querySelectorAll('[data-local-conversation-composer-shell="true"]'),
    ).toHaveLength(2);
  });

  test("does not auto-resume archived active thread summaries", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;

    await renderStage(buildThreadSummary(true));
    await act(async () => {
      await settleAsyncRender();
    });

    expect(invokeCalls.some((call) => call.channel === "codex:thread:resume:prepare")).toBe(false);
  });

  test("auto-resumes non-archived active thread summaries", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;

    await renderStage(buildThreadSummary(false));
    await act(async () => {
      await settleAsyncRender();
    });

    expect(
      invokeCalls.some(
        (call) =>
          call.channel === "codex:thread:resume:prepare" && call.threadId === "thread_active",
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
      await waitFor(
        () => {
          expect(resumes()).toHaveLength(initialResumes + 1);
          expect(manager.readConversation("thread_active")?.resumeState).toBe("resumed");
        },
        { timeout: 1_000 },
      );
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

  test("does not mark or resume hidden idle thread viewports", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;

    await renderStage(buildThreadSummary(false), { routeActive: false });
    await act(async () => {
      await settleAsyncRender();
    });

    expect(invokeCalls.some((call) => call.channel === "peer:threadStreamFollowingChanged")).toBe(
      false,
    );
    expect(invokeCalls.some((call) => call.channel === "codex:thread:resume:prepare")).toBe(false);
  });

  test("keeps resume and view-active behavior for hidden active threads", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;

    await renderStage(
      {
        ...buildThreadSummary(false),
        statusType: "active",
        statusActiveFlags: ["waitingOnApproval"],
      },
      { routeActive: false },
    );
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
          call.channel === "codex:thread:resume:prepare" && call.threadId === "thread_active",
      ),
    ).toBe(true);
  });

  test("keeps route lifecycle and composer mounted while the transcript is hidden", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    hostMessageListener = null;

    const view = await renderStage(buildThreadSummary(false), {
      routeActive: true,
      threadBodyVisible: false,
    });
    await act(async () => {
      await settleAsyncRender();
    });

    expect(view.container.querySelector("[data-local-conversation-transcript='true']")).toBe(null);
    expect(view.container.querySelector("[data-thread-find-composer='true']") !== null).toBe(true);
    expect(
      invokeCalls.some(
        (call) =>
          call.channel === "peer:threadStreamFollowingChanged" &&
          call.threadId === "thread_active" &&
          call.active === true,
      ),
    ).toBe(true);
  });
});

describe("ConnectedThreadStage read-state control plane", () => {
  test("marks newly active unread work as read while the thread viewport is focused", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    readStateWrites = [];
    hostMessageListener = null;
    const hasFocusDescriptor = Object.getOwnPropertyDescriptor(document, "hasFocus");
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
    });
    const view = await renderStage(buildThreadSummary(false));
    const { dispatchCodexAppServerMessage } = await import("../app-server-message-bus");

    try {
      invokeCalls = [];
      readStateWrites = [];
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
              hasUnreadTurn: true,
            }),
          },
        });
        await settleAsyncRender();
      });

      await waitFor(() => {
        if (
          !readStateWrites.some(
            (change) =>
              change.hostId === "local" &&
              change.threadId === "thread_active" &&
              !change.hasUnreadTurn,
          )
        ) {
          throw new Error("Expected focused unread thread to be marked read.");
        }
      });
    } finally {
      view.unmount();
      if (hasFocusDescriptor) {
        Object.defineProperty(document, "hasFocus", hasFocusDescriptor);
      } else {
        Reflect.deleteProperty(document, "hasFocus");
      }
    }
  });

  test("does not immediately clear an explicit mark-unread state without new thread activity", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    readStateWrites = [];
    hostMessageListener = null;
    const hasFocusDescriptor = Object.getOwnPropertyDescriptor(document, "hasFocus");
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => true,
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

  test("marks unread work as read on pointer, keyboard, and wheel interactions even before focus settles", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    readStateWrites = [];
    hostMessageListener = null;
    const hasFocusDescriptor = Object.getOwnPropertyDescriptor(document, "hasFocus");
    Object.defineProperty(document, "hasFocus", {
      configurable: true,
      value: () => false,
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
              hasUnreadTurn: true,
            }),
          },
        });
        await settleAsyncRender();
      });
      expect(readStateWrites.length > 0).toBe(false);

      const stage = view.container.firstElementChild;
      if (!(stage instanceof HTMLElement)) {
        throw new Error("Expected connected thread stage root.");
      }
      const interactions = [
        () => fireEvent.pointerDown(stage),
        () => fireEvent.keyDown(stage, { key: "ArrowDown" }),
        () => fireEvent.wheel(stage),
      ];

      for (const interact of interactions) {
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
        await act(async () => {
          interact();
          await settleAsyncRender();
        });
        expect(
          readStateWrites.some(
            (change) =>
              change.hostId === "local" &&
              change.threadId === "thread_active" &&
              !change.hasUnreadTurn,
          ),
        ).toBe(true);
      }
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
      expect(
        view.container.querySelector('[data-user-message-bubble="true"]')?.textContent,
      ).toContain("Canonical first submission is visible.");
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

  test("moves an admitted first submission onto the thread surface before a Thread exists", async () => {
    installAsyncRequestAnimationFrame();
    sessionFirstSubmissionOwner.dispose();
    sessionFirstSubmissionOwner.begin({
      backend: "codex",
      originProjectId: "project_1",
      originSessionId: "session_1",
      prompt: "Keep this prompt visible during startup.",
    });

    const view = await renderNewThreadHome();
    try {
      expect(view.container.querySelectorAll('[data-user-message-bubble="true"]')).toHaveLength(1);
      expect(textContent(view.container).includes("Keep this prompt visible during startup.")).toBe(
        true,
      );
      expect(view.container.querySelector("[data-new-thread-home-main='true']")).toBeNull();
      expect(view.container.querySelector("[data-new-thread-home-hero='true']")).toBeNull();
      expect(
        view.container.querySelector("[data-local-conversation-thread-body='true']"),
      ).not.toBeNull();
    } finally {
      view.unmount();
      sessionFirstSubmissionOwner.dispose();
    }
  });

  test("renders the new-thread hero, composer, and scoped footer without deferred rows", async () => {
    installAsyncRequestAnimationFrame();

    const view = await renderNewThreadHome();
    const home = view.container.querySelector<HTMLElement>("[data-new-thread-home-main='true']");
    const hero = view.container.querySelector<HTMLElement>("[data-new-thread-home-hero='true']");
    const composer = view.container.querySelector<HTMLElement>(
      "[data-new-thread-home-composer='true']",
    );
    const lowerStatusRow = view.container.querySelector<HTMLElement>(
      "[data-composer-lower-status-row='true']",
    );
    const externalFooterSlot = view.container.querySelector<HTMLElement>(
      "[data-composer-external-footer-slot='true']",
    );
    const promptEditor = view.container.querySelector<HTMLElement>("[data-codex-composer='true']");
    const mark = view.container.querySelector<HTMLElement>("[data-nodex-home-mark='true']");
    const projectTriggers = view.getAllByLabelText("Select project") as HTMLButtonElement[];
    const renderedText = textContent(view.container);

    expect(home !== null).toBe(true);
    expect(hero !== null).toBe(true);
    expect(mark !== null).toBe(true);
    expect(mark?.querySelector("canvas")).toBeNull();
    expect(renderedText.includes("What should we build in Nodex?")).toBe(true);
    expect(composer !== null).toBe(true);
    expect(promptEditor !== null).toBe(true);
    expect(projectTriggers.length).toBe(2);
    expect(projectTriggers.some((trigger) => trigger.disabled)).toBe(false);
    await waitFor(() => {
      if (!view.container.querySelector("[data-placeholder='Do anything']")) {
        throw new Error("Expected Codex composer placeholder.");
      }
    });
    const branchTrigger = view.getByLabelText("Switch branch");
    expect(branchTrigger !== null).toBe(true);
    expect(branchTrigger.hasAttribute("title")).toBe(false);
    expect(lowerStatusRow !== null).toBe(true);
    expect(externalFooterSlot?.contains(lowerStatusRow)).toBe(true);
    expect(renderedText.includes("Work locally")).toBe(true);
    expect(renderedText.includes("Start a new thread")).toBe(false);
    expect(renderedText.includes("Connect Codex web")).toBe(false);
    expect(renderedText.includes("Send to cloud")).toBe(false);
  });

  test("projects installed app-server plugins into the production composer menu", async () => {
    installAsyncRequestAnimationFrame();
    const view = await renderNewThreadHome();
    const trigger = view.getByRole("button", { name: "Add files and more" });

    await act(async () => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
      fireEvent.click(trigger);
      await settleAsyncRender();
    });

    await waitFor(() => {
      const browserRow = view.container.querySelector('[data-add-context-plugin="Browser"]');
      expect(browserRow).not.toBeNull();
      const pluginManagementRow = view.container.querySelector(
        '[data-add-context-app="Plugin Management"]',
      );
      expect(pluginManagementRow).not.toBeNull();
    });
  });

  test("uses ready thread start progress to render the materialized first turn", async () => {
    installAsyncRequestAnimationFrame();
    invokeCalls = [];
    readStateWrites = [];
    hostMessageListener = null;
    const threadId = "thread_ready";
    const view = await renderNewThreadHome({
      threadStartProgress: {
        runInTarget: "localProject",
        threadId,
        phase: "ready",
        message: "Message sent.",
        outputText: "",
        outputTruncated: false,
        updatedAt: 10,
      },
    });
    const { dispatchCodexAppServerMessage } = await import("../app-server-message-bus");

    await act(async () => {
      dispatchTestThreadStreamSnapshot(dispatchCodexAppServerMessage, {
        hostId: "local",
        conversationId: threadId,
        version: 1,
        sourceClientId: "test-owner",
        change: {
          type: "snapshot",
          revision: 1,
          conversationState: buildConversation(threadId),
        },
      });
      await settleAsyncRender();
    });

    const renderedText = textContent(view.container);
    const home = view.container.querySelector<HTMLElement>("[data-new-thread-home-main='true']");

    expect(home === null).toBe(true);
    expect(renderedText.includes("What should we build in Nodex?")).toBe(false);
    expect(renderedText.includes("Remove the redundant transitions.")).toBe(true);
    expect(renderedText.includes("Thinking")).toBe(true);
    expect(renderedText.includes("Sending message")).toBe(false);
    expect(renderedText.includes("Message sent.")).toBe(false);
    expect(
      invokeCalls.some(
        (call) =>
          call.channel === "peer:threadStreamFollowingChanged" &&
          call.threadId === threadId &&
          call.active === true,
      ),
    ).toBe(true);
  });
});
