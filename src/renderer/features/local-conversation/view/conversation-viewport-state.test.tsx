import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { createThreadResponseSpaceController } from "./local-conversation-response-space";
import { act } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import {
  appScope,
  createMaitaiStore,
  MaitaiProvider,
  useScopeHandle,
  type ScopeHandle,
} from "@/lib/maitai";
import { render } from "@/test/dom";
import { dispatchCodexAppServerMessage } from "../app-server-message-bus";
import { LocalConversationViewStateCleanupController } from "./local-conversation-view-state-cleanup-controller";
import {
  EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
  localConversationThreadRestoreSnapshotFamily,
  localConversationTurnCollapseOverrideFamily,
  normalizeThreadRestoreDistanceFromBottomPx,
  removeLocalConversationViewState,
  resolveLatestTurnCollapseTransition,
  setLocalConversationTurnCollapseOverride,
  type LocalConversationThreadRestoreSnapshot,
  updateLocalConversationThreadRestoreSnapshot,
} from "./local-conversation-thread-view-state";
import {
  getThreadScrollDistanceFromBottomPx,
  isThreadScrollNearBottom,
  resolveNativeScrollTopForDistanceFromBottomPx,
  resolveThreadScrollKeyDirection,
} from "./local-conversation-thread-scroll-controller";

describe("local conversation response space", () => {
  function fixture() {
    let viewport: HTMLDivElement | null = document.createElement("div");
    let distance = 200;
    let clientHeight = 800;
    let scrollHeight = 2_000;
    let spacerTop = 500;
    const calls: number[] = [];
    Object.defineProperty(viewport, "clientHeight", { get: () => clientHeight });
    Object.defineProperty(viewport, "scrollHeight", { get: () => scrollHeight });
    viewport.style.setProperty("--thread-scroll-padding-bottom", "100px");
    viewport.getBoundingClientRect = () => ({ top: 0, bottom: 800, height: 800 }) as DOMRect;
    const spacer = document.createElement("div");
    spacer.getBoundingClientRect = () =>
      ({ top: spacerTop, bottom: spacerTop + 100, height: 100 }) as DOMRect;
    const hold = vi.fn();
    const released = vi.fn();
    const scroll = {
      getScrollElement: () => viewport,
      getScrollDistanceFromBottomPx: () => distance,
      getLastScrollDistanceFromBottomPx: () => distance,
      getUnroundedScrollDistanceFromBottomPx: (fallback: number) => fallback,
      compensateScrollToDistanceFromBottomPx: (next: number) => {
        distance = next;
        calls.push(next);
      },
      scrollToDistanceFromBottomPx: (next: number) => {
        distance = next;
        calls.push(next);
      },
      holdViewport: hold,
    };
    const owner = createThreadResponseSpaceController(scroll);
    owner.updateContext(scroll, true, released);
    owner.setElement(spacer);
    return {
      owner,
      calls,
      hold,
      released,
      spacer,
      scroll,
      get distance() {
        return distance;
      },
      setDistance: (next: number) => {
        distance = next;
      },
      setViewportHeight: (next: number) => {
        clientHeight = next;
      },
      setScrollHeight: (next: number) => {
        scrollHeight = next;
      },
      setSpacerTop: (next: number) => {
        spacerTop = next;
      },
      retireViewport: () => {
        viewport = null;
      },
    };
  }

  afterEach(() => vi.unstubAllGlobals());

  describe("thread response space", () => {
    test("places at one native pixel with a fixed bounded response space under reduced motion", () => {
      const f = fixture();
      f.owner.place();
      expect(f.hold).toHaveBeenCalledOnce();
      expect(f.owner.getHeightPx()).toBe(460);
      expect(f.spacer.style.height).toBe("460px");
      expect(f.calls).toEqual([1]);
    });
    test("consumes only positive layout growth and never grows after collapse", () => {
      const f = fixture();
      f.owner.place();
      f.owner.consumeGrowth(100.25);
      expect(f.owner.getHeightPx()).toBe(359.75);
      f.owner.consumeGrowth(-100);
      expect(f.owner.getHeightPx()).toBe(359.75);
      f.owner.consumeGrowth(500);
      f.owner.consumeGrowth(-500);
      expect(f.owner.getHeightPx()).toBe(0);
      expect(f.calls).toEqual([1]);
    });
    test("accumulates real upward user deltas once per frame without discarding sub-24px changes", () => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      });
      const f = fixture();
      f.owner.place();
      f.setDistance(13);
      f.owner.handleUserScroll(6, 1);
      f.owner.handleUserScroll(13, 6);
      expect(frames).toHaveLength(1);
      frames[0]?.(0);
      expect(f.owner.getHeightPx()).toBe(448);
      expect(f.distance).toBe(1);
    });
    test("ignores toward-bottom deltas but reaching exact zero clears space", () => {
      const f = fixture();
      f.owner.place();
      f.owner.handleUserScroll(100, 200);
      expect(f.owner.getHeightPx()).toBe(460);
      f.owner.handleUserScroll(0, 100);
      expect(f.owner.getHeightPx()).toBe(0);
    });
    test("retires queued decay when its viewport is replaced", () => {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.push(callback);
        return 1;
      });
      const f = fixture();
      f.owner.place();
      f.owner.handleUserScroll(101, 1);
      f.retireViewport();
      frames[0]?.(0);
      expect(f.owner.getHeightPx()).toBe(460);
    });
    test("trims for viewport or footer shrink with equal scroll compensation", () => {
      const f = fixture();
      f.owner.place();
      f.setDistance(300);
      f.setViewportHeight(600);
      f.owner.reconcileViewport();
      expect(f.owner.getHeightPx()).toBe(260);
      expect(f.distance).toBe(100);
      f.setViewportHeight(1_000);
      f.owner.reconcileViewport();
      expect(f.owner.getHeightPx()).toBe(260);
    });
    test("retains visible space then collapses at the one physical-pixel content edge", () => {
      const f = fixture();
      f.owner.place();
      f.setDistance(500);
      f.setSpacerTop(698.5);
      f.owner.collapseIfHidden();
      expect(f.owner.getHeightPx()).toBe(460);
      f.setSpacerTop(699);
      f.owner.collapseIfHidden();
      expect(f.owner.getHeightPx()).toBe(0);
      expect(f.distance).toBe(40);
      expect(f.released).toHaveBeenCalledOnce();
    });
    test("clears space only when native content truly fits at exact bottom", () => {
      const f = fixture();
      f.owner.place();
      f.setScrollHeight(800);
      f.owner.handleScroll(1);
      expect(f.owner.getHeightPx()).toBe(460);
      f.owner.handleScroll(0);
      expect(f.owner.getHeightPx()).toBe(0);
    });

    test("places a requested row at the viewport inset instead of the generic response destination", () => {
      const f = fixture();
      const target = document.createElement("div");
      target.getBoundingClientRect = () => ({ top: 300 }) as DOMRect;
      f.owner.place(target);
      expect(f.hold).toHaveBeenCalledOnce();
      expect(f.owner.getHeightPx()).toBe(101);
      expect(f.calls).toEqual([1]);
    });

    test("prepares thread end content once and lets an upward gesture revoke that preparation", () => {
      const f = fixture();
      f.owner.place();
      f.setDistance(60);
      f.owner.prepareThreadEndContent();
      expect(f.owner.getHeightPx()).toBe(400);
      expect(f.calls).toEqual([1, 0]);
      f.owner.prepareThreadEndContent();
      expect(f.calls).toEqual([1, 0]);

      f.owner.place();
      f.owner.handleUserScroll(8, 1);
      f.owner.prepareThreadEndContent();
      expect(f.owner.getHeightPx()).toBe(460);
      f.owner.cancelPendingUserScrollDecay();
    });
  });
});

describe("local conversation thread restore atoms", () => {
  function HandleProbe({ onHandle }: { readonly onHandle: (handle: ScopeHandle) => void }) {
    onHandle(useScopeHandle(appScope));
    return null;
  }

  function TestStateRoot({
    children,
    onHandle,
  }: {
    readonly children?: ReactNode;
    readonly onHandle: (handle: ScopeHandle) => void;
  }) {
    const [store] = useState(createMaitaiStore);
    return (
      <MaitaiProvider store={store}>
        <HandleProbe onHandle={onHandle} />
        {children}
      </MaitaiProvider>
    );
  }

  function completeSnapshot(distanceFromBottomPx: number): LocalConversationThreadRestoreSnapshot {
    return {
      distanceFromBottomPx,
      latestTurn: {
        followMode: "prework_watch",
        isLatestTurnInProgress: true,
        latestTurnFollowContentHeightPx: 320,
        latestTurnHeightPx: 480,
        latestTurnPhase: "prework",
        turnKey: "turn_latest",
      },
      virtualizedTurnList: {
        renderedWindow: { anchorKey: "turn_4", count: 7 },
        turnHeightsByKey: { turn_4: 300, turn_latest: 480 },
      },
    };
  }

  describe("local conversation thread restore atoms", () => {
    test("restores isolated complete snapshots across fresh A/B/A readers", () => {
      let handle: ScopeHandle | null = null;
      render(
        <TestStateRoot
          onHandle={(next) => {
            handle = next;
          }}
        />,
      );
      const appHandle = handle as ScopeHandle | null;
      if (!appHandle) throw new Error("expected app scope handle");

      const snapshotA = completeSnapshot(5_365);
      const snapshotB = completeSnapshot(812);
      appHandle.set(localConversationThreadRestoreSnapshotFamily("thread_a"), snapshotA);
      appHandle.set(localConversationThreadRestoreSnapshotFamily("thread_b"), snapshotB);

      const firstAReader = appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_a"));
      const freshBReader = appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_b"));
      const freshAReader = appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_a"));

      expect(firstAReader).toBe(snapshotA);
      expect(freshBReader).toBe(snapshotB);
      expect(freshAReader).toBe(snapshotA);
      expect(freshAReader.latestTurn).toEqual(snapshotA.latestTurn);
      expect(freshAReader.virtualizedTurnList).toEqual(snapshotA.virtualizedTurnList);
    });

    test.each([
      [-8, 0],
      [0, 0],
      [0.125, 0],
      [24, 0],
      [24.01, 24.01],
      [Number.NaN, 0],
      [Number.POSITIVE_INFINITY, 0],
    ])("normalizes native restore distance %s to %s", (distance, expected) => {
      expect(normalizeThreadRestoreDistanceFromBottomPx(distance)).toBe(expected);
    });

    test("collapses the old latest turn while preserving the MCP App exception window", () => {
      const regularTransition = resolveLatestTurnCollapseTransition({
        entries: [
          { turnSearchKey: "turn_1", hasMcpApp: false },
          { turnSearchKey: "turn_2", hasMcpApp: false },
        ],
        latestTurnSearchKey: "turn_2",
        previousLatestTurnSearchKey: "turn_1",
      });
      expect(regularTransition).toEqual(["turn_1"]);

      const immediateMcpAppTransition = resolveLatestTurnCollapseTransition({
        entries: [
          { turnSearchKey: "mcp_turn", hasMcpApp: true },
          { turnSearchKey: "turn_2", hasMcpApp: false },
        ],
        latestTurnSearchKey: "turn_2",
        previousLatestTurnSearchKey: "mcp_turn",
      });
      expect(immediateMcpAppTransition).toEqual([]);

      const agedMcpAppTransition = resolveLatestTurnCollapseTransition({
        entries: [
          { turnSearchKey: "mcp_turn", hasMcpApp: true },
          { turnSearchKey: "turn_2", hasMcpApp: false },
          { turnSearchKey: "turn_3", hasMcpApp: false },
          { turnSearchKey: "turn_4", hasMcpApp: false },
        ],
        latestTurnSearchKey: "turn_4",
        previousLatestTurnSearchKey: "turn_3",
      });
      expect(agedMcpAppTransition).toEqual(["turn_3", "mcp_turn"]);
    });

    test("does not evict an earlier snapshot after more than fifty conversations", () => {
      let handle: ScopeHandle | null = null;
      render(
        <TestStateRoot
          onHandle={(next) => {
            handle = next;
          }}
        />,
      );
      const appHandle = handle as ScopeHandle | null;
      if (!appHandle) throw new Error("expected app scope handle");

      for (let index = 1; index <= 75; index += 1) {
        appHandle.set(localConversationThreadRestoreSnapshotFamily(`thread_${index}`), {
          ...EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
          distanceFromBottomPx: index,
        });
      }

      expect(
        appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_1"))
          .distanceFromBottomPx,
      ).toBe(1);
      expect(
        appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_75"))
          .distanceFromBottomPx,
      ).toBe(75);
    });

    test("explicit cleanup removes snapshot and every indexed collapse override idempotently", () => {
      let handle: ScopeHandle | null = null;
      render(
        <TestStateRoot
          onHandle={(next) => {
            handle = next;
          }}
        />,
      );
      const appHandle = handle as ScopeHandle | null;
      if (!appHandle) throw new Error("expected app scope handle");

      appHandle.set(
        localConversationThreadRestoreSnapshotFamily("thread_a"),
        completeSnapshot(400),
      );
      setLocalConversationTurnCollapseOverride(
        appHandle,
        {
          conversationId: "thread_a",
          turnSearchKey: "turn_1",
        },
        true,
      );
      setLocalConversationTurnCollapseOverride(
        appHandle,
        {
          conversationId: "thread_a",
          turnSearchKey: "turn_2",
        },
        false,
      );

      expect(removeLocalConversationViewState(appHandle, "thread_a")).toBe(true);
      expect(removeLocalConversationViewState(appHandle, "thread_a")).toBe(false);
      expect(appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_a"))).toBe(
        EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
      );
      expect(
        appHandle.get(
          localConversationTurnCollapseOverrideFamily({
            conversationId: "thread_a",
            turnSearchKey: "turn_1",
          }),
        ),
      ).toBe(null);
    });

    test("cleanup tombstone prevents late layout cleanup from resurrecting deleted state", () => {
      let handle: ScopeHandle | null = null;
      render(
        <TestStateRoot
          onHandle={(next) => {
            handle = next;
          }}
        />,
      );
      const appHandle = handle as ScopeHandle | null;
      if (!appHandle) throw new Error("expected app scope handle");

      expect(
        updateLocalConversationThreadRestoreSnapshot(appHandle, "thread_race", () =>
          completeSnapshot(500),
        ),
      ).toBe(true);
      expect(removeLocalConversationViewState(appHandle, "thread_race")).toBe(true);
      expect(
        updateLocalConversationThreadRestoreSnapshot(appHandle, "thread_race", () =>
          completeSnapshot(900),
        ),
      ).toBe(false);
      expect(appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_race"))).toBe(
        EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
      );
    });

    test("canonical deletion cleans view state while no conversation view is mounted", () => {
      let handle: ScopeHandle | null = null;
      render(
        <TestStateRoot
          onHandle={(next) => {
            handle = next;
          }}
        >
          <LocalConversationViewStateCleanupController />
        </TestStateRoot>,
      );
      const appHandle = handle as ScopeHandle | null;
      if (!appHandle) throw new Error("expected app scope handle");

      appHandle.set(
        localConversationThreadRestoreSnapshotFamily("thread_deleted"),
        completeSnapshot(700),
      );
      setLocalConversationTurnCollapseOverride(
        appHandle,
        {
          conversationId: "thread_deleted",
          turnSearchKey: "turn_1",
        },
        true,
      );

      act(() => {
        dispatchCodexAppServerMessage("thread-deleted", {
          hostId: "local",
          threadId: "thread_deleted",
        });
        dispatchCodexAppServerMessage("thread-deleted", {
          hostId: "local",
          threadId: "thread_deleted",
        });
      });

      expect(appHandle.get(localConversationThreadRestoreSnapshotFamily("thread_deleted"))).toBe(
        EMPTY_LOCAL_CONVERSATION_THREAD_RESTORE_SNAPSHOT,
      );
      expect(
        appHandle.get(
          localConversationTurnCollapseOverrideFamily({
            conversationId: "thread_deleted",
            turnSearchKey: "turn_1",
          }),
        ),
      ).toBe(null);
    });
  });
});

describe("local conversation thread scroll controller", () => {
  function buildScrollElement(input: {
    clientHeight: number;
    scrollHeight: number;
    scrollTop: number;
  }): HTMLDivElement {
    const element = document.createElement("div");
    Object.defineProperty(element, "clientHeight", {
      configurable: true,
      get: () => input.clientHeight,
    });
    Object.defineProperty(element, "scrollHeight", {
      configurable: true,
      get: () => input.scrollHeight,
    });
    Object.defineProperty(element, "scrollTop", {
      configurable: true,
      get: () => input.scrollTop,
    });
    return element;
  }

  describe("getThreadScrollDistanceFromBottomPx", () => {
    test("treats the end of the top-origin scroller as zero", () => {
      expect(
        getThreadScrollDistanceFromBottomPx({
          clientHeight: 500,
          scrollHeight: 8_000,
          scrollTop: 7_500,
        }),
      ).toBe(0);
    });

    test("derives distance from bottom from native scrollTop", () => {
      expect(
        getThreadScrollDistanceFromBottomPx({
          clientHeight: 500,
          scrollHeight: 8_000,
          scrollTop: 2_135,
        }),
      ).toBe(5_365);
    });
  });

  describe("thread keyboard scroll intent", () => {
    test("recognizes viewport paging and Shift-Space directions", () => {
      const viewport = document.createElement("div");
      const up = new KeyboardEvent("keydown", { key: "PageUp" });
      viewport.dispatchEvent(up);
      const down = new KeyboardEvent("keydown", { key: " " });
      viewport.dispatchEvent(down);
      const shift = new KeyboardEvent("keydown", { key: " ", shiftKey: true });
      viewport.dispatchEvent(shift);
      expect(resolveThreadScrollKeyDirection(up, viewport)).toBe("away");
      expect(resolveThreadScrollKeyDirection(down, viewport)).toBe("toward");
      expect(resolveThreadScrollKeyDirection(shift, viewport)).toBe("away");
    });
    test("leaves editor navigation and button activation with their own control", () => {
      const viewport = document.createElement("div");
      const input = document.createElement("textarea");
      viewport.append(input);
      const button = document.createElement("button");
      viewport.append(button);
      const up = new KeyboardEvent("keydown", { key: "ArrowUp" });
      input.dispatchEvent(up);
      const space = new KeyboardEvent("keydown", { key: " " });
      button.dispatchEvent(space);
      expect(resolveThreadScrollKeyDirection(up, viewport)).toBeNull();
      expect(resolveThreadScrollKeyDirection(space, viewport)).toBeNull();
    });
    test("ignores repeated scrolling keys and already consumed events", () => {
      const viewport = document.createElement("div");
      const repeat = new KeyboardEvent("keydown", { key: "Home", repeat: true });
      const consumed = new KeyboardEvent("keydown", { key: "End", cancelable: true });
      consumed.preventDefault();
      expect(resolveThreadScrollKeyDirection(repeat, viewport)).toBeNull();
      expect(resolveThreadScrollKeyDirection(consumed, viewport)).toBeNull();
    });
  });

  describe("resolveNativeScrollTopForDistanceFromBottomPx", () => {
    test("maps older content to a smaller native scrollTop", () => {
      const element = buildScrollElement({
        clientHeight: 500,
        scrollHeight: 8_000,
        scrollTop: 7_500,
      });

      expect(resolveNativeScrollTopForDistanceFromBottomPx(element, 5_365)).toBe(2_135);
    });

    test("maps the bottom target to the native scroll end", () => {
      const element = buildScrollElement({
        clientHeight: 500,
        scrollHeight: 8_000,
        scrollTop: 100,
      });

      expect(resolveNativeScrollTopForDistanceFromBottomPx(element, 0)).toBe(7_500);
    });

    test("clamps distances beyond the oldest content to the native start", () => {
      const element = buildScrollElement({
        clientHeight: 500,
        scrollHeight: 8_000,
        scrollTop: 100,
      });

      expect(resolveNativeScrollTopForDistanceFromBottomPx(element, 9_000)).toBe(0);
    });
  });

  describe("isThreadScrollNearBottom", () => {
    test("treats positions within the Codex near-bottom threshold as bottom", () => {
      expect(
        isThreadScrollNearBottom({
          scrollDistanceFromBottomPx: 12,
        }),
      ).toBe(true);
    });

    test("treats positions beyond the Codex near-bottom threshold as scrolled away", () => {
      expect(
        isThreadScrollNearBottom({
          scrollDistanceFromBottomPx: 25,
        }),
      ).toBe(false);
    });
  });
});
