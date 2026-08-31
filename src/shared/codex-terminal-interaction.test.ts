import { describe, expect, test } from "vite-plus/test";
import {
  CodexTerminalInteractionAccumulator,
  getTerminalInteractionBufferKey,
} from "./codex-terminal-interaction";

const first = {
  conversationId: "conversation-1",
  turnId: "turn-1",
  itemId: "command-1",
};

describe("Codex terminal interaction accumulator", () => {
  test("keeps fragmented input within its exact conversation, turn, and item identity", () => {
    const accumulator = new CodexTerminalInteractionAccumulator();
    const firstChunk = accumulator.accept(first, "ec", 1);
    const secondChunk = accumulator.accept(first, "ho", 2);
    const completed = accumulator.accept(first, " hello\rnext", 3);

    expect(firstChunk).toEqual({ disposition: "applied", commands: [] });
    expect(secondChunk).toEqual({ disposition: "applied", commands: [] });
    expect(completed).toEqual({ disposition: "applied", commands: ["echo hello"] });
    expect(accumulator.bufferedItemCount).toBe(1);
  });

  test("preserves terminal editing semantics without retaining a completed line", () => {
    const accumulator = new CodexTerminalInteractionAccumulator();
    const result = accumulator.accept(
      first,
      "carriage\rline\npaired\r\n discard\u0003echo 😀\b\r",
      1,
    );

    expect(result).toEqual({
      disposition: "applied",
      commands: ["carriage", "line", "paired", "echo \ud83d"],
    });
    expect(accumulator.bufferedItemCount).toBe(0);
    expect(accumulator.bufferedByteLength).toBe(0);
  });

  test("uses a turn-aware collision-free key", () => {
    expect(getTerminalInteractionBufferKey(first)).not.toBe(
      getTerminalInteractionBufferKey({ ...first, turnId: "turn-2" }),
    );
    expect(getTerminalInteractionBufferKey(first)).not.toBe(
      getTerminalInteractionBufferKey({ ...first, itemId: "command-2" }),
    );
  });

  test("fails closed on per-item, global-key, global-byte, and command pressure", () => {
    const itemLimited = new CodexTerminalInteractionAccumulator({
      maxBufferedBytesPerItem: 128,
    });
    expect(itemLimited.accept(first, "x".repeat(256), 1)).toMatchObject({
      disposition: "overflow",
      reason: "buffered-item-bytes",
    });
    expect(itemLimited.bufferedItemCount).toBe(0);

    const keyLimited = new CodexTerminalInteractionAccumulator({ maxBufferedItems: 1 });
    expect(keyLimited.accept(first, "partial", 1).disposition).toBe("applied");
    expect(keyLimited.accept({ ...first, itemId: "command-2" }, "partial", 2)).toMatchObject({
      disposition: "overflow",
      reason: "buffered-item-limit",
    });
    expect(keyLimited.bufferedItemCount).toBe(1);

    const byteLimited = new CodexTerminalInteractionAccumulator({
      maxBufferedBytesPerItem: 1_024,
      maxBufferedBytes: 140,
    });
    expect(byteLimited.accept(first, "x".repeat(70), 1).disposition).toBe("applied");
    expect(byteLimited.accept({ ...first, itemId: "command-2" }, "y".repeat(70), 2)).toMatchObject({
      disposition: "overflow",
      reason: "buffered-total-bytes",
    });
    expect(byteLimited.bufferedItemCount).toBe(1);

    const commandLimited = new CodexTerminalInteractionAccumulator({ maxCommandsPerInput: 1 });
    expect(commandLimited.accept(first, "one\ntwo\n", 1)).toEqual({
      disposition: "overflow",
      commands: [],
      reason: "command-count",
    });
    expect(commandLimited.bufferedItemCount).toBe(0);
  });

  test("cleans item, turn, conversation, and expired residual input", () => {
    const accumulator = new CodexTerminalInteractionAccumulator({ maxIdleMs: 10 });
    const sameTurn = { ...first, itemId: "command-2" };
    const nextTurn = { ...first, turnId: "turn-2", itemId: "command-3" };
    accumulator.accept(first, "first", 0);
    accumulator.accept(sameTurn, "second", 0);
    accumulator.accept(nextTurn, "third", 0);
    accumulator.clearItem(first);
    expect(accumulator.bufferedItemCount).toBe(2);
    accumulator.clearTurn(first.conversationId, first.turnId);
    expect(accumulator.bufferedItemCount).toBe(1);
    accumulator.clearConversation(first.conversationId);
    expect(accumulator.bufferedItemCount).toBe(0);

    accumulator.accept(first, "expired", 0);
    accumulator.accept(nextTurn, "fresh", 11);
    expect(accumulator.bufferedItemCount).toBe(1);
  });
});
