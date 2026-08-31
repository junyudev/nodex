import { describe, expect, test } from "vite-plus/test";
import { render } from "../../../test/dom";
import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
} from "../../../../shared/codex-conversation-state/codex-history-topology";
import {
  CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX,
  createLocalConversationHistoryGapLoadControllerState,
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
  readonly viewportRevision?: number;
  readonly viewportStartPx?: number;
  readonly viewportEndPx?: number;
  readonly gaps: readonly LocalConversationHistoryGapLayout[];
  readonly activeProgressKeys?: ReadonlySet<string>;
}) {
  return selectLocalConversationHistoryGapBoundary(
    createLocalConversationHistoryGapLoadControllerState(),
    {
      viewportRevision: input.viewportRevision ?? 1,
      viewportStartPx: input.viewportStartPx ?? 1_000,
      viewportEndPx: input.viewportEndPx ?? 1_200,
      gaps: input.gaps,
      activeProgressKeys: input.activeProgressKeys ?? new Set(),
    },
  );
}

describe("local conversation history gap controller", () => {
  test("selects a boundary at the inclusive 800px proximity edge", () => {
    const newer = boundary("older", "progress:near");
    const row = gapRow({ newerBoundary: newer });
    const result = select({ gaps: [gapLayout(56, row)] });

    expect(CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX).toBe(800);
    expect(result.boundary).toBe(newer);

    const outside = select({ gaps: [gapLayout(55.5, row)] });
    expect(outside.boundary).toBeNull();
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
    expect(fromAbove.boundary).toBe(older);

    const fromBelow = select({
      viewportStartPx: 1_120,
      viewportEndPx: 1_340,
      gaps: [layout],
    });
    expect(fromBelow.boundary).toBe(newer);
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

    expect(result.boundary).toBe(near);
  });

  test("deduplicates active progress and leaves an unconsumed revision retryable", () => {
    const older = boundary("newer", "progress:active");
    const newer = boundary("older", "progress:available");
    const row = gapRow({ olderBoundary: older, newerBoundary: newer });
    const first = select({
      gaps: [gapLayout(1_000, row)],
      activeProgressKeys: new Set([older.progressKey]),
    });
    expect(first.boundary).toBe(newer);

    const initialState = createLocalConversationHistoryGapLoadControllerState();
    const blocked = selectLocalConversationHistoryGapBoundary(initialState, {
      viewportRevision: 5,
      viewportStartPx: 900,
      viewportEndPx: 1_200,
      gaps: [gapLayout(1_000, row)],
      activeProgressKeys: new Set([older.progressKey, newer.progressKey]),
    });
    expect(blocked).toEqual({ boundary: null, state: initialState });

    const retry = selectLocalConversationHistoryGapBoundary(blocked.state, {
      viewportRevision: 5,
      viewportStartPx: 900,
      viewportEndPx: 1_200,
      gaps: [gapLayout(1_000, row)],
      activeProgressKeys: new Set(),
    });
    expect(retry.boundary).toBe(older);
  });

  test("allows at most one request for a viewport revision and rejects stale revisions", () => {
    const firstBoundary = boundary("older", "progress:first");
    const secondBoundary = boundary("older", "progress:second");
    const first = select({
      viewportRevision: 9,
      gaps: [gapLayout(900, gapRow({ newerBoundary: firstBoundary }))],
    });
    expect(first.boundary).toBe(firstBoundary);

    const repeated = selectLocalConversationHistoryGapBoundary(first.state, {
      viewportRevision: 9,
      viewportStartPx: 1_000,
      viewportEndPx: 1_200,
      gaps: [gapLayout(900, gapRow({ newerBoundary: secondBoundary }))],
      activeProgressKeys: new Set(),
    });
    expect(repeated.boundary).toBeNull();

    const stale = selectLocalConversationHistoryGapBoundary(first.state, {
      viewportRevision: 8,
      viewportStartPx: 1_000,
      viewportEndPx: 1_200,
      gaps: [gapLayout(900, gapRow({ newerBoundary: secondBoundary }))],
      activeProgressKeys: new Set(),
    });
    expect(stale.boundary).toBeNull();

    const next = selectLocalConversationHistoryGapBoundary(first.state, {
      viewportRevision: 10,
      viewportStartPx: 1_000,
      viewportEndPx: 1_200,
      gaps: [gapLayout(900, gapRow({ newerBoundary: secondBoundary }))],
      activeProgressKeys: new Set(),
    });
    expect(next.boundary).toBe(secondBoundary);
  });

  test("requests one nearby page, deduplicates active progress, and waits for a later revision", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator();
    const progress = boundary("older", "progress:page-1");
    const layout = gapLayout(1_000, gapRow({ newerBoundary: progress }));
    const pending = { release: () => {} };
    const requests: CodexHistoryBoundaryRef[] = [];
    const request = (requestedBoundary: CodexHistoryBoundaryRef) => {
      requests.push(requestedBoundary);
      return new Promise<void>((resolve) => {
        pending.release = resolve;
      });
    };

    coordinator.observeViewport(
      { viewportRevision: 1, viewportStartPx: 900, viewportEndPx: 1_200, gaps: [layout] },
      request,
    );
    coordinator.observeViewport(
      { viewportRevision: 1, viewportStartPx: 900, viewportEndPx: 1_200, gaps: [layout] },
      request,
    );
    await Promise.resolve();

    expect(requests).toEqual([progress]);
    expect(coordinator.activeProgressKeys()).toEqual(new Set([progress.progressKey]));

    coordinator.observeViewport(
      { viewportRevision: 2, viewportStartPx: 900, viewportEndPx: 1_200, gaps: [layout] },
      request,
    );
    expect(requests).toEqual([progress]);

    pending.release();
    await Promise.resolve();
    await Promise.resolve();
    coordinator.observeViewport(
      { viewportRevision: 2, viewportStartPx: 900, viewportEndPx: 1_200, gaps: [layout] },
      request,
    );
    await Promise.resolve();

    expect(requests).toEqual([progress, progress]);
  });

  test("releases a failed progress key for retry without retrying the consumed revision", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator();
    const progress = boundary("older", "progress:retry");
    const layout = gapLayout(1_000, gapRow({ newerBoundary: progress }));
    let requests = 0;
    const request = async () => {
      requests += 1;
      throw new Error("page failed");
    };

    coordinator.observeViewport(
      { viewportRevision: 4, viewportStartPx: 900, viewportEndPx: 1_200, gaps: [layout] },
      request,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    coordinator.observeViewport(
      { viewportRevision: 4, viewportStartPx: 900, viewportEndPx: 1_200, gaps: [layout] },
      request,
    );
    coordinator.observeViewport(
      { viewportRevision: 5, viewportStartPx: 900, viewportEndPx: 1_200, gaps: [layout] },
      request,
    );
    await Promise.resolve();

    expect(requests).toBe(2);
  });

  test("does not request after the history gap is exhausted", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator();
    let requests = 0;
    coordinator.observeViewport(
      { viewportRevision: 1, viewportStartPx: 0, viewportEndPx: 800, gaps: [] },
      async () => {
        requests += 1;
      },
    );
    await Promise.resolve();
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
