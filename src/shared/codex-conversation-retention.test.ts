import { describe, expect, test } from "vite-plus/test";
import {
  shouldKeepCodexConversationLoaded,
  projectCodexConversationAfterUnsubscribe,
  canReleasePassiveCodexHistory,
  projectCodexConversationWithoutHistory,
} from "./codex-conversation-retention";
import type { CodexConversationSnapshot } from "./types";

const snapshot = (patch: Partial<CodexConversationSnapshot> = {}): CodexConversationSnapshot =>
  ({
    threadId: "thread",
    statusType: "idle",
    statusActiveFlags: [],
    resumeState: "resumed",
    turns: [{ threadId: "thread", turnId: "turn", status: "completed", items: [], itemIds: [] }],
    requests: [],
    pendingSteers: [],
    ...patch,
  }) as CodexConversationSnapshot;

describe("conversation history retention", () => {
  test("protects steering until its server message echo, even after command acknowledgement", () => {
    const conversation = snapshot();
    const canonical = {
      ...{ rolloutPath: "/rollout" },
      requests: [],
      turns: [
        {
          items: [
            {
              type: "steeringUserMessage",
              status: "accepted",
              serverUserMessageId: null as string | null,
            },
          ],
        },
      ],
    };
    conversation.canonicalState = canonical as unknown as NonNullable<
      CodexConversationSnapshot["canonicalState"]
    >;
    expect(shouldKeepCodexConversationLoaded(conversation)).toBe(true);
    canonical.turns[0]!.items[0]!.serverUserMessageId = "echo";
    expect(shouldKeepCodexConversationLoaded(conversation)).toBe(false);
  });
  test("protects a proven empty unpersisted conversation but not an unloaded history window", () => {
    const conversation = snapshot({
      turns: [],
      canonicalState: {
        ...{ rolloutPath: null },
        turns: [],
        requests: [],
      } as unknown as NonNullable<CodexConversationSnapshot["canonicalState"]>,
    });
    expect(shouldKeepCodexConversationLoaded(conversation)).toBe(true);
    conversation.turnPagination = {
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: null,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 0,
      itemsView: "full",
    };
    expect(shouldKeepCodexConversationLoaded(conversation)).toBe(false);
  });
  test("allows a persistent waiting turn to unsubscribe while retaining the question and status", () => {
    const conversation = snapshot({
      turns: [{ threadId: "thread", turnId: "turn", status: "inProgress", items: [], itemIds: [] }],
      requests: [
        {
          type: "userInput",
          requestId: 1,
          threadId: "thread",
          turnId: "turn",
          questions: [],
          isBlocking: true,
        } as unknown as CodexConversationSnapshot["requests"][number],
      ],
    });
    expect(shouldKeepCodexConversationLoaded(conversation)).toBe(false);
    const after = projectCodexConversationAfterUnsubscribe(conversation, false);
    expect(after.turns).toEqual([]);
    expect(after.requests).toBe(conversation.requests);
    expect(after.statusActiveFlags).toEqual(["waitingOnUserInput"]);
    expect(after.resumeState).toBe("needs_resume");
    expect(
      shouldKeepCodexConversationLoaded({
        ...conversation,
        ephemeral: true,
        source: { parentThreadId: "parent", sideConversation: true },
      }),
    ).toBe(true);
  });
});

test("releases passive content but preserves explicit pagination, active hydration, requests and fork-only history", () => {
  const conversation = snapshot({
    turns: [
      {
        threadId: "thread",
        turnId: "turn",
        status: "completed",
        itemIds: ["message"],
        items: [
          {
            threadId: "passive",
            turnId: "turn",
            itemId: "message",
            type: "agentMessage",
            kind: "assistantMessage",
            markdownText: "history",
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    ],
  } as Partial<CodexConversationSnapshot>);
  expect(canReleasePassiveCodexHistory(conversation)).toBe(true);
  const released = projectCodexConversationWithoutHistory(conversation);
  expect(released.turns).toEqual([]);
  expect(released.statusType).toBe(conversation.statusType);
  expect(released.turnPagination?.hasLoadedOldest).toBe(false);
  expect(canReleasePassiveCodexHistory({ ...conversation, resumeState: "resuming" })).toBe(false);
  expect(canReleasePassiveCodexHistory({ ...conversation, resumeState: "needs_resume" })).toBe(
    false,
  );
  const pagination = released.turnPagination!;
  expect(
    canReleasePassiveCodexHistory({
      ...conversation,
      resumeState: "needs_resume",
      turnPagination: pagination,
    }),
  ).toBe(true);
  expect(
    canReleasePassiveCodexHistory({
      ...conversation,
      resumeState: "needs_resume",
      turnPagination: { ...pagination, olderCursor: "explicit-read" },
    }),
  ).toBe(false);
  expect(
    canReleasePassiveCodexHistory({
      ...conversation,
      turnPagination: { ...pagination, isLoadingOlder: true },
    }),
  ).toBe(false);
  expect(canReleasePassiveCodexHistory({ ...conversation, statusType: "active" })).toBe(false);
  expect(
    canReleasePassiveCodexHistory({
      ...conversation,
      turns: [
        {
          ...conversation.turns[0]!,
          items: [{ ...conversation.turns[0]!.items[0]!, type: "forkedFromConversation" }],
        },
      ],
    }),
  ).toBe(false);
});
