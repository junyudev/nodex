import { describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import type { CodexDelegatedTaskView } from "../../../../../shared/types";
import {
  createAgentRuntimeAgentLabelPort,
  createAgentRuntimeDelegatedTaskPort,
  createAgentRuntimeDelegatedTaskStore,
  type AgentRuntimeTaskStopTransport,
} from "../../agent-runtime-delegated-tasks";
import { ConversationRuntimeContext, type ConversationRuntime } from "../../conversation-runtime";
import { DelegatedTaskGroup, RuntimeNoticeRow } from "./delegated-task-row";

const task: CodexDelegatedTaskView = {
  taskId: "task",
  ownerRunId: "parent-run",
  childThreadId: "child",
  title: "Audit auth",
  providerInstanceId: "claude",
  status: "running",
  prompt: "Audit the auth module",
  summary: null,
};

function setup() {
  const store = createAgentRuntimeDelegatedTaskStore();
  store.publishLabels(
    new Map([
      [
        "claude",
        { label: "Claude", kind: "claude", models: new Map([["opus", "Claude Opus 5.5"]]) },
      ],
      ["codex", { label: "Codex", kind: "codex", models: new Map([["gpt", "GPT-5.5"]]) }],
    ]),
  );
  let finishStop: () => void = () => {};
  const transport: AgentRuntimeTaskStopTransport = {
    inspect: vi.fn(async () => ({
      sessionId: "session",
      projectId: null,
      threadId: "child",
      runtimeId: "runtime",
      rootThreadId: "root",
      thread: { activeRunId: "child-run" } as never,
    })),
    stop: vi.fn(
      () =>
        new Promise<{ stopped: boolean }>((resolve) => {
          finishStop = () => resolve({ stopped: true });
        }),
    ),
    stopTask: vi.fn(async () => ({ sequence: 1 })),
  };
  const runtime = {
    agentLabels: createAgentRuntimeAgentLabelPort(store),
    delegatedTasks: createAgentRuntimeDelegatedTaskPort("session", transport, store),
  } as unknown as ConversationRuntime;
  const wrap = (ui: ReactNode) => (
    <NodexTooltipProvider>
      <ConversationRuntimeContext value={runtime}>{ui}</ConversationRuntimeContext>
    </NodexTooltipProvider>
  );
  return { store, transport, wrap, finishStop: () => finishStop() };
}

describe("Delegated task row", () => {
  test("assigns identity only to a child Thread and keeps it through task state and title changes", () => {
    const { wrap } = setup();
    const row = (current: CodexDelegatedTaskView) =>
      wrap(<DelegatedTaskGroup tasks={[current]} parentThreadId="root" />);
    const view = render(row({ ...task, childThreadId: null }));
    expect(view.container.querySelector("[data-subagent-avatar-seed]")).toBeNull();

    view.rerender(row(task));
    const avatar = view.container.querySelector<HTMLImageElement>(
      '[data-subagent-avatar-seed="child"]',
    );
    expect(avatar).not.toBeNull();
    const source = avatar?.getAttribute("src");
    view.rerender(row({ ...task, title: "Review complete", status: "completed" }));
    expect(view.container.querySelector("[data-subagent-avatar-seed]")?.getAttribute("src")).toBe(
      source,
    );
    expect(screen.getByRole("status", { name: "Subagents finished" })).toBeTruthy();
  });

  test("reveals metadata on focus and keeps Stopping until the task settles", async () => {
    const { transport, wrap, finishStop } = setup();
    const onOpenThread = vi.fn();
    const membership = { threadId: "child", thread: { model: "opus" } } as never;
    const row = (current: CodexDelegatedTaskView) =>
      wrap(
        <DelegatedTaskGroup
          tasks={[current]}
          parentThreadId="root"
          childMemberships={[membership]}
          onOpenThread={onOpenThread}
        />,
      );
    const view = render(row(task));
    expect(screen.getByRole("status", { name: "Subagents is working" })).toBeTruthy();
    expect(screen.queryByText("Claude Opus 5.5")).toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: "Audit auth" }).focus();
      await Promise.resolve();
    });
    const details = await screen.findByRole("dialog", { name: "Audit auth details" });
    expect(within(details).getByText("Claude Opus 5.5")).toBeTruthy();
    expect(within(details).getByText("Audit the auth module")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(details).getByRole("button", { name: "Stop Audit auth" }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("status", { name: "Subagents is stopping…" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stop Audit auth" })).toBeNull();
    expect(transport.stop).toHaveBeenCalledWith({
      sessionId: "session",
      threadId: "child",
      runId: "child-run",
    });
    await act(async () => {
      finishStop();
      await Promise.resolve();
    });
    expect(screen.getByRole("status", { name: "Subagents is stopping…" })).toBeTruthy();
    view.rerender(row({ ...task, status: "stopped" }));
    expect(await screen.findByRole("status", { name: "Subagents stopped" })).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "Audit auth" }), { key: "Escape" });
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Audit auth" }));
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledWith(
      "child",
      expect.objectContaining({
        subagent: expect.objectContaining({ conversationId: "child", status: "done" }),
      }),
    );
  });

  test("an observation keeps its instructions reachable and stops through the owning parent Run", async () => {
    const { transport, wrap } = setup();
    render(
      wrap(
        <DelegatedTaskGroup
          tasks={[{ ...task, childThreadId: null, summary: "Checking access boundaries" }]}
          parentThreadId="root"
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: "Audit auth" })).toBeNull();
    await act(async () => {
      screen.getByText("Audit auth").focus();
      await Promise.resolve();
    });
    const details = await screen.findByRole("dialog", { name: "Audit auth details" });
    expect(within(details).getByText("Audit the auth module")).toBeTruthy();
    expect(within(details).getByText("Checking access boundaries")).toBeTruthy();
    await act(async () => {
      fireEvent.click(within(details).getByRole("button", { name: "Stop Audit auth" }));
      await Promise.resolve();
    });
    expect(transport.stopTask).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session",
        threadId: "root",
        runId: "parent-run",
        taskId: "task",
      }),
    );
  });

  test("restores Stop and the current task state when the request fails", async () => {
    const { transport, wrap } = setup();
    const reportError = vi.spyOn(toast, "danger").mockImplementation(() => ({ close: () => {} }));
    vi.mocked(transport.stop).mockRejectedValueOnce(new Error("Agent disconnected"));
    render(
      wrap(<DelegatedTaskGroup tasks={[task]} parentThreadId="root" onOpenThread={vi.fn()} />),
    );
    await act(async () => {
      screen.getByRole("button", { name: "Audit auth" }).focus();
      await Promise.resolve();
    });
    const stop = await screen.findByRole("button", { name: "Stop Audit auth" });
    await act(async () => {
      fireEvent.click(stop);
      await Promise.resolve();
    });
    expect(await screen.findByRole("status", { name: "Subagents is working" })).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Stop Audit auth" })).toBeTruthy();
    expect(reportError).toHaveBeenCalledWith("Agent disconnected");
    reportError.mockRestore();
  });

  test("exposes mixed outcomes and opens all overflow tasks without changing a named target", async () => {
    const { wrap } = setup();
    const onOpenThread = vi.fn();
    const onOpenSubagentsPanel = vi.fn();
    const tasks = [
      task,
      {
        ...task,
        taskId: "second",
        childThreadId: "second-child",
        title: "Review UI",
        status: "failed" as const,
      },
      ...Array.from({ length: 3 }, (_, i) => ({
        ...task,
        taskId: `extra-${i}`,
        childThreadId: `extra-child-${i}`,
        title: `Extra ${i}`,
        status: "completed" as const,
      })),
    ];
    render(
      wrap(
        <DelegatedTaskGroup
          tasks={tasks}
          parentThreadId="root"
          onOpenThread={onOpenThread}
          onOpenSubagentsPanel={onOpenSubagentsPanel}
        />,
      ),
    );
    expect(
      screen.getByRole("status", { name: "Subagents — 1 failed · 1 working · 3 done" }),
    ).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Show all 5 subagents" }));
      await Promise.resolve();
    });
    expect(onOpenSubagentsPanel).toHaveBeenCalledTimes(1);
    expect(onOpenThread).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Review UI" }));
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledWith("second-child", expect.anything());
  });

  test("a report opens the one subagent it names", async () => {
    const onOpenThread = vi.fn();
    const view = render(
      <RuntimeNoticeRow
        message='Subagent "Audit" finished'
        notice={{
          kind: "report",
          source: "subagent",
          outcome: "completed",
          childThreadId: "child",
        }}
        onOpenThread={onOpenThread}
      />,
    );
    expect(view.container.querySelector('[data-subagent-avatar-seed="child"]')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: 'Open Subagent "Audit" finished' }));
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledWith("child");
  });
});
