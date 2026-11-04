import { TestQueryProvider } from "@/test/query";
import { act, type ReactElement } from "react";
import { fireEvent, render as renderDom, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  AgentSubagentOverview,
  AgentSubagentOverviewItem,
} from "@nodex/agent-runtime/contracts";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionEvent,
} from "../../../shared/agent-runtime-api";
import type { WorkbenchSessionRenderProjection } from "@/lib/workbench-session-presentation";
import { makeTestWorkbenchSession } from "./workbench-testkit/panel-fixtures";
import { composerDraftIntents } from "@/lib/composer-draft-intents";
import { toast } from "@/components/ui/toast";
import {
  AgentRuntimeChildPanel,
  AgentRuntimeSideChatPanel,
  AgentRuntimeSubagentsOverviewPanel,
} from "./workbench-agent-runtime-panels";

const render = (ui: ReactElement) => renderDom(ui, { wrapper: TestQueryProvider });

const childAdapter = vi.hoisted(() => vi.fn());
vi.mock("@/features/local-conversation/agent-runtime-conversation-adapter", () => ({
  useAgentRuntimeConversationAdapter: childAdapter,
}));
const runtimeConnection = vi.hoisted(() => ({
  current: { status: "ready", generation: "generation" } as AgentRuntimeConnectionState,
}));
vi.mock("@/lib/agent-runtime-session-activity", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-runtime-session-activity")>()),
  useAgentRuntimeConnectionState: () => runtimeConnection.current,
}));
vi.mock("@/features/local-conversation/use-agent-instances", () => ({
  useAgentInstances: () => ({ instances: [] }),
}));
vi.mock("@/features/local-conversation", () => ({ ConnectedThreadStage: () => null }));

function sideChatProps(id: string) {
  return {
    session: makeTestWorkbenchSession({ id, projectId: null }),
    parentThreadId: "parent",
    title: "Side chat",
    project: null,
    initialPrompt: { prompt: "Review the patch" },
    initialSubmission: { launchId: "launch", clientUserMessageId: "message", acceptedAt: 1 },
    onInitialSubmissionSettled: vi.fn(),
    onRefresh: async () => {},
    onOpenThread: () => {},
    composerEnterBehavior: "enter" as const,
    hostActions: {},
    turnDiffHoverPreviewDisabled: false,
  };
}

it.each(["accepted", "rejected"] as const)(
  "sends the opening message without drafting it and settles once (%s)",
  async (outcome) => {
    let accept!: () => void;
    let reject!: (error: Error) => void;
    const send = vi.fn(
      () =>
        new Promise<void>((resolve, rejectPromise) => {
          accept = resolve;
          reject = rejectPromise;
        }),
    );
    childAdapter.mockReturnValue({
      runtime: {},
      actions: { onSendPrompt: send },
      summary: { threadId: "side-thread" },
      provider: { modelCatalog: { loading: false } },
      models: [{ id: "model" }],
      selectedModel: "model",
    });
    const danger = vi.spyOn(toast, "danger");
    const props = sideChatProps(`side-chat:${outcome}`);
    const chat = { kind: "session", sessionId: props.session.id } as const;
    const followUp = { prompt: "Keep my follow-up", focusNonce: 2 };
    let view = render(<AgentRuntimeSideChatPanel {...props} />);
    try {
      await waitFor(() => expect(send).toHaveBeenCalledOnce());
      expect(composerDraftIntents.read(chat)).toBeNull();
      expect(props.onInitialSubmissionSettled).not.toHaveBeenCalled();
      composerDraftIntents.set(chat, followUp);
      await act(async () => {
        if (outcome === "accepted") accept();
        else reject(new Error("Submission unavailable"));
        await Promise.resolve();
      });
      await waitFor(() => expect(props.onInitialSubmissionSettled).toHaveBeenCalledOnce());
      if (outcome === "accepted") {
        expect(composerDraftIntents.read(chat)).toBe(followUp);
        expect(danger).not.toHaveBeenCalled();
      } else {
        expect(composerDraftIntents.read(chat)).toMatchObject({
          prompt: props.initialPrompt.prompt,
          attachmentMode: "replace",
        });
        expect(danger).toHaveBeenCalledWith("Submission unavailable", {
          id: `side-chat-submit:${props.session.id}`,
        });
      }
      const settledProps = { ...props, initialSubmission: undefined, initialPrompt: null };
      view.rerender(<AgentRuntimeSideChatPanel {...settledProps} />);
      composerDraftIntents.set(chat, followUp);
      view.unmount();
      view = render(<AgentRuntimeSideChatPanel {...settledProps} />);
      expect(send).toHaveBeenCalledExactlyOnceWith(props.initialPrompt.prompt, {
        promptInput: undefined,
        submissionIdentity: props.initialSubmission,
        presentationTicket: undefined,
      });
      expect(props.onInitialSubmissionSettled).toHaveBeenCalledOnce();
      expect(composerDraftIntents.read(chat)).toBe(followUp);
    } finally {
      view.unmount();
      const pending = composerDraftIntents.read(chat);
      if (pending) composerDraftIntents.consume(chat, pending.focusNonce);
    }
  },
);

it("waits for the model catalog, then returns an unsendable opening message only once", async () => {
  const send = vi.fn();
  const adapter = {
    runtime: {},
    actions: { onSendPrompt: send },
    summary: { threadId: "side-thread" },
    provider: { modelCatalog: { loading: true } },
    models: [],
    selectedModel: null,
  };
  childAdapter.mockReturnValue(adapter);
  const danger = vi.spyOn(toast, "danger");
  const props = sideChatProps("side-chat:no-model");
  const chat = { kind: "session", sessionId: props.session.id } as const;
  let view = render(<AgentRuntimeSideChatPanel {...props} />);
  try {
    expect(send).not.toHaveBeenCalled();
    expect(danger).not.toHaveBeenCalled();
    expect(composerDraftIntents.read(chat)).toBeNull();
    expect(props.onInitialSubmissionSettled).not.toHaveBeenCalled();
    childAdapter.mockReturnValue({
      ...adapter,
      provider: { modelCatalog: { loading: false } },
    });
    view.rerender(<AgentRuntimeSideChatPanel {...props} />);
    await waitFor(() => expect(props.onInitialSubmissionSettled).toHaveBeenCalledOnce());
    expect(composerDraftIntents.read(chat)).toMatchObject({
      prompt: props.initialPrompt.prompt,
      attachmentMode: "replace",
    });
    expect(danger).toHaveBeenCalledOnce();
    const followUp = { prompt: "My edited opening message", focusNonce: 3 };
    composerDraftIntents.set(chat, followUp);
    view.unmount();
    view = render(
      <AgentRuntimeSideChatPanel {...props} initialSubmission={undefined} initialPrompt={null} />,
    );
    expect(send).not.toHaveBeenCalled();
    expect(props.onInitialSubmissionSettled).toHaveBeenCalledOnce();
    expect(composerDraftIntents.read(chat)).toBe(followUp);
  } finally {
    view.unmount();
    const pending = composerDraftIntents.read(chat);
    if (pending) composerDraftIntents.consume(chat, pending.focusNonce);
  }
});

it("keeps a child header unknown until its own settings load, independently of Fast defaults", () => {
  const adapter = {
    runtime: {},
    actions: {},
    provider: { serviceTier: "fast" },
    selectedModel: "global-default-model",
    selectedEffort: "high",
    state: { conversation: null },
  };
  childAdapter.mockReturnValue(adapter);
  const props = {
    session: { id: "session", projectId: null } as WorkbenchSessionRenderProjection,
    threadId: "child",
    title: "Explorer",
    project: null,
    canInteract: false,
    onBackToSubagents: vi.fn(),
    composerEnterBehavior: "enter" as const,
    queueingEnabled: false,
    onRefresh: async () => {},
    onOpenThread: () => {},
    hostActions: {},
    turnDiffHoverPreviewDisabled: false,
  };
  const view = render(<AgentRuntimeChildPanel {...props} />);
  expect(screen.queryByRole("img", { name: "Fast mode" })).toBeNull();
  expect(screen.queryByText("global-default-model")).toBeNull();

  const loaded = (options: { id: string; value: string }[]) => {
    childAdapter.mockReturnValue({
      ...adapter,
      state: {
        conversation: {
          snapshot: {
            projection: { thread: { modelSelection: { model: "child-model", options } } },
          },
        },
      },
    });
    view.rerender(<AgentRuntimeChildPanel {...props} />);
  };
  loaded([]);
  expect(screen.queryByRole("img", { name: "Fast mode" })).toBeNull();
  loaded([{ id: "serviceTier", value: "fast" }]);
  expect(screen.getByRole("img", { name: "Fast mode" })).toBeTruthy();
  loaded([{ id: "serviceTier", value: "default" }]);
  expect(screen.queryByRole("img", { name: "Fast mode" })).toBeNull();
});

const task = (id: string): AgentSubagentOverviewItem => ({
  id,
  threadId: "root",
  runId: "parent-run",
  parentNodeId: "node",
  origin: "app_owned",
  driver: "codex",
  providerInstanceId: "codex",
  providerThreadId: null,
  childThreadId: `child:${id}`,
  childRunId: `run:${id}`,
  title: `Review ${id}`,
  model: "model",
  status: "running",
  startedAt: null,
  completedAt: null,
  updatedAt: "2026-10-13T20:00:00Z",
  resultAvailable: false,
});
beforeEach(() => {
  runtimeConnection.current = { status: "ready", generation: "generation" };
  vi.spyOn(agentRuntimeRuntime, "connection").mockResolvedValue({
    status: "ready",
    generation: "generation",
  });
  vi.spyOn(agentRuntimeRuntime, "activity").mockResolvedValue({
    sequence: 0,
    items: [],
    complete: true,
  });
});
afterEach(() => vi.restoreAllMocks());

const overviewOf = (
  active: readonly AgentSubagentOverviewItem[],
  terminal: readonly AgentSubagentOverviewItem[] = [],
): AgentSubagentOverview => ({
  active: { items: active, nextCursor: null, hasMore: false, totalCount: active.length },
  terminal: { items: terminal, nextCursor: null, hasMore: false, totalCount: terminal.length },
});

function observe() {
  const listeners: ((event: AgentRuntimeSessionEvent) => void)[] = [];
  const releases: ReturnType<typeof vi.fn>[] = [];
  const subscribe = vi
    .spyOn(agentRuntimeRuntime, "subscribe")
    .mockImplementation(async (_input, listener) => {
      listeners.push(listener);
      const release = vi.fn();
      releases.push(release);
      return release;
    });
  const emit = (event: AgentRuntimeSessionEvent) => listeners.at(-1)!(event);
  const update = (item: AgentSubagentOverviewItem, sequence: number) =>
    emit({
      type: "event",
      sessionId: "session",
      threadId: "root",
      event: {
        sequence,
        commandId: null,
        event: {
          id: `event:${sequence}`,
          threadId: "root",
          occurredAt: item.updatedAt,
          type: "subagent.updated",
          payload: {
            ...item,
            createdBy: "agent",
            nativeTaskRef: null,
            prompt: "",
            result: null,
          },
        },
      } as never,
    });
  return { subscribe, releases, emit, update };
}

it("opens only bounded metadata, loads one explicit continuation and releases its observer", async () => {
  const initial: AgentSubagentOverview = {
    active: { items: [task("one")], nextCursor: "after-one", hasMore: true, totalCount: 2 },
    terminal: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
  };
  const next: AgentSubagentOverview = {
    ...initial,
    active: { items: [task("two")], nextCursor: null, hasMore: false, totalCount: 2 },
  };
  const overview = vi
    .spyOn(agentRuntimeRuntime, "overview")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(next);
  const release = vi.fn();
  const subscribe = vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(release);
  const read = vi.spyOn(agentRuntimeRuntime, "read");
  const select = vi.fn();
  const view = render(
    <AgentRuntimeSubagentsOverviewPanel sessionId="session" threadId="root" onSelect={select} />,
  );
  await screen.findByRole("button", { name: "Open subagent Review one" });
  expect(subscribe.mock.calls[0]?.[0]).toEqual({
    sessionId: "session",
    threadId: "root",
    eventTypes: ["subagent.updated"],
  });
  expect(overview).toHaveBeenCalledExactlyOnceWith({ sessionId: "session", threadId: "root" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  });
  await screen.findByRole("button", { name: "Open subagent Review two" });
  expect(overview.mock.calls[1]?.[0]).toEqual({
    sessionId: "session",
    threadId: "root",
    activeCursor: "after-one",
  });
  expect(read).not.toHaveBeenCalled();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Open subagent Review two" }));
  });
  await waitFor(() =>
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: "child:two", canInteract: true }),
    ),
  );
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});

it("releases a failed continuation so the same subagent window can be retried", async () => {
  const overview = vi
    .spyOn(agentRuntimeRuntime, "overview")
    .mockResolvedValueOnce({
      active: { items: [task("one")], nextCursor: "after-one", hasMore: true, totalCount: 2 },
      terminal: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
    })
    .mockRejectedValueOnce(new Error("Continuation unavailable"))
    .mockResolvedValueOnce(overviewOf([task("two")]));
  observe();
  const view = render(
    <AgentRuntimeSubagentsOverviewPanel sessionId="session" threadId="root" onSelect={vi.fn()} />,
  );
  await screen.findByRole("button", { name: "Open subagent Review one" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await Promise.resolve();
  });
  expect((await screen.findByRole("alert")).textContent).toContain("Continuation unavailable");
  expect(screen.getByRole("button", { name: "Open subagent Review one" })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await Promise.resolve();
  });
  await screen.findByRole("button", { name: "Open subagent Review two" });
  expect(overview.mock.calls.slice(1).map(([input]) => input)).toEqual([
    { sessionId: "session", threadId: "root", activeCursor: "after-one" },
    { sessionId: "session", threadId: "root", activeCursor: "after-one" },
  ]);
  expect(screen.queryByRole("alert")).toBeNull();
  view.unmount();
});

it("stops a native task through its owning Session and Run without inventing a child conversation", async () => {
  const native = { ...task("native"), origin: "provider_native" as const, childThreadId: null };
  vi.spyOn(agentRuntimeRuntime, "overview").mockResolvedValue({
    active: { items: [native], nextCursor: null, hasMore: false, totalCount: 1 },
    terminal: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
  });
  const release = vi.fn();
  vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(release);
  const stop = vi.spyOn(agentRuntimeRuntime, "stopTask").mockResolvedValue({ sequence: 9 });
  const read = vi.spyOn(agentRuntimeRuntime, "read");
  const select = vi.fn();
  const view = render(
    <AgentRuntimeSubagentsOverviewPanel sessionId="session" threadId="root" onSelect={select} />,
  );
  const action = await screen.findByRole("button", { name: "Stop Review native" });
  expect(screen.queryByRole("button", { name: "Open subagent Review native" })).toBeNull();
  await act(async () => {
    fireEvent.click(action);
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session",
        threadId: "root",
        runId: "parent-run",
        taskId: "native",
      }),
    ),
  );
  expect(select).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  view.unmount();
  expect(release).toHaveBeenCalledOnce();
});

it("cancels an application-owned subagent through its parent and settles from events", async () => {
  vi.spyOn(agentRuntimeRuntime, "overview").mockResolvedValue(overviewOf([task("one")]));
  const { update } = observe();
  const cancelTask = vi
    .spyOn(agentRuntimeRuntime, "cancelTask")
    .mockResolvedValue({ taskId: "one", status: "cancelled" });
  const view = render(
    <AgentRuntimeSubagentsOverviewPanel sessionId="session" threadId="root" onSelect={vi.fn()} />,
  );
  await screen.findByRole("button", { name: "Open subagent Review one" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Stop Review one" }));
    await Promise.resolve();
  });
  expect(await screen.findByText("Stopping…")).toBeTruthy();
  await waitFor(() =>
    expect(cancelTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session", threadId: "root", taskId: "one" }),
    ),
  );
  await act(async () => {
    update({ ...task("one"), status: "interrupted", updatedAt: "2026-10-13T20:05:00Z" }, 2);
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.queryByText("Stopping…")).toBeNull());
  expect(screen.queryByRole("button", { name: "Stop Review one" })).toBeNull();
  expect(screen.getByText("Done · 1")).toBeTruthy();
  view.unmount();
});

it("keeps loaded pages across task events and attaches again after a delivery gap", async () => {
  const overview = vi
    .spyOn(agentRuntimeRuntime, "overview")
    .mockResolvedValueOnce({
      active: { items: [task("one")], nextCursor: "after-one", hasMore: true, totalCount: 2 },
      terminal: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
    })
    .mockResolvedValueOnce(overviewOf([task("two")]))
    .mockRejectedValueOnce(new Error("Agent execution is restarting"))
    .mockResolvedValueOnce(overviewOf([task("three")]));
  const { subscribe, releases, emit, update } = observe();
  const view = render(
    <AgentRuntimeSubagentsOverviewPanel sessionId="session" threadId="root" onSelect={vi.fn()} />,
  );
  await screen.findByRole("button", { name: "Open subagent Review one" });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
  });
  await screen.findByRole("button", { name: "Open subagent Review two" });
  await act(async () => {
    update({ ...task("one"), title: "Review one again", updatedAt: "2026-10-13T20:01:00Z" }, 2);
    await Promise.resolve();
  });
  // An event patches the loaded window; the explicitly loaded page stays.
  await screen.findByRole("button", { name: "Open subagent Review one again" });
  expect(screen.getByRole("button", { name: "Open subagent Review two" })).toBeTruthy();
  expect(overview).toHaveBeenCalledTimes(2);

  await act(async () => {
    emit({
      type: "reset-required",
      sessionId: "session",
      threadId: "root",
      reason: "runtime-restarted",
    });
    await Promise.resolve();
  });
  await screen.findByRole("alert");
  expect(releases[0]).toHaveBeenCalledOnce();
  expect(subscribe).toHaveBeenCalledTimes(2);
  // The failed re-read keeps the last window visible beside its Retry.
  expect(screen.getByRole("button", { name: "Open subagent Review one again" })).toBeTruthy();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await Promise.resolve();
  });
  await screen.findByRole("button", { name: "Open subagent Review three" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(subscribe).toHaveBeenCalledTimes(3);
  view.unmount();
});

it("attaches again on its own once the same process answers after a failed attachment", async () => {
  vi.spyOn(agentRuntimeRuntime, "overview")
    .mockRejectedValueOnce(new Error("Nodex Core is busy"))
    .mockResolvedValueOnce(overviewOf([task("one")]));
  const { subscribe, releases } = observe();
  runtimeConnection.current = { status: "unresponsive", generation: "generation" };
  const panel = (
    <AgentRuntimeSubagentsOverviewPanel sessionId="session" threadId="root" onSelect={vi.fn()} />
  );
  const view = render(panel);
  await screen.findByRole("alert");

  runtimeConnection.current = { status: "ready", generation: "generation" };
  view.rerender(panel);

  await screen.findByRole("button", { name: "Open subagent Review one" });
  expect(screen.queryByRole("alert")).toBeNull();
  expect(subscribe).toHaveBeenCalledTimes(2);
  expect(releases[0]).toHaveBeenCalledOnce();
  view.unmount();
});

it("counts every Done task and re-reads the totals a report from an unloaded page leaves unknown", async () => {
  const done = (id: string) => ({ ...task(id), status: "completed" as const });
  const initial: AgentSubagentOverview = {
    active: { items: [], nextCursor: null, hasMore: false, totalCount: 0 },
    terminal: { items: [done("a")], nextCursor: "after-a", hasMore: true, totalCount: 12 },
  };
  const overview = vi
    .spyOn(agentRuntimeRuntime, "overview")
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce({
      active: { ...initial.active, totalCount: 1 },
      terminal: { ...initial.terminal, totalCount: 11 },
    });
  const { update } = observe();
  const view = render(
    <AgentRuntimeSubagentsOverviewPanel sessionId="session" threadId="root" onSelect={vi.fn()} />,
  );
  expect(await screen.findByText("Done · 12")).toBeTruthy();

  // A Done task from a page not loaded yet starts working again.
  await act(async () => {
    update({ ...task("old"), updatedAt: "2026-10-13T21:00:00Z" }, 2);
    await Promise.resolve();
  });
  expect(await screen.findByText("Done · 11")).toBeTruthy();
  expect(screen.getByText("Active · 1")).toBeTruthy();
  expect(overview).toHaveBeenCalledTimes(2);
  view.unmount();
});

it("names a child's pending approval using control metadata without reading its transcript", async () => {
  const { agentRuntimeSnapshotFixture, agentRuntimeRow } =
    await import("../../../shared/testing/agent-runtime-snapshot");
  vi.spyOn(agentRuntimeRuntime, "overview").mockResolvedValue(
    overviewOf([{ ...task("approval"), status: "waiting" }]),
  );
  vi.spyOn(agentRuntimeRuntime, "subscribe").mockResolvedValue(() => {});
  const read = vi.spyOn(agentRuntimeRuntime, "read");
  const control = vi.spyOn(agentRuntimeRuntime, "control").mockResolvedValue({
    sessionId: "session",
    projectId: null,
    threadId: "child:approval",
    snapshot: agentRuntimeSnapshotFixture({
      projection: {
        runtimeRequests: [
          agentRuntimeRow("runtimeRequests", {
            id: "request",
            nodeId: "approval-node",
            kind: "permission",
            status: "pending",
          }),
        ],
      },
    }),
  });
  const view = render(
    <AgentRuntimeSubagentsOverviewPanel sessionId="session" threadId="root" onSelect={vi.fn()} />,
  );
  try {
    expect(await screen.findByText("Needs approval")).toBeTruthy();
    expect(control).toHaveBeenCalledWith({ sessionId: "session", threadId: "child:approval" });
    expect(read).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});
