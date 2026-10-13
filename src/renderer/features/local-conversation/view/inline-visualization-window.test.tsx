import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  CodexConversationResumeState,
  CodexEvent,
  CodexVisualizationReadResult,
} from "../../../../shared/types";
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
  boundary.query.mockReset().mockResolvedValue(fragment);
  boundary.create.mockReset().mockImplementation((input) => {
    const element = document.createElement("button");
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

describe("window-owned interactive responses", () => {
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
    const states = new Map<string, CodexConversationResumeState | null>();
    const subscriptions = new Map<string, Set<() => void>>();
    const read = vi.fn((hostId: string, threadId: string) => ({
      resumeState: states.get(JSON.stringify([hostId, threadId])) ?? "resumed",
    }));
    boundary.registry.mockReturnValue({
      getForHostId: (hostId: string) => ({
        readConversation: (threadId: string) => read(hostId, threadId),
        addConversationCallback: (threadId: string, listener: () => void) => {
          const key = JSON.stringify([hostId, threadId]);
          const callbacks = subscriptions.get(key) ?? new Set();
          callbacks.add(listener);
          subscriptions.set(key, callbacks);
          return () => callbacks.delete(listener);
        },
      }),
    });
    const client = queryClient();
    const tree = (threadId: string) => (
      <QueryClientProvider client={client}>
        <InlineVisualizationWindowProvider>
          <InlineVisualizationWindowLifecycle />
          <Thread hostId="local" threadId={threadId} />
          <Thread hostId="remote" threadId="shared-thread" surfaceId="remote-main" />
        </InlineVisualizationWindowProvider>
      </QueryClientProvider>
    );
    const view = render(tree("shared-thread"));
    await view.findByText((_, node) => node === instances[1]?.runtime.element);
    const local = instances[0];
    const remote = instances[1];
    if (!local || !remote) throw new Error("Expected both host-owned documents");
    await act(async () => {
      view.rerender(tree("other-thread"));
    });
    await view.findByText((_, node) => node === instances[2]?.runtime.element);
    const signal = (hostId: string, threadId: string) =>
      subscriptions.get(JSON.stringify([hostId, threadId]))?.forEach((listener) => listener());
    await act(async () => {
      signal("local", "shared-thread");
    });
    expect(local.runtime.dispose).not.toHaveBeenCalled();
    expect(boundary.create).toHaveBeenCalledTimes(3);
    await act(async () => {
      states.set(JSON.stringify(["local", "shared-thread"]), "needs_resume");
      signal("local", "shared-thread");
    });
    expect(local.runtime.dispose).toHaveBeenCalledOnce();
    expect(remote.runtime.dispose).not.toHaveBeenCalled();
    await act(async () => {
      dispatchCodexAppServerMessage("thread-deleted", {
        hostId: "local",
        threadId: "shared-thread",
      });
    });
    expect(remote.runtime.dispose).not.toHaveBeenCalled();
    await act(async () => {
      dispatchCodexAppServerMessage("thread-deleted", {
        hostId: "remote",
        threadId: "shared-thread",
      });
    });
    expect(remote.runtime.dispose).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith("local", "shared-thread");
    expect(read).toHaveBeenCalledWith("remote", "shared-thread");
  });
});
