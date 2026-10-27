import { afterEach, describe, expect, test } from "vite-plus/test";
import { act } from "@testing-library/react";
import { startTransition, Suspense, useLayoutEffect, useState, type ReactNode } from "react";
import { NodexTooltipProvider } from "../../../components/ui/tooltip";
import { createMaitaiStore, MaitaiProvider } from "../../../lib/maitai";
import { render } from "../../../test/dom";
import type { CodexConversationItem, CodexConversationTurn } from "../../../lib/types";
import type { CodexHistoryRow } from "../../../../shared/codex-conversation-state/codex-history-topology";
import {
  EnsureLocalConversationThreadScrollController,
  LocalConversationThreadScrollLayout,
  useLocalConversationThreadScrollController,
} from "./local-conversation-thread-scroll-controller";
import {
  applyLocalConversationTurnMeasurementEffect,
  LocalConversationVirtualizedTurnList,
  type LocalConversationVirtualizedTurnListEntry,
  type LocalConversationVirtualizedTurnListApi,
} from "./local-conversation-virtualized-turn-list";
import { createThreadResponseSpaceController } from "./local-conversation-response-space";
import type { VisibleConversationTurnEntry } from "../selectors";
import type { CodexHistoryViewportBoundary } from "../../../../shared/codex-history-policy";
import type {
  VirtualizedLatestTurnRestoreState,
  VirtualizedTurnListRestoreState,
} from "./local-conversation-turn-virtualization";
import { LocalConversationTestQueryProvider } from "./local-conversation-test-query.test-fixtures";

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
const originalGetClientRects = HTMLElement.prototype.getClientRects;
const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;

function TooltipProvider({ children }: { readonly children: ReactNode }) {
  const [store] = useState(() => createMaitaiStore());
  return (
    <MaitaiProvider store={store}>
      <LocalConversationTestQueryProvider>
        <NodexTooltipProvider>{children}</NodexTooltipProvider>
      </LocalConversationTestQueryProvider>
    </MaitaiProvider>
  );
}

function MountedViewport({ children }: { readonly children: ReactNode }) {
  const { scrollElement } = useLocalConversationThreadScrollController();
  return (
    <LocalConversationThreadScrollLayout>
      {scrollElement ? children : null}
    </LocalConversationThreadScrollLayout>
  );
}

function makeRect(input: Partial<DOMRectReadOnly>): DOMRect {
  const left = input.left ?? 0;
  const top = input.top ?? 0;
  const width = input.width ?? 0;
  const height = input.height ?? 0;
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function installQueuedRequestAnimationFrame(): void {
  let nextFrameId = 1;
  const callbacks = new Map<number, FrameRequestCallback>();
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: ((callback: FrameRequestCallback) => {
      const frameId = nextFrameId;
      nextFrameId += 1;
      callbacks.set(frameId, callback);
      return frameId;
    }) as typeof globalThis.requestAnimationFrame,
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: ((frameId: number) => {
      callbacks.delete(frameId);
    }) as typeof globalThis.cancelAnimationFrame,
  });
}

function installTurnBlockSizes(
  heightsByTurnKey: Readonly<Record<string, number>>,
  viewportVisible = true,
): void {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      if (this.dataset.localConversationThreadBody === "true")
        return makeRect({ height: 600, width: 640 });
      const turnKey = this.getAttribute("data-turn-key");
      if (turnKey && Object.prototype.hasOwnProperty.call(heightsByTurnKey, turnKey)) {
        return makeRect({
          height: heightsByTurnKey[turnKey],
          width: 640,
        });
      }
      return originalGetBoundingClientRect.call(this);
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    writable: true,
    value(this: HTMLElement) {
      const bounds = this.getBoundingClientRect();
      const visible =
        this.dataset.localConversationThreadBody === "true"
          ? viewportVisible
          : bounds.width > 0 && bounds.height > 0;
      const rects = visible ? [bounds] : [];
      return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
    },
  });
}

function restoreBrowserGeometry(): void {
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    writable: true,
    value: originalGetBoundingClientRect,
  });
  Object.defineProperty(HTMLElement.prototype, "getClientRects", {
    configurable: true,
    writable: true,
    value: originalGetClientRects,
  });
  if (originalRequestAnimationFrame) {
    Object.defineProperty(globalThis, "requestAnimationFrame", {
      configurable: true,
      writable: true,
      value: originalRequestAnimationFrame,
    });
  } else {
    Reflect.deleteProperty(
      globalThis as typeof globalThis & { requestAnimationFrame?: typeof requestAnimationFrame },
      "requestAnimationFrame",
    );
  }
  if (originalCancelAnimationFrame) {
    Object.defineProperty(globalThis, "cancelAnimationFrame", {
      configurable: true,
      writable: true,
      value: originalCancelAnimationFrame,
    });
  } else {
    Reflect.deleteProperty(
      globalThis as typeof globalThis & { cancelAnimationFrame?: typeof cancelAnimationFrame },
      "cancelAnimationFrame",
    );
  }
}

function buildAssistantEntry(input: {
  itemId: string;
  markdownText: string;
  turnId: string;
}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: input.turnId,
    itemId: input.itemId,
    entryId: input.itemId,
    type: "assistant_message",
    kind: "assistantMessage",
    semanticKind: "assistantMessage",
    role: "assistant",
    markdownText: input.markdownText,
    createdAt: 2,
    updatedAt: 2,
  };
}

function buildUserEntry(input: {
  itemId: string;
  markdownText: string;
  turnId: string;
}): CodexConversationItem {
  return {
    threadId: "thread_1",
    turnId: input.turnId,
    itemId: input.itemId,
    entryId: input.itemId,
    type: "user_message",
    kind: "userMessage",
    semanticKind: "userMessage",
    role: "user",
    markdownText: input.markdownText,
    createdAt: 1,
    updatedAt: 1,
  };
}

function buildTurnEntry(input: {
  assistantText: string;
  index: number;
  isMostRecentTurn: boolean;
}): VisibleConversationTurnEntry {
  const turnId = `turn_${input.index}`;
  const userItemId = `user_${input.index}`;
  const assistantItemId = `assistant_${input.index}`;
  const turn: CodexConversationTurn = {
    threadId: "thread_1",
    turnId,
    status: "completed",
    itemIds: [userItemId, assistantItemId],
    items: [
      buildUserEntry({
        itemId: userItemId,
        markdownText: `Request ${input.index}`,
        turnId,
      }),
      buildAssistantEntry({
        itemId: assistantItemId,
        markdownText: input.assistantText,
        turnId,
      }),
    ],
  };
  return {
    turn,
    turnId,
    turnKey: turnId,
    turnSearchKey: turnId,
    requests: [],
    isMostRecentTurn: input.isMostRecentTurn,
  };
}

function buildTurnEntries(texts: readonly string[]): VisibleConversationTurnEntry[] {
  return texts.map((assistantText, index) =>
    buildTurnEntry({
      assistantText,
      index: index + 1,
      isMostRecentTurn: index === texts.length - 1,
    }),
  );
}

function renderVirtualizedTurnList(input: {
  entries: LocalConversationVirtualizedTurnListEntry[];
  withViewport?: boolean;
  historyRows?: readonly CodexHistoryRow[];
  initialScrollOffset?: number;
  initialLatestTurnRestoreState?: VirtualizedLatestTurnRestoreState;
  onLatestTurnRestoreStateChange?: (
    state: VirtualizedLatestTurnRestoreState | null,
    distanceFromBottomPx: number,
  ) => void;
  onRestoreStateChange?: (state: VirtualizedTurnListRestoreState | null) => void;
  onApiChange?: (api: LocalConversationVirtualizedTurnListApi | null) => void;
  onHistoryRetentionBoundaryChange?: (
    boundary: CodexHistoryViewportBoundary | null | undefined,
  ) => void;
}) {
  const list = (
    <LocalConversationVirtualizedTurnList
      entries={input.entries}
      historyRows={input.historyRows}
      conversationId="thread_1"
      threadCwd="/tmp/project"
      editableTurnIds={new Set()}
      canForkFromTurn={true}
      initialScrollOffset={input.initialScrollOffset}
      initialLatestTurnRestoreState={input.initialLatestTurnRestoreState}
      onLatestTurnRestoreStateChange={input.onLatestTurnRestoreStateChange}
      onRestoreStateChange={input.onRestoreStateChange}
      onApiChange={input.onApiChange}
      onHistoryRetentionBoundaryChange={input.onHistoryRetentionBoundaryChange}
      scrollElement={null}
    />
  );
  return render(
    <TooltipProvider>
      <EnsureLocalConversationThreadScrollController>
        {input.withViewport ? <MountedViewport>{list}</MountedViewport> : list}
      </EnsureLocalConversationThreadScrollController>
    </TooltipProvider>,
  );
}

function hasFixedHeightClippingAncestor(element: Element): boolean {
  let current = element.parentElement;
  while (current) {
    if (
      current instanceof HTMLElement &&
      current.style.height === "280px" &&
      current.style.overflow === "hidden"
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

describe("turn measurement compensation phases", () => {
  test("applies the captured native anchor after the latest-turn follow callback", () => {
    const fixture = createMeasurementResponseSpace();
    applyLocalConversationTurnMeasurementEffect({
      effect: {
        latestTurnHeightChange: {
          bottomViewportOverflowPx: 708,
          followContentHeightPx: null,
          heightDeltaPx: 1000,
          heightPx: 1320,
          turnElement: null,
        },
        nativeScrollDistanceFromBottomPx: 708,
        restoreScrollDistanceFromBottom: false,
      },
      getResponseSpacerHeightPx: fixture.space.getHeightPx,
      onLatestTurnHeightChange: () => {
        fixture.compensate(0);
      },
      restoreScrollDistanceFromBottomPx: () => {
        throw new Error("Following already owns native placement.");
      },
      compensateScrollToDistanceFromBottomPx: fixture.compensate,
    });
    expect(fixture.writes).toEqual([0, 708]);
  });

  test("uses application-time response space when placement changes after measurement capture", () => {
    const fixture = createMeasurementResponseSpace();
    // Capture a native measurement target while no submit placement space exists.
    const nativeTargetPx = 32;
    expect(fixture.space.getHeightPx()).toBe(0);
    fixture.space.place();
    expect(fixture.space.getHeightPx()).toBe(360);
    fixture.writes.length = 0;

    applyLocalConversationTurnMeasurementEffect({
      effect: {
        latestTurnHeightChange: {
          bottomViewportOverflowPx: 0,
          followContentHeightPx: null,
          heightDeltaPx: 32,
          heightPx: 132,
          turnElement: null,
        },
        nativeScrollDistanceFromBottomPx: nativeTargetPx,
        restoreScrollDistanceFromBottom: false,
      },
      getResponseSpacerHeightPx: fixture.space.getHeightPx,
      onLatestTurnHeightChange: ({ heightDeltaPx }) => {
        fixture.space.consumeGrowth(heightDeltaPx ?? 0);
      },
      restoreScrollDistanceFromBottomPx: () => {
        throw new Error("Unexpected history restore.");
      },
      compensateScrollToDistanceFromBottomPx: fixture.compensate,
    });

    expect(fixture.space.getHeightPx()).toBe(328);
    // Native target + post-callback space - application-time space = 32 + 328 - 360.
    expect(fixture.writes).toEqual([0]);
  });

  test("restores through the history owner after the height callback without a second compensation", () => {
    const fixture = createMeasurementResponseSpace();
    fixture.space.place();
    fixture.writes.length = 0;
    applyLocalConversationTurnMeasurementEffect({
      effect: {
        latestTurnHeightChange: {
          bottomViewportOverflowPx: 0,
          followContentHeightPx: null,
          heightDeltaPx: 32,
          heightPx: 132,
          turnElement: null,
        },
        nativeScrollDistanceFromBottomPx: 999,
        restoreScrollDistanceFromBottom: true,
      },
      getResponseSpacerHeightPx: fixture.space.getHeightPx,
      onLatestTurnHeightChange: ({ heightDeltaPx }) => {
        fixture.space.consumeGrowth(heightDeltaPx ?? 0);
      },
      restoreScrollDistanceFromBottomPx: () => {
        expect(fixture.space.getHeightPx()).toBe(328);
        fixture.compensate(17);
      },
      compensateScrollToDistanceFromBottomPx: () => {
        throw new Error("History restore already owns native placement.");
      },
    });
    expect(fixture.writes).toEqual([17]);
  });
});

function createMeasurementResponseSpace() {
  const viewport = document.createElement("div");
  Object.defineProperties(viewport, {
    clientHeight: { value: 600 },
    scrollHeight: { value: 2_000 },
  });
  const writes: number[] = [];
  let nativeDistance = 0;
  const compensate = (distance: number) => {
    nativeDistance = distance;
    writes.push(distance);
  };
  const scroll = {
    getScrollElement: () => viewport,
    getScrollDistanceFromBottomPx: () => nativeDistance,
    getLastScrollDistanceFromBottomPx: () => nativeDistance,
    getUnroundedScrollDistanceFromBottomPx: (fallback: number) => fallback,
    compensateScrollToDistanceFromBottomPx: compensate,
    scrollToDistanceFromBottomPx: compensate,
    holdViewport: () => {},
  };
  const space = createThreadResponseSpaceController(scroll);
  space.updateContext(scroll, true);
  return { space, writes, compensate };
}

describe("LocalConversationVirtualizedTurnList", () => {
  test("cancels pending navigation without waiting for a frame and releases viewer protection", async () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({ turn_1: 300 });
    let api: LocalConversationVirtualizedTurnListApi | null = null;
    const boundaries: Array<CodexHistoryViewportBoundary | null | undefined> = [];
    const view = renderVirtualizedTurnList({
      entries: buildTurnEntries(["Answer"]),
      onApiChange: (value) => {
        api = value;
      },
      onHistoryRetentionBoundaryChange: (boundary) => boundaries.push(boundary),
    });
    const currentApi = api as LocalConversationVirtualizedTurnListApi | null;
    if (!currentApi) throw new Error("missing virtualizer API");
    const alreadyCancelled = new AbortController();
    alreadyCancelled.abort();
    await currentApi.scrollToKey("turn_1", undefined, { signal: alreadyCancelled.signal });
    const controller = new AbortController();
    await act(async () => {
      const pending = currentApi.scrollToKey("turn_1", undefined, { signal: controller.signal });
      controller.abort();
      await pending;
      await Promise.resolve();
    });
    expect(boundaries).toContain(null);
    view.unmount();
    expect(boundaries.at(-1)).toBeUndefined();
  });
  afterEach(() => {
    restoreBrowserGeometry();
  });

  test("renders mounted older turns without fixed-height overflow clipping while unmeasured", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({});
    const view = renderVirtualizedTurnList({
      entries: buildTurnEntries([
        "Tall assistant answer that should remain fully visible before measurement.",
        "Second assistant answer.",
        "Latest assistant answer.",
      ]),
    });

    const tallContent = view.getByText(
      "Tall assistant answer that should remain fully visible before measurement.",
    );

    expect(hasFixedHeightClippingAncestor(tallContent)).toBe(false);
    view.unmount();
  });

  test("renders an inert 144px history row ahead of loaded turns", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({});
    const entries = buildTurnEntries(["Older loaded answer.", "Latest loaded answer."]);
    const gap: CodexHistoryRow = {
      kind: "gap",
      key: "history-gap:older",
      olderBoundary: null,
      newerBoundary: null,
      estimatedHeightPx: 144,
    };
    const view = renderVirtualizedTurnList({
      entries,
      historyRows: [
        gap,
        {
          kind: "content",
          key: "history-content:turn_1",
          turnKey: "turn_1",
          entityKey: "turn_1",
        },
        {
          kind: "content",
          key: "history-content:turn_2",
          turnKey: "turn_2",
          entityKey: "turn_2",
        },
      ],
    });

    const gapElement = [
      ...view.container.querySelectorAll<HTMLElement>("[aria-hidden='true']"),
    ].find((element) => element.style.height === "144px");
    const firstTurn = view.container.querySelector<HTMLElement>("[data-turn-key='turn_1']");

    expect(gapElement).toBeTruthy();
    expect(
      gapElement && firstTurn
        ? gapElement.compareDocumentPosition(firstTurn) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).not.toBe(0);
    view.unmount();
  });

  test("commits initial mounted turn measurements before the animation frame", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({
      turn_1: 96,
      turn_2: 112,
      turn_3: 128,
    });
    const restoreStateRef: { current: VirtualizedTurnListRestoreState | null } = { current: null };
    const view = renderVirtualizedTurnList({
      entries: buildTurnEntries([
        "Short assistant answer.",
        "Another short assistant answer.",
        "Latest short assistant answer.",
      ]),
      onRestoreStateChange: (state) => {
        restoreStateRef.current = state;
      },
    });

    view.unmount();

    expect(restoreStateRef.current?.turnHeightsByKey.turn_1 ?? 0).toBe(96);
    expect(restoreStateRef.current?.turnHeightsByKey.turn_2 ?? 0).toBe(112);
    expect(restoreStateRef.current?.turnHeightsByKey.turn_3 ?? 0).toBe(128);
  });

  test.each([true, false])(
    "accepts native viewport measurements only while its rendered box is visible: %s",
    (visible) => {
      installQueuedRequestAnimationFrame();
      installTurnBlockSizes({ turn_1: 96 }, visible);
      let restored: VirtualizedTurnListRestoreState | null = null;
      const view = renderVirtualizedTurnList({
        entries: buildTurnEntries(["Measured answer"]),
        withViewport: true,
        onRestoreStateChange: (state) => {
          restored = state;
        },
      });
      view.unmount();
      const snapshot = restored as VirtualizedTurnListRestoreState | null;
      expect(snapshot?.turnHeightsByKey.turn_1).toBe(visible ? 96 : undefined);
    },
  );

  test("captures the complete running latest-turn restore state during layout cleanup", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({ turn_1: 480 });
    const entries = buildTurnEntries(["Working on the task."]);
    const latestEntry = entries[0];
    if (!latestEntry) throw new Error("expected latest entry");
    latestEntry.turn = {
      ...latestEntry.turn,
      status: "inProgress",
      firstTurnWorkItemStartedAtMs: 10,
      items: latestEntry.turn.items.map((item) =>
        item.kind === "assistantMessage" ? { ...item, assistantPhase: "commentary" } : item,
      ),
    };
    let captured: {
      state: VirtualizedLatestTurnRestoreState | null;
      distanceFromBottomPx: number;
    } | null = null;
    const view = renderVirtualizedTurnList({
      entries,
      initialScrollOffset: 120,
      initialLatestTurnRestoreState: {
        followMode: "prework_watch",
        isLatestTurnInProgress: true,
        latestTurnFollowContentHeightPx: 320,
        latestTurnHeightPx: 480,
        latestTurnPhase: "prework",
        turnKey: "turn_1",
      },
      onLatestTurnRestoreStateChange: (state, distanceFromBottomPx) => {
        captured = { state, distanceFromBottomPx };
      },
    });

    view.unmount();

    expect(captured).toEqual({
      distanceFromBottomPx: 0,
      state: {
        followMode: "prework_watch",
        isLatestTurnInProgress: true,
        latestTurnFollowContentHeightPx: 320,
        latestTurnHeightPx: 480,
        latestTurnPhase: "prework",
        turnKey: "turn_1",
      },
    });
  });

  test.each([
    ["prework", "prework_follow"],
    ["final_answer", "user_follow"],
  ] as const)("resumes active %s near the bottom with %s", (phase, followMode) => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({ turn_1: 480 });
    const latest = buildTurnEntries(["Work is still running."])[0]!;
    latest.turn = {
      ...latest.turn,
      status: "inProgress",
      firstTurnWorkItemStartedAtMs: 10,
      items: latest.turn.items.map((item) =>
        item.kind === "assistantMessage"
          ? { ...item, assistantPhase: phase === "prework" ? "commentary" : "final_answer" }
          : item,
      ),
    };
    let captured: VirtualizedLatestTurnRestoreState | null = null;
    const view = renderVirtualizedTurnList({
      entries: [latest],
      initialScrollOffset: 0,
      initialLatestTurnRestoreState: {
        followMode: "static",
        isLatestTurnInProgress: true,
        latestTurnFollowContentHeightPx: 320,
        latestTurnHeightPx: 480,
        latestTurnPhase: phase,
        turnKey: "turn_1",
      },
      onLatestTurnRestoreStateChange: (state) => {
        captured = state;
      },
    });
    view.unmount();
    expect(captured).toMatchObject({
      followMode,
      isLatestTurnInProgress: true,
      latestTurnPhase: phase,
      latestTurnHeightPx: null,
      turnKey: "turn_1",
    });
  });

  test("keeps restore metadata on the committed turn when a later render suspends", async () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({ turn_1: 480, turn_2: 480 });
    const initial = buildTurnEntry({
      assistantText: "Committed answer",
      index: 1,
      isMostRecentTurn: true,
    });
    initial.turn = {
      ...initial.turn,
      status: "inProgress",
      firstTurnWorkItemStartedAtMs: 10,
      items: initial.turn.items.map((item) =>
        item.kind === "assistantMessage" ? { ...item, assistantPhase: "commentary" } : item,
      ),
    };
    const pending = buildTurnEntry({
      assistantText: "Suspended answer",
      index: 2,
      isMostRecentTurn: true,
    });
    const forever = new Promise<never>(() => {});
    let attempted = false;
    function PendingSibling({ suspend }: { readonly suspend: boolean }) {
      if (!suspend) return null;
      attempted = true;
      throw forever;
    }
    let update: (() => void) | null = null;
    let captured: VirtualizedLatestTurnRestoreState | null = null;
    function Fixture() {
      const [suspend, setSuspend] = useState(false);
      useLayoutEffect(() => {
        update = () => setSuspend(true);
        return () => {
          update = null;
        };
      }, []);
      return (
        <Suspense fallback={<div>Loading pending render</div>}>
          <LocalConversationVirtualizedTurnList
            entries={[suspend ? pending : initial]}
            conversationId="thread_1"
            threadCwd="/tmp/project"
            editableTurnIds={new Set()}
            canForkFromTurn={true}
            initialLatestTurnRestoreState={{
              followMode: "prework_watch",
              isLatestTurnInProgress: true,
              latestTurnFollowContentHeightPx: 320,
              latestTurnHeightPx: 480,
              latestTurnPhase: "prework",
              turnKey: "turn_1",
            }}
            onLatestTurnRestoreStateChange={(state) => {
              captured = state;
            }}
            scrollElement={null}
          />
          <PendingSibling suspend={suspend} />
        </Suspense>
      );
    }
    const view = render(
      <TooltipProvider>
        <EnsureLocalConversationThreadScrollController>
          <Fixture />
        </EnsureLocalConversationThreadScrollController>
      </TooltipProvider>,
    );
    await act(async () => {
      if (!update) throw new Error("missing fixture control");
      startTransition(update);
      await Promise.resolve();
    });
    expect(attempted).toBe(true);
    expect(view.queryByText("Loading pending render")).toBeNull();
    expect(view.getByText("Committed answer")).toBeTruthy();
    view.unmount();
    expect(captured).toMatchObject({
      turnKey: "turn_1",
      isLatestTurnInProgress: true,
      latestTurnPhase: "prework",
    });
  });

  test("restores running native follow state when a realtime row remains at the list tail", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({ turn_1: 480, "realtime:closed": 80 });
    const native = buildTurnEntries(["Working on the task."])[0]!;
    native.turn = {
      ...native.turn,
      status: "inProgress",
      firstTurnWorkItemStartedAtMs: 10,
      items: native.turn.items.map((item) =>
        item.kind === "assistantMessage" ? { ...item, assistantPhase: "commentary" } : item,
      ),
    };
    let captured: VirtualizedLatestTurnRestoreState | null = null;
    const view = renderVirtualizedTurnList({
      entries: [
        native,
        {
          type: "realtime",
          itemId: "closed",
          itemType: "realtimeSessionClosed",
          turnKey: "realtime:closed",
          turnSearchKey: "realtime:closed",
          turnId: null,
        },
      ],
      initialScrollOffset: 120,
      initialLatestTurnRestoreState: {
        followMode: "prework_watch",
        isLatestTurnInProgress: true,
        latestTurnFollowContentHeightPx: 320,
        latestTurnHeightPx: 480,
        latestTurnPhase: "prework",
        turnKey: "turn_1",
      },
      onLatestTurnRestoreStateChange: (state) => {
        captured = state;
      },
    });
    view.unmount();
    expect(captured).toMatchObject({
      turnKey: "turn_1",
      isLatestTurnInProgress: true,
      latestTurnPhase: "prework",
      followMode: "prework_watch",
    });
  });

  test("ignores zero-height initial mounted measurements", () => {
    installQueuedRequestAnimationFrame();
    installTurnBlockSizes({
      turn_1: 0,
      turn_2: 0,
      turn_3: 0,
    });
    const restoreStateRef: { current: VirtualizedTurnListRestoreState | null } = { current: null };
    const view = renderVirtualizedTurnList({
      entries: buildTurnEntries([
        "Zero-height assistant answer.",
        "Second zero-height assistant answer.",
        "Latest zero-height assistant answer.",
      ]),
      onRestoreStateChange: (state) => {
        restoreStateRef.current = state;
      },
    });

    view.unmount();

    expect(restoreStateRef.current?.turnHeightsByKey.turn_1 ?? 0).toBe(0);
    expect(restoreStateRef.current?.turnHeightsByKey.turn_2 ?? 0).toBe(0);
    expect(restoreStateRef.current?.turnHeightsByKey.turn_3 ?? 0).toBe(0);
  });
});
