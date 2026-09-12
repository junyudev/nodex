import { describe, expect, test, vi } from "vitest";
import type { IpcApi } from "./ipc-api";
import { CodexNativeIpcClient } from "./codex-native-ipc";
import { unwrapCodexNativeRequestOutcome } from "./codex-native-request-outcome";

const channel = "codex:app-server:request";
const args = (requestId = "request:one", hostId = "local"): IpcApi[typeof channel]["args"] => [
  {
    hostId,
    request: { id: requestId, method: "model/list", params: {} },
    caller: { requestId, timeoutMs: 0, expiresAtMs: null },
  },
];

describe("native response client", () => {
  test("host delivery preserves pending response until a matching terminal update", async () => {
    using client = new CodexNativeIpcClient();
    const operation = client.invoke(channel, args(), () => Promise.resolve());
    let settled = false;
    void operation.then(() => {
      settled = true;
    });
    const delivery = {
      requestId: "request:one",
      method: "turn/start",
      stage: "outcome-unknown",
    } as const;
    client.receive({
      type: "mcp-request-delivery",
      hostId: "local",
      update: { type: "outcome-unknown", delivery },
    });
    client.receive({
      type: "mcp-request-delivery",
      hostId: "other",
      update: { type: "failed", delivery, message: "Wrong host" },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    client.receive({
      type: "mcp-request-delivery",
      hostId: "local",
      update: { type: "failed", delivery, message: "Transport disconnected" },
    });
    const outcome = await operation;
    expect(outcome).toEqual({
      type: "error",
      hostId: "local",
      error: { code: null, message: "Transport disconnected", delivery },
    });
    expect(() => unwrapCodexNativeRequestOutcome(outcome)).toThrow("Transport disconnected");
    client.receive({
      type: "mcp-response",
      hostId: "local",
      message: { id: "request:one", result: "late" },
    });
    expect(await operation).toEqual(outcome);
  });

  for (const asynchronous of [false, true]) {
    test(`failed retained dispatch carries its real identity and not-sent stage: ${asynchronous}`, async () => {
      using client = new CodexNativeIpcClient();
      const input: IpcApi["codex:turn:native-steer:execute"]["args"][0] = {
        hostId: "local",
        caller: {
          requestId: "steer-as-start",
          timeoutMs: 10,
          expiresAtMs: 10,
          retainResponse: true,
        },
        request: { method: "turn/start", params: { threadId: "thread", input: [] } },
        clientUserMessageId: "client",
      };
      const failure = new Error("IPC dispatch failed");
      const pending = client.invoke("codex:turn:native-steer:execute", [input], () => {
        if (asynchronous) return Promise.reject(failure);
        throw failure;
      });
      await expect(pending).rejects.toMatchObject({
        message: failure.message,
        delivery: { requestId: "steer-as-start", method: "turn/start", stage: "not-sent" },
      });
    });
  }

  test("does not coerce a numeric delivery identity into a pending string identity", async () => {
    using client = new CodexNativeIpcClient();
    const operation = client.invoke(channel, args("0"), () => Promise.resolve());
    let settled = false;
    void operation.then(() => {
      settled = true;
    });
    client.receive({
      type: "mcp-request-delivery",
      hostId: "local",
      update: {
        type: "failed",
        delivery: { requestId: 0, method: "model/list", stage: "not-sent" },
        message: "Numeric identity",
      },
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    client.receive({
      type: "mcp-response",
      hostId: "local",
      message: { id: "0", result: "string identity" },
    });
    await expect(operation).resolves.toMatchObject({ type: "result", result: "string identity" });
  });

  test("registers before dispatch and ignores the invoke acknowledgement's value", async () => {
    using client = new CodexNativeIpcClient();
    let settled = false;
    const result = client.invoke(channel, args(), () => Promise.resolve({ wrong: true }));
    void result.then(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    client.receive({
      type: "mcp-response",
      hostId: "local",
      message: { id: "request:one", result: false },
    });
    await expect(result).resolves.toMatchObject({ type: "result", hostId: "local", result: false });

    const synchronous = client.invoke(channel, args("sync"), () => {
      client.receive({ type: "mcp-response", hostId: "local", message: { id: "sync", result: 7 } });
      return Promise.resolve();
    });
    await expect(synchronous).resolves.toMatchObject({ type: "result", result: 7 });
  });

  test("correlates host and request and preserves native failure data and metrics", async () => {
    using client = new CodexNativeIpcClient();
    const result = client.invoke(channel, args(), () => Promise.resolve());
    client.receive({
      type: "mcp-response",
      hostId: "other",
      message: { id: "request:one", result: "wrong host" },
    });
    client.receive({
      type: "mcp-response",
      hostId: "local",
      message: { id: "other", result: "wrong request" },
    });
    const error = { code: -32601, message: "Method not found", data: { method: "model/list" } };
    const hostMetrics = {
      transportKind: "stdio",
      incomingQueueDepth: 3,
      responseBytes: 128,
    } as const;
    client.receive({
      type: "mcp-response",
      hostId: "local",
      hostMetrics,
      message: { id: "request:one", error },
    });
    await expect(result).resolves.toEqual({ type: "error", hostId: "local", hostMetrics, error });
  });

  test("rejects synchronous and asynchronous dispatch failures and releases their identities", async () => {
    using client = new CodexNativeIpcClient();
    await expect(
      client.invoke(channel, args(), () => {
        throw new Error("sync failure");
      }),
    ).rejects.toThrow("sync failure");
    await expect(
      client.invoke(channel, args(), () => Promise.reject(new Error("async failure"))),
    ).rejects.toThrow("async failure");
    const result = client.invoke(channel, args(), () => Promise.resolve());
    client.receive({
      type: "mcp-response",
      hostId: "local",
      message: { id: "request:one", result: null },
    });
    await expect(result).resolves.toMatchObject({ type: "result", result: null });
  });

  test("rejects duplicate dispatch and disposal without disturbing another caller", async () => {
    const client = new CodexNativeIpcClient();
    const first = client.invoke(channel, args(), () => Promise.resolve());
    const second = client.invoke(channel, args("second"), () => Promise.resolve());
    const dispatch = vi.fn(() => Promise.resolve());
    await expect(client.invoke(channel, args(), dispatch)).rejects.toThrow("already pending");
    expect(dispatch).not.toHaveBeenCalled();
    const firstRejected = expect(first).rejects.toThrow("caller was disposed");
    client.abandon("request:one");
    await firstRejected;
    client.receive({
      type: "mcp-response",
      hostId: "local",
      message: { id: "request:one", result: "late" },
    });
    const secondRejected = expect(second).rejects.toThrow("client is disposed");
    client[Symbol.dispose]();
    client[Symbol.dispose]();
    await secondRejected;
    await expect(client.invoke(channel, args("third"), dispatch)).rejects.toThrow(
      "client is disposed",
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  test("an old invoke failure cannot retire a new request after the old response settled", async () => {
    using client = new CodexNativeIpcClient();
    let rejectDispatch: ((reason: unknown) => void) | undefined;
    const dispatch = new Promise<unknown>((_resolve, reject) => {
      rejectDispatch = reject;
    });
    const first = client.invoke(channel, args(), () => dispatch);
    client.receive({
      type: "mcp-response",
      hostId: "local",
      message: { id: "request:one", result: "first" },
    });
    await first;
    const second = client.invoke(channel, args(), () => Promise.resolve());
    rejectDispatch?.(new Error("late dispatch failure"));
    await Promise.resolve();
    client.receive({
      type: "mcp-response",
      hostId: "local",
      message: { id: "request:one", result: "second" },
    });
    await expect(second).resolves.toMatchObject({ type: "result", result: "second" });
  });
});
