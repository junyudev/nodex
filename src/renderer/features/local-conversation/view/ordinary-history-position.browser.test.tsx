import { act, render, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import {
  CodexTranscriptReadOwnerContext,
  useCodexTranscriptStructure,
} from "../normalized-transcript-hooks";
import { selectNormalizedConversationTurnEntries } from "../normalized-transcript-selectors";
import { ordinarySparseHistoryFixture } from "../projection/ordinary-history-position.test-fixtures";
import { projectNormalizedTimelineEntries } from "../projection/normalized-timeline-entries";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
  type LocalConversationThreadScrollControllerValue,
} from "./local-conversation-thread-scroll-controller";
import {
  LocalConversationVirtualizedTurnList,
  type LocalConversationVirtualizedTurnListApi,
} from "./local-conversation-virtualized-turn-list";
import {
  createLocalConversationSearchSource,
  projectLocalConversationResidentSearchResult,
} from "./local-conversation-search-source";
import { createLocalConversationSearchHighlightOwner } from "./local-conversation-search-highlight-owner";
import type { LocalConversationSearchTarget } from "./local-conversation-persisted-search";
import "../../../globals.css";

const originalApi = window.api;
beforeEach(() => {
  window.api = {
    on: () => () => {},
    invoke: async (channel) =>
      channel === "persisted-atom:sync-request"
        ? { revision: 0, values: {} }
        : channel === "codex:app-server:request"
          ? { type: "result", result: { data: [], nextCursor: null } }
          : undefined,
  };
});
afterEach(() => {
  window.api = originalApi;
  vi.restoreAllMocks();
});
const frames = async () => {
  for (let index = 0; index < 3; index++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

describe("ordinary sparse history geometry", () => {
  test("keeps the search-to-tail gap in place and restores its nearer newer side with asc5", async () => {
    const fixture = ordinarySparseHistoryFixture();
    const store = createMaitaiStore();
    let controller: LocalConversationThreadScrollControllerValue | null = null;
    let api: LocalConversationVirtualizedTurnListApi | null = null;
    let enableBoundary: (() => void) | null = null;
    let initialReady = false;
    let firstAccepted = false;
    let releaseFirst = () => {};
    const heldFirst = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const loadBoundary: typeof fixture.loadBoundary = async (boundary) => {
      const status = await fixture.loadBoundary(boundary);
      if (!firstAccepted) {
        firstAccepted = true;
        await heldFirst;
      }
      return status;
    };
    function Thread() {
      const { owner, structure } = useCodexTranscriptStructure();
      const scroll = useLocalConversationThreadScrollController();
      const [enabled, setEnabled] = useState(false);
      useLayoutEffect(() => {
        controller = scroll;
        enableBoundary = () => setEnabled(true);
      });
      if (!owner || !structure) return null;
      const projected = projectNormalizedTimelineEntries({
        owner,
        structure,
        entries: selectNormalizedConversationTurnEntries({ owner, structure, conversation: null }),
      });
      return (
        <div style={{ width: 700, height: 600 }}>
          <LocalConversationThreadScrollLayout>
            <LocalConversationVirtualizedTurnList
              entries={[...projected.entries]}
              historyRows={projected.historyRows ?? undefined}
              conversationId="ordinary-history"
              threadCwd="/workspace"
              editableTurnIds={new Set()}
              canForkFromTurn={false}
              initialScrollOffset={0}
              initialRestoreState={null}
              initialLatestTurnRestoreState={null}
              onVisibleContentReady={() => {
                initialReady = true;
              }}
              onApiChange={(next) => {
                api = next;
              }}
              onLoadHistoryBoundary={enabled ? loadBoundary : undefined}
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
            <CodexTranscriptReadOwnerContext.Provider value={fixture.owner}>
              <EnsureLocalConversationThreadScrollController>
                <Thread />
              </EnsureLocalConversationThreadScrollController>
            </CodexTranscriptReadOwnerContext.Provider>
          </NodexTooltipProvider>
        </LocalConversationTestQueryProvider>
      </MaitaiProvider>,
    );
    const readController = () => {
      if (!controller) throw new Error("Missing scroll owner");
      return controller;
    };
    const readApi = () => {
      if (!api) throw new Error("Missing virtual list");
      return api;
    };
    const highlights = createLocalConversationSearchHighlightOwner({
      readRoot: () => view.container,
      resolveTarget: (match) => match.meta as LocalConversationSearchTarget,
    });
    try {
      await waitFor(() => expect(readController().getScrollElement()?.clientHeight).toBe(600));
      await waitFor(() => expect(initialReady).toBe(true));
      const source = createLocalConversationSearchSource({
        routeContextId: "thread",
        getTurns: () => [],
        getProjectedEntries: () => fixture.project().entries,
        readOwner: () => fixture.owner,
        scrollAdapter: {
          scrollToTurn: async (turnKey) => {
            await readApi().scrollToKey(turnKey);
          },
          getTurnContainer: () => null,
        },
      });
      const unit = source.findMatches("History target 44")[0]!;
      expect(unit).toMatchObject({
        key: "44:user:0",
        itemId: "user-44",
        turnKey: "history-content:search:window:8",
      });
      const placement = { promise: Promise.resolve() };
      await act(async () => {
        placement.promise = source.scrollAdapter.scrollToTurn(unit.turnKey);
        await Promise.resolve();
      });
      await placement.promise;
      await act(async () => {
        await frames();
      });
      const projected = fixture.project();
      const middle = projected.historyRows!.find(
        (row) => row.kind === "gap" && row.olderBoundary?.islandId === "search:window",
      );
      if (!middle || middle.kind !== "gap") throw new Error("Missing island gap");
      const gap = Array.from(
        view.container.querySelectorAll<HTMLElement>("[data-history-gap-key]"),
      ).find((element) => element.dataset.historyGapKey === middle.key);
      const searchRow = view.container.querySelector<HTMLElement>(
        `[data-turn-key="${unit.turnKey}"]`,
      );
      const tailRow = view.container.querySelector<HTMLElement>(
        '[data-turn-key="history-content:turn:90"]',
      );
      expect(gap).toBeTruthy();
      expect(searchRow).toBeTruthy();
      expect(tailRow).toBeTruthy();
      expect(gap!.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        searchRow!.getBoundingClientRect().bottom,
      );
      expect(gap!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
        tailRow!.getBoundingClientRect().top,
      );
      expect(gap!.getBoundingClientRect().height).toBe(144);
      const result = projectLocalConversationResidentSearchResult({
        units: [unit],
        query: "History target 44",
        contextId: "thread",
        limit: 250,
      });
      await act(async () => {
        highlights.publishResult(result, result.matches[0]!.id);
        readController().scrollElementIntoView(
          highlights.readActiveMatch(result.matches[0]!.id)!,
          "instant",
          "center",
        );
        await frames();
      });
      const target = view.container.querySelector<HTMLElement>(
        '[data-content-search-unit-key="44:user:0"]',
      )!;
      const viewport = readController().getScrollElement()!.getBoundingClientRect();
      const beforeTop = target.getBoundingClientRect().top;
      const beforeScrollTop = readController().getScrollElement()!.scrollTop;
      const nativeWrites = vi.spyOn(readController().getScrollElement()!, "scrollTo");
      expect(beforeTop).toBeGreaterThan(viewport.top);
      expect(beforeTop).toBeLessThan(viewport.bottom);
      expect(gap!.getBoundingClientRect().top - viewport.bottom).toBeLessThanOrEqual(800);
      await act(async () => {
        if (!enableBoundary) throw new Error("Missing boundary admission");
        enableBoundary();
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(source.findMatches("History target 45")).toMatchObject([
          { key: "45:user:0", itemId: "user-45" },
        ]),
      );
      await act(async () => {
        await frames();
      });
      expect(firstAccepted).toBe(true);
      expect(fixture.calls.filter((call) => call.method === "thread/turns/list")).toHaveLength(1);
      expect(target.isConnected).toBe(true);
      expect(view.container.querySelector('[data-content-search-unit-key="44:user:0"]')).toBe(
        target,
      );
      expect(nativeWrites).toHaveBeenCalled();
      expect(readController().getScrollElement()!.scrollTop).toBeLessThan(beforeScrollTop);
      expect(Math.abs(target.getBoundingClientRect().top - beforeTop)).toBeLessThanOrEqual(1);
      await act(async () => {
        releaseFirst();
        await Promise.resolve();
      });
      const turnCalls = fixture.calls.filter((call) => call.method === "thread/turns/list");
      expect(turnCalls[0]).toEqual({
        method: "thread/turns/list",
        params: {
          threadId: "ordinary-history",
          cursor: "after:44",
          limit: 5,
          itemsView: "notLoaded",
          sortDirection: "asc",
        },
      });
      expect(
        turnCalls.every(
          (call) =>
            typeof call.params === "object" &&
            call.params !== null &&
            "limit" in call.params &&
            call.params.limit === 5,
        ),
      ).toBe(true);
      await act(async () => {
        await frames();
      });
      expect(target.isConnected).toBe(true);
      expect(view.container.querySelector('[data-content-search-unit-key="44:user:0"]')).toBe(
        target,
      );
      expect(Math.abs(target.getBoundingClientRect().top - beforeTop)).toBeLessThanOrEqual(1);
    } finally {
      releaseFirst();
      highlights.clear();
      view.unmount();
      disposeMaitaiStore(store);
      fixture.dispose();
    }
  });
});
