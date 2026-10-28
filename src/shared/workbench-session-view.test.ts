import { describe, expect, test } from "vite-plus/test";

import { WorkbenchSessionViewSnapshotSchema } from "./schemas/workbench-session-view";
import {
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
import { primaryCanvasBlockId } from "./block-documents";

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
        bottom: { ...source.panels.bottom, side: "left", size: { widthPx: 600, fullWidth: true } },
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
