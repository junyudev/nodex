import { describe, expect, test } from "vite-plus/test";
import {
  type WorkbenchPanelLayout,
  activateWorkbenchSessionViewTab,
  cloneWorkbenchLayoutForNewWindow,
  createWorkbenchSessionViewTab,
  materializeInitialWorkbenchSessionView,
  maximizeWorkbenchSessionViewLeaf,
  moveWorkbenchSessionViewTab,
  normalizeWorkbenchSessionView,
  patchWorkbenchSessionViewPanel,
  removeWorkbenchSessionViewTab,
  reorderWorkbenchSessionViewTabs,
  resizeWorkbenchSessionViewBranch,
  splitWorkbenchSessionViewLeaf,
  type WorkbenchSessionViewIdentityFactory,
  type WorkbenchSessionViewSnapshot,
  type WorkbenchSessionViewTab,
} from "./workbench-session-view";
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
import { WorkbenchSessionViewSnapshotSchema } from "./schemas/workbench-session-view";
import { primaryCanvasBlockId } from "./block-documents";

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

describe("workbench session view", () => {
  function identityFactory(prefix: string): WorkbenchSessionViewIdentityFactory {
    let next = 0;
    return {
      createId(kind) {
        next += 1;
        return `${prefix}:${kind}:${next}`;
      },
    };
  }

  function pageTab(id: string, pageId: string): WorkbenchSessionViewTab {
    return {
      id,
      kind: "page_stage",
      titleSnapshot: `Page ${pageId}`,
      config: {
        projectId: "project-1",
        pageId,
      },
      stateKey: 0,
      state: null,
    };
  }

  function materializedView(): WorkbenchSessionViewSnapshot {
    return materializeInitialWorkbenchSessionView(
      {
        id: "session-1",
        projectId: "project-1",
        databaseViewId: "view-1",
      },
      {
        identityFactory: identityFactory("initial"),
        touchedAt: "2026-07-23T00:00:00.000Z",
      },
    );
  }

  describe("WorkbenchSessionView", () => {
    test.each(["left", "right"] as const)(
      "preserves %s placement through patches, schema, normalization and window cloning",
      (side) => {
        const source = patchWorkbenchSessionViewPanel(materializedView(), "right", {
          side,
          collapsed: true,
        });
        const normalized = normalizeWorkbenchSessionView(
          WorkbenchSessionViewSnapshotSchema.parse(source),
        );
        const cloned = cloneWorkbenchLayoutForNewWindow(
          { sessionViewsBySessionId: { "session-1": normalized } },
          identityFactory("side-clone"),
        ).sessionViewsBySessionId["session-1"]!;
        expect(normalized.panels.right).toMatchObject({
          side,
          collapsed: true,
          size: { fullWidth: true },
        });
        expect(cloned.panels.right).toMatchObject({
          side,
          collapsed: true,
          size: { fullWidth: true },
        });
        expect(WorkbenchSessionViewSnapshotSchema.parse(cloned)).toEqual(cloned);
      },
    );

    test("drops side and width from bottom panels during normalization and patching", () => {
      const source = materializedView();
      const parsed = WorkbenchSessionViewSnapshotSchema.parse({
        ...source,
        panels: {
          ...source.panels,
          bottom: {
            ...source.panels.bottom,
            side: "left",
            size: { widthPx: 600, fullWidth: true },
          },
        },
      });
      const normalized = normalizeWorkbenchSessionView(parsed);
      const patched = patchWorkbenchSessionViewPanel(normalized, "bottom", { side: "right" });
      expect(normalized.panels.bottom).not.toHaveProperty("side");
      expect(normalized.panels.bottom.size).toEqual({ heightPx: 280 });
      expect(patched.panels.bottom).not.toHaveProperty("side");
    });

    test("migrates the v1 view envelope to the current envelope", () => {
      const current = materializedView();
      const migrated = WorkbenchSessionViewSnapshotSchema.parse({
        ...current,
        version: 1,
      });

      expect(migrated.version).toBe(4);
      expect(migrated.sessionId).toBe(current.sessionId);
      expect(migrated.tabsById).toEqual(current.tabsById);
    });

    test("migrates a v2 primary Canvas DB tab in place without disturbing panel identity", () => {
      const current = materializedView();
      const tabId = Object.keys(current.tabsById)[0]!;
      const legacy = {
        ...current,
        version: 2,
        tabsById: {
          ...current.tabsById,
          [tabId]: {
            ...current.tabsById[tabId],
            titleSnapshot: "Project canvas",
            config: {
              projectId: "project-1",
              databaseViewId: "view-1",
              view: "canvas",
            },
          },
        },
      };
      const beforePanel = structuredClone(legacy.panels);

      const migrated = WorkbenchSessionViewSnapshotSchema.parse(legacy);

      expect(migrated.version).toBe(4);
      expect(migrated.tabsById[tabId]).toEqual({
        ...legacy.tabsById[tabId],
        kind: "canvas_stage",
        state: null,
        config: {
          projectId: "project-1",
          canvasBlockId: primaryCanvasBlockId("project-1"),
          titleSnapshot: "Project canvas",
        },
      });
      expect(migrated.panels).toEqual(beforePanel);
      expect(WorkbenchSessionViewSnapshotSchema.parse(migrated)).toEqual(migrated);
    });

    test("removes the v3 synthetic Database layout from tab identity", () => {
      const current = materializedView();
      const tabId = Object.keys(current.tabsById)[0]!;
      const tab = current.tabsById[tabId];
      if (tab?.kind !== "db_view") throw new Error("Expected Database tab");
      const legacy = {
        ...current,
        version: 3,
        tabsById: {
          ...current.tabsById,
          [tabId]: {
            ...tab,
            config: { ...tab.config, view: "toggle-list" },
          },
        },
      };

      const migrated = WorkbenchSessionViewSnapshotSchema.parse(legacy);

      expect(migrated.version).toBe(4);
      expect(migrated.tabsById[tabId]?.config).not.toHaveProperty("view");
      expect(WorkbenchSessionViewSnapshotSchema.parse(migrated)).toEqual(migrated);
    });

    test("accepts exact Canvas Stage identity and rejects document authority leakage", () => {
      const current = materializedView();
      const valid = createWorkbenchSessionViewTab(current, {
        panelId: "right",
        tab: {
          id: "canvas-tab",
          kind: "canvas_stage",
          titleSnapshot: "Sketch",
          config: {
            projectId: "project-1",
            canvasBlockId: "canvas-1",
            titleSnapshot: "Sketch",
          },
          stateKey: 0,
          state: null,
        },
      });

      expect(WorkbenchSessionViewSnapshotSchema.parse(valid)).toEqual(valid);
      expect(() =>
        WorkbenchSessionViewSnapshotSchema.parse({
          ...valid,
          tabsById: {
            ...valid.tabsById,
            "canvas-tab": {
              ...valid.tabsById["canvas-tab"],
              config: {
                projectId: "project-1",
                canvasBlockId: "canvas-1",
                documentId: "private-document-id",
              },
            },
          },
        }),
      ).toThrow();
    });

    test("materializes one initial Database view as a local right-panel tab", () => {
      const view = materializedView();
      const tab = Object.values(view.tabsById)[0];

      expect(tab).toMatchObject({
        kind: "db_view",
        config: {
          projectId: "project-1",
          databaseViewId: "view-1",
        },
      });
      expect(view.panels.right.collapsed).toBe(false);
      expect(view.panels.right.size.fullWidth).toBe(true);
      expect(view.panels.bottom.collapsed).toBe(true);
    });

    test("normalization retains the first cross-panel occurrence and repairs unplaced tabs", () => {
      const base = createWorkbenchSessionViewTab(materializedView(), {
        panelId: "bottom",
        tab: pageTab("page-tab", "page-1"),
      });
      const duplicate = {
        ...base,
        panels: {
          ...base.panels,
          bottom: {
            ...base.panels.bottom,
            layout: {
              ...base.panels.bottom.layout,
              root: {
                type: "leaf" as const,
                id: "bottom-leaf",
                tabIds: ["page-tab", Object.keys(base.tabsById)[0]!],
                activeTabId: "page-tab",
                mruTabIds: ["page-tab"],
              },
              activeLeafId: "bottom-leaf",
              mruLeafIds: ["bottom-leaf"],
            },
          },
        },
        tabsById: {
          ...base.tabsById,
          unplaced: pageTab("unplaced", "page-2"),
        },
      };

      const normalized = normalizeWorkbenchSessionView(duplicate);
      const rightIds = JSON.stringify(normalized.panels.right.layout);
      const bottomIds = JSON.stringify(normalized.panels.bottom.layout);

      expect(rightIds).toContain(Object.keys(base.tabsById)[0]!);
      expect(bottomIds).not.toContain(Object.keys(base.tabsById)[0]!);
      expect(rightIds).toContain("unplaced");
    });

    test("supports local create, activate, reorder, split, move, resize, and remove", () => {
      const ids = identityFactory("mutation");
      let view = materializedView();
      const dbTabId = Object.keys(view.tabsById)[0]!;
      view = createWorkbenchSessionViewTab(view, {
        panelId: "right",
        tab: pageTab("page-1", "page-1"),
      });
      view = createWorkbenchSessionViewTab(view, {
        panelId: "right",
        tab: pageTab("page-2", "page-2"),
      });
      const rightLeafId = view.panels.right.layout.activeLeafId;
      view = reorderWorkbenchSessionViewTabs(view, {
        panelId: "right",
        leafId: rightLeafId,
        orderedTabIds: ["page-2", dbTabId, "page-1"],
      });
      view = activateWorkbenchSessionViewTab(view, "right", rightLeafId, "page-2");
      view = splitWorkbenchSessionViewLeaf(view, {
        panelId: "right",
        leafId: rightLeafId,
        side: "right",
        tabId: "page-2",
        identityFactory: ids,
      });
      const branch = view.panels.right.layout.root;
      expect(branch.type).toBe("split");
      if (branch.type !== "split") throw new Error("Expected split");
      view = resizeWorkbenchSessionViewBranch(view, {
        panelId: "right",
        branchId: branch.id,
        ratio: 0.7,
      });
      expect(view.panels.right.layout.root).toMatchObject({ ratio: 0.7 });
      view = moveWorkbenchSessionViewTab(view, {
        tabId: "page-1",
        targetPanelId: "bottom",
      });
      view = removeWorkbenchSessionViewTab(view, dbTabId);

      expect(JSON.stringify(view.panels.bottom.layout)).toContain("page-1");
      expect(view.tabsById[dbTabId]).toBeUndefined();
      expect(WorkbenchSessionViewSnapshotSchema.parse(view)).toEqual(view);
    });

    test("creates a background tab without opening or focusing its panel", () => {
      let view = materializedView();
      const existingRightTabId = Object.keys(view.tabsById)[0]!;
      view = maximizeWorkbenchSessionViewLeaf(view, {
        panelId: "right",
        leafId: view.panels.right.layout.activeLeafId,
      });
      view = createWorkbenchSessionViewTab(view, {
        panelId: "bottom",
        tab: pageTab("bottom-tab", "bottom-page"),
      });
      view = createWorkbenchSessionViewTab(view, {
        panelId: "right",
        presentation: "background",
        tab: pageTab("right-tail", "right-tail-page"),
      });
      view = {
        ...view,
        panels: {
          ...view.panels,
          right: {
            ...view.panels.right,
            collapsed: true,
          },
        },
      };
      const beforeRightLayout = structuredClone(view.panels.right.layout);

      const created = createWorkbenchSessionViewTab(view, {
        panelId: "right",
        presentation: "background",
        targetIndex: 1,
        tab: pageTab("background-tab", "background-page"),
      });

      expect(created.panels.right.collapsed).toBe(true);
      expect(created.lastFocusedPanelId).toBe("bottom");
      expect(created.panels.right.layout.activeLeafId).toBe(beforeRightLayout.activeLeafId);
      expect(created.panels.right.layout.mruLeafIds).toEqual(beforeRightLayout.mruLeafIds);
      expect(created.panels.right.layout.maximizedLeafId).toBe(beforeRightLayout.maximizedLeafId);
      const activeLeaf = created.panels.right.layout.root;
      expect(activeLeaf.type).toBe("leaf");
      if (activeLeaf.type !== "leaf") throw new Error("Expected right root leaf");
      expect(activeLeaf.activeTabId).toBe(existingRightTabId);
      expect(activeLeaf.tabIds).toEqual([existingRightTabId, "background-tab", "right-tail"]);
      expect(WorkbenchSessionViewSnapshotSchema.parse(created)).toEqual(created);
    });

    test("clones local identities while retaining resource targets and Terminal resources", () => {
      let source = materializedView();
      source = createWorkbenchSessionViewTab(source, {
        panelId: "right",
        tab: {
          id: "browser-tab",
          kind: "browser",
          titleSnapshot: "Example",
          config: {
            browserTabId: "browser-runtime",
            browserStorageId: "browser:storage-source",
            url: "https://example.com",
            deviceToolbarState: {
              responsiveViewportSize: { width: 430, height: 932 },
              toolbarState: {
                isEnabled: true,
                presetId: "iphone-15-pro-max",
                width: 430,
                height: 932,
              },
            },
          },
          stateKey: 0,
          state: null,
        },
      });
      source = createWorkbenchSessionViewTab(source, {
        panelId: "bottom",
        tab: {
          id: "terminal-tab",
          kind: "terminal",
          titleSnapshot: "Shell",
          config: { terminalSessionId: "pty-1" },
          stateKey: 0,
          state: null,
        },
      });
      const clone = cloneWorkbenchLayoutForNewWindow(
        { sessionViewsBySessionId: { "session-1": source } },
        identityFactory("clone"),
      ).sessionViewsBySessionId["session-1"]!;
      const clonedTabs = Object.values(clone.tabsById);

      expect(Object.keys(clone.tabsById)).not.toEqual(Object.keys(source.tabsById));
      expect(clonedTabs.find((tab) => tab.kind === "db_view")?.config).toMatchObject({
        databaseViewId: "view-1",
      });
      expect(clonedTabs.find((tab) => tab.kind === "terminal")?.config).toEqual({
        terminalSessionId: "pty-1",
      });
      expect(clonedTabs.find((tab) => tab.kind === "browser")?.config).toMatchObject({
        url: "https://example.com",
        deviceToolbarState: {
          toolbarState: {
            isEnabled: true,
            presetId: "iphone-15-pro-max",
          },
        },
      });
      expect(clonedTabs.find((tab) => tab.kind === "browser")?.config).not.toMatchObject({
        browserTabId: "browser-runtime",
      });
      expect(clonedTabs.find((tab) => tab.kind === "browser")?.config).not.toMatchObject({
        browserStorageId: "browser:storage-source",
      });
    });

    test("two windows over one shared Session diverge without changing the other", () => {
      const source = materializedView();
      const layout = { sessionViewsBySessionId: { "session-1": source } };
      const windowA = cloneWorkbenchLayoutForNewWindow(layout, identityFactory("a"));
      const windowB = cloneWorkbenchLayoutForNewWindow(layout, identityFactory("b"));
      const beforeB = JSON.stringify(windowB);
      const viewA = windowA.sessionViewsBySessionId["session-1"]!;
      const changedA = createWorkbenchSessionViewTab(viewA, {
        panelId: "bottom",
        tab: pageTab("a:page", "shared-page"),
      });

      expect(changedA.sessionId).toBe(windowB.sessionViewsBySessionId["session-1"]?.sessionId);
      expect(JSON.stringify(windowB)).toBe(beforeB);
      expect(
        Object.values(changedA.tabsById).some(
          (tab) => tab.kind === "page_stage" && tab.config.pageId === "shared-page",
        ),
      ).toBe(true);
    });

    test("rejects mismatched discriminated configs", () => {
      const view = materializedView();
      const tabId = Object.keys(view.tabsById)[0]!;
      expect(() =>
        WorkbenchSessionViewSnapshotSchema.parse({
          ...view,
          tabsById: {
            [tabId]: {
              ...view.tabsById[tabId],
              kind: "terminal",
            },
          },
        }),
      ).toThrow();
    });
  });

  test("Page File descriptors survive the panel codec and normalization", () => {
    const tab: WorkbenchSessionViewTab = {
      id: "page-file",
      kind: "page_file",
      titleSnapshot: "report.html",
      stateKey: 0,
      state: null,
      config: {
        pageId: "page",
        fileId: "file",
        logicalPath: null,
      },
    };
    const view = createWorkbenchSessionViewTab(materializedView(), { panelId: "bottom", tab });
    expect(
      normalizeWorkbenchSessionView(
        WorkbenchSessionViewSnapshotSchema.parse(JSON.parse(JSON.stringify(view))),
      ).tabsById[tab.id],
    ).toEqual(tab);
  });
});
