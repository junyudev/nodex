import { expect, test } from "vite-plus/test";
import { reduceCodexConversationEvent } from "../../shared/codex-conversation-state/codex-conversation-reducer";
import { buildCodexCanonicalTurnSummary } from "./CodexConversationServerRequestProjection";
import { projectCodexConversationTurn } from "./CodexConversationSnapshotProjection";
import { conversationFixture, turnFixture } from "./conversation-test-fixture";

test("projects actual assistant start independently of hydration and projection clocks", () => {
  const state = conversationFixture("child", [
    { ...turnFixture("turn", "inProgress"), startedAt: 1, completedAt: null },
  ]);
  const next = reduceCodexConversationEvent(
    state,
    {
      type: "notification",
      notification: {
        method: "item/started",
        params: {
          threadId: "child",
          turnId: "turn",
          startedAtMs: 2500,
          item: {
            type: "agentMessage",
            id: "answer",
            text: "",
            phase: "final_answer",
            questions: null,
            memoryCitation: null,
            delivery: null,
          },
        },
      },
    },
    { now: () => 10000 },
  );
  const projected = projectCodexConversationTurn({
    threadId: "child",
    turnIndex: 0,
    beforeTurn: state.turns[0]!,
    afterTurn: next.turns[0]!,
    current: null,
    observedAtMs: 20000,
  });
  expect(projected.assistantMessageStartedAtMsById).toEqual({ answer: 2500 });
  expect(projected.turnStartedAtMs).toBe(1000);
  expect(projected.completedAt).toBeNull();
  expect(
    buildCodexCanonicalTurnSummary("child", next.turns[0]!, ["answer"])
      .assistantMessageStartedAtMsById,
  ).toEqual({ answer: 2500 });
});
