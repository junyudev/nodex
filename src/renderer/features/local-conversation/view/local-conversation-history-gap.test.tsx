import { describe, expect, test } from "vite-plus/test";
import { render } from "../../../test/dom";
import { act, fireEvent } from "@testing-library/react";
import type {
  CodexHistoryBoundaryRef,
  CodexHistoryRow,
} from "../../../../shared/codex-conversation-state/codex-history-topology";
import {
  codexConversationHistoryTurnItemsRefKey,
  createCodexConversationHistoryTurnItemsRef,
} from "../../../../shared/codex-conversation-history-page";
import {
  CODEX_HISTORY_GAP_LOAD_PROXIMITY_PX,
  createLocalConversationHistoryGapRequestCoordinator,
  createLocalConversationHistoryRequestGate,
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
  test("a late stale item page cannot stop the same cursor in a new topology", async () => {
    const pagination = {
      source: "ordinary" as const,
      olderCursor: "same-opaque-cursor",
      hasLoadedOldest: false,
      isLoadingOlder: false,
      itemsView: "summary" as const,
    };
    const oldRef = createCodexConversationHistoryTurnItemsRef({
      turnId: "same-turn",
      expectedTopologyGeneration: 3,
      pagination,
    })!;
    const currentRef = createCodexConversationHistoryTurnItemsRef({
      turnId: oldRef.turnId,
      expectedTopologyGeneration: 4,
      pagination,
    })!;
    const gate = createLocalConversationHistoryRequestGate();
    const oldKey = codexConversationHistoryTurnItemsRefKey(oldRef);
    const currentKey = codexConversationHistoryTurnItemsRefKey(currentRef);
    const requested: number[] = [];
    let completeOld!: (result: "stale") => void;
    const oldPage = new Promise<"stale">((resolve) => {
      completeOld = resolve;
    });
    expect(
      gate.request(oldKey, () => {
        requested.push(oldRef.expectedTopologyGeneration);
        return oldPage;
      }),
    ).toBe(true);
    // Re-observing one boundary still coalesces while its physical read is pending.
    expect(gate.request(oldKey, () => Promise.resolve("applied"))).toBe(false);
    gate.retain(new Set([currentKey]));
    completeOld("stale");
    await oldPage;
    expect(gate.unavailableKeys().has(oldKey)).toBe(true);
    gate.retain(new Set([currentKey]));
    expect(
      gate.request(currentKey, () => {
        requested.push(currentRef.expectedTopologyGeneration);
        return Promise.resolve("applied");
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(requested).toEqual([3, 4]);
    expect(gate.unavailableKeys().size).toBe(0);
  });

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

  test("keeps a failed boundary stopped until explicit retry", async () => {
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
    expect(calls).toBe(1);
    expect(coordinator.readState().failed).toHaveLength(1);
    await coordinator.retryBoundary(view.gaps[0]!.row.newerBoundary!);
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

  test("retry FIFO discards replaced boundaries and leaving clears failure state", async () => {
    const coordinator = createLocalConversationHistoryGapRequestCoordinator();
    const first = boundary("older", "failed");
    const replacement = boundary("older", "replacement");
    const viewport = (target: CodexHistoryBoundaryRef) => ({
      viewportStartPx: 900,
      viewportEndPx: 1200,
      gaps: [gapLayout(1000, gapRow({ newerBoundary: target }))],
    });
    const loaded: CodexHistoryBoundaryRef[] = [];
    await coordinator.observeViewport(viewport(first), async (target) => {
      loaded.push(target);
      throw new Error("failed");
    });
    await coordinator.observeViewport(viewport(replacement), async (target) => {
      loaded.push(target);
      return "applied";
    });
    await coordinator.retryBoundary(first);
    expect(loaded).toEqual([first, replacement]);
    expect(coordinator.readState().failed).toEqual([]);
    await coordinator.observeViewport(viewport(replacement), async () => {
      throw new Error("failed again");
    });
    expect(coordinator.readState().failed).toEqual([replacement]);
    await coordinator.observeViewport(null);
    expect(coordinator.readState()).toEqual({ failed: [], loading: null });
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
  test("shows loading and retries only the failed current boundary", async () => {
    const newer = boundary("older", "retry-ui");
    const retry: CodexHistoryBoundaryRef[] = [];
    const view = render(
      <LocalConversationHistoryGap
        row={gapRow({ newerBoundary: newer })}
        state={{ failed: [], loading: newer }}
      />,
    );
    expect(view.getByRole("status").textContent).toBe("Loading history");
    view.rerender(
      <LocalConversationHistoryGap
        row={gapRow({ newerBoundary: newer })}
        state={{ failed: [newer], loading: null }}
        onRetry={(value) => retry.push(value)}
      />,
    );
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Try again" }));
      await Promise.resolve();
    });
    expect(retry).toEqual([newer]);
    const replacement = boundary("older", "replacement");
    view.rerender(
      <LocalConversationHistoryGap
        row={gapRow({ newerBoundary: replacement })}
        state={{ failed: [newer], loading: null }}
      />,
    );
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
  });
});
