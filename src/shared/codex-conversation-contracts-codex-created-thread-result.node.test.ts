import { describe, expect, test, expectTypeOf } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  decodeCreatedThreadResult,
  readCreatedThreadActivityResult,
  readNativeCreatedThreadResult,
} from "./codex-created-thread-result";
import {
  type CodexPendingWorktreeStartingState,
  CODEX_PENDING_WORKTREE_FALLBACK_LABEL,
  buildCodexPendingWorktreeSetupRepairPrompt,
  buildCodexPendingWorktreeInitItem,
  canCreateCodexPendingWorktreeSetupRepair,
  extractCodexUserRequestSection,
  summarizeCodexPendingWorktreeLabel,
} from "./codex-pending-worktree";
import {
  codexConversationRecoveryReason,
  isWaitingForNetworkMessage,
  parseConversationRetryProgress,
} from "./conversation-recovery";

describe("codex created thread result", () => {
  const call = (
    overrides: Partial<Extract<ThreadItem, { type: "dynamicToolCall" }>> = {},
  ): Extract<ThreadItem, { type: "dynamicToolCall" }> => ({
    type: "dynamicToolCall",
    id: "source-call",
    namespace: "codex_app",
    tool: "create_thread",
    arguments: {},
    status: "completed",
    contentItems: [{ type: "inputText", text: '{"threadId":" child ","hostId":" remote "}' }],
    success: true,
    durationMs: 1,
    ...overrides,
  });

  describe("created thread targets", () => {
    test("preserves provider and host while preferring a valid native identity", () => {
      expect(decodeCreatedThreadResult({ threadId: " child ", hostId: " remote " })).toEqual({
        threadId: "child",
        hostId: "remote",
      });
      expect(
        decodeCreatedThreadResult({ threadId: "child", clientThreadId: "client-new-thread:any" }),
      ).toEqual({ threadId: "child" });
      expect(
        decodeCreatedThreadResult({ threadId: " ", clientThreadId: "client-new-thread:any" }),
      ).toEqual({ clientThreadId: "client-new-thread:any" });
      expect(decodeCreatedThreadResult({ kind: "chatgpt", clientThreadId: " pending " })).toEqual({
        kind: "chatgpt",
        clientThreadId: "pending",
      });
    });
    test.each([
      { kind: "other", threadId: "child" },
      { threadId: " " },
      { threadId: "child", hostId: " " },
      { clientThreadId: " client-new-thread:any" },
      { clientThreadId: "pending-worktree:any" },
    ])("rejects an invalid target %j", (value) => {
      expect(decodeCreatedThreadResult(value)).toBeNull();
    });
    test("keeps ordinary registry admission distinct from raw promotion", () => {
      const legacy = call({ namespace: null });
      expect(readNativeCreatedThreadResult(legacy)).toBeNull();
      expect(readCreatedThreadActivityResult({ ...legacy, completed: true })).toEqual({
        threadId: "child",
        hostId: "remote",
      });
      for (const invalid of [
        call({ status: "inProgress" }),
        call({ success: false }),
        call({ namespace: "other" }),
        call({ tool: "fork_thread" }),
      ])
        expect(readNativeCreatedThreadResult(invalid)).toBeNull();
      expect(readCreatedThreadActivityResult({ ...call(), completed: false })).toBeNull();
    });
    test("only the first matching text result can establish the target", () => {
      expect(
        readNativeCreatedThreadResult(
          call({
            contentItems: [
              { type: "inputImage", imageUrl: "https://example.test/image.png" },
              { type: "inputText", text: '{"threadId":"after-image"}' },
            ],
          }),
        ),
      ).toEqual({ threadId: "after-image" });
      const invalidFirst = call({
        contentItems: [
          { type: "inputText", text: "invalid" },
          { type: "inputText", text: '{"threadId":"later"}' },
        ],
      });
      expect(readNativeCreatedThreadResult(invalidFirst)).toBeNull();
    });
  });
});

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
    expect(summarizeCodexPendingWorktreeLabel("Context\n## My request:\n**Ship** [it](x)")).toBe(
      "Ship it",
    );
  });

  test("projects Markdown and uses the exact empty fallback", () => {
    expect(summarizeCodexPendingWorktreeLabel("  Build\n\n  the   feature  ")).toBe(
      "Build the feature",
    );
    expect(summarizeCodexPendingWorktreeLabel(" \n\t ")).toBe(
      CODEX_PENDING_WORKTREE_FALLBACK_LABEL,
    );
    expect(summarizeCodexPendingWorktreeLabel("---")).toBe(CODEX_PENDING_WORKTREE_FALLBACK_LABEL);
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

describe("conversation recovery reasons", () => {
  test.each([
    [429, "rate_limit"],
    [529, "overloaded"],
    [401, "authentication"],
  ] as const)(
    "uses upstream HTTP %s before a broad connection wrapper",
    (httpStatusCode, reason) => {
      expect(
        codexConversationRecoveryReason({ responseStreamDisconnected: { httpStatusCode } }),
      ).toBe(reason);
    },
  );

  test("keeps an explicit connection cause when the HTTP status is unavailable or unclassified", () => {
    expect(
      codexConversationRecoveryReason({ responseStreamConnectionFailed: { httpStatusCode: null } }),
    ).toBe("connection");
    expect(codexConversationRecoveryReason({ httpConnectionFailed: { httpStatusCode: 502 } })).toBe(
      "connection",
    );
  });

  test("reads direct protocol codes without treating absent or future details as network evidence", () => {
    expect(codexConversationRecoveryReason("usageLimitExceeded")).toBe("usage_limit");
    expect(codexConversationRecoveryReason("flexUnavailable")).toBe("overloaded");
    expect(codexConversationRecoveryReason(null)).toBe("unknown");
    expect(codexConversationRecoveryReason({})).toBe("unknown");
    expect(codexConversationRecoveryReason({ futureError: { httpStatusCode: null } })).toBe(
      "unknown",
    );
  });

  test("reads disconnect evidence from the message the way the runtime does", () => {
    expect(codexConversationRecoveryReason("other", "stream disconnected before completion")).toBe(
      "connection",
    );
    expect(codexConversationRecoveryReason("other", "Something broke.")).toBe("unknown");
  });
});

describe("provider retry progress", () => {
  test.each([
    "Reconnecting... 2/5",
    "Retrying… 2 / 5",
    "Service is busy, RECONNECTING 2/5",
    "Retrying 2/5. Please wait.",
  ])("reads explicit provider progress from %s", (message) => {
    expect(parseConversationRetryProgress(message)).toEqual({ attempt: 2, maxAttempts: 5 });
  });

  test("preserves supplied counters instead of clamping them to a guessed retry budget", () => {
    expect(parseConversationRetryProgress("Retrying 6/5")).toEqual({ attempt: 6, maxAttempts: 5 });
    expect(parseConversationRetryProgress("Retrying 9007199254740991/9007199254740991")).toEqual({
      attempt: Number.MAX_SAFE_INTEGER,
      maxAttempts: Number.MAX_SAFE_INTEGER,
    });
  });

  test.each([
    "Claude API unknown.",
    "Retrying request",
    "Request failed after 2/5 attempts",
    "Retrying 0/5",
    "Retrying 1/0",
    "Retrying -1/5",
    "Retrying 1/-5",
    "Retrying 1.5/5",
    "Retrying 1/2.5",
    "Retrying 9007199254740992/5",
    "Retrying 1/9007199254740992",
  ])("does not invent valid progress from %s", (message) => {
    expect(parseConversationRetryProgress(message)).toBeNull();
  });
});

describe("network waits", () => {
  test.each([
    ["Reconnecting... waiting for network", true],
    ["Waiting for the network", true],
    ["Reconnecting... 2/5", false],
    ["The network request failed", false],
    [null, false],
  ] as const)("%s → %s", (message, expected) => {
    expect(isWaitingForNetworkMessage(message)).toBe(expected);
  });
});
