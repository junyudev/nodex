import type {
  DatabaseViewRenderColumn,
  DatabaseViewRenderRow,
} from "@/lib/database-view-render-model";
import { projectDataSourcePageRowToDatabaseViewRenderRow } from "@/lib/database-view-render-model";
import type { DataSourcePropertyRecordV2 } from "../../../../shared/database-module-v2";
import type { DatabaseViewConditionalColorRule } from "../../../../shared/database-kernel";
import type { DatabaseListProjectionRowSnapshot } from "../../../../shared/database-views";

export const DATABASE_LIST_GROUP_HEIGHT = 38;
export const DATABASE_LIST_SUBGROUP_HEIGHT = 32;
export const DATABASE_LIST_PAGE_HEIGHT = 44;
export const DATABASE_LIST_MAX_NESTING_DEPTH = 10;

export type DatabaseListProjectionRow =
  | DatabaseListGroupRow
  | DatabaseListSubgroupRow
  | DatabaseListPageRow;

export const resolveDatabaseListAuthority = (input: {
  readonly coreAuthorized: boolean;
  readonly coreRows: readonly DatabaseListProjectionRow[];
  readonly clientRows: readonly DatabaseListProjectionRow[];
}): readonly DatabaseListProjectionRow[] =>
  input.coreAuthorized ? input.coreRows : input.clientRows;

export const databaseListMountedActiveOccurrenceKey = (input: {
  readonly rows: readonly DatabaseListProjectionRow[];
  readonly startIndex: number;
  readonly endIndex: number;
  readonly activeOccurrenceKey: string | null;
}): string | null => {
  const mountedRows = input.rows.slice(input.startIndex, input.endIndex);
  if (mountedRows.some((row) => row.kind === "page" && row.key === input.activeOccurrenceKey)) {
    return input.activeOccurrenceKey;
  }
  return mountedRows.find((row) => row.kind === "page")?.key ?? null;
};

export interface DatabaseListGroupRow {
  readonly kind: "group";
  readonly key: string;
  readonly groupKey: string | null;
  readonly label: string;
  readonly totalRows: number;
  readonly collapsed: boolean;
  readonly height: typeof DATABASE_LIST_GROUP_HEIGHT;
}

export interface DatabaseListSubgroupRow {
  readonly kind: "subgroup";
  readonly key: string;
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
  readonly label: string;
  readonly totalRows: number;
  readonly height: typeof DATABASE_LIST_SUBGROUP_HEIGHT;
}

export interface DatabaseListPageRow {
  readonly kind: "page";
  readonly key: string;
  readonly pageId: string;
  readonly row: DatabaseViewRenderRow;
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
  readonly ancestorPageIds: readonly string[];
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly subtreeOccurrenceCount: number;
  readonly concreteSubtreePageCount: number;
  readonly subtreeHeight: number;
  readonly firstChildOccurrenceKey: string | null;
  readonly transientKind: "none" | "ancestor" | "child";
  readonly firstInGroup: boolean;
  readonly lastInGroup: boolean;
  readonly height: typeof DATABASE_LIST_PAGE_HEIGHT;
}

const pathKey = (values: readonly (string | null)[]): string =>
  values.map((value) => JSON.stringify(value)).join("/");

export const databaseListGroupKey = (groupKey: string | null): string =>
  `GROUP_${pathKey([groupKey])}`;

export const databaseListSubgroupKey = (
  groupKey: string | null,
  subgroupKey: string | null,
): string => `GROUP_${pathKey([groupKey, subgroupKey])}`;

export const databaseListOccurrenceKey = (input: {
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
  readonly ancestorPageIds: readonly string[];
  readonly pageId: string;
}): string =>
  `ITEM_${pathKey([input.groupKey, input.subgroupKey])}_${[...input.ancestorPageIds, input.pageId]
    .map(encodeURIComponent)
    .join("/")}`;

interface NestedRow {
  readonly key: string;
  readonly row: DatabaseViewRenderRow;
  readonly ancestorPageIds: readonly string[];
  readonly depth: number;
  readonly hasChildren: boolean;
  readonly subtreeOccurrenceCount: number;
  readonly subtreeHeight: number;
  readonly firstChildOccurrenceKey: string | null;
}

const nestedRows = (
  rows: readonly DatabaseViewRenderRow[],
  nested: boolean,
  showSubPages: boolean,
  groupKey: string | null,
  subgroupKey: string | null,
): readonly NestedRow[] => {
  const visibleRows = showSubPages ? rows : rows.filter((row) => !row.parentPageId);
  if (!nested) {
    return visibleRows.map((row) => ({
      key: databaseListOccurrenceKey({
        groupKey,
        subgroupKey,
        ancestorPageIds: [],
        pageId: row.pageId,
      }),
      row,
      ancestorPageIds: [],
      depth: 0,
      hasChildren: false,
      subtreeOccurrenceCount: 1,
      subtreeHeight: 0,
      firstChildOccurrenceKey: null,
    }));
  }

  const rowById = new Map(visibleRows.map((row) => [row.pageId, row] as const));
  const childrenByParent = new Map<string, DatabaseViewRenderRow[]>();
  const roots: DatabaseViewRenderRow[] = [];
  for (const row of visibleRows) {
    const parentPageId = row.parentPageId;
    if (!parentPageId || !rowById.has(parentPageId)) {
      roots.push(row);
      continue;
    }
    const children = childrenByParent.get(parentPageId) ?? [];
    children.push(row);
    childrenByParent.set(parentPageId, children);
  }

  const result: NestedRow[] = [];
  const visited = new Set<string>();
  const visit = (
    row: DatabaseViewRenderRow,
    ancestors: readonly string[],
    path: ReadonlySet<string>,
  ): {
    readonly key: string;
    readonly subtreeOccurrenceCount: number;
    readonly subtreeHeight: number;
  } | null => {
    if (visited.has(row.pageId) || path.has(row.pageId)) return null;
    visited.add(row.pageId);
    const key = databaseListOccurrenceKey({
      groupKey,
      subgroupKey,
      ancestorPageIds: ancestors,
      pageId: row.pageId,
    });
    const children = childrenByParent.get(row.pageId) ?? [];
    const hasChildren = children.length > 0;
    const resultIndex = result.length;
    result.push({
      key,
      row,
      ancestorPageIds: ancestors,
      depth: Math.min(ancestors.length, DATABASE_LIST_MAX_NESTING_DEPTH),
      hasChildren,
      subtreeOccurrenceCount: 1,
      subtreeHeight: 0,
      firstChildOccurrenceKey: null,
    });
    if (ancestors.length >= DATABASE_LIST_MAX_NESTING_DEPTH) {
      return { key, subtreeOccurrenceCount: 1, subtreeHeight: 0 };
    }
    const nextPath = new Set(path).add(row.pageId);
    let subtreeOccurrenceCount = 1;
    let subtreeHeight = 0;
    let firstChildOccurrenceKey: string | null = null;
    for (const child of children) {
      const childSubtree = visit(child, [...ancestors, row.pageId], nextPath);
      if (!childSubtree) continue;
      firstChildOccurrenceKey ??= childSubtree.key;
      subtreeOccurrenceCount += childSubtree.subtreeOccurrenceCount;
      subtreeHeight = Math.max(subtreeHeight, childSubtree.subtreeHeight + 1);
    }
    result[resultIndex] = {
      ...result[resultIndex]!,
      subtreeOccurrenceCount,
      subtreeHeight,
      firstChildOccurrenceKey,
    };
    return { key, subtreeOccurrenceCount, subtreeHeight };
  };

  for (const root of roots) visit(root, [], new Set());
  for (const row of visibleRows) visit(row, [], new Set());
  return result;
};

const rowsBySubgroup = (
  column: DatabaseViewRenderColumn,
): readonly {
  readonly subgroupKey: string | null;
  readonly label: string | null;
  readonly rows: readonly DatabaseViewRenderRow[];
}[] => {
  const orderedKeys: (string | null)[] = [];
  const grouped = new Map<string | null, DatabaseViewRenderRow[]>();
  for (const row of column.rows) {
    if (!grouped.has(row.subgroupKey)) orderedKeys.push(row.subgroupKey);
    grouped.set(row.subgroupKey, [...(grouped.get(row.subgroupKey) ?? []), row]);
  }
  return orderedKeys.map((subgroupKey) => ({
    subgroupKey,
    label: subgroupKey,
    rows: grouped.get(subgroupKey) ?? [],
  }));
};

export const buildDatabaseListProjection = (input: {
  readonly columns: readonly DatabaseViewRenderColumn[];
  readonly grouped: boolean;
  readonly subgrouped: boolean;
  readonly showSubPages?: boolean;
  readonly nested: boolean;
  readonly collapsedOccurrenceKeys: ReadonlySet<string>;
  readonly totalRowsByScope?: ReadonlyMap<string, number>;
}): readonly DatabaseListProjectionRow[] => {
  const projection: DatabaseListProjectionRow[] = [];
  for (const column of input.columns) {
    const groupKey = databaseListGroupKey(column.groupKey);
    const collapsed = input.collapsedOccurrenceKeys.has(groupKey);
    if (input.grouped) {
      projection.push({
        kind: "group",
        key: groupKey,
        groupKey: column.groupKey,
        label: column.name,
        totalRows: input.totalRowsByScope?.get(column.scopeKey) ?? column.rows.length,
        collapsed,
        height: DATABASE_LIST_GROUP_HEIGHT,
      });
    }
    if (collapsed) continue;

    const subgroups = input.subgrouped
      ? rowsBySubgroup(column)
      : [{ subgroupKey: null, label: null, rows: column.rows }];
    for (const subgroup of subgroups) {
      if (input.subgrouped) {
        projection.push({
          kind: "subgroup",
          key: databaseListSubgroupKey(column.groupKey, subgroup.subgroupKey),
          groupKey: column.groupKey,
          subgroupKey: subgroup.subgroupKey,
          label: subgroup.label ?? "No value",
          totalRows: subgroup.rows.length,
          height: DATABASE_LIST_SUBGROUP_HEIGHT,
        });
      }
      const materialized = nestedRows(
        subgroup.rows,
        input.nested,
        input.showSubPages !== false,
        column.groupKey,
        subgroup.subgroupKey,
      );
      for (const [index, nestedRow] of materialized.entries()) {
        projection.push({
          kind: "page",
          key: nestedRow.key,
          pageId: nestedRow.row.pageId,
          row: nestedRow.row,
          groupKey: column.groupKey,
          subgroupKey: subgroup.subgroupKey,
          ancestorPageIds: nestedRow.ancestorPageIds,
          depth: nestedRow.depth,
          hasChildren: nestedRow.hasChildren,
          subtreeOccurrenceCount: nestedRow.subtreeOccurrenceCount,
          concreteSubtreePageCount: nestedRow.subtreeOccurrenceCount,
          subtreeHeight: nestedRow.subtreeHeight,
          firstChildOccurrenceKey: nestedRow.firstChildOccurrenceKey,
          transientKind: "none",
          firstInGroup: index === 0,
          lastInGroup: index === materialized.length - 1,
          height: DATABASE_LIST_PAGE_HEIGHT,
        });
      }
    }
  }
  return projection;
};

const coreGroupPathKey = (groupPath: readonly (string | null)[]): string => pathKey(groupPath);

export interface CoreDatabaseListProjection {
  readonly rows: readonly DatabaseListProjectionRow[];
  readonly authorityByPageId: ReadonlyMap<
    string,
    Extract<DatabaseListProjectionRowSnapshot, { readonly kind: "page" }>["row"]
  >;
}

/**
 * Adapts the Core-owned occurrence projection into renderer rows without
 * reconstructing grouping or hierarchy from a bounded client query.
 */
export const projectCoreDatabaseListRows = (input: {
  readonly rows: readonly DatabaseListProjectionRowSnapshot[];
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly conditionalColors?: readonly DatabaseViewConditionalColorRule[];
  readonly collapsedOccurrenceKeys: ReadonlySet<string>;
  readonly groupLabel: (key: string | null) => string;
  readonly subgroupLabel: (key: string | null) => string;
  readonly matchesPage?: (
    row: DatabaseViewRenderRow,
    authority: Extract<DatabaseListProjectionRowSnapshot, { readonly kind: "page" }>["row"],
  ) => boolean;
}): CoreDatabaseListProjection => {
  const pageSnapshots = input.rows.filter(
    (row): row is Extract<DatabaseListProjectionRowSnapshot, { readonly kind: "page" }> =>
      row.kind === "page",
  );
  const renderRows = new Map(
    pageSnapshots.map(
      (snapshot) =>
        [
          snapshot.occurrenceKey,
          projectDataSourcePageRowToDatabaseViewRenderRow(
            snapshot.row,
            input.properties,
            input.conditionalColors,
          ),
        ] as const,
    ),
  );
  const authorityByPageId = new Map(
    pageSnapshots.map((snapshot) => [snapshot.row.page.pageId, snapshot.row] as const),
  );

  const visiblePageKeys = new Set<string>();
  if (!input.matchesPage) {
    for (const page of pageSnapshots) visiblePageKeys.add(page.occurrenceKey);
  } else {
    const pageByPathAndId = new Map(
      pageSnapshots.map(
        (page) => [`${coreGroupPathKey(page.groupPath)}:${page.row.page.pageId}`, page] as const,
      ),
    );
    for (const page of pageSnapshots) {
      const renderRow = renderRows.get(page.occurrenceKey)!;
      if (!input.matchesPage(renderRow, page.row)) continue;
      visiblePageKeys.add(page.occurrenceKey);
      for (const ancestorPageId of page.ancestorPageIds) {
        const ancestor = pageByPathAndId.get(
          `${coreGroupPathKey(page.groupPath)}:${ancestorPageId}`,
        );
        if (ancestor) visiblePageKeys.add(ancestor.occurrenceKey);
      }
    }
  }

  const visiblePathKeys = new Set(
    pageSnapshots.flatMap((page) =>
      visiblePageKeys.has(page.occurrenceKey) ? [coreGroupPathKey(page.groupPath)] : [],
    ),
  );
  const visibleGroupKeys = new Set(
    pageSnapshots.flatMap((page) =>
      visiblePageKeys.has(page.occurrenceKey) ? [pathKey([page.groupPath[0] ?? null])] : [],
    ),
  );
  const projected: DatabaseListProjectionRow[] = [];
  let currentGroupCollapsed = false;
  for (const snapshot of input.rows) {
    if (snapshot.kind === "group") {
      currentGroupCollapsed = input.collapsedOccurrenceKeys.has(snapshot.occurrenceKey);
      if (input.matchesPage && !visibleGroupKeys.has(pathKey([snapshot.groupKey]))) {
        continue;
      }
      projected.push({
        kind: "group",
        key: snapshot.occurrenceKey,
        groupKey: snapshot.groupKey,
        label: input.groupLabel(snapshot.groupKey),
        totalRows: snapshot.totalOccurrenceCount,
        collapsed: currentGroupCollapsed,
        height: DATABASE_LIST_GROUP_HEIGHT,
      });
      continue;
    }
    if (currentGroupCollapsed) continue;
    if (snapshot.kind === "subgroup") {
      if (
        input.matchesPage &&
        !visiblePathKeys.has(coreGroupPathKey([snapshot.groupKey, snapshot.subgroupKey]))
      ) {
        continue;
      }
      projected.push({
        kind: "subgroup",
        key: snapshot.occurrenceKey,
        groupKey: snapshot.groupKey,
        subgroupKey: snapshot.subgroupKey,
        label: input.subgroupLabel(snapshot.subgroupKey),
        totalRows: snapshot.totalOccurrenceCount,
        height: DATABASE_LIST_SUBGROUP_HEIGHT,
      });
      continue;
    }
    if (!visiblePageKeys.has(snapshot.occurrenceKey)) continue;
    const renderRow = renderRows.get(snapshot.occurrenceKey)!;
    projected.push({
      kind: "page",
      key: snapshot.occurrenceKey,
      pageId: snapshot.row.page.pageId,
      row: renderRow,
      groupKey: snapshot.groupPath[0] ?? null,
      subgroupKey: snapshot.groupPath[1] ?? null,
      ancestorPageIds: snapshot.ancestorPageIds,
      depth: Math.min(snapshot.depth, DATABASE_LIST_MAX_NESTING_DEPTH),
      hasChildren: snapshot.hasChildren,
      subtreeOccurrenceCount: snapshot.subtreeOccurrenceCount,
      concreteSubtreePageCount: snapshot.concreteSubtreePageCount,
      subtreeHeight: snapshot.subtreeHeight,
      firstChildOccurrenceKey: snapshot.firstChildOccurrenceKey,
      transientKind: snapshot.transientKind,
      firstInGroup: false,
      lastInGroup: false,
      height: DATABASE_LIST_PAGE_HEIGHT,
    });
  }

  const pageIndexesByPath = new Map<string, number[]>();
  for (const [index, row] of projected.entries()) {
    if (row.kind !== "page") continue;
    const key = coreGroupPathKey([row.groupKey, row.subgroupKey]);
    pageIndexesByPath.set(key, [...(pageIndexesByPath.get(key) ?? []), index]);
  }
  for (const indexes of pageIndexesByPath.values()) {
    const first = indexes[0];
    const last = indexes.at(-1);
    if (first === undefined || last === undefined) continue;
    const firstRow = projected[first];
    const lastRow = projected[last];
    if (firstRow?.kind === "page") projected[first] = { ...firstRow, firstInGroup: true };
    if (lastRow?.kind === "page") projected[last] = { ...lastRow, lastInGroup: true };
  }

  return { rows: projected, authorityByPageId };
};

const withListGroupBoundaries = (
  rows: readonly DatabaseListProjectionRow[],
): readonly DatabaseListProjectionRow[] => {
  const pageIndexesByPath = new Map<string, number[]>();
  for (const [index, row] of rows.entries()) {
    if (row.kind !== "page") continue;
    const key = pathKey([row.groupKey, row.subgroupKey]);
    pageIndexesByPath.set(key, [...(pageIndexesByPath.get(key) ?? []), index]);
  }
  return rows.map((row, index) => {
    if (row.kind !== "page") return row;
    const indexes = pageIndexesByPath.get(pathKey([row.groupKey, row.subgroupKey])) ?? [];
    return {
      ...row,
      firstInGroup: indexes[0] === index,
      lastInGroup: indexes.at(-1) === index,
    };
  });
};

/** A short-lived renderer overlay; authoritative order always comes back from Core. */
export const applyOptimisticDatabaseListDrop = (input: {
  readonly rows: readonly DatabaseListProjectionRow[];
  readonly occurrenceKeys: ReadonlySet<string>;
  readonly targetOccurrenceKey: string;
  readonly position: "before" | "after" | "nest" | "root";
  readonly groupKey: string | null;
  readonly subgroupKey: string | null;
}): readonly DatabaseListProjectionRow[] => {
  const target = input.rows.find((row) => row.key === input.targetOccurrenceKey);
  if (!target) return input.rows;
  const movedRootRows = input.rows.filter(
    (row): row is DatabaseListPageRow => row.kind === "page" && input.occurrenceKeys.has(row.key),
  );
  if (movedRootRows.length === 0) return input.rows;
  const movedEntries = movedRootRows
    .flatMap((root) => {
      const rootIndex = input.rows.findIndex((row) => row.key === root.key);
      if (rootIndex < 0) return [];
      return input.rows
        .slice(rootIndex, rootIndex + root.subtreeOccurrenceCount)
        .flatMap((row) => (row.kind === "page" ? [{ row, root }] : []));
    })
    .filter(
      (entry, index, entries) =>
        entries.findIndex((candidate) => candidate.row.key === entry.row.key) === index,
    );
  const movedRows = movedEntries.map((entry) => entry.row);
  const movedKeys = new Set(movedRows.map((row) => row.key));
  const remaining = input.rows.filter((row) => !movedKeys.has(row.key));

  const targetPage = target.kind === "page" ? target : null;
  const normalizedParentAfter = input.position === "after" && targetPage?.hasChildren === true;
  const nextAncestors =
    (input.position === "nest" || normalizedParentAfter) && targetPage
      ? [...targetPage.ancestorPageIds, targetPage.pageId]
      : input.position === "before" || input.position === "after"
        ? (targetPage?.ancestorPageIds ?? [])
        : [];
  const rootDepth = Math.min(nextAncestors.length, DATABASE_LIST_MAX_NESTING_DEPTH);
  const adjustedRows = movedEntries.map(({ row, root }): DatabaseListPageRow => {
    const originalRootDepth = root.depth;
    const relativeDepth = Math.max(0, row.depth - originalRootDepth);
    const relativeAncestors = row.ancestorPageIds.slice(originalRootDepth);
    return {
      ...row,
      groupKey: input.groupKey,
      subgroupKey: input.subgroupKey,
      ancestorPageIds: [...nextAncestors, ...relativeAncestors],
      depth: Math.min(rootDepth + relativeDepth, DATABASE_LIST_MAX_NESTING_DEPTH),
      firstInGroup: false,
      lastInGroup: false,
    };
  });

  let insertionIndex = remaining.findIndex((row) => row.key === target.key);
  if (insertionIndex < 0) return input.rows;
  if (normalizedParentAfter) {
    insertionIndex += 1;
  } else if (input.position === "after" && targetPage) {
    insertionIndex += 1;
    while (insertionIndex < remaining.length) {
      const candidate = remaining[insertionIndex];
      if (candidate?.kind !== "page" || !candidate.ancestorPageIds.includes(targetPage.pageId)) {
        break;
      }
      insertionIndex += 1;
    }
  } else if (input.position === "nest" && targetPage) {
    insertionIndex += 1;
    while (insertionIndex < remaining.length) {
      const candidate = remaining[insertionIndex];
      if (candidate?.kind !== "page" || !candidate.ancestorPageIds.includes(targetPage.pageId)) {
        break;
      }
      insertionIndex += 1;
    }
  } else if (input.position === "root") {
    insertionIndex += 1;
    while (insertionIndex < remaining.length) {
      const candidate = remaining[insertionIndex];
      if (candidate?.kind === "group") break;
      if (
        candidate?.kind === "subgroup" &&
        (candidate.groupKey !== input.groupKey || candidate.subgroupKey !== input.subgroupKey)
      ) {
        break;
      }
      insertionIndex += 1;
    }
  }
  const result = [...remaining];
  result.splice(insertionIndex, 0, ...adjustedRows);
  return withListGroupBoundaries(result);
};

/**
 * Compares only the structural coordinates authored by a List move. Live
 * titles and Properties are deliberately excluded so they can continue to
 * converge while a drag preview is active.
 */
export const databaseListProjectionPlacementEquals = (
  left: readonly DatabaseListProjectionRow[],
  right: readonly DatabaseListProjectionRow[],
): boolean => {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  return left.every((row, index) => {
    const candidate = right[index];
    if (!candidate || row.kind !== candidate.kind || row.key !== candidate.key) return false;
    if (row.kind !== "page" || candidate.kind !== "page") return true;
    return (
      row.groupKey === candidate.groupKey &&
      row.subgroupKey === candidate.subgroupKey &&
      row.depth === candidate.depth &&
      row.ancestorPageIds.length === candidate.ancestorPageIds.length &&
      row.ancestorPageIds.every(
        (pageId, ancestorIndex) => pageId === candidate.ancestorPageIds[ancestorIndex],
      )
    );
  });
};

export interface DatabaseListVirtualWindow {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly paddingStart: number;
  readonly paddingEnd: number;
  readonly totalHeight: number;
}

export interface DatabaseListScrollAnchor {
  readonly rowKey: string;
  readonly intraRowOffset: number;
}

export const captureDatabaseListScrollAnchor = (
  rows: readonly DatabaseListProjectionRow[],
  scrollTop: number,
): DatabaseListScrollAnchor | null => {
  if (rows.length === 0) return null;
  const target = Math.max(0, scrollTop);
  let offset = 0;
  for (const row of rows) {
    if (offset + row.height > target) {
      return {
        rowKey: row.key,
        intraRowOffset: target - offset,
      };
    }
    offset += row.height;
  }
  const last = rows.at(-1);
  return last ? { rowKey: last.key, intraRowOffset: last.height } : null;
};

export const restoreDatabaseListScrollTop = (
  rows: readonly DatabaseListProjectionRow[],
  anchor: DatabaseListScrollAnchor,
): number | null => {
  let offset = 0;
  for (const row of rows) {
    if (row.key === anchor.rowKey) {
      return offset + Math.max(0, Math.min(row.height, anchor.intraRowOffset));
    }
    offset += row.height;
  }
  return null;
};

export const databaseListScrollTopForOccurrence = (input: {
  readonly rows: readonly DatabaseListProjectionRow[];
  readonly occurrenceKey: string;
  readonly viewportTop: number;
  readonly viewportHeight: number;
}): number | null => {
  const row = input.rows.find((candidate) => candidate.key === input.occurrenceKey);
  if (!row) return null;
  const rowTop = restoreDatabaseListScrollTop(input.rows, {
    rowKey: input.occurrenceKey,
    intraRowOffset: 0,
  });
  if (rowTop === null) return null;
  const viewportTop = Math.max(0, input.viewportTop);
  const viewportBottom = viewportTop + Math.max(0, input.viewportHeight);
  if (rowTop < viewportTop) return rowTop;
  if (rowTop + row.height > viewportBottom) {
    return Math.max(0, rowTop + row.height - input.viewportHeight);
  }
  return viewportTop;
};

const lowerBound = (offsets: readonly number[], value: number): number => {
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((offsets[middle] ?? 0) < value) low = middle + 1;
    else high = middle;
  }
  return low;
};

export const computeDatabaseListVirtualWindow = (
  rows: readonly DatabaseListProjectionRow[],
  scrollTop: number,
  viewportHeight: number,
  overscan: number,
): DatabaseListVirtualWindow => {
  const offsets = [0];
  for (const row of rows) {
    offsets.push((offsets.at(-1) ?? 0) + row.height);
  }
  const totalHeight = offsets.at(-1) ?? 0;
  const startOffset = Math.max(0, scrollTop - overscan);
  const endOffset = Math.min(totalHeight, scrollTop + Math.max(0, viewportHeight) + overscan);
  const startIndex = Math.max(0, lowerBound(offsets, startOffset) - 1);
  const endIndex = Math.min(rows.length, lowerBound(offsets, endOffset) + 1);
  return {
    startIndex,
    endIndex,
    paddingStart: offsets[startIndex] ?? 0,
    paddingEnd: Math.max(0, totalHeight - (offsets[endIndex] ?? totalHeight)),
    totalHeight,
  };
};

export interface DatabaseListSelectionState {
  readonly selectedOccurrenceKeys: ReadonlySet<string>;
  readonly allMatching: boolean;
  readonly excludedOccurrenceKeys: ReadonlySet<string>;
  readonly anchorOccurrenceKey: string | null;
  readonly activeOccurrenceKey: string | null;
}

export const emptyDatabaseListSelection = (): DatabaseListSelectionState => ({
  selectedOccurrenceKeys: new Set(),
  allMatching: false,
  excludedOccurrenceKeys: new Set(),
  anchorOccurrenceKey: null,
  activeOccurrenceKey: null,
});

const selectableKeys = (rows: readonly DatabaseListProjectionRow[]): readonly string[] =>
  rows.flatMap((row) => (row.kind === "page" ? [row.key] : []));

export const selectDatabaseListOccurrence = (input: {
  readonly state: DatabaseListSelectionState;
  readonly rows: readonly DatabaseListProjectionRow[];
  readonly occurrenceKey: string;
  readonly mode: "replace" | "toggle" | "range";
}): DatabaseListSelectionState => {
  const keys = selectableKeys(input.rows);
  if (!keys.includes(input.occurrenceKey)) return input.state;
  if (input.mode === "toggle") {
    if (input.state.allMatching) {
      const excluded = new Set(input.state.excludedOccurrenceKeys);
      if (excluded.has(input.occurrenceKey)) excluded.delete(input.occurrenceKey);
      else excluded.add(input.occurrenceKey);
      return {
        ...input.state,
        excludedOccurrenceKeys: excluded,
        anchorOccurrenceKey: input.occurrenceKey,
        activeOccurrenceKey: input.occurrenceKey,
      };
    }
    const selected = new Set(input.state.selectedOccurrenceKeys);
    if (selected.has(input.occurrenceKey)) selected.delete(input.occurrenceKey);
    else selected.add(input.occurrenceKey);
    return {
      selectedOccurrenceKeys: selected,
      allMatching: false,
      excludedOccurrenceKeys: new Set(),
      anchorOccurrenceKey: input.occurrenceKey,
      activeOccurrenceKey: input.occurrenceKey,
    };
  }
  if (input.mode === "range" && input.state.anchorOccurrenceKey) {
    const anchorIndex = keys.indexOf(input.state.anchorOccurrenceKey);
    const targetIndex = keys.indexOf(input.occurrenceKey);
    if (anchorIndex >= 0 && targetIndex >= 0) {
      const start = Math.min(anchorIndex, targetIndex);
      const end = Math.max(anchorIndex, targetIndex);
      return {
        selectedOccurrenceKeys: new Set(keys.slice(start, end + 1)),
        allMatching: false,
        excludedOccurrenceKeys: new Set(),
        anchorOccurrenceKey: input.state.anchorOccurrenceKey,
        activeOccurrenceKey: input.occurrenceKey,
      };
    }
  }
  return {
    selectedOccurrenceKeys: new Set([input.occurrenceKey]),
    allMatching: false,
    excludedOccurrenceKeys: new Set(),
    anchorOccurrenceKey: input.occurrenceKey,
    activeOccurrenceKey: input.occurrenceKey,
  };
};

export const moveDatabaseListActiveOccurrence = (input: {
  readonly state: DatabaseListSelectionState;
  readonly rows: readonly DatabaseListProjectionRow[];
  readonly direction: -1 | 1;
  readonly extendSelection: boolean;
}): DatabaseListSelectionState => {
  const keys = selectableKeys(input.rows);
  if (keys.length === 0) return emptyDatabaseListSelection();
  const activeIndex = input.state.activeOccurrenceKey
    ? keys.indexOf(input.state.activeOccurrenceKey)
    : -1;
  const nextIndex =
    activeIndex < 0
      ? input.direction > 0
        ? 0
        : keys.length - 1
      : Math.max(0, Math.min(keys.length - 1, activeIndex + input.direction));
  const occurrenceKey = keys[nextIndex]!;
  if (input.extendSelection) {
    return selectDatabaseListOccurrence({
      state: input.state.anchorOccurrenceKey
        ? input.state
        : { ...input.state, anchorOccurrenceKey: keys[Math.max(0, activeIndex)] ?? occurrenceKey },
      rows: input.rows,
      occurrenceKey,
      mode: "range",
    });
  }
  return {
    ...input.state,
    activeOccurrenceKey: occurrenceKey,
  };
};

export const moveDatabaseListActiveOccurrenceToBoundary = (input: {
  readonly state: DatabaseListSelectionState;
  readonly rows: readonly DatabaseListProjectionRow[];
  readonly boundary: "first" | "last";
  readonly extendSelection: boolean;
}): DatabaseListSelectionState => {
  const keys = selectableKeys(input.rows);
  if (keys.length === 0) return emptyDatabaseListSelection();
  const occurrenceKey = input.boundary === "first" ? keys[0]! : keys.at(-1)!;
  if (input.extendSelection) {
    return selectDatabaseListOccurrence({
      state: input.state.anchorOccurrenceKey
        ? input.state
        : {
            ...input.state,
            anchorOccurrenceKey: input.state.activeOccurrenceKey ?? occurrenceKey,
          },
      rows: input.rows,
      occurrenceKey,
      mode: "range",
    });
  }
  return {
    ...input.state,
    activeOccurrenceKey: occurrenceKey,
  };
};

export const isDatabaseListOccurrenceSelected = (
  state: DatabaseListSelectionState,
  occurrenceKey: string,
): boolean =>
  state.allMatching
    ? !state.excludedOccurrenceKeys.has(occurrenceKey)
    : state.selectedOccurrenceKeys.has(occurrenceKey);

export const selectAllDatabaseListOccurrences = (input: {
  readonly state: DatabaseListSelectionState;
  readonly rows: readonly DatabaseListProjectionRow[];
}): DatabaseListSelectionState => {
  const keys = selectableKeys(input.rows);
  const activeOccurrenceKey =
    input.state.activeOccurrenceKey && keys.includes(input.state.activeOccurrenceKey)
      ? input.state.activeOccurrenceKey
      : (keys[0] ?? null);
  return {
    selectedOccurrenceKeys: new Set(),
    allMatching: true,
    excludedOccurrenceKeys: new Set(),
    anchorOccurrenceKey: activeOccurrenceKey,
    activeOccurrenceKey,
  };
};

export const selectedDatabaseListPageIds = (
  rows: readonly DatabaseListProjectionRow[],
  state: DatabaseListSelectionState,
): ReadonlySet<string> =>
  new Set(
    rows.flatMap((row) =>
      row.kind === "page" && isDatabaseListOccurrenceSelected(state, row.key) ? [row.pageId] : [],
    ),
  );

export const syncDatabaseListSelection = (
  state: DatabaseListSelectionState,
  rows: readonly DatabaseListProjectionRow[],
  previousRows: readonly DatabaseListProjectionRow[] = rows,
): DatabaseListSelectionState => {
  const valid = new Set(selectableKeys(rows));
  const nextKeys = selectableKeys(rows);
  const previousKeys = selectableKeys(previousRows);
  const selected = new Set([...state.selectedOccurrenceKeys].filter((key) => valid.has(key)));
  const previousActiveIndex = state.activeOccurrenceKey
    ? previousKeys.indexOf(state.activeOccurrenceKey)
    : -1;
  const fallbackActiveKey =
    state.activeOccurrenceKey && nextKeys.length > 0
      ? (nextKeys[
          Math.min(previousActiveIndex < 0 ? 0 : previousActiveIndex, nextKeys.length - 1)
        ] ?? null)
      : null;
  const anchorOccurrenceKey =
    state.anchorOccurrenceKey && valid.has(state.anchorOccurrenceKey)
      ? state.anchorOccurrenceKey
      : null;
  const activeOccurrenceKey =
    state.activeOccurrenceKey && valid.has(state.activeOccurrenceKey)
      ? state.activeOccurrenceKey
      : fallbackActiveKey;
  const selectionUnchanged =
    selected.size === state.selectedOccurrenceKeys.size &&
    [...selected].every((key) => state.selectedOccurrenceKeys.has(key));
  if (
    selectionUnchanged &&
    anchorOccurrenceKey === state.anchorOccurrenceKey &&
    activeOccurrenceKey === state.activeOccurrenceKey
  ) {
    return state;
  }
  return {
    selectedOccurrenceKeys: selected,
    allMatching: state.allMatching,
    excludedOccurrenceKeys: state.excludedOccurrenceKeys,
    anchorOccurrenceKey,
    activeOccurrenceKey,
  };
};
