import { act, render, waitFor, fireEvent } from "@testing-library/react";
import { useLayoutEffect, useState, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { createMaitaiStore, disposeMaitaiStore, MaitaiProvider } from "@/lib/maitai";
import {
  CodexTranscriptReadOwnerContext,
  useCodexTranscriptStructure,
} from "../normalized-transcript-hooks";
import { selectNormalizedConversationTurnEntries } from "../normalized-transcript-selectors";
import { ordinarySparseHistoryFixture } from "../projection/ordinary-history-position.test-fixtures";
import {
  projectNormalizedTimelineEntries,
  type CodexTimelineViewEntry,
} from "../projection/normalized-timeline-entries";
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
import { timelineOwnerFixture } from "../projection/normalized-timeline.test-fixtures";
import type { VirtualizedTurnListRestoreState } from "./local-conversation-turn-virtualization";
import type { ThreadItem, ThreadTimelineListResponse } from "@nodex/codex-app-server-protocol/v2";

describe("ordinary history position", () => {
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
          entries: selectNormalizedConversationTurnEntries({
            owner,
            structure,
            conversation: null,
          }),
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
        await waitFor(() => placement.promise);
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
        // Newer history fills in below the reader, so their native position needs no write.
        expect(
          Math.abs(readController().getScrollElement()!.scrollTop - beforeScrollTop),
        ).toBeLessThanOrEqual(1);
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
});

describe("local conversation realtime transcript", () => {
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
                editableTurnIds={new Set()}
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
        expect(
          Math.abs(retainedLeaf.getBoundingClientRect().top - afterPrepend),
        ).toBeLessThanOrEqual(1);
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
});

describe("local conversation voice work", () => {
  const originalApi = window.api;
  beforeEach(() => {
    window.api = {
      on: () => () => {},
      invoke: async (channel, ...args) =>
        channel === "persisted-atom:sync-request"
          ? { revision: 0, values: {} }
          : channel === "workspace-path-states"
            ? {
                states: (args[0] as { paths: string[] }).paths.map((path) => ({
                  path,
                  exists: true,
                  isGitSourcePath: null,
                })),
              }
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
        moderation: null,
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
                editableTurnIds={new Set()}
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
});
