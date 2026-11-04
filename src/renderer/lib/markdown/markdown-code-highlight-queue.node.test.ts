import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { CODE_BLOCK_SYNTAX_THEME_NAME } from "../code-block-syntax-theme";
import {
  CODE_HIGHLIGHT_IDLE_MS,
  CODE_HIGHLIGHT_INTERVAL_MS,
  createCodeHighlightQueue,
  createCodeHighlightScheduler,
  MAX_FALLBACK_CODE_UNITS,
  MAX_WORKER_CODE_UNITS,
  type CodeHighlightRequest,
  type CodeHighlightTokens,
  type RequestCodeHighlight,
} from "./markdown-code-highlight-queue";

const input = (code: string, incomplete = false): CodeHighlightRequest => ({
  code,
  language: "typescript",
  theme: CODE_BLOCK_SYNTAX_THEME_NAME,
  incomplete,
});
const paint = (content: string): CodeHighlightTokens => ({ tokens: [[{ content, offset: 0 }]] });
const visible = () => true;

function harness() {
  const worker = Object.assign(new EventTarget(), {
    postMessage: vi.fn(),
    terminate: vi.fn(),
  });
  const create = vi.fn(() => worker);
  const fallback = vi.fn(async (request: CodeHighlightRequest) => paint(request.code));
  const load = vi.fn(async () => fallback);
  const request = createCodeHighlightQueue(create, load);
  const reply = (data: CodeHighlightTokens | null) =>
    worker.dispatchEvent(new MessageEvent("message", { data }));
  return { worker, create, fallback, load, request, reply };
}

afterEach(() => vi.useRealTimers());

describe("read-only code highlight queue", () => {
  test("runs one FIFO job and removes queued work without interrupting active work", () => {
    vi.useFakeTimers();
    const { worker, request, reply, create } = harness();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    const d = vi.fn();
    const cancelA = request(input("a"), a, visible);
    const cancelB = request(input("b"), b, visible);
    request(input("c"), c, visible);
    request(input("d"), d, visible);
    cancelA();
    cancelB();
    expect(worker.postMessage.mock.calls).toEqual([[input("a")]]);
    reply(paint("a"));
    expect(worker.postMessage.mock.calls).toEqual([[input("a")], [input("c")]]);
    reply(paint("c"));
    expect(c).toHaveBeenCalledExactlyOnceWith({ ...input("c"), paint: paint("c") });
    reply(paint("d"));
    expect(d).toHaveBeenCalledOnce();
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    vi.advanceTimersByTime(CODE_HIGHLIGHT_IDLE_MS - 1);
    expect(worker.terminate).not.toHaveBeenCalled();
    request(input("e"), vi.fn(), visible);
    vi.advanceTimersByTime(CODE_HIGHLIGHT_IDLE_MS);
    expect(worker.terminate).not.toHaveBeenCalled();
    reply(paint("e"));
    vi.advanceTimersByTime(CODE_HIGHLIGHT_IDLE_MS);
    expect(worker.terminate).toHaveBeenCalledOnce();
    request(input("f"), vi.fn(), visible);
    expect(create).toHaveBeenCalledTimes(2);
  });

  test.each(["construct", "post", "error", "null"] as const)(
    "%s failure permanently retires the worker and uses one bounded fallback",
    async (failure) => {
      vi.useFakeTimers();
      const { worker, request, reply, create, load, fallback } = harness();
      if (failure === "construct")
        create.mockImplementationOnce(() => {
          throw new Error();
        });
      if (failure === "post")
        worker.postMessage.mockImplementationOnce(() => {
          throw new Error();
        });
      const first = vi.fn();
      request(input("first"), first, visible);
      request(input("offscreen"), vi.fn(), () => false);
      request(input("x".repeat(MAX_FALLBACK_CODE_UNITS + 1)), vi.fn(), visible);
      request(input("x".repeat(MAX_WORKER_CODE_UNITS + 1)), vi.fn(), visible);
      const last = vi.fn();
      request(input("last"), last, visible);
      if (failure === "error") worker.dispatchEvent(new Event("error", { cancelable: true }));
      if (failure === "null") reply(null);
      await vi.runAllTimersAsync();
      expect(load).toHaveBeenCalledOnce();
      expect(fallback.mock.calls).toEqual([[input("first")], [input("last")]]);
      expect(create).toHaveBeenCalledOnce();
      expect(first).toHaveBeenCalledExactlyOnceWith({ ...input("first"), paint: paint("first") });
      expect(last).toHaveBeenCalledExactlyOnceWith({ ...input("last"), paint: paint("last") });
    },
  );

  test("rechecks cancellation after loading the renderer fallback", async () => {
    let resolve!: (engine: (request: CodeHighlightRequest) => Promise<CodeHighlightTokens>) => void;
    const promise = new Promise<(request: CodeHighlightRequest) => Promise<CodeHighlightTokens>>(
      (done) => {
        resolve = done;
      },
    );
    const fallback = vi.fn(async (request: CodeHighlightRequest) => paint(request.code));
    const load = vi.fn(() => promise);
    const request = createCodeHighlightQueue(() => {
      throw new Error();
    }, load);
    const onResult = vi.fn();
    const cancel = request(input("gone"), onResult, visible);
    await Promise.resolve();
    expect(load).toHaveBeenCalledOnce();
    cancel();
    resolve(fallback);
    await promise;
    expect(fallback).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  test("starts immediately, flushes the latest input at 120 ms, and cancels trailing work", () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const request = vi.fn<RequestCodeHighlight>(() => cancel);
    const onResult = vi.fn();
    const scheduler = createCodeHighlightScheduler(request, onResult);
    scheduler.update(input("a", true), visible);
    scheduler.update(input("ab", true), visible);
    vi.advanceTimersByTime(CODE_HIGHLIGHT_INTERVAL_MS - 1);
    expect(cancel).not.toHaveBeenCalled();
    scheduler.update(input("abc"), visible);
    expect(request.mock.calls.map(([value]) => value)).toEqual([input("a", true)]);
    vi.advanceTimersByTime(1);
    expect(request.mock.calls.map(([value]) => value)).toEqual([input("a", true), input("abc")]);
    expect(cancel).toHaveBeenCalledOnce();
    scheduler.update(input("abcd"), visible);
    scheduler.cancel();
    vi.advanceTimersByTime(CODE_HIGHLIGHT_INTERVAL_MS);
    expect(request).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
