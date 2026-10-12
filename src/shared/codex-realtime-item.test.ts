import { describe, expect, test } from "vite-plus/test";
import { normalizeCodexRealtimeItem } from "./codex-realtime-item";

describe("native realtime item boundary", () => {
  test("maps validated promotion identities while retaining session and presentation", () => {
    expect(
      normalizeCodexRealtimeItem({
        type: "bemItemPromoted",
        id: "receipt",
        realtimeSessionId: "session",
        turn_id: "turn",
        item_id: "item",
        presentation: { type: "inlineVisualization", index: 2 },
      }),
    ).toEqual({
      type: "bemItemPromoted",
      id: "receipt",
      realtimeSessionId: "session",
      turnId: "turn",
      itemId: "item",
      presentation: { type: "inlineVisualization", index: 2 },
    });
  });
  test("rejects incomplete or incorrectly typed wire identity rather than returning a partial receipt", () => {
    for (const invalid of [
      {
        type: "bemItemPromoted",
        id: "receipt",
        realtimeSessionId: "session",
        turnId: "turn",
        itemId: "item",
        presentation: { type: "wholeItem" },
      },
      {
        type: "bemItemPromoted",
        id: "receipt",
        realtimeSessionId: "session",
        turn_id: "turn",
        item_id: 2,
        presentation: { type: "wholeItem" },
      },
      {
        type: "bemItemPromoted",
        id: "receipt",
        realtimeSessionId: "session",
        turn_id: "turn",
        item_id: "item",
        presentation: { type: "inlineVisualization", index: -1 },
      },
      { type: "transcriptSegment", id: "segment", role: "assistant", text: "text" },
    ])
      expect(() => normalizeCodexRealtimeItem(invalid)).toThrow();
  });
  test("retains transcript and session lifecycles without interpreting the opaque session identity", () => {
    for (const item of [
      {
        type: "transcriptSegment",
        id: "segment",
        realtimeSessionId: "old-session",
        role: "assistant",
        text: "Hello",
      },
      { type: "realtimeSessionStarted", id: "start", realtimeSessionId: "session" },
      { type: "realtimeSessionClosed", id: "end", realtimeSessionId: "session", outcome: "ended" },
    ])
      expect(normalizeCodexRealtimeItem(item)).toEqual(item);
  });
});
