import { afterEach, expect, it, vi } from "vitest";
import type { ThreadResumeParams, ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2";
import type { CodexRendererRequestCaller } from "../../../shared/codex-renderer-request";
import { RendererNativeAppServer } from "./renderer-native-app-server";
import { requestRendererConversationResume } from "./renderer-conversation-resume-request";

const invoke = vi.hoisted(() => vi.fn<(channel: string, ...args: unknown[]) => Promise<unknown>>());
vi.mock("./local-conversation-deps", () => ({ runConversationOperation: invoke }));
afterEach(() => {
  vi.useRealTimers();
  invoke.mockReset();
});

const prepared = {
  receiptId: "receipt",
  nativeRequestId: "thread/resume:first",
  params: { threadId: "thread", excludeTurns: true },
};
const response = { thread: { id: "thread" } } as ThreadResumeResponse;
const closing = "thread thread is closing; retry thread/resume after the thread is closed";
const settle = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

function fixture() {
  vi.useFakeTimers();
  let current = true;
  let cleanup: (() => void) | undefined;
  let sequence = 0;
  let renewGate: Promise<void> | undefined;
  const requests: Array<{
    id: string;
    params: ThreadResumeParams;
    caller: CodexRendererRequestCaller;
    resolve(value: ThreadResumeResponse): void;
    fail(message: string): void;
  }> = [];
  const abandon: unknown[] = [];
  invoke.mockImplementation(async (channel, ...args) => {
    if (channel === "codex:thread:resume:retry") {
      expect(args).toEqual([prepared.receiptId]);
      await renewGate;
      return `thread/resume:retry-${++sequence}`;
    }
    if (channel === "codex:app-server:request:abandon") {
      abandon.push(args[0]);
      return;
    }
    if (channel !== "codex:app-server:request") throw new Error(`Unexpected operation ${channel}`);
    const input = args[0] as {
      request: { id: string; method: string; params: ThreadResumeParams };
      caller: CodexRendererRequestCaller;
    };
    expect(input.request.method).toBe("thread/resume");
    return await new Promise((resolve) => {
      requests.push({
        id: input.request.id,
        params: input.request.params,
        caller: input.caller,
        resolve: (value) => resolve({ type: "result", result: value }),
        fail: (message) => resolve({ type: "error", error: { code: -32603, message } }),
      });
    });
  });
  const native = new RendererNativeAppServer("local");
  const lifetime = {
    isCurrent: () => current,
    setRetryCleanup: (next: () => void) => {
      cleanup = next;
      if (!current) next();
    },
  };
  return {
    native,
    requests,
    abandon,
    send: (timeoutMs?: number) =>
      requestRendererConversationResume(native, prepared, lifetime, timeoutMs),
    cancel: () => {
      current = false;
      cleanup?.();
    },
    setRenewGate: (gate: Promise<void>) => {
      renewGate = gate;
    },
    [Symbol.dispose]: () => {
      current = false;
      cleanup?.();
      native[Symbol.dispose]();
    },
  };
}

it("uses three increasing default deadlines and isolates a late response from the next native attempt", async () => {
  using f = fixture();
  const pending = f.send();
  const rejected = expect(pending).rejects.toThrow("Timeout");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(f.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(749);
  expect(f.requests).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(f.requests).toHaveLength(2);
  f.requests[0]!.resolve({ ...response, thread: { ...response.thread, id: "late" } });
  await settle();
  await vi.advanceTimersByTimeAsync(240_000 + 750);
  expect(f.requests.map((request) => request.caller.timeoutMs)).toEqual([
    120_000, 240_000, 480_000,
  ]);
  expect(new Set(f.requests.map((request) => request.id)).size).toBe(3);
  expect(f.requests.every((request) => request.params === prepared.params)).toBe(true);
  await vi.advanceTimersByTimeAsync(480_000);
  await rejected;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.requests).toHaveLength(3);
  expect(f.abandon).toHaveLength(3);
});

it("keeps an explicit deadline across closing retries and accepts only the latest result", async () => {
  using f = fixture();
  const pending = f.send(30_000);
  f.requests[0]!.fail(closing);
  await vi.advanceTimersByTimeAsync(750);
  expect(f.requests).toHaveLength(2);
  expect(f.requests[1]!.caller.timeoutMs).toBe(30_000);
  f.requests[1]!.resolve(response);
  await expect(pending).resolves.toBe(response);
});

it("does not retry an explicit response timeout", async () => {
  using f = fixture();
  const pending = f.send(20);
  const rejected = expect(pending).rejects.toThrow("Timeout");
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.requests).toHaveLength(1);
});

it("cancellation resolves a scheduled backoff without dispatching or renewing another attempt", async () => {
  using f = fixture();
  const pending = f.send();
  f.requests[0]!.fail(closing);
  await settle();
  f.cancel();
  await expect(pending).resolves.toBeNull();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.requests).toHaveLength(1);
  expect(invoke.mock.calls.some(([channel]) => channel === "codex:thread:resume:retry")).toBe(
    false,
  );
});

it("cancellation during receipt renewal prevents the returned identity from dispatching", async () => {
  using f = fixture();
  let finish!: () => void;
  f.setRenewGate(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = f.send();
  f.requests[0]!.fail(closing);
  await vi.advanceTimersByTimeAsync(750);
  f.cancel();
  finish();
  await expect(pending).resolves.toBeNull();
  expect(f.requests).toHaveLength(1);
});

it("native lifetime retirement settles an in-flight resume and ignores its late response", async () => {
  using f = fixture();
  const pending = f.send();
  const rejected = expect(pending).rejects.toThrow("lifetime retired");
  f.cancel();
  f.native.retire();
  await rejected;
  f.requests[0]!.resolve(response);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(f.requests).toHaveLength(1);
});
