import { describe, expect, test } from "vite-plus/test";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import {
  ASSISTANT_TURN_TIMESTAMP_GAP_MS,
  resolveConversationTimestampSeparators,
  resolveConversationTurnTimestampSeparators,
  USER_TURN_TIMESTAMP_GAP_MS,
} from "./conversation-turn-timestamps";

function buildItem(
  role: "user" | "assistant",
  overrides: Partial<CodexConversationItem> = {},
): CodexConversationItem {
  const isUser = role === "user";
  return {
    threadId: "thread_1",
    turnId: "turn_1",
    itemId: `${role}_1`,
    type: isUser ? "user_message" : "assistant_message",
    kind: isUser ? "userMessage" : "assistantMessage",
    semanticKind: isUser ? "userMessage" : "assistantMessage",
    role,
    markdownText: role,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function buildTurn(input: {
  id: string;
  turnStartedAtMs?: number | null;
  finalAssistantStartedAtMs?: number | null;
  roles?: readonly ("user" | "assistant")[];
}): CodexConversationTurn {
  const items = (input.roles ?? ["user", "assistant"]).map((role, index) =>
    buildItem(role, {
      turnId: input.id,
      itemId: `${input.id}_${role}_${index}`,
    }),
  );
  return {
    threadId: "thread_1",
    turnId: input.id,
    status: "completed",
    itemIds: items.map((item) => item.itemId),
    items,
    turnStartedAtMs: input.turnStartedAtMs,
    finalAssistantStartedAtMs: input.finalAssistantStartedAtMs,
  };
}

describe("resolveConversationTimestampSeparators", () => {
  test("shows an old first user turn only after the strict one-hour threshold", () => {
    const nowMs = 10 * USER_TURN_TIMESTAMP_GAP_MS;
    const exactlyOneHourAgo = nowMs - USER_TURN_TIMESTAMP_GAP_MS;
    const overOneHourAgo = exactlyOneHourAgo - 1;

    expect(
      resolveConversationTimestampSeparators(
        [[{ role: "user", sentAtMs: exactlyOneHourAgo }]],
        nowMs,
      ),
    ).toEqual([null]);
    expect(
      resolveConversationTimestampSeparators([[{ role: "user", sentAtMs: overOneHourAgo }]], nowMs),
    ).toEqual([overOneHourAgo]);
  });

  test("uses one hour from an assistant to a user and ten minutes to an assistant", () => {
    const firstAssistantAtMs = 1_000;
    const userAtBoundaryMs = firstAssistantAtMs + USER_TURN_TIMESTAMP_GAP_MS;
    const userPastBoundaryMs = userAtBoundaryMs + 1;
    const nextAssistantAtMs = userPastBoundaryMs + 1_000;
    const assistantAtBoundaryMs = nextAssistantAtMs + ASSISTANT_TURN_TIMESTAMP_GAP_MS;
    const assistantPastBoundaryMs = assistantAtBoundaryMs + ASSISTANT_TURN_TIMESTAMP_GAP_MS + 1;

    expect(
      resolveConversationTimestampSeparators(
        [
          [{ role: "assistant", sentAtMs: firstAssistantAtMs }],
          [{ role: "user", sentAtMs: userAtBoundaryMs }],
          [{ role: "user", sentAtMs: userPastBoundaryMs }],
          [{ role: "assistant", sentAtMs: nextAssistantAtMs }],
          [{ role: "assistant", sentAtMs: assistantAtBoundaryMs }],
          [{ role: "assistant", sentAtMs: assistantPastBoundaryMs }],
        ],
        firstAssistantAtMs,
      ),
    ).toEqual([null, null, null, null, null, assistantPastBoundaryMs]);
  });

  test("ignores invalid timestamps and emits at most one timestamp per group", () => {
    const separatorAtMs = USER_TURN_TIMESTAMP_GAP_MS + 2;
    expect(
      resolveConversationTimestampSeparators(
        [
          [{ role: "assistant", sentAtMs: Number.NaN }],
          [{ role: "assistant", sentAtMs: 1 }],
          [
            { role: "user", sentAtMs: separatorAtMs },
            { role: "assistant", sentAtMs: separatorAtMs + ASSISTANT_TURN_TIMESTAMP_GAP_MS + 1 },
          ],
        ],
        0,
      ),
    ).toEqual([null, null, separatorAtMs]);
  });

  test("history and explicit adjacency boundaries suppress comparisons across the break", () => {
    const oldUserAtMs = 1;
    const nowMs = oldUserAtMs + USER_TURN_TIMESTAMP_GAP_MS + 1;
    expect(
      resolveConversationTimestampSeparators(
        [null, [{ role: "user", sentAtMs: oldUserAtMs }]],
        nowMs,
      ),
    ).toEqual([null, null]);
    expect(
      resolveConversationTimestampSeparators(
        [
          [{ role: "assistant", sentAtMs: 1 }],
          [
            {
              role: "user",
              sentAtMs: USER_TURN_TIMESTAMP_GAP_MS + 2,
              breaksPreviousAdjacency: true,
            },
          ],
        ],
        0,
      ),
    ).toEqual([null, null]);
  });
});

describe("resolveConversationTurnTimestampSeparators", () => {
  test("uses canonical user and final-assistant timing fields", () => {
    const priorAssistantAtMs = 10_000;
    const nextUserAtMs = priorAssistantAtMs + USER_TURN_TIMESTAMP_GAP_MS + 1;
    const turns = [
      buildTurn({
        id: "turn_1",
        turnStartedAtMs: 1_000,
        finalAssistantStartedAtMs: priorAssistantAtMs,
      }),
      buildTurn({
        id: "turn_2",
        turnStartedAtMs: nextUserAtMs,
        finalAssistantStartedAtMs: nextUserAtMs + 1_000,
      }),
    ];

    expect(resolveConversationTurnTimestampSeparators(turns, { nowMs: 1_000 })).toEqual([
      null,
      nextUserAtMs,
    ]);
  });

  test("uses the ten-minute threshold for userless assistant continuations", () => {
    const priorAssistantAtMs = 10_000;
    const nextAssistantAtMs = priorAssistantAtMs + ASSISTANT_TURN_TIMESTAMP_GAP_MS + 1;
    const turns = [
      buildTurn({
        id: "turn_1",
        roles: ["assistant"],
        finalAssistantStartedAtMs: priorAssistantAtMs,
      }),
      buildTurn({
        id: "turn_2",
        roles: ["assistant"],
        finalAssistantStartedAtMs: nextAssistantAtMs,
      }),
    ];

    expect(resolveConversationTurnTimestampSeparators(turns, { nowMs: 0 })).toEqual([
      null,
      nextAssistantAtMs,
    ]);
  });

  test("does not label the first loaded turn when earlier history is not adjacent", () => {
    const oldUserAtMs = 1;
    const nowMs = oldUserAtMs + USER_TURN_TIMESTAMP_GAP_MS + 1;
    const turn = buildTurn({ id: "turn_1", turnStartedAtMs: oldUserAtMs });

    expect(
      resolveConversationTurnTimestampSeparators([turn], {
        nowMs,
        startsAfterHistoryBoundary: true,
      }),
    ).toEqual([null]);
  });

  test("does not treat hook feedback or steering-only rows as primary turn input", () => {
    const assistantAtMs = ASSISTANT_TURN_TIMESTAMP_GAP_MS + 2;
    const turn = buildTurn({
      id: "turn_1",
      roles: [],
      finalAssistantStartedAtMs: assistantAtMs,
    });
    turn.items = [
      buildItem("user", { hookFeedback: true }),
      buildItem("user", { type: "steeringUserMessage" }),
      buildItem("assistant"),
    ];

    expect(resolveConversationTurnTimestampSeparators([turn], { nowMs: 0 })).toEqual([null]);
  });
});
