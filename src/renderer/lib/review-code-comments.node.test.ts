import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationSnapshot } from "./types";
import {
  extractReviewCodeCommentsFromConversation,
  filterReviewCodeCommentsForPath,
  parseReviewCodeComments,
} from "./review-code-comments";

function buildConversationWithComment(text: string): CodexConversationSnapshot {
  return {
    threadId: "thread-review",
    projectId: "project",
    source: null,
    threadName: "Review",
    threadPreview: "",
    modelProvider: "codex",
    cwd: "/tmp/review",
    statusType: "idle",
    statusActiveFlags: [],
    archived: false,
    createdAt: 1,
    updatedAt: 1,
    linkedAt: "2026-06-09T00:00:00.000Z",
    resumeState: "resumed",
    turns: [
      {
        threadId: "thread-review",
        turnId: "turn-1",
        status: "completed",
        itemIds: ["item-1"],
        items: [
          {
            threadId: "thread-review",
            turnId: "turn-1",
            itemId: "item-1",
            type: "message",
            kind: "assistantMessage",
            role: "assistant",
            markdownText: text,
            rawItem: { content: [{ text }] },
            createdAt: 1,
            updatedAt: 1,
          },
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
      canEditUserTurns: true,
      canForkFromTurn: true,
      canSearch: true,
      canCollapseTurns: true,
    },
  };
}

describe("review code comments", () => {
  test("parses code-comment directives", () => {
    const comments = parseReviewCodeComments(
      '::code-comment{title="Check" body="Tighten this branch." file="src/a.ts" start=4 end=5 priority=2}',
    );

    expect(comments.length).toBe(1);
    expect(comments[0]?.title).toBe("Check");
    expect(comments[0]?.file).toBe("src/a.ts");
    expect(comments[0]?.start).toBe(4);
    expect(comments[0]?.end).toBe(5);
    expect(comments[0]?.priority).toBe(2);
  });

  test("deduplicates comments extracted from conversation strings", () => {
    const directive =
      '::code-comment{title="Check" body="Body" file="src/a.ts" start=1 priority=1}';
    const comments = extractReviewCodeCommentsFromConversation(
      buildConversationWithComment(directive),
    );

    expect(comments.length).toBe(1);
    expect(comments[0]?.body).toBe("Body");
  });

  test("matches absolute and relative comment paths", () => {
    const comments = parseReviewCodeComments(
      '::code-comment{title="Check" body="Body" file="/tmp/review/src/a.ts" start=1}',
    );
    const matches = filterReviewCodeCommentsForPath(comments, "src/a.ts");

    expect(matches.length).toBe(1);
  });
});
