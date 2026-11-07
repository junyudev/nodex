export type WorkbenchPanelSplitSide = "left" | "right" | "up" | "down";

export interface WorkbenchPanelSplitLeaf {
  type: "leaf";
  id: string;
  tabIds: string[];
  activeTabId: string | null;
  mruTabIds: string[];
}

export interface WorkbenchPanelSplitBranch {
  type: "split";
  id: string;
  direction: "horizontal" | "vertical";
  first: WorkbenchPanelNode;
  second: WorkbenchPanelNode;
  ratio: number;
}

export type WorkbenchPanelNode = WorkbenchPanelSplitLeaf | WorkbenchPanelSplitBranch;

export interface WorkbenchPanelLayout {
  version: 2;
  root: WorkbenchPanelNode;
  activeLeafId: string;
  mruLeafIds: string[];
  maximizedLeafId?: string | null;
}

export type WorkbenchPanelLayoutV2 = WorkbenchPanelLayout;

export const WORKBENCH_PANEL_LAYOUT_VERSION = 2;
export const WORKBENCH_PANEL_MIN_RATIO = 0.15;
export const WORKBENCH_PANEL_MAX_RATIO = 0.85;

interface NormalizePanelLayoutOptions {
  preferredActiveTabId?: string | null;
  preferredActiveLeafId?: string | null;
}

interface SplitPanelLeafInput {
  leafId: string;
  newLeafId: string;
  newBranchId: string;
  side: WorkbenchPanelSplitSide;
  tabId?: string;
}

interface InsertPanelLeafInput {
  leafId: string;
  newLeafId: string;
  newBranchId: string;
  side: WorkbenchPanelSplitSide;
}

interface MovePanelTabInput {
  tabId: string;
  targetLeafId?: string | null;
  targetIndex?: number;
}

interface InsertPanelTabInBackgroundInput {
  tabId: string;
  targetLeafId?: string | null;
  targetIndex?: number;
}

interface RemovePanelTabOptions {
  preferredActiveLeafId?: string | null;
  preferredActiveTabId?: string | null;
}

interface PruneEmptyPanelLeavesOptions {
  preserveLeafIds?: readonly string[];
  preferredActiveLeafId?: string | null;
  preferredActiveTabId?: string | null;
}

interface MovePanelLeafInput {
  sourceLeafId: string;
  targetLeafId: string;
  side: WorkbenchPanelSplitSide;
  newBranchId: string;
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function clampRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return 0.5;
  return Math.min(WORKBENCH_PANEL_MAX_RATIO, Math.max(WORKBENCH_PANEL_MIN_RATIO, ratio));
}

function normalizeMruTabIds(
  tabIds: readonly string[],
  activeTabId: string | null,
  mruTabIds: readonly string[] = [],
): string[] {
  const validTabIds = new Set(tabIds);
  const activePrefix = activeTabId && validTabIds.has(activeTabId) ? [activeTabId] : [];
  return uniqueStrings([...activePrefix, ...mruTabIds, ...tabIds]).filter((tabId) =>
    validTabIds.has(tabId),
  );
}

function makeLeaf(
  id: string,
  tabIds: string[],
  activeTabId: string | null,
  mruTabIds: readonly string[] = [],
): WorkbenchPanelSplitLeaf {
  const uniqueTabIds = uniqueStrings(tabIds);
  const resolvedActiveTabId =
    activeTabId && uniqueTabIds.includes(activeTabId) ? activeTabId : (uniqueTabIds[0] ?? null);
  return {
    type: "leaf",
    id,
    tabIds: uniqueTabIds,
    activeTabId: resolvedActiveTabId,
    mruTabIds: normalizeMruTabIds(uniqueTabIds, resolvedActiveTabId, mruTabIds),
  };
}

export function makeWorkbenchPanelLayout(
  tabIds: readonly string[],
  activeTabId: string | null,
  leafId = "main",
): WorkbenchPanelLayoutV2 {
  const uniqueTabIds = uniqueStrings(tabIds);
  const leaf = makeLeaf(leafId, uniqueTabIds, activeTabId);
  return {
    version: WORKBENCH_PANEL_LAYOUT_VERSION,
    root: leaf,
    activeLeafId: leaf.id,
    mruLeafIds: [leaf.id],
    maximizedLeafId: null,
  };
}

export function listWorkbenchPanelLeaves(layout: WorkbenchPanelLayout): WorkbenchPanelSplitLeaf[] {
  const leaves: WorkbenchPanelSplitLeaf[] = [];
  const visit = (node: WorkbenchPanelNode) => {
    if (node.type === "leaf") {
      leaves.push(node);
      return;
    }
    visit(node.first);
    visit(node.second);
  };
  visit(layout.root);
  return leaves;
}

export function getWorkbenchPanelTopRightLeafId(node: WorkbenchPanelNode): string {
  if (node.type === "leaf") return node.id;
  return getWorkbenchPanelTopRightLeafId(
    node.direction === "horizontal" ? node.second : node.first,
  );
}

export function getWorkbenchPanelTopLeftLeafId(node: WorkbenchPanelNode): string {
  if (node.type === "leaf") return node.id;
  return getWorkbenchPanelTopLeftLeafId(node.first);
}

interface PanelLeafRect {
  id: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const RECT_EPSILON = 0.000001;

function collectWorkbenchPanelLeafRects(
  node: WorkbenchPanelNode,
  rect: Omit<PanelLeafRect, "id">,
): PanelLeafRect[] {
  if (node.type === "leaf") return [{ ...rect, id: node.id }];

  const ratio = clampRatio(node.ratio);
  if (node.direction === "horizontal") {
    const splitX = rect.left + (rect.right - rect.left) * ratio;
    return [
      ...collectWorkbenchPanelLeafRects(node.first, { ...rect, right: splitX }),
      ...collectWorkbenchPanelLeafRects(node.second, { ...rect, left: splitX }),
    ];
  }

  const splitY = rect.top + (rect.bottom - rect.top) * ratio;
  return [
    ...collectWorkbenchPanelLeafRects(node.first, { ...rect, bottom: splitY }),
    ...collectWorkbenchPanelLeafRects(node.second, { ...rect, top: splitY }),
  ];
}

function rectsVerticallyOverlap(left: PanelLeafRect, right: PanelLeafRect): boolean {
  return Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top) > RECT_EPSILON;
}

export function findNearestWorkbenchPanelLeafToRight(
  layout: WorkbenchPanelLayout,
  sourceLeafId: string,
): string | null {
  const rects = collectWorkbenchPanelLeafRects(layout.root, {
    left: 0,
    top: 0,
    right: 1,
    bottom: 1,
  });
  const sourceRect = rects.find((rect) => rect.id === sourceLeafId);
  if (!sourceRect) return null;

  const sourceCenterY = (sourceRect.top + sourceRect.bottom) / 2;
  const candidates = rects
    .filter(
      (rect) =>
        rect.id !== sourceLeafId &&
        rect.left >= sourceRect.right - RECT_EPSILON &&
        rectsVerticallyOverlap(sourceRect, rect),
    )
    .map((rect) => ({
      rect,
      horizontalDistance: Math.max(0, rect.left - sourceRect.right),
      verticalDistance: Math.abs((rect.top + rect.bottom) / 2 - sourceCenterY),
    }))
    .sort(
      (left, right) =>
        left.horizontalDistance - right.horizontalDistance ||
        left.verticalDistance - right.verticalDistance ||
        left.rect.top - right.rect.top ||
        left.rect.left - right.rect.left,
    );

  return candidates[0]?.rect.id ?? null;
}

export function flattenWorkbenchPanelTabIds(layout: WorkbenchPanelLayout): string[] {
  return listWorkbenchPanelLeaves(layout).flatMap((leaf) => leaf.tabIds);
}

export function findWorkbenchPanelLeaf(
  layout: WorkbenchPanelLayout,
  leafId: string | null | undefined,
): WorkbenchPanelSplitLeaf | null {
  if (!leafId) return null;
  return listWorkbenchPanelLeaves(layout).find((leaf) => leaf.id === leafId) ?? null;
}

export function findWorkbenchPanelLeafForTab(
  layout: WorkbenchPanelLayout,
  tabId: string | null | undefined,
): WorkbenchPanelSplitLeaf | null {
  if (!tabId) return null;
  return listWorkbenchPanelLeaves(layout).find((leaf) => leaf.tabIds.includes(tabId)) ?? null;
}

export function getWorkbenchPanelActiveLeaf(layout: WorkbenchPanelLayout): WorkbenchPanelSplitLeaf {
  const leaves = listWorkbenchPanelLeaves(layout);
  if (leaves.length === 0) {
    return makeLeaf("main", [], null);
  }
  const activeLeaf = leaves.find((leaf) => leaf.id === layout.activeLeafId);
  return activeLeaf ?? leaves[0] ?? makeLeaf("main", [], null);
}

function updateMruLeafIds(layout: WorkbenchPanelLayoutV2, activeLeafId: string): string[] {
  const validLeafIds = new Set(listWorkbenchPanelLeaves(layout).map((leaf) => leaf.id));
  const next = [activeLeafId, ...layout.mruLeafIds].filter((leafId) => validLeafIds.has(leafId));
  return uniqueStrings(next);
}

function mapNode(
  node: WorkbenchPanelNode,
  visitor: (node: WorkbenchPanelNode) => WorkbenchPanelNode,
): WorkbenchPanelNode {
  if (node.type === "leaf") return visitor(node);
  return visitor({
    ...node,
    first: mapNode(node.first, visitor),
    second: mapNode(node.second, visitor),
  });
}

function replaceLeaf(
  node: WorkbenchPanelNode,
  leafId: string,
  replacement: WorkbenchPanelNode,
): WorkbenchPanelNode {
  if (node.type === "leaf") return node.id === leafId ? replacement : node;
  return {
    ...node,
    first: replaceLeaf(node.first, leafId, replacement),
    second: replaceLeaf(node.second, leafId, replacement),
  };
}

function normalizeNode(
  node: WorkbenchPanelNode,
  knownTabIds: Set<string>,
  seenTabIds: Set<string>,
  seenNodeIds: Set<string>,
  nextDuplicateId: () => number,
): WorkbenchPanelNode {
  const baseId = node.id.trim() || (node.type === "leaf" ? "leaf" : "split");
  const id = seenNodeIds.has(baseId) ? `${baseId}:${nextDuplicateId()}` : baseId;
  seenNodeIds.add(id);

  if (node.type === "leaf") {
    const tabIds: string[] = [];
    for (const tabId of node.tabIds) {
      if (!knownTabIds.has(tabId) || seenTabIds.has(tabId)) continue;
      seenTabIds.add(tabId);
      tabIds.push(tabId);
    }
    return makeLeaf(id, tabIds, node.activeTabId, node.mruTabIds ?? []);
  }

  return {
    type: "split",
    id,
    direction: node.direction === "vertical" ? "vertical" : "horizontal",
    first: normalizeNode(node.first, knownTabIds, seenTabIds, seenNodeIds, nextDuplicateId),
    second: normalizeNode(node.second, knownTabIds, seenTabIds, seenNodeIds, nextDuplicateId),
    ratio: clampRatio(node.ratio),
  };
}

function updateLeafTabs(
  node: WorkbenchPanelNode,
  leafId: string,
  update: (leaf: WorkbenchPanelSplitLeaf) => WorkbenchPanelSplitLeaf,
): WorkbenchPanelNode {
  return mapNode(node, (candidate) => {
    if (candidate.type !== "leaf" || candidate.id !== leafId) return candidate;
    return update(candidate);
  });
}

function normalizeV2Layout(
  layout: WorkbenchPanelLayoutV2,
  allTabIds: readonly string[],
  options: NormalizePanelLayoutOptions,
): WorkbenchPanelLayoutV2 {
  const knownTabIds = new Set(allTabIds);
  const seenTabIds = new Set<string>();
  const seenNodeIds = new Set<string>();
  let duplicateIndex = 0;
  const nextDuplicateId = () => {
    duplicateIndex += 1;
    return duplicateIndex;
  };
  let root = normalizeNode(layout.root, knownTabIds, seenTabIds, seenNodeIds, nextDuplicateId);
  let leaves = listWorkbenchPanelLeaves({ ...layout, root });
  if (leaves.length === 0) {
    root = makeLeaf("main", [], null);
    leaves = listWorkbenchPanelLeaves({ ...layout, root });
  }

  const preferredLeafId =
    options.preferredActiveLeafId ??
    findWorkbenchPanelLeafForTab({ ...layout, root }, options.preferredActiveTabId)?.id ??
    layout.activeLeafId ??
    leaves[0]?.id ??
    "main";
  const activeLeafId = leaves.some((leaf) => leaf.id === preferredLeafId)
    ? preferredLeafId
    : (leaves[0]?.id ?? "main");

  const unassignedTabIds = allTabIds.filter((tabId) => !seenTabIds.has(tabId));
  if (unassignedTabIds.length > 0) {
    root = updateLeafTabs(root, activeLeafId, (leaf) =>
      makeLeaf(
        leaf.id,
        [...leaf.tabIds, ...unassignedTabIds],
        options.preferredActiveTabId && unassignedTabIds.includes(options.preferredActiveTabId)
          ? options.preferredActiveTabId
          : leaf.activeTabId,
        leaf.mruTabIds,
      ),
    );
  }

  root = mapNode(root, (node) => {
    if (node.type !== "leaf") return node;
    return makeLeaf(node.id, uniqueStrings(node.tabIds), node.activeTabId, node.mruTabIds);
  });

  const normalized: WorkbenchPanelLayoutV2 = {
    version: WORKBENCH_PANEL_LAYOUT_VERSION,
    root,
    activeLeafId,
    mruLeafIds: [],
    maximizedLeafId: layout.maximizedLeafId ?? null,
  };
  const validLeafIds = new Set(listWorkbenchPanelLeaves(normalized).map((leaf) => leaf.id));
  const activeFromPreferredTab = options.preferredActiveTabId
    ? findWorkbenchPanelLeafForTab(normalized, options.preferredActiveTabId)?.id
    : null;
  const finalActiveLeafId =
    activeFromPreferredTab && validLeafIds.has(activeFromPreferredTab)
      ? activeFromPreferredTab
      : validLeafIds.has(activeLeafId)
        ? activeLeafId
        : ([...validLeafIds][0] ?? "main");

  return activateNormalizedWorkbenchPanelLeaf(
    {
      ...normalized,
      activeLeafId: finalActiveLeafId,
      mruLeafIds: uniqueStrings([finalActiveLeafId, ...layout.mruLeafIds]).filter((leafId) =>
        validLeafIds.has(leafId),
      ),
      maximizedLeafId:
        layout.maximizedLeafId && validLeafIds.has(layout.maximizedLeafId)
          ? layout.maximizedLeafId
          : null,
    },
    finalActiveLeafId,
    options.preferredActiveTabId,
  );
}

export function normalizeWorkbenchPanelLayout(
  value: WorkbenchPanelLayout | null | undefined,
  allTabIds: readonly string[],
  options: NormalizePanelLayoutOptions = {},
): WorkbenchPanelLayoutV2 {
  const fallback = makeWorkbenchPanelLayout(
    allTabIds,
    options.preferredActiveTabId ?? allTabIds[0] ?? null,
  );
  if (!value) return fallback;
  return normalizeV2Layout(value, allTabIds, options);
}

export function activateWorkbenchPanelLeaf(
  layout: WorkbenchPanelLayout,
  leafId: string,
  tabId?: string | null,
): WorkbenchPanelLayoutV2 {
  const normalized = normalizeWorkbenchPanelLayout(layout, flattenWorkbenchPanelTabIds(layout), {
    preferredActiveLeafId: leafId,
    preferredActiveTabId: tabId,
  });
  return activateNormalizedWorkbenchPanelLeaf(normalized, leafId, tabId);
}

function activateNormalizedWorkbenchPanelLeaf(
  normalized: WorkbenchPanelLayoutV2,
  leafId: string,
  tabId?: string | null,
): WorkbenchPanelLayoutV2 {
  const targetLeaf =
    findWorkbenchPanelLeaf(normalized, leafId) ??
    findWorkbenchPanelLeafForTab(normalized, tabId) ??
    getWorkbenchPanelActiveLeaf(normalized);
  const activeTabId = tabId && targetLeaf.tabIds.includes(tabId) ? tabId : targetLeaf.activeTabId;
  const root = updateLeafTabs(normalized.root, targetLeaf.id, (leaf) =>
    makeLeaf(
      leaf.id,
      leaf.tabIds,
      activeTabId,
      activeTabId ? [activeTabId, ...leaf.mruTabIds] : leaf.mruTabIds,
    ),
  );
  const next = {
    ...normalized,
    root,
    activeLeafId: targetLeaf.id,
  };
  return {
    ...next,
    mruLeafIds: updateMruLeafIds(next, targetLeaf.id),
  };
}

export function splitWorkbenchPanelLeaf(
  layout: WorkbenchPanelLayout,
  input: SplitPanelLeafInput,
): WorkbenchPanelLayoutV2 {
  const allTabIds = uniqueStrings([
    ...flattenWorkbenchPanelTabIds(layout),
    ...(input.tabId ? [input.tabId] : []),
  ]);
  const normalized = normalizeWorkbenchPanelLayout(layout, allTabIds, {
    preferredActiveLeafId: input.leafId,
    preferredActiveTabId: input.tabId,
  });
  const targetLeaf = findWorkbenchPanelLeaf(normalized, input.leafId);
  if (!targetLeaf) return normalized;
  if (!input.tabId) return normalized;
  if (!targetLeaf.tabIds.includes(input.tabId)) return normalized;
  if (targetLeaf.tabIds.length <= 1) return normalized;

  const targetTabIds = targetLeaf.tabIds.filter((tabId) => tabId !== input.tabId);
  const updatedTarget = makeLeaf(
    targetLeaf.id,
    targetTabIds,
    targetLeaf.activeTabId,
    targetLeaf.mruTabIds,
  );
  const newLeaf = makeLeaf(input.newLeafId, [input.tabId], input.tabId);
  const direction = input.side === "left" || input.side === "right" ? "horizontal" : "vertical";
  const newBranch: WorkbenchPanelSplitBranch = {
    type: "split",
    id: input.newBranchId,
    direction,
    first: input.side === "left" || input.side === "up" ? newLeaf : updatedTarget,
    second: input.side === "left" || input.side === "up" ? updatedTarget : newLeaf,
    ratio: 0.5,
  };
  const next = normalizeWorkbenchPanelLayout(
    {
      ...normalized,
      root: replaceLeaf(normalized.root, targetLeaf.id, newBranch),
      activeLeafId: newLeaf.id,
      mruLeafIds: [newLeaf.id, ...normalized.mruLeafIds],
      maximizedLeafId: null,
    },
    flattenWorkbenchPanelTabIds({
      ...normalized,
      root: replaceLeaf(normalized.root, targetLeaf.id, newBranch),
    }),
    {
      preferredActiveLeafId: newLeaf.id,
      preferredActiveTabId: input.tabId ?? null,
    },
  );
  return next;
}

export function insertWorkbenchPanelLeaf(
  layout: WorkbenchPanelLayout,
  input: InsertPanelLeafInput,
): WorkbenchPanelLayoutV2 {
  const allTabIds = flattenWorkbenchPanelTabIds(layout);
  const normalized = normalizeWorkbenchPanelLayout(layout, allTabIds, {
    preferredActiveLeafId: input.leafId,
  });
  const targetLeaf = findWorkbenchPanelLeaf(normalized, input.leafId);
  if (!targetLeaf) return normalized;

  const newLeaf = makeLeaf(input.newLeafId, [], null);
  const direction = input.side === "left" || input.side === "right" ? "horizontal" : "vertical";
  const newBranch: WorkbenchPanelSplitBranch = {
    type: "split",
    id: input.newBranchId,
    direction,
    first: input.side === "left" || input.side === "up" ? newLeaf : targetLeaf,
    second: input.side === "left" || input.side === "up" ? targetLeaf : newLeaf,
    ratio: 0.5,
  };
  const root = replaceLeaf(normalized.root, targetLeaf.id, newBranch);

  return normalizeWorkbenchPanelLayout(
    {
      ...normalized,
      root,
      activeLeafId: newLeaf.id,
      mruLeafIds: [newLeaf.id, ...normalized.mruLeafIds],
      maximizedLeafId: null,
    },
    allTabIds,
    {
      preferredActiveLeafId: newLeaf.id,
    },
  );
}

export function moveWorkbenchPanelTab(
  layout: WorkbenchPanelLayout,
  input: MovePanelTabInput,
): WorkbenchPanelLayoutV2 {
  const allTabIds = uniqueStrings([...flattenWorkbenchPanelTabIds(layout), input.tabId]);
  const normalized = normalizeWorkbenchPanelLayout(layout, allTabIds, {
    preferredActiveTabId: input.tabId,
    preferredActiveLeafId: input.targetLeafId,
  });
  const targetLeaf =
    findWorkbenchPanelLeaf(normalized, input.targetLeafId) ??
    getWorkbenchPanelActiveLeaf(normalized);

  let root = mapNode(normalized.root, (node) => {
    if (node.type !== "leaf") return node;
    const nextIds = node.tabIds.filter((tabId) => tabId !== input.tabId);
    return makeLeaf(node.id, nextIds, node.activeTabId, node.mruTabIds);
  });

  root = updateLeafTabs(root, targetLeaf.id, (leaf) => {
    const base = leaf.tabIds.filter((tabId) => tabId !== input.tabId);
    const targetIndex = Math.min(input.targetIndex ?? base.length, base.length);
    const nextIds = [...base];
    nextIds.splice(targetIndex, 0, input.tabId);
    return makeLeaf(leaf.id, nextIds, input.tabId, [input.tabId, ...leaf.mruTabIds]);
  });

  return normalizeWorkbenchPanelLayout(
    {
      ...normalized,
      root,
      activeLeafId: targetLeaf.id,
      mruLeafIds: [targetLeaf.id, ...normalized.mruLeafIds],
      maximizedLeafId: null,
    },
    allTabIds,
    {
      preferredActiveLeafId: targetLeaf.id,
      preferredActiveTabId: input.tabId,
    },
  );
}

export function insertWorkbenchPanelTabInBackground(
  layout: WorkbenchPanelLayout,
  input: InsertPanelTabInBackgroundInput,
): WorkbenchPanelLayoutV2 {
  const existingTabIds = flattenWorkbenchPanelTabIds(layout);
  const activeLeaf = getWorkbenchPanelActiveLeaf(layout);
  const normalized = normalizeWorkbenchPanelLayout(layout, existingTabIds, {
    preferredActiveLeafId: layout.activeLeafId,
    preferredActiveTabId: activeLeaf.activeTabId,
  });
  if (existingTabIds.includes(input.tabId)) return normalized;

  const targetLeaf =
    findWorkbenchPanelLeaf(normalized, input.targetLeafId) ??
    getWorkbenchPanelActiveLeaf(normalized);
  const normalizedActiveLeaf = getWorkbenchPanelActiveLeaf(normalized);
  const root = updateLeafTabs(normalized.root, targetLeaf.id, (leaf) => {
    const targetIndex = Math.min(
      Math.max(input.targetIndex ?? leaf.tabIds.length, 0),
      leaf.tabIds.length,
    );
    const tabIds = [...leaf.tabIds];
    tabIds.splice(targetIndex, 0, input.tabId);
    const activeTabId = leaf.activeTabId ?? input.tabId;
    return makeLeaf(leaf.id, tabIds, activeTabId, [...leaf.mruTabIds, input.tabId]);
  });

  return normalizeWorkbenchPanelLayout({ ...normalized, root }, [...existingTabIds, input.tabId], {
    preferredActiveLeafId: normalized.activeLeafId,
    preferredActiveTabId: normalizedActiveLeaf.activeTabId,
  });
}

export function reorderWorkbenchPanelLeafTabs(
  layout: WorkbenchPanelLayout,
  leafId: string,
  orderedTabIds: readonly string[],
): WorkbenchPanelLayoutV2 {
  const normalized = normalizeWorkbenchPanelLayout(layout, flattenWorkbenchPanelTabIds(layout), {
    preferredActiveLeafId: leafId,
  });
  const leaf = findWorkbenchPanelLeaf(normalized, leafId);
  if (!leaf) return normalized;
  const selected = orderedTabIds.filter((tabId) => leaf.tabIds.includes(tabId));
  const remaining = leaf.tabIds.filter((tabId) => !selected.includes(tabId));
  const finalOrder = [...selected, ...remaining];
  return activateWorkbenchPanelLeaf(
    {
      ...normalized,
      root: updateLeafTabs(normalized.root, leaf.id, (current) =>
        makeLeaf(current.id, finalOrder, current.activeTabId, current.mruTabIds),
      ),
    },
    leaf.id,
    leaf.activeTabId,
  );
}

/** Selects the tab that occupies the closed tab's slot, falling back to its left neighbor. */
export function resolveWorkbenchPanelTabAfterClose(
  tabIds: readonly string[],
  closingTabId: string,
): string | null {
  const closingIndex = tabIds.indexOf(closingTabId);
  if (closingIndex < 0) return null;
  return tabIds[closingIndex + 1] ?? tabIds[closingIndex - 1] ?? null;
}

export function removeWorkbenchPanelTab(
  layout: WorkbenchPanelLayout,
  tabId: string,
  options: RemovePanelTabOptions = {},
): WorkbenchPanelLayoutV2 {
  const allTabIds = flattenWorkbenchPanelTabIds(layout).filter((candidate) => candidate !== tabId);
  const sourceLeaf = findWorkbenchPanelLeafForTab(layout, tabId);
  const indexReplacement =
    sourceLeaf?.activeTabId === tabId
      ? resolveWorkbenchPanelTabAfterClose(sourceLeaf.tabIds, tabId)
      : null;
  const resolvedOptions =
    sourceLeaf?.activeTabId === tabId && options.preferredActiveTabId == null
      ? {
          ...options,
          preferredActiveLeafId: options.preferredActiveLeafId ?? sourceLeaf.id,
          preferredActiveTabId: indexReplacement,
        }
      : options;
  const normalized = normalizeWorkbenchPanelLayout(layout, allTabIds, resolvedOptions);
  const root = mapNode(normalized.root, (node) => {
    if (node.type !== "leaf") return node;
    const tabIds = node.tabIds.filter((candidate) => candidate !== tabId);
    return makeLeaf(node.id, tabIds, node.activeTabId, node.mruTabIds);
  });
  return normalizeWorkbenchPanelLayout({ ...normalized, root }, allTabIds, resolvedOptions);
}

function removeLeafFromNode(
  node: WorkbenchPanelNode,
  leafId: string,
): { node: WorkbenchPanelNode | null; removed: WorkbenchPanelSplitLeaf | null } {
  if (node.type === "leaf") {
    return node.id === leafId ? { node: null, removed: node } : { node, removed: null };
  }

  const first = removeLeafFromNode(node.first, leafId);
  if (first.removed) {
    return {
      node: first.node ? { ...node, first: first.node } : node.second,
      removed: first.removed,
    };
  }

  const second = removeLeafFromNode(node.second, leafId);
  if (second.removed) {
    return {
      node: second.node ? { ...node, second: second.node } : node.first,
      removed: second.removed,
    };
  }

  return { node, removed: null };
}

export function pruneEmptyWorkbenchPanelLeaves(
  layout: WorkbenchPanelLayout,
  options: PruneEmptyPanelLeavesOptions = {},
): WorkbenchPanelLayoutV2 {
  const allTabIds = flattenWorkbenchPanelTabIds(layout);
  const normalized = normalizeWorkbenchPanelLayout(layout, allTabIds, options);
  const leaves = listWorkbenchPanelLeaves(normalized);
  if (leaves.length <= 1) return normalized;

  const preserved = new Set(options.preserveLeafIds ?? []);
  const emptyLeafIds = leaves
    .filter((leaf) => leaf.tabIds.length === 0 && !preserved.has(leaf.id))
    .map((leaf) => leaf.id);
  if (emptyLeafIds.length === 0) return normalized;

  const removableLeafIds = new Set(emptyLeafIds);
  if (leaves.length - removableLeafIds.size <= 0) {
    const fallbackLeaf =
      findWorkbenchPanelLeaf(normalized, options.preferredActiveLeafId) ??
      findWorkbenchPanelLeafForTab(normalized, options.preferredActiveTabId) ??
      getWorkbenchPanelActiveLeaf(normalized) ??
      leaves[0];
    if (fallbackLeaf) removableLeafIds.delete(fallbackLeaf.id);
  }

  let root: WorkbenchPanelNode | null = normalized.root;
  for (const leafId of removableLeafIds) {
    if (!root) break;
    root = removeLeafFromNode(root, leafId).node;
  }
  if (!root) root = makeLeaf("main", [], null);

  return normalizeWorkbenchPanelLayout(
    {
      ...normalized,
      root,
      maximizedLeafId:
        normalized.maximizedLeafId && removableLeafIds.has(normalized.maximizedLeafId)
          ? null
          : normalized.maximizedLeafId,
    },
    flattenWorkbenchPanelTabIds({ ...normalized, root }),
    {
      preferredActiveLeafId: options.preferredActiveLeafId ?? normalized.activeLeafId,
      preferredActiveTabId:
        options.preferredActiveTabId ?? getWorkbenchPanelActiveLeaf(normalized).activeTabId,
    },
  );
}

export function moveWorkbenchPanelLeaf(
  layout: WorkbenchPanelLayout,
  input: MovePanelLeafInput,
): WorkbenchPanelLayoutV2 {
  const normalized = normalizeWorkbenchPanelLayout(layout, flattenWorkbenchPanelTabIds(layout), {
    preferredActiveLeafId: input.sourceLeafId,
  });
  const sourceLeaf = findWorkbenchPanelLeaf(normalized, input.sourceLeafId);
  const targetLeaf = findWorkbenchPanelLeaf(normalized, input.targetLeafId);
  const leaves = listWorkbenchPanelLeaves(normalized);
  if (!sourceLeaf || !targetLeaf || sourceLeaf.id === targetLeaf.id || leaves.length <= 1)
    return normalized;

  const removed = removeLeafFromNode(normalized.root, sourceLeaf.id);
  if (!removed.node || !removed.removed) return normalized;

  const direction = input.side === "left" || input.side === "right" ? "horizontal" : "vertical";
  const movedLeaf = removed.removed;
  const newBranch: WorkbenchPanelSplitBranch = {
    type: "split",
    id: input.newBranchId,
    direction,
    first: input.side === "left" || input.side === "up" ? movedLeaf : targetLeaf,
    second: input.side === "left" || input.side === "up" ? targetLeaf : movedLeaf,
    ratio: 0.5,
  };
  const root = replaceLeaf(removed.node, targetLeaf.id, newBranch);
  return normalizeWorkbenchPanelLayout(
    {
      ...normalized,
      root,
      activeLeafId: movedLeaf.id,
      mruLeafIds: [
        movedLeaf.id,
        ...normalized.mruLeafIds.filter((leafId) => leafId !== movedLeaf.id),
      ],
      maximizedLeafId: null,
    },
    flattenWorkbenchPanelTabIds({ ...normalized, root }),
    {
      preferredActiveLeafId: movedLeaf.id,
      preferredActiveTabId: movedLeaf.activeTabId,
    },
  );
}

export function mergeWorkbenchPanelLeaf(
  layout: WorkbenchPanelLayout,
  leafId: string,
): WorkbenchPanelLayoutV2 {
  const normalized = normalizeWorkbenchPanelLayout(layout, flattenWorkbenchPanelTabIds(layout), {
    preferredActiveLeafId: leafId,
  });
  const leaves = listWorkbenchPanelLeaves(normalized);
  if (leaves.length <= 1) return normalized;

  const leafIndex = leaves.findIndex((leaf) => leaf.id === leafId);
  if (leafIndex < 0) return normalized;

  const targetLeaf = leaves[leafIndex - 1] ?? leaves[leafIndex + 1] ?? leaves[0];
  if (!targetLeaf || targetLeaf.id === leafId) return normalized;

  const removed = removeLeafFromNode(normalized.root, leafId);
  if (!removed.node || !removed.removed) return normalized;

  const mergedRoot = updateLeafTabs(removed.node, targetLeaf.id, (leaf) =>
    makeLeaf(
      leaf.id,
      uniqueStrings([...leaf.tabIds, ...removed.removed!.tabIds]),
      removed.removed!.activeTabId ?? leaf.activeTabId,
      uniqueStrings([
        ...(removed.removed!.activeTabId ? [removed.removed!.activeTabId] : []),
        ...removed.removed!.mruTabIds,
        ...leaf.mruTabIds,
      ]),
    ),
  );
  return normalizeWorkbenchPanelLayout(
    {
      ...normalized,
      root: mergedRoot,
      activeLeafId: targetLeaf.id,
      mruLeafIds: [
        targetLeaf.id,
        ...normalized.mruLeafIds.filter((candidate) => candidate !== leafId),
      ],
      maximizedLeafId: normalized.maximizedLeafId === leafId ? null : normalized.maximizedLeafId,
    },
    flattenWorkbenchPanelTabIds({ ...normalized, root: mergedRoot }),
    {
      preferredActiveLeafId: targetLeaf.id,
      preferredActiveTabId: removed.removed.activeTabId,
    },
  );
}

export function setWorkbenchPanelBranchRatio(
  layout: WorkbenchPanelLayout,
  branchId: string,
  ratio: number,
): WorkbenchPanelLayoutV2 {
  const normalized = normalizeWorkbenchPanelLayout(layout, flattenWorkbenchPanelTabIds(layout));
  const root = mapNode(normalized.root, (node) => {
    if (node.type !== "split" || node.id !== branchId) return node;
    return {
      ...node,
      ratio: clampRatio(ratio),
    };
  });
  return normalizeWorkbenchPanelLayout(
    { ...normalized, root },
    flattenWorkbenchPanelTabIds(normalized),
  );
}

export function setWorkbenchPanelMaximizedLeaf(
  layout: WorkbenchPanelLayout,
  leafId: string | null,
): WorkbenchPanelLayoutV2 {
  const normalized = normalizeWorkbenchPanelLayout(layout, flattenWorkbenchPanelTabIds(layout), {
    preferredActiveLeafId: leafId,
  });
  const maximizedLeafId = leafId && findWorkbenchPanelLeaf(normalized, leafId) ? leafId : null;
  return {
    ...activateWorkbenchPanelLeaf(normalized, maximizedLeafId ?? normalized.activeLeafId),
    maximizedLeafId,
  };
}
