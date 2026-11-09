import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { queryKeys } from "@/lib/query-keys";
import { LinkOpeningProvider } from "@/lib/web-link-navigation";
import { createTestQueryClient, TestQueryProvider } from "@/test/query";
import type {
  AgentRuntimeSessionActivity,
  AgentRuntimeSessionActivityChange,
} from "../../../shared/agent-runtime-api";
import { readbackId, type Readback } from "../../../shared/readback";
import type { Project, ProjectSession } from "../../../shared/types";
import { createReadbackStore, type ReadbackCloseReason } from "./readback-store";
import { ReadbackStack } from "./readback-stack";
import { readbackVisibleDuration } from "./readback-timing";

const runtime = vi.hoisted(() => ({
  message: vi.fn(async (_input: unknown) => ({})),
  stop: vi.fn(async (_input: unknown) => ({ stopped: true })),
}));
const focus = vi.hoisted(() => ({
  focused: true,
  listeners: new Set<(focused: boolean) => void>(),
}));
const activity = vi.hoisted(() => ({
  listeners: new Set<(change: unknown) => void>(),
  sequence: 0,
}));

vi.mock("@/lib/agent-runtime-runtime", () => ({ agentRuntimeRuntime: runtime }));
vi.mock("@/lib/product-analytics", () => ({ recordProductEvent: () => undefined }));
vi.mock("@/lib/readback-events", () => ({ subscribeReadbackEvents: () => () => undefined }));
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getWindowFocusState: async () => focus.focused,
  subscribeWindowFocusChanges: (listener: (focused: boolean) => void) => {
    focus.listeners.add(listener);
    return () => focus.listeners.delete(listener);
  },
}));
vi.mock("@/lib/agent-runtime-session-activity", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-runtime-session-activity")>();
  const store = actual.createAgentRuntimeActivityStore({
    read: async () => ({ sequence: 0, items: [], complete: true }),
    subscribe: (listener) => {
      activity.listeners.add(listener as (change: unknown) => void);
      return () => activity.listeners.delete(listener as (change: unknown) => void);
    },
    readConnection: async () => ({ status: "ready" }) as never,
    subscribeConnection: () => () => {},
  });
  return {
    ...actual,
    agentRuntimeActivityStore: store,
    useAgentRuntimeSessionActivity: (sessionId: string | null | undefined) =>
      actual.useAgentRuntimeSessionActivity(sessionId, store),
    useAgentRuntimeSessionStatus: (sessionId: string | null | undefined) =>
      actual.useAgentRuntimeSessionStatus(sessionId, store),
  };
});

const links = vi.hoisted(() => ({ opened: [] as unknown[] }));
const linkRouter = {
  browserAvailable: false,
  openLink: async (request: unknown) => {
    links.opened.push(request);
    return true;
  },
};

const SESSION_ID = "session-1";
const RUN_ID = "run-1";

function makeReadback(overrides: Partial<Readback> = {}): Readback {
  return {
    id: readbackId(SESSION_ID, RUN_ID),
    sessionId: SESSION_ID,
    threadId: "thread-1",
    runId: RUN_ID,
    itemId: "item-1",
    text: "Two things to do; I'll redo the review covering **the whole branch**. See [the plan](https://example.com/plan).",
    title: "Provisional title",
    createdAt: 0,
    navigation: {
      hostId: "local",
      conversationId: "thread-1",
      navigationPath: `session:${SESSION_ID}/thread:thread-1`,
      activateTabId: null,
    },
    ...overrides,
  };
}

function runningActivity(runId = RUN_ID): AgentRuntimeSessionActivity {
  return {
    sessionId: SESSION_ID,
    threadId: "thread-1",
    status: "running",
    activeRunId: runId,
    pendingRequestCount: 0,
    backgroundTasks: [],
    providerInstanceId: "claude",
    model: "claude-opus",
    updatedAt: "2026-11-09T00:00:00.000Z",
  };
}

async function pushActivity(next: AgentRuntimeSessionActivity | null) {
  activity.sequence += 1;
  const change: AgentRuntimeSessionActivityChange = next
    ? { type: "upsert", sequence: activity.sequence, activity: next }
    : { type: "remove", sequence: activity.sequence, sessionId: SESSION_ID };
  await act(async () => {
    for (const listener of activity.listeners) listener(change);
    await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
}

async function renderStack(readback = makeReadback()) {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.projectSessions.detail(SESSION_ID), {
    id: SESSION_ID,
    projectId: "project-1",
    displayTitle: "Merge Store migrations",
    unread: false,
    thread: null,
    executionRef: { runtimeId: "runtime", threadId: "thread-1" },
  } as unknown as ProjectSession);
  client.setQueryData(queryKeys.projects.detail("project-1"), {
    id: "project-1",
    name: "nodex",
  } as unknown as Project);
  const closed: ReadbackCloseReason[] = [];
  const opened: Readback[] = [];
  const store = createReadbackStore({ onClose: (_readback, reason) => closed.push(reason) });
  await act(async () => {
    render(
      <TestQueryProvider client={client}>
        <LinkOpeningProvider router={linkRouter}>
          <NodexTooltipProvider>
            <ReadbackStack store={store} onOpen={(target) => opened.push(target)} />
          </NodexTooltipProvider>
        </LinkOpeningProvider>
      </TestQueryProvider>,
    );
    store.apply({ type: "show", readback });
    await Promise.resolve();
  });
  const card = () => screen.queryByRole("article");
  return { store, closed, opened, card };
}

describe("Readback stack", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    focus.focused = true;
    runtime.message.mockClear();
    runtime.stop.mockClear();
  });
  afterEach(async () => {
    await pushActivity(null);
    vi.useRealTimers();
  });

  test("names the chat by its live title and Project and shows the agent's words", async () => {
    const { card } = await renderStack();
    expect(card()?.getAttribute("aria-label")).toBe("Merge Store migrations: readback");
    expect(screen.getByRole("button", { name: "Merge Store migrations" })).toBeTruthy();
    expect(screen.getByText("nodex")).toBeTruthy();
    expect(screen.getByText("the whole branch")).toBeTruthy();
  });

  test("leaves on its own once there has been time to read it", async () => {
    const { card, closed } = await renderStack();
    const duration = readbackVisibleDuration(makeReadback().text);
    await advance(duration - 100);
    expect(card()).not.toBeNull();
    await advance(200);
    expect(card()).toBeNull();
    expect(closed).toEqual(["expired"]);
  });

  test("waits while the stack is pointed at, then leaves a grace period", async () => {
    const { card, closed } = await renderStack();
    await advance(readbackVisibleDuration(makeReadback().text) - 500);
    await act(async () => {
      fireEvent.pointerEnter(card()!);
      await Promise.resolve();
    });
    await advance(60_000);
    expect(card()).not.toBeNull();
    await act(async () => {
      fireEvent.pointerLeave(card()!);
      await Promise.resolve();
    });
    await advance(1_900);
    expect(card()).not.toBeNull();
    await advance(200);
    expect(closed).toEqual(["expired"]);
  });

  test("waits while its window is in the background", async () => {
    const { card } = await renderStack();
    await act(async () => {
      for (const listener of focus.listeners) listener(false);
      await Promise.resolve();
    });
    await advance(60_000);
    expect(card()).not.toBeNull();
  });

  test("opens its chat from the text, but not from a link inside it", async () => {
    const { opened, closed } = await renderStack();
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "the plan" }));
      await Promise.resolve();
    });
    expect(opened).toEqual([]);
    expect(links.opened).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByText("the whole branch"));
      await Promise.resolve();
    });
    expect(opened.map((readback) => readback.runId)).toEqual([RUN_ID]);
    expect(closed).toEqual(["opened"]);
  });

  test("offers Stop only while its own Run is working, and stops exactly that Run", async () => {
    const { card } = await renderStack();
    await act(async () => {
      fireEvent.pointerEnter(card()!);
      await Promise.resolve();
    });
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    await pushActivity(runningActivity("run-later"));
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();

    await pushActivity(runningActivity());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
      await Promise.resolve();
    });
    expect(runtime.stop).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      threadId: "thread-1",
      runId: RUN_ID,
    });
    // Stopping asks what the person meant, but an untouched reply does not pin the card.
    const field = screen.getByRole("textbox", { name: "Reply" });
    await act(async () => {
      fireEvent.blur(field, { relatedTarget: document.body });
      fireEvent.pointerLeave(card()!);
      await Promise.resolve();
    });
    await advance(readbackVisibleDuration(makeReadback().text));
    expect(card()).toBeNull();
  });

  test("sends a reply to the chat that spoke, confirms it, then leaves", async () => {
    const { card, closed } = await renderStack();
    await act(async () => {
      fireEvent.pointerEnter(card()!);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      await Promise.resolve();
    });
    const field = screen.getByRole("textbox", { name: "Reply" });
    await act(async () => {
      fireEvent.change(field, { target: { value: "  Only this round, not the whole branch.  " } });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" });
      await Promise.resolve();
    });
    expect(runtime.message).toHaveBeenCalledWith({
      sessionId: SESSION_ID,
      message: { messageId: expect.any(String), text: "Only this round, not the whole branch." },
      intent: "auto",
    });
    expect(screen.getByText("Sent")).toBeTruthy();
    // Replying holds the card even after the pointer leaves.
    await act(async () => {
      fireEvent.pointerLeave(card()!);
      await Promise.resolve();
    });
    await advance(1_300);
    expect(card()).toBeNull();
    expect(closed).toEqual(["replied"]);
  });

  test("moving on from an empty reply lets the card leave, while a drafted one holds it", async () => {
    const { card, closed } = await renderStack();
    const openReply = async () => {
      await act(async () => {
        fireEvent.pointerEnter(card()!);
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Reply" }));
        await Promise.resolve();
      });
      return screen.getByRole("textbox", { name: "Reply" });
    };
    const leave = async (field: HTMLElement) => {
      await act(async () => {
        fireEvent.blur(field, { relatedTarget: document.body });
        fireEvent.pointerLeave(card()!);
        await Promise.resolve();
      });
    };

    let field = await openReply();
    await act(async () => {
      fireEvent.change(field, { target: { value: "Only this round" } });
      await Promise.resolve();
    });
    await leave(field);
    await advance(60_000);
    expect(card()).not.toBeNull();

    // The drafted reply is still open; emptying it and moving on abandons it.
    field = screen.getByRole("textbox", { name: "Reply" });
    await act(async () => {
      fireEvent.change(field, { target: { value: "" } });
      await Promise.resolve();
    });
    await leave(field);
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    await advance(readbackVisibleDuration(makeReadback().text));
    expect(card()).toBeNull();
    expect(closed).toEqual(["expired"]);
  });

  test("Escape leaves a reply first, then dismisses the card", async () => {
    const { card, closed } = await renderStack();
    await act(async () => {
      fireEvent.pointerEnter(card()!);
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reply" }));
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Reply" }), { key: "Escape" });
      await Promise.resolve();
    });
    expect(screen.queryByRole("textbox", { name: "Reply" })).toBeNull();
    expect(card()).not.toBeNull();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "Reply" }), { key: "Escape" });
      await Promise.resolve();
    });
    expect(card()).toBeNull();
    expect(closed).toEqual(["dismissed"]);
  });
});
