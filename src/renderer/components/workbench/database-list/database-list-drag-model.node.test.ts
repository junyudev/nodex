import { describe, expect, test } from "vite-plus/test";

import {
  databaseListDragTargetChangesPlacement,
  databaseListDropTargetIdentity,
  databaseListProjectionReflectsMove,
  normalizeDatabaseListDropTarget,
  resolveDatabaseListDragSources,
  resolveDatabaseListRawEdge,
} from "./database-list-drag-model";
import {
  emptyDatabaseListSelection,
  type DatabaseListPageRow,
  type DatabaseListProjectionRow,
} from "./database-list-model";

const page = (input: {
  readonly key: string;
  readonly pageId: string;
  readonly depth?: number;
  readonly ancestors?: readonly string[];
  readonly transientKind?: DatabaseListPageRow["transientKind"];
  readonly subtreeOccurrenceCount?: number;
  readonly concreteSubtreePageCount?: number;
  readonly hasChildren?: boolean;
  readonly groupKey?: string;
  readonly parentPageId?: string;
}): DatabaseListPageRow => ({
  kind: "page",
  key: input.key,
  pageId: input.pageId,
  row: {
    pageId: input.pageId,
    pageKey: null,
    groupKey: input.groupKey ?? "build",
    subgroupKey: null,
    title: input.pageId,
    preview: "",
    plainText: "",
    ...(input.parentPageId ? { parentPageId: input.parentPageId } : {}),
    tags: [],
    taskParentValueRevision: 1,
    documentGeneration: 1,
    documentHeadSeq: 1,
    metadataRevision: 1,
    createdAt: new Date("2026-08-13T00:00:00.000Z"),
  },
  groupKey: input.groupKey ?? "build",
  subgroupKey: null,
  ancestorPageIds: input.ancestors ?? [],
  depth: input.depth ?? 0,
  hasChildren: input.hasChildren ?? false,
  transientKind: input.transientKind ?? "none",
  subtreeOccurrenceCount: input.subtreeOccurrenceCount ?? 1,
  concreteSubtreePageCount: input.concreteSubtreePageCount ?? 1,
  subtreeHeight: 0,
  firstChildOccurrenceKey: null,
  firstInGroup: false,
  lastInGroup: false,
  height: 44,
});

const selected = (...occurrenceKeys: readonly string[]) => ({
  ...emptyDatabaseListSelection(),
  selectedOccurrenceKeys: new Set(occurrenceKeys),
  activeOccurrenceKey: occurrenceKeys[0] ?? null,
});

const subtree = (): readonly DatabaseListProjectionRow[] => [
  page({
    key: "a",
    pageId: "A",
    hasChildren: true,
    subtreeOccurrenceCount: 4,
    concreteSubtreePageCount: 4,
  }),
  page({
    key: "b",
    pageId: "B",
    depth: 1,
    ancestors: ["A"],
    hasChildren: true,
    subtreeOccurrenceCount: 2,
    concreteSubtreePageCount: 2,
  }),
  page({ key: "c", pageId: "C", depth: 2, ancestors: ["A", "B"] }),
  page({ key: "d", pageId: "D", depth: 1, ancestors: ["A"] }),
  page({ key: "e", pageId: "E" }),
];

describe("Database List receipt materialization", () => {
  const target = {
    targetOccurrenceKey: "anchor",
    targetPageId: "anchor",
    parentPageId: null,
    beforePageId: "anchor",
    groupKey: "build",
    subgroupKey: null,
    depth: 0,
    edge: "before",
  } as const;
  const rootA = page({ key: "a", pageId: "A" });
  const rootB = page({ key: "b", pageId: "B" });
  const anchor = page({ key: "anchor", pageId: "anchor" });

  test.each([
    { name: "all roots missing", rows: [anchor] },
    { name: "one root missing", rows: [rootA, anchor] },
    { name: "anchor missing", rows: [rootA, rootB] },
    { name: "wrong root order", rows: [rootB, rootA, anchor] },
    {
      name: "a sibling between roots",
      rows: [rootA, page({ key: "other", pageId: "other" }), rootB, anchor],
    },
    {
      name: "a sibling before the anchor",
      rows: [rootA, rootB, page({ key: "other", pageId: "other" }), anchor],
    },
    {
      name: "a transient root instead of concrete evidence",
      rows: [{ ...rootA, transientKind: "ancestor" as const }, rootB, anchor],
    },
    {
      name: "a transient sibling before the anchor",
      rows: [
        rootA,
        rootB,
        page({ key: "context", pageId: "context", transientKind: "ancestor" }),
        anchor,
      ],
    },
  ])("does not settle when $name", ({ rows }) => {
    expect(
      databaseListProjectionReflectsMove({
        rows,
        moveRootPageIds: ["A", "B"],
        normalizedTarget: target,
        complete: true,
      }),
    ).toBe(false);
  });

  test("accepts the exact sibling run while preserving descendants between its roots", () => {
    const rows = [
      rootA,
      page({ key: "child", pageId: "child", parentPageId: "A", depth: 1, ancestors: ["A"] }),
      rootB,
      anchor,
    ];
    expect(
      databaseListProjectionReflectsMove({
        rows,
        moveRootPageIds: ["A", "B"],
        normalizedTarget: target,
      }),
    ).toBe(true);
  });

  test("requires complete authority to prove a true sibling tail", () => {
    const normalizedTarget = { ...target, beforePageId: null };
    const rows = [anchor, rootA, rootB];
    expect(
      databaseListProjectionReflectsMove({ rows, moveRootPageIds: ["A", "B"], normalizedTarget }),
    ).toBe(false);
    expect(
      databaseListProjectionReflectsMove({
        rows,
        moveRootPageIds: ["A", "B"],
        normalizedTarget,
        complete: true,
      }),
    ).toBe(true);
    expect(
      databaseListProjectionReflectsMove({
        rows: [rootA, rootB, anchor],
        moveRootPageIds: ["A", "B"],
        normalizedTarget,
        complete: true,
      }),
    ).toBe(false);
  });

  test("finds the exact destination occurrence without rejecting copies in another group", () => {
    const rows = [
      page({ key: "other-a", pageId: "A", groupKey: "ship" }),
      page({ key: "other-b", pageId: "B", groupKey: "ship" }),
      rootA,
      rootB,
      anchor,
    ];
    expect(
      databaseListProjectionReflectsMove({
        rows,
        moveRootPageIds: ["A", "B"],
        normalizedTarget: target,
      }),
    ).toBe(true);
    expect(
      databaseListProjectionReflectsMove({
        rows: rows.slice(0, 2),
        moveRootPageIds: ["A", "B"],
        normalizedTarget: { ...target, beforePageId: null },
        complete: true,
      }),
    ).toBe(false);
  });

  test("requires the normalized parent as well as sibling order", () => {
    const normalizedTarget = { ...target, parentPageId: "parent", depth: 1 };
    expect(
      databaseListProjectionReflectsMove({
        rows: [rootA, rootB, anchor],
        moveRootPageIds: ["A", "B"],
        normalizedTarget,
      }),
    ).toBe(false);
    const rows = ["A", "B", "anchor"].map((pageId) =>
      page({
        key: `parent/${pageId}`,
        pageId,
        parentPageId: "parent",
        depth: 1,
        ancestors: ["parent"],
      }),
    );
    expect(
      databaseListProjectionReflectsMove({ rows, moveRootPageIds: ["A", "B"], normalizedTarget }),
    ).toBe(true);
  });

  test("does not accept an empty or duplicate root proof", () => {
    expect(
      databaseListProjectionReflectsMove({
        rows: [rootA, anchor],
        moveRootPageIds: [],
        normalizedTarget: target,
      }),
    ).toBe(false);
    expect(
      databaseListProjectionReflectsMove({
        rows: [rootA, rootA, anchor],
        moveRootPageIds: ["A", "A"],
        normalizedTarget: target,
      }),
    ).toBe(false);
  });
});

describe("Database List subtree drag model", () => {
  test("classifies the exact row midpoint as after", () => {
    expect(
      resolveDatabaseListRawEdge({
        pointerY: 122,
        top: 100,
        height: 44,
        explicitInside: false,
      }),
    ).toBe("after");
    expect(
      resolveDatabaseListRawEdge({
        pointerY: 121.999,
        top: 100,
        height: 44,
        explicitInside: false,
      }),
    ).toBe("before");
  });

  test("normalizes an ancestor plus descendant selection to one visible subtree root", () => {
    const rows = subtree();
    const sources = resolveDatabaseListDragSources({
      rows,
      selection: selected("a", "b", "c"),
      initiatorOccurrenceKey: "a",
    });

    expect(sources?.rootRows.map((row) => row.key)).toEqual(["a"]);
    expect([...sources!.visibleClosurePageIds]).toEqual(["A", "B", "C", "D"]);
    expect(sources?.concretePageCount).toBe(4);
  });

  test("skips a transient occurrence without truncating its concrete descendants", () => {
    const rows = [
      page({
        key: "root",
        pageId: "root",
        hasChildren: true,
        subtreeOccurrenceCount: 3,
        concreteSubtreePageCount: 2,
      }),
      page({
        key: "context",
        pageId: "context",
        depth: 1,
        ancestors: ["root"],
        transientKind: "child",
        hasChildren: true,
        subtreeOccurrenceCount: 2,
        concreteSubtreePageCount: 1,
      }),
      page({
        key: "deep",
        pageId: "deep",
        depth: 2,
        ancestors: ["root", "context"],
      }),
    ];
    const sources = resolveDatabaseListDragSources({
      rows,
      selection: selected("root"),
      initiatorOccurrenceKey: "root",
    });

    expect([...sources!.visibleClosurePageIds]).toEqual(["root", "deep"]);
    expect(sources?.concretePageCount).toBe(2);
    expect(
      resolveDatabaseListDragSources({
        rows,
        selection: selected("context"),
        initiatorOccurrenceKey: "context",
      }),
    ).toBeNull();
  });

  test("previews after a parent as the first child slot", () => {
    const rows = subtree();
    const sources = resolveDatabaseListDragSources({
      rows,
      selection: selected("e"),
      initiatorOccurrenceKey: "e",
    });
    const target = normalizeDatabaseListDropTarget({
      rows,
      row: rows[0]!,
      rawEdge: "after",
      sources: sources!,
    });

    expect(target).toMatchObject({
      kind: "page",
      overOccurrenceKey: "a",
      occurrenceKey: "b",
      pointerEdge: "after",
      indicatorEdge: "before",
      prospectiveDepth: 1,
      target: { kind: "page", occurrenceKey: "a", edge: "after" },
    });
  });

  test("canonicalizes both halves of one sibling gap to one stable slot", () => {
    const rows = [
      page({ key: "x", pageId: "X" }),
      page({ key: "y", pageId: "Y" }),
      page({ key: "z", pageId: "Z" }),
    ];
    const sources = resolveDatabaseListDragSources({
      rows,
      selection: selected("z"),
      initiatorOccurrenceKey: "z",
    })!;
    const lowerHalf = normalizeDatabaseListDropTarget({
      rows,
      row: rows[0]!,
      rawEdge: "after",
      sources,
    });
    const upperHalf = normalizeDatabaseListDropTarget({
      rows,
      row: rows[1]!,
      rawEdge: "before",
      sources,
    });

    expect(lowerHalf).toMatchObject({
      overOccurrenceKey: "x",
      occurrenceKey: "y",
      indicatorEdge: "before",
      target: { kind: "page", occurrenceKey: "x", edge: "after" },
    });
    expect(upperHalf).toMatchObject({
      overOccurrenceKey: "y",
      occurrenceKey: "y",
      indicatorEdge: "before",
    });
    expect(databaseListDropTargetIdentity(lowerHalf)).toBe(
      databaseListDropTargetIdentity(upperHalf),
    );
  });

  test("treats a drop back into the source's current sibling slot as a no-op", () => {
    const rows = [
      page({ key: "x", pageId: "X" }),
      page({ key: "y", pageId: "Y" }),
      page({ key: "z", pageId: "Z" }),
    ];
    const sources = resolveDatabaseListDragSources({
      rows,
      selection: selected("y"),
      initiatorOccurrenceKey: "y",
    })!;
    const target = normalizeDatabaseListDropTarget({
      rows,
      row: rows[0]!,
      rawEdge: "after",
      sources,
    });

    expect(target).toMatchObject({
      overOccurrenceKey: "x",
      occurrenceKey: "x",
      indicatorEdge: "after",
    });
    expect(
      databaseListDragTargetChangesPlacement({
        rows,
        sources,
        target: target!,
      }),
    ).toBe(false);
  });

  test("leaves bounded all-matching no-op authority to Core", () => {
    const rows = [page({ key: "x", pageId: "X" }), page({ key: "y", pageId: "Y" })];
    const sources = resolveDatabaseListDragSources({
      rows,
      selection: {
        ...emptyDatabaseListSelection(),
        allMatching: true,
        excludedOccurrenceKeys: new Set(["x"]),
      },
      initiatorOccurrenceKey: "y",
    })!;
    const target = normalizeDatabaseListDropTarget({
      rows,
      row: rows[0]!,
      rawEdge: "after",
      sources,
    });

    expect(sources.previewClosureComplete).toBe(false);
    expect(
      databaseListDragTargetChangesPlacement({
        rows,
        sources,
        target: target!,
      }),
    ).toBe(true);
  });

  test("rejects every Page target inside the concrete closure", () => {
    const rows = subtree();
    const sources = resolveDatabaseListDragSources({
      rows,
      selection: selected("a"),
      initiatorOccurrenceKey: "a",
    });

    expect(
      normalizeDatabaseListDropTarget({
        rows,
        row: rows[2]!,
        rawEdge: "before",
        sources: sources!,
      }),
    ).toBeNull();
  });

  test("deduplicates a fully visible Page closure for the overlay count", () => {
    const rows = [
      page({ key: "first", pageId: "same" }),
      page({ key: "second", pageId: "same", groupKey: "ship" }),
    ];
    const sources = resolveDatabaseListDragSources({
      rows,
      selection: selected("first", "second"),
      initiatorOccurrenceKey: "first",
    });

    expect(sources?.rootRows).toHaveLength(2);
    expect(sources?.concretePageCount).toBe(1);
  });
});
