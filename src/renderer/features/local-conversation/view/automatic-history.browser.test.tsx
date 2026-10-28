import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { page } from "vite-plus/test/browser";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type {
  AgentHistoryPage,
  AgentSnapshot,
  AgentTurnItem,
} from "@nodex/agent-runtime/contracts";
import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import { projectCodexTranscript } from "../../../../shared/codex-transcript-projection";
import type { CodexCanonicalUserMessageItem } from "../../../../shared/codex-conversation-state/codex-conversation-state";
import type {
  AgentRuntimeConversation,
  AgentRuntimeSessionEvent,
} from "../../../../shared/agent-runtime-api";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import {
  AgentRuntimeConversationOwner,
  type AgentRuntimeReadTransport,
} from "../agent-runtime-conversation-owner";
import {
  CodexTranscriptReadOwnerContext,
  useCodexTranscriptStructure,
} from "../normalized-transcript-hooks";
import { selectNormalizedConversationTurnEntries } from "../normalized-transcript-selectors";
import { projectNormalizedTimelineEntries } from "../projection/normalized-timeline-entries";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import {
  EnsureLocalConversationThreadScrollController,
  getThreadScrollDistanceFromBottomPx,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import { LocalConversationVirtualizedTurnList } from "./local-conversation-virtualized-turn-list";
import "../../../globals.css";

const target = { sessionId: "history-session", threadId: "history-thread" };
const at = "2026-10-23T00:00:00.000Z";
const originalApi = window.api;
beforeEach(async () => {
  await page.viewport(800, 700);
  window.api = {
    on: () => () => {},
    invoke: async (channel) =>
      channel === "persisted-atom:sync-request"
        ? { revision: 0, values: {} }
        : channel === "codex:app-server:request"
          ? { type: "result", result: { data: [], nextCursor: null } }
          : undefined,
  };
});
afterEach(() => {
  window.api = originalApi;
  vi.restoreAllMocks();
});
const frames = async () => {
  for (let index = 0; index < 3; index++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
const base = (id: string, ordinal: number) => ({
  id,
  ordinal,
  threadId: target.threadId,
  runId: `run:${ordinal}`,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});
const user = (ordinal: number, lines = 6): Extract<AgentTurnItem, { type: "user_message" }> => ({
  ...base(`user:${ordinal}`, ordinal),
  type: "user_message",
  createdBy: "user",
  creationSource: "web",
  inputIntent: "turn_start",
  messageId: `message:${ordinal}`,
  text: [
    `Prompt ${ordinal}`,
    ...Array.from({ length: lines - 1 }, (_, line) => `Reading line ${line + 1}`),
  ].join("\n"),
  attachments: [],
});
const assistant = (text: string): AgentTurnItem => ({
  ...base("assistant", 100),
  type: "assistant_message",
  runId: "run:100",
  messageId: "assistant-message",
  text,
  streaming: true,
  status: "running",
  completedAt: null,
});
const row = (
  item: AgentTurnItem,
  position = 0,
): AgentSnapshot["projection"]["visibleTurnItems"][number] => ({
  position,
  visibility: "local",
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
});
function conversation(
  items: readonly AgentTurnItem[],
  cursor: string | null = null,
): AgentRuntimeConversation {
  return {
    ...target,
    projectId: "project",
    snapshot: {
      kind: "snapshot",
      snapshotSequence: 1,
      historyCursor: cursor,
      hasMoreHistory: cursor !== null,
      latestLocalTurnOrdinal: 20_000,
      payloadBudgetExceeded: false,
      turnItemsOmitLocalVisible: true,
      projection: {
        thread: {
          id: target.threadId,
          projectId: "project",
          title: "Thread",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: "claude",
          modelSelection: { instanceId: "claude", model: "model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/workspace",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: target.threadId,
          },
          forkedFrom: null,
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        runs: [
          {
            id: "run",
            threadId: target.threadId,
            ordinal: 1,
            providerInstanceId: "claude",
            modelSelection: { instanceId: "claude", model: "model" },
            providerThreadId: null,
            userMessageId: "user-message",
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: at,
            startedAt: at,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        messages: [],
        plans: [],
        turnItems: [],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: items.map(row),
        updatedAt: at,
      },
    },
  };
}
interface PendingPage {
  readonly cursor: string | null | undefined;
  readonly resolve: (page: AgentHistoryPage) => void;
  readonly reject: (cause: Error) => void;
}
function historyFixture(items: readonly AgentTurnItem[]) {
  const initial = conversation(items, "page:0");
  const requests: PendingPage[] = [];
  let listener: ((event: AgentRuntimeSessionEvent) => void) | undefined;
  let active = 0;
  let sequence = 1;
  let maxActive = 0;
  const transport: AgentRuntimeReadTransport = {
    read: async () => initial,
    control: async () => initial,
    history: ({ cursor }) => {
      active++;
      maxActive = Math.max(maxActive, active);
      return new Promise<AgentHistoryPage>((resolve, reject) => {
        requests.push({ cursor, resolve, reject });
      }).finally(() => {
        active--;
      });
    },
    promptIndex: async () => ({ prompts: [], complete: true }),
    item: async () => null,
    attachment: async () => null,
    readQueuePage: async () => ({
      snapshotSequence: 1,
      entries: [],
      nextCursor: null,
      nextRunId: null,
    }),
    readQueuedPreview: async () => null,
    readRunMessage: async () => null,
    subscribe: async (_target, next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  const owner = new AgentRuntimeConversationOwner(target, transport);
  return {
    owner,
    requests,
    get maxActive() {
      return maxActive;
    },
    async finish(index: number, items: readonly AgentTurnItem[], nextCursor: string | null) {
      await act(async () => {
        const request = requests[index];
        if (!request) throw new Error(`Missing history request ${index}`);
        request.resolve({
          snapshotSequence: 1,
          items: items.map(row),
          nextCursor,
          hasMoreHistory: nextCursor !== null,
        });
        await frames();
      });
    },
    async stream(text: string, runId = "run:100", beforeCommit?: () => void) {
      await act(async () => {
        beforeCommit?.();
        listener?.({
          type: "event",
          ...target,
          event: {
            sequence: ++sequence,
            commandId: null,
            event: {
              id: `stream:${sequence}`,
              threadId: target.threadId,
              occurredAt: at,
              type: "turn-item.updated",
              payload: { ...assistant(text), runId },
            },
          },
        });
        await frames();
      });
    },
  };
}
interface MountedHistoryFixture {
  readonly owner: {
    readonly readOwner: AgentRuntimeConversationOwner["readOwner"];
    readonly resume: () => Promise<unknown>;
    readonly dispose: () => void;
    readonly loadHistoryBoundary?: AgentRuntimeConversationOwner["loadHistoryBoundary"];
  };
}

function mountHistory(fixture: MountedHistoryFixture) {
  const store = createMaitaiStore();
  let controller: LocalConversationThreadScrollControllerValue | null = null;
  let ready = false;
  function Thread({ source }: { source: MountedHistoryFixture }) {
    const { owner, structure } = useCodexTranscriptStructure();
    const scroll = useLocalConversationThreadScrollController();
    useLayoutEffect(() => {
      controller = scroll;
    });
    if (!owner || !structure) return null;
    const projected = projectNormalizedTimelineEntries({
      owner,
      structure,
      entries: selectNormalizedConversationTurnEntries({ owner, structure, conversation: null }),
    });
    return (
      <div style={{ width: 700, height: 600 }}>
        <LocalConversationThreadScrollLayout>
          <LocalConversationVirtualizedTurnList
            entries={[...projected.entries]}
            historyRows={projected.historyRows ?? undefined}
            conversationId={source.owner.readOwner.key.threadId}
            threadCwd="/workspace"
            editableTurnIds={new Set()}
            canForkFromTurn={false}
            initialScrollOffset={0}
            initialRestoreState={null}
            initialLatestTurnRestoreState={null}
            onVisibleContentReady={() => {
              ready = true;
            }}
            historyRequestSource={source.owner}
            onLoadHistoryBoundary={source.owner.loadHistoryBoundary}
            scrollElement={scroll.scrollElement}
          />
        </LocalConversationThreadScrollLayout>
      </div>
    );
  }
  const renderTree = (source: MountedHistoryFixture) => (
    <MaitaiProvider store={store}>
      <LocalConversationTestQueryProvider>
        <NodexTooltipProvider>
          <CodexTranscriptReadOwnerContext.Provider value={source.owner.readOwner}>
            <EnsureLocalConversationThreadScrollController>
              <Thread source={source} />
            </EnsureLocalConversationThreadScrollController>
          </CodexTranscriptReadOwnerContext.Provider>
        </NodexTooltipProvider>
      </LocalConversationTestQueryProvider>
    </MaitaiProvider>
  );
  const view = render(renderTree(fixture));
  const scroll = () => {
    if (!controller) throw new Error("Missing thread scroll controller");
    return controller;
  };
  const viewport = () => {
    const element = scroll().getScrollElement();
    if (!element) throw new Error("Missing thread viewport");
    return element;
  };
  return {
    ...view,
    scroll,
    viewport,
    async replace(source: MountedHistoryFixture) {
      const release = source.owner.readOwner.subscribeStructure(() => {});
      try {
        await source.owner.resume();
        await act(async () => {
          view.rerender(renderTree(source));
          await frames();
        });
      } finally {
        release();
      }
    },
    async settle() {
      await waitFor(() => expect(ready).toBe(true));
      await act(async () => {
        await frames();
      });
    },
    async towardTop(offset = 100) {
      await act(async () => {
        const element = viewport();
        const nextScrollTop = offset;
        fireEvent.wheel(element, { deltaY: nextScrollTop - element.scrollTop });
        element.scrollTop = nextScrollTop;
        fireEvent.scroll(element);
        await frames();
      });
    },
    dispose() {
      view.unmount();
      fixture.owner.dispose();
      disposeMaitaiStore(store);
    },
  };
}

describe("automatic thread history in Chromium", () => {
  test("keeps an unreported upward movement out of bottom following through subsequent growth", async () => {
    const prompts = Array.from({ length: 12 }, (_, index): AgentTurnItem => ({
      ...user(index + 40),
      runId: "run",
      inputIntent: "steer",
    }));
    const fixture = historyFixture([...prompts, { ...assistant("Same-Turn reply"), runId: "run" }]);
    const view = mountHistory(fixture);
    const delayScrollDelivery = (event: Event) => event.stopImmediatePropagation();
    try {
      await view.settle();
      expect(view.scroll().getScrollMode()).toBe("stickToBottom");
      expect(getThreadScrollDistanceFromBottomPx(view.viewport())).toBe(0);
      const anchor = view.container.querySelector<HTMLElement>(
        '[data-client-user-message-id="message:51"]',
      )!;
      const before = anchor.getBoundingClientRect().top;
      expect(before).toBeGreaterThan(view.viewport().getBoundingClientRect().top);
      expect(before).toBeLessThan(view.viewport().getBoundingClientRect().bottom);
      await fixture.stream("A growing reply.\n\n".repeat(24), "run", () => {
        view.viewport().addEventListener("scroll", delayScrollDelivery, { capture: true });
        fireEvent.wheel(view.viewport(), { deltaY: -8 });
        view.viewport().scrollTop -= 8;
      });
      expect(anchor.isConnected).toBe(true);
      expect(Math.abs(anchor.getBoundingClientRect().top - before - 8)).toBeLessThanOrEqual(2);
      expect(view.scroll().getScrollMode()).toBe("user");
      view.viewport().removeEventListener("scroll", delayScrollDelivery, { capture: true });
      await act(async () => {
        fireEvent.scroll(view.viewport());
        await Promise.resolve();
      });
      await fixture.stream("A growing reply.\n\n".repeat(48), "run");
      expect(view.scroll().getScrollMode()).toBe("user");
      expect(Math.abs(anchor.getBoundingClientRect().top - before - 8)).toBeLessThanOrEqual(2);
    } finally {
      view.viewport().removeEventListener("scroll", delayScrollDelivery, { capture: true });
      view.dispose();
    }
  });

  test("resumes following when an unreported downward movement reaches the bottom threshold", async () => {
    const prompts = Array.from({ length: 12 }, (_, index): AgentTurnItem => ({
      ...user(index + 40),
      runId: "run",
      inputIntent: "steer",
    }));
    const fixture = historyFixture([...prompts, { ...assistant("Same-Turn reply"), runId: "run" }]);
    const view = mountHistory(fixture);
    const delayScrollDelivery = (event: Event) => event.stopImmediatePropagation();
    try {
      await view.settle();
      await act(async () => {
        view.scroll().scrollToDistanceFromBottomPx(28, "instant", "user");
        await frames();
      });
      expect(view.scroll().getScrollMode()).toBe("user");
      expect(getThreadScrollDistanceFromBottomPx(view.viewport())).toBe(28);
      await fixture.stream("A growing reply.\n\n".repeat(24), "run", () => {
        view.viewport().addEventListener("scroll", delayScrollDelivery, { capture: true });
        fireEvent.wheel(view.viewport(), { deltaY: 8 });
        view.viewport().scrollTop += 8;
      });
      expect(view.scroll().getScrollMode()).toBe("stickToBottom");
      expect(getThreadScrollDistanceFromBottomPx(view.viewport())).toBe(0);
      view.viewport().removeEventListener("scroll", delayScrollDelivery, { capture: true });
      await act(async () => {
        fireEvent.scroll(view.viewport());
        await Promise.resolve();
      });
      await fixture.stream("A growing reply.\n\n".repeat(48), "run");
      expect(view.scroll().getScrollMode()).toBe("stickToBottom");
      expect(getThreadScrollDistanceFromBottomPx(view.viewport())).toBe(0);
    } finally {
      view.viewport().removeEventListener("scroll", delayScrollDelivery, { capture: true });
      view.dispose();
    }
  });

  test("preserves a native user message without client correlation through same-Turn prepend and growth", async () => {
    const native = (first: number, reply: string, swapResidentMessages = false) => {
      const items: ThreadItem[] = Array.from(
        { length: 52 - first },
        (_, index): CodexCanonicalUserMessageItem => ({
          type: "userMessage",
          id: `native-user:${first + index}`,
          clientId: null,
          ...(first + index === 38 ? {} : { inputIntent: "steer" }),
          content: [{ type: "text", text: user(first + index).text, text_elements: [] }],
        }),
      );
      if (swapResidentMessages) {
        const firstIndex = items.findIndex((item) => item.id === "native-user:41");
        const secondIndex = items.findIndex((item) => item.id === "native-user:42");
        const firstItem = items[firstIndex]!;
        items[firstIndex] = items[secondIndex]!;
        items[secondIndex] = firstItem;
      }
      items.push({
        type: "agentMessage",
        id: "native-reply",
        text: reply,
        phase: "final_answer",
        memoryCitation: null,
        delivery: null,
        questions: null,
      });
      return timelineOwnerFixture(
        { data: [], nextCursor: null, activeRealtimeSessionAtPageStart: null },
        items,
        { status: "inProgress", completedAt: null },
      );
    };
    const first = native(40, "Same-Turn reply");
    const view = mountHistory({
      owner: {
        readOwner: first.owner,
        resume: async () => {},
        dispose: () => first.owner.dispose(),
      },
    });
    const replace = async (
      start: number,
      reply: string,
      beforeCommit?: () => void,
      swapResidentMessages = false,
    ) => {
      const next = native(start, reply, swapResidentMessages);
      try {
        await act(async () => {
          beforeCommit?.();
          first.owner.applyEvent({ type: "reset", value: projectCodexTranscript(next.state) });
          await frames();
        });
      } finally {
        next.owner.dispose();
      }
    };
    try {
      await view.settle();
      await view.towardTop();
      expect(view.viewport().scrollTop).toBe(100);
      expect(view.scroll().getScrollMode()).toBe("user");
      const anchor = view
        .getByText("Prompt 41", { exact: false })
        .closest<HTMLElement>('[data-user-message-bubble="true"]')!;
      expect(anchor).toBeTruthy();
      expect(anchor.hasAttribute("data-client-user-message-id")).toBe(false);
      const before = anchor.getBoundingClientRect().top;
      expect(before).toBeGreaterThanOrEqual(view.viewport().getBoundingClientRect().top);
      expect(before).toBeLessThan(view.viewport().getBoundingClientRect().bottom);
      await replace(38, "A growing native reply.\n\n".repeat(24), () => {
        // Native movement can precede its scroll event when a history receipt commits.
        fireEvent.wheel(view.viewport(), { deltaY: -8 });
        view.viewport().scrollTop -= 8;
      });
      expect(anchor.isConnected).toBe(true);
      const afterGesture = before + 8;
      expect(Math.abs(anchor.getBoundingClientRect().top - afterGesture)).toBeLessThanOrEqual(2);
      await replace(38, "A growing native reply.\n\n".repeat(48));
      expect(anchor.isConnected).toBe(true);
      expect(Math.abs(anchor.getBoundingClientRect().top - afterGesture)).toBeLessThanOrEqual(2);
      await view.towardTop(
        view.viewport().scrollTop +
          anchor.getBoundingClientRect().top -
          view.viewport().getBoundingClientRect().top,
      );
      const turn = anchor.closest<HTMLElement>("[data-turn-key]")!;
      const beforeReorderTop = anchor.getBoundingClientRect().top;
      const beforeReorderHeight = turn.getBoundingClientRect().height;
      // Equal-height native messages can change order without notifying ResizeObserver.
      await replace(38, "A growing native reply.\n\n".repeat(48), undefined, true);
      expect(turn.getBoundingClientRect().height).toBe(beforeReorderHeight);
      expect(anchor.isConnected).toBe(true);
      expect(Math.abs(anchor.getBoundingClientRect().top - beforeReorderTop)).toBeLessThanOrEqual(
        2,
      );
    } finally {
      view.dispose();
    }
  });

  test("keeps a resident steering message fixed through prepend and streamed growth inside the same Turn", async () => {
    const steering = (ordinal: number): AgentTurnItem => ({
      ...user(ordinal),
      runId: "run",
      inputIntent: "steer",
    });
    const fixture = historyFixture([
      ...Array.from({ length: 12 }, (_, index) => steering(index + 40)),
      { ...assistant("Same-Turn reply"), runId: "run" },
    ]);
    const view = mountHistory(fixture);
    try {
      await view.settle();
      await view.towardTop();
      await waitFor(() => expect(fixture.requests).toHaveLength(1));
      expect(fixture.owner.readOwner.readStructure()?.turnEntityKeys).toHaveLength(1);
      const anchor = view.container.querySelector<HTMLElement>(
        '[data-client-user-message-id="message:40"]',
      );
      if (!anchor) throw new Error("Missing resident steering message");
      const before = anchor.getBoundingClientRect().top;
      const beforeScrollTop = view.viewport().scrollTop;
      expect(before).toBeGreaterThanOrEqual(view.viewport().getBoundingClientRect().top);
      expect(before).toBeLessThan(view.viewport().getBoundingClientRect().bottom);
      await fixture.finish(0, [{ ...user(38), runId: "run" }, steering(39)], null);
      expect(fixture.owner.readOwner.readStructure()?.turnEntityKeys).toHaveLength(1);
      expect(anchor.isConnected).toBe(true);
      const after = anchor.getBoundingClientRect().top;
      expect(
        Math.abs(after - before),
        JSON.stringify({
          before,
          after,
          beforeScrollTop,
          afterScrollTop: view.viewport().scrollTop,
        }),
      ).toBeLessThanOrEqual(2);
      const beforeStreamDistance = getThreadScrollDistanceFromBottomPx(view.viewport());
      const turn = anchor.closest<HTMLElement>("[data-turn-key]")!;
      const beforeStreamHeight = turn.getBoundingClientRect().height;
      await fixture.stream(
        Array.from({ length: 12 }, (_, index) => `Same-Turn reply paragraph ${index}`).join("\n\n"),
        "run",
      );
      expect(turn.getBoundingClientRect().height).toBeGreaterThan(beforeStreamHeight);
      // The reply grows below the reader, extending the conversation away from them.
      expect(getThreadScrollDistanceFromBottomPx(view.viewport())).toBeGreaterThan(
        beforeStreamDistance,
      );
      expect(anchor.isConnected).toBe(true);
      expect(Math.abs(anchor.getBoundingClientRect().top - before)).toBeLessThanOrEqual(2);
    } finally {
      view.dispose();
    }
  });

  test("prefetches near the top, serially fills the nearby gap, and preserves reading position through stream and prepend", async () => {
    const fixture = historyFixture([
      ...Array.from({ length: 12 }, (_, index) => user(index + 40)),
      assistant("Current reply"),
    ]);
    const view = mountHistory(fixture);
    try {
      await view.settle();
      expect(fixture.requests).toHaveLength(0);
      const reply = view.getByText("Current reply").closest<HTMLElement>("[data-turn-key]")!;
      const replyHeight = reply.getBoundingClientRect().height;
      await fixture.stream(
        "Current reply\n\nThe live response continues.\n\nA third paragraph arrives.",
      );
      expect(reply.getBoundingClientRect().height).toBeGreaterThan(replyHeight);
      expect(getThreadScrollDistanceFromBottomPx(view.viewport())).toBe(0);
      expect(fixture.requests).toHaveLength(0);
      await view.towardTop();
      await waitFor(() => expect(fixture.requests).toHaveLength(1));
      const anchor = Array.from(
        view.container.querySelectorAll<HTMLElement>("[data-content-search-unit-key]"),
      ).find(
        (element) =>
          element.dataset.contentSearchUnitKey ===
          `${JSON.stringify(["agent-run", target.threadId, "run:40"])}:user:0`,
      );
      if (!anchor) throw new Error("Missing resident reading anchor");
      const before = anchor.getBoundingClientRect().top;
      expect(before).toBeGreaterThanOrEqual(view.viewport().getBoundingClientRect().top);
      expect(before).toBeLessThan(view.viewport().getBoundingClientRect().bottom);
      expect(getThreadScrollDistanceFromBottomPx(view.viewport())).toBeGreaterThan(0);
      await fixture.stream(
        Array.from({ length: 12 }, (_, index) => `Growing reply ${index}`).join("\n\n"),
      );
      expect(Math.abs(anchor.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
      expect(fixture.requests).toHaveLength(1);
      await fixture.finish(0, [user(38), user(39)], "page:1");
      await waitFor(() => expect(fixture.requests).toHaveLength(2));
      expect(anchor.isConnected).toBe(true);
      expect(Math.abs(anchor.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
      await fixture.finish(
        1,
        Array.from({ length: 6 }, (_, index) => user(index + 32)),
        "page:2",
      );
      await act(async () => {
        await frames();
      });
      expect(fixture.requests).toHaveLength(2);
      expect(fixture.maxActive).toBe(1);

      expect(anchor.isConnected).toBe(true);
      // The measured layout rounds each row to physical pixels.
      expect(Math.abs(anchor.getBoundingClientRect().top - before)).toBeLessThanOrEqual(2);
      const distanceFromTop = view.viewport().scrollTop;
      expect(distanceFromTop - 144).toBeGreaterThan(800);
      await view.towardTop();
      await waitFor(() => expect(fixture.requests).toHaveLength(3));
      await fixture.finish(2, [user(31)], null);
      await waitFor(() =>
        expect(view.container.querySelector("[data-history-gap-key]")).toBeNull(),
      );
      await view.towardTop(0);
      expect(fixture.requests).toHaveLength(3);
    } finally {
      view.dispose();
    }
  });

  test("refills short, empty and hidden pages without another scroll, and retries a failed page only from its gap", async () => {
    const fixture = historyFixture([user(10, 1)]);
    const view = mountHistory(fixture);
    try {
      await view.settle();
      await waitFor(() => expect(fixture.requests).toHaveLength(1));
      await fixture.finish(0, [], "page:1");
      await waitFor(() => expect(fixture.requests).toHaveLength(2));
      const hidden: AgentTurnItem = {
        ...base("stop:8", 8),
        type: "run_interrupt_request",
        message: "Stopping",
      };
      await fixture.finish(1, [hidden], "page:2");
      await waitFor(() => expect(fixture.requests).toHaveLength(3));
      await fixture.finish(2, [user(7, 1)], "page:3");
      await waitFor(() => expect(fixture.requests).toHaveLength(4));
      await act(async () => {
        fixture.requests[3]!.reject(new Error("History unavailable"));
        await frames();
      });
      const retry = await view.findByRole("button", { name: "Try again" });
      expect(fixture.owner.getSnapshot().error).toBeNull();
      await view.towardTop(0);
      expect(fixture.requests).toHaveLength(4);
      await act(async () => {
        fireEvent.click(retry);
        await Promise.resolve();
      });
      await waitFor(() => expect(fixture.requests).toHaveLength(5));
      expect(fixture.requests.map((request) => request.cursor)).toEqual([
        "page:0",
        "page:1",
        "page:2",
        "page:3",
        "page:3",
      ]);
      await fixture.finish(4, [user(6, 1)], null);
      await waitFor(() => expect(view.queryByRole("button", { name: "Try again" })).toBeNull());
      expect(view.container.querySelector("[data-history-gap-key]")).toBeNull();
      expect(fixture.maxActive).toBe(1);
      expect(fixture.requests).toHaveLength(5);
    } finally {
      view.dispose();
    }
  });

  test.each(["loading", "failed"] as const)(
    "replaces a %s history reader without carrying its gap state or resetting the viewport",
    async (state) => {
      const items = Array.from({ length: 12 }, (_, index) => user(index + 40));
      const first = historyFixture(items);
      const next = historyFixture(items);
      const view = mountHistory(first);
      try {
        await view.settle();
        await view.towardTop();
        await waitFor(() => expect(first.requests).toHaveLength(1));
        if (state === "failed") {
          await act(async () => {
            first.requests[0]!.reject(new Error("Old reader failed"));
            await frames();
          });
          await view.findByRole("button", { name: "Try again" });
        }
        const viewport = view.viewport();
        const before = viewport.scrollTop;
        await view.replace(next);
        await waitFor(() => expect(next.requests).toHaveLength(1));
        expect(view.viewport()).toBe(viewport);
        expect(Math.abs(viewport.scrollTop - before)).toBeLessThanOrEqual(1);
        expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
        if (state === "loading") await first.finish(0, [user(39)], null);
        expect(next.requests).toHaveLength(1);
        await next.finish(0, [user(39)], null);
        await waitFor(() =>
          expect(view.container.querySelector("[data-history-gap-key]")).toBeNull(),
        );
        expect(first.requests).toHaveLength(1);
      } finally {
        view.dispose();
        next.owner.dispose();
      }
    },
  );
});
