import { describe, expect, test } from "vite-plus/test";
import type { ProjectSessionSummary } from "../../shared/types";
import {
  buildProjectAgentDockModel,
  buildProjectAgentDockPendingWorktreeModel,
  resolveProjectAgentDockPendingWorktree,
  type ProjectAgentDockPendingWorktreeEntry,
} from "./project-agent-dock-model";

function session(
  id: string,
  overrides: Partial<ProjectSessionSummary> = {},
): ProjectSessionSummary {
  return {
    id,
    projectId: "project-1",
    noThreadFallbackTitle: "New chat",
    displayTitle: id,
    order: 0,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function pendingWorktree(
  overrides: Partial<ProjectAgentDockPendingWorktreeEntry> = {},
): ProjectAgentDockPendingWorktreeEntry {
  return {
    launchMode: "start-conversation",
    firstSubmission: {
      launchId: "01991e60-b800-7000-8000-000000000101",
      clientUserMessageId: "01991e60-b800-7000-8000-000000000102",
    },
    id: "pending-1",
    hostId: "host-1",
    clientThreadId: "client-1",
    projectSessionId: "session-1",
    label: "Task",
    sourceWorkspaceRoot: "/tmp/project",
    localEnvironmentConfigPath: null,
    prompt: "Do the work",
    startConversationParamsInput:
      {} as ProjectAgentDockPendingWorktreeEntry["startConversationParamsInput"],
    sourceConversationId: null,
    sourceCollaborationMode: null,
    createdAt: 1,
    attempt: 1,
    phase: "creating",
    labelEdited: false,
    worktreeOutputText: "",
    setupOutputText: "",
    errorMessage: null,
    worktreeWorkspaceRoot: null,
    worktreeGitRoot: null,
    needsAttention: false,
    isPinned: false,
    pinnedBeforeThreadId: null,
    ...overrides,
  };
}

describe("buildProjectAgentDockModel", () => {
  test("keeps New chat immediately available while the collection loads", () => {
    const model = buildProjectAgentDockModel({
      projectId: "project-1",
      dock: {
        binding: { kind: "new" },
        newDraftId: "draft-1",
      },
      summaries: [],
      exactSelectedSession: null,
      collectionState: { kind: "loading" },
      hasMore: false,
      query: "",
    });

    expect(model.trigger.label).toBe("New chat");
    expect(model.rows.map((row) => row.label)).toEqual(["New chat"]);
    expect(model.canSend).toBe(true);
    expect(model.collectionMessage).toBe("Loading chats…");
  });

  test("uses sidebar ordering and compact indicator precedence", () => {
    const model = buildProjectAgentDockModel({
      projectId: "project-1",
      dock: {
        binding: { kind: "session", sessionId: "approval" },
        newDraftId: "draft-1",
      },
      summaries: [
        session("running", {
          order: 0,
          thread: {
            sessionId: "running",
            projectId: "project-1",
            threadId: "thread-running",
            threadPreview: "Working",
            backendBinding: { kind: "codex" },
            executionHostId: "local",
            statusType: "active",
            statusActiveFlags: [],
            archived: false,
            createdAt: 1,
            updatedAt: 1,
            linkedAt: "2026-08-01T00:00:00.000Z",
          },
        }),
        session("approval", {
          pinned: true,
          pinnedOrder: 0,
          thread: {
            sessionId: "approval",
            projectId: "project-1",
            threadId: "thread-approval",
            threadPreview: "Needs review",
            backendBinding: { kind: "codex" },
            executionHostId: "local",
            statusType: "active",
            statusActiveFlags: ["waitingOnApproval"],
            archived: false,
            createdAt: 1,
            updatedAt: 1,
            linkedAt: "2026-08-01T00:00:00.000Z",
          },
        }),
      ],
      exactSelectedSession: session("approval"),
      collectionState: { kind: "ready", refreshError: null },
      hasMore: true,
      query: "",
    });

    expect(model.rows.map((row) => row.label)).toEqual(["New chat", "approval", "running"]);
    expect(model.trigger.attention).toBe("request");
    expect(model.trigger.indicator).toBe("needs-attention");
    expect(model.rows[2]?.indicator).toBe("running");
    expect(model.hasMore).toBe(true);
  });

  test("projects unread state into the same compact indicator language as the sidebar", () => {
    const model = buildProjectAgentDockModel({
      projectId: "project-1",
      dock: {
        binding: { kind: "session", sessionId: "unread" },
        newDraftId: "draft-1",
      },
      summaries: [session("unread", { unread: true })],
      exactSelectedSession: session("unread", { unread: true }),
      collectionState: { kind: "ready", refreshError: null },
      hasMore: false,
      query: "",
    });

    expect(model.trigger.indicator).toBe("unread");
    expect(model.trigger.attention).toBe("activity");
  });

  test("filters loaded chats without hiding the New chat row", () => {
    const model = buildProjectAgentDockModel({
      projectId: "project-1",
      dock: {
        binding: { kind: "new" },
        newDraftId: "draft-1",
      },
      summaries: [session("Alpha"), session("Beta")],
      exactSelectedSession: null,
      collectionState: { kind: "ready", refreshError: null },
      hasMore: false,
      query: "beta",
    });

    expect(model.rows.map((row) => row.label)).toEqual(["New chat", "Beta"]);
  });
});

describe("Project Agent Dock pending worktree projection", () => {
  test("derives the latest exact pending entry and releases it after attachment", () => {
    const older = pendingWorktree();
    const latest = pendingWorktree({
      id: "pending-2",
      clientThreadId: "client-2",
      createdAt: 2,
      phase: "setting-up",
    });

    expect(
      resolveProjectAgentDockPendingWorktree(
        [pendingWorktree({ projectSessionId: "another-session" }), older, latest],
        "session-1",
        false,
      ),
    ).toBe(latest);
    expect(resolveProjectAgentDockPendingWorktree([latest], "session-1", true)).toBeNull();
  });

  test("maps progress and failure into compact Dock state", () => {
    expect(
      buildProjectAgentDockPendingWorktreeModel(pendingWorktree({ phase: "setting-up" })),
    ).toEqual({
      clientThreadId: "client-1",
      statusLabel: "Running setup…",
      composerBlockedReason: "Worktree setup is already in progress",
      attention: "activity",
    });
    expect(
      buildProjectAgentDockPendingWorktreeModel(
        pendingWorktree({ phase: "failed", needsAttention: true }),
      ),
    ).toEqual({
      clientThreadId: "client-1",
      statusLabel: "Setup failed",
      composerBlockedReason: "Resolve the failed worktree setup before starting this chat again",
      attention: "request",
    });
  });
});
