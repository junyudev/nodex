import { describe, expect, test } from "vite-plus/test";

import type { DatabaseListProjectionRow } from "./database-list-model";
import {
  resolveDatabaseListBlockDropPreview,
  resolveDatabaseListBlockDropRejection,
} from "./database-list-block-drop";

const page = (
  key: string,
  overrides: Partial<Extract<DatabaseListProjectionRow, { readonly kind: "page" }>> = {},
): Extract<DatabaseListProjectionRow, { readonly kind: "page" }> => ({
  kind: "page",
  key,
  pageId: key,
  row: {} as never,
  groupKey: null,
  subgroupKey: null,
  ancestorPageIds: [],
  depth: 0,
  hasChildren: false,
  subtreeOccurrenceCount: 1,
  concreteSubtreePageCount: 1,
  subtreeHeight: 0,
  firstChildOccurrenceKey: null,
  transientKind: "none",
  firstInGroup: false,
  lastInGroup: false,
  height: 44,
  ...overrides,
});

describe("Database List external Block drop", () => {
  test("keeps search and incomplete projection states from accepting a transfer", () => {
    const ready = {
      pageDragActive: false,
      searchActive: false,
      projectionReady: true,
    };
    expect(resolveDatabaseListBlockDropRejection(ready)).toBeNull();
    expect(
      resolveDatabaseListBlockDropRejection({
        ...ready,
        searchActive: true,
      }),
    ).toBe("Clear search to add Blocks as Pages");
    expect(
      resolveDatabaseListBlockDropRejection({
        ...ready,
        projectionReady: false,
      }),
    ).toBe("Wait for the List to finish loading");
  });

  test("maps row halves to stable root gaps", () => {
    const rows = [page("a"), page("b")];
    expect(
      resolveDatabaseListBlockDropPreview({
        rows,
        overOccurrenceKey: "a",
        pointerY: 30,
        rowTop: 0,
        rowBottom: 44,
        exactSlot: true,
      }),
    ).toMatchObject({
      target: { kind: "page", occurrenceKey: "b", edge: "before" },
      feedback: { kind: "line", occurrenceKey: "b", edge: "before" },
    });
  });

  test("collapses nested rows to their subgroup instead of implying nesting", () => {
    const rows: readonly DatabaseListProjectionRow[] = [
      {
        kind: "subgroup",
        key: "subgroup",
        groupKey: "plan",
        subgroupKey: "large",
        label: "Large",
        totalRows: 1,
        height: 32,
      },
      page("child", {
        groupKey: "plan",
        subgroupKey: "large",
        depth: 1,
        ancestorPageIds: ["parent"],
      }),
    ];
    expect(
      resolveDatabaseListBlockDropPreview({
        rows,
        overOccurrenceKey: "child",
        pointerY: 20,
        rowTop: 0,
        rowBottom: 44,
        exactSlot: true,
      }),
    ).toEqual({
      target: { kind: "group", occurrenceKey: "subgroup" },
      feedback: { kind: "surface", occurrenceKey: "subgroup" },
      message: "Drop into this group",
    });
  });

  test("uses a truthful surface target under derived sorting", () => {
    expect(
      resolveDatabaseListBlockDropPreview({
        rows: [page("a")],
        overOccurrenceKey: "a",
        pointerY: 10,
        rowTop: 0,
        rowBottom: 44,
        exactSlot: false,
      }),
    ).toEqual({
      target: { kind: "root" },
      feedback: { kind: "surface", occurrenceKey: null },
      message: "Current sort decides the Page position",
    });
  });
});
