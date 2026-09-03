import { describe, expect, expectTypeOf, test } from "vite-plus/test";
import type { CodexPendingWorktreeStartingState } from "./codex-pending-worktree";
import {
  CODEX_PENDING_WORKTREE_FALLBACK_LABEL,
  buildCodexPendingWorktreeSetupRepairPrompt,
  buildCodexPendingWorktreeInitItem,
  canCreateCodexPendingWorktreeSetupRepair,
  extractCodexUserRequestSection,
  summarizeCodexPendingWorktreeLabel,
} from "./codex-pending-worktree";

describe("codex pending worktree label", () => {
  test("summarizes only the final explicit user-request section", () => {
    const prompt = [
      "# Context",
      "Ignore this setup text",
      "## My request for Codex:",
      "First request",
      "## My request for Codex:",
      "  Build the exact pending lifecycle  ",
    ].join("\n");

    expect(extractCodexUserRequestSection(prompt)).toBe("Build the exact pending lifecycle");
    expect(summarizeCodexPendingWorktreeLabel(prompt)).toBe("Build the exact pending lifecycle");
  });

  test("collapses prompt whitespace and uses the exact empty fallback", () => {
    expect(summarizeCodexPendingWorktreeLabel("  Build\n\n  the   feature  ")).toBe(
      "Build the feature",
    );
    expect(summarizeCodexPendingWorktreeLabel(" \n\t ")).toBe(
      CODEX_PENDING_WORKTREE_FALLBACK_LABEL,
    );
  });

  test("keeps an 80-character label and truncates longer labels to 79 plus ellipsis", () => {
    const exact = "x".repeat(80);
    expect(summarizeCodexPendingWorktreeLabel(exact)).toBe(exact);
    expect(summarizeCodexPendingWorktreeLabel(`${exact}y`)).toBe(`${"x".repeat(79)}…`);
  });
});

describe("codex pending worktree starting state", () => {
  test("round-trips the full remote ref alongside its normalized branch name", () => {
    const startingState = {
      type: "branch",
      branchName: "feature/exact",
      remoteRef: "refs/remotes/origin/feature/exact",
    } satisfies CodexPendingWorktreeStartingState;

    const roundTripped = JSON.parse(
      JSON.stringify(startingState),
    ) as CodexPendingWorktreeStartingState;

    expectTypeOf(roundTripped).toMatchTypeOf<CodexPendingWorktreeStartingState>();
    expect(roundTripped).toEqual({
      type: "branch",
      branchName: "feature/exact",
      remoteRef: "refs/remotes/origin/feature/exact",
    });
  });
});

describe("codex pending worktree init item", () => {
  test("projects a ready no-environment attempt with its exact stable id", () => {
    const item = buildCodexPendingWorktreeInitItem({
      id: "local:pending-1",
      hostId: "local",
      label: "Task",
      sourceWorkspaceRoot: "/repo",
      startingState: { type: "branch", branchName: "main" },
      localEnvironmentConfigPath: null,
      prompt: "Task",
      launchMode: "start-conversation",
      firstSubmission: {
        launchId: "01991e60-b800-7000-8000-000000000101",
        clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
      },
      clientThreadId: "client-new-thread:1",
      startConversationParamsInput: {
        input: [],
        commentAttachments: [],
        workspaceRoots: ["/repo"],
        cwd: "/repo",
        fileAttachments: [],
        addedFiles: [],
        agentMode: "auto",
        permissionProfileId: undefined,
        shouldSendPermissionOverrides: true,
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
          projectId: "project-1",
          pendingCoreUpdate: false,
        },
      },
      sourceConversationId: null,
      sourceCollaborationMode: null,
      createdAt: 1,
      attempt: 2,
      phase: "worktree-ready",
      labelEdited: false,
      worktreeOutputText: "created\n",
      setupOutputText: "",
      errorMessage: null,
      worktreeWorkspaceRoot: "/worktree/repo",
      worktreeGitRoot: "/worktree",
      needsAttention: false,
      isPinned: false,
      pinnedBeforeThreadId: null,
    });

    expect(item?.id).toBe("local:pending-1:2");
    expect(item?.worktreeOutputText).toBe("created\n");
    expect(item?.setup).toBe(null);
  });
});

describe("codex pending worktree setup repair", () => {
  test("builds the exact repair prompt only at the retained setup-failure boundary", () => {
    const entry = {
      id: "local:pending-repair",
      hostId: "local",
      label: "Original task",
      sourceWorkspaceRoot: "/repo",
      sourceWorkspaceRoots: ["/repo"],
      startingState: { type: "working-tree" as const },
      localEnvironmentConfigPath: ".codex/environments/dev.toml",
      prompt: "Original request",
      launchMode: "create-stable-worktree" as const,
      startConversationParamsInput: null,
      sourceConversationId: null,
      sourceCollaborationMode: null,
      createdAt: 1,
      attempt: 1,
      phase: "failed" as const,
      labelEdited: false,
      worktreeOutputText: "created\n",
      setupOutputText: "dependency failed\n",
      errorMessage: "setup exited 1",
      worktreeWorkspaceRoot: "/worktree/repo",
      worktreeGitRoot: "/worktree",
      needsAttention: true,
      isPinned: false,
      pinnedBeforeThreadId: null,
    };

    expect(canCreateCodexPendingWorktreeSetupRepair(entry)).toBe(true);
    expect(buildCodexPendingWorktreeSetupRepairPrompt(entry)).toBe(
      [
        "Fix this project's local environment setup.",
        "The original worktree setup failed before its thread could start. Do not continue the original user request. Start a one-off repair task in this new worktree without running the broken setup automatically. Paths in the failure output refer to the original source or failed worktree, so edit the corresponding files in this current repair worktree. Inspect the selected local environment config and related setup files, reproduce the failure manually if useful, make the smallest source-controlled fix, verify the setup succeeds, and leave the proposed fix here for user review before they retry the original task. If the fix should not be made automatically, explain exactly what the user should change.",
        "Selected local environment config: .codex/environments/dev.toml\nOriginal setup error: setup exited 1",
        "Original setup output:\n```text\ndependency failed\n\n```",
      ].join("\n\n"),
    );
    expect(
      canCreateCodexPendingWorktreeSetupRepair({
        ...entry,
        worktreeGitRoot: null,
      }),
    ).toBe(false);
  });
});
