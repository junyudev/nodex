import { describe, expect, test } from "vite-plus/test";

import type {
  DatabaseViewRenderColumn,
  DatabaseViewRenderRow,
} from "@/lib/database-view-render-model";
import {
  applyOptimisticDatabaseListDrop,
  buildDatabaseListProjection,
  captureDatabaseListScrollAnchor,
  computeDatabaseListVirtualWindow,
  databaseListViewportOccurrenceKeys,
  databaseListScrollTopForOccurrence,
  databaseListMountedActiveOccurrenceKey,
  databaseListGroupKey,
  emptyDatabaseListSelection,
  moveDatabaseListActiveOccurrence,
  isDatabaseListOccurrenceSelected,
  selectAllDatabaseListOccurrences,
  selectDatabaseListOccurrence,
  selectedDatabaseListPageIds,
  restoreDatabaseListScrollTop,
  resolveDatabaseListAuthority,
  syncDatabaseListSelection,
  type DatabaseListPageRow,
} from "./database-list-model";

const row = (
  pageId: string,
  input: Partial<DatabaseViewRenderRow> = {},
): DatabaseViewRenderRow => ({
  pageId,
  pageKey: null,
  groupKey: "build",
  subgroupKey: null,
  title: pageId,
  preview: "",
  plainText: "",
  tags: [],
  taskParentValueRevision: 1,
  documentGeneration: 1,
  documentHeadSeq: 1,
  metadataRevision: 1,
  createdAt: new Date("2026-08-12T00:00:00.000Z"),
  ...input,
});

const column = (rows: readonly DatabaseViewRenderRow[]): DatabaseViewRenderColumn => ({
  id: "build",
  groupKey: "build",
  name: "Build",
  scopeKey: 'key:"build"',
  rows,
});

const listPage = (input: {
  readonly key: string;
  readonly pageId: string;
  readonly groupKey: string;
  readonly depth: number;
  readonly ancestorPageIds?: readonly string[];
  readonly subtreeOccurrenceCount?: number;
  readonly hasChildren?: boolean;
}): DatabaseListPageRow => ({
  kind: "page",
  key: input.key,
  pageId: input.pageId,
  row: row(input.pageId, { groupKey: input.groupKey }),
  groupKey: input.groupKey,
  subgroupKey: null,
  ancestorPageIds: input.ancestorPageIds ?? [],
  depth: input.depth,
  hasChildren: input.hasChildren ?? false,
  subtreeOccurrenceCount: input.subtreeOccurrenceCount ?? 1,
  concreteSubtreePageCount: input.subtreeOccurrenceCount ?? 1,
  subtreeHeight: input.hasChildren ? 1 : 0,
  firstChildOccurrenceKey: null,
  transientKind: "none",
  firstInGroup: false,
  lastInGroup: false,
  height: 44,
});

describe("Database List projection", () => {
  test("reports viewport intersections separately from mounted overscan and preserves duplicate occurrences", () => {
    const rows = [
      listPage({ key: "first", pageId: "same-page", groupKey: "a", depth: 0 }),
      listPage({ key: "second", pageId: "same-page", groupKey: "b", depth: 0 }),
      listPage({ key: "third", pageId: "third-page", groupKey: "b", depth: 0 }),
    ];
    const input = {
      rows,
      scrollTop: 44,
      viewportHeight: 44,
      mountedStartIndex: 0,
      mountedEndIndex: 3,
    };
    expect([...databaseListViewportOccurrenceKeys(input)]).toEqual(["second"]);
    expect([...databaseListViewportOccurrenceKeys({ ...input, scrollTop: 43 })]).toEqual([
      "first",
      "second",
    ]);
    expect([
      ...databaseListViewportOccurrenceKeys({ ...input, scrollTop: 0, viewportHeight: 88 }),
    ]).toEqual(["first", "second"]);
    expect([...databaseListViewportOccurrenceKeys({ ...input, mountedEndIndex: 1 })]).toEqual([]);
    expect([...databaseListViewportOccurrenceKeys({ ...input, viewportHeight: 0 })]).toEqual([]);
  });
  test("never substitutes Board-derived order for an authorized Core List", () => {
    const clientRows = buildDatabaseListProjection({
      columns: [column([row("temporary-board-order")])],
      grouped: false,
      subgrouped: false,
      nested: false,
      collapsedOccurrenceKeys: new Set(),
    });

    expect(
      resolveDatabaseListAuthority({
        coreAuthorized: true,
        coreRows: [],
        clientRows,
      }),
    ).toEqual([]);
    expect(
      resolveDatabaseListAuthority({
        coreAuthorized: false,
        coreRows: [],
        clientRows,
      }),
    ).toBe(clientRows);
  });

  test("uses occurrence identity and keeps a Page nested below its parent", () => {
    const projection = buildDatabaseListProjection({
      columns: [
        column([
          row("parent"),
          row("child", { parentPageId: "parent" }),
          row("grandchild", { parentPageId: "child" }),
        ]),
      ],
      grouped: true,
      subgrouped: false,
      nested: true,
      collapsedOccurrenceKeys: new Set(),
    });
    const pages = projection.filter((item) => item.kind === "page");

    expect(pages.map((item) => [item.pageId, item.depth])).toEqual([
      ["parent", 0],
      ["child", 1],
      ["grandchild", 2],
    ]);
    expect(new Set(pages.map((item) => item.key)).size).toBe(3);
  });

  test("collapsing a stable group key removes its issue occurrences", () => {
    const projection = buildDatabaseListProjection({
      columns: [column([row("one"), row("two")])],
      grouped: true,
      subgrouped: false,
      nested: false,
      collapsedOccurrenceKeys: new Set([databaseListGroupKey("build")]),
    });

    expect(projection).toHaveLength(1);
    expect(projection[0]).toMatchObject({ kind: "group", collapsed: true });
  });

  test("computes bounded windows without losing logical scroll height", () => {
    const projection = buildDatabaseListProjection({
      columns: [column(Array.from({ length: 200 }, (_, index) => row(`p-${index}`)))],
      grouped: true,
      subgrouped: false,
      nested: false,
      collapsedOccurrenceKeys: new Set(),
    });
    const window = computeDatabaseListVirtualWindow(projection, 2_000, 500, 100);

    expect(window.startIndex).toBeGreaterThan(0);
    expect(window.endIndex).toBeLessThan(projection.length);
    expect(window.paddingStart).toBeGreaterThan(0);
    expect(window.paddingStart + window.paddingEnd).toBeLessThan(window.totalHeight);
  });

  test("keeps the mounted slice bounded for a 10k occurrence projection", () => {
    const projection = buildDatabaseListProjection({
      columns: [
        column(
          Array.from({ length: 10_000 }, (_, index) =>
            row(`page-${index.toString().padStart(5, "0")}`),
          ),
        ),
      ],
      grouped: true,
      subgrouped: false,
      nested: false,
      collapsedOccurrenceKeys: new Set(),
    });
    const window = computeDatabaseListVirtualWindow(projection, 44 * 5_000, 900, 100);

    expect(window.endIndex - window.startIndex).toBeLessThan(32);
    expect(window.totalHeight).toBe(38 + 44 * 10_000);
  });

  test("keeps one roving tab stop when the logical active row is outside the mounted window", () => {
    const projection = buildDatabaseListProjection({
      columns: [column(Array.from({ length: 100 }, (_, index) => row(`p-${index}`)))],
      grouped: true,
      subgrouped: false,
      nested: false,
      collapsedOccurrenceKeys: new Set(),
    });
    const firstPage = projection.find((item) => item.kind === "page");
    if (!firstPage) throw new Error("missing active row fixture");

    const mountedActive = databaseListMountedActiveOccurrenceKey({
      rows: projection,
      startIndex: 70,
      endIndex: 80,
      activeOccurrenceKey: firstPage.key,
    });

    expect(mountedActive).toBe(projection.slice(70, 80).find((item) => item.kind === "page")?.key);
  });

  test("restores a logical row anchor after rows are inserted above it", () => {
    const before = buildDatabaseListProjection({
      columns: [column([row("one"), row("two"), row("three")])],
      grouped: true,
      subgrouped: false,
      nested: false,
      collapsedOccurrenceKeys: new Set(),
    });
    const anchor = captureDatabaseListScrollAnchor(before, 38 + 44 + 11);
    expect(anchor).toMatchObject({ intraRowOffset: 11 });
    if (!anchor) throw new Error("missing scroll anchor");
    const after = buildDatabaseListProjection({
      columns: [column([row("inserted"), row("one"), row("two"), row("three")])],
      grouped: true,
      subgrouped: false,
      nested: false,
      collapsedOccurrenceKeys: new Set(),
    });

    expect(restoreDatabaseListScrollTop(after, anchor)).toBe(38 + 44 * 2 + 11);
  });

  test("scrolls a virtualized keyboard occurrence into the nearest viewport edge", () => {
    const projection = buildDatabaseListProjection({
      columns: [column(Array.from({ length: 100 }, (_, index) => row(`p-${index}`)))],
      grouped: true,
      subgrouped: false,
      nested: false,
      collapsedOccurrenceKeys: new Set(),
    });
    const target = projection.find((item) => item.kind === "page" && item.pageId === "p-80");
    if (!target) throw new Error("missing keyboard target fixture");

    expect(
      databaseListScrollTopForOccurrence({
        rows: projection,
        occurrenceKey: target.key,
        viewportTop: 0,
        viewportHeight: 440,
      }),
    ).toBe(38 + 44 * 81 - 440);
    expect(
      databaseListScrollTopForOccurrence({
        rows: projection,
        occurrenceKey: target.key,
        viewportTop: 38 + 44 * 78,
        viewportHeight: 440,
      }),
    ).toBe(38 + 44 * 78);
  });

  test("keeps a moved subtree contiguous in the optimistic drop overlay", () => {
    const before = buildDatabaseListProjection({
      columns: [column([row("parent"), row("child", { parentPageId: "parent" }), row("root-b")])],
      grouped: true,
      subgrouped: false,
      nested: true,
      collapsedOccurrenceKeys: new Set(),
    });
    const parent = before.find((item) => item.kind === "page" && item.pageId === "parent");
    if (!parent) throw new Error("missing parent fixture");

    const optimistic = applyOptimisticDatabaseListDrop({
      rows: before,
      occurrenceKeys: new Set([
        before.find((item) => item.kind === "page" && item.pageId === "root-b")!.key,
      ]),
      targetOccurrenceKey: parent.key,
      position: "nest",
      groupKey: "build",
      subgroupKey: null,
    });

    expect(
      optimistic.flatMap((item) =>
        item.kind === "page" ? [[item.pageId, item.depth, item.ancestorPageIds]] : [],
      ),
    ).toEqual([
      ["parent", 0, []],
      ["child", 1, ["parent"]],
      ["root-b", 1, ["parent"]],
    ]);
  });

  test("keeps duplicate Page occurrences anchored to their own optimistic roots", () => {
    const duplicateAtRoot = listPage({
      key: "duplicate:root",
      pageId: "duplicate",
      groupKey: "triage",
      depth: 0,
      subtreeOccurrenceCount: 1,
    });
    const duplicateNested = listPage({
      key: "duplicate:nested",
      pageId: "duplicate",
      groupKey: "build",
      depth: 2,
      ancestorPageIds: ["outer", "inner"],
      subtreeOccurrenceCount: 2,
      hasChildren: true,
    });
    const nestedChild = listPage({
      key: "duplicate:nested:child",
      pageId: "child",
      groupKey: "build",
      depth: 3,
      ancestorPageIds: ["outer", "inner", "duplicate"],
    });
    const target = listPage({
      key: "target",
      pageId: "target",
      groupKey: "ship",
      depth: 0,
    });

    const projected = applyOptimisticDatabaseListDrop({
      rows: [duplicateAtRoot, duplicateNested, nestedChild, target],
      occurrenceKeys: new Set(["duplicate:nested"]),
      targetOccurrenceKey: "target",
      position: "after",
      groupKey: "ship",
      subgroupKey: null,
    });
    const movedRoot = projected.find((row) => row.key === "duplicate:nested");
    const movedChild = projected.find((row) => row.key === "duplicate:nested:child");

    expect(movedRoot).toMatchObject({ depth: 0, ancestorPageIds: [] });
    expect(movedChild).toMatchObject({
      depth: 1,
      ancestorPageIds: ["duplicate"],
    });
  });
});

describe("Database List occurrence selection", () => {
  const projection = buildDatabaseListProjection({
    columns: [column([row("one"), row("two"), row("three")])],
    grouped: true,
    subgrouped: false,
    nested: false,
    collapsedOccurrenceKeys: new Set(),
  });
  const pages = projection.filter((item) => item.kind === "page");

  test("ranges skip group rows and domain mutations deduplicate Page ids", () => {
    const first = selectDatabaseListOccurrence({
      state: emptyDatabaseListSelection(),
      rows: projection,
      occurrenceKey: pages[0]!.key,
      mode: "replace",
    });
    const range = selectDatabaseListOccurrence({
      state: first,
      rows: projection,
      occurrenceKey: pages[2]!.key,
      mode: "range",
    });

    expect(range.selectedOccurrenceKeys.size).toBe(3);
    expect(selectedDatabaseListPageIds(projection, range)).toEqual(
      new Set(["one", "two", "three"]),
    );
  });

  test("keyboard movement keeps active state separate until range extension", () => {
    const active = moveDatabaseListActiveOccurrence({
      state: emptyDatabaseListSelection(),
      rows: projection,
      direction: 1,
      extendSelection: false,
    });
    expect(active.activeOccurrenceKey).toBe(pages[0]!.key);
    expect(active.selectedOccurrenceKeys.size).toBe(0);

    const extended = moveDatabaseListActiveOccurrence({
      state: active,
      rows: projection,
      direction: 1,
      extendSelection: true,
    });
    expect(extended.selectedOccurrenceKeys).toEqual(new Set([pages[0]!.key, pages[1]!.key]));
  });

  test("represents select-all sparsely and tracks occurrence exclusions", () => {
    const active = {
      ...emptyDatabaseListSelection(),
      activeOccurrenceKey: pages[1]!.key,
    };
    const all = selectAllDatabaseListOccurrences({
      state: active,
      rows: projection,
    });
    expect(all.selectedOccurrenceKeys.size).toBe(0);
    expect(pages.every((item) => isDatabaseListOccurrenceSelected(all, item.key))).toBe(true);
    expect(all.activeOccurrenceKey).toBe(pages[1]!.key);

    const excluded = selectDatabaseListOccurrence({
      state: all,
      rows: projection,
      occurrenceKey: pages[1]!.key,
      mode: "toggle",
    });
    expect(excluded.allMatching).toBe(true);
    expect(isDatabaseListOccurrenceSelected(excluded, pages[1]!.key)).toBe(false);
    expect(selectedDatabaseListPageIds(projection, excluded)).toEqual(new Set(["one", "three"]));
  });

  test("preserves selection identity when a refreshed projection changes no keys", () => {
    const first = pages[0]!;
    const state = {
      selectedOccurrenceKeys: new Set([first.key]),
      allMatching: false,
      excludedOccurrenceKeys: new Set<string>(),
      anchorOccurrenceKey: first.key,
      activeOccurrenceKey: first.key,
    };

    expect(syncDatabaseListSelection(state, [...projection], projection)).toBe(state);
  });
});
