export type DockPanelKind = "cardstage" | "terminal" | "history";

export interface DockTab {
  id: string;
  kind: DockPanelKind;
  title: string;
}

export interface DockLeaf {
  type: "leaf";
  id: string;
  tabs: DockTab[];
  activeTabId: string | null;
}

export interface DockSplit {
  type: "split";
  id: string;
  direction: "row" | "column";
  ratio: number;
  first: DockTreeNode;
  second: DockTreeNode;
}

export type DockTreeNode = DockLeaf | DockSplit;

const DEFAULT_TABS: DockTab[] = [
  { id: "cardstage", kind: "cardstage", title: "Card" },
  { id: "terminal", kind: "terminal", title: "Terminal" },
  { id: "history", kind: "history", title: "History" },
];

function makeId(): string {
  return crypto.randomUUID();
}

export function createDefaultDockLeaf(): DockLeaf {
  return {
    type: "leaf",
    id: makeId(),
    tabs: [...DEFAULT_TABS],
    activeTabId: "cardstage",
  };
}

export function createDefaultDockTree(): DockTreeNode {
  return createDefaultDockLeaf();
}

export function countDockLeaves(node: DockTreeNode): number {
  if (node.type === "leaf") return 1;
  return countDockLeaves(node.first) + countDockLeaves(node.second);
}

export function setLeafActiveTab(
  node: DockTreeNode,
  leafId: string,
  tabId: string,
): DockTreeNode {
  if (node.type === "leaf") {
    if (node.id !== leafId) return node;
    const hasTab = node.tabs.some((tab) => tab.id === tabId);
    if (!hasTab) return node;
    if (node.activeTabId === tabId) return node;
    return { ...node, activeTabId: tabId };
  }

  const nextFirst = setLeafActiveTab(node.first, leafId, tabId);
  const nextSecond = setLeafActiveTab(node.second, leafId, tabId);
  if (nextFirst === node.first && nextSecond === node.second) return node;
  return { ...node, first: nextFirst, second: nextSecond };
}

export function splitDockLeaf(
  node: DockTreeNode,
  leafId: string,
  direction: "row" | "column",
  maxLeaves = 3,
): DockTreeNode {
  if (countDockLeaves(node) >= maxLeaves) return node;

  function splitRec(current: DockTreeNode): [DockTreeNode, boolean] {
    if (current.type === "leaf") {
      if (current.id !== leafId) return [current, false];
      const clonedCurrent: DockLeaf = {
        ...current,
        tabs: [...current.tabs],
      };
      const sibling = createDefaultDockLeaf();
      return [
        {
          type: "split",
          id: makeId(),
          direction,
          ratio: 0.5,
          first: clonedCurrent,
          second: sibling,
        },
        true,
      ];
    }

    const [nextFirst, firstChanged] = splitRec(current.first);
    if (firstChanged) {
      return [{ ...current, first: nextFirst }, true];
    }

    const [nextSecond, secondChanged] = splitRec(current.second);
    if (secondChanged) {
      return [{ ...current, second: nextSecond }, true];
    }

    return [current, false];
  }

  const [next, changed] = splitRec(node);
  return changed ? next : node;
}

function removeLeafRec(
  node: DockTreeNode,
  leafId: string,
): [DockTreeNode | null, boolean] {
  if (node.type === "leaf") {
    if (node.id !== leafId) return [node, false];
    return [null, true];
  }

  const [nextFirst, firstRemoved] = removeLeafRec(node.first, leafId);
  if (firstRemoved) {
    if (!nextFirst) return [node.second, true];
    return [{ ...node, first: nextFirst }, true];
  }

  const [nextSecond, secondRemoved] = removeLeafRec(node.second, leafId);
  if (secondRemoved) {
    if (!nextSecond) return [node.first, true];
    return [{ ...node, second: nextSecond }, true];
  }

  return [node, false];
}

export function closeDockLeaf(node: DockTreeNode, leafId: string): DockTreeNode {
  if (node.type === "leaf") return node;
  const [next, removed] = removeLeafRec(node, leafId);
  if (!removed || !next) return node;
  return next;
}

export function setDockSplitRatio(
  node: DockTreeNode,
  splitId: string,
  ratio: number,
): DockTreeNode {
  const clamped = Math.max(0.15, Math.min(0.85, ratio));

  if (node.type === "leaf") return node;
  if (node.id === splitId) {
    if (Math.abs(node.ratio - clamped) < 0.0001) return node;
    return { ...node, ratio: clamped };
  }

  const nextFirst = setDockSplitRatio(node.first, splitId, clamped);
  const nextSecond = setDockSplitRatio(node.second, splitId, clamped);
  if (nextFirst === node.first && nextSecond === node.second) return node;
  return { ...node, first: nextFirst, second: nextSecond };
}

export function collectDockLeafIds(node: DockTreeNode): string[] {
  if (node.type === "leaf") return [node.id];
  return [...collectDockLeafIds(node.first), ...collectDockLeafIds(node.second)];
}

export function findDockLeaf(node: DockTreeNode, leafId: string): DockLeaf | null {
  if (node.type === "leaf") {
    return node.id === leafId ? node : null;
  }

  const fromFirst = findDockLeaf(node.first, leafId);
  if (fromFirst) return fromFirst;
  return findDockLeaf(node.second, leafId);
}
