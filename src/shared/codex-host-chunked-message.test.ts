import { expect, test } from "vitest";
import {
  CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES,
  codexHostMessageExceedsBytes,
  codexHostMessageParts,
  CodexHostMessageReceiver,
  setCodexHostSourceLineBytes,
  shouldChunkCodexHostMessage,
} from "./codex-host-chunked-message";

test("reassembles structured data and split strings with exact per-part acknowledgements", () => {
  const value = { text: "中文😀".repeat(80), nested: [{ value: null }, undefined, true, 42] };
  const receiver = new CodexHostMessageReceiver();
  const parts = [...codexHostMessageParts(value, { transferId: "first", batchTargetBytes: 128 })];
  expect(parts.length).toBeGreaterThan(4);
  for (const [index, part] of parts.entries()) {
    const received = receiver.receive(part);
    expect(received.type).toBe(index === parts.length - 1 ? "complete" : "pending");
    if (received.type === "passthrough") throw new Error("Expected transfer part");
    expect(received.acknowledgement).toEqual({ transferId: "first", sequence: index });
    if (received.type === "complete") expect(received.message).toEqual(value);
  }
});

test("a new start retires the old transfer and wrong sequence receives no acknowledgement", () => {
  const receiver = new CodexHostMessageReceiver();
  const first = [...codexHostMessageParts({ value: 1 }, { transferId: "first" })];
  const second = [...codexHostMessageParts({ value: 2 }, { transferId: "second" })];
  receiver.receive(first[0]);
  receiver.receive(second[0]);
  expect(receiver.receive(first[1])).toEqual({ type: "pending", acknowledgement: null });
  expect(receiver.receive(second[2])).toEqual({ type: "pending", acknowledgement: null });
  expect(receiver.receive(second[1])).toEqual({ type: "pending", acknowledgement: null });
});

test("critical inline messages pass through an in-flight transfer", () => {
  const receiver = new CodexHostMessageReceiver();
  const parts = [
    ...codexHostMessageParts(
      { large: "x".repeat(1000) },
      { transferId: "large", batchTargetBytes: 128 },
    ),
  ];
  receiver.receive(parts[0]);
  const critical = { type: "approval", id: 1 };
  expect(receiver.receive(critical)).toEqual({ type: "passthrough", message: critical });
  let last: ReturnType<CodexHostMessageReceiver["receive"]> | undefined;
  for (const part of parts.slice(1)) last = receiver.receive(part);
  expect(last?.type).toBe("complete");
});

test("preserves own prototype keys and repeated references but rejects cycles", () => {
  const receiver = new CodexHostMessageReceiver();
  const child = { x: 1 };
  const input = { ...JSON.parse('{"__proto__":{"safe":true}}'), repeated: [child, child] };
  let result: unknown;
  for (const part of codexHostMessageParts(input, { transferId: "own-key" })) {
    const received = receiver.receive(part);
    if (received.type === "complete") result = received.message;
  }
  expect(result).toEqual(input);
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.hasOwn(result as object, "__proto__")).toBe(true);
  const cyclic: { next?: unknown } = {};
  cyclic.next = cyclic;
  expect(() => [...codexHostMessageParts(cyclic, { transferId: "cycle" })]).toThrow("cyclic");
});

test("uses the desktop host structured-size estimator at the exact inline threshold", () => {
  expect(codexHostMessageExceedsBytes("x", 18)).toBe(false);
  expect(codexHostMessageExceedsBytes("xx", 18)).toBe(true);
  expect(shouldChunkCodexHostMessage("x".repeat(CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES))).toBe(
    true,
  );
});

test("prefers physical source-line byte metadata on message result and params", () => {
  const result = { value: "tiny" };
  const responsePayload = { message: { result } };
  setCodexHostSourceLineBytes(result, CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES + 1);
  expect(shouldChunkCodexHostMessage(responsePayload)).toBe(true);

  const params = { value: "x".repeat(128) };
  const notificationPayload = { params };
  setCodexHostSourceLineBytes(params, 1);
  expect(shouldChunkCodexHostMessage(notificationPayload)).toBe(false);
});

test("native occurrence wrapping preserves physical notification size decisions", () => {
  const params = { thread: { turns: [] } };
  const payload = {
    type: "nativeNotification",
    notification: { method: "thread/started", params },
  };
  setCodexHostSourceLineBytes(params, CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES);
  expect(shouldChunkCodexHostMessage(payload)).toBe(false);
  setCodexHostSourceLineBytes(params, CODEX_HOST_CHUNK_INLINE_THRESHOLD_BYTES + 1);
  expect(shouldChunkCodexHostMessage(payload)).toBe(true);
});
