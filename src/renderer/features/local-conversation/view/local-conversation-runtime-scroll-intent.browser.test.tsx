import { act, render, waitFor } from "@testing-library/react";
import { cdp, page } from "vite-plus/test/browser";
import { useLayoutEffect, type CSSProperties } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import type { AgentSnapshot, AgentTurnItem } from "@nodex/agent-runtime/contracts";
import type {
  AgentRuntimeConversation,
  AgentRuntimeSessionEvent,
} from "../../../../shared/agent-runtime-api";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import {
  AgentRuntimeConversationOwner,
  type AgentRuntimeReadTransport,
} from "../agent-runtime-conversation-owner";
import {
  CodexTranscriptReadOwnerContext,
  useCodexTranscriptStructure,
} from "../normalized-transcript-hooks";
import { selectNormalizedConversationTurnEntries } from "../normalized-transcript-selectors";
import { projectNormalizedTimelineEntries } from "../projection/normalized-timeline-entries";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import {
  EnsureLocalConversationThreadScrollController,
  getThreadScrollDistanceFromBottomPx,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import { LocalConversationVirtualizedTurnList } from "./local-conversation-virtualized-turn-list";
import type { CDPSession } from "@vitest/browser-playwright";
import "../../../globals.css";

const target = { sessionId: "scroll-session", threadId: "scroll-thread" };
const at = "2026-10-23T00:00:00.000Z";
const originalApi = window.api;
beforeEach(async () => {
  await page.viewport(800, 700);
  window.api = {
    on: () => () => {},
    invoke: async (channel, ...args) =>
      channel === "persisted-atom:sync-request"
        ? { revision: 0, values: {} }
        : channel === "codex:app-server:request"
          ? { type: "result", result: { data: [], nextCursor: null } }
          : channel === "workspace-paths-exist"
            ? { existingPaths: (args[0] as { paths: string[] }).paths }
            : undefined,
  };
});
afterEach(() => {
  window.api = originalApi;
});
const frames = async (count = 3) => {
  for (let index = 0; index < count; index++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
const base = (id: string, ordinal: number) => ({
  id,
  ordinal,
  threadId: target.threadId,
  runId: "run",
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  status: "completed" as const,
  title: null,
  startedAt: at,
  completedAt: at,
  updatedAt: at,
});
const assistant = (text: string): Extract<AgentTurnItem, { type: "assistant_message" }> => ({
  ...base("assistant", 100),
  type: "assistant_message",
  runId: "run",
  messageId: "assistant-message",
  text,
  streaming: true,
  status: "running",
  completedAt: null,
});
const row = (
  item: AgentTurnItem,
  position = 0,
): AgentSnapshot["projection"]["visibleTurnItems"][number] => ({
  position,
  visibility: "local",
  sourceThreadId: item.threadId,
  sourceItemId: item.id,
  item,
});
function conversation(
  items: readonly AgentTurnItem[],
  cursor: string | null = null,
): AgentRuntimeConversation {
  return {
    ...target,
    projectId: "project",
    snapshot: {
      kind: "snapshot",
      snapshotSequence: 1,
      historyCursor: cursor,
      hasMoreHistory: cursor !== null,
      latestLocalTurnOrdinal: 100,
      payloadBudgetExceeded: false,
      turnItemsOmitLocalVisible: true,
      projection: {
        thread: {
          id: target.threadId,
          projectId: "project",
          title: "Thread",
          createdBy: "user",
          creationSource: "web",
          providerInstanceId: "claude",
          modelSelection: { instanceId: "claude", model: "model" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: "/workspace",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: target.threadId,
          },
          forkedFrom: null,
          createdAt: at,
          updatedAt: at,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        runs: [
          {
            id: "run",
            threadId: target.threadId,
            ordinal: 1,
            providerInstanceId: "claude",
            modelSelection: { instanceId: "claude", model: "model" },
            providerThreadId: null,
            userMessageId: "user-message",
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: at,
            startedAt: at,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
        attempts: [],
        nodes: [],
        subagents: [],
        providerSessions: [],
        providerThreads: [],
        providerTurns: [],
        runtimeRequests: [],
        messages: [],
        plans: [],
        turnItems: [],
        checkpointScopes: [],
        checkpoints: [],
        contextHandoffs: [],
        contextTransfers: [],
        visibleTurnItems: items.map(row),
        updatedAt: at,
      },
    },
  };
}

/** Continuation replies can contain work and a final delivery without a new user message. */
function runtimeFixture(toolWork = false) {
  const items: AgentTurnItem[] = Array.from({ length: 9 }, (_, index) => ({
    ...base(`work:${index}`, index + 1),
    type: "assistant_message",
    messageId: `work-message:${index}`,
    text:
      `Review step ${index + 1}. ` +
      "The report is being checked against the current application state. ".repeat(6),
    streaming: false,
  }));
  if (toolWork) {
    items.splice(3);
    items.push(
      ...Array.from({ length: 24 }, (_, index): AgentTurnItem => ({
        ...base(`command:${index}`, index + 10),
        type: "command_execution",
        input: `echo verification-${index}`,
        output: "Verification completed.",
        exitCode: 0,
      })),
    );
  }
  items.push({
    ...base("report-file", 90),
    type: "file_change",
    fileName: "/workspace/report/index.html",
    diffStr:
      "--- a/report/index.html\n+++ b/report/index.html\n@@ -0,0 +1 @@\n+<h1>Review report</h1>",
  });
  const answer = assistant(
    toolWork
      ? "The report is ready. Verification completed successfully."
      : Array.from(
          { length: 12 },
          (_, index) =>
            `Verification ${index + 1}: ` +
            "The report and application behavior are consistent. ".repeat(3),
        ).join("\n\n"),
  );
  items.push(answer);
  const initial = conversation(items);
  const run = initial.snapshot.projection.runs[0]!;
  let listener: ((event: AgentRuntimeSessionEvent) => void) | undefined;
  let sequence = 1;
  const transport: AgentRuntimeReadTransport = {
    read: async () => initial,
    control: async () => initial,
    history: async () => ({
      snapshotSequence: 1,
      items: [],
      nextCursor: null,
      hasMoreHistory: false,
    }),
    item: async () => null,
    attachment: async () => null,
    readQueuePage: async () => ({
      snapshotSequence: 1,
      entries: [],
      nextCursor: null,
      nextRunId: null,
    }),
    readQueuedPreview: async () => null,
    readRunMessage: async () => null,
    subscribe: async (_target, next) => {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  };
  const owner = new AgentRuntimeConversationOwner(target, transport);
  return {
    owner,
    complete() {
      listener?.({
        type: "event",
        ...target,
        event: {
          sequence: ++sequence,
          commandId: null,
          event: {
            id: "answer-completed",
            threadId: target.threadId,
            occurredAt: at,
            type: "turn-item.updated",
            payload: { ...answer, status: "completed", streaming: false, completedAt: at },
          },
        },
      });
      listener?.({
        type: "event",
        ...target,
        event: {
          sequence: ++sequence,
          commandId: null,
          event: {
            id: "run-completed",
            threadId: target.threadId,
            occurredAt: at,
            type: "run.updated",
            payload: { ...run, status: "completed", completedAt: at },
          },
        },
      });
    },
  };
}

function mountRuntime(
  fixture: ReturnType<typeof runtimeFixture>,
  { zoom = 1, height = 600 }: { zoom?: number; height?: number } = {},
) {
  const store = createMaitaiStore();
  let controller: LocalConversationThreadScrollControllerValue | null = null;
  let ready = false;
  function Thread() {
    const { owner, structure } = useCodexTranscriptStructure();
    const scroll = useLocalConversationThreadScrollController();
    useLayoutEffect(() => {
      controller = scroll;
    });
    if (!owner || !structure) return null;
    const projected = projectNormalizedTimelineEntries({
      owner,
      structure,
      entries: selectNormalizedConversationTurnEntries({ owner, structure, conversation: null }),
    });
    // A viewport consumer may read native geometry before the scroll owner handles the event.
    return (
      <div
        data-test-viewport-frame="true"
        style={
          {
            width: 700 / zoom,
            height: height / zoom,
            zoom,
            "--codex-window-zoom": zoom,
          } as CSSProperties
        }
        onScrollCapture={() => scroll.getScrollDistanceFromBottomPx()}
      >
        <LocalConversationThreadScrollLayout footer={<div style={{ height: 80 }} />}>
          <LocalConversationVirtualizedTurnList
            entries={[...projected.entries]}
            historyRows={projected.historyRows ?? undefined}
            conversationId={target.threadId}
            threadCwd="/workspace"
            editableTurnIds={new Set()}
            canForkFromTurn={false}
            initialScrollOffset={0}
            initialCollapsedAgentBodyByTurnSearchKey={Object.fromEntries(
              projected.entries.flatMap((entry) =>
                "turnSearchKey" in entry ? [[entry.turnSearchKey, false]] : [],
              ),
            )}
            onVisibleContentReady={() => {
              ready = true;
            }}
            historyRequestSource={fixture.owner}
            scrollElement={scroll.scrollElement}
          />
        </LocalConversationThreadScrollLayout>
      </div>
    );
  }
  const view = render(
    <MaitaiProvider store={store}>
      <LocalConversationTestQueryProvider>
        <NodexTooltipProvider>
          <CodexTranscriptReadOwnerContext.Provider value={fixture.owner.readOwner}>
            <EnsureLocalConversationThreadScrollController>
              <Thread />
            </EnsureLocalConversationThreadScrollController>
          </CodexTranscriptReadOwnerContext.Provider>
        </NodexTooltipProvider>
      </LocalConversationTestQueryProvider>
    </MaitaiProvider>,
  );
  return {
    ...view,
    scroll: () => {
      if (!controller) throw new Error("Missing controller");
      return controller;
    },
    settle: async () => {
      await waitFor(() => expect(ready).toBe(true));
      await act(async () => {
        await frames(8);
      });
    },
    dispose: () => {
      view.unmount();
      fixture.owner.dispose();
      disposeMaitaiStore(store);
    },
  };
}

describe("completed runtime response scroll intent", () => {
  test("geometry reads preserve user intent while a completed continuation report reflows", async () => {
    const fixture = runtimeFixture();
    const view = mountRuntime(fixture);
    try {
      await view.settle();
      await act(async () => {
        fixture.complete();
        await frames(15);
      });
      await view.findByRole("button", { name: "index.html" });
      const viewport = view.scroll().getScrollElement()!;
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight + 500);
      const bounds = viewport.getBoundingClientRect();
      const iframe = window.frameElement?.getBoundingClientRect();
      const session: CDPSession = cdp();
      const distances: number[] = [];
      for (let index = 0; index < 8; index++) {
        const beforeWheel = getThreadScrollDistanceFromBottomPx(viewport);
        await act(async () => {
          await session.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: bounds.left + 200 + (iframe?.left ?? 0),
            y: bounds.top + 200 + (iframe?.top ?? 0),
            deltaX: 0,
            deltaY: -8,
          });
          await frames(8);
        });
        distances.push(getThreadScrollDistanceFromBottomPx(viewport));
        expect(getThreadScrollDistanceFromBottomPx(viewport)).toBeGreaterThan(beforeWheel);
        if (index === 0) {
          const frame = view.container.querySelector<HTMLElement>("[data-test-viewport-frame]")!;
          const beforeReflow = getThreadScrollDistanceFromBottomPx(viewport);
          await act(async () => {
            frame.style.width = "620px";
            await frames(8);
          });
          expect(getThreadScrollDistanceFromBottomPx(viewport)).toBeGreaterThanOrEqual(
            beforeReflow,
          );
        }
      }
      expect(distances.at(-1)).toBeGreaterThan(50);
      expect(view.scroll().getScrollMode()).toBe("user");
    } finally {
      view.dispose();
    }
  });
  test("small upward scrolling survives the expansion of completed tool work", async () => {
    const fixture = runtimeFixture(true);
    const view = mountRuntime(fixture, { zoom: 1.2, height: 480 });
    try {
      await view.settle();
      await act(async () => {
        const follow = view.scroll().responseSpacerState;
        expect(follow).not.toBeNull();
        follow!.scrollToBottom();
        await frames(4);
        fixture.complete();
        await frames(12);
      });
      await view.findByRole("button", { name: "index.html" });
      await act(async () => {
        view.getByRole("button", { name: "Edited a file, ran commands" }).click();
        await frames(10);
      });
      const viewport = view.scroll().getScrollElement()!;
      expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight + 200);
      expect(view.scroll().getScrollMode()).toBe("stickToBottom");
      const bounds = viewport.getBoundingClientRect();
      const iframe = window.frameElement?.getBoundingClientRect();
      const session: CDPSession = cdp();
      const nativeDistances: number[] = [];
      const recordNativeScroll = () =>
        nativeDistances.push(getThreadScrollDistanceFromBottomPx(viewport));
      viewport.addEventListener("scroll", recordNativeScroll);
      try {
        await act(async () => {
          // Scroll below the tool group's own viewport so the gesture belongs to the thread.
          await session.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: bounds.left + 20 + (iframe?.left ?? 0),
            y: bounds.bottom - 130 + (iframe?.top ?? 0),
            deltaX: 0,
            deltaY: -8,
          });
          await frames(40);
        });
        expect(nativeDistances.some((distance) => distance > 0)).toBe(true);
        expect(getThreadScrollDistanceFromBottomPx(viewport)).toBeGreaterThan(0);
        expect(view.scroll().getScrollMode()).toBe("user");
      } finally {
        viewport.removeEventListener("scroll", recordNativeScroll);
      }
      await act(async () => {
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: bounds.left + 20 + (iframe?.left ?? 0),
          y: bounds.bottom - 130 + (iframe?.top ?? 0),
          deltaX: 0,
          deltaY: 1000,
        });
        await frames(10);
      });
      expect(view.scroll().getScrollDistanceFromBottomPx()).toBe(0);
      expect(view.scroll().getScrollMode()).toBe("stickToBottom");
      await act(async () => {
        view.getByRole("button", { name: "Edited a file, ran commands" }).click();
        await frames(40);
      });
      expect(view.scroll().getScrollDistanceFromBottomPx()).toBe(0);
      expect(view.scroll().getScrollMode()).toBe("stickToBottom");
    } finally {
      view.dispose();
    }
  });
});
