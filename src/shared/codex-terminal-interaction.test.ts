import { describe, expect, test } from "vite-plus/test";
import {
  CodexTerminalInteractionAccumulator,
  parseCodexTerminalInput,
} from "./codex-terminal-interaction";

const first = { conversationId: "conversation-1", itemId: "command-1" };

describe("Codex terminal interaction accumulator", () => {
  test("joins fragmented input by conversation and command item", () => {
    const accumulator = new CodexTerminalInteractionAccumulator();
    expect(accumulator.accept(first, "ec").commands).toEqual([]);
    accumulator.accept({ ...first, itemId: "other" }, "unrelated");
    accumulator.accept({ ...first, conversationId: "other" }, "foreign");
    expect(accumulator.accept(first, "ho hello\rnext").commands).toEqual(["echo hello"]);
    expect(accumulator.accept(first, " line\n").commands).toEqual(["next line"]);
  });

  test("interprets carriage return, newline, interrupt and UTF-16 backspace", () => {
    expect(
      parseCodexTerminalInput("", "carriage\rline\npaired\r\n discard\u0003echo 😀\b\r"),
    ).toEqual({ commands: ["carriage", "line", "paired", "echo \ud83d"], inputBuffer: "" });
    expect(parseCodexTerminalInput("abc", "\u007fd\n unfinished")).toEqual({
      commands: ["abd"],
      inputBuffer: " unfinished",
    });
  });

  test("retains long incomplete commands and every submitted command", () => {
    const accumulator = new CodexTerminalInteractionAccumulator();
    const long = "汉".repeat(100_000);
    accumulator.accept(first, long);
    const commands = Array.from({ length: 512 }, (_, index) => `command-${index}`);
    expect(accumulator.accept(first, `\n${commands.join("\n")}\n`).commands).toEqual([
      long,
      ...commands,
    ]);
  });

  test("clears selected lifecycle items without discarding other conversations", () => {
    const accumulator = new CodexTerminalInteractionAccumulator();
    const second = { ...first, itemId: "command-2" };
    const other = { ...first, conversationId: "conversation-2" };
    accumulator.accept(first, "first");
    accumulator.accept(second, "second");
    accumulator.accept(other, "other");
    accumulator.clearItems(first.conversationId, [first.itemId]);
    expect(accumulator.accept(first, "\n").commands).toEqual([]);
    expect(accumulator.accept(second, "\n").commands).toEqual(["second"]);
    accumulator.accept(first, "discard");
    accumulator.clearConversation(first.conversationId);
    expect(accumulator.accept(first, "\n").commands).toEqual([]);
    expect(accumulator.accept(other, "\n").commands).toEqual(["other"]);
    accumulator.accept(first, "discard");
    accumulator.clear();
    expect(accumulator.accept(first, "\n").commands).toEqual([]);
  });
});
