import { describe, expect, test } from "vite-plus/test";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import {
  projectCodexChildReplyText,
  selectCodexChildThreadReply,
} from "./codex-child-thread-summary";

const reply = (
  text: string,
  phase: "commentary" | "final_answer" | null = null,
  delivery: "async" | null = null,
): ThreadItemEntry => ({
  turnId: "turn",
  startedAtMs: null,
  completedAtMs: null,
  item: {
    type: "agentMessage",
    id: text,
    text,
    phase,
    delivery,
    memoryCitation: null,
    questions: null,
  },
});

describe("created conversation reply summaries", () => {
  test("uses descending item order, skipping synchronous commentary and empty visible replies", () => {
    expect(
      selectCodexChildThreadReply([
        reply("Newest commentary", "commentary"),
        reply("<script>hidden()</script>"),
        reply("**hel**lo [a](https://x)bc"),
      ]),
    ).toBe("hello abc");
  });
  test("includes async commentary without imposing a completion timestamp absent from the producer", () => {
    expect(
      selectCodexChildThreadReply([
        reply("Async **reply**", "commentary", "async"),
        reply("Older answer"),
      ]),
    ).toBe("Async reply");
  });
  test("preserves code content while excluding executable HTML from compact text", () => {
    expect(
      projectCodexChildReplyText("before <style>.secret{}</style> after\n\n```ts\na\n\n\nb\n```"),
    ).toBe("before after a b");
  });
});
