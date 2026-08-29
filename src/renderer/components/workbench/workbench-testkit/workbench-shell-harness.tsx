import { afterEach, beforeAll, beforeEach, expect, vi } from "vite-plus/test";
import { initPrefersReducedMotion } from "motion";
import { installMotionPreferenceForTest } from "@/test/browser-globals";
import {
  Fragment,
  createElement,
  createRef,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import * as Y from "yjs";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { PAGE_DOCUMENT_SCHEMA_VERSION } from "../../../../shared/block-documents/page-document";
import type { DatabaseViewConfigV6, DatabaseViewSort } from "../../../../shared/database-kernel";
import { WorkbenchLayoutSnapshotSchema } from "../../../../shared/schemas/workbench-layout";
import type {
  CodexAutomationInboxItem,
  CodexAutomationRunsInboxResponse,
  CodexBackgroundSubagentThreadsHydrateInput,
  CodexSubagentPanelHydrateInput,
  CodexHostMessage,
  CodexModelOption,
  CodexScheduledAutomation,
  CodexScheduledAutomationCreateInput,
  CodexScheduledAutomationUpdateInput,
  CodexSidebarSyncResult,
  CodexSidebarThreadItem,
  CodexThreadDetail,
  CodexThreadStartForSessionResult,
  GitReviewSource,
  PageChatItem,
  Project,
  WorkbenchTabProjection,
  WorkbenchTabCreateInput,
  WorkbenchTabUpdateInput,
  WorktreeEnvironmentOption,
} from "@/lib/types";
import type { PageSearchMetadataSnapshot, PageSearchSnapshot } from "../../../../shared/types";
import type { LibraryNavigationNode } from "../../../../shared/library-module";
import type { WorkbenchLayoutSnapshot } from "../../../../shared/workbench-layout";
import {
  DEFAULT_SIDEBAR_COLLAPSIBLE_SECTIONS,
  DEFAULT_TEST_CODEX_MODELS,
  activateTestPanelLayout,
  appendTestPanelLayoutTab,
  firstPanelLeafId,
  makeAttachedSession,
  makePanelLayout,
  makePanels,
  makeProject,
  makeSession,
  makeSessionTab,
  makeSessionViewFixture,
  replaceSession,
  sortProjectSessionsForTest,
  updateSessionTab,
} from "./workbench-shell-fixtures";
import type { ProjectSession } from "./workbench-shell-fixtures";
import { resetDatabaseRowDetailStoreForTests } from "@/lib/database-row-detail-store";
import { resetPageDetailStoreForTests } from "@/lib/page-detail-store";
import { resetDatabaseViewPersonalPreferencesForTests } from "@/lib/database-view-personal-preferences";
import { resetDatabaseListWindowStoresForTests } from "../database-list/use-database-list-window";
import { useRetainedScrollPosition } from "@/lib/retained-scroll-position";
import { buildPageDetailStoryResult } from "../../board/page-stage/page-stage-story-page-detail";
import { authorizedReadStampFixture } from "../../../../shared/testing/authorized-read-stamp-fixture";
import { terminalSessionStore } from "@/lib/terminal-session-store";
import type {
  SidebarDisclosureSectionId,
  SidebarCollapsibleSectionsState,
} from "@/lib/use-workbench-profile-preferences";
import { openNodexMenu, render, settleAsyncRender } from "../../../test/dom";
import { TestQueryProvider } from "../../../test/query";
import { RendererStateProvider } from "../../../app-providers";
import { NodexModalHost } from "@/lib/modal-registry";
import { AppShellHeaderContentRegistrar } from "@/lib/workbench-ui-scopes";
import { __resetNodexToastStoreForTests } from "@/components/ui/toast";
import {
  buildCommandPaletteCommands,
  executeCommandPaletteShellCommand,
  isCommandPaletteShellCommandId,
  type CommandPaletteShellCommandContext,
  type CommandPaletteShellCommandHandlers,
} from "@/lib/command-palette-commands";
import type { WorkbenchCommandPort } from "@/lib/use-workbench-command-ingress";
import { normalizeCodexManualThreadTitle } from "../../../../shared/codex-thread-title";
import type {
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeStartingState,
  CodexPendingWorktreeWarningEvent,
} from "../../../../shared/codex-pending-worktree";
import type {
  WorkbenchNavigationCommandState,
  WorkbenchNavigationCommandSource,
  WorkbenchNavigationDirection,
  WorkbenchPanelTabCycleDirection,
  WorkbenchSidebarToggleCommandSource,
} from "../../../../shared/window-navigation";
import {
  CREATE_PAGE_COMMAND_ID,
  type WorkbenchCommandRequest,
  type WorkbenchCommandSource,
} from "../../../../shared/workbench-commands";
import {
  findWorkbenchPanelLeafForTab,
  findNearestWorkbenchPanelLeafToRight,
  insertWorkbenchPanelLeaf,
  removeWorkbenchPanelTab,
  listWorkbenchPanelLeaves,
} from "../../../../shared/workbench-panel-layout";
import { type WorkbenchSessionViewSnapshot } from "../../../../shared/workbench-session-view";
import { projectWorkbenchSceneToLegacySessionView } from "../../../../shared/workbench-scene";
import {
  PageTitleProjectionPublisher,
  type PageTitleResourceIdentity,
} from "@/lib/page-title-projection-context";

export let invokeCalls: unknown[][] = [];

const databaseViewConfigFixture = ({
  sorts = [],
  showEmptyGroups = true,
}: {
  readonly sorts?: readonly DatabaseViewSort[];
  readonly showEmptyGroups?: boolean;
} = {}): DatabaseViewConfigV6 => ({
  schemaKey: "nodex.database-view",
  schemaVersion: 6,
  rules: { propertyFilters: [], advancedFilter: null, sorts },
  presentation: {
    group: null,
    subgroup: null,
    groupDirection: "asc",
    completion: { range: "all", orderByRecency: false },
    hierarchy: { showSubPages: true, nestedSubPages: false },
    display: { fields: [], propertyOrder: [], showEmptyGroups, showDescription: true },
    conditionalColors: [],
  },
});

export let mockInvokeImpl: ((channel: string, ...args: unknown[]) => Promise<unknown>) | null =
  null;
export let startThreadForSessionCalls: unknown[] = [];
export let startTurnCalls: unknown[][] = [];
export let pageChatItems: PageChatItem[] = [];
export let startThreadForSessionResult: CodexThreadStartForSessionResult = {
  kind: "started",
  detail: { threadId: "thread-started" } as CodexThreadDetail,
};
export let requestThreadStreamSnapshotCalls: string[] = [];
export let requestThreadStreamSnapshotImpl: ((threadId: string) => Promise<unknown>) | null = null;
export let hydrateBackgroundSubagentThreadsCalls: CodexBackgroundSubagentThreadsHydrateInput[] = [];
export let hydrateSubagentPanelCalls: CodexSubagentPanelHydrateInput[] = [];
export let removeQueuedFollowUpCalls: unknown[][] = [];
export let reorderQueuedFollowUpsCalls: unknown[][] = [];
export let sendQueuedFollowUpNowCalls: unknown[][] = [];
export let editLastUserTurnCalls: unknown[][] = [];
export let setComposerIntentCalls: unknown[][] = [];
export let removePlanImplementationRequestCalls: unknown[][] = [];
export let cleanBackgroundTerminalsCalls: string[] = [];
export let listBackgroundTerminalsCalls: string[] = [];
export let listBackgroundProcessesCalls: string[] = [];
export let terminateBackgroundTerminalCalls: unknown[] = [];
export let startSideChatCalls: unknown[] = [];
export let startSideChatError: Error | null = null;
export let discardSideChatCalls: string[] = [];
export let sideChatConversations: Record<string, Record<string, unknown>> = {};
export let sideChatConversationProjectId: string | null = "alpha";
export let mockThreadStartProgress: unknown = null;
export let mockConversationHasVisibleTurn = true;
export let codexHostMessageListener: ((message: CodexHostMessage) => void) | null = null;
export let pendingWorktreeWarningListener:
  | ((event: CodexPendingWorktreeWarningEvent) => void)
  | null = null;
export const PANEL_VISIBLE_ICON_PREFIX = "M16.835 8.66301";
export const BOTTOM_PANEL_HIDDEN_ICON_PREFIX = "M13.334 12.2529";
export const EXPAND_PANEL_ICON_PREFIX = "M16.0299 3.0293";
export const RESTORE_PANEL_ICON_PREFIX = "M4.33496 11";
export const NEW_CHAT_ICON_PREFIX = "M2.6687 11.333";
export const TITLEBAR_NEW_CHAT_ICON_PREFIX = "M6.33325 1.88379";

export type TerminalEventListenerMap = Record<string, (payload: unknown) => void>;

export const mockCodexControl = {
  availableModels: DEFAULT_TEST_CODEX_MODELS,
  threadSettings: { model: "gpt-5.5", reasoningEffort: "medium" },
  reasoningEffortOptions: [{ reasoningEffort: "medium", description: "Balanced" }],
  permissionMode: "auto",
  loadModels: async () => undefined,
  loadThreads: async () => undefined,
  listCollaborationModes: async () => [{ name: "Plan", mode: "plan", model: null }],
  setThreadModel: () => undefined,
  setThreadReasoningEffort: () => undefined,
  setPermissionMode: async () => undefined,
  startThreadForSession: async (input: unknown) => {
    startThreadForSessionCalls.push(input);
    return startThreadForSessionResult;
  },
  startSideChat: async (input: unknown) => {
    startSideChatCalls.push(input);
    if (startSideChatError) throw startSideChatError;
    const threadId = `side-thread-${startSideChatCalls.length}`;
    const conversation = {
      threadId,
      projectId: sideChatConversationProjectId,
      source: {
        parentThreadId: "thread-alpha",
        sideConversation: true,
        sideConversationParentNavigationPath:
          "project:alpha/session:session:alpha:database-view/thread:thread-alpha",
      },
      threadName: null,
      threadPreview: "",
      modelProvider: "openai",
      cwd: "/Users/asc/repo/nodex",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      linkedAt: "",
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
        canEditLastUserTurn: false,
        canForkFromTurn: false,
        canSearch: true,
        canCollapseTurns: true,
      },
      ephemeral: true,
    };
    sideChatConversations[threadId] = conversation;
    return {
      parentThreadId: "thread-alpha",
      threadId,
      conversation,
    };
  },
  discardSideChat: async (threadId: string) => {
    discardSideChatCalls.push(threadId);
    delete sideChatConversations[threadId];
    return true;
  },
  startTurn: async (...args: unknown[]) => {
    startTurnCalls.push(args);
  },
  steerTurn: async () => undefined,
  interruptTurn: async () => undefined,
  respondApproval: async () => undefined,
  respondUserInput: async () => undefined,
  respondMcpElicitation: async () => undefined,
  enqueueQueuedFollowUp: async () => undefined,
  requestThreadStreamSnapshot: async (threadId: string) => {
    requestThreadStreamSnapshotCalls.push(threadId);
    if (requestThreadStreamSnapshotImpl) {
      await requestThreadStreamSnapshotImpl(threadId);
    }
    return null;
  },
  markSubagentThreadOpened: async () => true,
  hydrateBackgroundSubagentThreads: async (input: CodexBackgroundSubagentThreadsHydrateInput) => {
    hydrateBackgroundSubagentThreadsCalls.push(input);
    return [];
  },
  hydrateSubagentPanel: async (input: CodexSubagentPanelHydrateInput) => {
    hydrateSubagentPanelCalls.push(input);
    return (input.threadIds ?? []).flatMap((threadId) => {
      const conversation = sideChatConversations[threadId];
      return conversation ? [conversation as unknown as CodexThreadDetail] : [];
    });
  },
  removeQueuedFollowUp: async (threadId: string, followUpId: string) => {
    removeQueuedFollowUpCalls.push([threadId, followUpId]);
  },
  reorderQueuedFollowUps: async (threadId: string, orderedFollowUpIds: string[]) => {
    reorderQueuedFollowUpsCalls.push([threadId, orderedFollowUpIds]);
  },
  sendQueuedFollowUpNow: async (threadId: string, followUpId: string) => {
    sendQueuedFollowUpNowCalls.push([threadId, followUpId]);
  },
  editLastUserTurn: async (threadId: string, turnId: string, message: string) => {
    editLastUserTurnCalls.push([threadId, turnId, message]);
    return {
      threadId,
      composerIntent: {
        prompt: message,
        focusNonce: 1,
      },
    };
  },
  forkConversationFromTurn: async (threadId: string, turnId: string, message: string) => ({
    threadId: `${threadId}:forked:${turnId}`,
    composerIntent: {
      prompt: message,
      focusNonce: 1,
    },
  }),
  compactThread: async () => undefined,
  getThreadGoal: async () => null,
  setThreadGoal: async () => null,
  clearThreadGoal: async () => undefined,
  setThreadMemoryMode: async () => undefined,
  uploadFeedback: async () => undefined,
  cleanBackgroundTerminals: async (threadId: string) => {
    cleanBackgroundTerminalsCalls.push(threadId);
    return true;
  },
  listBackgroundTerminals: async (threadId: string) => {
    listBackgroundTerminalsCalls.push(threadId);
    if (threadId !== "thread-alpha") return [];
    return [
      {
        itemId: "item-process",
        processId: "process-alpha",
        command: "bun run dev",
        cwd: "/Users/asc/repo/nodex",
        osPid: 4312,
        cpuPercent: 12.5,
        rssKb: 1536n,
      },
    ];
  },
  listBackgroundProcesses: async (threadId: string) => {
    listBackgroundProcessesCalls.push(threadId);
    if (threadId !== "thread-alpha") return [];
    const terminal = {
      itemId: "item-process",
      processId: "process-alpha",
      command: "bun run dev",
      cwd: "/Users/asc/repo/nodex",
      osPid: 4312,
      cpuPercent: 12.5,
      rssKb: 1536n,
    };
    return [
      {
        id: "thread-alpha:item-process",
        threadId,
        threadTitle: "Thread alpha",
        itemId: terminal.itemId,
        turnId: "turn-process",
        command: terminal.command,
        cwd: terminal.cwd,
        processId: terminal.processId,
        osPid: terminal.osPid,
        terminalSessionId: null,
        source: "app-server",
        startedAtMs: 1,
        updatedAtMs: 2,
        status: "running",
        terminal,
        terminalSession: null,
      },
    ];
  },
  runBackgroundProcess: async () => [],
  stopBackgroundProcess: async (input: {
    threadId: string;
    processId: string | null;
    terminalSessionId: string | null;
  }) => {
    terminateBackgroundTerminalCalls.push(input);
    return true;
  },
  terminateBackgroundTerminal: async (input: unknown) => {
    terminateBackgroundTerminalCalls.push(input);
    return true;
  },
  setComposerIntent: (threadId: string, composerIntent: unknown) => {
    setComposerIntentCalls.push([threadId, composerIntent]);
  },
  consumeComposerIntent: () => undefined,
  setConversationCollaborationMode: async () => ({
    mode: "default",
    settings: {
      model: null,
      reasoning_effort: null,
      developer_instructions: null,
    },
  }),
  removePlanImplementationRequest: async (threadId: string, turnId: string) => {
    removePlanImplementationRequestCalls.push([threadId, turnId]);
    return true;
  },
};

const pageCreateWorkflowMocks = vi.hoisted(() => ({
  requestFromContext: vi.fn(() => true),
}));

export const requestPageCreateFromContextMock = pageCreateWorkflowMocks.requestFromContext;

vi.mock("@/lib/page-create-workflow", () => ({
  requestPageCreateFromContext: pageCreateWorkflowMocks.requestFromContext,
}));

vi.mock("@/features/workspace-files/workspace-pierre-editor", () => ({
  WorkspacePierreEditor: ({
    ariaLabel,
    value,
    onChange,
  }: {
    ariaLabel: string;
    value: string;
    onChange: (value: string) => void;
  }) =>
    createElement("textarea", {
      "aria-label": ariaLabel,
      value,
      onChange: (event: { currentTarget: { value: string } }) => {
        onChange(event.currentTarget.value);
      },
    }),
}));

vi.mock("@/lib/api", () => {
  const gitWorkerListeners = new Set<(message: unknown) => void>();
  const gitWorkerClient = {
    request: async (input: { method: string; params: Record<string, unknown> }) => {
      invokeCalls.push([input.method, input.params]);
      const mocked = await mockInvokeImpl?.(input.method, input.params);
      if (mocked !== null && mocked !== undefined) return mocked;
      const cwd = typeof input.params.cwd === "string" ? input.params.cwd : "/workspace/alpha";
      switch (input.method) {
        case "stable-metadata":
          return {
            cwd,
            root: cwd,
            gitDir: `${cwd}/.git`,
            commonDir: `${cwd}/.git`,
            isGitRepository: true,
            currentBranch: "main",
            defaultBranch: "main",
            errorMessage: null,
          };
        case "branch-metadata":
          return {
            currentBranch: "main",
            defaultBranch: "main",
            branches: ["main"],
          };
        case "status-summary":
          return {
            type: "success",
            cwd,
            stagedCount: 0,
            unstagedCount: 0,
            untrackedCount: 0,
          };
        case "action-status":
          return {
            cwd,
            isGitRepository: true,
            currentBranch: "main",
            defaultBranch: "main",
            upstreamBranch: "origin/main",
            remotes: ["origin"],
            hasHeadCommit: true,
            hasStagedChanges: false,
            hasUnstagedChanges: false,
            hasUntrackedFiles: false,
            hasUncommittedChanges: false,
            commitsAhead: 0,
            canCommit: false,
            canPush: false,
            pushNeedsUpstream: false,
            errorMessage: null,
          };
        case "review-summary":
          return {
            type: "success",
            source: input.params.source ?? "unstaged",
            files: [],
            snapshotGeneration: 1,
            stageCounts: {
              stagedFileCount: 0,
              unstagedFileCount: 0,
              untrackedFileCount: 0,
            },
            untrackedFilesOmitted: 0,
          };
        case "branch-diff-stats":
          return {
            cwd,
            baseRef: "main",
            files: [],
            fileCount: 0,
            additions: 0,
            deletions: 0,
            untrackedFilesOmitted: 0,
            isGitRepository: true,
            currentBranch: "main",
            defaultBranch: "main",
            errorMessage: null,
          };
        case "base-branch":
          return { cwd, local: "main", remote: "origin/main", errorMessage: null };
        case "subscribe-live-query":
          return { subscribed: true };
        case "unsubscribe-live-query":
          return { unsubscribed: true };
        case "recover-live-query":
          return { recovered: true };
        case "refresh-live-query":
          return { refreshed: true };
        case "refresh-repository":
          return { type: "success", generation: 1 };
        default:
          return null;
      }
    },
    subscribe: (listener: (message: unknown) => void) => {
      gitWorkerListeners.add(listener);
      return () => gitWorkerListeners.delete(listener);
    },
  };
  return {
    getGitWorkerClient: () => gitWorkerClient,
    invoke: async (channel: string, ...args: unknown[]) => {
      invokeCalls.push([channel, ...args]);
      return mockInvokeImpl?.(channel, ...args) ?? null;
    },
    searchPages: async (input: unknown) => {
      const requestId = "test-page-search-request";
      invokeCalls.push(["pages:search", requestId, input]);
      return mockInvokeImpl?.("pages:search", requestId, input) ?? null;
    },
    readDatabaseViewWindow: async (projectId: string, input: unknown) => {
      invokeCalls.push(["database:view-window:get", projectId, input]);
      return mockInvokeImpl?.("database:view-window:get", projectId, input) ?? null;
    },
    readDatabaseListWindow: async (projectId: string, input: unknown) => {
      invokeCalls.push(["database:list-window:get", projectId, input]);
      const configured = await mockInvokeImpl?.("database:list-window:get", projectId, input);
      if (configured !== undefined && configured !== null) return configured;
      const viewWindow = (await mockInvokeImpl?.("database:view-window:get", projectId, input)) as
        | Readonly<Record<string, unknown>>
        | null
        | undefined;
      if (!viewWindow) return null;
      return {
        projectId: viewWindow.projectId,
        libraryId: viewWindow.libraryId,
        databaseId: viewWindow.databaseId,
        dataSourceId: viewWindow.dataSourceId,
        viewId: viewWindow.viewId,
        storeEpoch: viewWindow.storeEpoch,
        commitSeq: viewWindow.commitSeq,
        authorization: viewWindow.authorization,
        projection: viewWindow.projection,
        nextCursor: null,
        rows: [],
        groups: [],
        totalProjectionRowCount: 0,
        totalOccurrenceCount: 0,
        totalModelCount: 0,
        windowStart: 0,
        windowEnd: 0,
        isComplete: true,
      };
    },
    readDatabaseViewGroups: async (projectId: string, input: unknown) => {
      invokeCalls.push(["database:view-groups:get", projectId, input]);
      // Ungrouped default keeps stores on the single flat-window path unless a
      // test opts into per-group windows through mockInvokeImpl.
      const mocked = await mockInvokeImpl?.("database:view-groups:get", projectId, input);
      const viewId = projectId === "beta" ? "view:beta" : "view:alpha";
      return (
        mocked ?? {
          projectId,
          libraryId: "library:test",
          databaseId: "database:test:primary",
          dataSourceId: projectId === "beta" ? "data-source:beta" : "data-source:alpha",
          viewId,
          storeEpoch: "epoch:test",
          commitSeq: 1,
          authorization: authorizedReadStampFixture({
            deliveryAddress: {
              kind: "project",
              library_id: "library:test",
              project_id: projectId,
            },
            subject: { kind: "view", view_id: viewId },
            storeEpoch: "epoch:test",
            commitSeq: 1,
          }),
          projection: {
            scopeKey: `scope:${viewId}`,
            schemaVersion: 1,
            revision: 1,
            coveredCommitSeq: 1,
            effectHash: "f".repeat(64),
          },
          grouped: false,
          subgrouped: false,
          totalRows: 0,
          totalGroups: 0,
          groupLimit: 200,
          truncated: false,
          groups: [],
        }
      );
    },
    readLibraryDatabaseViewWindow: async (input: unknown) => {
      invokeCalls.push(["library-database:view-window:get", input]);
      return mockInvokeImpl?.("library-database:view-window:get", input) ?? null;
    },
    readLibraryDatabaseListWindow: async (input: unknown) => {
      invokeCalls.push(["library-database:list-window:get", input]);
      return mockInvokeImpl?.("library-database:list-window:get", input) ?? null;
    },
    readLibraryDatabaseViewGroups: async (input: unknown) => {
      invokeCalls.push(["library-database:view-groups:get", input]);
      return mockInvokeImpl?.("library-database:view-groups:get", input) ?? null;
    },
    readPageDetail: async (projectId: string, pageId: string) => {
      invokeCalls.push(["pages:detail:get", projectId, pageId]);
      return mockInvokeImpl?.("pages:detail:get", projectId, pageId) ?? null;
    },
    applyDatabaseModule: async (projectId: string, request: unknown) => {
      invokeCalls.push(["database-module:apply", projectId, request]);
      const configured = await mockInvokeImpl?.("database-module:apply", projectId, request);
      if (configured !== undefined && configured !== null) return configured;
      const personalPresentationOperations =
        (
          request as {
            operations?: ReadonlyArray<{
              kind?: string;
              viewId?: string;
              expectedRevision?: number;
            }>;
          }
        ).operations ?? [];
      if (
        personalPresentationOperations.length > 0 &&
        personalPresentationOperations.every(
          (operation) => operation.kind === "put_view_personal_preferences",
        )
      ) {
        return {
          ok: true,
          value: {
            committedRevisions: Object.fromEntries(
              personalPresentationOperations.map((operation) => [
                `view_presentation:profile:test:${String(operation.viewId ?? "")}`,
                (operation.expectedRevision ?? 0) + 1,
              ]),
            ),
            commitSeq: 2,
          },
          localCommit: { status: "applied" },
        };
      }
      return {
        ok: false,
        error: {
          code: "unknown",
          message: "Not configured in this test.",
          retryable: false,
        },
      };
    },
    applyLibraryDatabaseModule: async (request: unknown) => {
      invokeCalls.push(["library-database-module:apply", request]);
      return (
        mockInvokeImpl?.("library-database-module:apply", request) ?? {
          ok: false,
          error: {
            code: "unknown",
            message: "Not configured in this test.",
            retryable: false,
          },
        }
      );
    },
    mutateBlockProperties: async (projectId: string, request: unknown) => {
      invokeCalls.push(["block-properties:mutate", projectId, request]);
      return (
        mockInvokeImpl?.("block-properties:mutate", projectId, request) ?? {
          ok: false,
          error: {
            code: "unknown",
            message: "Not configured in this test.",
            retryable: false,
          },
        }
      );
    },
    resolvePageTarget: async (input: {
      accessContext: { kind: "library" } | { kind: "project"; projectId: string };
      targetPageId: string;
    }) => {
      invokeCalls.push(["page-target:resolve", input]);
      return (
        mockInvokeImpl?.("page-target:resolve", input) ?? {
          status: "missing",
          targetPageId: input.targetPageId,
        }
      );
    },
    resolvePageOwnershipPath: async (input: {
      accessContext: { kind: "library" } | { kind: "project"; projectId: string };
      targetPageId: string;
    }) => {
      invokeCalls.push(["page-ownership-path:resolve", input]);
      return (
        mockInvokeImpl?.("page-ownership-path:resolve", input) ?? {
          status: "available",
          targetPageId: input.targetPageId,
          ancestors: [],
        }
      );
    },
    subscribeBoardChanges: () => () => undefined,
    subscribeDatabaseChanges: () => () => undefined,
    subscribeLibraryChanges: () => () => undefined,
    readLibraryModule: async (accessContext: unknown, request: unknown) => {
      invokeCalls.push(["library-module:read", accessContext, request]);
      const configured = await mockInvokeImpl?.("library-module:read", accessContext, request);
      if (configured !== undefined && configured !== null) return configured;
      const mode = (request as { readonly read?: { readonly mode?: string } }).read?.mode;
      const value =
        mode === "metadata"
          ? { kind: "metadata" as const }
          : mode === "standalone_roots"
            ? {
                kind: "standalone_roots" as const,
                items: [],
                nextCursor: null,
                hasMore: false,
                total: 0,
              }
            : {
                kind: "children" as const,
                parent: { kind: "library" as const },
                items: [],
                nextCursor: null,
                hasMore: false,
                total: 0,
              };
      return {
        ok: true,
        value: {
          version: 5,
          profileId: "profile:test",
          libraryId: "library:test",
          storeEpoch: "epoch:test",
          commitSeq: 0,
          authorization: authorizedReadStampFixture({
            deliveryAddress: { kind: "library", library_id: "library:test" },
            subject: { kind: "library", library_id: "library:test" },
            storeEpoch: "epoch:test",
            commitSeq: 0,
          }),
          value,
        },
      };
    },
    mutateLibraryBlockProperties: async (request: { mutationId: string; storeEpoch: string }) => ({
      ok: true,
      value: {
        version: 2,
        mutationId: request.mutationId,
        projectId: "project-1",
        storeEpoch: request.storeEpoch,
        duplicate: false,
        fields: [],
        blockMetadataRevisions: {},
        commitSeq: 1,
        committedAt: "2026-07-18T00:00:00.000Z",
      },
    }),
    subscribeCommandKeymapChanges: () => () => undefined,
    subscribeProjectChanges: () => () => undefined,
    subscribeProjectSessionChanges: () => () => undefined,
    subscribeCodexHostMessages: (listener: (message: CodexHostMessage) => void) => {
      codexHostMessageListener = listener;
      return () => {
        if (codexHostMessageListener === listener) {
          codexHostMessageListener = null;
        }
      };
    },
    subscribeDesktopNotificationActions: () => () => undefined,
    subscribeCodexScheduledAutomationChanges: () => () => undefined,
    subscribeCodexAutomationRunsUpdates: () => () => undefined,
    subscribeCodexPendingWorktreesChanged: () => () => undefined,
    subscribeCodexPendingWorktreeWarnings: (
      listener: (event: CodexPendingWorktreeWarningEvent) => void,
    ) => {
      pendingWorktreeWarningListener = listener;
      return () => {
        if (pendingWorktreeWarningListener === listener) {
          pendingWorktreeWarningListener = null;
        }
      };
    },
    subscribeAppUpdateStatus: () => () => undefined,
    getWindowFocusState: async () => true,
    subscribeWindowFocusChanges: () => () => undefined,
    readDatabaseModule: async (
      projectId: string,
      request: {
        read?: {
          mode?: string;
          target?: { viewId?: string };
        };
      },
    ) => {
      invokeCalls.push(["database-module:read", projectId, request]);
      const configured = await mockInvokeImpl?.("database-module:read", projectId, request);
      if (configured !== undefined && configured !== null) return configured;
      const databaseId = `database-${projectId}`;
      const dataSourceId = `source-${projectId}`;
      const viewId = `database-view:${projectId}:primary-board`;
      const listViewId = `database-view:${projectId}:primary-list`;
      if (request.read?.mode === "view_personal_preferences") {
        return {
          ok: true,
          value: {
            version: 1,
            projectId,
            libraryId: "library:test",
            storeEpoch: "store-test",
            commitSeq: 1,
            authorization: null,
            value: {
              kind: "view_personal_preferences",
              value: {
                preferencesOverride: { rulesOverride: {}, presentationOverride: {} },
                revision: 0,
              },
            },
          },
        };
      }
      if (request.read?.mode === "view_collapsed_occurrences") {
        return {
          ok: true,
          value: {
            version: 1,
            projectId,
            libraryId: "library:test",
            storeEpoch: "store-test",
            commitSeq: 1,
            authorization: null,
            value: {
              kind: "view_collapsed_occurrences",
              value: { targets: [] },
            },
          },
        };
      }
      const descriptor = {
        database: {
          databaseId,
          libraryId: "library:test",
          name: "Tasks",
          lifecycle: "active",
          defaultViewId: viewId,
          accessRevision: 1,
          metadataRevision: 1,
          createdAt: "2026-06-07T00:00:00.000Z",
          updatedAt: "2026-06-07T00:00:00.000Z",
        },
        dataSources: [
          {
            dataSourceId,
            libraryId: "library:test",
            homeDatabaseId: databaseId,
            name: "Pages",
            schemaKey: "nodex.page",
            schemaRevision: 1,
            lifecycle: "active",
            rankKey: "a",
            createdAt: "2026-06-07T00:00:00.000Z",
            updatedAt: "2026-06-07T00:00:00.000Z",
          },
        ],
        views: [
          {
            viewId,
            databaseId,
            dataSourceId,
            name: "Board",
            layout: "board",
            config: databaseViewConfigFixture({ showEmptyGroups: false }),
            isDefault: true,
            revision: 1,
            rankKey: "a",
            lifecycle: "active",
            createdAt: "2026-06-07T00:00:00.000Z",
            updatedAt: "2026-06-07T00:00:00.000Z",
          },
          {
            viewId: listViewId,
            databaseId,
            dataSourceId,
            name: "List",
            layout: "list",
            config: databaseViewConfigFixture({ showEmptyGroups: false }),
            isDefault: false,
            revision: 1,
            rankKey: "b",
            lifecycle: "active",
            createdAt: "2026-06-07T00:00:00.000Z",
            updatedAt: "2026-06-07T00:00:00.000Z",
          },
        ],
      } as const;
      const selectedView =
        descriptor.views.find((view) => view.viewId === request.read?.target?.viewId) ??
        descriptor.views[0];
      return {
        ok: true,
        value: {
          version: 1,
          projectId,
          libraryId: "library:test",
          storeEpoch: "workbench-test-store",
          commitSeq: 1,
          authorization: null,
          value: {
            kind:
              request.read?.mode === "catalog"
                ? "catalog"
                : request.read?.mode === "query"
                  ? "query"
                  : request.read?.mode === "data_source"
                    ? "data_source"
                    : "database",
            ...(request.read?.mode === "catalog"
              ? {
                  databases: [descriptor],
                }
              : request.read?.mode === "query"
                ? {
                    value: {
                      database: descriptor.database,
                      dataSource: descriptor.dataSources[0],
                      view: selectedView,
                      properties: [],
                      rows: [],
                    },
                  }
                : request.read?.mode === "data_source"
                  ? {
                      value: {
                        dataSource: descriptor.dataSources[0],
                        properties: [],
                      },
                    }
                  : { value: descriptor }),
          },
        },
      };
    },
    transferBlocks: async () => ({
      ok: false,
      error: {
        code: "unknown",
        message: "Not configured in this test.",
        retryable: false,
        reloadRequired: false,
      },
    }),
    undoBlockTransfer: async () => ({
      ok: false,
      error: {
        code: "undo_unavailable",
        message: "Not configured in this test.",
        retryable: false,
        reloadRequired: false,
      },
    }),
  };
});

vi.mock("../database-view-surface", () => ({
  DatabaseViewSurface: (props: Record<string, unknown>) => {
    const model = props.model as {
      accessContext?: { kind?: string; projectId?: string };
      databaseViewId?: string;
      columns?: ReadonlyArray<{
        rows?: ReadonlyArray<{ pageId?: string; title?: string }>;
      }>;
    };
    const projectId =
      model.accessContext?.kind === "project" ? String(model.accessContext.projectId) : "library";
    const effectivePresentation = props.effectivePresentation as
      | { readonly layout?: unknown }
      | undefined;
    const presentationLayout = String(effectivePresentation?.layout ?? props.presentationLayout);
    const [localSearch, setLocalSearch] = useState("");
    const retainedScroll = useRetainedScrollPosition<HTMLDivElement>(
      `database-view-test:${String(model.databaseViewId ?? "unknown")}`,
    );
    (
      globalThis as {
        __lastDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastDatabaseViewSurfaceProps = {
      ...props,
      // The production surface now consumes one effective presentation.
      // Preserve the harness's compact layout observation for shell tests.
      presentationLayout,
      projectId,
      databaseViewId: model.databaseViewId,
      openPageStage: (_projectId: string, pageId: string, titleSnapshot?: string) =>
        (
          props.onOpenPage as (
            pageId: string,
            titleSnapshot: string,
            openMode: "preview" | "durable",
          ) => void
        )(pageId, titleSnapshot ?? "Untitled", "preview"),
    };
    const rows = model.columns?.flatMap((column) => column.rows ?? []) ?? [];
    return createElement(
      "div",
      {
        "data-database-view-surface": "true",
        "data-database-view-id": String(model.databaseViewId ?? ""),
      },
      `DB:${projectId}:${presentationLayout}`,
      createElement("input", {
        "aria-label": `Mock DB search ${projectId}`,
        value: localSearch,
        onInput: (event: { currentTarget: { value: string } }) => {
          setLocalSearch(event.currentTarget.value);
        },
      }),
      createElement(
        "div",
        {
          "data-testid": `mock-db-scroll-${projectId}`,
          ref: retainedScroll.ref,
          onScroll: retainedScroll.onScroll,
          style: { height: 40, width: 40, overflow: "auto" },
        },
        createElement("div", { style: { height: 400, width: 400 } }),
      ),
      ...rows.map((row) =>
        createElement(
          "button",
          {
            key: row.pageId,
            type: "button",
            onClick: () =>
              (props.onOpenPage as (pageId: string, title: string) => void)(
                String(row.pageId),
                String(row.title ?? "Untitled"),
              ),
          },
          row.title,
        ),
      ),
    );
  },
  databaseViewMutationErrorMessage: (error: unknown) => String(error),
}));

vi.mock("../workbench-canvas-stage-panel", () => ({
  WorkbenchCanvasStagePanel: (props: Record<string, unknown>) => {
    (
      globalThis as {
        __lastWorkbenchCanvasStagePanelProps?: Record<string, unknown>;
      }
    ).__lastWorkbenchCanvasStagePanelProps = props;
    return createElement("div", {
      "data-testid": "workbench-canvas-stage-panel",
    });
  },
}));

vi.mock("../workbench-database-view-surface", () => ({
  WorkbenchDatabaseViewSurface: (props: Record<string, unknown>) => {
    (
      globalThis as {
        __lastWorkbenchDatabaseViewSurfaceProps?: Record<string, unknown>;
      }
    ).__lastWorkbenchDatabaseViewSurfaceProps = props;
    useEffect(() => {
      const publish = props.onPresentationChange as
        | ((value: { databaseName: string; viewName: string }) => void)
        | undefined;
      publish?.({ databaseName: "Tasks", viewName: "Board" });
    }, [props.onPresentationChange]);
    return createElement("div", {
      "data-testid": "workbench-database-view-surface",
    });
  },
}));

vi.mock("../workbench-db-view-panel", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../workbench-db-view-panel")>();
  return {
    ...actual,
    DbViewSessionTab: (props: ComponentProps<typeof actual.DbViewSessionTab>) => {
      (
        globalThis as {
          __lastDbViewSessionTabProps?: Record<string, unknown>;
        }
      ).__lastDbViewSessionTabProps = props as unknown as Record<string, unknown>;
      return createElement(actual.DbViewSessionTab, props);
    },
  };
});

export const MockOwnedBlockDocumentBoundary = ({
  accessContext,
  ownerBlockId,
  dependencies,
  children,
}: {
  accessContext: { kind: "library" } | { kind: "project"; projectId: string };
  ownerBlockId: string;
  dependencies?: {
    fetchDescriptor?: (
      accessContext: { kind: "library" } | { kind: "project"; projectId: string },
      ownerBlockId: string,
    ) => Promise<Record<string, unknown>>;
  };
  children: (
    model: Record<string, unknown>,
    controls: { reload: () => Promise<void> },
  ) => ReactNode;
}) => {
  const fetchDescriptor = dependencies?.fetchDescriptor;
  const [model, setModel] = useState<Record<string, unknown>>(() => {
    if (fetchDescriptor) {
      return { status: "loading", accessContext, ownerBlockId };
    }
    return {
      status: "ready",
      accessContext,
      ownerBlockId,
      descriptor: {
        libraryId: "library-test",
        accessContext,
        ownerBlockId,
        ownerType: "page",
        ownerLifecycle: "active",
        documentId: `document:${ownerBlockId}`,
        authorization: null,
        storeEpoch: "workbench-test-store",
        generation: 1,
        headSeq: 1,
        schemaKey: "nodex.page",
        schemaVersion: PAGE_DOCUMENT_SCHEMA_VERSION,
        readiness: "ready",
        sync: { kind: "yjs", stateVector: new Uint8Array([0]) },
      },
    };
  });
  const reload = useCallback(async (): Promise<void> => {
    if (!fetchDescriptor) return;
    const descriptor = await fetchDescriptor(accessContext, ownerBlockId);
    setModel({
      descriptor,
      status: "ready",
      accessContext,
      ownerBlockId,
    });
  }, [accessContext, fetchDescriptor, ownerBlockId]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return children(model, { reload });
};

vi.mock("@/components/block-documents/owned-block-document-boundary", () => ({
  OwnedBlockDocumentBoundary: MockOwnedBlockDocumentBoundary,
  RegisteredOwnedBlockDocumentBoundary: MockOwnedBlockDocumentBoundary,
}));

vi.mock(".././workbench-page-stage", () => ({
  PageStage: (props: Record<string, unknown>) => {
    const stageModel = props.page as
      | {
          page?: { id?: string; title?: string };
        }
      | null
      | undefined;
    const page = stageModel?.page;
    const pageId = page?.id ?? "missing";
    const [titleDocument] = useState(() => {
      const document = new Y.Doc();
      if (page?.title) document.getText("title").insert(0, page.title);
      return document;
    });
    const title = titleDocument.getText("title");
    const [titleRuntime] = useState(() => {
      let phase: "ready" | "saving" | "closed" = "ready";
      let headSeq = 1;
      let pendingUpdateCount = 0;
      const listeners = new Set<() => void>();
      const emit = () => listeners.forEach((listener) => listener());
      return {
        getStatus: () => ({
          phase,
          ready: phase !== "closed",
          reloadRequired: false,
          descriptor: { generation: 1 },
          provider: { generation: 1, headSeq, pendingUpdateCount },
        }),
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        commitUpdate: () => {
          phase = "saving";
          pendingUpdateCount = 1;
          emit();
          headSeq += 1;
          phase = "ready";
          pendingUpdateCount = 0;
          emit();
        },
        close: () => {
          phase = "closed";
          pendingUpdateCount = 0;
          emit();
          listeners.clear();
        },
      };
    });
    const [publishingTitle, setPublishingTitle] = useState(true);
    const publishTitle = (nextTitle: string) => {
      titleDocument.transact(() => {
        title.delete(0, title.length);
        title.insert(0, nextTitle);
      });
      titleRuntime.commitUpdate();
      setPublishingTitle(true);
    };
    const exposedProps = {
      ...props,
      __publishPageTitle: publishTitle,
      __disposePageTitlePublisher: () => setPublishingTitle(false),
    };
    (
      globalThis as {
        __lastPageStageProps?: Record<string, unknown>;
      }
    ).__lastPageStageProps = exposedProps;
    const propsByPageId = ((
      globalThis as {
        __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>>;
      }
    ).__mockPageStagePropsByPageId ??= {});
    propsByPageId[pageId] = exposedProps;
    useEffect(() => {
      const state = globalThis as {
        __mockPageStageMounts?: number;
        __mockPageStageUnmounts?: number;
        __mockPageStageMountsByPageId?: Record<string, number>;
        __mockPageStageUnmountsByPageId?: Record<string, number>;
      };
      state.__mockPageStageMounts = (state.__mockPageStageMounts ?? 0) + 1;
      state.__mockPageStageMountsByPageId = {
        ...(state.__mockPageStageMountsByPageId ?? {}),
        [pageId]: (state.__mockPageStageMountsByPageId?.[pageId] ?? 0) + 1,
      };
      return () => {
        titleRuntime.close();
        titleDocument.destroy();
        state.__mockPageStageUnmounts = (state.__mockPageStageUnmounts ?? 0) + 1;
        state.__mockPageStageUnmountsByPageId = {
          ...(state.__mockPageStageUnmountsByPageId ?? {}),
          [pageId]: (state.__mockPageStageUnmountsByPageId?.[pageId] ?? 0) + 1,
        };
      };
    }, [pageId, titleDocument, titleRuntime]);
    const content = createElement(
      "div",
      { "data-page-stage": "true" },
      `Page:${String(pageId)}`,
      createElement(
        "div",
        { className: "nfm-editor" },
        createElement("div", {
          "aria-label": `Mock editor ${String(pageId)}`,
          className: "ProseMirror",
          contentEditable: true,
          tabIndex: 0,
        }),
      ),
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "Close",
          "data-tab-preview-pin-exempt": "true",
          onClick: () => (props.onClose as (() => void) | undefined)?.(),
        },
        "Close",
      ),
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "History",
          "aria-pressed": Boolean(props.historyPanelActive),
          onClick: () => {
            const current =
              (globalThis as { __mockPageStageHistoryClicks?: number })
                .__mockPageStageHistoryClicks ?? 0;
            (globalThis as { __mockPageStageHistoryClicks?: number }).__mockPageStageHistoryClicks =
              current + 1;
            (
              props.onToggleHistoryPanel as
                | ((snapshot: { readonly title: string; readonly nfm: string }) => void)
                | undefined
            )?.({
              title: `Card ${String(pageId)}`,
              nfm: `Body ${String(pageId)}`,
            });
          },
        },
        "History",
      ),
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "Terminal",
          onClick: () => {
            (props.onOpenTerminalPanel as (() => void) | undefined)?.();
          },
        },
        "Terminal",
      ),
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "Delete",
          "data-tab-preview-pin-exempt": "true",
          onClick: () => {
            const current =
              (globalThis as { __mockPageStageDeleteClicks?: number })
                .__mockPageStageDeleteClicks ?? 0;
            (globalThis as { __mockPageStageDeleteClicks?: number }).__mockPageStageDeleteClicks =
              current + 1;
            void (props.onDelete as ((pageId: string) => Promise<void>) | undefined)?.(
              page?.id ?? "card-1",
            );
          },
        },
        "Delete",
      ),
    );
    const identity = props.pageTitleIdentity as PageTitleResourceIdentity | undefined;
    if (!identity || !publishingTitle) return content;
    return (
      <PageTitleProjectionPublisher
        identity={identity}
        publisherId={String(props.editorSessionKey ?? pageId)}
        title={title}
        runtime={titleRuntime}
      >
        {content}
      </PageTitleProjectionPublisher>
    );
  },
}));

vi.mock(".././plan-side-panel-tab", () => ({
  PlanSidePanelTab: (props: { content: string }) =>
    createElement("div", { "data-plan-side-panel-tab": "true" }, props.content),
}));

vi.mock(".././workbench-history-panel", () => ({
  HistoryPanel: (props: Record<string, unknown>) => {
    (globalThis as { __lastHistoryPanelProps?: Record<string, unknown> }).__lastHistoryPanelProps =
      props;
    if (!props.open) return null;
    return createElement(
      "div",
      {
        "data-testid": "page-history-panel",
        "data-project-id": String(props.projectId),
        "data-uuid-v7": String(props.pageId),
      },
      "History panel",
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "Close history panel",
          onClick: () => (props.onClose as (() => void) | undefined)?.(),
        },
        "Close",
      ),
      createElement(
        "button",
        {
          type: "button",
          "aria-label": "Mutate card from history",
          onClick: () => (props.onPageMutated as (() => void) | undefined)?.(),
        },
        "Mutate",
      ),
    );
  },
}));

vi.mock(".././workbench-terminal-panel", () => ({
  TerminalPanel: (props: Record<string, unknown>) => {
    (
      globalThis as { __lastTerminalPanelProps?: Record<string, unknown> }
    ).__lastTerminalPanelProps = props;
    return createElement(
      "div",
      { "data-terminal-panel": "true" },
      `Terminal:${String(props.terminalId)}`,
    );
  },
}));

vi.mock("@/features/local-conversation", () => ({
  useDefaultCodexAppServerManager: () => ({
    readProjectThreadSummaries: () => [],
    loadThreads: async () => [],
  }),
  ThreadSummaryPanelHeaderAction: (props: {
    mode: "hidden" | "pinned" | "popover";
    onPopoverOpenChange?: (open: boolean) => void;
    pinnedOpen: boolean;
    onPinnedOpenToggle?: () => void;
    popoverOpen?: boolean;
  }) => {
    if (props.mode === "hidden") return null;
    return createElement(
      "button",
      {
        type: "button",
        "aria-label": props.mode === "popover" ? "Toggle summary" : "Toggle pinned summary",
        "aria-pressed":
          props.mode === "pinned" ? props.pinnedOpen : String(Boolean(props.popoverOpen)),
        "data-testid": "mock-summary-action",
        onClick:
          props.mode === "pinned"
            ? props.onPinnedOpenToggle
            : () => props.onPopoverOpenChange?.(!props.popoverOpen),
      },
      "Summary",
    );
  },
  ThreadSummaryPanelToggle: (props: { label?: string; pressed: boolean; onClick: () => void }) =>
    createElement(
      "button",
      {
        type: "button",
        "aria-label": props.label ?? "Toggle pinned summary",
        "aria-pressed": props.pressed,
        onClick: props.onClick,
      },
      "Summary",
    ),
  ConnectedThreadStage: (props: Record<string, unknown>) => {
    (
      globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> }
    ).__lastConnectedThreadStageProps = props;
    const propsByThreadId = ((
      globalThis as {
        __mockConnectedThreadStagePropsByThreadId?: Record<string, Record<string, unknown>>;
      }
    ).__mockConnectedThreadStagePropsByThreadId ??= {});
    const activeThreadId = typeof props.activeThreadId === "string" ? props.activeThreadId : null;
    if (activeThreadId) {
      propsByThreadId[activeThreadId] = props;
    }
    const summary = props.activeThreadSummary as
      | { threadName?: string | null; threadPreview?: string | null }
      | null
      | undefined;
    const threadTitle =
      summary?.threadName ??
      summary?.threadPreview ??
      (props.isNewThreadTab ? "New thread" : "No thread");
    const [mockPrompt, setMockPrompt] = useState("");
    const headerContent = createElement(
      "div",
      {
        className:
          "draggable grid w-full min-w-0 grid-cols-[minmax(0,1fr)] items-center gap-x-4 electron:h-toolbar extension:py-row-y",
      },
      createElement(
        "div",
        { className: "flex min-w-0 items-center gap-2 truncate text-base electron:font-medium" },
        createElement(
          "span",
          {
            "data-testid": "thread-stage-title",
            className:
              "inline-flex max-w-[320px] min-w-[2ch] items-center overflow-hidden text-token-foreground",
          },
          createElement("span", { className: "min-w-0 truncate" }, threadTitle),
        ),
      ),
    );
    const actions = props.actions as
      | {
          onOpenSummaryGitReview?: (input: { source: GitReviewSource }) => void | Promise<void>;
          onStartThreadForSession?: (input: {
            projectId: string;
            sessionId: string;
            prompt: string;
            runInTarget?: string;
            runInEnvironmentPath?: string | null;
            worktreeStartingState?: CodexPendingWorktreeStartingState;
          }) => Promise<void>;
          onConsumeNewThreadComposerIntent?: (sessionId: string, focusNonce: number) => void;
        }
      | undefined;
    const target = props.newThreadTarget as
      | {
          projectId?: string;
          sessionId?: string;
          runInTarget?: string;
          runInEnvironmentPath?: string | null;
          worktreeStartingState?: CodexPendingWorktreeStartingState;
        }
      | null
      | undefined;
    const composerIntent = props.newThreadComposerIntent as
      | {
          prompt?: string;
          focusNonce?: number;
        }
      | null
      | undefined;
    useEffect(() => {
      if (!props.isNewThreadTab || !target?.sessionId || !composerIntent?.prompt) return;
      setMockPrompt(composerIntent.prompt);
      if (typeof composerIntent.focusNonce === "number") {
        actions?.onConsumeNewThreadComposerIntent?.(target.sessionId, composerIntent.focusNonce);
      }
    }, [
      actions,
      composerIntent?.focusNonce,
      composerIntent?.prompt,
      props.isNewThreadTab,
      target?.sessionId,
    ]);
    return createElement(
      Fragment,
      null,
      props.backgroundAgentDetail === true || props.sideChatContext
        ? null
        : createElement(AppShellHeaderContentRegistrar, { content: headerContent }),
      createElement(
        "div",
        { "data-thread-stage": "true" },
        createElement("span", null, `Thread:${String(props.activeThreadId)}`),
        props.isNewThreadTab
          ? createElement("textarea", {
              "aria-label": "Prompt",
              placeholder: "Write the first prompt for this new thread...",
              readOnly: true,
              value: mockPrompt,
            })
          : null,
        props.isNewThreadTab
          ? createElement(
              "button",
              {
                type: "button",
                onClick: () => {
                  if (!target?.projectId || !target.sessionId) return;
                  void actions?.onStartThreadForSession?.({
                    projectId: target.projectId,
                    sessionId: target.sessionId,
                    prompt: "Start from session",
                    runInTarget: target.runInTarget,
                    runInEnvironmentPath: target.runInEnvironmentPath,
                    worktreeStartingState: target.worktreeStartingState,
                  });
                },
              },
              "Send",
            )
          : null,
        props.isNewThreadTab
          ? null
          : createElement(
              "button",
              {
                type: "button",
                onClick: () => {
                  void actions?.onOpenSummaryGitReview?.({ source: "staged" });
                },
              },
              "Open staged changes",
            ),
        createElement("span", null, String(props.selectedModel)),
        createElement("span", null, String(props.selectedReasoningEffort)),
        createElement(
          "span",
          {
            "data-summary-panel-hide-immediately": String(props.summaryPanelHideImmediately),
            "data-summary-panel-mounted": String(props.summaryPanelMounted),
            "data-summary-panel-open": String(props.summaryPanelOpen),
          },
          String(props.summaryPanelMounted),
        ),
      ),
    );
  },
  ConnectedThreadComposerDock: (props: Record<string, unknown>) => {
    (
      globalThis as {
        __lastConnectedThreadComposerDockProps?: Record<string, unknown>;
      }
    ).__lastConnectedThreadComposerDockProps = props;
    const actions = props.actions as
      | {
          onStartThreadForSession?: (input: {
            projectId: string;
            sessionId: string;
            projectDraftId?: string;
            prompt: string;
          }) => Promise<void>;
        }
      | undefined;
    const target = props.newThreadTarget as
      | {
          projectId?: string;
          sessionId?: string;
          projectDraftId?: string;
        }
      | null
      | undefined;
    const visibility = props.overlayVisibility as
      | {
          kind?: string;
          visible?: boolean;
          onVisibleChange?: (visible: boolean) => void;
        }
      | undefined;
    return createElement(
      "div",
      { "data-project-agent-dock": "true" },
      props.leadingContent as ReactNode,
      createElement("textarea", {
        "aria-label": "Project Agent Dock prompt",
        defaultValue: "",
      }),
      props.isNewThreadTab
        ? createElement(
            "button",
            {
              type: "button",
              onClick: () => {
                if (!target?.projectId || !target.sessionId) return;
                void actions?.onStartThreadForSession?.({
                  projectId: target.projectId,
                  sessionId: target.sessionId,
                  ...(target.projectDraftId ? { projectDraftId: target.projectDraftId } : {}),
                  prompt: "Start from Project Agent Dock",
                });
              },
            },
            "Send from Dock",
          )
        : null,
      visibility?.kind === "controlled" && visibility.visible
        ? createElement(
            "button",
            {
              type: "button",
              onClick: () => visibility.onVisibleChange?.(false),
            },
            "Hide Dock",
          )
        : null,
    );
  },
  ConnectedReviewDiffPanel: (props: Record<string, unknown>) => {
    (
      globalThis as { __lastConnectedReviewDiffPanelProps?: Record<string, unknown> }
    ).__lastConnectedReviewDiffPanelProps = props;
    return createElement(
      "div",
      { "data-review-diff-panel": "true" },
      `Review:${String(props.threadId)}`,
    );
  },
  useCodexAppServerControl: () => mockCodexControl,
  useCodexAppServerRegistry: () => ({
    getForHostId: () => ({
      readConversation: () => null,
      startTurn: async () => undefined,
      respondApproval: async () => false,
    }),
  }),
  useConversation: (threadId: string | null) =>
    threadId ? (sideChatConversations[threadId] ?? null) : null,
  useConversationSubset: (threadIds: readonly string[]) =>
    Object.fromEntries(
      threadIds.flatMap((threadId) =>
        sideChatConversations[threadId] ? [[threadId, sideChatConversations[threadId]]] : [],
      ),
    ),
  useCodexConversationValue: (
    threadId: string | null,
    selector: (conversation: { turns: readonly unknown[] } | null) => unknown,
  ) => selector(threadId ? { turns: mockConversationHasVisibleTurn ? [{}] : [] } : null),
  useCodexThreadStartProgress: () => mockThreadStartProgress,
  useLocalConversationAccount: () => null,
  useLocalConversationConnection: () => ({ status: "connected", retries: 0 }),
}));

vi.mock("@/lib/use-board", () => ({
  useBoard: (options?: { projectId?: string; databaseViewId?: string }) => {
    const projectId = options?.projectId ?? "alpha";
    const cards =
      projectId === "beta"
        ? {
            id: "card-beta",
            projectId: "beta",
            status: "build",
            title: "Beta Card",
            description: "",
            tags: [],
            archived: false,
          }
        : [
            {
              id: "card-1",
              projectId: "alpha",
              status: "build",
              title: "Card One",
              description: "",
              tags: [],
              archived: false,
            },
            {
              id: "card-2",
              projectId: "alpha",
              status: "build",
              title: "Card Two",
              description: "",
              tags: [],
              archived: false,
            },
          ];
    const visibleCards = Array.isArray(cards) ? cards : [cards];
    const databaseViewId = options?.databaseViewId ?? `view-${projectId}-primary`;
    const isListView = databaseViewId === `database-view:${projectId}:primary-list`;
    const viewLayout = isListView ? "list" : "board";
    const viewName = isListView ? "List" : "Board";
    const timestamp = "2026-08-11T00:00:00.000Z";
    const rows = visibleCards.map((card, index) => ({
      pageId: card.id,
      groupKey: "build",
      subgroupKey: null,
      title: card.title,
      preview: "",
      plainText: "",
      status: card.status,
      tags: card.tags,
      metadataRevision: 1,
      createdAt: new Date(timestamp),
      rankKey: String(index + 1),
    }));
    const databaseView = {
      accessContext: { kind: "project", projectId },
      libraryId: "library-test",
      databaseViewId,
      databaseId: `database-${projectId}`,
      dataSourceId: `source-${projectId}`,
      databaseName: "Tasks",
      dataSourceName: "Tasks",
      viewName,
      storeEpoch: "store-test",
      commitSeq: 1,
      authorization: null,
      readOnlyReason: null,
      columns: [
        {
          id: "build",
          groupKey: "build",
          name: "Build",
          scopeKey: 'key:"build"',
          rows,
        },
      ],
      query: {
        database: {
          databaseId: `database-${projectId}`,
          libraryId: "library-test",
          name: "Tasks",
          lifecycle: "active",
          defaultViewId: databaseViewId,
          accessRevision: 1,
          metadataRevision: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        dataSource: {
          dataSourceId: `source-${projectId}`,
          libraryId: "library-test",
          homeDatabaseId: `database-${projectId}`,
          name: "Tasks",
          schemaKey: "nodex.pages",
          schemaRevision: 1,
          lifecycle: "active",
          rankKey: "a",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        view: {
          viewId: databaseViewId,
          databaseId: `database-${projectId}`,
          dataSourceId: `source-${projectId}`,
          name: viewName,
          layout: viewLayout,
          config: databaseViewConfigFixture({
            sorts: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
          }),
          isDefault: true,
          revision: 1,
          rankKey: "a",
          lifecycle: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        properties: [],
        rows: [],
      },
    };
    return {
      databaseView,
      board: {
        columns: [
          {
            id: "build",
            name: "Build",
            cards: visibleCards,
          },
        ],
      },
      pageIndex: new Map(visibleCards.map((card) => [card.id, card])),
      loading: false,
      error: null,
      groupPagination: new Map(),
      setPresentationOverride: () => undefined,
      loadMoreGroup: async () => undefined,
      refresh: async () => undefined,
      patchPage: () => undefined,
      updatePage: async () => ({ didMutate: true }),
      deletePage: async () => true,
      completeOccurrence: async () => undefined,
      skipOccurrence: async () => undefined,
    };
  },
}));

export type MockCommandPaletteProps = {
  open: boolean;
  initialMode?: string;
  initialQuery?: string;
  commandContext: Omit<CommandPaletteShellCommandContext, "isMac" | "showMockCommands">;
  commandHandlers: CommandPaletteShellCommandHandlers;
  onOpenChange: (open: boolean) => void;
};

vi.mock(".././command-palette", () => ({
  CommandPalette: (props: MockCommandPaletteProps) => {
    if (!props.open) return null;
    const rawQuery = props.initialQuery ?? "";
    const commandMode = props.initialMode === "root";
    const commandQuery = commandMode ? rawQuery.trim().toLowerCase() : "";
    const commands = commandMode
      ? buildCommandPaletteCommands({
          ...props.commandContext,
          isMac: true,
          showMockCommands: false,
        })
          .filter((command) => {
            if (commandQuery.length === 0) return true;
            const haystack = [command.title, command.subtitle, ...command.keywords]
              .join(" ")
              .toLowerCase();
            return haystack.includes(commandQuery);
          })
          .slice(0, 100)
      : [];

    return createElement(
      "div",
      null,
      createElement("input", {
        "aria-label": "Command palette search",
        readOnly: true,
        value: props.initialMode ?? "root",
      }),
      ...commands.map((command) =>
        createElement(
          "button",
          {
            key: command.id,
            type: "button",
            disabled: command.disabled,
            onClick: () => {
              if (command.disabled) return;
              if (!isCommandPaletteShellCommandId(command.id)) return;
              executeCommandPaletteShellCommand(command.id, props.commandHandlers);
              props.onOpenChange(false);
            },
          },
          command.title,
        ),
      ),
      createElement(
        "button",
        {
          type: "button",
          onClick: () => props.onOpenChange(false),
        },
        "Close palette",
      ),
    );
  },
}));

export let WorkbenchShell: (typeof import(".././workbench-runtime"))["WorkbenchRuntime"];

beforeAll(async () => {
  const workbenchRuntimeModule = await import(".././workbench-runtime");
  WorkbenchShell = workbenchRuntimeModule.WorkbenchRuntime;
}, 120_000);

export function getPanelTabById(container: HTMLElement, tabId: string): HTMLElement {
  const tabShell = Array.from(container.querySelectorAll<HTMLElement>("[data-panel-tab-id]")).find(
    (element) => element.dataset.panelTabId === tabId,
  );
  const tab = tabShell?.querySelector<HTMLElement>('[role="tab"]') ?? null;
  if (!tab) throw new Error(`Expected panel tab ${tabId}`);
  return tab;
}

export function getPanelTabChromeById(container: HTMLElement, tabId: string): HTMLElement {
  const tabShell = Array.from(container.querySelectorAll<HTMLElement>("[data-panel-tab-id]")).find(
    (element) => element.dataset.panelTabId === tabId,
  );
  const tabChrome = tabShell?.querySelector<HTMLElement>("[data-tab-id]") ?? null;
  if (!tabChrome) throw new Error(`Expected panel tab chrome ${tabId}`);
  return tabChrome;
}

export function getWorkbenchPanelActivateCalls(): {
  sessionId?: string;
  panelId?: WorkbenchTabProjection["panelId"];
  leafId?: string;
  tabId?: string | null;
}[] {
  return invokeCalls.flatMap((call) => {
    if (call[0] !== "window-session-view:panel-activate") return [];
    return [
      call[1] as {
        sessionId?: string;
        panelId?: WorkbenchTabProjection["panelId"];
        leafId?: string;
        tabId?: string | null;
      },
    ];
  });
}

export function getWorkbenchTabProjectionDeleteTabIds(): string[] {
  return invokeCalls.flatMap((call) => {
    if (call[0] !== "window-session-view:tab-remove") return [];
    const input = call[1] as string | { tabId?: string };
    if (typeof input === "string") return [input];
    return input.tabId ? [input.tabId] : [];
  });
}

export function getWorkbenchTabDeleteInputs(): Array<
  | string
  | {
      tabId?: string;
      preferredActiveLeafId?: string | null;
      preferredActiveTabId?: string | null;
    }
> {
  return invokeCalls.flatMap((call) => {
    if (call[0] !== "window-session-view:tab-remove") return [];
    return [
      call[1] as
        | string
        | {
            tabId?: string;
            preferredActiveLeafId?: string | null;
            preferredActiveTabId?: string | null;
          },
    ];
  });
}

export function recordSessionViewMutation(
  previous: WorkbenchSessionViewSnapshot | undefined,
  next: WorkbenchSessionViewSnapshot,
): void {
  if (!previous) return;
  const placement = (
    view: WorkbenchSessionViewSnapshot,
    tabId: string,
  ): { panelId: "right" | "bottom"; leafId: string; index: number } | null => {
    for (const panelId of ["right", "bottom"] as const) {
      const leaf = findWorkbenchPanelLeafForTab(view.panels[panelId].layout, tabId);
      if (!leaf) continue;
      return { panelId, leafId: leaf.id, index: leaf.tabIds.indexOf(tabId) };
    }
    return null;
  };
  const previousTabIds = new Set(Object.keys(previous.tabsById));
  const nextTabIds = new Set(Object.keys(next.tabsById));

  for (const tabId of nextTabIds) {
    const tab = next.tabsById[tabId]!;
    const nextPlacement = placement(next, tabId);
    if (!previousTabIds.has(tabId)) {
      invokeCalls.push([
        "window-session-view:tab-create",
        {
          sessionId: next.sessionId,
          panelId: nextPlacement?.panelId ?? "right",
          targetLeafId: nextPlacement?.leafId,
          clientTabId: tab.id,
          kind: tab.kind,
          title: tab.titleSnapshot,
          config:
            tab.kind === "browser"
              ? {
                  projectId: null,
                  ...tab.config,
                  browserTabId: undefined,
                }
              : tab.config,
          ...(tab.kind === "browser" ? { browserTabId: tab.config.browserTabId } : {}),
        },
      ]);
      continue;
    }
    const previousTab = previous.tabsById[tabId]!;
    if (JSON.stringify(previousTab) !== JSON.stringify(tab)) {
      invokeCalls.push([
        "window-session-view:tab-update",
        tabId,
        {
          ...(previousTab.titleSnapshot === tab.titleSnapshot ? {} : { title: tab.titleSnapshot }),
          ...(JSON.stringify(previousTab.config) === JSON.stringify(tab.config)
            ? {}
            : { config: tab.config }),
          ...(previousTab.stateKey === tab.stateKey ? {} : { stateKey: tab.stateKey }),
          ...(JSON.stringify(previousTab.state) === JSON.stringify(tab.state)
            ? {}
            : { state: tab.state }),
        },
      ]);
    }
    const previousPlacement = placement(previous, tabId);
    if (
      previousPlacement &&
      nextPlacement &&
      JSON.stringify(previousPlacement) !== JSON.stringify(nextPlacement)
    ) {
      invokeCalls.push([
        "window-session-view:tab-move",
        {
          tabId,
          targetPanelId: nextPlacement.panelId,
          targetLeafId: nextPlacement.leafId,
          targetIndex: nextPlacement.index,
        },
      ]);
    }
  }

  for (const tabId of previousTabIds) {
    if (nextTabIds.has(tabId)) continue;
    const previousPlacement = placement(previous, tabId);
    const panelId = previousPlacement?.panelId ?? "right";
    const activeLeafId = next.panels[panelId].layout.activeLeafId;
    const activeLeaf = listWorkbenchPanelLeaves(next.panels[panelId].layout).find(
      (leaf) => leaf.id === activeLeafId,
    );
    invokeCalls.push([
      "window-session-view:tab-remove",
      {
        tabId,
        preferredActiveLeafId: activeLeafId,
        preferredActiveTabId: activeLeaf?.activeTabId ?? null,
      },
    ]);
  }

  for (const panelId of ["right", "bottom"] as const) {
    const previousPanel = previous.panels[panelId];
    const nextPanel = next.panels[panelId];
    const panelPatch = {
      ...(previousPanel.collapsed === nextPanel.collapsed
        ? {}
        : { collapsed: nextPanel.collapsed }),
      ...(JSON.stringify(previousPanel.size) === JSON.stringify(nextPanel.size)
        ? {}
        : { size: nextPanel.size }),
    };
    if (Object.keys(panelPatch).length > 0) {
      invokeCalls.push(["window-session-view:panel-patch", next.sessionId, panelId, panelPatch]);
    }

    const previousLeaves = listWorkbenchPanelLeaves(previousPanel.layout);
    const nextLeaves = listWorkbenchPanelLeaves(nextPanel.layout);
    for (const nextLeaf of nextLeaves) {
      const previousLeaf = previousLeaves.find((leaf) => leaf.id === nextLeaf.id);
      if (!previousLeaf) continue;
      if (JSON.stringify(previousLeaf.tabIds) === JSON.stringify(nextLeaf.tabIds)) continue;
      if (
        previousLeaf.tabIds.length !== nextLeaf.tabIds.length ||
        previousLeaf.tabIds.some((tabId) => !nextLeaf.tabIds.includes(tabId))
      ) {
        continue;
      }
      invokeCalls.push([
        "window-session-view:tab-reorder",
        {
          sessionId: next.sessionId,
          panelId,
          leafId: nextLeaf.id,
          orderedTabIds: nextLeaf.tabIds,
        },
      ]);
    }
    if (nextLeaves.length > previousLeaves.length) {
      invokeCalls.push([
        "window-session-view:ensure-right-leaf",
        {
          sessionId: next.sessionId,
          panelId,
          sourceLeafId: previousPanel.layout.activeLeafId,
        },
      ]);
    }
    const nextActiveLeaf = nextLeaves.find((leaf) => leaf.id === nextPanel.layout.activeLeafId);
    const previousActiveLeaf = previousLeaves.find(
      (leaf) => leaf.id === previousPanel.layout.activeLeafId,
    );
    if (
      previousPanel.layout.activeLeafId !== nextPanel.layout.activeLeafId ||
      previousActiveLeaf?.activeTabId !== nextActiveLeaf?.activeTabId ||
      previous.lastFocusedPanelId !== next.lastFocusedPanelId
    ) {
      invokeCalls.push([
        "window-session-view:panel-activate",
        {
          sessionId: next.sessionId,
          panelId,
          leafId: nextPanel.layout.activeLeafId,
          tabId: nextActiveLeaf?.activeTabId ?? null,
        },
      ]);
    }
  }
}

export function getThreadRow(container: HTMLElement, title: string): HTMLElement {
  const row = container.querySelector(`[data-app-action-sidebar-thread-title="${title}"]`);
  if (!(row instanceof HTMLElement)) {
    throw new Error(`Expected thread row ${title}`);
  }
  return row;
}

export function getSidebarSection(container: HTMLElement, heading: string): HTMLElement {
  const section = container.querySelector(`[data-app-action-sidebar-section-heading="${heading}"]`);
  if (!(section instanceof HTMLElement)) {
    throw new Error(`Expected sidebar section ${heading}`);
  }
  return section;
}

export function getSidebarProjectGroup(section: HTMLElement, projectId: string): HTMLElement {
  const row = section.querySelector(`[data-app-action-sidebar-project-id="${projectId}"]`);
  const group = row?.closest('[role="listitem"]');
  if (!(group instanceof HTMLElement)) {
    throw new Error(`Expected sidebar project group ${projectId}`);
  }
  return group;
}

export function getThreadRowTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("[data-app-action-sidebar-thread-row]")).map(
    (row) => row.getAttribute("data-app-action-sidebar-thread-title") ?? "",
  );
}

export function getBottomPanelContentSizer(container: HTMLElement): HTMLElement {
  const sizer = Array.from(container.querySelectorAll<HTMLElement>('[style*="min-height"]')).find(
    (element) => element.getAttribute("style")?.includes("height:"),
  );
  if (!sizer) throw new Error("Expected bottom panel content sizer");
  return sizer;
}

export function appendMockNfmEditor(container: HTMLElement): {
  root: HTMLElement;
  content: HTMLElement;
} {
  const root = document.createElement("div");
  root.className = "nfm-editor";
  const content = document.createElement("div");
  content.contentEditable = "true";
  content.className = "ProseMirror";
  root.appendChild(content);
  container.appendChild(root);
  return { root, content };
}

function installMotionPreferenceMatchMediaForTest(
  reducedMotion: boolean,
  options: { readonly skipAnimations?: boolean } = {},
) {
  const restoreMatchMedia = installMotionPreferenceForTest(reducedMotion, options);
  initPrefersReducedMotion();

  return () => {
    restoreMatchMedia();
    initPrefersReducedMotion();
  };
}

export function installReducedMotionMatchMediaForTest() {
  return installMotionPreferenceMatchMediaForTest(true);
}

export function installMotionEnabledMatchMediaForTest() {
  return installMotionPreferenceMatchMediaForTest(false);
}

export function installInstantMotionMatchMediaForTest() {
  return installMotionPreferenceMatchMediaForTest(false, { skipAnimations: true });
}

let restoreDefaultInstantMotion: (() => void) | null = null;

export function renderWorkbench({
  projects = [makeProject()],
  sessionsByProject = { alpha: [makeSession()] },
  projectlessSessions = [],
  sidebarSnapshotItems = [],
  sidebarSyncChangedProjectIds = [],
  sidebarSyncProjectlessChanged = false,
  searchByProject = {},
  sidebar,
  initialSelectedSessionId,
  workbenchCommandRequest = null,
  pendingViewDeepLinkOpen = null,
  onNavigationStateChange,
  cardGetOverride = null,
  ownershipPathsByPage = {},
  scheduledAutomations = [],
  automationInboxItems = [],
  worktreeEnvironmentOptionsByProject = {},
  codexModels = DEFAULT_TEST_CODEX_MODELS,
  pendingWorktrees = [],
  libraryRoots = [],
  defaultDraftSessionIdsByScope = {},
  initialWindowLayoutSnapshot,
}: {
  projects?: Project[];
  sessionsByProject?: Record<string, ProjectSession[]>;
  projectlessSessions?: ProjectSession[];
  sidebarSnapshotItems?: CodexSidebarThreadItem[];
  sidebarSyncChangedProjectIds?: string[];
  sidebarSyncProjectlessChanged?: boolean;
  searchByProject?: Record<string, string>;
  sidebar?: {
    collapsed: boolean;
    width: number;
    collapsibleSections?: SidebarCollapsibleSectionsState;
  };
  initialSelectedSessionId?: string | null;
  workbenchCommandRequest?: WorkbenchCommandRequest | null;
  pendingViewDeepLinkOpen?: ComponentProps<typeof WorkbenchShell>["pendingViewDeepLinkOpen"];
  onNavigationStateChange?: ComponentProps<typeof WorkbenchShell>["onNavigationStateChange"];
  cardGetOverride?: ((projectId: string, pageId: string) => Promise<unknown> | unknown) | null;
  ownershipPathsByPage?: Record<
    string,
    ReadonlyArray<{
      pageId: string;
      title: string;
      lifecycle: "active" | "archived";
    }>
  >;
  scheduledAutomations?: CodexScheduledAutomation[];
  automationInboxItems?: CodexAutomationInboxItem[];
  worktreeEnvironmentOptionsByProject?: Record<string, WorktreeEnvironmentOption[]>;
  codexModels?: CodexModelOption[];
  pendingWorktrees?: readonly CodexPendingWorktreeEntry[];
  libraryRoots?: readonly LibraryNavigationNode[];
  defaultDraftSessionIdsByScope?: Readonly<Record<string, string>>;
  initialWindowLayoutSnapshot?: WorkbenchLayoutSnapshot;
} = {}) {
  const resolvedInitialSelectedSessionId =
    initialSelectedSessionId === undefined
      ? (Object.values(sessionsByProject).flat()[0]?.id ?? projectlessSessions[0]?.id ?? null)
      : initialSelectedSessionId;
  const asPageDetailResult = (value: unknown, projectId: string, pageId: string): unknown => {
    if (value instanceof Promise) {
      return value.then((resolved) => asPageDetailResult(resolved, projectId, pageId));
    }
    if (value && typeof value === "object" && "ok" in value) {
      return value;
    }
    if (!value) {
      return {
        ok: false,
        error: {
          code: "page_not_found",
          message: `Page not found: ${pageId}`,
          retryable: false,
        },
      };
    }
    const row = value as Record<string, unknown>;
    const standalone = row.standalone === true;
    const result = buildPageDetailStoryResult(
      projectId,
      {
        id: pageId,
        pageKey: typeof row.pageKey === "string" ? row.pageKey : null,
        status: (typeof row.status === "string" ? row.status : "triage") as "triage",
        archived: false,
        title: typeof row.title === "string" ? row.title : pageId,
        richTitle: [],
        description: typeof row.description === "string" ? row.description : "",
        priority: row.priority as never,
        estimate: row.estimate as never,
        tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
        dueDate: row.dueDate instanceof Date ? row.dueDate : undefined,
        scheduledStart: row.scheduledStart instanceof Date ? row.scheduledStart : undefined,
        scheduledEnd: row.scheduledEnd instanceof Date ? row.scheduledEnd : undefined,
        isAllDay: Boolean(row.isAllDay),
        recurrence: row.recurrence as never,
        reminders: Array.isArray(row.reminders) ? (row.reminders as never) : [],
        scheduleTimezone: row.scheduleTimezone as string | undefined,
        assignee: row.assignee as string | undefined,
        runInTarget: row.runInTarget as never,
        runInLocalPath: row.runInLocalPath as string | undefined,
        runInBaseBranch: row.runInBaseBranch as string | undefined,
        runInWorktreePath: row.runInWorktreePath as string | undefined,
        runInEnvironmentPath: row.runInEnvironmentPath as string | undefined,
        revision: typeof row.revision === "number" ? row.revision : 1,
        created: row.created instanceof Date ? row.created : new Date("2026-06-07T00:00:00.000Z"),
        order: 0,
      },
      {
        libraryId: "library:test",
        storeEpoch: "epoch:test",
      },
    );
    if (!standalone || !result.ok) return result;
    return {
      ...result,
      value: {
        ...result.value,
        page: {
          ...result.value.page,
          parent: {
            kind: "library" as const,
            libraryId: result.value.libraryId,
          },
        },
        dataSourceContext: { kind: "standalone" as const },
      },
    };
  };
  const projectlessSessionStateKey = "__projectless__";
  let projectState = projects;
  let sessionState =
    projectlessSessions.length > 0
      ? { ...sessionsByProject, [projectlessSessionStateKey]: projectlessSessions }
      : sessionsByProject;
  const defaultDraftSessionIds = new Map(Object.entries(defaultDraftSessionIdsByScope));
  const createdSessionCountsByScope = new Map<string, number>();
  const createMockSession = (input: {
    projectId: string | null;
    noThreadFallbackTitle?: string;
  }): ProjectSession => {
    const sessionStateKey = input.projectId ?? projectlessSessionStateKey;
    const existingSessions = sessionState[sessionStateKey] ?? [];
    const shiftedSessions = existingSessions.map((session) =>
      session.order >= 0 ? { ...session, order: session.order + 1 } : session,
    );
    const createdSessionSequence = (createdSessionCountsByScope.get(sessionStateKey) ?? 0) + 1;
    createdSessionCountsByScope.set(sessionStateKey, createdSessionSequence);
    const createdIdBase = `session:${input.projectId ?? "projectless"}:created`;
    const session = makeSession({
      id:
        createdSessionSequence === 1 ? createdIdBase : `${createdIdBase}:${createdSessionSequence}`,
      projectId: input.projectId,
      noThreadFallbackTitle: input.noThreadFallbackTitle ?? "New chat",
      displayTitle: input.noThreadFallbackTitle ?? "New chat",
      order: 0,
      thread: null,
      tabs: [],
      panels: makePanels({ rightCollapsed: true }),
    });
    sessionState = {
      ...sessionState,
      [sessionStateKey]: sortProjectSessionsForTest([...shiftedSessions, session]),
    };
    return session;
  };
  let sidebarItemState = sidebarSnapshotItems;
  const runNowAutomationIds: string[] = [];
  const buildSidebarSnapshot = () => ({
    items: sidebarItemState,
    pinnedThreadIds: sidebarItemState.filter((item) => item.pinned).map((item) => item.threadId),
    projectAssignments: Object.fromEntries(
      sidebarItemState
        .filter(
          (item): item is CodexSidebarThreadItem & { projectId: string } =>
            typeof item.projectId === "string",
        )
        .map((item) => [item.threadId, item.projectId]),
    ),
    projectlessThreadIds: sidebarItemState
      .filter((item) => item.projectless)
      .map((item) => item.threadId),
    generatedAt: 1,
  });
  mockInvokeImpl = async (channel, ...args) => {
    if (channel === "library-module:read") {
      const request = args[1] as {
        readonly read?: {
          readonly mode?: string;
          readonly target?: {
            readonly kind?: string;
            readonly pageId?: string;
            readonly databaseId?: string;
            readonly canvasId?: string;
            readonly viewId?: string;
          };
        };
      };
      const target = request.read?.target;
      const pathNode = target
        ? libraryRoots.find((node) => {
            if (target.kind === "page" && node.kind === "page") {
              return node.pageId === target.pageId;
            }
            if (target.kind === "database" && node.kind === "database") {
              return node.databaseId === target.databaseId;
            }
            if (target.kind === "canvas" && node.kind === "canvas") {
              return node.canvasId === target.canvasId;
            }
            if (target.kind === "view" && node.kind === "database") {
              return node.defaultViewId === target.viewId;
            }
            return false;
          })
        : undefined;
      const value =
        request.read?.mode === "metadata"
          ? { kind: "metadata" as const }
          : request.read?.mode === "path"
            ? {
                kind: "path" as const,
                target,
                nodes: pathNode ? [pathNode] : [],
              }
            : {
                kind: "standalone_roots" as const,
                items: libraryRoots.filter((node) => node.kind !== "view"),
                nextCursor: null,
                hasMore: false,
                total: libraryRoots.length,
              };
      return {
        ok: true,
        value: {
          version: 5,
          profileId: "profile:test",
          libraryId: "library:test",
          storeEpoch: "epoch:test",
          commitSeq: 1,
          authorization: authorizedReadStampFixture({
            deliveryAddress: { kind: "library", library_id: "library:test" },
            subject: { kind: "library", library_id: "library:test" },
            storeEpoch: "epoch:test",
            commitSeq: 1,
          }),
          value,
        },
      };
    }
    if (channel === "projects:get") {
      const projectId = String(args[0] ?? "");
      return projectState.find((project) => project.id === projectId) ?? null;
    }
    if (channel === "browser-sidebar-command") {
      return { ok: true };
    }
    if (channel === "page-ownership-path:resolve") {
      const input = args[0] as { targetPageId: string };
      return {
        status: "available",
        targetPageId: input.targetPageId,
        ancestors: ownershipPathsByPage[input.targetPageId] ?? [],
      };
    }
    if (channel === "codex:pending-worktrees:list") return pendingWorktrees;
    if (channel === "pages:search-metadata") {
      const projectIds = [...new Set((args[0] as string[] | undefined) ?? [])];
      const requestedPageIds = args[1] as string[] | undefined;
      const documents = [
        {
          pageId: "card-1",
          projectId: "alpha",
          pageKey: "ALPHA-1",
          title: "Card One",
          status: "build",
        },
        {
          pageId: "card-2",
          projectId: "alpha",
          pageKey: "ALPHA-2",
          title: "Card Two",
          status: "build",
        },
        {
          pageId: "card-beta",
          projectId: "beta",
          pageKey: "BETA-1",
          title: "Beta Card",
          status: "build",
        },
      ]
        .filter((document) => projectIds.includes(document.projectId))
        .filter((document) => !requestedPageIds || requestedPageIds.includes(document.pageId))
        .map((document) => ({
          pageId: document.pageId,
          pageKey: document.pageKey,
          title: document.title,
          preview: document.title,
          status: document.status as "build",
          priority: null,
          tags: [],
          assignee: null,
          locationLabel: `${document.projectId} / Build`,
          updatedAt: "2026-08-14T00:00:00.000Z",
          properties: [],
          authorizedProjectIds: [document.projectId],
          dataSourceIds: [`data-source:${document.projectId}`],
        }));
      const snapshot: PageSearchMetadataSnapshot = {
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: 1,
        authorization: {
          libraryId: "library:test",
          storeEpoch: "epoch:test",
          coveredCommitSeq: 1,
          projectIds,
        },
        documents,
      };
      return snapshot;
    }
    if (channel === "pages:search") {
      const input = args[1] as {
        projectIds?: string[];
        query?: string;
        limit?: number;
      };
      const results =
        input.projectIds?.includes("beta") && input.query?.toLowerCase().includes("beta")
          ? [
              {
                projectId: "beta",
                pageId: "card-beta",
                pageKey: "BETA-1",
                title: "Beta Card",
                status: "build" as const,
                priority: null,
                tags: [],
                assignee: null,
                locationLabel: "Beta / Build",
                titleParts: [],
                excerpt: "Beta Card",
                excerptParts: [],
                matches: [
                  {
                    source: "title" as const,
                    quality: "exact" as const,
                    parts: [{ text: "Beta Card", highlighted: true }],
                  },
                ],
                updatedAt: "2026-08-14T00:00:00.000Z",
              },
            ]
          : [];
      const snapshot: PageSearchSnapshot = {
        libraryId: "library:test",
        storeEpoch: "epoch:test",
        commitSeq: 1,
        results,
      };
      return snapshot;
    }
    if (channel === "project-sessions:list") {
      const projectId = args[0] === null ? projectlessSessionStateKey : String(args[0]);
      return (sessionState[projectId] ?? []).filter((session) => !session.archived);
    }
    if (channel === "workspace:tasks:list") {
      const projectId = args[0] === null ? projectlessSessionStateKey : String(args[0]);
      const input = (args[1] ?? {}) as { after?: string | null; first?: number };
      const first = input.first ?? 50;
      const offset = input.after?.startsWith("test-window:")
        ? Number(input.after.slice("test-window:".length))
        : 0;
      const summaries = (sessionState[projectId] ?? [])
        .filter((session) => !session.archived)
        .map((session) => ({
          id: session.id,
          projectId: session.projectId,
          noThreadFallbackTitle: session.noThreadFallbackTitle,
          displayTitle: session.displayTitle,
          order: session.order,
          pinned: session.pinned,
          pinnedOrder: session.pinnedOrder,
          archived: session.archived,
          archivedAt: session.archivedAt,
          unread: session.unread,
          thread: session.thread,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        }));
      const items = summaries.slice(offset, offset + first);
      const nextOffset = offset + items.length;
      const hasMore = nextOffset < summaries.length;
      return {
        items,
        nextCursor: hasMore ? `test-window:${nextOffset}` : null,
        hasMore,
        projectionRevision: 1,
      };
    }
    if (channel === "project-sessions:get") {
      const sessionId = String(args[0]);
      return (
        Object.values(sessionState)
          .flat()
          .find((session) => session.id === sessionId) ?? null
      );
    }
    if (channel === "page-chats:activity-summaries") {
      const input = (args[1] ?? args[0] ?? {}) as { pageIds?: string[] };
      return {
        summaries: (input.pageIds ?? []).map((pageId) => ({
          pageId,
          relatedCount: 0,
          workingCount: 0,
          waitingOnApprovalCount: 0,
          waitingOnUserInputCount: 0,
          errorCount: 0,
          unreadCount: 0,
          soleSessionId: null,
        })),
        projectionRevision: 1,
      };
    }
    if (channel === "page-chats:list") {
      return { items: pageChatItems, nextCursor: null, hasMore: false, projectionRevision: 1 };
    }
    if (channel === "page-chats:link" || channel === "page-chats:unlink") {
      return undefined;
    }
    if (channel === "project-sessions:reorder") {
      const projectId = args[0] === null ? projectlessSessionStateKey : String(args[0]);
      const orderedSessionIds = (args[1] as readonly string[]) ?? [];
      const current = sessionState[projectId] ?? [];
      const currentById = new Map(current.map((session) => [session.id, session] as const));
      const seen = new Set<string>();
      const ordered = orderedSessionIds.flatMap((sessionId) => {
        const session = currentById.get(sessionId);
        if (!session || seen.has(sessionId)) return [];
        seen.add(sessionId);
        return [session];
      });
      ordered.push(...current.filter((session) => !seen.has(session.id)));
      sessionState = {
        ...sessionState,
        [projectId]: ordered.map((session, order) => ({ ...session, order })),
      };
      return undefined;
    }
    if (channel === "codex:sidebar:snapshot") {
      return buildSidebarSnapshot();
    }
    if (channel === "codex:sidebar:sync") {
      return {
        snapshot: buildSidebarSnapshot(),
        source: "app-server",
        refreshed: true,
        refreshedAt: 1,
        changedProjectIds: sidebarSyncChangedProjectIds,
        projectlessChanged: sidebarSyncProjectlessChanged,
        materializedSessionIds: [],
        failedThreadIds: [],
      } satisfies CodexSidebarSyncResult;
    }
    if (channel === "codex:scheduled-automations:list") {
      return { items: scheduledAutomations };
    }
    if (channel === "codex:automation-runs:inbox-items") {
      const unreadItems = automationInboxItems.filter((item) => item.readAt === null);
      return {
        items: automationInboxItems,
        unreadRunCounts: {
          total: unreadItems.length,
          automationIds: [...new Set(unreadItems.map((item) => item.automationId))],
          unreadRuns: unreadItems.map((item) => ({
            automationId: item.automationId,
            threadId: item.threadId,
          })),
        },
      } satisfies CodexAutomationRunsInboxResponse;
    }
    if (channel === "codex:model:list") {
      return codexModels;
    }
    if (channel === "codex:automation-runs:archive") {
      const threadId = String((args[0] as { threadId?: string } | undefined)?.threadId ?? "");
      let success = false;
      automationInboxItems = automationInboxItems.map((item) => {
        if (item.threadId !== threadId) return item;
        success = true;
        return {
          ...item,
          status: "ARCHIVED",
          readAt: item.readAt ?? 1_000,
          archivedReason: "manual",
        };
      });
      return { success };
    }
    if (channel === "codex:automation-runs:unarchive") {
      const threadId = String((args[0] as { threadId?: string } | undefined)?.threadId ?? "");
      let success = false;
      automationInboxItems = automationInboxItems.map((item) => {
        if (item.threadId !== threadId || item.status !== "ARCHIVED") return item;
        success = true;
        return {
          ...item,
          status: "ACCEPTED",
          readAt: item.readAt ?? 1_000,
          archivedReason: null,
        };
      });
      return { success };
    }
    if (channel === "codex:automation-runs:delete") {
      const threadId = String((args[0] as { threadId?: string } | undefined)?.threadId ?? "");
      const previousLength = automationInboxItems.length;
      automationInboxItems = automationInboxItems.filter((item) => item.threadId !== threadId);
      return { success: automationInboxItems.length !== previousLength };
    }
    if (channel === "codex:automation-runs:set-read-state") {
      const input = args[0] as { threadId?: string; readAt?: number | null };
      let updated: CodexAutomationInboxItem | null = null;
      automationInboxItems = automationInboxItems.map((item) => {
        if (item.threadId !== input.threadId) return item;
        updated = {
          ...item,
          readAt: input.readAt ?? null,
        };
        return updated;
      });
      return updated;
    }
    if (channel === "codex:scheduled-automations:run-now") {
      runNowAutomationIds.push(String((args[0] as { id?: string } | undefined)?.id ?? ""));
      return { success: true };
    }
    if (channel === "codex:scheduled-automations:create") {
      const input = args[0] as CodexScheduledAutomationCreateInput;
      const saved: CodexScheduledAutomation = {
        id: `automation-${scheduledAutomations.length + 1}`,
        definitionRevision: 1,
        kind: input.kind,
        status: "ACTIVE",
        targetThreadId: input.targetThreadId ?? null,
        name: input.name,
        prompt: input.prompt ?? "",
        rrule: input.rrule ?? null,
        model: input.model ?? null,
        modelProvider: input.modelProvider ?? null,
        harnessId: input.harnessId ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        serviceTier: input.serviceTier ?? null,
        cwds: input.cwds ?? [],
        executionEnvironment: input.executionEnvironment ?? "worktree",
        localEnvironmentConfigPath: input.localEnvironmentConfigPath ?? null,
        nextRunAt: null,
        lastRunAt: null,
        createdAt: 300,
        updatedAt: 400,
      };
      scheduledAutomations = [...scheduledAutomations, saved];
      return { item: saved };
    }
    if (channel === "codex:scheduled-automations:update") {
      const input = args[0] as CodexScheduledAutomationUpdateInput;
      const existing = scheduledAutomations.find((automation) => automation.id === input.id);
      const saved: CodexScheduledAutomation = {
        id: input.id,
        definitionRevision: (existing?.definitionRevision ?? 0) + 1,
        kind: input.kind,
        status: input.status,
        targetThreadId: input.targetThreadId ?? null,
        name: input.name,
        prompt: input.prompt ?? "",
        rrule: input.rrule ?? null,
        model: input.model ?? null,
        modelProvider: input.modelProvider ?? null,
        harnessId: input.harnessId ?? null,
        reasoningEffort: input.reasoningEffort ?? null,
        serviceTier: input.serviceTier ?? null,
        cwds: input.cwds ?? [],
        executionEnvironment: input.executionEnvironment ?? "worktree",
        localEnvironmentConfigPath: input.localEnvironmentConfigPath ?? null,
        nextRunAt: existing?.nextRunAt ?? null,
        lastRunAt: existing?.lastRunAt ?? null,
        createdAt: existing?.createdAt ?? 300,
        updatedAt: 400,
      };
      scheduledAutomations = scheduledAutomations.some((automation) => automation.id === saved.id)
        ? scheduledAutomations.map((automation) =>
            automation.id === saved.id ? saved : automation,
          )
        : [...scheduledAutomations, saved];
      return { item: saved };
    }
    if (channel === "codex:scheduled-automations:delete") {
      const automationId = String((args[0] as { id?: string } | undefined)?.id ?? "");
      const item =
        scheduledAutomations.find((automation) => automation.id === automationId) ?? null;
      const previousLength = scheduledAutomations.length;
      scheduledAutomations = scheduledAutomations.filter(
        (automation) => automation.id !== automationId,
      );
      return {
        item,
        success: scheduledAutomations.length !== previousLength || item === null,
        status: item ? "deleted" : "not_found",
      };
    }
    if (channel === "codex:threads:pinned:list") {
      return Object.values(sessionState)
        .flat()
        .filter((session) => session.thread && session.pinned)
        .map((session) => session.thread?.threadId);
    }
    if (channel === "codex:thread:ensure-session") {
      const threadId = String(args[0]);
      const existing = Object.values(sessionState)
        .flat()
        .find((session) => session.thread?.threadId === threadId);
      if (existing) return existing;

      const projectId = "alpha";
      const projectSessions = sessionState[projectId] ?? [];
      const session = makeAttachedSession({
        id: `session:${projectId}:${threadId}`,
        projectId,
        threadId,
        title: "Mention target",
        order: projectSessions.length,
        rightCollapsed: true,
        tabs: [],
      });
      sessionState = {
        ...sessionState,
        [projectId]: sortProjectSessionsForTest([...projectSessions, session]),
      };
      return session;
    }
    if (channel === "codex:threads:pinned:set") {
      const threadId = String(args[0]);
      const input = (args[1] ?? {}) as { pinned?: boolean };
      const nextPinned = input.pinned === true;
      const projectSessions = Object.values(sessionState).flat();
      const nextPinnedOrder = nextPinned
        ? Math.max(-1, ...projectSessions.map((session) => session.pinnedOrder ?? -1)) + 1
        : null;
      sessionState = Object.fromEntries(
        Object.entries(sessionState).map(([projectId, sessions]) => [
          projectId,
          sortProjectSessionsForTest(
            sessions.map((session) =>
              session.thread?.threadId === threadId
                ? { ...session, pinned: nextPinned, pinnedOrder: nextPinnedOrder }
                : session,
            ),
          ),
        ]),
      );
      return {
        items: [],
        pinnedThreadIds: Object.values(sessionState)
          .flat()
          .filter((session) => session.thread && session.pinned)
          .map((session) => session.thread?.threadId),
        projectAssignments: {},
        projectlessThreadIds: [],
        generatedAt: 1,
      };
    }
    if (channel === "database:view-window:get") {
      const projectId = String(args[0] ?? "alpha");
      const viewId = projectId === "beta" ? "view:beta" : "view:alpha";
      const dataSourceId = projectId === "beta" ? "data-source:beta" : "data-source:alpha";
      const board =
        projectId === "beta"
          ? {
              columns: [
                {
                  id: "build",
                  name: "Build",
                  cards: [
                    {
                      id: "card-beta",
                      projectId: "beta",
                      status: "build",
                      title: "Beta Card",
                      tags: [],
                      archived: false,
                      created: new Date("2026-06-07T00:00:00.000Z"),
                      order: 0,
                      revision: 1,
                      descriptionPreview: "",
                      descriptionLength: 0,
                      hasDescription: false,
                    },
                  ],
                },
              ],
            }
          : {
              columns: [
                {
                  id: "build",
                  name: "Build",
                  cards: [
                    {
                      id: "card-1",
                      projectId: "alpha",
                      status: "build",
                      title: "Card One",
                      tags: [],
                      archived: false,
                      created: new Date("2026-06-07T00:00:00.000Z"),
                      order: 0,
                      revision: 1,
                      descriptionPreview: "",
                      descriptionLength: 0,
                      hasDescription: false,
                    },
                    {
                      id: "card-2",
                      projectId: "alpha",
                      status: "build",
                      title: "Card Two",
                      tags: [],
                      archived: false,
                      created: new Date("2026-06-07T00:00:00.000Z"),
                      order: 1,
                      revision: 1,
                      descriptionPreview: "",
                      descriptionLength: 0,
                      hasDescription: false,
                    },
                  ],
                },
              ],
            };
      const cards = board.columns.flatMap((column) => column.cards);
      const databaseId = "database:test:primary";
      const database = {
        databaseId,
        libraryId: "library:test",
        name: "Tasks",
        lifecycle: "active",
        defaultViewId: viewId,
        accessRevision: 1,
        metadataRevision: 1,
        createdAt: "2026-06-07T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
      };
      const dataSource = {
        dataSourceId,
        libraryId: "library:test",
        homeDatabaseId: databaseId,
        name: "Pages",
        schemaKey: "nodex.page",
        schemaRevision: 1,
        lifecycle: "active",
        rankKey: "a",
        createdAt: "2026-06-07T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
      };
      const queryView = {
        viewId,
        databaseId,
        dataSourceId,
        name: projectId === "beta" ? "Beta" : "Alpha",
        layout: "board",
        config: databaseViewConfigFixture(),
        isDefault: true,
        revision: 1,
        rankKey: "a",
        lifecycle: "active",
        createdAt: "2026-06-07T00:00:00.000Z",
        updatedAt: "2026-06-07T00:00:00.000Z",
      };
      return {
        projectId,
        libraryId: "library:test",
        databaseId,
        dataSourceId,
        viewId,
        storeEpoch: "epoch:test",
        commitSeq: 1,
        authorization: authorizedReadStampFixture({
          deliveryAddress: {
            kind: "project",
            library_id: "library:test",
            project_id: projectId,
          },
          subject: { kind: "view", view_id: viewId },
          storeEpoch: "epoch:test",
          commitSeq: 1,
          authorizationDependencies: [
            ...cards.map((page) => ({ kind: "page" as const, page_id: page.id })),
            { kind: "view" as const, view_id: viewId },
          ],
        }),
        projection: {
          scopeKey: `scope:${viewId}`,
          schemaVersion: 1,
          revision: 1,
          coveredCommitSeq: 1,
          effectHash: "f".repeat(64),
        },
        nextCursor: null,
        rows: cards.map((page, index) => ({
          page,
          groupKey: page.status,
          subgroupKey: null,
          rankKey: String(index).padStart(8, "0"),
        })),
        board,
        view: {
          id: viewId,
          databaseBlockId: databaseId,
          projectId,
          name: queryView.name,
          layout: queryView.layout,
          config: queryView.config,
          isPrimary: true,
          createdAt: queryView.createdAt,
          updatedAt: queryView.updatedAt,
        },
        query: {
          database,
          dataSource,
          view: queryView,
          properties: [],
          rows: [],
        },
      };
    }
    if (channel === "pages:detail:get") {
      const projectId = String(args[0] ?? "");
      const pageId = String(args[1] ?? "");
      if (cardGetOverride) {
        const overridden = cardGetOverride(projectId, pageId);
        if (overridden !== undefined) {
          return asPageDetailResult(overridden, projectId, pageId);
        }
      }
      if (pageId === "card-beta") {
        return asPageDetailResult(
          {
            id: "card-beta",
            projectId: "beta",
            status: "build",
            title: "Beta Card",
            description: "",
            tags: [],
            archived: false,
            created: new Date("2026-06-07T00:00:00.000Z"),
            order: 0,
            revision: 1,
          },
          projectId,
          pageId,
        );
      }
      if (pageId === "card-2") {
        return asPageDetailResult(
          {
            id: "card-2",
            projectId: "alpha",
            status: "build",
            title: "Card Two",
            description: "",
            tags: [],
            archived: false,
            created: new Date("2026-06-07T00:00:00.000Z"),
            order: 1,
            revision: 1,
          },
          projectId,
          pageId,
        );
      }
      if (pageId !== "card-1") {
        return asPageDetailResult(null, projectId, pageId);
      }
      return asPageDetailResult(
        {
          id: "card-1",
          projectId: "alpha",
          status: "build",
          title: "Card One",
          description: "",
          tags: [],
          archived: false,
          created: new Date("2026-06-07T00:00:00.000Z"),
          order: 0,
          revision: 1,
        },
        projectId,
        pageId,
      );
    }
    if (channel === "project-sessions:update") {
      const sessionId = String(args[0]);
      const input = (args[1] ?? {}) as Partial<ProjectSession>;
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.id === sessionId);
      if (!session) return null;
      const updated = { ...session, ...input };
      sessionState = replaceSession(sessionState, updated);
      return updated;
    }
    if (channel === "project-sessions:rename") {
      const sessionId = String(args[0]);
      const input = (args[1] ?? {}) as { title?: string };
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.id === sessionId);
      if (!session) return null;
      const nextTitle = normalizeCodexManualThreadTitle(input.title ?? "");
      if (!nextTitle) return session;
      const updated = session.thread
        ? {
            ...session,
            displayTitle: nextTitle,
            thread: {
              ...session.thread,
              threadName: nextTitle,
            },
          }
        : {
            ...session,
            noThreadFallbackTitle: nextTitle,
            displayTitle: nextTitle,
          };
      sessionState = replaceSession(sessionState, updated);
      return updated;
    }
    if (channel === "project-sessions:set-pinned") {
      const sessionId = String(args[0]);
      const input = (args[1] ?? {}) as { pinned?: boolean };
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.id === sessionId);
      if (!session) return null;
      if (session.projectId === null) return null;
      const projectId = session.projectId;
      const projectSessions = sessionState[projectId] ?? [];
      const nextPinned = input.pinned === true;
      const nextPinnedOrder = nextPinned
        ? (session.pinnedOrder ??
          Math.max(-1, ...projectSessions.map((item) => item.pinnedOrder ?? -1)) + 1)
        : null;
      const updated = {
        ...session,
        pinned: nextPinned,
        pinnedOrder: nextPinnedOrder,
      };
      sessionState = {
        ...sessionState,
        [projectId]: sortProjectSessionsForTest(
          projectSessions.map((item) => (item.id === updated.id ? updated : item)),
        ),
      };
      return updated;
    }
    if (channel === "project-sessions:archive") {
      const sessionId = String(args[0]);
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.id === sessionId);
      if (!session) return null;
      const updated = {
        ...session,
        archived: true,
        archivedAt: "2026-06-07T00:00:00.000Z",
        pinned: false,
        pinnedOrder: null,
        unread: false,
        thread: session.thread ? { ...session.thread, archived: true } : session.thread,
      };
      sessionState = replaceSession(sessionState, updated);
      const scope = session.projectId ?? projectlessSessionStateKey;
      if (defaultDraftSessionIds.get(scope) === sessionId) {
        defaultDraftSessionIds.delete(scope);
      }
      sidebarItemState = sidebarItemState.filter(
        (item) => item.sessionId !== sessionId && item.threadId !== session.thread?.threadId,
      );
      return updated;
    }
    if (channel === "codex:thread:archive") {
      const threadId = String(args[0]);
      sessionState = Object.fromEntries(
        Object.entries(sessionState).map(([projectId, sessions]) => [
          projectId,
          sessions.map((session) =>
            session.thread?.threadId === threadId
              ? {
                  ...session,
                  archived: true,
                  archivedAt: "2026-06-07T00:00:00.000Z",
                  pinned: false,
                  pinnedOrder: null,
                  unread: false,
                  thread: { ...session.thread, archived: true },
                }
              : session,
          ),
        ]),
      );
      sidebarItemState = sidebarItemState.filter((item) => item.threadId !== threadId);
      return true;
    }
    if (channel === "window-session-view:panel-patch") {
      const sessionId = String(args[0]);
      const panelId = args[1] === "bottom" ? "bottom" : "right";
      const input = (args[2] ?? {}) as Partial<ProjectSession["panels"]["right"]>;
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.id === sessionId);
      if (!session) return null;
      const updated = {
        ...session,
        panels: {
          ...session.panels,
          [panelId]: {
            ...session.panels[panelId],
            ...input,
            size: {
              ...session.panels[panelId].size,
              ...(input.size ?? {}),
            },
          },
        },
      };
      sessionState = replaceSession(sessionState, updated);
      return updated;
    }
    if (channel === "window-session-view:ensure-right-leaf") {
      const input = (args[0] ?? {}) as {
        sessionId: string;
        panelId: WorkbenchTabProjection["panelId"];
        sourceLeafId: string;
      };
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.id === input.sessionId);
      if (!session) return null;
      const panel = session.panels[input.panelId];
      const existingLeafId = findNearestWorkbenchPanelLeafToRight(panel.layout, input.sourceLeafId);
      if (existingLeafId) {
        return { session, leafId: existingLeafId, created: false };
      }

      const leafId = `leaf:auto-right:${invokeCalls.length}`;
      const layout = insertWorkbenchPanelLeaf(panel.layout, {
        leafId: input.sourceLeafId,
        side: "right",
        newLeafId: leafId,
        newBranchId: `branch:auto-right:${invokeCalls.length}`,
      });
      const updated = {
        ...session,
        panels: {
          ...session.panels,
          [input.panelId]: {
            ...panel,
            collapsed: false,
            layout,
          },
        },
      };
      sessionState = replaceSession(sessionState, updated);
      return { session: updated, leafId, created: true };
    }
    if (channel === "window-session-view:panel-activate") {
      const input = (args[0] ?? {}) as {
        sessionId: string;
        panelId: WorkbenchTabProjection["panelId"];
        leafId?: string;
        tabId?: string | null;
      };
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.id === input.sessionId);
      if (!session) return null;
      const panel = session.panels[input.panelId];
      const updated = {
        ...session,
        panels: {
          ...session.panels,
          [input.panelId]: {
            ...panel,
            layout: activateTestPanelLayout(panel.layout, input.leafId, input.tabId),
          },
        },
      };
      sessionState = replaceSession(sessionState, updated);
      return updated;
    }
    if (channel === "project-sessions:create") {
      const input = (args[0] ?? {}) as {
        projectId: string | null;
        noThreadFallbackTitle?: string;
        initialPageIds?: string[];
      };
      return createMockSession(input);
    }
    if (channel === "project-sessions:ensure-default-draft") {
      const projectId = (args[0] ?? null) as string | null;
      const scope = projectId ?? projectlessSessionStateKey;
      const existingId = defaultDraftSessionIds.get(scope);
      const existing = existingId
        ? (sessionState[scope] ?? []).find(
            (session) => session.id === existingId && !session.archived && !session.thread,
          )
        : null;
      if (existing) return existing;
      defaultDraftSessionIds.delete(scope);
      const session = createMockSession({
        projectId,
        noThreadFallbackTitle: "New chat",
      });
      defaultDraftSessionIds.set(scope, session.id);
      return session;
    }
    if (channel === "window-session-view:tab-create") {
      const input = (args[0] ?? {}) as WorkbenchTabCreateInput;
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.id === input.sessionId);
      if (!session) return null;
      if (input.kind === "review") {
        const existing = session.tabs.find((tab) => tab.kind === input.kind);
        if (existing) {
          const panel = session.panels[existing.panelId];
          sessionState = replaceSession(sessionState, {
            ...session,
            panels: {
              ...session.panels,
              [existing.panelId]: {
                ...panel,
                collapsed: false,
                layout: makePanelLayout(
                  session.tabs
                    .filter((tab) => tab.panelId === existing.panelId)
                    .map((tab) => tab.id),
                  existing.id,
                ),
              },
            },
          });
          return existing;
        }
      }
      if (input.kind === "db_view" && "projectId" in input.config) {
        const inputProjectId = input.config.projectId;
        const existing = session.tabs.find(
          (tab) =>
            tab.kind === "db_view" &&
            "projectId" in tab.config &&
            tab.config.projectId === inputProjectId,
        );
        if (existing) {
          const panel = session.panels[existing.panelId];
          sessionState = replaceSession(sessionState, {
            ...session,
            panels: {
              ...session.panels,
              [existing.panelId]: {
                ...panel,
                collapsed: false,
                layout: makePanelLayout(
                  session.tabs
                    .filter((tab) => tab.panelId === existing.panelId)
                    .map((tab) => tab.id),
                  existing.id,
                ),
              },
            },
          });
          return existing;
        }
      }
      const panelId = input.panelId ?? "right";
      if (input.clientTabId && session.tabs.some((tab) => tab.id === input.clientTabId)) {
        throw new Error(`Project session tab id already exists: ${input.clientTabId}`);
      }
      const tabId = input.clientTabId ?? `created-tab-${session.tabs.length + 1}`;
      const tab = makeSessionTab({
        ...input,
        id: tabId,
        projectId: session.projectId,
        panelId,
        order: session.tabs.filter((item) => item.panelId === panelId).length,
      });
      const tabs = [...session.tabs, tab];
      const targetLeafId =
        input.targetLeafId ??
        session.panels[panelId].layout.activeLeafId ??
        firstPanelLeafId(session.panels[panelId].layout.root);
      sessionState = replaceSession(sessionState, {
        ...session,
        tabs,
        panels: {
          ...session.panels,
          [panelId]: {
            ...session.panels[panelId],
            collapsed: false,
            layout: appendTestPanelLayoutTab(session.panels[panelId].layout, targetLeafId, tab.id),
          },
        },
      });
      return tab;
    }
    if (channel === "window-session-view:tab-update") {
      const tabId = String(args[0]);
      const input = (args[1] ?? {}) as WorkbenchTabUpdateInput;
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.tabs.some((tab) => tab.id === tabId));
      if (!session) return null;

      const updatedTabs = session.tabs.map((tab) =>
        tab.id === tabId ? updateSessionTab(tab, input, "2026-06-07T00:00:00.000Z") : tab,
      );
      const updatedSession = { ...session, tabs: updatedTabs };
      sessionState = replaceSession(sessionState, updatedSession);
      return updatedTabs.find((tab) => tab.id === tabId) ?? null;
    }
    if (channel === "window-session-view:tab-remove") {
      const rawInput = args[0] as
        | string
        | {
            tabId?: string;
            preferredActiveLeafId?: string | null;
            preferredActiveTabId?: string | null;
          };
      const tabId = typeof rawInput === "string" ? rawInput : (rawInput.tabId ?? "");
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.tabs.some((tab) => tab.id === tabId));
      if (!session) return null;

      const deletedTab = session.tabs.find((tab) => tab.id === tabId);
      const updatedTabs = session.tabs.filter((tab) => tab.id !== tabId);
      const preferredActiveLeafId =
        typeof rawInput === "string" ? undefined : rawInput.preferredActiveLeafId;
      const preferredActiveTabId =
        typeof rawInput === "string" ? undefined : rawInput.preferredActiveTabId;
      sessionState = replaceSession(sessionState, {
        ...session,
        tabs: updatedTabs,
        panels: {
          right: {
            ...session.panels.right,
            layout:
              deletedTab?.panelId === "right"
                ? removeWorkbenchPanelTab(session.panels.right.layout, tabId, {
                    preferredActiveLeafId,
                    preferredActiveTabId,
                  })
                : session.panels.right.layout,
          },
          bottom: {
            ...session.panels.bottom,
            layout:
              deletedTab?.panelId === "bottom"
                ? removeWorkbenchPanelTab(session.panels.bottom.layout, tabId, {
                    preferredActiveLeafId,
                    preferredActiveTabId,
                  })
                : session.panels.bottom.layout,
          },
        },
      });
      return true;
    }
    if (channel === "window-session-view:tab-reorder") {
      const input = (args[0] ?? {}) as {
        sessionId: string;
        panelId: WorkbenchTabProjection["panelId"];
        orderedTabIds: string[];
      };
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.id === input.sessionId);
      if (!session) return null;
      const panelTabs = session.tabs.filter((tab) => tab.panelId === input.panelId);
      const knownIds = new Set(panelTabs.map((tab) => tab.id));
      const selected = input.orderedTabIds.filter((tabId) => knownIds.has(tabId));
      const remaining = panelTabs.map((tab) => tab.id).filter((tabId) => !selected.includes(tabId));
      const finalOrder = [...selected, ...remaining];
      const updatedTabs = session.tabs.map((tab) =>
        tab.panelId === input.panelId ? { ...tab, order: finalOrder.indexOf(tab.id) } : tab,
      );
      const root = session.panels[input.panelId].layout.root;
      const updated = {
        ...session,
        tabs: updatedTabs,
        panels: {
          ...session.panels,
          [input.panelId]: {
            ...session.panels[input.panelId],
            layout: makePanelLayout(
              finalOrder,
              root.type === "leaf" ? root.activeTabId : (finalOrder[0] ?? null),
            ),
          },
        },
      };
      sessionState = replaceSession(sessionState, updated);
      return updated;
    }
    if (channel === "window-session-view:tab-move") {
      const input = (args[0] ?? {}) as {
        tabId: string;
        targetPanelId: WorkbenchTabProjection["panelId"];
      };
      const session = Object.values(sessionState)
        .flat()
        .find((item) => item.tabs.some((tab) => tab.id === input.tabId));
      if (!session) return null;
      const updatedTabs = session.tabs.map((tab) =>
        tab.id === input.tabId ? { ...tab, panelId: input.targetPanelId, order: 0 } : tab,
      );
      const rightIds = updatedTabs.filter((tab) => tab.panelId === "right").map((tab) => tab.id);
      const bottomIds = updatedTabs.filter((tab) => tab.panelId === "bottom").map((tab) => tab.id);
      const updated = {
        ...session,
        tabs: updatedTabs,
        panels: {
          right: {
            ...session.panels.right,
            layout: makePanelLayout(rightIds, rightIds[0] ?? null),
          },
          bottom: {
            ...session.panels.bottom,
            collapsed: false,
            layout: makePanelLayout(bottomIds, bottomIds[0] ?? null),
          },
        },
      };
      sessionState = replaceSession(sessionState, updated);
      return updated;
    }
    if (channel === "worktrees:environments:list") {
      const projectId = String(args[0] ?? "");
      return worktreeEnvironmentOptionsByProject[projectId] ?? [];
    }
    if (channel === "worktrees:environments:configs:list") {
      const projectId = String(args[0] ?? "");
      return (worktreeEnvironmentOptionsByProject[projectId] ?? []).map((option) => ({
        configPath: option.path,
        fileName: option.path.split(/[\\/]/).at(-1) ?? option.name,
        state: "success",
        exists: true,
        name: option.name,
        hasSetupScript: option.hasSetupScript,
        hasCleanupScript: option.hasCleanupScript,
        actionCount: option.actionCount,
        parseErrorMessage: null,
        readErrorMessage: null,
        tooLargeMessage: null,
        environment: null,
      }));
    }
    if (channel === "workspace:pick-directory") {
      return "/repo/selected";
    }
    if (channel === "workspace-directory-entries") {
      const input = (args[0] ?? {}) as { directoryPath?: string };
      return {
        directoryPath: input.directoryPath ?? "",
        parentPath: input.directoryPath ? "" : null,
        entries: [],
      };
    }
    if (channel === "read-file-metadata") {
      return {
        isFile: true,
        sizeBytes: 12,
        createdAtMs: 1,
        mtimeMs: 1,
        contentKind: "text",
      };
    }
    if (channel === "read-file") {
      return {
        contents: "# Preview\n",
      };
    }
    if (channel === "shell:open-file-link") {
      return true;
    }
    return null;
  };

  const navigationStateChanges: WorkbenchNavigationCommandState[] = [];
  let requestWorkbenchNavigation: (
    direction: WorkbenchNavigationDirection,
    source?: WorkbenchNavigationCommandSource,
  ) => void = () => undefined;
  let requestPanelTabCycle: (direction: WorkbenchPanelTabCycleDirection) => void = () => undefined;
  let requestPanelTabClose: () => void = () => undefined;
  let requestSidebarToggle: (source: WorkbenchSidebarToggleCommandSource) => void = () => undefined;
  let requestWorkbenchCommand: (source: WorkbenchCommandSource) => void = () => undefined;
  let requestPageCreateCommand: (source: WorkbenchCommandSource) => void = () => undefined;
  let openCommandPalette: (
    mode?: "root" | "chats" | "pages" | "files",
    initialQuery?: string,
  ) => void = () => undefined;
  let replaceProjects: (projects: Project[]) => void = () => undefined;
  type TestSidebarState = NonNullable<ComponentProps<typeof WorkbenchShell>["sidebar"]>;

  function WorkbenchShellTestHarness() {
    const [renderedProjects, setRenderedProjects] = useState(projects);
    const sessionViewsBySessionId = Object.fromEntries(
      [...Object.values(sessionsByProject).flat(), ...projectlessSessions].map((session) => [
        session.id,
        makeSessionViewFixture(session),
      ]),
    );
    const [sidebarState, setSidebarState] = useState<TestSidebarState>(() => ({
      collapsed: false,
      width: 300,
      ...sidebar,
      collapsibleSections: {
        ...DEFAULT_SIDEBAR_COLLAPSIBLE_SECTIONS,
        ...sidebar?.collapsibleSections,
      },
    }));
    const commandPortRef = useRef<WorkbenchCommandPort | null>(null);
    const [pendingViewOpen, setPendingViewOpen] = useState(pendingViewDeepLinkOpen);
    const initialWorkbenchCommandConsumedRef = useRef(false);
    requestWorkbenchNavigation = (
      direction,
      source = direction === "back" ? "sidebar_back" : "sidebar_forward",
    ) => {
      commandPortRef.current?.navigate(direction, source);
    };
    requestPanelTabCycle = (direction) => {
      commandPortRef.current?.cyclePanelTab(direction);
    };
    requestPanelTabClose = () => {
      commandPortRef.current?.closePanelTab();
    };
    requestSidebarToggle = (source) => {
      commandPortRef.current?.toggleSidebar(source);
    };
    requestWorkbenchCommand = (source) => {
      commandPortRef.current?.execute("toggleBottomPanel", source);
    };
    requestPageCreateCommand = (source) => {
      commandPortRef.current?.execute(CREATE_PAGE_COMMAND_ID, source);
    };
    openCommandPalette = (mode = "root", initialQuery = "") => {
      commandPortRef.current?.openCommandPalette({
        mode,
        query: initialQuery,
      });
    };
    replaceProjects = (nextProjects) => {
      projectState = nextProjects;
      setRenderedProjects(nextProjects);
    };
    const initialWindowLayoutSnapshotRef = useRef(
      initialWindowLayoutSnapshot ??
        WorkbenchLayoutSnapshotSchema.parse({
          version: 4 as const,
          location: resolvedInitialSelectedSessionId
            ? {
                kind: "session" as const,
                activeProjectId: projects[0]?.id ?? null,
                sessionId: resolvedInitialSelectedSessionId,
              }
            : {
                kind: "empty" as const,
                activeProjectId: projects[0]?.id ?? null,
              },
          databaseSearchByProject: searchByProject,
          sessionViewsBySessionId,
        }),
    );
    return (
      <WorkbenchShell
        windowSessionId="window-session:test"
        initialWindowLayoutSnapshot={initialWindowLayoutSnapshotRef.current}
        projects={renderedProjects}
        onSceneMutation={(owner, previous, next) => {
          if (owner.kind !== "session") return;
          recordSessionViewMutation(
            projectWorkbenchSceneToLegacySessionView(previous),
            projectWorkbenchSceneToLegacySessionView(next),
          );
        }}
        sidebar={sidebarState}
        pageStageCloseRef={createRef()}
        pendingViewDeepLinkOpen={pendingViewOpen}
        onViewDeepLinkHandled={() => setPendingViewOpen(null)}
        openPageStage={() => undefined}
        onLeavePageStage={() => undefined}
        onCreateProject={async () => null}
        onUpdateProject={async () => null}
        onArchiveProject={async () => ({ kind: "not-found" })}
        onReorderProjects={async () => undefined}
        onSetProjectPinned={async () => null}
        onSetPinnedProjectOrder={async () => undefined}
        onRequestProjectPickerOpen={() => undefined}
        threadSearchOpenTick={0}
        setSidebarCollapsed={(collapsed) => {
          setSidebarState((current) => ({ ...current, collapsed }));
        }}
        setSidebarWidth={(width) => {
          setSidebarState((current) => ({ ...current, width }));
        }}
        setSidebarCollapsibleSectionCollapsed={(
          sectionId: SidebarDisclosureSectionId,
          collapsed: boolean,
        ) => {
          setSidebarState((current) => ({
            ...current,
            collapsibleSections: {
              ...DEFAULT_SIDEBAR_COLLAPSIBLE_SECTIONS,
              ...current.collapsibleSections,
              [sectionId]: collapsed,
            },
          }));
        }}
        onRegisterCommandPort={(port) => {
          commandPortRef.current = port;
          if (workbenchCommandRequest && !initialWorkbenchCommandConsumedRef.current) {
            initialWorkbenchCommandConsumedRef.current = true;
            port.execute(workbenchCommandRequest.commandId, workbenchCommandRequest.source);
          }
          return () => {
            if (commandPortRef.current !== port) return;
            commandPortRef.current = null;
          };
        }}
        onNavigationStateChange={(state) => {
          navigationStateChanges.push(state);
          onNavigationStateChange?.(state);
        }}
      />
    );
  }

  const result = render(
    <TestQueryProvider>
      <RendererStateProvider>
        <WorkbenchShellTestHarness />
        <NodexModalHost />
      </RendererStateProvider>
    </TestQueryProvider>,
  );
  return {
    ...result,
    navigationStateChanges,
    replaceProjects,
    openCommandPalette: (mode?: "root" | "chats" | "pages" | "files", initialQuery?: string) => {
      openCommandPalette(mode, initialQuery);
    },
    requestWorkbenchNavigation: (
      direction: WorkbenchNavigationDirection,
      source?: WorkbenchNavigationCommandSource,
    ) => {
      requestWorkbenchNavigation(direction, source);
    },
    requestPanelTabCycle: (direction: WorkbenchPanelTabCycleDirection) => {
      requestPanelTabCycle(direction);
    },
    requestPanelTabClose: () => {
      requestPanelTabClose();
    },
    requestSidebarToggle: (source: WorkbenchSidebarToggleCommandSource) => {
      requestSidebarToggle(source);
    },
    requestWorkbenchCommand: (source: WorkbenchCommandSource) => {
      requestWorkbenchCommand(source);
    },
    requestPageCreateCommand: (source: WorkbenchCommandSource) => {
      requestPageCreateCommand(source);
    },
    getScheduledAutomations: () => scheduledAutomations,
    getRunNowAutomationIds: () => runNowAutomationIds,
    getAutomationInboxItems: () => automationInboxItems,
  };
}

export function installRendererApiMock(listeners?: TerminalEventListenerMap): void {
  window.api = {
    invoke: async (channel: string, ...args: unknown[]) => {
      invokeCalls.push([channel, ...args]);
      return mockInvokeImpl?.(channel, ...args) ?? null;
    },
    on: (event: string, callback: (...args: unknown[]) => void) => {
      if (!listeners) return () => undefined;
      listeners[event] = (payload: unknown) => callback(payload);
      return () => {
        delete listeners[event];
      };
    },
  } as typeof window.api;
}

export function installTerminalEventApiMock(): TerminalEventListenerMap {
  const listeners: TerminalEventListenerMap = {};
  installRendererApiMock(listeners);
  return listeners;
}

beforeEach(() => {
  restoreDefaultInstantMotion?.();
  // Shell behavior tests assert settled product state without impersonating a
  // user's accessibility preference. Motion contracts opt into live timelines;
  // reduced-motion contracts set that preference explicitly.
  restoreDefaultInstantMotion = installInstantMotionMatchMediaForTest();
  terminalSessionStore.disposeEventSubscriptions();
  resetDatabaseRowDetailStoreForTests();
  resetPageDetailStoreForTests();
  resetDatabaseViewPersonalPreferencesForTests();
  resetDatabaseListWindowStoresForTests();
  __resetNodexToastStoreForTests();
  document.body.removeAttribute("style");
  installRendererApiMock();
  invokeCalls = [];
  startThreadForSessionCalls = [];
  startTurnCalls = [];
  pageChatItems = [];
  startThreadForSessionResult = {
    kind: "started",
    detail: { threadId: "thread-started" } as CodexThreadDetail,
  };
  requestThreadStreamSnapshotCalls = [];
  requestThreadStreamSnapshotImpl = null;
  hydrateBackgroundSubagentThreadsCalls = [];
  hydrateSubagentPanelCalls = [];
  removeQueuedFollowUpCalls = [];
  reorderQueuedFollowUpsCalls = [];
  sendQueuedFollowUpNowCalls = [];
  editLastUserTurnCalls = [];
  setComposerIntentCalls = [];
  removePlanImplementationRequestCalls = [];
  cleanBackgroundTerminalsCalls = [];
  listBackgroundTerminalsCalls = [];
  listBackgroundProcessesCalls = [];
  terminateBackgroundTerminalCalls = [];
  startSideChatCalls = [];
  startSideChatError = null;
  discardSideChatCalls = [];
  sideChatConversations = {};
  sideChatConversationProjectId = "alpha";
  mockThreadStartProgress = null;
  mockConversationHasVisibleTurn = true;
  codexHostMessageListener = null;
  pendingWorktreeWarningListener = null;
  mockInvokeImpl = null;
  requestPageCreateFromContextMock.mockReset();
  requestPageCreateFromContextMock.mockReturnValue(true);
  setWindowInnerWidthForTest(1024);
  localStorage.clear();
  sessionStorage.clear();
  delete (
    globalThis as {
      __lastDatabaseViewSurfaceProps?: Record<string, unknown>;
    }
  ).__lastDatabaseViewSurfaceProps;
  delete (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
    .__lastConnectedThreadStageProps;
  delete (
    globalThis as {
      __lastConnectedThreadComposerDockProps?: Record<string, unknown>;
    }
  ).__lastConnectedThreadComposerDockProps;
  delete (
    globalThis as {
      __mockConnectedThreadStagePropsByThreadId?: Record<string, Record<string, unknown>>;
    }
  ).__mockConnectedThreadStagePropsByThreadId;
  delete (globalThis as { __lastTerminalPanelProps?: Record<string, unknown> })
    .__lastTerminalPanelProps;
  delete (globalThis as { __lastHistoryPanelProps?: Record<string, unknown> })
    .__lastHistoryPanelProps;
  delete (globalThis as { __lastPageStageProps?: Record<string, unknown> }).__lastPageStageProps;
  delete (
    globalThis as {
      __lastWorkbenchCanvasStagePanelProps?: Record<string, unknown>;
    }
  ).__lastWorkbenchCanvasStagePanelProps;
  delete (
    globalThis as {
      __lastWorkbenchDatabaseViewSurfaceProps?: Record<string, unknown>;
    }
  ).__lastWorkbenchDatabaseViewSurfaceProps;
  delete (
    globalThis as {
      __lastDbViewSessionTabProps?: Record<string, unknown>;
    }
  ).__lastDbViewSessionTabProps;
  delete (globalThis as { __mockPageStagePropsByPageId?: Record<string, Record<string, unknown>> })
    .__mockPageStagePropsByPageId;
  delete (globalThis as { __mockPageStageHistoryClicks?: number }).__mockPageStageHistoryClicks;
  delete (globalThis as { __mockPageStageDeleteClicks?: number }).__mockPageStageDeleteClicks;
  delete (globalThis as { __mockPageStageMounts?: number }).__mockPageStageMounts;
  delete (globalThis as { __mockPageStageUnmounts?: number }).__mockPageStageUnmounts;
  delete (globalThis as { __mockPageStageMountsByPageId?: Record<string, number> })
    .__mockPageStageMountsByPageId;
  delete (globalThis as { __mockPageStageUnmountsByPageId?: Record<string, number> })
    .__mockPageStageUnmountsByPageId;
});

afterEach(() => {
  terminalSessionStore.disposeEventSubscriptions();
  restoreDefaultInstantMotion?.();
  restoreDefaultInstantMotion = null;
});

export async function openBottomPanel(screen: ReturnType<typeof renderWorkbench>): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Toggle bottom panel" }));
    await Promise.resolve();
  });
  await settleAsyncRender();
}

export async function executeCommandPaletteCommand(
  screen: ReturnType<typeof renderWorkbench>,
  query: string,
  label: string,
): Promise<void> {
  await act(async () => {
    screen.openCommandPalette("root", query);
    await Promise.resolve();
  });
  await settleAsyncRender();

  await act(async () => {
    const paletteInput = screen.getByLabelText("Command palette search");
    const paletteSurface = paletteInput.parentElement;
    if (!paletteSurface) throw new Error("Expected the command palette surface");
    fireEvent.click(within(paletteSurface).getByRole("button", { name: label }));
    await Promise.resolve();
  });
  await settleAsyncRender();
  await settleAsyncRender();
}

export async function pointerActivate(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(element, { button: 0 });
    fireEvent.click(element);
    await Promise.resolve();
  });
  await settleAsyncRender();
}

export async function releasePointerDrag(pointerId = 1): Promise<void> {
  await act(async () => {
    fireEvent.pointerUp(window, { pointerId });
    await Promise.resolve();
  });
  await settleAsyncRender();
}

export async function openPanelMenu(
  screen: ReturnType<typeof renderWorkbench>,
  label: "Open side panel tab" | "Open bottom panel tab",
): Promise<HTMLElement> {
  await openNodexMenu(screen.getByRole("button", { name: label }));
  await waitFor(() => {
    expect(screen.queryByRole("menu") !== null).toBe(true);
  });
  return screen.getByRole("menu");
}

export async function clickMenuItem(menu: HTMLElement, label: string): Promise<void> {
  await act(async () => {
    fireEvent.click(within(menu).getByText(label));
    await Promise.resolve();
  });
  await settleAsyncRender();
}

export async function pointerDownAndSettle(element: HTMLElement): Promise<void> {
  await act(async () => {
    fireEvent.pointerDown(element, { button: 0 });
    await Promise.resolve();
  });
  await settleAsyncRender();
}

export function getFilesPreviewInteractionTarget(
  screen: ReturnType<typeof renderWorkbench>,
): HTMLElement {
  return (
    screen.container.querySelector<HTMLElement>("[data-workspace-files-session-id]") ??
    screen.container.querySelector<HTMLElement>("[data-source-viewer='true']") ??
    screen.queryByPlaceholderText("Filter files…") ??
    screen.getByText("No file or workspace folder is available.")
  );
}

export function getLastTerminalPanelProps(): Record<string, unknown> {
  const props = (globalThis as { __lastTerminalPanelProps?: Record<string, unknown> })
    .__lastTerminalPanelProps;
  if (!props) throw new Error("Expected terminal panel props");
  return props;
}

export function getLastThreadStageActions(): Record<string, unknown> {
  const props = (globalThis as { __lastConnectedThreadStageProps?: Record<string, unknown> })
    .__lastConnectedThreadStageProps;
  const actions = props?.actions;
  if (!actions || typeof actions !== "object") {
    throw new Error("Expected ConnectedThreadStage actions");
  }
  return actions as Record<string, unknown>;
}

export function getHeaderShellSlot(
  screen: ReturnType<typeof renderWorkbench>,
  side: "left" | "right",
): HTMLElement {
  const slot = screen.container.querySelector(`[data-workbench-header-shell-slot="${side}"]`);
  if (!(slot instanceof HTMLElement)) {
    throw new Error(`Expected ${side} header shell slot`);
  }
  return slot;
}

export function setWindowInnerWidthForTest(width: number): void {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

export function installShellBodyMeasurementForTest({
  width,
  height,
}: {
  width: number;
  height: number;
}): {
  flushResizeObservers: () => void;
  restore: () => void;
} {
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = globalThis.ResizeObserver;
  const observers = new Set<{
    callback: ResizeObserverCallback;
    instance: ResizeObserver;
    targets: Set<Element>;
  }>();
  const makeRect = (targetWidth: number, targetHeight: number): DOMRect =>
    ({
      x: 0,
      y: 0,
      width: targetWidth,
      height: targetHeight,
      top: 0,
      right: targetWidth,
      bottom: targetHeight,
      left: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  const isMeasuredShellBody = (element: Element): boolean =>
    element instanceof HTMLElement && element.hasAttribute("data-app-shell-summary-layout");

  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      if (!isMeasuredShellBody(this)) {
        return originalGetBoundingClientRect.call(this);
      }
      return this.isConnected ? makeRect(width, height) : makeRect(0, 0);
    },
  });

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    writable: true,
    value: class ResizeObserver {
      private readonly observerRecord: {
        callback: ResizeObserverCallback;
        instance: ResizeObserver;
        targets: Set<Element>;
      };

      constructor(callback: ResizeObserverCallback) {
        this.observerRecord = {
          callback,
          instance: this as ResizeObserver,
          targets: new Set(),
        };
        observers.add(this.observerRecord);
      }

      observe(target: Element) {
        this.observerRecord.targets.add(target);
      }

      unobserve(target: Element) {
        this.observerRecord.targets.delete(target);
      }

      disconnect() {
        this.observerRecord.targets.clear();
        observers.delete(this.observerRecord);
      }
    } as typeof ResizeObserver,
  });

  return {
    flushResizeObservers: () => {
      for (const observer of observers) {
        const entries = [...observer.targets].map(
          (target) =>
            ({
              target,
              contentRect: target.getBoundingClientRect(),
            }) as ResizeObserverEntry,
        );
        if (entries.length === 0) continue;
        observer.callback(entries, observer.instance);
      }
    },
    restore: () => {
      observers.clear();
      Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
        configurable: true,
        writable: true,
        value: originalGetBoundingClientRect,
      });
      if (typeof originalResizeObserver === "undefined") {
        Reflect.deleteProperty(
          globalThis as typeof globalThis & { ResizeObserver?: typeof ResizeObserver },
          "ResizeObserver",
        );
        return;
      }
      Object.defineProperty(globalThis, "ResizeObserver", {
        configurable: true,
        writable: true,
        value: originalResizeObserver,
      });
    },
  };
}

export async function moveSidebarPointer(clientX: number, clientY = 80): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new MouseEvent("pointermove", {
        clientX,
        clientY,
      }),
    );
    await Promise.resolve();
  });
  await settleAsyncRender();
}

export function getMountedSessionIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-workbench-scene-owner^="session:"]'),
  ).map(
    (element) => element.getAttribute("data-workbench-scene-owner")?.slice("session:".length) ?? "",
  );
}

export function getMountedSessionRoot(container: HTMLElement): HTMLElement {
  const root = container.querySelector<HTMLElement>('[data-workbench-scene-owner^="session:"]');
  if (!root) throw new Error("Expected a mounted session root");
  return root;
}

export async function selectSidebarSession(container: HTMLElement, title: string): Promise<void> {
  await act(async () => {
    fireEvent.click(getThreadRow(container, title));
    await Promise.resolve();
  });
  await settleAsyncRender();
  await settleAsyncRender();
}

export function getConnectedThreadStagePropsByThreadId(
  threadId: string,
): Record<string, unknown> | undefined {
  return (
    globalThis as {
      __mockConnectedThreadStagePropsByThreadId?: Record<string, Record<string, unknown>>;
    }
  ).__mockConnectedThreadStagePropsByThreadId?.[threadId];
}

export type WorkbenchShellTestScope =
  | "sidebar-core"
  | "sidebar-projects"
  | "routes-threads"
  | "automations-conversation"
  | "layout-panel-actions"
  | "panel-commands"
  | "pages-shell-navigation";

export function setInvokeCalls(value: typeof invokeCalls): void {
  invokeCalls = value;
}

export function setPageChatItems(value: PageChatItem[]): void {
  pageChatItems = value;
}

export function setMockInvokeImpl(value: typeof mockInvokeImpl): void {
  mockInvokeImpl = value;
}

export function setStartThreadForSessionCalls(value: typeof startThreadForSessionCalls): void {
  startThreadForSessionCalls = value;
}

export function setStartThreadForSessionResult(value: typeof startThreadForSessionResult): void {
  startThreadForSessionResult = value;
}

export function setRequestThreadStreamSnapshotCalls(
  value: typeof requestThreadStreamSnapshotCalls,
): void {
  requestThreadStreamSnapshotCalls = value;
}

export function setRequestThreadStreamSnapshotImpl(
  value: typeof requestThreadStreamSnapshotImpl,
): void {
  requestThreadStreamSnapshotImpl = value;
}

export function setHydrateBackgroundSubagentThreadsCalls(
  value: typeof hydrateBackgroundSubagentThreadsCalls,
): void {
  hydrateBackgroundSubagentThreadsCalls = value;
}

export function setHydrateSubagentPanelCalls(value: typeof hydrateSubagentPanelCalls): void {
  hydrateSubagentPanelCalls = value;
}

export function setRemoveQueuedFollowUpCalls(value: typeof removeQueuedFollowUpCalls): void {
  removeQueuedFollowUpCalls = value;
}

export function setReorderQueuedFollowUpsCalls(value: typeof reorderQueuedFollowUpsCalls): void {
  reorderQueuedFollowUpsCalls = value;
}

export function setSendQueuedFollowUpNowCalls(value: typeof sendQueuedFollowUpNowCalls): void {
  sendQueuedFollowUpNowCalls = value;
}

export function setEditLastUserTurnCalls(value: typeof editLastUserTurnCalls): void {
  editLastUserTurnCalls = value;
}

export function setSetComposerIntentCalls(value: typeof setComposerIntentCalls): void {
  setComposerIntentCalls = value;
}

export function setRemovePlanImplementationRequestCalls(
  value: typeof removePlanImplementationRequestCalls,
): void {
  removePlanImplementationRequestCalls = value;
}

export function setCleanBackgroundTerminalsCalls(
  value: typeof cleanBackgroundTerminalsCalls,
): void {
  cleanBackgroundTerminalsCalls = value;
}

export function setListBackgroundTerminalsCalls(value: typeof listBackgroundTerminalsCalls): void {
  listBackgroundTerminalsCalls = value;
}

export function setListBackgroundProcessesCalls(value: typeof listBackgroundProcessesCalls): void {
  listBackgroundProcessesCalls = value;
}

export function setTerminateBackgroundTerminalCalls(
  value: typeof terminateBackgroundTerminalCalls,
): void {
  terminateBackgroundTerminalCalls = value;
}

export function setStartSideChatCalls(value: typeof startSideChatCalls): void {
  startSideChatCalls = value;
}

export function setStartSideChatError(value: typeof startSideChatError): void {
  startSideChatError = value;
}

export function setDiscardSideChatCalls(value: typeof discardSideChatCalls): void {
  discardSideChatCalls = value;
}

export function setSideChatConversations(value: typeof sideChatConversations): void {
  sideChatConversations = value;
}

export function setSideChatConversationProjectId(
  value: typeof sideChatConversationProjectId,
): void {
  sideChatConversationProjectId = value;
}

export function setMockThreadStartProgress(value: typeof mockThreadStartProgress): void {
  mockThreadStartProgress = value;
}

export function setMockConversationHasVisibleTurn(
  value: typeof mockConversationHasVisibleTurn,
): void {
  mockConversationHasVisibleTurn = value;
}

export function setCodexHostMessageListener(value: typeof codexHostMessageListener): void {
  codexHostMessageListener = value;
}

export function setPendingWorktreeWarningListener(
  value: typeof pendingWorktreeWarningListener,
): void {
  pendingWorktreeWarningListener = value;
}

export function setWorkbenchShell(value: typeof WorkbenchShell): void {
  WorkbenchShell = value;
}
