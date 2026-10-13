import { act, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import { renderWithMaitai as render } from "../../../test/thread-maitai";
import { createTestQueryClient, TestQueryProvider } from "../../../test/query";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import {
  childThreadSummaryQueryOptions,
  createdThreadResolutionQueryOptions,
} from "../../../lib/codex-created-thread-runtime";
import { buildTurnRenderModel } from "../projection/build-turn-render-model";
import { ThreadBlockRenderer } from "./blocks/local-conversation-block-renderer";
import { LocalConversationCreatedThreadCards } from "./local-conversation-created-thread-cards";
import type {
  CodexChildThreadSummary,
  CodexCreatedThreadResolution,
} from "../../../../shared/codex-child-thread-summary";

const state = vi.hoisted(() => ({
  connected: false,
  aeon: false,
  listeners: new Set<() => void>(),
}));
vi.mock("../created-thread-host-hooks", async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  };
  return {
    useExistingCreatedThreadHost: () => ({
      connected: useSyncExternalStore(subscribe, () => state.connected),
      manager: {
        observeThreadMetadata: () => () => {},
        readConversation: () => null,
        readThreadSummary: () => null,
      },
    }),
    useCreatedThreadSourceAeon: () => useSyncExternalStore(subscribe, () => state.aeon),
  };
});
const originalApi = window.api;
const requests: unknown[][] = [];
let resolver = () => ({
  hostId: "remote",
  threadId: "child",
  clientThreadId: "client-new-thread:pending",
  ready: false,
  parentThreadId: null,
});
beforeEach(() => {
  state.connected = false;
  state.aeon = false;
  requests.length = 0;
  window.api = {
    ...originalApi,
    on: () => () => {},
    invoke: async (channel, ...args) => {
      requests.push([channel, ...args]);
      if (channel === "codex:created-thread:resolve") return resolver();
      if (channel === "codex:thread:child-summary") {
        const input = args[0] as { hostId: string; threadId: string };
        return {
          ...input,
          title: `Title ${input.threadId}`,
          status: { type: "idle" },
          latestReply: `Reply ${input.threadId}`,
        };
      }
      return null;
    },
  };
});
afterEach(() => {
  window.api = originalApi;
});
function assistant(source: string, completed: boolean) {
  const item: CodexConversationItem = {
    threadId: "parent",
    turnId: "turn",
    itemId: "answer",
    entryId: "answer",
    type: "agentMessage",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    role: "assistant",
    status: completed ? "completed" : "inProgress",
    assistantPhase: "final_answer",
    markdownText: source,
    createdAt: 1,
    updatedAt: 1,
  };
  const turn: CodexConversationTurn = {
    threadId: "parent",
    turnId: "turn",
    status: "inProgress",
    itemIds: [item.itemId],
    items: [item],
  };
  const model = buildTurnRenderModel({
    turn,
    requests: [],
    isLatestTurn: true,
    isStreamingTurn: true,
  });
  const block = model.trailingBlocks.find((block) => block.type === "assistantMessage");
  if (!block) throw new Error("Missing assistant body");
  return block;
}
describe("created chat rich list", () => {
  test("completed item metadata adds cards during an active Turn without replacing its document", async () => {
    const client = createTestQueryClient();
    const source = 'Public answer\n\n::created-thread{threadId="child" hostId="remote"}';
    const onOpenThread = vi.fn();
    const surface = (completed: boolean) => (
      <TestQueryProvider client={client}>
        <NodexTooltipProvider>
          <ThreadBlockRenderer
            block={assistant(source, completed)}
            hostId="source"
            isLatestTurn
            isStreamingTurn
            onOpenThread={onOpenThread}
          />
        </NodexTooltipProvider>
      </TestQueryProvider>
    );
    const view = render(surface(false));
    const publicDocument = await view.findByText(
      (_text, node) => node?.tagName === "P" && node.textContent === "Public answer",
    );
    expect(view.queryByRole("button", { name: "Open chat: Created chat" })).toBeNull();
    view.rerender(surface(true));
    const card = await view.findByRole("button", { name: "Open chat: Created chat" });
    expect(
      view.getByText(
        (_text, node) => node?.tagName === "P" && node.textContent === "Public answer",
      ),
    ).toBe(publicDocument);
    expect(card.closest('[data-content-search-skip="true"]')).not.toBeNull();
    await act(async () => {
      fireEvent.click(card);
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledExactlyOnceWith("child", {
      createdTarget: { threadId: "child", hostId: "remote" },
      sourceRoot: { hostId: "source", threadId: "parent" },
    });
    await act(async () => {
      state.aeon = true;
      state.listeners.forEach((listener) => listener());
      await Promise.resolve();
    });
    expect(view.queryByRole("button", { name: "Open chat: Created chat" })).toBeNull();
    expect(requests.filter(([channel]) => String(channel).startsWith("codex:"))).toEqual([]);
    view.unmount();
    client.clear();
  });
  test("five results initially mount three observers and expand without querying a disconnected host", async () => {
    const client = createTestQueryClient();
    const results = Array.from({ length: 5 }, (_, index) => ({
      threadId: `child-${index}`,
      hostId: "remote",
    }));
    const surface = () => (
      <TestQueryProvider client={client}>
        <LocalConversationCreatedThreadCards results={results} />
      </TestQueryProvider>
    );
    const view = render(surface());
    expect(view.getAllByRole("button", { name: "Open chat: Created chat" })).toHaveLength(3);
    expect(requests).toEqual([]);
    await act(async () => {
      state.connected = true;
      state.listeners.forEach((listener) => listener());
      await Promise.resolve();
    });
    await view.findByRole("button", { name: "Open chat: Title child-2" });
    expect(requests.filter(([channel]) => channel === "codex:thread:child-summary")).toHaveLength(
      3,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Show 2 more chats" }));
      await Promise.resolve();
    });
    await view.findByRole("button", { name: "Open chat: Title child-4" });
    expect(requests.filter(([channel]) => channel === "codex:thread:child-summary")).toHaveLength(
      5,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Show fewer chats" }));
      await Promise.resolve();
    });
    expect(view.getAllByRole("button", { name: /^Open chat:/ })).toHaveLength(3);
    view.unmount();
    client.clear();
  });
  test("a pending card upgrades its read target while preserving the button and focus", async () => {
    const client = createTestQueryClient();
    state.connected = true;
    resolver = () => ({
      hostId: "remote",
      threadId: "child",
      clientThreadId: "client-new-thread:pending",
      ready: false,
      parentThreadId: null,
    });
    const result = { clientThreadId: "client-new-thread:pending", hostId: "remote" };
    const view = render(
      <TestQueryProvider client={client}>
        <LocalConversationCreatedThreadCards results={[result]} />
      </TestQueryProvider>,
    );
    const card = await view.findByRole("button", { name: "Open chat: Worktree chat" });
    await waitFor(() =>
      expect(
        requests.filter(([channel]) => channel === "codex:created-thread:resolve"),
      ).toHaveLength(1),
    );
    expect(requests.filter(([channel]) => channel === "codex:thread:child-summary")).toHaveLength(
      0,
    );
    await act(async () => {
      card.focus();
      const resolution: CodexCreatedThreadResolution = {
        hostId: "remote",
        threadId: "child",
        clientThreadId: result.clientThreadId,
        ready: true,
        parentThreadId: null,
      };
      client.setQueryData(
        createdThreadResolutionQueryOptions({
          clientThreadId: result.clientThreadId,
          expectedHostId: "remote",
        }).queryKey,
        resolution,
      );
      await Promise.resolve();
    });
    const ready = await view.findByRole("button", { name: "Open chat: Title child" });
    expect(ready).toBe(card);
    expect(document.activeElement).toBe(card);
    expect(
      client.getQueryData(
        childThreadSummaryQueryOptions({ hostId: "remote", threadId: "child" }).queryKey,
      ),
    ).toMatchObject({ latestReply: "Reply child" });
    view.unmount();
    client.clear();
  });
  test("cached reply survives a background refresh and active status takes precedence", async () => {
    const client = createTestQueryClient();
    state.connected = true;
    const options = childThreadSummaryQueryOptions({ hostId: "remote", threadId: "child" });
    const cached = {
      hostId: "remote",
      threadId: "child",
      title: "Cached",
      status: { type: "idle" as const },
      latestReply: "Saved reply",
    };
    client.setQueryData(options.queryKey, cached);
    let resolve!: (value: typeof cached) => void;
    const pending = new Promise<typeof cached>((accept) => {
      resolve = accept;
    });
    if (!window.api) throw new Error("Missing renderer fixture API");
    window.api.invoke = async () => await pending;
    const view = render(
      <TestQueryProvider client={client}>
        <LocalConversationCreatedThreadCards results={[{ hostId: "remote", threadId: "child" }]} />
      </TestQueryProvider>,
    );
    await view.findByText("Saved reply");
    await act(async () => {
      void client.invalidateQueries({ queryKey: options.queryKey });
      await Promise.resolve();
    });
    expect(view.getByText("Saved reply")).toBeTruthy();
    expect(view.queryByText("Working")).toBeNull();
    await act(async () => {
      resolve({ ...cached, latestReply: "New reply" });
      await Promise.resolve();
    });
    await view.findByText("New reply");
    await act(async () => {
      const active: CodexChildThreadSummary = {
        ...cached,
        status: { type: "active", activeFlags: [] },
      };
      client.setQueryData(options.queryKey, active);
      await Promise.resolve();
    });
    await view.findByText("Working", { selector: '[data-codex-shimmer="cadenced"]' });
    expect(view.queryByText("Saved reply")).toBeNull();
    view.unmount();
    client.clear();
  });
});
