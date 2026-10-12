import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, test } from "vite-plus/test";
import type { ThreadItem, ThreadTimelineListResponse } from "@nodex/codex-app-server-protocol/v2";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import type { VirtualizedTurnListRestoreState } from "./local-conversation-turn-virtualization";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import { LocalConversationVirtualizedTurnList } from "./local-conversation-virtualized-turn-list";
import "../../../globals.css";

const originalApi = window.api;
beforeEach(() => {
  window.api = {
    on: () => () => {},
    invoke: async (channel, ...args) =>
      channel === "persisted-atom:sync-request"
        ? { revision: 0, values: {} }
        : channel === "workspace-paths-exist"
          ? { existingPaths: (args[0] as { paths: string[] }).paths }
          : channel === "codex:app-server:request"
            ? { type: "result", result: undefined }
            : undefined,
  };
});
afterEach(() => {
  window.api = originalApi;
});
const frames = async (count = 5) => {
  for (let index = 0; index < count; index += 1)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};
function fixture(prefix: boolean, includeResources = false) {
  const raw: ThreadItem[] = Array.from({ length: 16 }, (_, index) => ({
    type: "commandExecution",
    id: `command-${index}`,
    pluginId: null,
    scriptPath: null,
    command: `echo segment-${index}`,
    cwd: "/workspace",
    processId: null,
    source: "agent",
    status: "completed",
    commandActions: [],
    aggregatedOutput: `segment-${index}`,
    exitCode: 0,
    durationMs: 1,
  }));
  if (includeResources)
    raw.push({
      type: "agentMessage",
      id: "outputs",
      phase: "final_answer",
      memoryCitation: null,
      delivery: null,
      questions: null,
      text: Array.from(
        { length: 5 },
        (_, index) =>
          `:codex-file-citation{path="/workspace/output-${index}.pdf" purpose="output"}`,
      ).join("\n\n"),
    });
  const data: ThreadTimelineListResponse["data"] = raw.flatMap((item, index) => [
    { type: "item" as const, turnId: "one", position: index * 2 + 2, item },
    {
      type: "realtime" as const,
      position: index * 2 + 3,
      item: {
        type: "transcriptSegment" as const,
        id: `spoken-${index}`,
        realtimeSessionId: "session",
        role: "user" as const,
        text: `Recorded speech ${index}. A persisted voice work boundary.`,
      },
    },
  ]);
  data.unshift({ type: "turnStarted", position: 1, turnId: "one", startedAt: 1 });
  if (prefix)
    data.unshift({
      type: "realtime",
      position: 0,
      item: {
        type: "transcriptSegment",
        id: "older",
        realtimeSessionId: "session",
        role: "assistant",
        text: "Older resident speech.\n\n".repeat(8),
      },
    });
  data.push({
    type: "turnCompleted",
    position: raw.length * 2 + 2,
    turnId: "one",
    status: "completed",
    error: null,
    startedAt: 1,
    completedAt: 2,
    durationMs: 1000,
  });
  return timelineOwnerFixture(
    { data, nextCursor: null, activeRealtimeSessionAtPageStart: "session" },
    raw,
  );
}

test.for([false, true])(
  "a resident native work leaf keeps its position through history prepend and reopen (resources=%s)",
  async (includeResources, context) => {
    const store = createMaitaiStore();
    let controller: LocalConversationThreadScrollControllerValue | null = null;
    const saved = { current: null as VirtualizedTurnListRestoreState | null };
    let resourceGeometry: {
      heightGrowth: number;
      topDelta: number;
      bottomDistance: number;
    } | null = null;
    const onRestore = (state: VirtualizedTurnListRestoreState | null) => {
      saved.current = state;
    };
    const read = () => {
      if (!controller) throw new Error("missing scroll owner");
      return controller;
    };
    function Thread({
      value,
      restore = null,
      offset = 0,
    }: {
      value: ReturnType<typeof fixture>;
      restore?: VirtualizedTurnListRestoreState | null;
      offset?: number;
    }) {
      const scroll = useLocalConversationThreadScrollController();
      useLayoutEffect(() => {
        controller = scroll;
      });
      return (
        <div style={{ width: 650, height: 420 }}>
          <LocalConversationThreadScrollLayout
            initialRestoreSnapshot={{
              distanceFromBottomPx: offset,
              latestTurn: null,
              virtualizedTurnList: restore,
            }}
          >
            <LocalConversationVirtualizedTurnList
              entries={[...value.project().entries]}
              conversationId="voice-work-history"
              threadCwd={null}
              editableTurnId={null}
              canForkFromTurn={false}
              initialScrollOffset={offset}
              initialRestoreState={restore}
              onRestoreStateChange={onRestore}
              scrollElement={scroll.scrollElement}
            />
          </LocalConversationThreadScrollLayout>
        </div>
      );
    }
    const surface = (
      value: ReturnType<typeof fixture>,
      restore?: VirtualizedTurnListRestoreState | null,
      offset?: number,
    ) => (
      <MaitaiProvider store={store}>
        <LocalConversationTestQueryProvider>
          <NodexTooltipProvider>
            <CodexTranscriptReadOwnerContext.Provider value={value.owner}>
              <EnsureLocalConversationThreadScrollController>
                <Thread value={value} restore={restore} offset={offset} />
              </EnsureLocalConversationThreadScrollController>
            </CodexTranscriptReadOwnerContext.Provider>
          </NodexTooltipProvider>
        </LocalConversationTestQueryProvider>
      </MaitaiProvider>
    );
    const view = render(surface(fixture(false, includeResources)));
    try {
      await waitFor(() => expect(read().getScrollElement()?.clientHeight).toBe(420));
      if (includeResources) {
        await view.findByRole("button", { name: "Show 2 more" });
        await act(async () => {
          await frames();
        });
        const resourceRow = view.container.querySelector<HTMLElement>(
          '[data-turn-key="timeline:resources:turn:one"]',
        )!;
        const beforeResource = resourceRow.getBoundingClientRect();
        await act(async () => {
          fireEvent.click(view.getByRole("button", { name: "Show 2 more" }));
          await frames();
        });
        const afterResource = resourceRow.getBoundingClientRect();
        resourceGeometry = {
          heightGrowth: afterResource.height - beforeResource.height,
          topDelta: afterResource.top - beforeResource.top,
          bottomDistance: read().getLastScrollDistanceFromBottomPx(),
        };
        expect(afterResource.height - beforeResource.height).toBeGreaterThan(30);
        expect(Math.abs(read().getLastScrollDistanceFromBottomPx())).toBeLessThanOrEqual(1);
        expect(
          Math.abs(
            afterResource.top - beforeResource.top + afterResource.height - beforeResource.height,
          ),
        ).toBeLessThanOrEqual(1);
      }
      await act(async () => {
        await frames();
        read().holdViewport();
        read().scrollToDistanceFromBottomPx(700, "instant");
        await frames();
      });
      const scroll = read().getScrollElement()!;
      const viewport = scroll.getBoundingClientRect();
      const leaf = [
        ...view.container.querySelectorAll<HTMLElement>(
          "[data-local-conversation-item-target-ids]",
        ),
      ].find(
        (node) =>
          node.getBoundingClientRect().top > viewport.top &&
          node.getBoundingClientRect().bottom < viewport.bottom,
      )!;
      expect(leaf).toBeDefined();
      const nativeId = leaf.dataset.localConversationItemTargetIds!;
      const before = leaf.getBoundingClientRect().top - viewport.top;
      const next = fixture(true, includeResources);
      await act(async () => {
        view.rerender(surface(next));
        await frames();
      });
      const current = view.container.querySelector<HTMLElement>(
        `[data-local-conversation-item-target-ids="${nativeId}"]`,
      )!;
      const after = current.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      expect(Math.abs(after - before)).toBeLessThanOrEqual(1);
      const distance = read().getLastScrollDistanceFromBottomPx();
      view.unmount();
      expect(saved.current).not.toBeNull();
      const reopenedFixture = fixture(true, includeResources);
      const restoreSnapshot = saved.current;
      const reopened = render(surface(reopenedFixture, restoreSnapshot, distance));
      try {
        await act(async () => {
          await frames(7);
        });
        const restored = reopened.container.querySelector<HTMLElement>(
          `[data-local-conversation-item-target-ids="${nativeId}"]`,
        )!;
        const restoredTop =
          restored.getBoundingClientRect().top -
          read().getScrollElement()!.getBoundingClientRect().top;
        expect(Math.abs(restoredTop - before)).toBeLessThanOrEqual(1);
        await act(async () => {
          await context.annotate("native voice work history anchor", "viewport geometry", {
            body: JSON.stringify({ nativeId, before, after, restoredTop, resourceGeometry }),
            bodyEncoding: "utf-8",
            contentType: "application/json",
          });
        });
      } finally {
        reopened.unmount();
      }
    } finally {
      view.unmount();
      disposeMaitaiStore(store);
    }
  },
);
