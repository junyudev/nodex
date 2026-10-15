import { describe, expect, test } from "vite-plus/test";

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
    expect(promoted.defaultFeatureOverrides?.["features.onboarding_interactive_tools"]).toBe(true);
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
