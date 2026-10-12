import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import { CodexTranscriptReadOwnerContext } from "../normalized-transcript-hooks";
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import type { CodexTimelineViewEntry } from "../projection/normalized-timeline-entries";
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
    invoke: async (channel) =>
      channel === "persisted-atom:sync-request" ? { revision: 0, values: {} } : undefined,
  };
});
afterEach(() => {
  window.api = originalApi;
});

function fixture(ids: readonly string[]) {
  return timelineOwnerFixture({
    data: ids.map((id, position) => ({
      type: "realtime",
      position,
      item: {
        type: "transcriptSegment",
        id,
        realtimeSessionId: "session",
        role: "assistant",
        text: `${id} visible native paragraph.\n\n`.repeat(8),
      },
    })),
    nextCursor: null,
    activeRealtimeSessionAtPageStart: "session",
  });
}

const settleFrames = async (count = 3) => {
  for (let index = 0; index < count; index += 1)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

describe("continuous voice row geometry", () => {
  test("keeps the resident native leaf fixed when a prepend renames its row and adds a suffix", async (context) => {
    const first = fixture(["first", "second", "third", "fourth"]);
    const store = createMaitaiStore();
    let controller: LocalConversationThreadScrollControllerValue | null = null;
    const restore = { current: null as VirtualizedTurnListRestoreState | null };
    const onRestore = (value: VirtualizedTurnListRestoreState | null) => {
      restore.current = value;
    };
    function Thread({
      entries,
      initialRestoreState = null,
      initialScrollOffset = 0,
    }: {
      readonly entries: readonly CodexTimelineViewEntry[];
      readonly initialRestoreState?: VirtualizedTurnListRestoreState | null;
      readonly initialScrollOffset?: number;
    }) {
      const scroll = useLocalConversationThreadScrollController();
      useLayoutEffect(() => {
        controller = scroll;
      });
      return (
        <div style={{ width: 650, height: 420 }}>
          <LocalConversationThreadScrollLayout>
            <LocalConversationVirtualizedTurnList
              entries={[...entries]}
              conversationId="voice-thread"
              threadCwd={null}
              editableTurnId={null}
              canForkFromTurn={false}
              initialScrollOffset={initialScrollOffset}
              initialRestoreState={initialRestoreState}
              scrollElement={scroll.scrollElement}
              onRestoreStateChange={onRestore}
            />
          </LocalConversationThreadScrollLayout>
        </div>
      );
    }
    const readController = () => {
      if (!controller) throw new Error("missing scroll owner");
      return controller;
    };
    function Providers({
      children,
      owner = first.owner,
    }: {
      readonly children: ReactNode;
      readonly owner?: typeof first.owner;
    }) {
      return (
        <MaitaiProvider store={store}>
          <LocalConversationTestQueryProvider>
            <NodexTooltipProvider>
              <CodexTranscriptReadOwnerContext.Provider value={owner}>
                <EnsureLocalConversationThreadScrollController>
                  {children}
                </EnsureLocalConversationThreadScrollController>
              </CodexTranscriptReadOwnerContext.Provider>
            </NodexTooltipProvider>
          </LocalConversationTestQueryProvider>
        </MaitaiProvider>
      );
    }
    const view = render(
      <Providers>
        <Thread entries={first.project().entries} />
      </Providers>,
    );
    try {
      await waitFor(() => expect(readController().getScrollElement()?.clientHeight).toBe(420));
      await act(async () => {
        await settleFrames();
        readController().holdViewport();
        readController().scrollToDistanceFromBottomPx(260, "instant");
        await settleFrames();
      });
      const scroll = readController().getScrollElement()!;
      const viewport = scroll.getBoundingClientRect();
      const leaf = Array.from(
        view.container.querySelectorAll<HTMLElement>("[data-native-realtime-item-id]"),
      ).find(
        (node) =>
          node.getBoundingClientRect().bottom > viewport.top &&
          node.getBoundingClientRect().top < viewport.bottom,
      )!;
      expect(leaf).toBeDefined();
      const itemId = leaf.dataset.nativeRealtimeItemId!;
      const before = leaf.getBoundingClientRect().top;
      const next = fixture(["older", "first", "second", "third", "fourth", "suffix"]);
      await act(async () => {
        view.rerender(
          <Providers owner={next.owner}>
            <Thread entries={next.project().entries} />
          </Providers>,
        );
        await settleFrames(5);
      });
      const afterLeaf = Array.from(
        view.container.querySelectorAll<HTMLElement>("[data-native-realtime-item-id]"),
      ).find((node) => node.dataset.nativeRealtimeItemId === itemId)!;
      expect(view.container.querySelectorAll("[data-thread-turn-id]")).toHaveLength(1);
      expect(Math.abs(afterLeaf.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
      const afterPrepend = afterLeaf.getBoundingClientRect().top;
      const orderedIds = ["older", "first", "second", "third", "fourth", "suffix"];
      const retainedIds = orderedIds.slice(orderedIds.indexOf(itemId));
      const retained = fixture(retainedIds);
      await act(async () => {
        view.rerender(
          <Providers owner={retained.owner}>
            <Thread entries={retained.project().entries} />
          </Providers>,
        );
        await settleFrames(5);
      });
      const retainedLeaf = Array.from(
        view.container.querySelectorAll<HTMLElement>("[data-native-realtime-item-id]"),
      ).find((node) => node.dataset.nativeRealtimeItemId === itemId)!;
      expect(Math.abs(retainedLeaf.getBoundingClientRect().top - afterPrepend)).toBeLessThanOrEqual(
        1,
      );
      await act(async () => {
        await context.annotate("resident voice segment remains anchored", "viewport geometry", {
          body: JSON.stringify({
            itemId,
            before,
            afterPrepend,
            afterRelease: retainedLeaf.getBoundingClientRect().top,
            scrollTop: scroll.scrollTop,
          }),
          bodyEncoding: "utf-8",
          contentType: "application/json",
        });
      });
      const distanceBeforeClose = readController().getLastScrollDistanceFromBottomPx();
      const positionBeforeClose =
        retainedLeaf.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
      view.unmount();
      expect(restore.current?.renderedWindow.realtimeSegmentIds).toContain(itemId);
      expect(restore.current?.realtimeAnchor?.itemId).toBe(itemId);
      const saved = restore.current;
      const reopened = fixture(["restored-prefix", ...retainedIds, "restored-suffix"]);
      const restoredView = render(
        <Providers owner={reopened.owner}>
          <Thread
            entries={reopened.project().entries}
            initialRestoreState={saved}
            initialScrollOffset={distanceBeforeClose}
          />
        </Providers>,
      );
      try {
        await act(async () => {
          await settleFrames(5);
        });
        const restoredLeaf = Array.from(
          restoredView.container.querySelectorAll<HTMLElement>("[data-native-realtime-item-id]"),
        ).find((node) => node.dataset.nativeRealtimeItemId === itemId)!;
        const restoredPosition =
          restoredLeaf.getBoundingClientRect().top -
          readController().getScrollElement()!.getBoundingClientRect().top;
        expect(Math.abs(restoredPosition - positionBeforeClose)).toBeLessThanOrEqual(1);
      } finally {
        restoredView.unmount();
      }
    } finally {
      view.unmount();
      disposeMaitaiStore(store);
    }
  });
});
