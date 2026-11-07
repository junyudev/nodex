import type { OrchestrationV2TurnItem } from "@nodex/runtime-contracts";
import { describe, expect, it } from "vitest";
import * as NodeZlib from "node:zlib";

import {
  boundStoredCommandOutput,
  boundStoredTurnItem,
  MAX_STORED_COMMAND_OUTPUT_BYTES,
  splitCommandOutput,
} from "./commandOutputStorage.ts";

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

describe("boundStoredCommandOutput", () => {
  it("keeps output at the limit unchanged", () => {
    const output = "x".repeat(MAX_STORED_COMMAND_OUTPUT_BYTES);
    expect(boundStoredCommandOutput(output)).toBe(output);
  });

  it("keeps both ends of an output over the limit", () => {
    const output = `first line\n${"x".repeat(MAX_STORED_COMMAND_OUTPUT_BYTES)}\nfinal error`;
    const bounded = boundStoredCommandOutput(output);
    expect(byteLength(bounded)).toBeLessThanOrEqual(MAX_STORED_COMMAND_OUTPUT_BYTES);
    expect(bounded.startsWith("first line\n")).toBe(true);
    expect(bounded.endsWith("\nfinal error")).toBe(true);
    expect(bounded).toContain("output truncated for storage");
  });

  it.each([
    ["two-byte", "é"],
    ["three-byte", "界"],
    ["four-byte", "😀"],
  ])("never splits a %s character at either cut", (_name, character) => {
    const output = character.repeat(MAX_STORED_COMMAND_OUTPUT_BYTES);
    const bounded = boundStoredCommandOutput(output);
    expect(byteLength(bounded)).toBeLessThanOrEqual(MAX_STORED_COMMAND_OUTPUT_BYTES);
    expect(bounded).not.toContain("�");
    expect(byteLength(bounded)).toBeGreaterThan(MAX_STORED_COMMAND_OUTPUT_BYTES - 16);
  });
});

const commandItem = (output?: string) =>
  ({
    type: "command_execution",
    input: "ls",
    ...(output === undefined ? {} : { output }),
  }) as unknown as OrchestrationV2TurnItem;

describe("command output storage", () => {
  it("returns the same item when nothing needs bounding", () => {
    const item = commandItem("short");
    expect(boundStoredTurnItem(item)).toBe(item);
    const other = { type: "reasoning", text: "x".repeat(1024 * 1024) } as OrchestrationV2TurnItem;
    expect(boundStoredTurnItem(other)).toBe(other);
  });

  it("separates output from the stored JSON and records its size", () => {
    const stored = splitCommandOutput(commandItem("hello 界"));
    expect(stored.item).not.toHaveProperty("output");
    expect(stored.output?.bytes).toBe(byteLength("hello 界"));
    expect(NodeZlib.zstdDecompressSync(stored.output!.zstd).toString("utf8")).toBe("hello 界");
  });

  it("leaves items without command output whole", () => {
    const withoutOutput = commandItem();
    expect(splitCommandOutput(withoutOutput)).toEqual({ item: withoutOutput, output: null });
    const reply = { type: "assistant_message", text: "hi" } as OrchestrationV2TurnItem;
    expect(splitCommandOutput(reply)).toEqual({ item: reply, output: null });
  });
});
