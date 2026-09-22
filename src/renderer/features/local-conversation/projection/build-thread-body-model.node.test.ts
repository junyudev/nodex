import { describe, expect, test } from "vite-plus/test";
import { buildCodexFileChangeMap } from "../../../../shared/codex-file-change";
import type { CodexConversationItem, CodexConversationSnapshot } from "../../../lib/types";
import {
  buildThreadBodyModel as buildCanonicalThreadBodyModel,
  resolveThreadStartProgressPresentation,
  type ThreadBodyModelInput,
} from "./build-thread-body-model";

function buildThreadBodyModel(
  input: Omit<ThreadBodyModelInput, "activeThreadArchived"> & {
    activeThreadArchived?: boolean;
  },
) {
  return buildCanonicalThreadBodyModel({
    ...input,
    activeThreadArchived: input.activeThreadArchived ?? false,
  });
}

function buildEntry(overrides: Partial<CodexConversationItem>): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: "item_1",
    type: "agent_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildConversation(
  overrides?: Partial<CodexConversationSnapshot>,
): CodexConversationSnapshot {
  return {
    threadId: "thread_1",
    projectId: "project_1",
    source: overrides?.source ?? null,
    threadName: "Thread",
    threadPreview: "Preview",
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
        threadId: "thread_1",
        turnId: "turn_1",
        status: "inProgress",
        itemIds: ["user_1", "assistant_1"],
        items: [
          buildEntry({
            itemId: "user_1",
            type: "user_message",
            kind: "userMessage",
            semanticKind: "userMessage",
            role: "user",
            markdownText: "Please refactor this.",
          }),
          buildEntry({
            itemId: "assistant_1",
            type: "assistant_message",
            kind: "assistantMessage",
            role: "assistant",
            markdownText: "Working on it.",
          }),
        ],
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

describe("buildThreadBodyModel", () => {
  test("returns shell state without eagerly projecting all turn models", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation(),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.threadId).toBe("thread_1");
    expect(model.turnCount).toBe(1);
    expect(model.latestTurnId).toBe("turn_1");
    expect(model.activeTurnId).toBe("turn_1");
    expect(model.emptyState.type).toBe("none");
  });

  test("prepares a selected thread explicitly while its canonical snapshot is unavailable", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: null,
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.threadId).toBe("thread_1");
    expect(model.emptyState.type).toBe("resumingThread");
    if (model.emptyState.type === "resumingThread") {
      expect(model.emptyState.status).toBe("needs_resume");
    }
  });

  test("projects a settled attachment failure instead of an endless restore loader", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: null,
      attachmentState: {
        status: "failed",
        message: "Codex connection timed out",
      },
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.emptyState).toEqual({
      type: "threadAttachmentFailed",
      title: "Thread could not be restored",
      description: "Codex connection timed out",
    });
  });

  test("keeps cached transcript visible when attachment activation fails", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation({ resumeState: "needs_resume" }),
      attachmentState: {
        status: "failed",
        message: "Owner publication failed",
      },
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.turnCount).toBe(1);
    expect(model.emptyState.type).toBe("none");
  });

  test("fails closed when the loaded snapshot belongs to another selected thread", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_2",
      conversation: buildConversation(),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.threadId).toBe("thread_2");
    expect(model.turnCount).toBe(0);
    expect(model.emptyState.type).toBe("resumingThread");
  });

  test("keeps selected archive state authoritative before a snapshot is mounted", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: null,
      activeThreadArchived: true,
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.threadId).toBe("thread_1");
    expect(model.emptyState.type).toBe("archivedThread");
  });

  test("keeps fixed-content candidates inside the active turn shell entry", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation({
        turns: [
          {
            threadId: "thread_1",
            turnId: "turn_1",
            status: "inProgress",
            itemIds: ["todo_1", "assistant_1"],
            items: [
              buildEntry({
                itemId: "todo_1",
                type: "todo_list",
                kind: "plan",
                semanticKind: "todoList",
                markdownText: "- [ ] ship it",
              }),
              buildEntry({
                itemId: "assistant_1",
                type: "assistant_message",
                kind: "assistantMessage",
                role: "assistant",
                markdownText: "Still working",
              }),
            ],
          },
        ],
      }),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.activeTurnId).toBe("turn_1");
    expect(model.latestTurnId).toBe("turn_1");
  });

  test("keeps canonical blocking state scoped to the active turn projection", () => {
    const conversation = buildConversation({
      turns: [
        {
          threadId: "thread_1",
          turnId: "turn_1",
          status: "inProgress",
          itemIds: ["todo_1"],
          items: [
            buildEntry({
              itemId: "todo_1",
              type: "todo_list",
              kind: "plan",
              semanticKind: "todoList",
              markdownText: "- [ ] ship it",
            }),
          ],
        },
      ],
    });
    const model = buildThreadBodyModel({
      activeThreadId: conversation.threadId,
      conversation: buildConversation({
        turns: conversation.turns,
        canonicalRequests: [
          {
            id: "option_active",
            method: "item/tool/requestOptionPicker",
            params: {
              threadId: conversation.threadId,
              turnId: "turn_1",
              question: "Choose the next slice",
              options: [{ label: "UI" }],
            },
          },
        ],
      }),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.activeTurnId).toBe("turn_1");
    expect(model.turnCount).toBe(1);
  });

  test("keeps one active shell entry when live fileChange rows coexist with turn diff", () => {
    const liveDiff = ["--- a/src/app.ts", "+++ b/src/app.ts", "@@ -1 +1 @@", "-old", "+new"].join(
      "\n",
    );
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation({
        turns: [
          {
            threadId: "thread_1",
            turnId: "turn_1",
            status: "inProgress",
            diff: liveDiff,
            itemIds: ["user_1", "patch_live"],
            items: [
              buildEntry({
                itemId: "user_1",
                type: "user_message",
                kind: "userMessage",
                semanticKind: "userMessage",
                role: "user",
                markdownText: "Edit src/app.ts.",
              }),
              buildEntry({
                itemId: "patch_live",
                type: "file_change",
                kind: "fileChange",
                semanticKind: "patch",
                status: "inProgress",
                fileChange: {
                  changes: buildCodexFileChangeMap([
                    {
                      type: "update",
                      path: "src/app.ts",
                      unifiedDiff: liveDiff,
                      movePath: null,
                    },
                  ]),
                  label: "Edited src/app.ts",
                },
              }),
            ],
          },
        ],
      }),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.activeTurnId).toBe("turn_1");
    expect(model.turnCount).toBe(1);
  });

  test("renders archived threads as restorable instead of resuming", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation({
        archived: true,
        resumeState: "needs_resume",
      }),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.threadId).toBe("thread_1");
    expect(model.emptyState.type).toBe("archivedThread");
    if (model.emptyState.type === "archivedThread") {
      expect(model.emptyState.title).toBe("Archived thread");
    }
  });

  test("keeps local-project start progress silent for a resumed empty thread", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation({
        turns: [],
        resumeState: "resumed",
      }),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: {
        runInTarget: "localProject",
        threadId: "thread_1",
        phase: "startingThread",
        message: "Sending message…",
        outputText: "",
        updatedAt: 10,
      },
    });

    expect(model.showThreadStartProgressPanel).toBe(false);
    expect(model.emptyState.type).toBe("none");
  });

  test("keeps an attached local thread visibly preparing until its first snapshot arrives", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: null,
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: {
        runInTarget: "localProject",
        threadId: "thread_1",
        phase: "ready",
        message: "Message sent.",
        outputText: "",
        updatedAt: 10,
      },
    });

    expect(model.showThreadStartProgressPanel).toBe(false);
    expect(model.emptyState.type).toBe("resumingThread");
    if (model.emptyState.type === "resumingThread") {
      expect(model.emptyState.title).toBe("Preparing thread");
    }
  });

  test("shows local-project failures as thread start progress", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation({
        turns: [],
        resumeState: "resumed",
      }),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: {
        runInTarget: "localProject",
        threadId: "thread_1",
        phase: "failed",
        message: "Message could not be sent.",
        outputText: "boom",
        updatedAt: 10,
      },
    });

    expect(model.showThreadStartProgressPanel).toBe(true);
    expect(model.emptyState.type).toBe("none");
  });

  test("shows new-worktree setup progress", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation({
        turns: [],
        resumeState: "resumed",
      }),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: {
        runInTarget: "newWorktree",
        threadId: "thread_1",
        phase: "runningSetup",
        message: "Preparing worktree...",
        outputText: "setup log",
        updatedAt: 10,
      },
    });

    expect(model.showThreadStartProgressPanel).toBe(true);
    expect(model.emptyState.type).toBe("none");
  });

  test("renders normal transcript state for an in-progress first turn with local progress", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation({
        statusType: "active",
      }),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: {
        runInTarget: "localProject",
        threadId: "thread_1",
        phase: "ready",
        message: "Message sent.",
        outputText: "",
        updatedAt: 10,
      },
    });

    expect(model.showThreadStartProgressPanel).toBe(false);
    expect(model.turnCount).toBe(1);
    expect(model.activeTurnId).toBe("turn_1");
    expect(model.emptyState.type).toBe("none");
  });

  test("classifies thread start progress presentation by target and phase", () => {
    expect(
      resolveThreadStartProgressPresentation({
        runInTarget: "localProject",
        phase: "startingThread",
      }),
    ).toBe("hidden");
    expect(
      resolveThreadStartProgressPresentation({
        runInTarget: "localProject",
        phase: "failed",
      }),
    ).toBe("panel");
    expect(
      resolveThreadStartProgressPresentation({
        runInTarget: "newWorktree",
        phase: "runningSetup",
      }),
    ).toBe("panel");
    expect(
      resolveThreadStartProgressPresentation({
        runInTarget: "newWorktree",
        phase: "ready",
      }),
    ).toBe("hidden");
  });

  test("keeps true resumed empty threads as empty", () => {
    const model = buildThreadBodyModel({
      activeThreadId: "thread_1",
      conversation: buildConversation({
        turns: [],
        resumeState: "resumed",
      }),
      parentTurns: [],
      isNewThreadTab: false,
      newThreadTarget: null,
      isCloudNewThreadTarget: false,
      threadStartProgress: null,
    });

    expect(model.showThreadStartProgressPanel).toBe(false);
    expect(model.emptyState.type).toBe("emptyThread");
  });
});

test("renders an attached read-only transcript without resuming its execution", () => {
  const conversation = buildConversation({ resumeState: "needs_resume" });
  const input = {
    activeThreadId: conversation.threadId,
    conversation,
    attachmentState: { status: "attached" as const },
    activeThreadArchived: false,
    parentTurns: [],
    isNewThreadTab: false,
    newThreadTarget: null,
    isCloudNewThreadTarget: false,
    threadStartProgress: null,
  };
  expect(buildThreadBodyModel({ ...input, readOnly: true })).toMatchObject({
    turnCount: 1,
    emptyState: { type: "none" },
  });
  expect(buildThreadBodyModel(input).emptyState.type).toBe("resumingThread");
});
