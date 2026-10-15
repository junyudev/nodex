import { act } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type {
  AgentSubagentOverview,
  AgentSubagentOverviewItem,
} from "@nodex/agent-runtime/contracts";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
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
afterEach(() => vi.restoreAllMocks());

it("opens only bounded metadata, loads one explicit continuation and releases its observer", async () => {
  const initial: AgentSubagentOverview = {
    active: { items: [task("one")], nextCursor: "after-one", hasMore: true },
    terminal: { items: [], nextCursor: null, hasMore: false },
  };
  const next: AgentSubagentOverview = {
    ...initial,
    active: { items: [task("two")], nextCursor: null, hasMore: false },
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
    active: { items: [native], nextCursor: null, hasMore: false },
    terminal: { items: [], nextCursor: null, hasMore: false },
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
