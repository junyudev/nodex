import "./workbench-testkit/workbench-shell-harness";
import { describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { render, settleAsyncRender } from "../../test/dom";
import { TestQueryProvider } from "../../test/query";
import { LocalConversationCreatedThreadCards } from "../../features/local-conversation/view/local-conversation-created-thread-cards";
import {
  deferred,
  fixture as messageTargetFixture,
  key as messageTargetKey,
} from "../../features/local-conversation/view/conversation-markdown-targets.test-fixtures";
import type { ThreadStageActions } from "../../features/local-conversation/thread-stage-types";
import { makeAttachedSession } from "./workbench-testkit/workbench-shell-fixtures";
import {
  waitForLastThreadStageActions,
  invokeCalls,
  renderWorkbench,
  getConnectedThreadStagePropsByThreadId,
  sideChatConversations,
  mockInvokeImpl,
  setMockInvokeImpl,
  hydrateSelectedSubagentCalls,
} from "./workbench-testkit/workbench-shell-harness";

vi.mock("../../features/local-conversation/created-thread-host-hooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../features/local-conversation/created-thread-host-hooks")
  >()),
  useExistingCreatedThreadHost: () => ({ manager: null, connected: false }),
}));

function namedSession(id: string, title: string, threadId: string) {
  return {
    ...makeAttachedSession({ id, projectId: "alpha", title, threadId, tabs: [] }),
    thread: null,
  };
}

function remoteSession(id: string, title: string, threadId: string) {
  const session = makeAttachedSession({ id, projectId: "alpha", title, threadId, tabs: [] });
  return {
    ...session,
    executionRef: null,
    thread: { ...session.thread!, threadName: title, executionHostId: "remote" },
  };
}

function childThread(threadId: string, parentThreadId: string, title: string) {
  sideChatConversations[threadId] = {
    threadId,
    projectId: "alpha",
    threadName: title,
    statusType: "idle",
    source: { parentThreadId },
    turns: [],
    requests: [],
  };
}

function headerTitle(view: ReturnType<typeof renderWorkbench>) {
  return within(view.getByTestId("workbench-global-header")).getByTestId("thread-stage-title")
    .textContent;
}

function inspections() {
  return invokeCalls.filter(([channel]) => channel === "agent-runtime:session:inspect");
}

describe("created chat Session-bound Workbench navigation", () => {
  test("a Thread from another cached Session cannot borrow the selected Session binding", async () => {
    const source = namedSession("source", "Source", "source-thread");
    const other = namedSession("other", "Other chat", "same");
    const view = renderWorkbench({
      sessionsByProject: { alpha: [source, other] },
      initialSelectedSessionId: source.id,
    });
    await settleAsyncRender();
    const open = (await waitForLastThreadStageActions()).onOpenThread as NonNullable<
      ThreadStageActions["onOpenThread"]
    >;
    const before = view.navigationStateChanges.length;
    await act(async () => {
      await expect(open("same")).rejects.toThrow("Thread does not belong to this Session");
    });
    expect(view.navigationStateChanges).toHaveLength(before);
    expect(headerTitle(view)).toBe("Source");
    expect(inspections()).toEqual([
      ["agent-runtime:session:inspect", { sessionId: source.id, threadId: "same" }],
    ]);
  });

  test("an unavailable destination Session leaves the current route selected", async () => {
    const source = namedSession("source", "Source", "source-thread");
    const view = renderWorkbench({
      sessionsByProject: { alpha: [source] },
      initialSelectedSessionId: source.id,
    });
    await settleAsyncRender();
    const open = (await waitForLastThreadStageActions()).onOpenThread as NonNullable<
      ThreadStageActions["onOpenThread"]
    >;
    const before = view.navigationStateChanges.length;
    await act(async () => {
      await expect(open("created-thread", { runtimeSessionId: "missing" })).rejects.toThrow(
        "Conversation identity changed",
      );
    });
    expect(view.navigationStateChanges).toHaveLength(before);
    expect(headerTitle(view)).toBe("Source");
    expect(inspections()).toEqual([]);
  });

  test("a linked root is inspected through its exact Session before navigation", async () => {
    const source = namedSession("source", "Source", "source-thread");
    const target = namedSession("target", "Created", "created-thread");
    const view = renderWorkbench({
      sessionsByProject: { alpha: [source, target] },
      initialSelectedSessionId: source.id,
    });
    await settleAsyncRender();
    const open = (await waitForLastThreadStageActions()).onOpenThread as NonNullable<
      ThreadStageActions["onOpenThread"]
    >;
    await act(async () => {
      await open("created-thread", { runtimeSessionId: target.id });
    });
    await waitFor(() => expect(headerTitle(view)).toBe("Created"));
    expect(inspections()).toEqual([
      ["agent-runtime:session:inspect", { sessionId: target.id, threadId: "created-thread" }],
    ]);
  });
  test("a retired message cannot select a Session whose strict open was already admitted", async () => {
    const source = namedSession("source", "Source", "source-thread");
    const target = namedSession("target", "Created", "created-thread");
    const remoteSource = remoteSession(source.id, "Source", "source-thread");
    const remoteTarget = remoteSession(target.id, "Created", "created-thread");
    const view = renderWorkbench({
      sessionsByProject: { alpha: [remoteSource] },
      initialSelectedSessionId: source.id,
    });
    await settleAsyncRender();
    const actions = await waitForLastThreadStageActions();
    const admitted = deferred<typeof remoteTarget>();
    const open = actions.onOpenThread as ThreadStageActions["onOpenThread"];
    const base = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "codex:created-thread:resolve")
        return { hostId: "remote", threadId: "created-thread", ready: true, parentThreadId: null };
      if (channel === "codex:thread:ensure-open") return admitted.promise;
      return (await base?.(channel, ...args)) ?? null;
    });
    const message = messageTargetFixture(
      "[Created](thread://created-thread)",
      "remote",
      "ordinary",
      {
        threadId: "source-thread",
        onOpenThread: open,
      },
    );
    const body = message.mount([]);
    try {
      await act(async () => {
        message.connect();
        await Promise.resolve();
      });
      const button = await body.findByRole("button", { name: "Created" });
      await act(async () => {
        fireEvent.click(button);
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(invokeCalls.some(([channel]) => channel === "codex:thread:ensure-open")).toBe(true),
      );
      await act(async () => {
        message.owner.applyEvent({
          type: "changes",
          changes: [
            { type: "item", key: { ...messageTargetKey, ...message.owner.key }, value: null },
          ],
        });
        admitted.resolve(remoteTarget);
        await message.onOpenThread.mock.results[0]!.value;
      });
      expect(
        within(view.getByTestId("workbench-global-header")).getByTestId("thread-stage-title")
          .textContent,
      ).toBe("Source");
      expect(invokeCalls.some(([channel]) => channel === "codex:thread:ensure-session")).toBe(
        false,
      );
    } finally {
      admitted.resolve(remoteTarget);
      await act(async () => {
        body.unmount();
        message.dispose();
        await Promise.resolve();
      });
    }
  });
  test("a child click keeps its captured owning Session instead of the selected root", async () => {
    const active = namedSession("active", "Current", "current-thread");
    const root = namedSession("root", "Actual root", "root-thread");
    childThread("child", "root-thread", "Reviewer");
    const view = renderWorkbench({
      sessionsByProject: { alpha: [active, root] },
      initialSelectedSessionId: active.id,
    });
    await settleAsyncRender();
    const open = (await waitForLastThreadStageActions()).onOpenThread as NonNullable<
      ThreadStageActions["onOpenThread"]
    >;
    await act(async () => {
      await open("child", {
        runtimeSessionId: root.id,
        subagent: {
          conversationId: "child",
          displayName: "Reviewer",
          agentRole: null,
          spawnModel: null,
          status: "done",
          statusSummary: null,
          diffStats: null,
        },
      });
    });
    await waitFor(() => expect(getConnectedThreadStagePropsByThreadId("child")).toBeDefined());
    expect(headerTitle(view)).toBe("Actual root");
    expect(inspections()).toEqual([
      ["agent-runtime:session:inspect", { sessionId: root.id, threadId: "child" }],
    ]);
    expect(invokeCalls).toContainEqual([
      "agent-runtime:session:control",
      { sessionId: root.id, threadId: "child" },
    ]);
    expect(
      view.container.querySelector('[data-subagents-side-panel-tab="subagents:root-thread"]'),
    ).not.toBeNull();
  });
  test.each(["card", "message link"] as const)(
    "a real %s in selected child detail hydrates its grandchild against the panel's owning root",
    async (consumer) => {
      const root = namedSession("root", "Actual root", "root-thread");
      const remoteRoot = remoteSession(root.id, "Actual root", "root-thread");
      sideChatConversations["child"] = {
        threadId: "child",
        projectId: "alpha",
        threadName: "Child",
        statusType: "idle",
        source: { parentThreadId: "root-thread" },
        turns: [],
        requests: [],
      };
      sideChatConversations["grandchild"] = {
        ...sideChatConversations["child"],
        threadId: "grandchild",
        threadName: "Grandchild",
        source: { parentThreadId: "child" },
      };
      const view = renderWorkbench({
        sessionsByProject: { alpha: [remoteRoot] },
        initialSelectedSessionId: remoteRoot.id,
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
            parentThreadId:
              input.threadId === "root-thread"
                ? null
                : input.threadId === "child"
                  ? "root-thread"
                  : "child",
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
        await Promise.resolve();
      });
      await waitFor(() => expect(getConnectedThreadStagePropsByThreadId("child")).toBeDefined());
      const actions = getConnectedThreadStagePropsByThreadId("child")!
        .actions as ThreadStageActions;
      const message =
        consumer === "message link"
          ? messageTargetFixture("[Grandchild](thread://grandchild)", "remote", "ordinary", {
              threadId: "child",
              onOpenThread: actions.onOpenThread,
            })
          : null;
      const card = message
        ? message.mount([])
        : render(
            <TestQueryProvider>
              <LocalConversationCreatedThreadCards
                results={[{ hostId: "remote", threadId: "grandchild" }]}
                sourceRoot={{ hostId: "remote", threadId: "child" }}
                onOpenThread={actions.onOpenThread}
              />
            </TestQueryProvider>,
          );
      try {
        await act(async () => {
          message?.connect();
          await Promise.resolve();
        });
        const button = await card.findByRole("button", {
          name: consumer === "card" ? "Open chat: Created chat" : "Grandchild",
        });
        await act(async () => {
          fireEvent.click(button);
          await Promise.resolve();
        });
        await waitFor(() =>
          expect(hydrateSelectedSubagentCalls).toEqual([
            { rootThreadId: "root-thread", threadId: "child", expectedHostId: "remote" },
            { rootThreadId: "root-thread", threadId: "grandchild", expectedHostId: "remote" },
          ]),
        );
        expect(
          within(view.getByTestId("workbench-global-header")).getByTestId("thread-stage-title")
            .textContent,
        ).toBe("Actual root");
        expect(invokeCalls.some(([channel]) => channel === "codex:thread:ensure-session")).toBe(
          false,
        );
      } finally {
        await act(async () => {
          card.unmount();
          message?.dispose();
          await Promise.resolve();
        });
      }
    },
  );

  test("a real card in child detail opens its grandchild through the panel's owning Session", async () => {
    const root = namedSession("root", "Actual root", "root-thread");
    childThread("child", "root-thread", "Child");
    childThread("grandchild", "child", "Grandchild");
    const view = renderWorkbench({
      sessionsByProject: { alpha: [root] },
      initialSelectedSessionId: root.id,
    });
    await settleAsyncRender();
    const open = (await waitForLastThreadStageActions()).onOpenThread as NonNullable<
      ThreadStageActions["onOpenThread"]
    >;
    await act(async () => {
      await open("child", { runtimeSessionId: root.id });
    });
    await waitFor(() => expect(getConnectedThreadStagePropsByThreadId("child")).toBeDefined());
    const actions = getConnectedThreadStagePropsByThreadId("child")!.actions as ThreadStageActions;
    const card = render(
      <TestQueryProvider>
        <LocalConversationCreatedThreadCards
          results={[{ threadId: "grandchild", hostId: "local" }]}
          sourceRoot={{ hostId: "local", threadId: "child" }}
          onOpenThread={actions.onOpenThread}
        />
      </TestQueryProvider>,
    );
    await act(async () => {
      fireEvent.click(card.getByRole("button", { name: "Open chat: Created chat" }));
      await Promise.resolve();
    });
    await waitFor(() => expect(getConnectedThreadStagePropsByThreadId("grandchild")).toBeDefined());
    expect(inspections()).toEqual([
      ["agent-runtime:session:inspect", { sessionId: root.id, threadId: "child" }],
      ["agent-runtime:session:inspect", { sessionId: root.id, threadId: "grandchild" }],
    ]);
    expect(invokeCalls).toContainEqual([
      "agent-runtime:session:control",
      { sessionId: root.id, threadId: "grandchild" },
    ]);
    expect(headerTitle(view)).toBe("Actual root");
  });
});
