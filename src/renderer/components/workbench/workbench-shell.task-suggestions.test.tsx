import "./workbench-testkit/workbench-shell-harness";
import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { settleAsyncRender } from "@/test/dom";
import type { ThreadStageActions } from "@/features/local-conversation/thread-stage-types";
import {
  fixture as messageFixture,
  deferred,
} from "@/features/local-conversation/view/conversation-markdown-targets.test-fixtures";
import { makeAttachedSession } from "./workbench-testkit/workbench-shell-fixtures";
import {
  invokeCalls,
  mockInvokeImpl,
  renderWorkbench,
  rendererCommandPayload,
  setMockInvokeImpl,
  startThreadForSessionCalls,
  waitForLastThreadStageActions,
  sideChatConversations,
  getConnectedThreadStagePropsByThreadId,
} from "./workbench-testkit/workbench-shell-harness";

function executionCalls() {
  return invokeCalls.filter(([channel, input]) => {
    const method = (input as { request?: { method?: string } } | undefined)?.request?.method;
    return (
      /(?:turn:start|turn:steer|queue.*enqueue|thread:start)/.test(String(channel)) ||
      (typeof method === "string" &&
        /(?:turn\/start|turn\/steer|queue.*enqueue|thread\/start)/.test(method))
    );
  });
}

describe("task suggestions use the owning Workbench draft", () => {
  test("an already retired source cannot allocate or navigate", async () => {
    const source = makeAttachedSession({ id: "source", projectId: "alpha" });
    const view = renderWorkbench({
      sessionsByProject: { alpha: [source] },
      initialSelectedSessionId: source.id,
    });
    await settleAsyncRender();
    const prefill = (await waitForLastThreadStageActions()).onStartNewChatWithPrompt as NonNullable<
      ThreadStageActions["onStartNewChatWithPrompt"]
    >;
    const before = view.navigationStateChanges.length;
    await act(async () => {
      await prefill({ projectId: "alpha", prompt: "stale", isSourceCurrent: () => false });
    });
    expect(view.navigationStateChanges).toHaveLength(before);
    expect(
      invokeCalls.filter(([channel]) => channel === "project-sessions:ensure-default-draft"),
    ).toEqual([]);
    expect(startThreadForSessionCalls).toEqual([]);
  });
  test.each(["alpha", null])(
    "prefills captured project %s despite another active project",
    async (projectId) => {
      const foreign = makeAttachedSession({
        id: "foreign",
        projectId: "beta",
        threadId: "foreign-thread",
      });
      const view = renderWorkbench({
        sessionsByProject: { alpha: [], beta: [foreign] },
        initialSelectedSessionId: foreign.id,
      });
      await settleAsyncRender();
      const prefill = (await waitForLastThreadStageActions())
        .onStartNewChatWithPrompt as NonNullable<ThreadStageActions["onStartNewChatWithPrompt"]>;
      const message = messageFixture(
        ':::task-stub{title="Suggested"}\nRaw **prompt**\n:::',
        "remote",
        "ordinary",
        { projectId, onStartNewChatWithPrompt: prefill },
      );
      const body = message.mount([]);
      try {
        await act(async () => {
          message.connect();
          await Promise.resolve();
        });
        const use = await body.findByRole("button", { name: "Use suggestion" });
        await act(async () => {
          fireEvent.click(use);
          await Promise.resolve();
        });
        await waitFor(() =>
          expect((view.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(
            "\nRaw **prompt**",
          ),
        );
        const ensure = invokeCalls.filter(
          ([channel]) => channel === "project-sessions:ensure-default-draft",
        );
        expect(ensure).toHaveLength(1);
        expect(rendererCommandPayload(ensure[0])?.projectId).toBe(projectId);
        expect(startThreadForSessionCalls).toEqual([]);
        expect(executionCalls()).toEqual([]);
      } finally {
        body.unmount();
        message.dispose();
      }
    },
  );

  test("a retired source cannot publish a draft whose allocation was already admitted", async () => {
    const sourceSession = makeAttachedSession({
      id: "source",
      projectId: "alpha",
      threadId: "source-thread",
    });
    const view = renderWorkbench({
      sessionsByProject: { alpha: [sourceSession] },
      initialSelectedSessionId: sourceSession.id,
    });
    await settleAsyncRender();
    const prefill = (await waitForLastThreadStageActions()).onStartNewChatWithPrompt as NonNullable<
      ThreadStageActions["onStartNewChatWithPrompt"]
    >;
    const allocation = deferred<unknown>();
    let allocated: unknown;
    const base = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel !== "project-sessions:ensure-default-draft")
        return (await base?.(channel, ...args)) ?? null;
      allocated = await base?.(channel, ...args);
      return allocation.promise;
    });
    const message = messageFixture('::task-stub[raw]{title="Task"}', "local", "inline", {
      projectId: "alpha",
      onStartNewChatWithPrompt: prefill,
    });
    const body = message.mount([]);
    try {
      await act(async () => {
        message.connect();
        await Promise.resolve();
      });
      const use = await body.findByRole("button", { name: "Use suggestion" });
      const before = view.navigationStateChanges.length;
      await act(async () => {
        fireEvent.click(use);
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(
          invokeCalls.some(([channel]) => channel === "project-sessions:ensure-default-draft"),
        ).toBe(true),
      );
      await waitFor(() => expect(allocated).toBeDefined());
      await act(async () => {
        body.unmount();
        allocation.resolve(allocated);
        await Promise.resolve();
      });
      await settleAsyncRender();
      expect(view.navigationStateChanges).toHaveLength(before);
      expect(view.queryByLabelText("Prompt")).toBeNull();
      expect(startThreadForSessionCalls).toEqual([]);
      expect(executionCalls()).toEqual([]);
    } finally {
      body.unmount();
      message.dispose();
    }
  });

  test("an empty authored prompt explicitly clears the reusable draft", async () => {
    const source = makeAttachedSession({ id: "source", projectId: "alpha" });
    const view = renderWorkbench({
      sessionsByProject: { alpha: [source] },
      initialSelectedSessionId: source.id,
    });
    await settleAsyncRender();
    const prefill = (await waitForLastThreadStageActions()).onStartNewChatWithPrompt as NonNullable<
      ThreadStageActions["onStartNewChatWithPrompt"]
    >;
    await act(async () => {
      await prefill({ projectId: "alpha", prompt: "Old draft" });
    });
    await waitFor(() =>
      expect((view.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Old draft"),
    );
    await act(async () => {
      await prefill({ projectId: "alpha", prompt: "" });
    });
    await waitFor(() =>
      expect((view.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe(""),
    );
    expect(startThreadForSessionCalls).toEqual([]);
    expect(executionCalls()).toEqual([]);
  });

  test("a read-only selected child's suggestion reaches the same project draft owner", async () => {
    const root = makeAttachedSession({ id: "root", projectId: "alpha", threadId: "root-thread" });
    const remoteRoot = { ...root, thread: { ...root.thread!, executionHostId: "remote" } };
    sideChatConversations["child"] = {
      threadId: "child",
      projectId: "alpha",
      threadName: "Child",
      statusType: "idle",
      source: { parentThreadId: "root-thread" },
      turns: [],
      requests: [],
    };
    const view = renderWorkbench({
      sessionsByProject: { alpha: [remoteRoot] },
      initialSelectedSessionId: root.id,
    });
    await settleAsyncRender();
    const base = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "codex:created-thread:resolve") {
        const input = args[0] as { threadId: string };
        return {
          hostId: "remote",
          threadId: input.threadId,
          ready: true,
          parentThreadId: input.threadId === "child" ? "root-thread" : null,
        };
      }
      if (channel === "codex:thread:ensure-open") return remoteRoot;
      return (await base?.(channel, ...args)) ?? null;
    });
    const open = (await waitForLastThreadStageActions())
      .onOpenThread as ThreadStageActions["onOpenThread"];
    await act(async () => {
      await open("child", {
        createdTarget: { hostId: "remote", threadId: "child" },
        sourceRoot: { hostId: "remote", threadId: "root-thread" },
      });
    });
    await waitFor(() => expect(getConnectedThreadStagePropsByThreadId("child")).toBeDefined());
    const actions = getConnectedThreadStagePropsByThreadId("child")!.actions as ThreadStageActions;
    const message = messageFixture(
      '::task-stub[Child prompt]{title="Task"}',
      "remote",
      "ordinary",
      {
        projectId: "alpha",
        threadId: "child",
        onStartNewChatWithPrompt: actions.onStartNewChatWithPrompt,
      },
    );
    const body = message.mount([]);
    try {
      await act(async () => {
        message.connect();
        await Promise.resolve();
      });
      await act(async () => {
        fireEvent.click(await body.findByRole("button", { name: "Use suggestion" }));
        await Promise.resolve();
      });
      await waitFor(() =>
        expect((view.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Child prompt"),
      );
      expect(startThreadForSessionCalls).toEqual([]);
      expect(executionCalls()).toEqual([]);
    } finally {
      body.unmount();
      message.dispose();
    }
  });
});
