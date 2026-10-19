import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationSnapshot } from "./types";
import {
  applyCodexConversationStateUpdates,
  buildCodexConversationStateUpdates,
} from "./codex-conversation-patches";

function buildConversation(
  overrides?: Partial<CodexConversationSnapshot>,
): CodexConversationSnapshot {
  return {
    threadId: "thread-1",
    projectId: "project-1",
    source: overrides?.source ?? null,
    threadName: "Thread",
    threadPreview: "Preview",
    modelProvider: "openai",
    cwd: "/tmp/project",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 2,
    linkedAt: "2026-04-07T00:00:00.000Z",
    resumeState: "resumed",
    turns: [],
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
      canEditUserTurns: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
    ...overrides,
    hasUnreadTurn: overrides?.hasUnreadTurn ?? false,
  };
}

describe("codex-conversation-patches", () => {
  test("builds add patches for appended array entries and replays them", () => {
    const previous = buildConversation();
    const next = buildConversation({
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      ],
    });

    const patches = buildCodexConversationStateUpdates(previous, next);
    expect(String(patches.length)).toBe("1");
    expect(patches[0]?.op).toBe("add");
    expect((patches[0]?.path ?? []).join("/")).toBe("turns/0");

    const replayed = applyCodexConversationStateUpdates(previous, patches);
    expect(String(replayed.turns.length)).toBe("1");
    expect(replayed.turns[0]?.turnId).toBe("turn-1");
  });

  test("applies root replace patches", () => {
    const previous = buildConversation();
    const replacement = buildConversation({
      threadId: "thread-2",
      projectId: "project-2",
    });

    const replayed = applyCodexConversationStateUpdates(previous, [
      {
        op: "replace",
        path: [],
        value: replacement,
      },
    ]);

    expect(replayed.threadId).toBe("thread-2");
    expect(replayed.projectId).toBe("project-2");
  });

  test("applies array append patches that use the dash path segment", () => {
    const previous = buildConversation({
      turns: [
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
          itemIds: [],
          items: [],
        },
      ],
    });

    const replayed = applyCodexConversationStateUpdates(previous, [
      {
        op: "add",
        path: ["turns", "-"],
        value: {
          threadId: "thread-1",
          turnId: "turn-2",
          status: "inProgress",
          itemIds: [],
          items: [],
        },
      },
    ]);

    expect(String(replayed.turns.length)).toBe("2");
    expect(replayed.turns[1]?.turnId).toBe("turn-2");
  });
});
