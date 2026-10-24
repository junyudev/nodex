import { expect, it } from "vitest";
import {
  isConversationReadInteraction,
  observeConversationReadState,
  type ConversationReadStateInput,
} from "./conversation-read-state-observer";

const readConversation: ConversationReadStateInput & { focused: boolean } = {
  identity: "local:thread",
  active: true,
  focused: true,
  hasConversation: true,
  hasUnreadTurn: false,
  hasPersistedUnreadTurn: false,
  latestRequestId: null,
  latestTurnId: "turn",
  latestTurnStatus: "completed",
  activityToken: null,
};

it("consumes persisted unread before the conversation has loaded", () => {
  const result = observeConversationReadState(null, {
    ...readConversation,
    hasConversation: false,
    hasPersistedUnreadTurn: true,
  });
  expect(result.shouldMarkRead).toBe(true);
});

it("preserves manual unread through unchanged activity and blur/refocus", () => {
  const observed = observeConversationReadState(null, readConversation).observation;
  const unread = { ...readConversation, hasUnreadTurn: true, hasPersistedUnreadTurn: true };
  const manual = observeConversationReadState(observed, unread);
  const blurred = observeConversationReadState(manual.observation, { ...unread, focused: false });
  const refocused = observeConversationReadState(blurred.observation, unread);
  expect([manual.shouldMarkRead, blurred.shouldMarkRead, refocused.shouldMarkRead]).toEqual([
    false,
    false,
    false,
  ]);
});

it("consumes a late completion event after the completed status was already observed", () => {
  const observed = observeConversationReadState(null, readConversation).observation;
  const unread = { ...readConversation, hasUnreadTurn: true, hasPersistedUnreadTurn: true };
  const pending = observeConversationReadState(observed, unread);
  expect(pending.shouldMarkRead).toBe(false);
  const activityToken = {
    hostId: "local",
    threadId: "thread",
    activity: { type: "turn-completed" as const, turnId: "turn" },
  };
  const completed = observeConversationReadState(pending.observation, {
    ...unread,
    activityToken,
  });
  expect(completed.shouldMarkRead).toBe(true);
  expect(
    observeConversationReadState(completed.observation, { ...unread, activityToken })
      .shouldMarkRead,
  ).toBe(false);
});

it("does not consume a completion for another turn", () => {
  const observed = observeConversationReadState(null, readConversation).observation;
  expect(
    observeConversationReadState(observed, {
      ...readConversation,
      hasUnreadTurn: true,
      activityToken: {
        hostId: "local",
        threadId: "thread",
        activity: { type: "turn-completed" as const, turnId: "other-turn" },
      },
    }).shouldMarkRead,
  ).toBe(false);
});

it("acknowledges completion before the local unread projection catches up", () => {
  const observed = observeConversationReadState(null, readConversation).observation;
  const activityToken = {
    hostId: "local",
    threadId: "thread",
    activity: { type: "turn-completed" as const, turnId: "turn" },
  };
  const completed = observeConversationReadState(observed, {
    ...readConversation,
    activityToken,
  });
  expect(completed.shouldMarkRead).toBe(true);
  expect(
    observeConversationReadState(completed.observation, { ...readConversation, activityToken })
      .shouldMarkRead,
  ).toBe(false);
});

it("retains an early completion until the turn projection catches up", () => {
  const observed = observeConversationReadState(null, readConversation).observation;
  const activityToken = {
    hostId: "local",
    threadId: "thread",
    activity: { type: "turn-completed" as const, turnId: "next-turn" },
  };
  const early = observeConversationReadState(observed, { ...readConversation, activityToken });
  expect(early.shouldMarkRead).toBe(false);
  const caughtUp = observeConversationReadState(early.observation, {
    ...readConversation,
    activityToken,
    latestTurnId: "next-turn",
  });
  expect(caughtUp.shouldMarkRead).toBe(true);
});

it("acknowledges a request before its unread projection and preserves a subsequent manual marker", () => {
  const observed = observeConversationReadState(null, readConversation).observation;
  const activityToken = {
    hostId: "local",
    threadId: "thread",
    activity: { type: "request" as const },
  };
  const request = observeConversationReadState(observed, { ...readConversation, activityToken });
  expect(request.shouldMarkRead).toBe(true);
  const manual = observeConversationReadState(request.observation, {
    ...readConversation,
    activityToken,
    hasUnreadTurn: true,
    hasPersistedUnreadTurn: true,
  });
  expect(manual.shouldMarkRead).toBe(false);
  expect(
    observeConversationReadState(manual.observation, {
      ...readConversation,
      activityToken: { ...activityToken },
    }).shouldMarkRead,
  ).toBe(true);
});

it.each([
  { latestRequestId: "approval" },
  { latestTurnId: "next-turn" },
  { latestTurnStatus: "failed" },
])("consumes unread when observed activity changes: %o", (activity) => {
  const observed = observeConversationReadState(null, readConversation).observation;
  expect(
    observeConversationReadState(observed, {
      ...readConversation,
      ...activity,
      hasUnreadTurn: true,
    }).shouldMarkRead,
  ).toBe(true);
});

it("reconciles persisted unread that arrives after a live conversation was read", () => {
  const observed = observeConversationReadState(null, readConversation).observation;
  expect(
    observeConversationReadState(observed, {
      ...readConversation,
      hasPersistedUnreadTurn: true,
    }).shouldMarkRead,
  ).toBe(true);
});

it("defers unread activity while blurred and resets observation for a new visible identity", () => {
  const observed = observeConversationReadState(null, readConversation).observation;
  const next = { ...readConversation, hasUnreadTurn: true, latestTurnId: "next-turn" };
  const blurred = observeConversationReadState(observed, { ...next, focused: false });
  expect(blurred.shouldMarkRead).toBe(false);
  expect(observeConversationReadState(blurred.observation, next).shouldMarkRead).toBe(true);
  const hidden = observeConversationReadState(observed, { ...next, active: false });
  expect(hidden.observation).toBeNull();
  expect(observeConversationReadState(hidden.observation, next).shouldMarkRead).toBe(true);
  expect(
    observeConversationReadState(observed, {
      ...readConversation,
      identity: "other-host:thread",
      hasUnreadTurn: true,
    }).shouldMarkRead,
  ).toBe(true);
});

it("ignores prevented interactions and modifier-only keys", () => {
  expect(isConversationReadInteraction({ type: "pointerdown", defaultPrevented: true })).toBe(
    false,
  );
  for (const key of ["Meta", "Control", "Alt", "AltGraph", "Shift"])
    expect(isConversationReadInteraction({ type: "keydown", key, defaultPrevented: false })).toBe(
      false,
    );
});
