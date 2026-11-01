import { describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { toast } from "@/components/ui/toast";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import type { CodexDelegatedTaskView } from "../../../../../shared/types";
import {
  agentRuntimeDelegatedTasks,
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
  agentKind: "claude",
  status: "running",
  prompt: "Audit the auth module",
  summary: null,
};

function setup() {
  const store = createAgentRuntimeDelegatedTaskStore();
  agentRuntimeDelegatedTasks.publishLabels(
    new Map([
      [
        "claude",
        { label: "Claude", kind: "claude", models: new Map([["opus", "Claude Opus 5.5"]]) },
      ],
      [
        "codex",
        { label: "Codex", kind: "codex", models: new Map([["gpt-6.1-sol", "GPT-6.1-Sol"]]) },
      ],
    ]),
  );
  let finishStop: () => void = () => {};
  const transport: AgentRuntimeTaskStopTransport = {
    cancelTask: vi.fn(
      (input: { readonly taskId: string }) =>
        new Promise<{ taskId: string; status: string }>((resolve) => {
          finishStop = () => resolve({ taskId: input.taskId, status: "cancelled" });
        }),
    ),
    stopTask: vi.fn(async () => ({ sequence: 1 })),
  };
  const runtime = {
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
    expect(transport.cancelTask).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "session", threadId: "root", taskId: "task" }),
    );
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

  test("names the harness and model of a subagent another Agent runs", async () => {
    const { wrap } = setup();
    const membership = {
      threadId: "child",
      taskId: "task",
      agent: { kind: "codex", providerInstanceId: "codex", model: "gpt-6.1-sol", effort: "xhigh" },
    } as never;
    render(
      wrap(
        <DelegatedTaskGroup
          tasks={[{ ...task, providerInstanceId: "codex", agentKind: "codex" }]}
          parentThreadId="root"
          childMemberships={[membership]}
          onOpenThread={vi.fn()}
        />,
      ),
    );
    await act(async () => {
      screen.getByRole("button", { name: "Audit auth" }).focus();
      await Promise.resolve();
    });
    const details = await screen.findByRole("dialog", { name: "Audit auth details" });
    const agent = within(details).getByText("Codex · GPT-6.1 Sol");
    expect(agent.closest("[data-agent-identity]")?.getAttribute("data-agent-identity")).toBe(
      "codex",
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
    vi.mocked(transport.cancelTask).mockRejectedValueOnce(new Error("Agent disconnected"));
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

  test("a report names its subagents like the row that started them and opens each one", async () => {
    const { wrap } = setup();
    const onOpenThread = vi.fn();
    const children = [
      {
        threadId: "child",
        taskId: "task",
        displayName: "WebAuthn routes",
        agent: {
          kind: "codex",
          providerInstanceId: "codex",
          model: "gpt-6.1-sol",
          effort: "xhigh",
        },
      },
      { threadId: "second-child", taskId: "second", displayName: "Credentials migration" },
    ] as never;
    const view = render(
      wrap(
        <RuntimeNoticeRow
          message="2 delegated tasks finished: WebAuthn routes, Credentials migration"
          notice={{
            kind: "report",
            source: "subagent",
            outcome: "completed",
            childThreadId: null,
            taskIds: ["task", "second"],
          }}
          childMemberships={children}
          onOpenThread={onOpenThread}
        />,
      ),
    );
    expect(screen.getByRole("status", { name: "Subagents finished" }).textContent).toBe(
      "WebAuthn routes and Credentials migration finished",
    );
    expect(view.container.querySelector('[data-subagent-avatar-seed="child"]')).not.toBeNull();
    await act(async () => {
      screen.getByRole("button", { name: "WebAuthn routes" }).focus();
      await Promise.resolve();
    });
    const details = await screen.findByRole("dialog", { name: "WebAuthn routes details" });
    expect(within(details).getByText("Codex · GPT-6.1 Sol")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Credentials migration" }));
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledWith(
      "second-child",
      expect.objectContaining({
        subagent: expect.objectContaining({ displayName: "Credentials migration" }),
      }),
    );
  });

  test("a report whose subagents the parent no longer lists keeps its message and opens its child", async () => {
    const onOpenThread = vi.fn();
    const view = render(
      <RuntimeNoticeRow
        message='Delegated task "Audit" failed'
        notice={{
          kind: "report",
          source: "subagent",
          outcome: "failed",
          childThreadId: "child",
          taskIds: ["task"],
        }}
        onOpenThread={onOpenThread}
      />,
    );
    expect(view.container.querySelector('[data-subagent-avatar-seed="child"]')).not.toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: 'Open Delegated task "Audit" failed' }));
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledWith("child");
  });
});
