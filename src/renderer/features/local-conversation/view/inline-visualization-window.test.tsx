import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  CodexConversationResumeState,
  CodexEvent,
  CodexVisualizationReadResult,
} from "../../../../shared/types";
import type { LocalConversationAttachmentState } from "../conversation-attachment-state";
import type {
  createInlineVisualizationRuntime,
  InlineVisualizationRuntime,
} from "../../../lib/inline-visualization/inline-visualization-runtime";
import { createInlineVisualizationAnnotations } from "../../../lib/inline-visualization/inline-visualization-annotations";
import {
  dispatchCodexAppServerMessage,
  __resetCodexAppServerMessageBusForTests,
} from "../app-server-message-bus";
import { ConversationVisualizationContext } from "./inline-visualization-context";
import { LocalConversationInlineVisualization } from "./local-conversation-inline-visualization";
import { InlineVisualizationWindowLifecycle } from "./inline-visualization-window-lifecycle";
import {
  InlineVisualizationSurfaceProvider,
  InlineVisualizationWindowProvider,
} from "./inline-visualization-window";

type RuntimeInput = Parameters<typeof createInlineVisualizationRuntime>[0];
const boundary = vi.hoisted(() => ({
  create: vi.fn<(input: RuntimeInput) => InlineVisualizationRuntime>(),
  query: vi.fn<() => Promise<CodexVisualizationReadResult>>(),
  registry: vi.fn(),
  events: new Set<(event: CodexEvent) => void>(),
  close: null as ((...args: unknown[]) => void) | null,
  acknowledgeClose: vi.fn(async (_webContentsId: number) => {}),
}));
vi.mock("../../../lib/app-close-flush-deps", () => ({
  notifyAppCloseFlushComplete: boundary.acknowledgeClose,
  readAppCloseBridge: () => ({
    on: (_event: string, listener: (...args: unknown[]) => void) => {
      boundary.close = listener;
      return () => {};
    },
  }),
}));
vi.mock("../../../lib/inline-visualization/inline-visualization-runtime", () => ({
  createInlineVisualizationRuntime: boundary.create,
}));
vi.mock("../../../lib/renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/renderer-command")>()),
  invokeRendererQuery: boundary.query,
}));
vi.mock("../local-conversation-store", () => ({ useCodexAppServerRegistry: boundary.registry }));
vi.mock("../local-conversation-deps", () => ({
  subscribeCodexEvents: (listener: (event: CodexEvent) => void) => {
    boundary.events.add(listener);
    return () => boundary.events.delete(listener);
  },
}));

const fragment = { path: "/owned/widget.html", contents: "<button>Owned response</button>" };
const instances: Array<{ input: RuntimeInput; runtime: InlineVisualizationRuntime }> = [];
const clients: QueryClient[] = [];
beforeEach(() => {
  instances.length = 0;
  boundary.events.clear();
  boundary.acknowledgeClose.mockClear();
  boundary.query.mockReset().mockResolvedValue(fragment);
  boundary.create.mockReset().mockImplementation((input) => {
    const element = document.createElement("button");
    input.mountTarget?.append(element);
    element.textContent = input.scopeId;
    const snapshot = {
      status: "ready" as const,
      height: input.initialHeight ?? 240,
      fullscreenHeight: null,
      displayMode: "inline" as const,
      error: null,
    };
    const runtime: InlineVisualizationRuntime = {
      element,
      annotations: createInlineVisualizationAnnotations({ allowed: true, globals: () => {} }),
      setActive: vi.fn(),
      getSnapshot: () => snapshot,
      subscribe: () => () => {},
      setDisplayMode: () => "inline",
      captureImage: vi.fn(async () => new Uint8Array()),
      copyAsImage: vi.fn(async () => {}),
      dispose: vi.fn(async () => {
        element.remove();
      }),
    };
    instances.push({ input, runtime });
    return runtime;
  });
  __resetCodexAppServerMessageBusForTests();
});
afterEach(() => {
  clients.splice(0).forEach((client) => client.clear());
  vi.useRealTimers();
  __resetCodexAppServerMessageBusForTests();
});

function queryClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return client;
}

function Thread({
  hostId = "local",
  threadId,
  surfaceId = "main",
}: {
  readonly hostId?: string;
  readonly threadId: string;
  readonly surfaceId?: string;
}) {
  return (
    <InlineVisualizationSurfaceProvider id={surfaceId} hostId={hostId} threadId={threadId} active>
      <ConversationVisualizationContext.Provider
        value={{
          hostId,
          threadId,
          turnId: "native-turn",
          turnSearchKey: "native-turn",
          markdownStreaming: false,
          readChangedFilePaths: () => [],
        }}
      >
        <LocalConversationInlineVisualization file="widget.html" />
      </ConversationVisualizationContext.Provider>
    </InlineVisualizationSurfaceProvider>
  );
}

// Native conversation metadata per host and Thread, with the store's change signals.
function nativeRegistry(defaultResumeState: CodexConversationResumeState = "resumed") {
  const key = (hostId: string, threadId: string) => JSON.stringify([hostId, threadId]);
  const states = new Map<string, CodexConversationResumeState | null>();
  const attachments = new Map<string, LocalConversationAttachmentState>();
  const subscriptions = new Map<string, Set<() => void>>();
  const subscribe = (hostId: string, threadId: string, listener: () => void) => {
    const callbacks = subscriptions.get(key(hostId, threadId)) ?? new Set();
    callbacks.add(listener);
    subscriptions.set(key(hostId, threadId), callbacks);
    return () => callbacks.delete(listener);
  };
  const read = vi.fn((hostId: string, threadId: string) => ({
    resumeState: states.has(key(hostId, threadId))
      ? states.get(key(hostId, threadId))!
      : defaultResumeState,
  }));
  boundary.registry.mockReturnValue({
    getForHostId: (hostId: string) => ({
      readConversation: (threadId: string) => read(hostId, threadId),
      addConversationCallback: (threadId: string, listener: () => void) =>
        subscribe(hostId, threadId, listener),
      readConversationAttachmentState: (threadId: string) =>
        attachments.get(key(hostId, threadId)) ?? { status: "idle" },
      subscribeConversationAttachment: (threadId: string, listener: () => void) =>
        subscribe(hostId, threadId, listener),
    }),
  });
  return {
    read,
    update: (
      hostId: string,
      threadId: string,
      change: {
        resumeState?: CodexConversationResumeState | null;
        attachment?: LocalConversationAttachmentState;
      },
    ) => {
      if ("resumeState" in change) states.set(key(hostId, threadId), change.resumeState!);
      if (change.attachment) attachments.set(key(hostId, threadId), change.attachment);
      subscriptions.get(key(hostId, threadId))?.forEach((listener) => listener());
    },
  };
}

describe("window-owned interactive responses", () => {
  test("window close cancels preparation that has not reached its background admission", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    const view = render(
      <InlineVisualizationWindowProvider>{null}</InlineVisualizationWindowProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(view.container.querySelector("webview")).toBeNull();
    await act(async () => {
      if (!boundary.close) throw new Error("Expected the window close coordinator");
      boundary.close(42);
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(boundary.acknowledgeClose).toHaveBeenCalledExactlyOnceWith(42);
    expect(view.container.querySelector("webview")).toBeNull();
  });

  test("window close retires parked, active and warming guests before acknowledging native shutdown", async () => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    });
    const client = queryClient();
    const tree = (threadId: string) => (
      <QueryClientProvider client={client}>
        <InlineVisualizationWindowProvider>
          <Thread threadId={threadId} />
        </InlineVisualizationWindowProvider>
      </QueryClientProvider>
    );
    const view = render(tree("thread-a"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(instances).toHaveLength(1);
    await act(async () => {
      view.rerender(tree("thread-b"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(instances).toHaveLength(2);
    const [parked, active] = instances;
    if (!parked || !active) throw new Error("Expected both retained documents");
    expect(parked.runtime.setActive).toHaveBeenLastCalledWith(false);
    expect(active.runtime.setActive).toHaveBeenLastCalledWith(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await vi.waitFor(() => expect(view.container.querySelector("webview")).not.toBeNull());
    const standby = view.container.querySelector("webview")!;
    expect(standby.isConnected).toBe(true);
    let acknowledgedState: unknown;
    boundary.acknowledgeClose.mockImplementationOnce(async (webContentsId) => {
      acknowledgedState = {
        webContentsId,
        windowConnected: view.container.isConnected,
        standbyConnected: standby.isConnected,
        parkedConnected: parked.runtime.element.isConnected,
        activeConnected: active.runtime.element.isConnected,
      };
    });

    await act(async () => {
      if (!boundary.close) throw new Error("Expected the window close coordinator");
      boundary.close(42);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(boundary.acknowledgeClose).toHaveBeenCalledOnce());
    expect(acknowledgedState).toEqual({
      webContentsId: 42,
      windowConnected: true,
      standbyConnected: false,
      parkedConnected: false,
      activeConnected: false,
    });
    expect(parked.runtime.dispose).toHaveBeenCalledOnce();
    expect(active.runtime.dispose).toHaveBeenCalledOnce();
    await act(async () => {
      window.dispatchEvent(new Event("languagechange"));
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(view.container.querySelector("webview")).toBeNull();
    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
    expect(parked.runtime.dispose).toHaveBeenCalledOnce();
    expect(active.runtime.dispose).toHaveBeenCalledOnce();
  });

  test("actual application deletion releases only the deleted host's retained guest", async () => {
    boundary.registry.mockReturnValue({
      getForHostId: () => ({
        addConversationCallback: () => () => {},
        readConversation: () => ({ resumeState: "resumed" }),
      }),
    });
    const client = queryClient();
    const view = render(
      <QueryClientProvider client={client}>
        <InlineVisualizationWindowProvider>
          <InlineVisualizationWindowLifecycle />
          <Thread hostId="local" threadId="shared-thread" />
          <Thread hostId="remote" threadId="shared-thread" surfaceId="remote-main" />
        </InlineVisualizationWindowProvider>
      </QueryClientProvider>,
    );
    await view.findByText((_, node) => node === instances[1]?.runtime.element);
    const local = instances[0]!;
    const remote = instances[1]!;
    await act(async () => {
      for (const listener of boundary.events)
        listener({ type: "threadDeleted", hostId: "local", threadId: "shared-thread" });
    });
    expect(local.runtime.dispose).toHaveBeenCalledOnce();
    expect(remote.runtime.dispose).not.toHaveBeenCalled();
    await act(async () => {
      for (const listener of boundary.events)
        listener({ type: "threadDeleted", hostId: "remote", threadId: "shared-thread" });
    });
    expect(remote.runtime.dispose).toHaveBeenCalledOnce();
  });
  test("A-B-A survives real query garbage collection and a pending file reload without restarting the document", async () => {
    const client = queryClient();
    const tree = (threadId: string) => (
      <QueryClientProvider client={client}>
        <InlineVisualizationWindowProvider>
          <Thread threadId={threadId} />
        </InlineVisualizationWindowProvider>
      </QueryClientProvider>
    );
    const view = render(tree("thread-a"));
    await view.findByText((_, node) => node === instances[0]?.runtime.element);
    const original = instances[0];
    if (!original) throw new Error("Expected the loaded A document");
    await act(async () => {
      original.input.onInlineHeight?.(456);
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await act(async () => {
      view.rerender(tree("thread-b"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(instances).toHaveLength(2);
    expect(original.runtime.element.isConnected).toBe(true);
    expect(original.runtime.setActive).toHaveBeenLastCalledWith(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_001);
    });
    expect(client.getQueryCache().getAll()).toHaveLength(1);
    let complete: ((value: CodexVisualizationReadResult) => void) | undefined;
    boundary.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    await act(async () => {
      view.rerender(tree("thread-a"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(boundary.query).toHaveBeenCalledTimes(3);
    expect(instances).toHaveLength(2);
    expect(original.runtime.dispose).not.toHaveBeenCalled();
    expect(original.runtime.setActive).toHaveBeenLastCalledWith(true);
    expect(view.queryByRole("status", { name: "Loading interactive response" })).toBeNull();
    expect(
      view.container.querySelector<HTMLElement>("[data-visualization-anchor]")?.style.height,
    ).toBe("456px");
    await act(async () => {
      complete?.({ ...fragment });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(instances).toHaveLength(2);
    boundary.query.mockResolvedValueOnce({
      ...fragment,
      contents: "<button>Changed response</button>",
    });
    await act(async () => {
      await client.invalidateQueries();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(instances).toHaveLength(3);
    expect(original.runtime.dispose).toHaveBeenCalledOnce();
    expect(instances[2]?.input.initialHeight).toBe(240);
    await act(async () => {
      original.input.onInlineHeight?.(900);
    });
    expect(
      view.container.querySelector<HTMLElement>("[data-visualization-anchor]")?.style.height,
    ).toBe("240px");
    await act(async () => {
      view.unmount();
      await Promise.resolve();
    });
    expect(instances.every(({ runtime }) => !runtime.element.isConnected)).toBe(true);
  });

  test("accepted host-scoped deletion and resume eviction release only detached documents", async () => {
    const sharedThread = "0197f6e8-8c00-7000-8000-000000000001";
    const otherThread = "0197f6e8-8c00-7000-8000-000000000002";
    const registry = nativeRegistry();
    const client = queryClient();
    const tree = (threadId: string) => (
      <QueryClientProvider client={client}>
        <InlineVisualizationWindowProvider>
          <InlineVisualizationWindowLifecycle />
          <Thread hostId="local" threadId={threadId} />
          <Thread hostId="remote" threadId={sharedThread} surfaceId="remote-main" />
        </InlineVisualizationWindowProvider>
      </QueryClientProvider>
    );
    const view = render(tree(sharedThread));
    await view.findByText((_, node) => node === instances[1]?.runtime.element);
    const local = instances[0];
    const remote = instances[1];
    if (!local || !remote) throw new Error("Expected both host-owned documents");
    await act(async () => {
      view.rerender(tree(otherThread));
    });
    await view.findByText((_, node) => node === instances[2]?.runtime.element);
    await act(async () => {
      registry.update("local", sharedThread, {});
    });
    expect(local.runtime.dispose).not.toHaveBeenCalled();
    expect(boundary.create).toHaveBeenCalledTimes(3);
    await act(async () => {
      registry.update("local", sharedThread, { resumeState: "needs_resume" });
    });
    expect(local.runtime.dispose).toHaveBeenCalledOnce();
    expect(remote.runtime.dispose).not.toHaveBeenCalled();
    await act(async () => {
      dispatchCodexAppServerMessage("thread-deleted", {
        hostId: "local",
        threadId: sharedThread,
      });
    });
    expect(remote.runtime.dispose).not.toHaveBeenCalled();
    await act(async () => {
      dispatchCodexAppServerMessage("thread-deleted", {
        hostId: "remote",
        threadId: sharedThread,
      });
    });
    expect(remote.runtime.dispose).toHaveBeenCalledOnce();
    expect(registry.read).toHaveBeenCalledWith("local", sharedThread);
    expect(registry.read).toHaveBeenCalledWith("remote", sharedThread);
  });
  test("attached read-only native history keeps its detached response until a reconnect invalidates it", async () => {
    const historyThread = "0197f6e8-8c00-7000-8000-000000000003";
    const otherThread = "0197f6e8-8c00-7000-8000-000000000004";
    // Attached native history is read without a resume.
    const registry = nativeRegistry("needs_resume");
    registry.update("local", historyThread, { attachment: { status: "attached" } });
    registry.update("local", otherThread, { attachment: { status: "attached" } });
    const client = queryClient();
    const tree = (threadId: string) => (
      <QueryClientProvider client={client}>
        <InlineVisualizationWindowProvider>
          <InlineVisualizationWindowLifecycle />
          <Thread threadId={threadId} />
        </InlineVisualizationWindowProvider>
      </QueryClientProvider>
    );
    const view = render(tree(historyThread));
    await view.findByText((_, node) => node === instances[0]?.runtime.element);
    const history = instances[0]!;
    await act(async () => {
      view.rerender(tree(otherThread));
    });
    await view.findByText((_, node) => node === instances[1]?.runtime.element);
    expect(history.runtime.dispose).not.toHaveBeenCalled();
    await act(async () => {
      registry.update("local", historyThread, { attachment: { status: "idle" } });
    });
    expect(history.runtime.dispose).toHaveBeenCalledOnce();
  });
  test("an Agent chat's detached response stays resident; its history needs no native resume", async () => {
    const read = vi.fn(() => null);
    boundary.registry.mockReturnValue({
      getForHostId: () => ({
        readConversation: read,
        addConversationCallback: () => () => {},
      }),
    });
    const client = queryClient();
    const tree = (threadId: string) => (
      <QueryClientProvider client={client}>
        <InlineVisualizationWindowProvider>
          <InlineVisualizationWindowLifecycle />
          <Thread threadId={threadId} />
        </InlineVisualizationWindowProvider>
      </QueryClientProvider>
    );
    const view = render(tree("nodex:thread:agent-chat"));
    await view.findByText((_, node) => node === instances[0]?.runtime.element);
    const agentChat = instances[0]!;
    await act(async () => {
      view.rerender(tree("nodex:thread:other-chat"));
    });
    await view.findByText((_, node) => node === instances[1]?.runtime.element);
    expect(agentChat.runtime.dispose).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });
});
