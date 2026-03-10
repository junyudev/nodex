import { describe, expect, test } from "bun:test";
import {
  closeDockLeaf,
  collectDockLeafIds,
  countDockLeaves,
  createDefaultDockTree,
  findDockLeaf,
  setDockSplitRatio,
  setLeafActiveTab,
  splitDockLeaf,
} from "./dock-layout";

describe("dock-layout", () => {
  test("split leaf increases leaf count", () => {
    const root = createDefaultDockTree();
    const firstLeaf = collectDockLeafIds(root)[0];

    const next = splitDockLeaf(root, firstLeaf, "row");

    expect(countDockLeaves(root)).toBe(1);
    expect(countDockLeaves(next)).toBe(2);
  });

  test("split is capped by max leaves", () => {
    const root = createDefaultDockTree();
    const firstLeaf = collectDockLeafIds(root)[0];
    const two = splitDockLeaf(root, firstLeaf, "row", 3);
    const leaves = collectDockLeafIds(two);
    const three = splitDockLeaf(two, leaves[1], "column", 3);
    const stillThree = splitDockLeaf(three, collectDockLeafIds(three)[2], "row", 3);

    expect(countDockLeaves(three)).toBe(3);
    expect(stillThree).toBe(three);
  });

  test("close leaf rebalances split tree", () => {
    const root = createDefaultDockTree();
    const firstLeaf = collectDockLeafIds(root)[0];
    const split = splitDockLeaf(root, firstLeaf, "row");
    const [left, right] = collectDockLeafIds(split);

    const closed = closeDockLeaf(split, right);

    expect(countDockLeaves(closed)).toBe(1);
    expect(JSON.stringify(collectDockLeafIds(closed))).toBe(JSON.stringify([left]));
  });

  test("set active tab on leaf", () => {
    const root = createDefaultDockTree();
    const leafId = collectDockLeafIds(root)[0];

    const next = setLeafActiveTab(root, leafId, "history");
    const leaf = findDockLeaf(next, leafId);

    expect(leaf?.activeTabId).toBe("history");
  });

  test("set split ratio clamps bounds", () => {
    const root = createDefaultDockTree();
    const firstLeaf = collectDockLeafIds(root)[0];
    const split = splitDockLeaf(root, firstLeaf, "row");
    if (split.type !== "split") throw new Error("expected split root");

    const next = setDockSplitRatio(split, split.id, 0.99);
    if (next.type !== "split") throw new Error("expected split root");

    expect(next.ratio).toBe(0.85);
  });
});
