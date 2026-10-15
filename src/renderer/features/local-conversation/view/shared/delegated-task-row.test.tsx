import { describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { NodexTooltipProvider } from "../../../../components/ui/tooltip";
import type { CodexDelegatedTaskView } from "../../../../../shared/types";
import {
  createAgentRuntimeDelegatedTaskPort,
  createAgentRuntimeDelegatedTaskStore,
  type AgentRuntimeTaskStopTransport,
} from "../../agent-runtime-delegated-tasks";
import { ConversationRuntimeContext, type ConversationRuntime } from "../../conversation-runtime";
import { DelegatedTaskRow, RuntimeNoticeRow } from "./delegated-task-row";

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
      ["claude", { label: "Claude", models: new Map([["opus", "Claude Opus 5.5"]]) }],
      ["codex", { label: "Codex", models: new Map([["gpt", "GPT-5.5"]]) }],
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
  test("names the task and who runs it, then keeps Stopping until the task settles", async () => {
    const { transport, wrap, finishStop } = setup();
    const onOpenThread = vi.fn();
    const membership = { threadId: "child", thread: { model: "opus" } } as never;
    const view = render(
      wrap(
        <DelegatedTaskRow
          task={task}
          parentThreadId="root"
          membership={membership}
          onOpenThread={onOpenThread}
        />,
      ),
    );
    expect(screen.getByRole("button", { name: "Audit auth, Running" })).toBeTruthy();
    expect(screen.getByText("· Claude Opus 5.5")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop Audit auth" }));
      await Promise.resolve();
    });
    expect(await screen.findByRole("button", { name: "Audit auth, Stopping…" })).toBeTruthy();
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
    // The accepted request alone does not prove the task stopped.
    expect(screen.getByRole("button", { name: "Audit auth, Stopping…" })).toBeTruthy();

    view.rerender(
      wrap(
        <DelegatedTaskRow
          task={{ ...task, status: "stopped" }}
          parentThreadId="root"
          membership={membership}
          onOpenThread={onOpenThread}
        />,
      ),
    );
    expect(await screen.findByRole("button", { name: "Audit auth, Stopped" })).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Open Audit auth" }));
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledWith(
      "child",
      expect.objectContaining({
        subagent: expect.objectContaining({ conversationId: "child", status: "done" }),
      }),
    );
  });

  test("a provider-native task stops through its owning parent Run", async () => {
    const { transport, wrap } = setup();
    render(
      wrap(
        <DelegatedTaskRow
          task={{ ...task, childThreadId: null }}
          parentThreadId="root"
          membership={undefined}
        />,
      ),
    );
    expect(screen.queryByRole("button", { name: "Open Audit auth" })).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop Audit auth" }));
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

  test("a report opens the one subagent it names", async () => {
    const onOpenThread = vi.fn();
    render(
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
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: 'Open Subagent "Audit" finished' }));
      await Promise.resolve();
    });
    expect(onOpenThread).toHaveBeenCalledWith("child");
  });
});
