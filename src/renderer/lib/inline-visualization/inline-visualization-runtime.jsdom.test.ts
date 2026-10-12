import { act, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  ConnectedMcpAppSandbox,
  connectMcpAppSandbox,
  McpAppSkybridgeApi,
} from "../mcp-app/mcp-app-port-rpc";
import {
  createInlineVisualizationRuntime,
  type InlineVisualizationRuntime,
} from "./inline-visualization-runtime";

type ConnectInput = Parameters<typeof connectMcpAppSandbox>[0];
const boundary = vi.hoisted(() => ({
  connect: vi.fn<(input: ConnectInput) => Promise<ConnectedMcpAppSandbox>>(),
  gesture: vi.fn<(key: string, input: unknown) => Promise<boolean>>(),
  external: vi.fn<(command: unknown, input: unknown) => Promise<void>>(async () => undefined),
}));
vi.mock("../mcp-app/mcp-app-port-rpc", () => ({ connectMcpAppSandbox: boundary.connect }));
vi.mock("../renderer-command", () => ({
  defineRendererCommand: (definition: unknown) => definition,
  invokeRendererControl: boundary.gesture,
  invokePlainCommand: boundary.external,
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Step =
  | { readonly type: "value"; readonly value: unknown }
  | { readonly type: "error"; readonly error: Error }
  | { readonly type: "end" };
function statusStream() {
  const pending: Step[] = [];
  let reader: ReturnType<typeof deferred<Step>> | null = null;
  const push = (step: Step) => {
    if (!reader) {
      pending.push(step);
      return;
    }
    const current = reader;
    reader = null;
    current.resolve(step);
  };
  const generator = (async function* () {
    while (true) {
      const step =
        pending.shift() ??
        (await (() => {
          reader = deferred<Step>();
          return reader.promise;
        })());
      if (step.type === "end") return;
      if (step.type === "error") throw step.error;
      yield step.value;
    }
  })();
  return {
    generator,
    status: (status: number) =>
      push({ type: "value", value: { type: "environment_status", status } }),
    fail: (error: Error) => push({ type: "error", error }),
    end: () => push({ type: "end" }),
  };
}

function sandboxAttempt(input: ConnectInput) {
  const stream = statusStream();
  const control = vi.fn(async () => undefined);
  const teardown = vi.fn<(value: unknown) => Promise<unknown>>(async () => undefined);
  const run = vi.fn(() => stream.generator);
  const api: McpAppSkybridgeApi = {
    navigate: control,
    notifyMcpAppsHostContext: control,
    notifyMcpAppsMcpNotification: null,
    notifyMcpAppsToolCancelled: control,
    notifyMcpAppsToolInput: control,
    notifyMcpAppsToolResult: control,
    requestMcpAppsResourceTeardown: teardown,
    runWidgetCode: run,
    setAdditionalGlobals: control,
    setSafeArea: control,
    setTheme: control,
    setWidgetData: control,
    setWidgetView: control,
  };
  const dispose = vi.fn(stream.end);
  const connected: ConnectedMcpAppSandbox = { api, dispose, initId: "synthetic-init" };
  input.webview.setAttribute("src", input.sourceUrl);
  input.signal?.addEventListener("abort", stream.end, { once: true });
  return { input, stream, run, teardown, dispose, connected };
}

const attempts: ReturnType<typeof sandboxAttempt>[] = [];
const runtimes: InlineVisualizationRuntime[] = [];
const timeout = () =>
  Object.assign(new Error("Sandbox initialization timed out"), { name: "TimeoutError" });
function mountRuntime(
  options: Partial<Parameters<typeof createInlineVisualizationRuntime>[0]> = {},
) {
  const runtime = createInlineVisualizationRuntime({
    scopeId: "synthetic-widget-runtime",
    html: "<p>Synthetic interactive content</p>",
    onInteraction: vi.fn(),
    ...options,
  });
  document.body.append(runtime.element);
  runtimes.push(runtime);
  return runtime;
}
async function readAttempt(index: number) {
  await waitFor(() => expect(attempts[index]?.run).toHaveBeenCalledOnce());
  const attempt = attempts[index];
  if (!attempt) throw new Error("Expected a connected sandbox attempt");
  return attempt;
}

beforeEach(() => {
  boundary.connect.mockReset();
  boundary.gesture.mockReset().mockResolvedValue(true);
  boundary.external.mockClear();
  attempts.length = 0;
  runtimes.length = 0;
  boundary.connect.mockImplementation(async (input) => {
    const attempt = sandboxAttempt(input);
    attempts.push(attempt);
    return attempt.connected;
  });
});
afterEach(async () => {
  await Promise.all(runtimes.map((runtime) => runtime.dispose()));
});

describe("inline visualization runtime lifecycle", () => {
  test("admits fullscreen only while the retained document's presentation allows it", async () => {
    let canExpand = false;
    const runtime = mountRuntime({ canExpand: () => canExpand });
    const attempt = await readAttempt(0);
    expect(attempt.input.handlers.requestDisplayMode({ mode: "fullscreen" })).toEqual({
      mode: "inline",
    });
    expect(runtime.getSnapshot().displayMode).toBe("inline");
    canExpand = true;
    expect(attempt.input.handlers.requestDisplayMode({ mode: "fullscreen" })).toEqual({
      mode: "fullscreen",
    });
    expect(runtime.getSnapshot().displayMode).toBe("fullscreen");
    canExpand = false;
    runtime.setDisplayMode("inline");
    expect(runtime.getSnapshot().displayMode).toBe("inline");
    expect(attempts).toHaveLength(1);
    expect(attempt.dispose).not.toHaveBeenCalled();
  });
  test.each([
    ["environment-first", 275],
    ["height-first", 275],
    ["environment-first", 0],
    ["height-first", 0],
  ] as const)(
    "requires environment status 2 and a valid measurement (%s, %i)",
    async (order, height) => {
      const runtime = mountRuntime();
      const attempt = await readAttempt(0);
      await act(async () => {
        attempt.input.handlers.callTool("__codex_inline_visualization_ready__", {});
        attempt.input.handlers.notifyIntrinsicHeight(-1);
        attempt.stream.status(1);
      });
      expect(runtime.getSnapshot().status).toBe("loading");
      if (order === "height-first") {
        await act(async () => {
          attempt.input.handlers.notifyIntrinsicHeight(height);
        });
        expect(runtime.getSnapshot().status).toBe("loading");
      }
      await act(async () => {
        attempt.stream.status(2);
      });
      if (order === "environment-first") {
        expect(runtime.getSnapshot().status).toBe("loading");
        await act(async () => {
          attempt.input.handlers.callTool("__codex_inline_visualization_height__", {
            height,
            width: 400,
          });
        });
      }
      await waitFor(() =>
        expect(runtime.getSnapshot()).toMatchObject({ status: "ready", height, error: null }),
      );
    },
  );

  test("retries only the first initialization timeout with a fresh guest and retires old callbacks", async () => {
    const followUp = vi.fn(async () => undefined);
    const runtime = mountRuntime({ followUp });
    const first = await readAttempt(0);
    await act(async () => {
      first.input.handlers.notifyIntrinsicHeight(111);
      first.stream.fail(timeout());
    });
    const second = await readAttempt(1);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(first.input.signal?.aborted).toBe(true);
    expect(first.input.webview.isConnected).toBe(false);
    expect(second.input.webview).not.toBe(first.input.webview);
    expect(second.input.expectedOrigin).not.toBe(first.input.expectedOrigin);
    expect(second.input.signal?.aborted).toBe(false);
    await act(async () => {
      second.stream.status(2);
      expect(() => first.input.handlers.notifyIntrinsicHeight(999)).toThrow();
      expect(() =>
        first.input.handlers.notifyEnvironmentError(new Error("Retired attempt")),
      ).toThrow();
      expect(() =>
        first.input.handlers.sendFollowUpMessage({ prompt: "Retired proposal" }),
      ).toThrow();
    });
    expect(runtime.getSnapshot().status).toBe("loading");
    expect(runtime.getSnapshot().height).not.toBe(999);
    expect(boundary.gesture).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
    await act(async () => {
      second.input.handlers.notifyIntrinsicHeight(310);
    });
    await waitFor(() =>
      expect(runtime.getSnapshot()).toMatchObject({ status: "ready", height: 310 }),
    );
    expect(boundary.connect).toHaveBeenCalledTimes(2);
  });

  test("a second initialization timeout becomes an error without a third guest", async () => {
    const runtime = mountRuntime();
    const first = await readAttempt(0);
    await act(async () => {
      first.stream.fail(timeout());
    });
    const second = await readAttempt(1);
    const error = timeout();
    await act(async () => {
      second.stream.fail(error);
    });
    await waitFor(() => expect(runtime.getSnapshot()).toMatchObject({ status: "error", error }));
    expect(boundary.connect).toHaveBeenCalledTimes(2);
  });

  test("an ordinary guest failure becomes an error without a fresh sandbox", async () => {
    const runtime = mountRuntime();
    const attempt = await readAttempt(0);
    const error = new Error("Invalid guest document");
    await act(async () => {
      attempt.stream.fail(error);
    });
    await waitFor(() => expect(runtime.getSnapshot()).toMatchObject({ status: "error", error }));
    expect(boundary.connect).toHaveBeenCalledOnce();
  });

  test("the first timeout also restarts a guest that reported environment readiness", async () => {
    const runtime = mountRuntime();
    const first = await readAttempt(0);
    await act(async () => {
      first.input.handlers.notifyIntrinsicHeight(245);
      first.stream.status(2);
    });
    await waitFor(() => expect(runtime.getSnapshot().status).toBe("ready"));
    await act(async () => {
      first.stream.fail(timeout());
    });
    const second = await readAttempt(1);
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(first.input.signal?.aborted).toBe(true);
    expect(second.input.webview).not.toBe(first.input.webview);
    expect(runtime.getSnapshot().status).toBe("loading");
  });

  test("dispose fences pending and late follow-ups immediately while teardown releases the connection and guest", async () => {
    const followUp = vi.fn(async () => undefined);
    const review = vi.fn(async () => "Reviewed proposal");
    const onInteraction = vi.fn();
    const runtime = mountRuntime({ followUp, reviewFollowUp: review, onInteraction });
    const attempt = await readAttempt(0);
    const gesture = deferred<boolean>();
    boundary.gesture.mockImplementation(() => gesture.promise);
    const teardown = deferred<unknown>();
    attempt.teardown.mockImplementation(() => teardown.promise);
    const pending = Promise.resolve(
      attempt.input.handlers.sendFollowUpMessage({ prompt: "Pending proposal" }),
    );
    expect(boundary.gesture).toHaveBeenCalledOnce();
    const disposing = runtime.dispose();
    expect(attempt.input.signal?.aborted).toBe(true);
    expect(runtime.dispose()).toBe(disposing);
    const interactionCount = onInteraction.mock.calls.length;
    await act(async () => {
      expect(() =>
        attempt.input.handlers.sendFollowUpMessage({ prompt: "Late proposal" }),
      ).toThrow();
      expect(() => attempt.input.handlers.requestDisplayMode({ mode: "fullscreen" })).toThrow();
      gesture.resolve(true);
      await pending;
    });
    expect(boundary.gesture).toHaveBeenCalledOnce();
    expect(followUp).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(onInteraction).toHaveBeenCalledTimes(interactionCount);
    expect(runtime.getSnapshot().displayMode).toBe("inline");
    expect(attempt.dispose).not.toHaveBeenCalled();
    teardown.resolve(undefined);
    await disposing;
    expect(attempt.teardown).toHaveBeenCalledWith({ timeoutMs: 500 });
    expect(attempt.dispose).toHaveBeenCalledOnce();
    expect(runtime.element.isConnected).toBe(false);
    expect(attempt.input.webview.hasAttribute("src")).toBe(false);
  });

  test("a connection completing after disposal releases its ports without executing the guest", async () => {
    const connection = deferred<ConnectedMcpAppSandbox>();
    boundary.connect.mockImplementation(async (input) => {
      const attempt = sandboxAttempt(input);
      attempts.push(attempt);
      return connection.promise;
    });
    const runtime = mountRuntime();
    await waitFor(() => expect(attempts).toHaveLength(1));
    const attempt = attempts[0];
    if (!attempt) throw new Error("Expected the pending connection attempt");
    await runtime.dispose();
    expect(attempt.input.signal?.aborted).toBe(true);
    connection.resolve(attempt.connected);
    await waitFor(() => expect(attempt.dispose).toHaveBeenCalledOnce());
    expect(attempt.run).not.toHaveBeenCalled();
    expect(runtime.element.isConnected).toBe(false);
  });
});
