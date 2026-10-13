import { describe, expect, test } from "vite-plus/test";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import {
  decodeCreatedThreadResult,
  readCreatedThreadActivityResult,
  readNativeCreatedThreadResult,
} from "./codex-created-thread-result";

const call = (
  overrides: Partial<Extract<ThreadItem, { type: "dynamicToolCall" }>> = {},
): Extract<ThreadItem, { type: "dynamicToolCall" }> => ({
  type: "dynamicToolCall",
  id: "source-call",
  namespace: "codex_app",
  tool: "create_thread",
  arguments: {},
  status: "completed",
  contentItems: [{ type: "inputText", text: '{"threadId":" child ","hostId":" remote "}' }],
  success: true,
  durationMs: 1,
  ...overrides,
});

describe("created thread targets", () => {
  test("preserves provider and host while preferring a valid native identity", () => {
    expect(decodeCreatedThreadResult({ threadId: " child ", hostId: " remote " })).toEqual({
      threadId: "child",
      hostId: "remote",
    });
    expect(
      decodeCreatedThreadResult({ threadId: "child", clientThreadId: "client-new-thread:any" }),
    ).toEqual({ threadId: "child" });
    expect(
      decodeCreatedThreadResult({ threadId: " ", clientThreadId: "client-new-thread:any" }),
    ).toEqual({ clientThreadId: "client-new-thread:any" });
    expect(decodeCreatedThreadResult({ kind: "chatgpt", clientThreadId: " pending " })).toEqual({
      kind: "chatgpt",
      clientThreadId: "pending",
    });
  });
  test.each([
    { kind: "other", threadId: "child" },
    { threadId: " " },
    { threadId: "child", hostId: " " },
    { clientThreadId: " client-new-thread:any" },
    { clientThreadId: "pending-worktree:any" },
  ])("rejects an invalid target %j", (value) => {
    expect(decodeCreatedThreadResult(value)).toBeNull();
  });
  test("keeps ordinary registry admission distinct from raw promotion", () => {
    const legacy = call({ namespace: null });
    expect(readNativeCreatedThreadResult(legacy)).toBeNull();
    expect(readCreatedThreadActivityResult({ ...legacy, completed: true })).toEqual({
      threadId: "child",
      hostId: "remote",
    });
    for (const invalid of [
      call({ status: "inProgress" }),
      call({ success: false }),
      call({ namespace: "other" }),
      call({ tool: "fork_thread" }),
    ])
      expect(readNativeCreatedThreadResult(invalid)).toBeNull();
    expect(readCreatedThreadActivityResult({ ...call(), completed: false })).toBeNull();
  });
  test("only the first matching text result can establish the target", () => {
    expect(
      readNativeCreatedThreadResult(
        call({
          contentItems: [
            { type: "inputImage", imageUrl: "https://example.test/image.png" },
            { type: "inputText", text: '{"threadId":"after-image"}' },
          ],
        }),
      ),
    ).toEqual({ threadId: "after-image" });
    const invalidFirst = call({
      contentItems: [
        { type: "inputText", text: "invalid" },
        { type: "inputText", text: '{"threadId":"later"}' },
      ],
    });
    expect(readNativeCreatedThreadResult(invalidFirst)).toBeNull();
  });
});
