import { expect, test } from "vitest";
import {
  CodexChunkedArray,
  copyCodexTransportMetadata,
  markCodexChunkedJson,
  materializeCodexJson,
  setCodexSourceLineBytes,
} from "@nodex/effect-codex-app-server/transport-values";
import { CodexNativeIpcClient } from "../../shared/codex-native-ipc";
import type { CodexNativeResponseMessage } from "../../shared/codex-native-request-outcome";
import type { IpcApi } from "../../shared/ipc-api";
import {
  CodexHostMessageReceiver,
  type CodexHostMessagePart,
} from "../../shared/codex-host-chunked-message";
import { CodexHostChunkedMessageSender } from "./CodexHostChunkedMessageSender";
import {
  codexNativePredispatchOutcome,
  codexNativeResponseIsCritical,
  codexNativeResponseMessage,
  codexNativeResponseRoute,
  codexNativeUntracedResponseMessage,
} from "./CodexNativeResponse";

test("native result delivery preserves segmented data through decoding, sender, ACKs and caller correlation", async () => {
  const text = "中文😀".repeat(256);
  const raw = { result: { data: new CodexChunkedArray([[{ text }], [{ text: "last" }]], 2) } };
  markCodexChunkedJson(raw);
  setCodexSourceLineBytes(raw.result, 8_192);
  const decoded = structuredClone(materializeCodexJson(raw.result));
  copyCodexTransportMetadata(materializeCodexJson(raw.result), decoded);
  const input = {
    hostId: "local",
    caller: { requestId: "one", timeoutMs: 0, expiresAtMs: null },
    request: { method: "model/list", id: "one", params: {} },
  } as const;
  const hostMetrics = {
    transportKind: "stdio",
    incomingQueueDepth: 2,
    responseBytes: 8_192,
  } as const;
  const message = codexNativeResponseMessage(input, {
    type: "result",
    result: decoded,
    hostMetrics,
  });
  if (message.type !== "mcp-response") throw new Error("Expected native response envelope");
  expect(message.message.result).toBe(raw.result);

  using client = new CodexNativeIpcClient();
  const result = client.invoke("codex:app-server:request", [input], () => Promise.resolve());
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  const deliveries: Array<CodexHostMessagePart | CodexNativeResponseMessage> = [];
  const target = { id: 1 };
  const sender = new CodexHostChunkedMessageSender<typeof target, CodexNativeResponseMessage>({
    inlineThresholdBytes: 128,
    batchTargetBytes: 128,
    getPayload: (value) => value,
    deliver: (_target, value, part) => {
      deliveries.push(part ?? value);
    },
    onSendError: (_target, error) => {
      throw error;
    },
  });
  sender.send(target, message);
  expect(deliveries).toHaveLength(1);
  const receiver = new CodexHostMessageReceiver();
  for (let index = 0; index < deliveries.length; index += 1) {
    const received = receiver.receive(deliveries[index]);
    if (received.type === "passthrough") throw new Error("Expected segmented delivery");
    expect(settled).toBe(false);
    if (received.type === "complete")
      client.receive(received.message as CodexNativeResponseMessage);
    if (!received.acknowledgement) throw new Error("Missing transport acknowledgement");
    sender.acknowledge(
      target,
      received.acknowledgement.transferId,
      received.acknowledgement.sequence,
    );
  }
  expect(deliveries.length).toBeGreaterThan(4);
  await expect(result).resolves.toEqual({
    type: "result",
    hostId: "local",
    hostMetrics,
    result: { data: [{ text }, { text: "last" }] },
  });
  sender.dispose(target);
});

test("transport delivery errors settle through the host stream while native errors remain responses", async () => {
  const input: IpcApi["codex:app-server:request"]["args"][0] = {
    hostId: "local",
    caller: { requestId: "native:start", timeoutMs: 30, expiresAtMs: 30, retainResponse: true },
    request: {
      id: "native:start",
      method: "turn/start",
      params: { threadId: "thread", input: [] },
    },
  };
  using client = new CodexNativeIpcClient();
  const result = client.invoke("codex:app-server:request", [input], () => Promise.resolve());
  const delivery = { requestId: "native:start", method: "turn/start", stage: "not-sent" } as const;
  const message = codexNativeResponseMessage(input, {
    type: "error",
    error: { code: null, message: "Expired before dispatch", delivery },
  });
  expect(message).toEqual({
    type: "mcp-request-delivery",
    hostId: "local",
    update: { type: "failed", delivery, message: "Expired before dispatch" },
  });
  client.receive(structuredClone(message));
  await expect(result).resolves.toMatchObject({
    type: "error",
    error: { delivery, message: "Expired before dispatch" },
  });
  expect(
    codexNativeResponseMessage(input, {
      type: "error",
      error: { code: -32600, message: "Native rejection", data: { reason: "NoActiveTurn" } },
    }),
  ).toEqual({
    type: "mcp-response",
    hostId: "local",
    hostMetrics: undefined,
    message: {
      id: input.caller.requestId,
      error: { code: -32600, message: "Native rejection", data: { reason: "NoActiveTurn" } },
    },
  });
});

test("critical response delivery follows the native method and explicit scheduling override", () => {
  const base = { hostId: "local", caller: { requestId: "one", timeoutMs: 0, expiresAtMs: null } };
  expect(
    codexNativeResponseIsCritical("codex:app-server:request", {
      ...base,
      request: { method: "thread/resume", id: "one", params: { threadId: "thread" } },
    }),
  ).toBe(true);
  expect(
    codexNativeResponseIsCritical("codex:app-server:request", {
      ...base,
      request: { method: "model/list", id: "one", params: {} },
      scheduling: { priority: "critical" },
    }),
  ).toBe(true);
  expect(
    codexNativeResponseIsCritical("codex:app-server:request", {
      ...base,
      request: { method: "thread/resume", id: "one", params: { threadId: "thread" } },
      scheduling: { priority: "background" },
    }),
  ).toBe(false);
  expect(
    codexNativeResponseIsCritical("codex:thread:native-session:execute", {
      ...base,
      receiptId: "prepared",
    }),
  ).toBe(true);
  expect(
    codexNativeResponseIsCritical("codex:thread:native-fork:execute", {
      ...base,
      receiptId: "prepared",
    }),
  ).toBe(false);
});

test("late native responses preserve the physical reply without reviving an abandoned caller", () => {
  expect(
    codexNativeResponseRoute({
      requestId: "turn-start",
      abandonmentReason: "timeout",
      senderDestroyed: false,
    }),
  ).toBe("direct");
  expect(
    codexNativeResponseRoute({
      requestId: "read-random-uuid",
      abandonmentReason: "timeout",
      senderDestroyed: false,
    }),
  ).toBe("direct");
  expect(
    codexNativeResponseRoute({
      requestId: "thread/read:prefixed",
      abandonmentReason: "disposed",
      senderDestroyed: true,
    }),
  ).toBe("drop");
  expect(
    codexNativeResponseRoute({
      requestId: "turn-start",
      senderDestroyed: true,
    }),
  ).toBe("broadcast-fallback");
  expect(
    codexNativeResponseRoute({
      requestId: "thread/read:prefixed",
      senderDestroyed: true,
    }),
  ).toBe("drop");
  expect(
    codexNativeResponseRoute({
      requestId: "read-random-uuid",
      senderDestroyed: true,
    }),
  ).toBe("broadcast-fallback");
  expect(
    codexNativeResponseRoute({
      requestId: "turn-start",
      senderDestroyed: false,
    }),
  ).toBe("direct");

  const input = {
    hostId: "local",
    caller: { requestId: "turn", timeoutMs: 0, expiresAtMs: null },
  } as const;
  expect(
    codexNativeUntracedResponseMessage(input, {
      type: "result",
      result: { thread: { id: "thread" } },
      abandonmentReason: "timeout",
      receivedAtMs: 100,
      requestMethod: "turn/start",
      trace: {
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
      },
    }),
  ).toEqual({
    type: "mcp-response",
    hostId: "local",
    hostMetrics: undefined,
    message: { id: "turn", result: { thread: { id: "thread" } } },
  });
});

test("only unsent retained mutations turn preparation failures into definite delivery failures", () => {
  const input: IpcApi["codex:thread:native-fork:execute"]["args"][0] = {
    hostId: "local",
    receiptId: "missing",
    caller: { requestId: "fork", retainResponse: true, timeoutMs: 0, expiresAtMs: null },
  };
  const failure = { type: "error", error: { code: null, message: "Preparation missing" } } as const;
  const rejected = codexNativePredispatchOutcome(
    "codex:thread:native-fork:execute",
    input,
    failure,
    false,
  );
  expect(codexNativeResponseMessage(input, rejected)).toEqual({
    type: "mcp-request-delivery",
    hostId: "local",
    update: {
      type: "failed",
      message: "Preparation missing",
      delivery: { requestId: "fork", method: "thread/fork", stage: "not-sent" },
    },
  });
  expect(
    codexNativePredispatchOutcome("codex:thread:native-fork:execute", input, failure, true),
  ).toBe(failure);
  const nativeFailure = {
    type: "error",
    error: { code: -32600, message: "Native rejection", data: { reason: "Rejected" } },
  } as const;
  expect(
    codexNativePredispatchOutcome("codex:thread:native-fork:execute", input, nativeFailure, true),
  ).toBe(nativeFailure);
  expect(
    codexNativePredispatchOutcome(
      "codex:thread:native-fork:execute",
      {
        ...input,
        caller: { ...input.caller, retainResponse: false },
      },
      failure,
      false,
    ),
  ).toBe(failure);
  const uncertain = {
    type: "error",
    error: {
      code: null,
      message: "Disconnected",
      delivery: {
        requestId: "fork",
        method: "thread/fork",
        stage: "outcome-unknown",
      },
    },
  } as const;
  expect(
    codexNativePredispatchOutcome("codex:thread:native-fork:execute", input, uncertain, false),
  ).toBe(uncertain);
  const result = { type: "result", result: {} } as const;
  expect(
    codexNativePredispatchOutcome("codex:thread:native-fork:execute", input, result, false),
  ).toBe(result);
  expect(
    codexNativePredispatchOutcome(
      "codex:app-server:request",
      {
        hostId: "local",
        caller: input.caller,
        request: { id: "fork", method: "model/list", params: {} },
      },
      failure,
      false,
    ),
  ).toBe(failure);
});
