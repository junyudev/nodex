import { describe, expect, test } from "vite-plus/test";
import type { CodexFrameTextDeltaUpdate } from "./codex-frame-text-delta-queue";
import { CodexFrameTextDeltaSequenceTracker } from "./codex-frame-text-delta-sequence-tracker";

const delta = (
  text: string,
  overrides: Partial<CodexFrameTextDeltaUpdate> = {},
): CodexFrameTextDeltaUpdate => ({
  conversationId: "conversation-a",
  turnId: "turn-a",
  itemId: "item-a",
  target: { type: "agentMessage" },
  delta: text,
  ...overrides,
});

describe("CodexFrameTextDeltaSequenceTracker", () => {
  test("attributes partial coalesced frame flushes to exact completed sequences", () => {
    const tracker = new CodexFrameTextDeltaSequenceTracker();
    tracker.track(delta("abc"), 1);
    tracker.track(delta("de"), 2);
    tracker.track(delta(""), 3);

    expect(tracker.consume([delta("abcd")])).toEqual(new Map([["conversation-a", [1]]]));
    expect(tracker.consume([delta("e")])).toEqual(new Map([["conversation-a", [2, 3]]]));
  });

  test("rejects segment and code-unit pressure before growing its arrays", () => {
    const tracker = new CodexFrameTextDeltaSequenceTracker({
      maxSegments: 3,
      maxSegmentsPerKey: 2,
      maxCodeUnits: 4,
    });
    expect(tracker.track(delta("ab"), 1)).toEqual({ accepted: true });
    expect(tracker.track(delta("c"), 2)).toEqual({ accepted: true });
    expect(tracker.track(delta("d"), 3)).toMatchObject({
      accepted: false,
      reason: "per-key-segment-count",
      trackedSegments: 2,
      trackedCodeUnits: 3,
    });
    expect(
      tracker.track(delta("de", { conversationId: "conversation-b", itemId: "item-b" }), 4),
    ).toMatchObject({ accepted: false, reason: "code-units" });
    expect(
      tracker.track(delta("d", { conversationId: "conversation-b", itemId: "item-b" }), 5),
    ).toEqual({ accepted: true });
    expect(
      tracker.track(delta("", { conversationId: "conversation-c", itemId: "item-c" }), 6),
    ).toMatchObject({ accepted: false, reason: "segment-count" });
  });

  test("conversation discard releases exact segment and code-unit admission", () => {
    const tracker = new CodexFrameTextDeltaSequenceTracker({
      maxSegments: 2,
      maxSegmentsPerKey: 2,
      maxCodeUnits: 3,
    });
    tracker.track(delta("abc"), 1);
    tracker.discardConversation("conversation-a");
    expect(
      tracker.track(delta("xyz", { conversationId: "conversation-b", itemId: "item-b" }), 2),
    ).toEqual({ accepted: true });
    expect(
      tracker.consume([delta("xyz", { conversationId: "conversation-b", itemId: "item-b" })]),
    ).toEqual(new Map([["conversation-b", [2]]]));
  });
});
