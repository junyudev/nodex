import { describe, expect, test } from "vite-plus/test";
import {
  CODEX_PENDING_WORKTREE_CONTINUE_WITHOUT_SETUP_OUTPUT,
  CODEX_PENDING_WORKTREE_CREATION_STARTED_OUTPUT,
  appendCodexPendingWorktreeOutputTail,
  getCodexPendingWorktreeConversationStartSnapshot,
  type CodexPendingStartConversationRequest,
  type CodexPendingStableWorktreeRequest,
  type CodexPendingWorktreeAction,
  type CodexPendingWorktreeEffect,
} from "./codex-pending-worktree-state";
import { WORKTREE_OUTPUT_TAIL_MAX_CHARS } from "../../shared/worktree-output";
import { CodexPendingWorktreeStateStore } from "./codex-pending-worktree-state.test-support";
import {
  allocateCodexPendingWorktreeRequest,
  appendCodexPendingPastedTextAttachments,
  buildCodexPendingComposerPrompt,
  buildCodexPendingFirstTurnAttachments,
  buildCodexPendingStartConversationParams,
  buildCodexPendingThreadStartConfig,
  dedupeCodexLiveFileAttachments,
  projectCodexPendingThreadStart,
  projectCodexPendingWorktreeLaunchLocation,
  rebaseCodexPendingWorkspacePath,
  rebaseCodexPendingWorkspaceRoots,
} from "./codex-pending-worktree-request";

describe("codex-pending-worktree-state", () => {
  function createStartRequest(
    id = "pending-1",
    clientThreadId = "client-1",
  ): CodexPendingStartConversationRequest {
    return {
      id,
      hostId: "local",
      label: "Delegated task",
      initialThreadTitle: "Delegated task",
      browserTransferSourceBrowserTabId: null,
      browserTransferSourceBrowserTabIds: null,
      browserTransferSourceConversationId: null,
      sourceWorkspaceRoot: "/repo",
      startingState: { type: "working-tree" },
      localEnvironmentConfigPath: "/repo/.codex/environments/environment.toml",
      prompt: "Do the delegated work",
      launchMode: "start-conversation",
      firstSubmission: {
        launchId: "01991e60-b800-7000-8000-000000000101",
        clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
      },
      clientThreadId,
      startConversationParamsInput: {
        input: [],
        commentAttachments: [],
        workspaceRoots: ["/repo"],
        cwd: "/repo",
        fileAttachments: [],
        addedFiles: [],

        model: null,
        serviceTier: null,
        reasoningEffort: null,
        collaborationMode: null,
        config: {},
        threadSource: "subagent",
        workspaceKind: "project",
        serviceName: undefined,
        projectAssignment: {
          projectKind: "local",
          projectId: "project-pending",
          pendingCoreUpdate: false,
        },
      },
      threadStartHostId: "local",
      threadGoalDraft: null,
      sourceConversationId: null,
      sourceCollaborationMode: null,
    };
  }

  function createStableRequest(id = "stable-1"): CodexPendingStableWorktreeRequest {
    return {
      id,
      hostId: "local",
      label: "Stable worktree",
      sourceWorkspaceRoot: "/repo",
      sourceWorkspaceRoots: ["/repo", "/shared"],
      prompt: "",
      launchMode: "create-stable-worktree",
      startConversationParamsInput: null,
      sourceConversationId: null,
      sourceCollaborationMode: null,
    };
  }

  function createGoalStartRequest(
    id = "goal-pending",
    clientThreadId = "goal-client",
  ): CodexPendingStartConversationRequest {
    return {
      ...createStartRequest(id, clientThreadId),
      threadGoalDraft: {
        objective: "Ship the goal",
        pastedTextAttachments: [
          {
            file: {
              label: "Pasted text.txt",
              path: "/attachments/source/pasted-text.txt",
              fsPath: "/attachments/source/pasted-text.txt",
            },
            preview: "Goal source",
            characterCount: 11,
          },
        ],
        imageAttachments: [],
      },
    };
  }

  function dispatch(
    store: CodexPendingWorktreeStateStore,
    action: CodexPendingWorktreeAction,
  ): readonly CodexPendingWorktreeEffect[] {
    return store.dispatch(action);
  }

  function effectTypes(effects: readonly CodexPendingWorktreeEffect[]): string {
    return effects.map((effect) => effect.type).join(",");
  }

  describe("Codex pending worktree state", () => {
    test("creates exact queued entries, starts work once, and publishes sorted snapshots", () => {
      const store = new CodexPendingWorktreeStateStore();
      let publishCount = 0;
      const unsubscribe = store.subscribe(() => {
        publishCount += 1;
      });

      const secondEffects = dispatch(store, {
        type: "create",
        request: createStartRequest("pending-2", "client-2"),
        createdAt: 20,
      });
      dispatch(store, {
        type: "create",
        request: createStartRequest("pending-1", "client-1"),
        createdAt: 10,
      });
      const duplicateEffects = dispatch(store, {
        type: "create",
        request: createStartRequest("pending-1", "client-1"),
        createdAt: 30,
      });

      const snapshot = store.getSnapshot();
      const entry = snapshot[0];
      expect(snapshot.map((item) => item.id).join(",")).toBe("pending-1,pending-2");
      expect(entry?.attempt).toBe(1);
      expect(entry?.phase).toBe("queued");
      expect(entry?.labelEdited).toBe(false);
      expect(entry?.worktreeOutputText).toBe("");
      expect(entry?.setupOutputText).toBe("");
      expect(entry?.errorMessage).toBe(null);
      expect(entry?.worktreeWorkspaceRoot).toBe(null);
      expect(entry?.worktreeGitRoot).toBe(null);
      expect(entry?.needsAttention).toBe(false);
      expect(entry?.isPinned).toBe(false);
      expect(effectTypes(secondEffects)).toBe("startWorktree");
      expect(duplicateEffects.length).toBe(0);
      expect(publishCount).toBe(2);
      expect(store.resolveThread("client-1")?.state).toBe("waiting");

      dispatch(store, { type: "start", pendingWorktreeId: "pending-1", attempt: 1 });
      dispatch(store, { type: "start", pendingWorktreeId: "pending-1", attempt: 1 });
      expect(store.getSnapshot()[0]?.phase).toBe("creating");
      expect(store.getSnapshot()[0]?.worktreeOutputText).toBe(
        CODEX_PENDING_WORKTREE_CREATION_STARTED_OUTPUT,
      );
      expect(store.getSnapshot()[0]?.worktreeGitRoot).toBe(null);
      expect(store.getSnapshot()[0]?.worktreeWorkspaceRoot).toBe(null);
      expect(publishCount).toBe(3);
      unsubscribe();
    });

    test("keeps independent 32k worktree and setup output tails", () => {
      const store = new CodexPendingWorktreeStateStore();
      dispatch(store, {
        type: "create",
        request: createStartRequest(),
        createdAt: 1,
      });
      dispatch(store, { type: "start", pendingWorktreeId: "pending-1", attempt: 1 });
      dispatch(store, {
        type: "appendOutput",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        phase: "worktree",
        output: "w".repeat(WORKTREE_OUTPUT_TAIL_MAX_CHARS + 7),
      });
      dispatch(store, { type: "setupStarted", pendingWorktreeId: "pending-1", attempt: 1 });
      dispatch(store, {
        type: "appendOutput",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        phase: "setup",
        output: "s".repeat(WORKTREE_OUTPUT_TAIL_MAX_CHARS + 9),
      });
      dispatch(store, {
        type: "worktreeFailed",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        errorMessage: "setup exited 1",
      });

      const entry = store.getSnapshot()[0];
      expect(entry?.worktreeOutputText.length).toBe(WORKTREE_OUTPUT_TAIL_MAX_CHARS);
      expect(entry?.worktreeOutputText).toBe("w".repeat(WORKTREE_OUTPUT_TAIL_MAX_CHARS));
      expect(entry?.setupOutputText.length).toBe(WORKTREE_OUTPUT_TAIL_MAX_CHARS);
      expect(entry?.setupOutputText.endsWith("[stderr] setup exited 1\n")).toBe(true);
      expect(entry?.phase).toBe("failed");
      expect(entry?.needsAttention).toBe(true);
      expect(appendCodexPendingWorktreeOutputTail("same", "")).toBe("same");
    });

    test("retains goal sources and setup-failure roots when continuing without setup", () => {
      const store = new CodexPendingWorktreeStateStore();
      dispatch(store, {
        type: "create",
        request: createGoalStartRequest("pending-1", "client-1"),
        createdAt: 1,
      });
      dispatch(store, { type: "start", pendingWorktreeId: "pending-1", attempt: 1 });
      dispatch(store, { type: "setupStarted", pendingWorktreeId: "pending-1", attempt: 1 });
      dispatch(store, {
        type: "appendOutput",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        phase: "setup",
        output: "setup log\n",
      });
      dispatch(store, {
        type: "setupFailed",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        errorMessage: "setup failed",
        worktreeGitRoot: "/repo/.worktrees/delegated",
        worktreeWorkspaceRoot: "/repo/.worktrees/delegated/workspace",
      });

      const failed = store.getSnapshot()[0];
      expect(failed?.phase).toBe("failed");
      expect(failed?.worktreeGitRoot).toBe("/repo/.worktrees/delegated");
      expect(failed?.worktreeWorkspaceRoot).toBe("/repo/.worktrees/delegated/workspace");
      expect(store.resolveThread("client-1")?.state).toBe("failed");

      const effects = dispatch(store, {
        type: "continueWithoutSetup",
        pendingWorktreeId: "pending-1",
      });
      const continued = store.getSnapshot()[0];
      expect(effectTypes(effects)).toBe("launchConversation");
      expect(continued?.phase).toBe("worktree-ready");
      expect(continued?.needsAttention).toBe(false);
      expect(continued?.errorMessage).toBe("setup failed");
      expect(continued?.worktreeGitRoot).toBe("/repo/.worktrees/delegated");
      expect(continued?.setupOutputText).toBe(
        `setup log\n${CODEX_PENDING_WORKTREE_CONTINUE_WITHOUT_SETUP_OUTPUT}`,
      );
      expect(getCodexPendingWorktreeConversationStartSnapshot(store.getState())[0]?.state).toBe(
        "starting",
      );
      expect(store.resolveThread("client-1")?.state).toBe("starting");
      expect(
        dispatch(store, {
          type: "continueWithoutSetup",
          pendingWorktreeId: "pending-1",
        }).length,
      ).toBe(0);
    });

    test("retry preserves goal sources, resets transient state, and cleans only failed roots", () => {
      const store = new CodexPendingWorktreeStateStore();
      dispatch(store, {
        type: "create",
        request: createGoalStartRequest("pending-1", "client-1"),
        createdAt: 1,
      });
      dispatch(store, { type: "start", pendingWorktreeId: "pending-1", attempt: 1 });
      dispatch(store, { type: "setupStarted", pendingWorktreeId: "pending-1", attempt: 1 });
      dispatch(store, {
        type: "appendOutput",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        phase: "setup",
        output: "setup log",
      });
      dispatch(store, {
        type: "setupFailed",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        errorMessage: "setup failed",
        worktreeGitRoot: "/repo/.worktrees/delegated",
        worktreeWorkspaceRoot: "/repo/.worktrees/delegated/workspace",
      });
      dispatch(store, {
        type: "updateMetadata",
        pendingWorktreeId: "pending-1",
        update: { type: "label", label: "Edited" },
      });
      dispatch(store, {
        type: "updateMetadata",
        pendingWorktreeId: "pending-1",
        update: { type: "isPinned", isPinned: true },
      });

      const effects = dispatch(store, { type: "retry", pendingWorktreeId: "pending-1" });
      const entry = store.getSnapshot()[0];
      expect(effectTypes(effects)).toBe("abort,delete,startWorktree");
      expect(effects[1]?.type === "delete" ? effects[1].worktreeGitRoot : null).toBe(
        "/repo/.worktrees/delegated",
      );
      expect(entry?.attempt).toBe(2);
      expect(entry?.phase).toBe("queued");
      expect(entry?.worktreeOutputText).toBe("");
      expect(entry?.setupOutputText).toBe("");
      expect(entry?.errorMessage).toBe(null);
      expect(entry?.worktreeWorkspaceRoot).toBe(null);
      expect(entry?.worktreeGitRoot).toBe(null);
      expect(entry?.needsAttention).toBe(false);
      expect(entry?.label).toBe("Edited");
      expect(entry?.isPinned).toBe(true);
      expect(store.resolveThread("client-1")?.state).toBe("waiting");

      dispatch(store, {
        type: "worktreeFailed",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        errorMessage: "stale worker result",
      });
      expect(store.getSnapshot()[0]).toMatchObject({
        attempt: 2,
        phase: "queued",
        worktreeGitRoot: null,
        errorMessage: null,
      });
    });

    test("cancel and dismiss return exact abort, remove, and conditional delete effects", () => {
      const cancelStore = new CodexPendingWorktreeStateStore();
      dispatch(cancelStore, {
        type: "create",
        request: createStartRequest("cancel", "cancel-client"),
        createdAt: 1,
      });
      dispatch(cancelStore, { type: "start", pendingWorktreeId: "cancel", attempt: 1 });
      dispatch(cancelStore, {
        type: "worktreeReady",
        pendingWorktreeId: "cancel",
        attempt: 1,
        worktreeGitRoot: "/worktrees/cancel",
        worktreeWorkspaceRoot: "/worktrees/cancel/workspace",
      });
      const cancelEffects = dispatch(cancelStore, {
        type: "cancel",
        pendingWorktreeId: "cancel",
      });
      expect(effectTypes(cancelEffects)).toBe("abort,remove,delete");
      expect(cancelStore.getSnapshot().length).toBe(0);
      expect(cancelStore.resolveThread("cancel-client")).toBe(null);

      const readyDismissStore = new CodexPendingWorktreeStateStore();
      dispatch(readyDismissStore, {
        type: "create",
        request: createStartRequest("ready", "ready-client"),
        createdAt: 1,
      });
      dispatch(readyDismissStore, { type: "start", pendingWorktreeId: "ready", attempt: 1 });
      dispatch(readyDismissStore, {
        type: "worktreeReady",
        pendingWorktreeId: "ready",
        attempt: 1,
        worktreeGitRoot: "/worktrees/ready",
        worktreeWorkspaceRoot: "/worktrees/ready/workspace",
      });
      expect(
        effectTypes(
          dispatch(readyDismissStore, {
            type: "dismiss",
            pendingWorktreeId: "ready",
          }),
        ),
      ).toBe("abort,remove");

      const failedDismissStore = new CodexPendingWorktreeStateStore();
      dispatch(failedDismissStore, {
        type: "create",
        request: createStartRequest("failed", "failed-client"),
        createdAt: 1,
      });
      dispatch(failedDismissStore, { type: "start", pendingWorktreeId: "failed", attempt: 1 });
      dispatch(failedDismissStore, {
        type: "setupStarted",
        pendingWorktreeId: "failed",
        attempt: 1,
      });
      dispatch(failedDismissStore, {
        type: "setupFailed",
        pendingWorktreeId: "failed",
        attempt: 1,
        errorMessage: "failed",
        worktreeGitRoot: "/worktrees/failed",
        worktreeWorkspaceRoot: "/worktrees/failed/workspace",
      });
      expect(
        effectTypes(
          dispatch(failedDismissStore, {
            type: "dismiss",
            pendingWorktreeId: "failed",
          }),
        ),
      ).toBe("abort,remove,delete");
    });

    test("emits frozen goal-source cleanup before work-local, cancel, dismiss, and success removal", () => {
      const cancelStore = new CodexPendingWorktreeStateStore();
      dispatch(cancelStore, {
        type: "create",
        request: createGoalStartRequest("goal-cancel", "goal-cancel-client"),
        createdAt: 1,
      });
      const cancelEffects = dispatch(cancelStore, {
        type: "cancel",
        pendingWorktreeId: "goal-cancel",
      });
      expect(effectTypes(cancelEffects)).toBe("cleanupGoalSources,abort,remove");
      expect(
        cancelEffects[0]?.type === "cleanupGoalSources" &&
          cancelEffects[0].entry.launchMode === "start-conversation"
          ? cancelEffects[0].entry.threadGoalDraft?.pastedTextAttachments?.[0]?.file?.path
          : null,
      ).toBe("/attachments/source/pasted-text.txt");

      const dismissStore = new CodexPendingWorktreeStateStore();
      dispatch(dismissStore, {
        type: "create",
        request: createGoalStartRequest("goal-dismiss", "goal-dismiss-client"),
        createdAt: 1,
      });
      expect(
        effectTypes(
          dispatch(dismissStore, {
            type: "dismiss",
            pendingWorktreeId: "goal-dismiss",
          }),
        ),
      ).toBe("cleanupGoalSources,abort,remove");

      const localStore = new CodexPendingWorktreeStateStore();
      dispatch(localStore, {
        type: "create",
        request: createGoalStartRequest("goal-local", "goal-local-client"),
        createdAt: 1,
      });
      dispatch(localStore, { type: "start", pendingWorktreeId: "goal-local", attempt: 1 });
      expect(
        effectTypes(
          dispatch(localStore, {
            type: "workLocally",
            pendingWorktreeId: "goal-local",
          }),
        ),
      ).toBe("cleanupGoalSources,abort,launchConversation");

      const successStore = new CodexPendingWorktreeStateStore();
      dispatch(successStore, {
        type: "create",
        request: createGoalStartRequest("goal-success", "goal-success-client"),
        createdAt: 1,
      });
      dispatch(successStore, {
        type: "start",
        pendingWorktreeId: "goal-success",
        attempt: 1,
      });
      dispatch(successStore, {
        type: "worktreeReady",
        pendingWorktreeId: "goal-success",
        attempt: 1,
        worktreeGitRoot: "/worktrees/goal-success",
        worktreeWorkspaceRoot: "/worktrees/goal-success/workspace",
      });
      expect(
        effectTypes(
          dispatch(successStore, {
            type: "conversationStartSucceeded",
            pendingWorktreeId: "goal-success",
            attempt: 1,
          }),
        ),
      ).toBe("cleanupGoalSources,remove");
    });

    test("works locally from an active setup with the frozen source payload and client identity", () => {
      const store = new CodexPendingWorktreeStateStore();
      dispatch(store, {
        type: "create",
        request: createStartRequest(),
        createdAt: 1,
      });
      dispatch(store, { type: "start", pendingWorktreeId: "pending-1", attempt: 1 });

      const effects = dispatch(store, {
        type: "workLocally",
        pendingWorktreeId: "pending-1",
      });
      expect(effectTypes(effects)).toBe("abort,launchConversation");
      const launch = effects[1];
      expect(launch?.type === "launchConversation" ? launch.workspaceRoot : null).toBe("/repo");
      expect(launch?.type === "launchConversation" ? launch.includeWorktreeInit : true).toBe(false);
      expect(store.getSnapshot().length).toBe(0);
      expect(store.resolveThread("client-1")).toBe(null);
      expect(getCodexPendingWorktreeConversationStartSnapshot(store.getState()).length).toBe(0);
    });

    test("tracks waiting, failed, and retried starts, then releases identity on success", () => {
      const store = new CodexPendingWorktreeStateStore();
      dispatch(store, {
        type: "create",
        request: createStartRequest(),
        createdAt: 1,
      });
      expect(store.resolveThread("client-1")?.state).toBe("waiting");

      dispatch(store, { type: "start", pendingWorktreeId: "pending-1", attempt: 1 });
      const firstLaunch = dispatch(store, {
        type: "worktreeReady",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        worktreeGitRoot: "/worktrees/delegated",
        worktreeWorkspaceRoot: "/worktrees/delegated/workspace",
      });
      expect(effectTypes(firstLaunch)).toBe("launchConversation");
      expect(store.resolveThread("client-1")?.state).toBe("starting");
      expect(
        dispatch(store, {
          type: "worktreeReady",
          pendingWorktreeId: "pending-1",
          attempt: 1,
          worktreeGitRoot: "/worktrees/delegated",
          worktreeWorkspaceRoot: "/worktrees/delegated/workspace",
        }).length,
      ).toBe(0);

      dispatch(store, {
        type: "conversationStartFailed",
        pendingWorktreeId: "pending-1",
        attempt: 1,
        errorMessage: "thread start failed",
      });
      expect(store.resolveThread("client-1")?.state).toBe("failed");
      const retryLaunch = dispatch(store, {
        type: "retryConversationStart",
        pendingWorktreeId: "pending-1",
      });
      expect(effectTypes(retryLaunch)).toBe("launchConversation");
      expect(store.resolveThread("client-1")?.state).toBe("starting");
      expect(
        dispatch(store, {
          type: "retryConversationStart",
          pendingWorktreeId: "pending-1",
        }).length,
      ).toBe(0);

      const successEffects = dispatch(store, {
        type: "conversationStartSucceeded",
        pendingWorktreeId: "pending-1",
        attempt: 1,
      });
      expect(effectTypes(successEffects)).toBe("remove");
      expect(store.getSnapshot().length).toBe(0);
      expect(store.resolveThread("client-1")).toBe(null);
      expect(getCodexPendingWorktreeConversationStartSnapshot(store.getState()).length).toBe(0);

      expect(
        effectTypes(
          dispatch(store, {
            type: "dismiss",
            pendingWorktreeId: "pending-1",
          }),
        ),
      ).toBe("");
      expect(store.resolveThread("client-1")).toBe(null);
    });

    test("removes ready stable worktrees only after workspace registration succeeds", () => {
      const store = new CodexPendingWorktreeStateStore();
      dispatch(store, {
        type: "create",
        request: createStableRequest(),
        createdAt: 1,
      });
      dispatch(store, { type: "start", pendingWorktreeId: "stable-1", attempt: 1 });
      const effects = dispatch(store, {
        type: "worktreeReady",
        pendingWorktreeId: "stable-1",
        attempt: 1,
        worktreeGitRoot: "/worktrees/stable",
        worktreeWorkspaceRoot: "/worktrees/stable/workspace",
      });

      expect(effectTypes(effects)).toBe("registerStableProject");
      expect(store.getSnapshot()[0]?.phase).toBe("worktree-ready");
      expect(effects[0]?.type === "registerStableProject" ? effects[0].attempt : null).toBe(1);
      expect(
        effects[0]?.type === "registerStableProject" ? effects[0].workspaceRoots : null,
      ).toEqual(["/worktrees/stable/workspace", "/shared"]);

      const registeredEffects = dispatch(store, {
        type: "stableProjectRegistered",
        pendingWorktreeId: "stable-1",
        attempt: 1,
      });
      expect(effectTypes(registeredEffects)).toBe("remove");
      expect(store.getSnapshot().length).toBe(0);
      expect(getCodexPendingWorktreeConversationStartSnapshot(store.getState()).length).toBe(0);
    });

    test("retains stable roots when workspace registration fails so retry can clean them", () => {
      const store = new CodexPendingWorktreeStateStore();
      dispatch(store, {
        type: "create",
        request: createStableRequest(),
        createdAt: 1,
      });
      dispatch(store, { type: "start", pendingWorktreeId: "stable-1", attempt: 1 });
      dispatch(store, {
        type: "worktreeReady",
        pendingWorktreeId: "stable-1",
        attempt: 1,
        worktreeGitRoot: "/worktrees/stable",
        worktreeWorkspaceRoot: "/worktrees/stable/workspace",
      });

      dispatch(store, {
        type: "workspaceRootAddFailed",
        pendingWorktreeId: "stable-1",
        attempt: 1,
        errorMessage: "project registration failed",
      });
      const failed = store.getSnapshot()[0];
      expect(failed?.phase).toBe("failed");
      expect(failed?.errorMessage).toBe("project registration failed");
      expect(failed?.needsAttention).toBe(true);
      expect(failed?.worktreeGitRoot).toBe("/worktrees/stable");
      expect(failed?.worktreeWorkspaceRoot).toBe("/worktrees/stable/workspace");
      expect(
        failed?.worktreeOutputText.endsWith("[stderr] project registration failed\n") ?? false,
      ).toBe(true);

      const retryEffects = dispatch(store, {
        type: "retry",
        pendingWorktreeId: "stable-1",
      });
      expect(effectTypes(retryEffects)).toBe("abort,delete,startWorktree");
      expect(retryEffects[1]?.type === "delete" ? retryEffects[1].worktreeGitRoot : null).toBe(
        "/worktrees/stable",
      );
      expect(
        dispatch(store, {
          type: "stableProjectRegistered",
          pendingWorktreeId: "stable-1",
          attempt: 1,
        }).length,
      ).toBe(0);
      expect(store.getSnapshot()[0]?.attempt).toBe(2);
    });

    test("reports an unknown action discriminator at the state-machine boundary", () => {
      const store = new CodexPendingWorktreeStateStore();
      const malformedAction = {
        type: "path-allocated",
        pendingWorktreeId: "pending-1",
        attempt: 1,
      } as unknown as CodexPendingWorktreeAction;

      expect(() => store.dispatch(malformedAction)).toThrowError(
        /Unhandled Codex pending worktree action:.*path-allocated/,
      );
    });
  });
});

describe("codex-pending-worktree-request", () => {
  describe("pending worktree request allocation", () => {
    test("allocates only a host-scoped pending identity for stable worktrees", () => {
      const ids = ["pending-stable"];
      const allocated = allocateCodexPendingWorktreeRequest(
        {
          hostId: "local",
          label: "Persistent project",
          sourceWorkspaceRoot: "/repo",
          sourceWorkspaceRoots: ["/repo", "/shared"],
          startingState: { type: "branch", branchName: "HEAD" },
          localEnvironmentConfigPath: null,
          prompt: "Create a persistent project worktree",
          launchMode: "create-stable-worktree",
          startConversationParamsInput: null,
          sourceConversationId: null,
          sourceCollaborationMode: null,
        },
        () => ids.shift() ?? "unexpected",
      );

      expect(allocated.result.pendingWorktreeId).toBe("local:pending-stable");
      expect(allocated.result.clientThreadId).toBe(null);
      expect(allocated.request.id).toBe("local:pending-stable");
      expect("clientThreadId" in allocated.request).toBe(false);
    });

    test("allocates pending and client identities for conversation modes", () => {
      const ids = ["pending-fork", "client-fork"];
      const allocated = allocateCodexPendingWorktreeRequest(
        {
          hostId: "local",
          label: "Forked task",
          sourceWorkspaceRoot: "/repo",
          sourceWorkspaceRoots: ["/repo", "/shared"],
          startingState: { type: "working-tree" },
          localEnvironmentConfigPath: null,
          prompt: "Forking task",
          launchMode: "fork-conversation",
          startConversationParamsInput: null,
          sourceConversationId: "thread-source",
          sourceCollaborationMode: null,
          targetTurnId: "turn-older",
          threadSource: "user",
        },
        () => ids.shift() ?? "unexpected",
      );

      expect(allocated.result.pendingWorktreeId).toBe("local:pending-fork");
      expect(allocated.result.clientThreadId).toBe("client-new-thread:client-fork");
      expect(allocated.request.launchMode).toBe("fork-conversation");
      if (allocated.request.launchMode !== "fork-conversation") {
        throw new Error("Expected fork request");
      }
      expect(allocated.request.clientThreadId).toBe("client-new-thread:client-fork");
      expect(allocated.request.targetTurnId).toBe("turn-older");
    });
  });

  describe("pending worktree frozen start payload", () => {
    test("retains secondary project roots and rebases only the primary source tree", () => {
      const frozen = buildCodexPendingStartConversationParams({
        input: [],
        commentAttachments: [],
        sourceWorkspaceRoot: "/repo/primary/packages/app",
        sourceWorkspaceRoots: [
          "/repo/primary/packages/app",
          "/repo/shared",
          "/repo/primary/packages/app/",
        ],
        fileAttachments: [],
        addedFiles: [],

        model: null,
        serviceTier: null,
        reasoningEffort: null,
        collaborationMode: null,
        config: {},
        threadSource: "user",
        workspaceKind: "project",
        projectAssignment: null,
      });

      expect(frozen.workspaceRoots).toEqual(["/repo/primary/packages/app", "/repo/shared"]);
      expect(
        rebaseCodexPendingWorkspaceRoots({
          sourceWorkspaceRoot: "/repo/primary/packages/app",
          worktreeWorkspaceRoot: "/worktrees/a1b2/primary/packages/app",
          workspaceRoots: frozen.workspaceRoots,
        }),
      ).toEqual(["/worktrees/a1b2/primary/packages/app", "/repo/shared"]);
    });

    test("rebases a nested cwd while leaving unrelated roots unchanged", () => {
      expect(
        rebaseCodexPendingWorkspacePath({
          path: "/repo/primary/packages/app/src",
          sourceWorkspaceRoot: "/repo/primary/packages/app",
          worktreeWorkspaceRoot: "/worktrees/a1b2/primary/packages/app",
        }),
      ).toBe("/worktrees/a1b2/primary/packages/app/src");
      expect(
        rebaseCodexPendingWorkspacePath({
          path: "/repo/shared",
          sourceWorkspaceRoot: "/repo/primary/packages/app",
          worktreeWorkspaceRoot: "/worktrees/a1b2/primary/packages/app",
        }),
      ).toBe("/repo/shared");
    });

    test("projects cwd, roots, and project assignment from one immutable launch descriptor", () => {
      expect(
        projectCodexPendingWorktreeLaunchLocation({
          sourceWorkspaceRoot: "/repo/primary",
          worktreeWorkspaceRoot: "/worktrees/a1b2/primary",
          params: {
            cwd: "/repo/primary/packages/app",
            workspaceRoots: ["/repo/primary", "/repo/shared"],
            projectAssignment: {
              projectKind: "local",
              projectId: "project-1",
              path: "/repo/primary/packages/app",
              pendingCoreUpdate: false,
            },
          },
        }),
      ).toEqual({
        cwd: "/worktrees/a1b2/primary/packages/app",
        workspaceRoots: ["/worktrees/a1b2/primary", "/repo/shared"],
        projectAssignment: {
          projectKind: "local",
          projectId: "project-1",
          path: "/worktrees/a1b2/primary/packages/app",
          pendingCoreUpdate: false,
        },
      });
    });

    test("keeps an external custom cwd explicit instead of granting the old primary", () => {
      expect(
        projectCodexPendingWorktreeLaunchLocation({
          sourceWorkspaceRoot: "/repo/primary",
          worktreeWorkspaceRoot: "/worktrees/a1b2/primary",
          params: {
            cwd: "/scratch/custom-cwd",
            workspaceRoots: ["/repo/primary", "/repo/shared"],
            projectAssignment: null,
          },
        }),
      ).toEqual({
        cwd: "/scratch/custom-cwd",
        workspaceRoots: ["/worktrees/a1b2/primary", "/repo/shared", "/scratch/custom-cwd"],
        projectAssignment: null,
      });
    });

    test("appends pasted source labels and dedupes the exact five-field identity first-wins", () => {
      const first = {
        label: "notes.md",
        path: "/repo/notes.md",
        fsPath: "/repo/notes.md",
        startLine: undefined,
        hostId: "first-host",
      };
      const duplicate = {
        ...first,
        startLine: null,
        hostId: "second-host",
      };
      const pasted = appendCodexPendingPastedTextAttachments(
        [first],
        [
          {
            file: {
              label: "pasted-text.txt",
              path: "/attachments/pasted-text.txt",
              fsPath: "/attachments/pasted-text.txt",
            },
            preview: "",
          },
          {
            file: {
              label: "pasted-text.txt",
              path: "/attachments/requirements.txt",
              fsPath: "/attachments/requirements.txt",
            },
            preview: "Requirements excerpt",
          },
        ],
      );
      const normalized = dedupeCodexLiveFileAttachments([...pasted, duplicate]);

      expect(normalized.length).toBe(3);
      expect(normalized[0] === first).toBe(true);
      expect(normalized[0]?.hostId).toBe("first-host");
      expect(normalized[1]?.label).toBe("pasted-text");
      expect(normalized[2]?.label).toBe("Requirements excerpt");
    });

    test("filters only goal pasted sources before appending and normalizing added files", () => {
      const source = {
        label: "Goal source",
        path: "/attachments/goal/pasted-text.txt",
        fsPath: "/attachments/goal/pasted-text.txt",
      };
      const ordinary = {
        label: "notes.md",
        path: "/repo/notes.md",
        fsPath: "/repo/notes.md",
      };
      const added = {
        label: "Added goal source",
        path: source.path,
        fsPath: source.fsPath,
      };

      const attachments = buildCodexPendingFirstTurnAttachments({
        fileAttachments: [source, ordinary],
        addedFiles: [added, { ...ordinary }],
        threadGoalDraft: {
          objective: "Use the goal source",
          pastedTextAttachments: [
            {
              text: "goal source",
              file: source,
            },
          ],
          imageAttachments: [],
        },
      });

      expect(JSON.stringify(attachments)).toBe(JSON.stringify([ordinary, added]));
    });

    test("builds the exact attachment-aware pending prompt and pasted-only request sentence", () => {
      const prompt = buildCodexPendingComposerPrompt({
        prompt: "",
        fileAttachments: [
          {
            label: "source.ts",
            path: "/repo/source.ts",
            fsPath: "/repo/source.ts",
            startLine: 4,
            endLine: 8,
          },
        ],
        pastedTextAttachments: [
          {
            file: {
              label: "pasted-text.txt",
              path: "/attachments/pasted-text.txt",
              fsPath: "/attachments/pasted-text.txt",
            },
            preview: "Pasted request",
          },
        ],
        addedFiles: [
          {
            label: "added.md",
            path: "/repo/added.md",
            fsPath: "/repo/added.md",
            startLine: 2,
          },
        ],
      });

      expect(prompt).toBe(
        [
          "",
          "# Files mentioned by the user:",
          "",
          "## added.md: /repo/added.md (line 2)",
          "",
          "## source.ts: /repo/source.ts (lines 4-8)",
          "",
          "## Pasted request: /attachments/pasted-text.txt",
          "",
          "The attached pasted text file(s) contain the user's request. Read and act on that content.",
          "",
          "## My request for Codex:",
          "",
          "",
        ].join("\n"),
      );
    });

    test("preserves raw user-request whitespace in the attachment-aware prompt", () => {
      const rawPrompt = "  first line\nsecond line  \n";
      const prompt = buildCodexPendingComposerPrompt({
        prompt: rawPrompt,
        fileAttachments: [
          {
            label: "source.ts",
            path: "/repo/source.ts",
            fsPath: "/repo/source.ts",
          },
        ],
        addedFiles: [],
      });

      expect(prompt).toBe(
        [
          "",
          "# Files mentioned by the user:",
          "",
          "## source.ts: /repo/source.ts",
          "",
          "## My request for Codex:",
          rawPrompt,
          "",
        ].join("\n"),
      );
    });

    test("projects only platform config, memory preferences, and frozen overrides into thread/start", () => {
      const frozen = buildCodexPendingStartConversationParams({
        input: [{ type: "text", text: "Ship the change", text_elements: [] }],
        commentAttachments: [],
        sourceWorkspaceRoot: "/source/repo",
        fileAttachments: [],
        addedFiles: [],

        model: null,
        serviceTier: null,
        reasoningEffort: null,
        collaborationMode: null,
        config: { expanded_only_marker: "must-not-leak" },
        configOverrides: {
          override_only_marker: "override",
          "memories.use_memories": true,
        },
        memoryPreferences: { generateMemories: true, useMemories: false },
        threadSource: "user",
        workspaceKind: "project",
        projectAssignment: null,
      });

      const projected = buildCodexPendingThreadStartConfig(
        {
          platform_only_marker: "platform",
          "memories.generate_memories": false,
        },
        frozen,
      );

      expect(JSON.stringify(projected)).toBe(
        JSON.stringify({
          platform_only_marker: "platform",
          "memories.generate_memories": true,
          "memories.use_memories": true,
          override_only_marker: "override",
        }),
      );
      expect(Object.prototype.hasOwnProperty.call(projected, "expanded_only_marker")).toBe(false);
    });

    test("promotes only a true onboarding control flag into builder feature defaults", () => {
      const promoted = projectCodexPendingThreadStart({
        defaultFeatureOverrides: { thread_tools: true },
        frozen: {
          configOverrides: {
            "features.onboarding_interactive_tools": true,
            ordinary_override: "kept",
          },
        },
      });
      expect(promoted.defaultFeatureOverrides?.["features.onboarding_interactive_tools"]).toBe(
        true,
      );
      expect(
        Object.prototype.hasOwnProperty.call(
          promoted.configOverrides,
          "features.onboarding_interactive_tools",
        ),
      ).toBe(false);
      expect(
        buildCodexPendingThreadStartConfig(
          {
            "features.onboarding_interactive_tools": true,
          },
          promoted,
        )["features.onboarding_interactive_tools"],
      ).toBe(true);
      expect(buildCodexPendingThreadStartConfig({}, promoted).ordinary_override).toBe("kept");

      const strippedFalse = projectCodexPendingThreadStart({
        defaultFeatureOverrides: {
          "features.onboarding_interactive_tools": true,
        },
        frozen: {
          configOverrides: {
            "features.onboarding_interactive_tools": false,
          },
        },
      });
      expect(strippedFalse.defaultFeatureOverrides?.["features.onboarding_interactive_tools"]).toBe(
        true,
      );
      expect(
        Object.prototype.hasOwnProperty.call(
          strippedFalse.configOverrides,
          "features.onboarding_interactive_tools",
        ),
      ).toBe(false);
      expect(
        buildCodexPendingThreadStartConfig(
          {
            "features.onboarding_interactive_tools": true,
          },
          strippedFalse,
        )["features.onboarding_interactive_tools"],
      ).toBe(true);

      const absentFalse = projectCodexPendingThreadStart({
        defaultFeatureOverrides: { thread_tools: true },
        frozen: {
          configOverrides: {
            "features.onboarding_interactive_tools": false,
          },
        },
      });
      expect(
        Object.prototype.hasOwnProperty.call(
          buildCodexPendingThreadStartConfig({}, absentFalse),
          "features.onboarding_interactive_tools",
        ),
      ).toBe(false);
    });
  });
});
