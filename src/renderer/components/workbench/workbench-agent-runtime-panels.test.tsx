import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type {
  AgentSubagentOverview,
  AgentSubagentOverviewItem,
} from "@nodex/agent-runtime/contracts";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import type { AgentRuntimeSessionEvent } from "../../../shared/agent-runtime-api";
import { AgentRuntimeSubagentsOverviewPanel } from "./workbench-agent-runtime-panels";

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

it("stops an application-owned subagent through its own conversation and settles from events", async () => {
  vi.spyOn(agentRuntimeRuntime, "overview").mockResolvedValue(overviewOf([task("one")]));
  const { update } = observe();
  const inspect = vi.spyOn(agentRuntimeRuntime, "inspect").mockResolvedValue({
    sessionId: "session",
    projectId: null,
    runtimeId: "runtime",
    rootThreadId: "root",
    threadId: "child:one",
    thread: { activeRunId: "child-active-run" } as never,
  });
  const stop = vi.spyOn(agentRuntimeRuntime, "stop").mockResolvedValue({ stopped: true });
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
    expect(stop).toHaveBeenCalledWith({
      sessionId: "session",
      threadId: "child:one",
      runId: "child-active-run",
    }),
  );
  expect(inspect).toHaveBeenCalledWith({ sessionId: "session", threadId: "child:one" });
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
