import { describe, expect, test } from "vite-plus/test";
import type { SubagentOverviewRow } from "../../agent-runtime-subagent-overview";
import {
  DELEGATION_MAP_GEOMETRY as GEOMETRY,
  delegationEdgeState,
  delegationRailBranchPath,
  delegationRailRunPath,
  delegationRailTrunkPath,
  projectDelegationMap,
  summarizeDelegation,
} from "./delegation-map-model";

function row(threadId: string, overrides: Partial<SubagentOverviewRow> = {}): SubagentOverviewRow {
  return {
    threadId,
    identityThreadId: threadId,
    parentThreadId: "root",
    displayName: threadId,
    actorName: threadId,
    agentRole: null,
    spawnModel: null,
    objective: null,
    status: "active",
    statusSummary: null,
    startedAtMs: 1_000,
    lastActivityAtMs: 1_000,
    completedAtMs: null,
    recencyAtMs: 1_000,
    diffStats: null,
    canOpen: true,
    canInteract: true,
    ...overrides,
  };
}

const project = (rows: readonly SubagentOverviewRow[], moreAbove = false) =>
  projectDelegationMap({ rootThreadId: "root", rows, moreAbove });
const keys = (map: ReturnType<typeof project>) => map.nodes.map((node) => node.row.threadId);

describe("projectDelegationMap", () => {
  test("keeps subagents in the order they were delegated, whatever their status", () => {
    const rows = [
      row("docs", { startedAtMs: 4_000 }),
      row("routes", { startedAtMs: 1_000 }),
      row("tests", { startedAtMs: 3_000 }),
      row("migration", { startedAtMs: 2_000 }),
    ];
    expect(keys(project(rows))).toEqual(["routes", "migration", "tests", "docs"]);

    // The overview lists settled subagents apart from live ones; a card still holds its place.
    const settled = rows.map((entry) =>
      entry.threadId === "routes"
        ? { ...entry, status: "done" as const, recencyAtMs: 9_000, outcome: "completed" as const }
        : entry,
    );
    const map = project([...settled.slice(1), settled[0]!]);
    expect(keys(map)).toEqual(["routes", "migration", "tests", "docs"]);
    expect(map.nodes.map((node) => node.edge)).toEqual([
      "returned",
      "flowing",
      "flowing",
      "flowing",
    ]);
  });

  test("keeps a card in place when a follow-up turn starts after its siblings", () => {
    const map = project([
      row("routes", { startedAtMs: 2_000 }),
      // A follow-up turn started last, but the subagent was delegated first.
      row("migration", { startedAtMs: 9_000, delegatedAtMs: 1_000 }),
    ]);
    expect(keys(map)).toEqual(["migration", "routes"]);
    expect(map.nodes.map((node) => node.edge)).toEqual(["flowing", "flowing"]);
  });

  test("hangs each subagent under whoever delegated it", () => {
    const map = project([
      row("b", { startedAtMs: 2_000 }),
      row("a", { startedAtMs: 1_000 }),
      row("a2", { parentThreadId: "a", startedAtMs: 4_000 }),
      row("a1", { parentThreadId: "a", startedAtMs: 3_000 }),
      row("a1x", { parentThreadId: "a1", startedAtMs: 5_000 }),
    ]);
    expect(map.nodes.map((node) => [node.row.threadId, node.depth])).toEqual([
      ["a", 1],
      ["a1", 2],
      ["a1x", 3],
      ["a2", 2],
      ["b", 1],
    ]);
    expect(map.maxDepth).toBe(3);
    const rail = (parentKey: string | null) =>
      map.rails.find((candidate) => candidate.parentKey === parentKey)!;
    expect(rail(null).nodes.map((node) => node.row.threadId)).toEqual(["a", "b"]);
    expect(rail("a").nodes.map((node) => node.row.threadId)).toEqual(["a1", "a2"]);
    // A subagent's rail leaves from the bottom of its own card, one step in from it.
    const a = map.nodes[0]!;
    expect(rail("a").top).toBe(a.top + a.height);
    expect(rail("a").depth).toBe(1);
    expect(rail(null).top).toBe(-GEOMETRY.leadGap);
  });

  test("hangs a subagent from the lead when its delegator is missing or loops", () => {
    const map = project([
      row("orphan", { parentThreadId: "unloaded" }),
      row("self", { parentThreadId: "self" }),
      row("x", { parentThreadId: "y" }),
      row("y", { parentThreadId: "x" }),
      row("unknown", { parentThreadId: null }),
    ]);
    expect(map.nodes.every((node) => node.depth === 1)).toBe(true);
    expect(map.nodes).toHaveLength(5);
  });

  test("folds settled subagents to a line once the tree outgrows full cards", () => {
    const few = project([
      ...Array.from({ length: GEOMETRY.fullCardBudget - 1 }, (_, index) =>
        row(`done-${index}`, { status: "done", startedAtMs: index }),
      ),
      row("live", { startedAtMs: 100 }),
    ]);
    expect(few.nodes.every((node) => node.density === "full")).toBe(true);

    const many = project([
      ...Array.from({ length: GEOMETRY.fullCardBudget }, (_, index) =>
        row(`done-${index}`, { status: "done", startedAtMs: index }),
      ),
      row("live", { startedAtMs: 100 }),
    ]);
    expect(many.nodes.map((node) => node.density)).toEqual([
      ...Array.from({ length: GEOMETRY.fullCardBudget }, () => "compact"),
      "full",
    ]);
    const [first, second] = many.nodes;
    expect(second!.top - first!.top).toBe(GEOMETRY.compactHeight + GEOMETRY.gap);
  });

  test("centers the lead on a short column and stops it beside a long one", () => {
    const one = project([row("only")]);
    // One card is shorter than the lead, so the card centers on the lead instead.
    expect(one.beside.leadTop).toBe(0);
    expect(one.beside.columnTop).toBe((GEOMETRY.leadHeight - GEOMETRY.fullHeight) / 2);
    expect(one.beside.columnTop + one.nodes[0]!.centerY).toBe(one.beside.leadCenterY);
    expect(one.beside.height).toBe(GEOMETRY.leadHeight);

    const four = project(
      ["a", "b", "c", "d"].map((key, index) => row(key, { startedAtMs: index })),
    );
    expect(four.beside.columnTop).toBe(0);
    expect(four.beside.leadCenterY).toBe(four.columnHeight / 2);

    const long = project(
      Array.from({ length: 6 }, (_, index) => row(`n-${index}`, { startedAtMs: index })),
    );
    expect(long.beside.leadCenterY).toBe(GEOMETRY.leadPinY);
    expect(long.beside.height).toBe(long.columnHeight);
  });

  test("keeps the lead at the top of its column when maps are stacked", () => {
    const rows = Array.from({ length: 4 }, (_, index) => row(`t-${index}`, { startedAtMs: index }));
    const map = projectDelegationMap({
      rootThreadId: "root",
      rows,
      moreAbove: false,
      leadPlacement: "top",
    });
    expect(map.beside.leadTop).toBe(0);
    expect(map.beside.columnTop).toBe(0);
    expect(map.beside.leadCenterY).toBe(GEOMETRY.leadHeight / 2);
    expect(map.beside.height).toBe(map.columnHeight);

    const alone = projectDelegationMap({
      rootThreadId: "root",
      rows: [],
      moreAbove: false,
      leadPlacement: "top",
    });
    expect(alone.beside.height).toBe(GEOMETRY.leadHeight);
  });

  test("leaves room above the first card for the subagents not shown yet", () => {
    const map = project([row("a")], true);
    expect(map.nodes[0]!.top).toBe(GEOMETRY.moreHeight + GEOMETRY.gap);
    expect(map.columnHeight).toBe(GEOMETRY.moreHeight + GEOMETRY.gap + GEOMETRY.fullHeight);
  });

  test("draws nothing for an empty tree", () => {
    const map = project([]);
    expect(map.nodes).toEqual([]);
    expect(map.rails).toEqual([]);
    expect(map.columnHeight).toBe(0);
  });
});

test("an edge says how the delegated work stands", () => {
  expect(delegationEdgeState(row("a"))).toBe("flowing");
  expect(delegationEdgeState(row("a", { status: "waiting" }))).toBe("paused");
  expect(delegationEdgeState(row("a", { attentionKind: "approval" }))).toBe("paused");
  expect(delegationEdgeState(row("a", { status: "unknown" }))).toBe("paused");
  expect(delegationEdgeState(row("a", { status: "done" }))).toBe("returned");
  expect(delegationEdgeState(row("a", { status: "done", outcome: "completed" }))).toBe("returned");
  // A provider's own batch that went idle is back with its delegator, not lost.
  expect(delegationEdgeState(row("a", { status: "done", outcome: "idle" }))).toBe("returned");
  for (const outcome of ["failed", "stopped", "cancelled"] as const)
    expect(delegationEdgeState(row("a", { status: "done", outcome }))).toBe("ended");
});

test("a rail runs from its delegator, turns into each card, and stops at the last turn", () => {
  const map = project([row("a", { startedAtMs: 1 }), row("b", { startedAtMs: 2 })]);
  const rail = map.rails[0]!;
  const [a, b] = rail.nodes;
  const x = GEOMETRY.railX;
  const r = GEOMETRY.railRadius;
  expect(delegationRailTrunkPath(rail)).toBe(`M${x},${rail.top} V${b!.centerY - r}`);
  expect(delegationRailBranchPath(rail, a!)).toBe(
    `M${x},${a!.centerY - r} Q${x},${a!.centerY} ${x + r},${a!.centerY} H${GEOMETRY.indent}`,
  );
  // Work under way runs down the shared line only as far as the last subagent still working.
  expect(delegationRailTrunkPath(rail, a!)).toBe(`M${x},${rail.top} V${a!.centerY - r}`);
  // Work travels the whole way from the delegator, so its run starts where the rail does.
  expect(delegationRailRunPath(rail, b!).startsWith(`M${x},${rail.top} V`)).toBe(true);
  expect(delegationRailRunPath(rail, b!).endsWith(`H${GEOMETRY.indent}`)).toBe(true);
});

test("counts the whole tree, including subagents on pages not loaded yet", () => {
  expect(
    summarizeDelegation({
      active: { totalCount: 2, knownCount: 2 },
      done: { totalCount: 13, knownCount: 10 },
    }),
  ).toEqual({ total: 15, back: 13 });
  expect(
    summarizeDelegation({
      active: { totalCount: null, knownCount: 3 },
      done: { totalCount: null, knownCount: 1 },
    }),
  ).toEqual({ total: 4, back: 1 });
});
