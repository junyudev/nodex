import { describe, expect, test } from "vite-plus/test";
import type {
  CodexPendingWorktreeEntry,
  CodexPendingWorktreeThreadResolution,
} from "../../../shared/codex-pending-worktree";
import {
  buildCancelledPendingWorktreeComposerIntent,
  resolveCancelledPendingWorktreeProjectId,
} from "./pending-worktree-cancel-recovery";
import {
  resolvePendingWorktreeProgressModel,
  resolvePendingWorktreeRouteActions,
} from "./pending-worktree-route-model";
import {
  buildStableWorktreeCreateInput,
  STABLE_WORKTREE_CREATE_PROMPT,
  suggestStableWorktreeProjectName,
} from "./stable-worktree-production";

describe("pending worktree cancel recovery", () => {
  type StartConversationEntry = Extract<
    CodexPendingWorktreeEntry,
    { readonly launchMode: "start-conversation" }
  >;

  function makeEntry(): StartConversationEntry {
    return {
      id: "local:pending-cancel",
      hostId: "local",
      label: "Cancelled task",
      sourceWorkspaceRoot: "/repo/nodex",
      startingState: { type: "working-tree" },
      localEnvironmentConfigPath: null,
      prompt: "Generated context\n## My request for Codex:\n  Restore this request  ",
      launchMode: "start-conversation",
      firstSubmission: {
        launchId: "01991e60-b800-7000-8000-000000000101",
        clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
      },
      clientThreadId: "client-new-thread:cancel",
      startConversationParamsInput: {
        input: [],
        commentAttachments: [
          {
            id: "comment-1",
            type: "comment",
            content: [{ content_type: "text", text: "Handle this edge case" }],
            position: { side: "right", path: "src/index.ts", line: 12 },
            createdAt: 1,
          },
        ],
        workspaceRoots: ["/repo/nodex"],
        cwd: "/repo/nodex",
        fileAttachments: [],
        addedFiles: [],

        model: null,
        serviceTier: null,
        reasoningEffort: null,
        collaborationMode: null,
        config: {},
        threadSource: "user",
        workspaceKind: "project",
      },
      sourceConversationId: null,
      sourceCollaborationMode: null,
      createdAt: 1,
      attempt: 1,
      phase: "failed",
      labelEdited: false,
      worktreeOutputText: "",
      setupOutputText: "",
      errorMessage: "Cancelled",
      worktreeWorkspaceRoot: null,
      worktreeGitRoot: null,
      needsAttention: false,
      isPinned: false,
    };
  }

  describe("pending worktree cancel recovery", () => {
    test("restores the final user request and review comments", () => {
      const intent = buildCancelledPendingWorktreeComposerIntent(makeEntry(), 42);

      expect(intent.prompt).toBe("Restore this request");
      expect(intent.focusNonce).toBe(42);
      expect(intent.promptInput?.text).toBe("Restore this request");
      expect(intent.promptInput?.commentAttachments?.[0]?.id).toBe("comment-1");
    });

    test("returns projectless scope when the frozen request has no live assignment", () => {
      const projectEntry = makeEntry();
      const assignedEntry: StartConversationEntry = {
        ...projectEntry,
        startConversationParamsInput: {
          ...projectEntry.startConversationParamsInput,
          projectAssignment: {
            projectKind: "local",
            projectId: "project-1",
            pendingCoreUpdate: false,
          },
        },
      };

      expect(resolveCancelledPendingWorktreeProjectId(assignedEntry, new Set(["project-1"]))).toBe(
        "project-1",
      );
      expect(resolveCancelledPendingWorktreeProjectId(assignedEntry, new Set())).toBe(null);
      expect(resolveCancelledPendingWorktreeProjectId(projectEntry, new Set(["project-1"]))).toBe(
        null,
      );
    });
  });
});

describe("pending worktree route model", () => {
  type StartConversationEntry = Extract<
    CodexPendingWorktreeEntry,
    { readonly launchMode: "start-conversation" }
  >;

  function makeEntry(overrides: Partial<StartConversationEntry> = {}): StartConversationEntry {
    return {
      id: "local:pending-1",
      hostId: "local",
      label: "Prepare an isolated workspace",
      sourceWorkspaceRoot: "/repo/nodex",
      startingState: { type: "branch", branchName: "main" },
      localEnvironmentConfigPath: null,
      prompt: "Create an isolated workspace",
      launchMode: "start-conversation",
      firstSubmission: {
        launchId: "01991e60-b800-7000-8000-000000000101",
        clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
      },
      clientThreadId: "client-new-thread:11111111-1111-4111-8111-111111111111",
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
      sourceConversationId: null,
      sourceCollaborationMode: null,
      createdAt: 1,
      attempt: 1,
      phase: "queued",
      labelEdited: false,
      worktreeOutputText: "",
      setupOutputText: "",
      errorMessage: null,
      worktreeWorkspaceRoot: null,
      worktreeGitRoot: null,
      needsAttention: false,
      isPinned: false,
      ...overrides,
    };
  }

  function resolution(
    entry: StartConversationEntry,
    state: "waiting" | "starting",
  ): CodexPendingWorktreeThreadResolution {
    return { state, clientThreadId: entry.clientThreadId, pendingWorktreeId: entry.id };
  }

  describe("pending worktree route model", () => {
    test("derives the two-stage create progress and checkout percentage", () => {
      const queued = makeEntry();
      expect(
        resolvePendingWorktreeProgressModel(queued, resolution(queued, "waiting")),
      ).toMatchObject({
        title: "Creating a worktree",
        titleIsRunning: true,
        steps: [
          { kind: "workspace", status: "running", progressPercentage: null },
          { kind: "checkout", status: "pending", progressPercentage: null },
        ],
      });

      const checkout = makeEntry({
        phase: "creating",
        worktreeOutputText: "Preparing worktree\nUpdating files: 37% (37/100)\n",
      });
      expect(
        resolvePendingWorktreeProgressModel(checkout, resolution(checkout, "waiting")).steps,
      ).toEqual([
        { kind: "workspace", status: "completed", progressPercentage: null },
        { kind: "checkout", status: "running", progressPercentage: 37 },
      ]);
    });

    test("does not mistake an allocated path followed by Git failure for a created worktree", () => {
      const failed = makeEntry({
        phase: "failed",
        worktreeOutputText: "[info] Starting worktree creation\n",
        errorMessage: "fatal: not a git repository",
      });
      const model = resolvePendingWorktreeProgressModel(failed, {
        state: "failed",
        clientThreadId: failed.clientThreadId,
        pendingWorktreeId: failed.id,
        errorMessage: failed.errorMessage,
      });

      expect(model).toMatchObject({
        title: "Worktree setup failed",
        detailsInitiallyExpanded: true,
        steps: [
          { kind: "workspace", status: "failed" },
          { kind: "checkout", status: "pending" },
        ],
      });
      expect(model.outputText).toContain("fatal: not a git repository");
      expect(resolvePendingWorktreeRouteActions(failed, null)).toEqual({
        canAutoFix: false,
        canCancel: false,
        canContinue: false,
        canEditEnvironment: true,
        canRetry: true,
        canWorkLocally: false,
      });
    });

    test("separates retained setup failure from task-start failure", () => {
      const setupFailed = makeEntry({
        phase: "failed",
        localEnvironmentConfigPath: ".codex/environments/default.toml",
        worktreeGitRoot: "/repo/worktrees/task",
        worktreeWorkspaceRoot: "/repo/worktrees/task",
        errorMessage: "setup failed",
      });
      expect(resolvePendingWorktreeProgressModel(setupFailed, null).steps).toEqual([
        { kind: "workspace", status: "completed", progressPercentage: null },
        { kind: "checkout", status: "completed", progressPercentage: null },
        { kind: "setup", status: "failed", progressPercentage: null },
      ]);
      expect(resolvePendingWorktreeRouteActions(setupFailed, null)).toMatchObject({
        canAutoFix: true,
        canContinue: true,
        canEditEnvironment: true,
        canRetry: true,
      });

      const ready = makeEntry({
        phase: "worktree-ready",
        worktreeGitRoot: "/repo/worktrees/task",
        worktreeWorkspaceRoot: "/repo/worktrees/task",
      });
      expect(
        resolvePendingWorktreeProgressModel(ready, resolution(ready, "starting")),
      ).toMatchObject({ title: "Worktree created", cardVisible: false, startingTask: true });
      expect(
        resolvePendingWorktreeProgressModel(ready, {
          state: "failed",
          clientThreadId: ready.clientThreadId,
          pendingWorktreeId: ready.id,
          errorMessage: "thread/start failed",
        }),
      ).toMatchObject({ title: "Task failed to start", cardVisible: true });
    });
  });
});

describe("stable worktree production helpers", () => {
  test("suggests the first free project suffix from labels and folder names", () => {
    expect(
      suggestStableWorktreeProjectName({
        base: " Nodex ",
        workspaceRootOptions: ["/repo/first", "/repo/Nodex_3"],
        workspaceRootLabels: { "/repo/first": "Nodex_2" },
      }),
    ).toBe("Nodex_4");
    expect(suggestStableWorktreeProjectName({ base: "   " })).toBe("Workspace_2");
  });

  test("builds the exact stable create request", () => {
    const input = buildStableWorktreeCreateInput({
      sourceWorkspaceRoot: "/repo/nodex",
      sourceWorkspaceRoots: ["/repo/nodex", "/repo/shared"],
      label: "Nodex_2",
    });

    expect(input.hostId).toBe("local");
    expect(input.label).toBe("Nodex_2");
    expect(input.sourceWorkspaceRoot).toBe("/repo/nodex");
    expect(input.launchMode).toBe("create-stable-worktree");
    if (input.launchMode !== "create-stable-worktree") {
      throw new Error("Expected stable worktree input");
    }
    expect(input.sourceWorkspaceRoots).toEqual(["/repo/nodex", "/repo/shared"]);
    expect(input.startingState?.type).toBe("branch");
    expect(input.startingState?.type === "branch" ? input.startingState.branchName : null).toBe(
      "HEAD",
    );
    expect(input.localEnvironmentConfigPath).toBe(null);
    expect(input.prompt).toBe(STABLE_WORKTREE_CREATE_PROMPT);
    expect(input.launchMode).toBe("create-stable-worktree");
    expect(input.startConversationParamsInput).toBe(null);
    expect(input.sourceConversationId).toBe(null);
    expect(input.sourceCollaborationMode).toBe(null);
  });
});
