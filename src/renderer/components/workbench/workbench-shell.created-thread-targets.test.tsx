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
  hydrateSelectedSubagentCalls,
  invokeCalls,
  mockInvokeImpl,
  renderWorkbench,
  setMockInvokeImpl,
  getConnectedThreadStagePropsByThreadId,
  sideChatConversations,
} from "./workbench-testkit/workbench-shell-harness";

vi.mock("../../features/local-conversation/created-thread-host-hooks", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../features/local-conversation/created-thread-host-hooks")
  >()),
  useExistingCreatedThreadHost: () => ({ manager: null, connected: false }),
}));

function namedSession(id: string, title: string, threadId: string) {
  const session = makeAttachedSession({ id, projectId: "alpha", title, threadId, tabs: [] });
  return { ...session, thread: { ...session.thread!, threadName: title } };
}

describe("created chat host-qualified Workbench navigation", () => {
  test("an explicit foreign host cannot select a cached Session with the same native ID", async () => {
    const source = namedSession("source", "Source", "source-thread");
    const foreign = namedSession("foreign", "Foreign local chat", "same");
    const view = renderWorkbench({
      sessionsByProject: { alpha: [source, foreign] },
      initialSelectedSessionId: source.id,
    });
    await settleAsyncRender();
    const actions = await waitForLastThreadStageActions();
    const open = actions.onOpenThread as ThreadStageActions["onOpenThread"];
    const base = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) =>
      channel === "codex:created-thread:resolve"
        ? { hostId: "local", threadId: "same", ready: true, parentThreadId: null }
        : ((await base?.(channel, ...args)) ?? null),
    );
    const before = view.navigationStateChanges.length;
    await act(async () => {
      await open("same", { createdTarget: { threadId: "same", hostId: "remote" } });
      await Promise.resolve();
    });
    expect(view.navigationStateChanges).toHaveLength(before);
    expect(
      within(view.getByTestId("workbench-global-header")).getByTestId("thread-stage-title")
        .textContent,
    ).toBe("Source");
    expect(
      invokeCalls.filter(
        ([channel]) =>
          channel === "codex:thread:ensure-open" || channel === "codex:thread:ensure-session",
      ),
    ).toEqual([]);
    expect(
      invokeCalls.some(
        ([channel, input]) =>
          channel === "codex:created-thread:resolve" &&
          (input as { expectedHostId?: string }).expectedHostId === "remote",
      ),
    ).toBe(true);
  });
  test("an explicit missing root reaches the strict command before selecting its returned Session", async () => {
    const source = namedSession("source", "Source", "source-thread");
    const target = namedSession("target", "Created", "created-thread");
    const view = renderWorkbench({
      sessionsByProject: { alpha: [source] },
      initialSelectedSessionId: source.id,
    });
    await settleAsyncRender();
    const open = (await waitForLastThreadStageActions())
      .onOpenThread as ThreadStageActions["onOpenThread"];
    const base = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "codex:created-thread:resolve") return null;
      if (channel === "codex:thread:ensure-open") return target;
      return (await base?.(channel, ...args)) ?? null;
    });
    await act(async () => {
      await open("created-thread", {
        createdTarget: { threadId: "created-thread", hostId: "local" },
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        within(view.getByTestId("workbench-global-header")).getByTestId("thread-stage-title")
          .textContent,
      ).toBe("Created"),
    );
    expect(invokeCalls.filter(([channel]) => channel === "codex:thread:ensure-open")).toEqual([
      ["codex:thread:ensure-open", { hostId: "local", threadId: "created-thread" }],
    ]);
    expect(invokeCalls.some(([channel]) => channel === "codex:thread:ensure-session")).toBe(false);
  });
  test("a known linked root still crosses the exact host guard before selecting its Session", async () => {
    const source = namedSession("source", "Source", "source-thread");
    const target = namedSession("target", "Created", "created-thread");
    const view = renderWorkbench({
      sessionsByProject: { alpha: [source, target] },
      initialSelectedSessionId: source.id,
    });
    await settleAsyncRender();
    const open = (await waitForLastThreadStageActions())
      .onOpenThread as ThreadStageActions["onOpenThread"];
    const base = mockInvokeImpl;
    setMockInvokeImpl(async (channel, ...args) => {
      if (channel === "codex:created-thread:resolve")
        return { hostId: "local", threadId: "created-thread", ready: true, parentThreadId: null };
      if (channel === "codex:thread:ensure-open") return target;
      return (await base?.(channel, ...args)) ?? null;
    });
    await act(async () => {
      await open("created-thread", {
        createdTarget: { threadId: "created-thread", hostId: "local" },
      });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        within(view.getByTestId("workbench-global-header")).getByTestId("thread-stage-title")
          .textContent,
      ).toBe("Created"),
    );
    expect(invokeCalls.filter(([channel]) => channel === "codex:thread:ensure-open")).toEqual([
      ["codex:thread:ensure-open", { hostId: "local", threadId: "created-thread" }],
    ]);
    expect(invokeCalls.some(([channel]) => channel === "codex:thread:ensure-session")).toBe(false);
  });
  test("a retired message cannot select a Session whose strict open was already admitted", async () => {
    const source = namedSession("source", "Source", "source-thread");
    const target = namedSession("target", "Created", "created-thread");
    const remoteSource = { ...source, thread: { ...source.thread!, executionHostId: "remote" } };
    const remoteTarget = { ...target, thread: { ...target.thread!, executionHostId: "remote" } };
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
  test("a child click keeps its captured root and host instead of the currently selected Session", async () => {
    const active = namedSession("active", "Current", "current-thread");
    const root = namedSession("root", "Actual root", "root-thread");
    const remoteRoot = { ...root, thread: { ...root.thread!, executionHostId: "remote" } };
    const view = renderWorkbench({
      sessionsByProject: { alpha: [active, remoteRoot] },
      initialSelectedSessionId: active.id,
    });
    await settleAsyncRender();
    const open = (await waitForLastThreadStageActions())
      .onOpenThread as ThreadStageActions["onOpenThread"];
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
    await act(async () => {
      await open("child", {
        hostId: "remote",
        sourceRoot: { hostId: "remote", threadId: "root-thread" },
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
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(
        within(view.getByTestId("workbench-global-header")).getByTestId("thread-stage-title")
          .textContent,
      ).toBe("Actual root"),
    );
    expect(hydrateSelectedSubagentCalls).toEqual([
      { rootThreadId: "root-thread", threadId: "child", expectedHostId: "remote" },
    ]);
    expect(
      view.container.querySelector('[data-subagents-side-panel-tab="subagents:root-thread"]'),
    ).not.toBeNull();
  });
  test.each(["card", "message link"] as const)(
    "a real %s in selected child detail hydrates its grandchild against the panel's owning root",
    async (consumer) => {
      const root = namedSession("root", "Actual root", "root-thread");
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
});
