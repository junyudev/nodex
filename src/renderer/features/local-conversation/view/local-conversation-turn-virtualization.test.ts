import { describe, expect, test } from "vite-plus/test";
import {
  buildPendingLatestTurnSubmitPlacement,
  buildVirtualizedTurnLayout,
  buildVirtualizedTurnListRestoreState,
  createThreadLatestTurnFollowState,
  resolveAdjustedScrollDistanceFromBottomForMeasuredTurnHeightDelta,
  resolveAnchorPreservedDistanceFromBottom,
  resolveInitialVirtualizedTurnViewportState,
  resolveMeasuredVisibleAnchorKey,
  resolveRenderedRangeForPendingScrollTarget,
  resolveResponseSpacerBottomViewportOverflowPx,
  resolveResponseSpacerHeightPx,
  resolveRestoredDistanceWithoutResponseSpacer,
  resolveTargetCenterDistanceFromBottom,
  resolveThreadLatestTurnFollowState,
  resolveThreadLatestTurnPhase,
  resolveTurnCenterDistanceFromBottom,
  resolveVirtualizedTurnViewportState,
  resolveVisibleTurnRangeFromBottomDistance,
  shouldShowThreadScrollToBottomControl,
} from "./local-conversation-turn-virtualization";

function buildLayout(heightsPx: number[]) {
  return buildVirtualizedTurnLayout({
    entries: heightsPx.map((heightPx, index) => ({
      turnKey: `turn_${index + 1}`,
      estimatedHeightPx: heightPx,
    })),
    gapPx: 12,
  });
}

describe("buildVirtualizedTurnLayout", () => {
  test("preserves measured zero, minimum height and per-row gaps with physical-pixel rounding", () => {
    const layout = buildVirtualizedTurnLayout({
      entries: [
        { turnKey: "empty", estimatedHeightPx: 200 },
        { turnKey: "second", estimatedHeightPx: 10.2, minHeightPx: 10.4, gapBeforePx: 4.2 },
        { turnKey: "gap", type: "gap", estimatedHeightPx: 3.3 },
      ],
      gapPx: 12,
      pixelScale: 1.6,
      measuredHeightsByKey: { empty: 0 },
      collapseEmptyRows: true,
    });
    expect(layout.heightsPx).toEqual([0, 10.625, 3.125]);
    expect(layout.gapsBeforePx).toEqual([0, 0, 11.875]);
    expect(layout.topOffsetsPx).toEqual([0, 0, 22.5]);
    expect(layout.totalHeightPx).toBe(25.625);
    expect(layout.gapKeys.has("gap")).toBe(true);
    expect(
      resolveVisibleTurnRangeFromBottomDistance({
        layout,
        distanceFromBottomPx: 0,
        viewportHeightPx: 100,
        overscanCount: 0,
      }),
    ).toEqual({ startIndex: 0, endIndex: 3 });
  });

  test("rounds height and gap to the same pixel grid across zoom and DPR", () => {
    for (const zoom of [0.8, 1, 1.25, 1.5])
      for (const ratio of [1, 2]) {
        const scale = zoom * ratio;
        const layout = buildVirtualizedTurnLayout({
          entries: [
            { turnKey: "one", estimatedHeightPx: 10.3 },
            { turnKey: "two", estimatedHeightPx: 11.3, gapBeforePx: 4.7 },
          ],
          gapPx: 12,
          pixelScale: scale,
        });
        expect(layout.heightsPx.map((value) => value * scale)).toEqual([
          Math.round(10.3 * scale),
          Math.round(11.3 * scale),
        ]);
        expect(layout.gapsBeforePx[1]! * scale).toBeCloseTo(Math.round(4.7 * scale));
        expect(layout.topOffsetsPx[1]).toBeCloseTo(layout.heightsPx[0]! + layout.gapsBeforePx[1]!);
      }
  });
  test("matches Codex spacer layout offsets, total height, and turn key index map", () => {
    const layout = buildLayout([100, 120, 80]);

    expect(layout.topOffsetsPx.join(",")).toBe("0,112,244");
    expect(layout.bottomOffsetsPx.join(",")).toBe("224,92,0");
    expect(layout.totalHeightPx).toBe(324);
    expect(layout.turnKeys.join(",")).toBe("turn_1,turn_2,turn_3");
    expect(layout.turnIndexByKey.get("turn_2")).toBe(1);
  });

  test("keeps a measured content anchor stable when an older page replaces the history gap", () => {
    const previousLayout = buildVirtualizedTurnLayout({
      entries: [
        { turnKey: "history-gap", estimatedHeightPx: 144 },
        { turnKey: "turn_2", estimatedHeightPx: 100 },
        { turnKey: "turn_3", estimatedHeightPx: 100 },
      ],
      gapPx: 12,
    });
    const nextLayout = buildVirtualizedTurnLayout({
      entries: [
        { turnKey: "turn_1", estimatedHeightPx: 100 },
        { turnKey: "turn_2", estimatedHeightPx: 100 },
        { turnKey: "turn_3", estimatedHeightPx: 100 },
      ],
      gapPx: 12,
    });

    expect(
      resolveAnchorPreservedDistanceFromBottom({
        anchorKey: "turn_2",
        distanceFromBottomPx: 112,
        previousLayout,
        nextLayout,
      }),
    ).toBe(112);
  });

  test("prefers measured heights over estimated heights", () => {
    const layout = buildVirtualizedTurnLayout({
      entries: [
        { turnKey: "turn_a", estimatedHeightPx: 100 },
        { turnKey: "turn_b", estimatedHeightPx: 120 },
      ],
      gapPx: 12,
      measuredHeightsByKey: { turn_a: 180 },
    });

    expect(layout.heightsPx.join(",")).toBe("180,120");
    expect(layout.bottomOffsetsPx.join(",")).toBe("132,0");
  });
});

describe("resolveVisibleTurnRangeFromBottomDistance", () => {
  test("returns visible turns from a bottom-origin viewport", () => {
    const layout = buildLayout([100, 120, 80, 90]);

    const range = resolveVisibleTurnRangeFromBottomDistance({
      distanceFromBottomPx: 0,
      layout,
      viewportHeightPx: 160,
      overscanCount: 1,
    });

    expect(`${range.startIndex}:${range.endIndex}`).toBe("1:4");
  });

  test("resolves older visible turns as distance from bottom increases", () => {
    const layout = buildLayout([100, 120, 80, 90]);

    const range = resolveVisibleTurnRangeFromBottomDistance({
      distanceFromBottomPx: 250,
      layout,
      viewportHeightPx: 100,
      overscanCount: 0,
    });

    expect(`${range.startIndex}:${range.endIndex}`).toBe("0:2");
  });
});

describe("virtualized viewport restore state", () => {
  test("restores the rendered window from an anchor key", () => {
    const layout = buildLayout([100, 120, 80, 90]);
    const state = resolveInitialVirtualizedTurnViewportState({
      distanceFromBottomPx: 0,
      initialRestoreState: {
        renderedWindow: { anchorKey: "turn_2", count: 2 },
        turnHeightsByKey: { turn_2: 120 },
      },
      layout,
      overscanCount: 1,
      viewportHeightPx: 160,
    });

    expect(`${state.renderedRange.startIndex}:${state.renderedRange.endIndex}`).toBe("1:3");
  });

  test("keeps an existing rendered range when it already covers the next visible range", () => {
    const layout = buildLayout([100, 120, 80, 90]);
    const current = {
      distanceFromBottomPx: 0,
      renderedRange: { startIndex: 0, endIndex: 4 },
      turnKeys: layout.turnKeys,
      viewportHeightPx: 160,
    };
    const state = resolveVirtualizedTurnViewportState({
      current,
      distanceFromBottomPx: 0,
      layout,
      overscanCount: 0,
      viewportHeightPx: 160,
    });

    expect(`${state.renderedRange.startIndex}:${state.renderedRange.endIndex}`).toBe("0:4");
  });

  test("serializes rendered window and measured heights for known keys", () => {
    const restoreState = buildVirtualizedTurnListRestoreState({
      measuredHeightsByKey: { turn_1: 100, turn_2: 120, missing: 999 },
      renderedRange: { startIndex: 1, endIndex: 3 },
      turnKeys: ["turn_1", "turn_2", "turn_3"],
    });

    expect(restoreState?.renderedWindow.anchorKey ?? "").toBe("turn_2");
    expect(restoreState?.renderedWindow.count ?? 0).toBe(2);
    expect(Object.keys(restoreState?.turnHeightsByKey ?? {}).join(",")).toBe("turn_1,turn_2");
  });

  test("preserves distance from bottom through layout changes by measured visible anchor", () => {
    const previousLayout = buildLayout([100, 120, 80]);
    const nextLayout = buildLayout([100, 200, 80]);
    const anchorKey = resolveMeasuredVisibleAnchorKey({
      distanceFromBottomPx: 100,
      layout: previousLayout,
      measuredHeightsByKey: { turn_2: 120 },
      nextLayout,
      viewportHeightPx: 180,
    });

    const distance = anchorKey
      ? resolveAnchorPreservedDistanceFromBottom({
          anchorKey,
          distanceFromBottomPx: 100,
          previousLayout,
          nextLayout,
        })
      : null;

    expect(anchorKey ?? "").toBe("turn_2");
    expect(distance).toBe(180);
  });
});

describe("turn reveal distances", () => {
  test("centers a turn using bottom-origin distance", () => {
    const layout = buildLayout([100, 120, 80]);

    expect(
      resolveTurnCenterDistanceFromBottom({
        layout,
        turnIndex: 0,
        viewportHeightPx: 200,
      }),
    ).toBe(174);
    expect(
      resolveTurnCenterDistanceFromBottom({
        layout,
        turnKey: "turn_3",
        viewportHeightPx: 200,
      }),
    ).toBe(0);
  });

  test("centers a target inside a turn and normalizes rect deltas by window zoom", () => {
    const layout = buildLayout([100, 120, 80]);

    expect(
      resolveTargetCenterDistanceFromBottom({
        layout,
        targetHeightPx: 40,
        targetTopWithinTurnPx: 40,
        turnIndex: 0,
        viewportHeightPx: 200,
        windowZoom: 2,
      }),
    ).toBe(194);
  });

  test("uses pending target to render the target turn range before DOM reveal", () => {
    const layout = buildLayout([100, 120, 80, 90, 70]);
    const range = resolveRenderedRangeForPendingScrollTarget({
      currentRange: { startIndex: 3, endIndex: 5 },
      layout,
      overscanCount: 1,
      pendingTurnKey: "turn_1",
      viewportHeightPx: 160,
    });

    expect(`${range.startIndex}:${range.endIndex}`).toBe("0:3");
  });
});

describe("resolveAdjustedScrollDistanceFromBottomForMeasuredTurnHeightDelta", () => {
  test("does not adjust when the turn is still visible in the viewport", () => {
    const adjustedScrollDistanceFromBottomPx =
      resolveAdjustedScrollDistanceFromBottomForMeasuredTurnHeightDelta({
        currentScrollDistanceFromBottomPx: 300,
        heightDeltaPx: 80,
        turnTopDistanceFromBottomPx: 340,
        viewportBottomDistanceFromBottomPx: 300,
        scrollMode: "user",
      });

    expect(adjustedScrollDistanceFromBottomPx === null).toBe(true);
  });

  test("adjusts when the measured turn is fully below the viewport", () => {
    const adjustedScrollDistanceFromBottomPx =
      resolveAdjustedScrollDistanceFromBottomForMeasuredTurnHeightDelta({
        currentScrollDistanceFromBottomPx: 300,
        heightDeltaPx: 80,
        turnTopDistanceFromBottomPx: 220,
        viewportBottomDistanceFromBottomPx: 300,
        scrollMode: "user",
      });

    expect(adjustedScrollDistanceFromBottomPx).toBe(380);
  });

  test("stays at zero while sticking to bottom", () => {
    const adjustedScrollDistanceFromBottomPx =
      resolveAdjustedScrollDistanceFromBottomForMeasuredTurnHeightDelta({
        currentScrollDistanceFromBottomPx: 700,
        heightDeltaPx: 64,
        turnTopDistanceFromBottomPx: 740,
        viewportBottomDistanceFromBottomPx: 640,
        scrollMode: "stickToBottom",
      });

    expect(adjustedScrollDistanceFromBottomPx).toBe(0);
  });

  test("suppresses height compensation during programmatic find scrolls", () => {
    const adjustedScrollDistanceFromBottomPx =
      resolveAdjustedScrollDistanceFromBottomForMeasuredTurnHeightDelta({
        currentScrollDistanceFromBottomPx: 400,
        heightDeltaPx: 40,
        turnTopDistanceFromBottomPx: 120,
        viewportBottomDistanceFromBottomPx: 400,
        scrollMode: "programmaticFind",
      });

    expect(adjustedScrollDistanceFromBottomPx === null).toBe(true);
  });
});

describe("latest turn follow helpers", () => {
  test("derives latest turn phase from in-progress turn items", () => {
    expect(
      resolveThreadLatestTurnPhase({
        status: "inProgress",
        firstTurnWorkItemStartedAtMs: 1,
        finalAssistantStartedAtMs: null,
        items: [],
      }),
    ).toBe("prework");
    expect(
      resolveThreadLatestTurnPhase({
        status: "inProgress",
        firstTurnWorkItemStartedAtMs: 1,
        finalAssistantStartedAtMs: 2,
        items: [{ type: "assistantMessage", assistantPhase: "final_answer" }],
      }),
    ).toBe("final_answer");
    expect(
      resolveThreadLatestTurnPhase({
        status: "completed",
        items: [{ type: "assistantMessage", assistantPhase: "final_answer" }],
      }),
    ).toBe("idle");
  });

  test("matches Codex follow-mode transitions", () => {
    let state = createThreadLatestTurnFollowState();
    state = resolveThreadLatestTurnFollowState(state, {
      type: "latest_turn_phase_changed",
      previousLatestTurnPhase: "idle",
      latestTurnPhase: "prework",
    });
    expect(state.followMode).toBe("prework_watch");

    state = resolveThreadLatestTurnFollowState(state, {
      type: "latest_turn_follow_content_changed",
      latestTurnPhase: "prework",
      followContentOverflowPx: 10,
    });
    expect(state.followMode).toBe("prework_follow");

    state = resolveThreadLatestTurnFollowState(state, {
      type: "latest_turn_phase_changed",
      previousLatestTurnPhase: "prework",
      latestTurnPhase: "final_answer",
    });
    expect(state.followMode).toBe("user_follow");

    state = resolveThreadLatestTurnFollowState(state, {
      type: "scroll_distance_changed",
      latestTurnPhase: "final_answer",
      distanceFromBottomPx: 40,
    });
    expect(state.followMode).toBe("static");
  });

  test("resolves response spacer restore and catch-up visibility", () => {
    const placement = buildPendingLatestTurnSubmitPlacement({
      distanceFromBottomPx: 250,
      responseSpacerHeightPx: 20,
      scrollHeightPx: 8_000,
    });
    expect(placement.shouldPlaceLatestTurn).toBe(true);

    expect(
      resolveResponseSpacerBottomViewportOverflowPx({
        distanceFromBottomPx: 40,
        responseSpacerHeightPx: 120,
        scrollPaddingBottomPx: 20,
      }),
    ).toBe(60);

    expect(
      resolveResponseSpacerHeightPx({
        scrollPaddingBottomPx: 80,
        viewportHeightPx: 720,
      }),
    ).toBe(400);

    const restored = resolveRestoredDistanceWithoutResponseSpacer({
      distanceFromBottomPx: 40,
      latestTurnPhase: "final_answer",
      responseSpacerHeightPx: 120,
      scrollPaddingBottomPx: 20,
      scrollState: createThreadLatestTurnFollowState(),
    });
    expect(restored.distanceFromBottomPx).toBe(0);
    expect(restored.scrollState.followMode).toBe("static");

    expect(
      shouldShowThreadScrollToBottomControl({
        isScrollToTopEnabled: true,
        isScrolledFromBottom: false,
        responseSpacerHeightPx: 100,
        scrollDistanceFromBottomPx: 130,
      }),
    ).toBe(true);
  });
  test("keeps explicit user follow through prework and idle, and holds it on interaction", () => {
    const state = resolveThreadLatestTurnFollowState(createThreadLatestTurnFollowState(), {
      type: "scroll_to_bottom",
      latestTurnPhase: "prework",
    });
    expect(state.followMode).toBe("user_follow");
    expect(
      resolveThreadLatestTurnFollowState(state, {
        type: "latest_turn_phase_changed",
        previousLatestTurnPhase: "idle",
        latestTurnPhase: "prework",
      }),
    ).toBe(state);
    expect(
      resolveThreadLatestTurnFollowState(state, {
        type: "latest_turn_phase_changed",
        previousLatestTurnPhase: "prework",
        latestTurnPhase: "idle",
      }),
    ).toBe(state);
    expect(resolveThreadLatestTurnFollowState(state, { type: "hold_viewport" }).followMode).toBe(
      "static",
    );
  });
});
