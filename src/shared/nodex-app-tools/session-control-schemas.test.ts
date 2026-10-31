import { describe, expect, it } from "vitest";
import { sessionControlSchemas, sessionQueueSchema } from "./session-control-schemas";
import { readSessionQueue, reorderedQueueIds } from "./session-queue";

describe("Session controls", () => {
  it("validates exact action fields and bounded windows", () => {
    expect(
      sessionControlSchemas.stop_session.safeParse({
        sessionId: "target",
        execution: { threadId: "child" },
        reason: "cancelled",
      }).success,
    ).toBe(true);
    expect(sessionControlSchemas.set_session_unread.parse({ unread: false })).toEqual({
      unread: false,
    });
    for (const args of [
      { action: "edit", queuedId: "id" },
      { action: "reorder", queuedId: "id" },
      { action: "list", limit: 21 },
      { action: "remove", queuedId: "id", text: "ignored" },
      { action: "list", cursor: "" },
      { action: "steer" },
    ])
      expect(sessionQueueSchema.safeParse({ sessionId: "target", ...args }).success).toBe(false);
    expect(sessionQueueSchema.parse({ sessionId: "target", action: "list" })).toEqual({
      sessionId: "target",
      action: "list",
      limit: 20,
    });
    expect(
      sessionQueueSchema.safeParse({
        sessionId: "target",
        action: "reorder",
        queuedId: "id",
        beforeId: null,
      }).success,
    ).toBe(true);
  });
  it("moves stable identities before another entry or to the end", () => {
    expect(reorderedQueueIds(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(reorderedQueueIds(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
    expect(() => reorderedQueueIds(["a"], "started", null)).toThrow();
    expect(() => reorderedQueueIds(["a"], "a", "started")).toThrow();
  });
  it("bounds native queue pages by Unicode characters and rejects cross-execution cursors", () => {
    const entries = [
      {
        queuedId: "one",
        text: "😀".repeat(7000),
        truncated: false,
        kind: "message" as const,
        held: true,
      },
      { queuedId: "two", text: "second", truncated: false, kind: "message" as const, held: false },
    ];
    const listed = readSessionQueue("thread", entries, {
      sessionId: "session",
      action: "list",
      limit: 1,
    });
    if (!("items" in listed)) throw new Error("Expected page");
    expect(listed.items[0]?.text).toBe("😀".repeat(250));
    expect(listed.items[0]?.truncated).toBe(true);
    expect(() =>
      readSessionQueue("another", entries, {
        sessionId: "session",
        action: "list",
        limit: 1,
        cursor: listed.nextCursor!,
      }),
    ).toThrow();
    const read = readSessionQueue("thread", entries, {
      sessionId: "session",
      action: "read",
      queuedId: "one",
    });
    if (!("queuedId" in read)) throw new Error("Expected message");
    expect(read.text).toBe("😀".repeat(6000));
    expect(read.truncated).toBe(true);
    expect(read.held).toBe(true);
  });
});
