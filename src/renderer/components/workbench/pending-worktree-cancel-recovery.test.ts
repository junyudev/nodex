import { describe, expect, test } from "vite-plus/test";
import type { CodexPendingWorktreeEntry } from "../../../shared/codex-pending-worktree";
import {
  buildCancelledPendingWorktreeComposerIntent,
  resolveCancelledPendingWorktreeProjectId,
} from "./pending-worktree-cancel-recovery";

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
      agentMode: "auto",
      shouldSendPermissionOverrides: true,
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
    pinnedBeforeThreadId: null,
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
