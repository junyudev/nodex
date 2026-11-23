import { describe, expect, test } from "vite-plus/test";
import type { WorkbenchPanelLayout } from "./workbench-session-view";
import {
  activateWorkbenchPanelLeaf,
  flattenWorkbenchPanelTabIds,
  findNearestWorkbenchPanelLeafToRight,
  getWorkbenchPanelActiveLeaf,
  getWorkbenchPanelTopLeftLeafId,
  getWorkbenchPanelTopRightLeafId,
  insertWorkbenchPanelTabInBackground,
  insertWorkbenchPanelLeaf,
  listWorkbenchPanelLeaves,
  makeWorkbenchPanelLayout,
  mergeWorkbenchPanelLeaf,
  moveWorkbenchPanelLeaf,
  moveWorkbenchPanelTab,
  normalizeWorkbenchPanelLayout,
  pruneEmptyWorkbenchPanelLeaves,
  removeWorkbenchPanelTab,
  resolveWorkbenchPanelTabAfterClose,
  reorderWorkbenchPanelLeafTabs,
  setWorkbenchPanelBranchRatio,
  setWorkbenchPanelMaximizedLeaf,
  splitWorkbenchPanelLeaf,
} from "./workbench-panel-layout";

describe("project session panel layout", () => {
  test("falls back to a v2 layout when the stored layout is missing", () => {
    const normalized = normalizeWorkbenchPanelLayout(null, ["one", "two"], {
      preferredActiveTabId: "two",
    });

    expect(normalized.version).toBe(2);
    expect(normalized.activeLeafId).toBe("main");
    expect(JSON.stringify(normalized.mruLeafIds)).toBe(JSON.stringify(["main"]));
    expect(getWorkbenchPanelActiveLeaf(normalized).activeTabId).toBe("two");
    expect(JSON.stringify(flattenWorkbenchPanelTabIds(normalized))).toBe(
      JSON.stringify(["one", "two"]),
    );
  });

  test("normalizes legacy leaves without tab MRU", () => {
    const legacyLayout = {
      version: 2,
      root: { type: "leaf", id: "main", tabIds: ["one", "two"], activeTabId: "two" },
      activeLeafId: "main",
      mruLeafIds: ["main"],
      maximizedLeafId: null,
    } as unknown as WorkbenchPanelLayout;

    const normalized = normalizeWorkbenchPanelLayout(legacyLayout, ["one", "two"]);
    const activeLeaf = getWorkbenchPanelActiveLeaf(normalized);

    expect(activeLeaf.activeTabId).toBe("two");
    expect(JSON.stringify(activeLeaf.mruTabIds)).toBe(JSON.stringify(["two", "one"]));
  });

  test("tracks most recently active tabs inside a leaf", () => {
    const layout = makeWorkbenchPanelLayout(["one", "two", "three"], "one");
    const activatedTwo = activateWorkbenchPanelLeaf(layout, "main", "two");
    const activatedThree = activateWorkbenchPanelLeaf(activatedTwo, "main", "three");
    const activeLeaf = getWorkbenchPanelActiveLeaf(activatedThree);

    expect(activeLeaf.activeTabId).toBe("three");
    expect(JSON.stringify(activeLeaf.mruTabIds)).toBe(JSON.stringify(["three", "two", "one"]));
  });

  test("splits a leaf and moves the selected tab into the new group", () => {
    const layout = makeWorkbenchPanelLayout(["one", "two"], "one");
    const split = splitWorkbenchPanelLeaf(layout, {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });

    expect(split.root.type).toBe("split");
    expect(split.activeLeafId).toBe("leaf:right");
    expect(JSON.stringify(flattenWorkbenchPanelTabIds(split))).toBe(JSON.stringify(["one", "two"]));
    expect(getWorkbenchPanelActiveLeaf(split).activeTabId).toBe("two");
  });

  test("inserts an empty right sibling leaf without moving existing tabs", () => {
    const layout = makeWorkbenchPanelLayout(["one"], "one");
    const inserted = insertWorkbenchPanelLeaf(layout, {
      leafId: "main",
      side: "right",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });
    const leaves = listWorkbenchPanelLeaves(inserted);
    const main = leaves.find((leaf) => leaf.id === "main");
    const right = leaves.find((leaf) => leaf.id === "leaf:right");

    expect(inserted.root.type).toBe("split");
    expect(inserted.activeLeafId).toBe("leaf:right");
    expect(JSON.stringify(main?.tabIds ?? [])).toBe(JSON.stringify(["one"]));
    expect(JSON.stringify(right?.tabIds ?? [])).toBe(JSON.stringify([]));
    expect(JSON.stringify(flattenWorkbenchPanelTabIds(inserted))).toBe(JSON.stringify(["one"]));
  });

  test("does not insert an empty leaf when the source leaf is missing", () => {
    const layout = makeWorkbenchPanelLayout(["one"], "one");
    const inserted = insertWorkbenchPanelLeaf(layout, {
      leafId: "missing",
      side: "right",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });

    expect(inserted.root.type).toBe("leaf");
    expect(listWorkbenchPanelLeaves(inserted).length).toBe(1);
    expect(JSON.stringify(flattenWorkbenchPanelTabIds(inserted))).toBe(JSON.stringify(["one"]));
  });

  test("moves a tab between leaves without duplicating ownership", () => {
    const split = splitWorkbenchPanelLeaf(
      makeWorkbenchPanelLayout(["one", "two", "three"], "one"),
      {
        leafId: "main",
        side: "right",
        tabId: "three",
        newLeafId: "leaf:right",
        newBranchId: "branch:root",
      },
    );

    const moved = moveWorkbenchPanelTab(split, {
      tabId: "one",
      targetLeafId: "leaf:right",
      targetIndex: 0,
    });

    const leaves = listWorkbenchPanelLeaves(moved);
    const main = leaves.find((leaf) => leaf.id === "main");
    const right = leaves.find((leaf) => leaf.id === "leaf:right");
    expect(JSON.stringify(main?.tabIds ?? [])).toBe(JSON.stringify(["two"]));
    expect(JSON.stringify(right?.tabIds ?? [])).toBe(JSON.stringify(["one", "three"]));
    expect(JSON.stringify(flattenWorkbenchPanelTabIds(moved))).toBe(
      JSON.stringify(["two", "one", "three"]),
    );
  });

  test("inserts a background tab without changing active, MRU, or maximize state", () => {
    const split = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });
    const activeLeft = activateWorkbenchPanelLeaf(split, "main", "one");
    const maximizedLeft = setWorkbenchPanelMaximizedLeaf(activeLeft, "main");
    const before = structuredClone(maximizedLeft);

    const inserted = insertWorkbenchPanelTabInBackground(maximizedLeft, {
      tabId: "three",
      targetLeafId: "leaf:right",
    });

    expect(inserted.activeLeafId).toBe(before.activeLeafId);
    expect(inserted.mruLeafIds).toEqual(before.mruLeafIds);
    expect(inserted.maximizedLeafId).toBe(before.maximizedLeafId);
    const beforeLeft = listWorkbenchPanelLeaves(before).find((leaf) => leaf.id === "main");
    const insertedLeft = listWorkbenchPanelLeaves(inserted).find((leaf) => leaf.id === "main");
    const insertedRight = listWorkbenchPanelLeaves(inserted).find(
      (leaf) => leaf.id === "leaf:right",
    );
    expect(insertedLeft).toEqual(beforeLeft);
    expect(insertedRight).toMatchObject({
      tabIds: ["two", "three"],
      activeTabId: "two",
      mruTabIds: ["two", "three"],
    });
  });

  test("gives an empty target leaf local activity without changing the global active leaf", () => {
    const withEmptyRight = insertWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one"], "one"), {
      leafId: "main",
      side: "right",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });
    const activeLeft = activateWorkbenchPanelLeaf(withEmptyRight, "main", "one");

    const inserted = insertWorkbenchPanelTabInBackground(activeLeft, {
      tabId: "two",
      targetLeafId: "leaf:right",
    });

    expect(inserted.activeLeafId).toBe("main");
    expect(getWorkbenchPanelActiveLeaf(inserted).activeTabId).toBe("one");
    expect(
      listWorkbenchPanelLeaves(inserted).find((leaf) => leaf.id === "leaf:right"),
    ).toMatchObject({
      tabIds: ["two"],
      activeTabId: "two",
      mruTabIds: ["two"],
    });
  });

  test("reorders one leaf without changing sibling order or the active leaf", () => {
    const split = splitWorkbenchPanelLeaf(
      makeWorkbenchPanelLayout(["one", "two", "three"], "one"),
      {
        leafId: "main",
        side: "right",
        tabId: "three",
        newLeafId: "leaf:right",
        newBranchId: "branch:root",
      },
    );

    const reordered = reorderWorkbenchPanelLeafTabs(split, "main", ["two", "one"]);

    expect(JSON.stringify(flattenWorkbenchPanelTabIds(reordered))).toBe(
      JSON.stringify(["two", "one", "three"]),
    );
    expect(reordered.activeLeafId).toBe(split.activeLeafId);
    expect(reordered.mruLeafIds).toEqual(split.mruLeafIds);
  });

  test("resolves the top-right leaf for single and direct split trees", () => {
    const single = makeWorkbenchPanelLayout(["one"], "one");
    const horizontal = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:horizontal",
    });
    const vertical = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "down",
      tabId: "two",
      newLeafId: "leaf:bottom",
      newBranchId: "branch:vertical",
    });

    expect(getWorkbenchPanelTopRightLeafId(single.root)).toBe("main");
    expect(getWorkbenchPanelTopRightLeafId(horizontal.root)).toBe("leaf:right");
    expect(getWorkbenchPanelTopRightLeafId(vertical.root)).toBe("main");
    expect(getWorkbenchPanelTopLeftLeafId(single.root)).toBe("main");
    expect(getWorkbenchPanelTopLeftLeafId(horizontal.root)).toBe("main");
    expect(getWorkbenchPanelTopLeftLeafId(vertical.root)).toBe("main");
  });

  test("resolves the top-right leaf through nested split trees", () => {
    const baseRightSplit = splitWorkbenchPanelLeaf(
      makeWorkbenchPanelLayout(["one", "two", "three"], "one"),
      {
        leafId: "main",
        side: "right",
        tabId: "three",
        newLeafId: "leaf:right",
        newBranchId: "branch:root",
      },
    );
    const rightWithTwoTabs = moveWorkbenchPanelTab(baseRightSplit, {
      tabId: "two",
      targetLeafId: "leaf:right",
      targetIndex: 0,
    });
    const rightSplit = splitWorkbenchPanelLeaf(rightWithTwoTabs, {
      leafId: "leaf:right",
      side: "down",
      tabId: "three",
      newLeafId: "leaf:right-bottom",
      newBranchId: "branch:right",
    });
    const topSplit = splitWorkbenchPanelLeaf(
      splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two", "three"], "one"), {
        leafId: "main",
        side: "down",
        tabId: "three",
        newLeafId: "leaf:bottom",
        newBranchId: "branch:root",
      }),
      {
        leafId: "main",
        side: "right",
        tabId: "two",
        newLeafId: "leaf:top-right",
        newBranchId: "branch:top",
      },
    );

    expect(getWorkbenchPanelTopRightLeafId(rightSplit.root)).toBe("leaf:right");
    expect(getWorkbenchPanelTopRightLeafId(topSplit.root)).toBe("leaf:top-right");
    expect(getWorkbenchPanelTopLeftLeafId(rightSplit.root)).toBe("main");
    expect(getWorkbenchPanelTopLeftLeafId(topSplit.root)).toBe("main");
  });

  test("resolves the nearest leaf to the right for a direct horizontal split", () => {
    const split = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });

    expect(findNearestWorkbenchPanelLeafToRight(split, "main")).toBe("leaf:right");
  });

  test("resolves the vertically aligned nearest leaf when multiple right leaves exist", () => {
    const layout: WorkbenchPanelLayout = {
      version: 2,
      activeLeafId: "leaf:left-top",
      mruLeafIds: ["leaf:left-top"],
      maximizedLeafId: null,
      root: {
        type: "split",
        id: "branch:root",
        direction: "horizontal",
        ratio: 0.5,
        first: {
          type: "split",
          id: "branch:left",
          direction: "vertical",
          ratio: 0.5,
          first: {
            type: "leaf",
            id: "leaf:left-top",
            tabIds: ["one"],
            activeTabId: "one",
            mruTabIds: ["one"],
          },
          second: {
            type: "leaf",
            id: "leaf:left-bottom",
            tabIds: ["two"],
            activeTabId: "two",
            mruTabIds: ["two"],
          },
        },
        second: {
          type: "split",
          id: "branch:right",
          direction: "vertical",
          ratio: 0.5,
          first: {
            type: "leaf",
            id: "leaf:right-top",
            tabIds: ["three"],
            activeTabId: "three",
            mruTabIds: ["three"],
          },
          second: {
            type: "leaf",
            id: "leaf:right-bottom",
            tabIds: ["four"],
            activeTabId: "four",
            mruTabIds: ["four"],
          },
        },
      },
    };

    expect(findNearestWorkbenchPanelLeafToRight(layout, "leaf:left-top")).toBe("leaf:right-top");
    expect(findNearestWorkbenchPanelLeafToRight(layout, "leaf:left-bottom")).toBe(
      "leaf:right-bottom",
    );
  });

  test("does not resolve a right leaf for vertical-only layouts", () => {
    const split = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "down",
      tabId: "two",
      newLeafId: "leaf:bottom",
      newBranchId: "branch:root",
    });

    expect(findNearestWorkbenchPanelLeafToRight(split, "main")).toBe(null);
  });

  test("returns null when the source leaf is already rightmost", () => {
    const split = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });

    expect(findNearestWorkbenchPanelLeafToRight(split, "leaf:right")).toBe(null);
  });

  test("merges a non-empty leaf into its nearest visual neighbor", () => {
    const split = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });

    const merged = mergeWorkbenchPanelLeaf(split, "leaf:right");

    expect(listWorkbenchPanelLeaves(merged).length).toBe(1);
    expect(JSON.stringify(flattenWorkbenchPanelTabIds(merged))).toBe(
      JSON.stringify(["one", "two"]),
    );
  });

  test("clamps branch resize ratios", () => {
    const split = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });

    const resized = setWorkbenchPanelBranchRatio(split, "branch:root", 0.99);

    expect(resized.root.type).toBe("split");
    if (resized.root.type === "split") {
      expect(resized.root.ratio).toBe(0.85);
    }
  });

  test("does not split a single-tab leaf into an empty source group", () => {
    const layout = makeWorkbenchPanelLayout(["one"], "one");
    const split = splitWorkbenchPanelLeaf(layout, {
      leafId: "main",
      side: "right",
      tabId: "one",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });

    expect(split.root.type).toBe("leaf");
    expect(listWorkbenchPanelLeaves(split).length).toBe(1);
    expect(JSON.stringify(flattenWorkbenchPanelTabIds(split))).toBe(JSON.stringify(["one"]));
  });

  test("splits a temporarily unassigned moved tab from a multi-tab target leaf", () => {
    const layout = makeWorkbenchPanelLayout(["one", "two"], "one");
    const withoutDraggedTab = removeWorkbenchPanelTab(layout, "two");
    const split = splitWorkbenchPanelLeaf(withoutDraggedTab, {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });
    const leaves = listWorkbenchPanelLeaves(split);

    expect(leaves.length).toBe(2);
    expect(JSON.stringify(leaves[0]?.tabIds ?? [])).toBe(JSON.stringify(["one"]));
    expect(JSON.stringify(leaves[1]?.tabIds ?? [])).toBe(JSON.stringify(["two"]));
    expect(split.activeLeafId).toBe("leaf:right");
  });

  test("prunes empty split leaves and collapses parent branches", () => {
    const split = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });
    const emptyRight = removeWorkbenchPanelTab(split, "two");
    const pruned = pruneEmptyWorkbenchPanelLeaves(emptyRight);

    expect(listWorkbenchPanelLeaves(pruned).length).toBe(1);
    expect(pruned.root.type).toBe("leaf");
    expect(JSON.stringify(flattenWorkbenchPanelTabIds(pruned))).toBe(JSON.stringify(["one"]));
  });

  test("uses a preferred active tab when removing the active tab", () => {
    const layout = makeWorkbenchPanelLayout(["one", "two", "three"], "two");
    const removed = removeWorkbenchPanelTab(layout, "two", {
      preferredActiveLeafId: "main",
      preferredActiveTabId: "three",
    });

    const activeLeaf = getWorkbenchPanelActiveLeaf(removed);
    expect(activeLeaf.activeTabId).toBe("three");
    expect(activeLeaf.mruTabIds[0]).toBe("three");
  });

  test("selects the physical right neighbor after active removal, then the left edge fallback", () => {
    const middleRemoved = removeWorkbenchPanelTab(
      makeWorkbenchPanelLayout(["one", "two", "three"], "two"),
      "two",
    );
    const lastRemoved = removeWorkbenchPanelTab(
      makeWorkbenchPanelLayout(["one", "two", "three"], "three"),
      "three",
    );

    expect(getWorkbenchPanelActiveLeaf(middleRemoved).activeTabId).toBe("three");
    expect(getWorkbenchPanelActiveLeaf(lastRemoved).activeTabId).toBe("two");
    expect(resolveWorkbenchPanelTabAfterClose(["one", "two", "three"], "missing")).toBeNull();
  });

  test("falls back when the preferred active tab is invalid after removal", () => {
    const layout = makeWorkbenchPanelLayout(["one", "two", "three"], "two");
    const removed = removeWorkbenchPanelTab(layout, "two", {
      preferredActiveLeafId: "main",
      preferredActiveTabId: "missing",
    });

    expect(getWorkbenchPanelActiveLeaf(removed).activeTabId).toBe("one");
  });

  test("keeps one fallback leaf when every leaf is empty", () => {
    const empty = removeWorkbenchPanelTab(makeWorkbenchPanelLayout(["one"], "one"), "one");
    const pruned = pruneEmptyWorkbenchPanelLeaves(empty);
    const leaves = listWorkbenchPanelLeaves(pruned);

    expect(leaves.length).toBe(1);
    expect(JSON.stringify(leaves[0]?.tabIds ?? [])).toBe(JSON.stringify([]));
  });

  test("falls back active and maximized leaf state when pruning the active empty leaf", () => {
    const split = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });
    const emptyRight = removeWorkbenchPanelTab(
      {
        ...split,
        activeLeafId: "leaf:right",
        maximizedLeafId: "leaf:right",
      },
      "two",
    );
    const pruned = pruneEmptyWorkbenchPanelLeaves(emptyRight);

    expect(pruned.activeLeafId).toBe("main");
    expect(pruned.maximizedLeafId ?? null).toBe(null);
    expect(JSON.stringify(pruned.mruLeafIds)).toBe(JSON.stringify(["main"]));
  });

  test("moves a whole single-tab leaf next to a target leaf", () => {
    const split = splitWorkbenchPanelLeaf(makeWorkbenchPanelLayout(["one", "two"], "one"), {
      leafId: "main",
      side: "right",
      tabId: "two",
      newLeafId: "leaf:right",
      newBranchId: "branch:root",
    });
    const moved = moveWorkbenchPanelLeaf(split, {
      sourceLeafId: "leaf:right",
      targetLeafId: "main",
      side: "left",
      newBranchId: "branch:moved",
    });

    expect(moved.root.type).toBe("split");
    expect(moved.activeLeafId).toBe("leaf:right");
    expect(JSON.stringify(flattenWorkbenchPanelTabIds(moved))).toBe(JSON.stringify(["two", "one"]));
  });
});
