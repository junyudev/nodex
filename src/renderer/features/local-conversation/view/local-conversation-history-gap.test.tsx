import { describe, expect, test } from "vite-plus/test";
import { render } from "../../../test/dom";
import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
} from "../../../../shared/codex-conversation-state/codex-history-topology";
import {
  CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX,
  createLocalConversationHistoryGapRequestCoordinator,
  LocalConversationHistoryGap,
  projectLocalConversationLegacyHistoryRows,
  selectLocalConversationHistoryGapBoundary,
  type LocalConversationHistoryGapLayout,
} from "./local-conversation-history-gap";

type GapRow = Extract<CodexHistoryRow, { kind: "gap" }>;

function boundary(
  edge: CodexHistoryBoundaryRef["edge"],
  progressKey: string,
): CodexHistoryBoundaryRef {
  return {
    generation: 3,
    islandId: `island:${edge}`,
    edge,
    boundaryId: `boundary:${edge}:${progressKey}`,
    progressKey,
    handle: { cursor: progressKey, oldestLoadedTurnId: null },
  };
}

function gapRow(input: {
  readonly key?: string;
  readonly olderBoundary?: CodexHistoryBoundaryRef | null;
  readonly newerBoundary?: CodexHistoryBoundaryRef | null;
}): GapRow {
  return {
    kind: "gap",
    key: input.key ?? "gap:1",
    olderBoundary: input.olderBoundary ?? null,
    newerBoundary: input.newerBoundary ?? null,
    estimatedHeightPx: 144,
  };
}

function gapLayout(startPx: number, row: GapRow): LocalConversationHistoryGapLayout {
  return { row, startPx, endPx: startPx + row.estimatedHeightPx };
}

function select(input: {
  readonly viewportStartPx?: number;
  readonly viewportEndPx?: number;
  readonly gaps: readonly LocalConversationHistoryGapLayout[];
}) {
  return selectLocalConversationHistoryGapBoundary({
    viewportStartPx: input.viewportStartPx ?? 1000,
    viewportEndPx: input.viewportEndPx ?? 1200,
    gaps: input.gaps,
  });
}

describe("local conversation history gap controller", () => {
  test("selects a boundary at the inclusive 800px proximity edge", () => {
    const newer = boundary("older", "progress:near");
    const row = gapRow({ newerBoundary: newer });
    const result = select({ gaps: [gapLayout(56, row)] });

    expect(CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX).toBe(800);
    expect(result).toBe(newer);

    const outside = select({ gaps: [gapLayout(55.5, row)] });
    expect(outside).toBeNull();
  });

  test("uses the viewport center to select the nearest available side of an internal gap", () => {
    const older = boundary("newer", "progress:older-side");
    const newer = boundary("older", "progress:newer-side");
    const row = gapRow({ olderBoundary: older, newerBoundary: newer });
    const layout = gapLayout(1_000, row);

    const fromAbove = select({
      viewportStartPx: 800,
      viewportEndPx: 1_020,
      gaps: [layout],
    });
    expect(fromAbove).toBe(older);

    const fromBelow = select({
      viewportStartPx: 1_120,
      viewportEndPx: 1_340,
      gaps: [layout],
    });
    expect(fromBelow).toBe(newer);
  });

  test("selects only the nearest boundary across all eligible gaps", () => {
    const far = boundary("older", "progress:far");
    const near = boundary("newer", "progress:near");
    const result = select({
      gaps: [
        gapLayout(300, gapRow({ key: "gap:far", newerBoundary: far })),
        gapLayout(900, gapRow({ key: "gap:near", olderBoundary: near })),
      ],
    });

    expect(result).toBe(near);
  });

  test("serializes pending viewport changes and loads the newest boundary", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator();
    const first = boundary("older", "first");
    const second = boundary("older", "second");
    const view = (target: CodexHistoryBoundaryRef) => ({
      viewportStartPx: 900,
      viewportEndPx: 1200,
      gaps: [gapLayout(1000, gapRow({ newerBoundary: target }))],
    });
    const requests: CodexHistoryBoundaryRef[] = [];
    let release = (_result: string) => {};
    const load = (target: CodexHistoryBoundaryRef) => {
      requests.push(target);
      return requests.length === 1
        ? new Promise<string>((resolve) => {
            release = resolve;
          })
        : Promise.resolve("applied");
    };
    const pending = coordinator.observeViewport(view(first), load);
    await Promise.resolve();
    expect(coordinator.observeViewport(view(second), load)).toBe(pending);
    expect(requests).toEqual([first]);
    release("applied");
    await pending;
    expect(requests).toEqual([first, second]);
  });

  test("retries a failed boundary on a later observation even with unchanged bounds", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator();
    const view = {
      viewportStartPx: 900,
      viewportEndPx: 1200,
      gaps: [gapLayout(1000, gapRow({ newerBoundary: boundary("older", "retry") }))],
    };
    let calls = 0;
    const load = async () => {
      calls += 1;
      throw new Error("page failed");
    };
    await coordinator.observeViewport(view, load);
    await coordinator.observeViewport(view, load);
    expect(calls).toBe(2);
  });

  test("suppresses an applied boundary within a run but permits it in a later run", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator();
    const view = {
      viewportStartPx: 900,
      viewportEndPx: 1200,
      gaps: [gapLayout(1000, gapRow({ newerBoundary: boundary("older", "same") }))],
    };
    let calls = 0;
    const load = async () => {
      calls += 1;
      void coordinator.observeViewport(view);
      return "applied";
    };
    await coordinator.observeViewport(view, load);
    expect(calls).toBe(1);
    await coordinator.observeViewport(view, load);
    expect(calls).toBe(2);
  });

  test("stops following viewport changes when the view is cleared during a request", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator();
    const view = {
      viewportStartPx: 900,
      viewportEndPx: 1200,
      gaps: [gapLayout(1000, gapRow({ newerBoundary: boundary("older", "clear") }))],
    };
    let calls = 0;
    await coordinator.observeViewport(view, async () => {
      calls += 1;
      void coordinator.observeViewport(null);
      return "stale";
    });
    expect(calls).toBe(1);
  });

  test("consumes explicit scroll permission once per fetch when required", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator({
      requireUserScroll: true,
    });
    const view = {
      viewportStartPx: 900,
      viewportEndPx: 1200,
      gaps: [gapLayout(1000, gapRow({ newerBoundary: boundary("older", "scroll") }))],
    };
    let calls = 0;
    const load = async () => {
      calls += 1;
      return "applied";
    };
    await coordinator.observeViewport(view, load);
    expect(calls).toBe(0);
    coordinator.allowNextFetch();
    await coordinator.observeViewport(view, load);
    await coordinator.observeViewport(view, load);
    expect(calls).toBe(1);
  });

  test("does not request after the history gap is exhausted", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator();
    let requests = 0;
    await coordinator.observeViewport(
      { viewportStartPx: 0, viewportEndPx: 800, gaps: [] },
      async () => {
        requests += 1;
      },
    );
    expect(requests).toBe(0);
  });
});

describe("legacy local conversation history row projection", () => {
  const pagination = {
    olderCursor: "cursor:older",
    backwardsCursor: "cursor:older",
    oldestLoadedTurnId: "turn-2",
    isLoadingOlder: false,
    hasLoadedOldest: false,
    loadedTurnCount: 2,
    itemsView: "full" as const,
  };

  test("keeps the 144px legacy gap inert without inventing a Main cursor", () => {
    const rows = projectLocalConversationLegacyHistoryRows({
      conversationId: "thread-1",
      pagination,
      turnKeys: ["turn-2", "turn-3"],
    });

    expect(rows.map((row) => row.kind)).toEqual(["gap", "content", "content"]);
    expect(rows[0]).toMatchObject({
      kind: "gap",
      estimatedHeightPx: 144,
      olderBoundary: null,
      newerBoundary: null,
    });
  });

  test("removes the gap after exhaustion and leaves an invalid cursor inert", () => {
    const complete = projectLocalConversationLegacyHistoryRows({
      conversationId: "thread-1",
      pagination: { ...pagination, olderCursor: null, hasLoadedOldest: true },
      turnKeys: ["turn-1"],
    });
    const inert = projectLocalConversationLegacyHistoryRows({
      conversationId: "thread-1",
      pagination: { ...pagination, olderCursor: null },
      turnKeys: ["turn-2"],
    });

    expect(complete.map((row) => row.kind)).toEqual(["content"]);
    expect(inert[0]).toMatchObject({
      kind: "gap",
      olderBoundary: null,
      newerBoundary: null,
    });
  });
});

describe("LocalConversationHistoryGap", () => {
  test("renders an exact silent 144px virtualized row", () => {
    const view = render(<LocalConversationHistoryGap row={gapRow({})} />);
    const element = view.container.firstElementChild as HTMLElement | null;

    expect(element?.tagName).toBe("DIV");
    expect(element?.getAttribute("aria-hidden")).toBe("true");
    expect(element?.hasAttribute("data-virtualized-turn-content")).toBe(true);
    expect(element?.style.height).toBe("144px");
    expect(element?.textContent).toBe("");
    expect(element?.childElementCount).toBe(0);
    expect(element?.getAttribute("class")).toBeNull();
  });
});
