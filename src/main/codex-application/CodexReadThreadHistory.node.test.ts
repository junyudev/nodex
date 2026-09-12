import { assert, it } from "@effect/vitest";
import { expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import type { Thread, Turn } from "@nodex/codex-app-server-protocol/v2";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAppServerCapabilities, createCodexAppServerCapabilitySnapshot } from "../codex-runtime/CodexAppServerCapabilities";
import { CodexNativeThreadLookup } from "./CodexNativeThreadLookup";
import { make, serializeCodexReadThreadProtocolItem } from "./CodexReadThreadHistory";
import { turnFixture } from "./conversation-test-fixture";
const nativeThread = (turns: Turn[], historyMode: Thread["historyMode"] = "paginated"): Thread => ({ id: "thread", historyMode, turns, name: "History", preview: "Native", status: { type: "idle" }, cwd: "/repo", createdAt: 1, updatedAt: 2 } as Thread);
function service(thread: Thread, paginated: boolean, calls: { method: string; params: unknown }[], assertCurrent = () => {}) {
  return make.pipe(
    Effect.provideService(CodexNativeThreadLookup, { resolve: () => Effect.sync(() => { calls.push({ method: "thread/read", params: { threadId: "thread", includeTurns: false } }); return { hostId: "local", thread, manager: { assertCurrent, generation: 1 } }; }) } as unknown as CodexNativeThreadLookup["Service"]),
    Effect.provideService(CodexAppServerCapabilities, { forHost: () => Effect.succeed({ ...createCodexAppServerCapabilitySnapshot({ hostId: "local", generation: 1, userAgent: "0.153.0" }), flags: { paginatedHistory: paginated } }) } as unknown as CodexAppServerCapabilities["Service"]),
    Effect.provideService(CodexGateway, { requestOnHost: (_host: string, method: string, params: unknown) => Effect.sync(() => { calls.push({ method, params }); return method === "thread/read" ? { thread } : { data: [turnFixture("older")], nextCursor: "opaque-next" }; }) } as unknown as CodexGateway["Service"]),
  );
}
it.effect("paginated read forwards the native cursor and returns native metadata without resident hydration", () => Effect.gen(function* () {
  const calls: { method: string; params: unknown }[] = [];
  const reader = yield* service(nativeThread([]), true, calls);
  const result = yield* reader.read({ threadId: "thread", cursor: "opaque-before", turnLimit: 2 });
  assert.deepEqual(calls, [{ method: "thread/read", params: { threadId: "thread", includeTurns: false } }, { method: "thread/turns/list", params: { threadId: "thread", cursor: "opaque-before", itemsView: "full", limit: 2 } }]);
  assert.strictEqual(result.page.nextCursor, "opaque-next"); assert.strictEqual(result.thread.createdAt, 1); assert.strictEqual(result.thread.kind, "codex");
}));
it.effect("legacy paginated history translates turn identity cursors only at the native boundary", () => Effect.gen(function* () {
  const calls: { method: string; params: unknown }[] = [];
  const reader = yield* service(nativeThread([], "default" as Thread["historyMode"]), true, calls);
  const result = yield* reader.read({ threadId: "thread", cursor: "anchor" });
  assert.deepEqual(calls[1]?.params, { threadId: "thread", cursor: JSON.stringify({ turnId: "anchor", includeAnchor: false }), itemsView: "full", limit: 1 });
  assert.strictEqual(result.page.nextCursor, "older");
}));
it.effect("nonpaginated history uses exclusive turn IDs and rejects unknown anchors", () => Effect.gen(function* () {
  const calls: { method: string; params: unknown }[] = [];
  const reader = yield* service(nativeThread([turnFixture("a"), turnFixture("b"), turnFixture("c")], "default" as Thread["historyMode"]), false, calls);
  const result = yield* reader.read({ threadId: "thread", cursor: "c" });
  assert.strictEqual(result.turns[0]?.id, "b"); assert.strictEqual(result.page.nextCursor, "b");
  const error = yield* reader.read({ threadId: "thread", cursor: "missing" }).pipe(Effect.flip);
  assert.include(String(error.cause), "Unknown cursor");
}));
test("output budget does not truncate user/assistant input and structured output reports original size", () => {
  expect(serializeCodexReadThreadProtocolItem({ type: "agentMessage", id: "answer", text: "complete answer", phase: "final_answer", memoryCitation: null, delivery: null, questions: null }, true, 3)).toMatchObject({ text: "complete answer" });
  expect(serializeCodexReadThreadProtocolItem({ type: "functionCallOutput", id: "output", name: "tool", namespace: null, output: "abcdef" }, true, 3)).toMatchObject({ output: { text: "abc", truncated: true, originalChars: 6 } });
  expect(serializeCodexReadThreadProtocolItem({ type: "userMessage", id: "input", clientId: null, content: [{ type: "localImage", path: "/image.png" }] }, false, 0)).toEqual({ type: "userMessage", id: "input", content: [{ type: "localImage", path: "/image.png" }] });
});

it.effect("native history rejects a page returned after its authenticated manager retires", () => Effect.gen(function* () {
  const calls: { method: string; params: unknown }[] = [];
  const reader = yield* service(nativeThread([]), true, calls, () => { if (calls.length > 1) throw new Error("account retired"); });
  const error = yield* reader.read({ threadId: "thread" }).pipe(Effect.flip);
  assert.strictEqual(error.reason, "request-failed");
  assert.include(String(error.cause), "account retired");
  assert.lengthOf(calls, 2);
}));
