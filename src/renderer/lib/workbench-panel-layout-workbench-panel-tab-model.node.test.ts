import { describe, expect, test } from "vite-plus/test";
import {
  buildSideChatParentNavigationPath,
  getPanelTabPlacement,
  isAutomationPanelTab,
  isBackgroundAgentPanelTab,
  isImageEditorPanelTab,
  isMcpAppPanelTab,
  isPanelTabClosable,
  isPlanPanelTab,
  isProcessOutputPanelTab,
  isRootThreadRightPanelComposerOverlayEligibleTab,
  isSideChatPanelTab,
  isSubagentsPanelTab,
  isTransientPanelTab,
  makeImageEditorPanelTabId,
  makeProcessOutputPanelTabId,
  routeDeletedSelectedSubagentsToOverview,
  settlePendingSubagentsPanelTab,
  updateImageEditorPanelTabTitle,
  updateSideChatPanelTabTitle,
  type ImageEditorPanelTab,
  type ProjectSessionRenderableTab,
  type SideChatPanelTab,
  type SubagentsPanelTab,
} from "./workbench-panel-tab-model";
import {
  makeTestWorkbenchSession,
  makeTestWorkbenchTab,
} from "@/components/workbench/workbench-testkit/panel-fixtures";
import {
  createWorkbenchPanelTabOpenerState,
  recordWorkbenchPanelTabActivated,
  recordWorkbenchPanelTabClosed,
  recordWorkbenchPanelTabMoved,
  recordWorkbenchPanelTabOpened,
  resolveWorkbenchPanelTabOpenerCloseReplacement,
} from "./workbench-panel-tab-opener-state";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import { buildWorkbenchScenePanelTabShortcutProjection } from "./workbench-panel-tab-shortcut";

describe("workbench panel tab model", () => {
  function transient(discriminant: string): ProjectSessionRenderableTab {
    return {
      [discriminant]: true,
      id: discriminant,
      sessionId: "session-1",
      projectId: "project-1",
      panelId: "right",
      title: discriminant,
      stateKey: 0,
    } as unknown as ProjectSessionRenderableTab;
  }

  describe("workbench panel tab model", () => {
    test("names only the addressed side tab without resetting its draft or shortening its request", () => {
      const first = transient("sideChat") as SideChatPanelTab;
      const second = { ...first, id: "other-side", stateKey: 12, title: "Side chat 2" };
      const tabs = [first, second];
      const title = "Long request ".repeat(200);
      const updated = updateSideChatPanelTabTitle(tabs, second.id, title);
      expect(updated[0]).toBe(first);
      expect(updated[1]).toEqual({ ...second, title });
      expect(updateSideChatPanelTabTitle(updated, second.id, title)).toBe(updated);
      expect(updateSideChatPanelTabTitle(updated, "closed-side", "Late request")).toBe(updated);
      expect(updateSideChatPanelTabTitle(updated, second.id, "  ")).toBe(updated);
    });
    test.each([
      ["sideChat", isSideChatPanelTab],
      ["mcpApp", isMcpAppPanelTab],
      ["planPanel", isPlanPanelTab],
      ["automationPanel", isAutomationPanelTab],
      ["backgroundAgent", isBackgroundAgentPanelTab],
      ["subagentsPanel", isSubagentsPanelTab],
      ["processOutputPanel", isProcessOutputPanelTab],
      ["imageEditor", isImageEditorPanelTab],
    ] as const)("recognizes only the %s discriminant", (kind, guard) => {
      expect(guard(transient(kind))).toBe(true);
      expect(guard(transient("different"))).toBe(false);
    });

    test("classifies every auxiliary family as transient", () => {
      for (const discriminant of [
        "sideChat",
        "mcpApp",
        "planPanel",
        "automationPanel",
        "backgroundAgent",
        "subagentsPanel",
        "processOutputPanel",
        "imageEditor",
      ]) {
        expect(isTransientPanelTab(transient(discriminant))).toBe(true);
      }
      expect(
        isTransientPanelTab(
          makeTestWorkbenchTab({
            id: "browser",
            kind: "browser",
          }),
        ),
      ).toBe(false);
    });

    test("keeps a remote side chat open until its native Thread exists", () => {
      const sideChat = {
        sideChat: true,
        id: "side-chat",
        sessionId: "session-1",
        panelId: "right",
        parentThreadId: "parent",
        parentNavigationPath: "path",
        threadId: null,
        title: "Side chat",
        status: "loading",
        stateKey: 0,
      } satisfies SideChatPanelTab;
      expect(isPanelTabClosable(sideChat)).toBe(false);
      expect(isPanelTabClosable({ ...sideChat, status: "ready" })).toBe(true);
      expect(isPanelTabClosable({ ...sideChat, status: "expired" })).toBe(true);
      expect(isPanelTabClosable({ ...sideChat, status: "failed" })).toBe(true);
    });

    test("places durable tabs and conversations anywhere, and right-panel tools in the right panel", () => {
      expect(
        getPanelTabPlacement(makeTestWorkbenchTab({ id: "browser", kind: "browser" })),
      ).toEqual(["right", "bottom"]);
      expect(getPanelTabPlacement(transient("mcpApp"))).toEqual(["right", "bottom"]);
      expect(
        getPanelTabPlacement({ ...(transient("sideChat") as SideChatPanelTab), status: "ready" }),
      ).toEqual(["right", "bottom"]);
      for (const discriminant of [
        "planPanel",
        "automationPanel",
        "backgroundAgent",
        "subagentsPanel",
        "processOutputPanel",
      ])
        expect(getPanelTabPlacement(transient(discriminant))).toEqual(["right"]);
      expect(
        getPanelTabPlacement({ ...(transient("sideChat") as SideChatPanelTab), status: "loading" }),
      ).toEqual([]);
    });

    test("limits root composer overlay eligibility to durable surfaces", () => {
      for (const tab of [
        makeTestWorkbenchTab({ id: "review", kind: "review" }),
        makeTestWorkbenchTab({ id: "browser", kind: "browser" }),
        makeTestWorkbenchTab({
          id: "page",
          kind: "page_stage",
          pageId: "page-1",
        }),
      ]) {
        expect(isRootThreadRightPanelComposerOverlayEligibleTab(tab)).toBe(true);
      }
      expect(
        isRootThreadRightPanelComposerOverlayEligibleTab(
          makeTestWorkbenchTab({
            id: "terminal",
            kind: "terminal",
          }),
        ),
      ).toBe(false);
      expect(isRootThreadRightPanelComposerOverlayEligibleTab(transient("planPanel"))).toBe(false);
      const imageTab = {
        ...transient("imageEditor"),
        threadId: "thread-1",
        options: {
          composerTarget: null,
          initialView: "single",
        },
      } as ImageEditorPanelTab;
      expect(isRootThreadRightPanelComposerOverlayEligibleTab(imageTab)).toBe(true);
      expect(
        isRootThreadRightPanelComposerOverlayEligibleTab({
          ...imageTab,
          threadId: null,
        } as ImageEditorPanelTab),
      ).toBe(false);
      expect(
        isRootThreadRightPanelComposerOverlayEligibleTab({
          ...imageTab,
          threadId: null,
          options: {
            ...imageTab.options,
            composerTarget: {
              channelId: "/new-chat::root",
              placement: "root",
            },
          },
        }),
      ).toBe(true);
      expect(isRootThreadRightPanelComposerOverlayEligibleTab(null)).toBe(false);
    });

    test("encodes process identities and project-aware side-chat paths", () => {
      expect(makeProcessOutputPanelTabId("thread:a/b", "item:c d")).toBe(
        "process-output:thread%3Aa%2Fb:item%3Ac%20d",
      );
      expect(
        buildSideChatParentNavigationPath(
          makeTestWorkbenchSession({ projectId: "project-1" }),
          "thread-1",
        ),
      ).toBe("project:project-1/session:session-1/thread:thread-1");
      expect(
        buildSideChatParentNavigationPath(
          makeTestWorkbenchSession({ projectId: null }),
          "thread-1",
        ),
      ).toBe("session:session-1/thread:thread-1");
    });

    test("creates renderer-local image tab identities", () => {
      expect(makeImageEditorPanelTabId()).toMatch(/^image:[0-9a-f-]{36}$/u);
    });

    test("updates image chrome without changing tab identity", () => {
      const tab = {
        ...transient("imageEditor"),
        id: "image:one",
        title: "User attachment",
        tooltip: "User attachment",
      } as ImageEditorPanelTab;
      const sibling = {
        ...tab,
        id: "image:two",
      } as ImageEditorPanelTab;

      const next = updateImageEditorPanelTabTitle([tab, sibling], tab.id, "  Generated image 2  ");

      expect(next[0]).toMatchObject({
        id: tab.id,
        title: "Generated image 2",
        tooltip: "Generated image 2",
      });
      expect(next[1]).toBe(sibling);
    });

    test("settles only the still-owned pending Subagents route", () => {
      const pending = {
        subagentsPanel: true,
        id: "subagents:root",
        sessionId: "session-1",
        projectId: "project-1",
        panelId: "right",
        rootThreadId: "root",
        selectedThreadId: "child",
        selectedDisplayName: "Child",
        selectedCanInteract: false,
        selectedHydration: { status: "pending", requestId: 7 },
        title: "Subagents",
        stateKey: 10,
      } satisfies SubagentsPanelTab;
      const ready = {
        ...pending,
        selectedCanInteract: true,
        selectedHydration: {
          status: "ready",
          revision: 2,
          fidelity: "attachedSparse",
          checkpoint: "checkpoint",
        },
      } satisfies SubagentsPanelTab;
      const current = { "session-1": [pending] };

      const settled = settlePendingSubagentsPanelTab(current, {
        sessionId: "session-1",
        tabId: pending.id,
        requestId: 7,
        tab: ready,
      });
      expect(settled["session-1"]?.[0]).toMatchObject({
        selectedHydration: { status: "ready" },
        stateKey: 11,
      });

      const closedOrPruned = {};
      expect(
        settlePendingSubagentsPanelTab(closedOrPruned, {
          sessionId: "session-1",
          tabId: pending.id,
          requestId: 7,
          tab: ready,
        }),
      ).toBe(closedOrPruned);
      expect(
        settlePendingSubagentsPanelTab(
          { "session-1": [{ ...pending, selectedHydration: { status: "pending", requestId: 8 } }] },
          {
            sessionId: "session-1",
            tabId: pending.id,
            requestId: 7,
            tab: ready,
          },
        )["session-1"]?.[0],
      ).toMatchObject({ selectedHydration: { status: "pending", requestId: 8 } });
    });

    test("routes deleted selected Subagents to overview across hidden and pending tabs", () => {
      const selected = {
        subagentsPanel: true,
        id: "subagents:root-1",
        sessionId: "session-1",
        projectId: "project-1",
        panelId: "right",
        rootThreadId: "root-1",
        selectedThreadId: "child-deleted",
        selectedDisplayName: "Deleted child",
        selectedCanInteract: true,
        selectedHydration: { status: "pending", requestId: 9 },
        title: "Subagents",
        stateKey: 12,
      } satisfies SubagentsPanelTab;
      const unrelated = {
        ...selected,
        id: "subagents:root-2",
        rootThreadId: "root-2",
        selectedThreadId: "child-kept",
      } satisfies SubagentsPanelTab;
      const current = {
        "session-1": [selected],
        "session-2": [unrelated],
        "session-remote": [{ ...selected, sessionId: "session-remote" }],
        "session-unassigned": [{ ...selected, sessionId: "session-unassigned" }],
      };
      const sessionHostIds = new Map([
        ["session-1", "local"],
        ["session-2", "local"],
        ["session-remote", "remote"],
      ]);
      const deleted = {
        type: "threadDeleted",
        hostId: "local",
        threadId: "child-deleted",
      } as const;

      const routed = routeDeletedSelectedSubagentsToOverview(current, deleted, sessionHostIds);

      expect(routed["session-1"]?.[0]).toMatchObject({
        selectedThreadId: null,
        selectedDisplayName: null,
        selectedCanInteract: false,
        selectedHydration: null,
        stateKey: 13,
      });
      expect(routed["session-2"]?.[0]).toBe(unrelated);
      expect(routed["session-remote"]).toBe(current["session-remote"]);
      expect(routed["session-unassigned"]).toBe(current["session-unassigned"]);
      expect(
        routeDeletedSelectedSubagentsToOverview(
          current,
          { ...deleted, threadId: "missing-child" },
          sessionHostIds,
        ),
      ).toBe(current);

      expect(
        settlePendingSubagentsPanelTab(routed, {
          sessionId: "session-1",
          tabId: selected.id,
          requestId: 9,
          tab: {
            ...selected,
            selectedHydration: {
              status: "ready",
              revision: 1,
              fidelity: "attachedSparse",
              checkpoint: null,
            },
          },
        }),
      ).toBe(routed);
      expect(
        settlePendingSubagentsPanelTab(routed, {
          sessionId: "session-remote",
          tabId: selected.id,
          requestId: 9,
          tab: {
            ...selected,
            sessionId: "session-remote",
            selectedHydration: {
              status: "ready",
              revision: 1,
              fidelity: "attachedSparse",
              checkpoint: null,
            },
          },
        })["session-remote"]?.[0],
      ).toMatchObject({
        selectedThreadId: "child-deleted",
        selectedHydration: { status: "ready" },
      });
    });
  });
});

describe("workbench panel tab opener state", () => {
  function openTab(
    state: ReturnType<typeof createWorkbenchPanelTabOpenerState>,
    tabId: string,
    openerTabId: string,
    tabIds: readonly string[],
  ) {
    const opened = recordWorkbenchPanelTabOpened(state, {
      tabId,
      openerTabId,
      openedInBackground: false,
    });
    return recordWorkbenchPanelTabActivated(opened, tabId, tabIds);
  }

  describe("workbench panel tab opener state", () => {
    test("prefers the nearest right sibling, then the nearest left sibling, then the opener", () => {
      const firstChild = openTab(createWorkbenchPanelTabOpenerState(), "child-one", "root", [
        "root",
        "child-one",
      ]);
      const secondChild = openTab(firstChild, "child-two", "root", [
        "root",
        "child-two",
        "child-one",
      ]);

      expect(
        resolveWorkbenchPanelTabOpenerCloseReplacement(
          secondChild,
          ["root", "child-two", "child-one"],
          "child-two",
        ),
      ).toBe("child-one");
      expect(
        resolveWorkbenchPanelTabOpenerCloseReplacement(
          secondChild,
          ["root", "child-two", "child-one"],
          "child-one",
        ),
      ).toBe("child-two");
      expect(
        resolveWorkbenchPanelTabOpenerCloseReplacement(
          firstChild,
          ["root", "child-one"],
          "child-one",
        ),
      ).toBe("root");
    });

    test("treats nested descendants as one opener tree", () => {
      const child = openTab(createWorkbenchPanelTabOpenerState(), "child", "root", [
        "root",
        "child",
      ]);
      const grandchild = openTab(child, "grandchild", "child", ["root", "child", "grandchild"]);

      expect(
        resolveWorkbenchPanelTabOpenerCloseReplacement(
          grandchild,
          ["root", "child", "grandchild"],
          "grandchild",
        ),
      ).toBe("child");
      expect(
        resolveWorkbenchPanelTabOpenerCloseReplacement(
          grandchild,
          ["root", "child", "grandchild"],
          "child",
        ),
      ).toBe("grandchild");
      expect(Object.keys(recordWorkbenchPanelTabClosed(grandchild, "child").tabsById)).toEqual([]);
    });

    test("invalidates affinity after selection leaves the opener tree", () => {
      const child = openTab(createWorkbenchPanelTabOpenerState(), "child", "root", [
        "root",
        "child",
        "unrelated",
      ]);
      const unrelated = recordWorkbenchPanelTabActivated(child, "unrelated", [
        "root",
        "child",
        "unrelated",
      ]);

      expect(unrelated.active).toBe(false);
      expect(unrelated.generation).toBe(child.generation + 1);
      expect(
        resolveWorkbenchPanelTabOpenerCloseReplacement(
          unrelated,
          ["root", "child", "unrelated"],
          "child",
        ),
      ).toBeNull();
    });

    test("ignores stale generations when a new opener tree starts", () => {
      const firstChild = openTab(createWorkbenchPanelTabOpenerState(), "old-child", "root", [
        "root",
        "old-child",
        "unrelated",
      ]);
      const invalidated = recordWorkbenchPanelTabActivated(firstChild, "unrelated", [
        "root",
        "old-child",
        "unrelated",
      ]);
      const currentChild = openTab(invalidated, "current-child", "root", [
        "root",
        "current-child",
        "old-child",
        "unrelated",
      ]);

      expect(
        resolveWorkbenchPanelTabOpenerCloseReplacement(
          currentChild,
          ["root", "current-child", "old-child", "unrelated"],
          "current-child",
        ),
      ).toBe("root");
    });

    test("keeps affinity while moving between ancestors, descendants, and siblings", () => {
      const child = openTab(createWorkbenchPanelTabOpenerState(), "child-one", "root", [
        "root",
        "child-one",
      ]);
      const sibling = openTab(child, "child-two", "root", ["root", "child-two", "child-one"]);
      const openerSelected = recordWorkbenchPanelTabActivated(sibling, "root", [
        "root",
        "child-two",
        "child-one",
      ]);
      const firstChildSelected = recordWorkbenchPanelTabActivated(openerSelected, "child-one", [
        "root",
        "child-two",
        "child-one",
      ]);

      expect(openerSelected.active).toBe(true);
      expect(firstChildSelected.active).toBe(true);
    });

    test("clears the whole relationship graph when a tracked tab or opener moves", () => {
      const child = openTab(createWorkbenchPanelTabOpenerState(), "child", "root", [
        "root",
        "child",
      ]);

      expect(recordWorkbenchPanelTabMoved(child, "unrelated")).toBe(child);
      expect(recordWorkbenchPanelTabMoved(child, "child")).toMatchObject({
        active: false,
        lastSelectedTabId: null,
        tabsById: {},
      });
      expect(recordWorkbenchPanelTabMoved(child, "root")).toMatchObject({
        active: false,
        lastSelectedTabId: null,
        tabsById: {},
      });
    });

    test("background opens do not replace the last selected tab", () => {
      const initial = recordWorkbenchPanelTabActivated(
        createWorkbenchPanelTabOpenerState(),
        "root",
        ["root"],
      );
      const background = recordWorkbenchPanelTabOpened(initial, {
        tabId: "child",
        openerTabId: "root",
        openedInBackground: true,
      });

      expect(background.active).toBe(true);
      expect(background.lastSelectedTabId).toBe("root");
    });
  });
});

describe("workbench panel tab shortcut", () => {
  function pageSurface(id: string): WorkbenchSurfaceDescriptor {
    return {
      id,
      kind: "page_stage",
      titleSnapshot: id,
      stateKey: 0,
      state: null,
      config: {
        pageId: id,
      },
    };
  }

  function sceneWithTwoPageSurfaces(owner: WorkbenchSceneOwner) {
    const initial = materializeInitialWorkbenchScene(owner, {
      identityFactory: {
        createId: (kind) => `test:${kind}`,
      },
    });
    const withFirst = createWorkbenchSceneSurface(initial, {
      panelId: "right",
      surface: pageSurface("first"),
    });
    return createWorkbenchSceneSurface(withFirst, {
      panelId: "right",
      surface: pageSurface("second"),
    });
  }

  describe("workbench panel tab shortcut projection", () => {
    test.each([[{ kind: "project", projectId: "alpha" }], [{ kind: "library" }]] as const)(
      "projects the %s owner scene by leaf",
      (owner) => {
        const scene = sceneWithTwoPageSurfaces(owner);
        const leaf = Object.values(
          scene.panels.right.layout.root.type === "leaf"
            ? { [scene.panels.right.layout.root.id]: scene.panels.right.layout.root }
            : {},
        )[0];
        if (!leaf) throw new Error("Expected a right-panel leaf");

        const active = activateWorkbenchSceneSurface(scene, "right", leaf.id, "first");
        const projection = buildWorkbenchScenePanelTabShortcutProjection(active);
        const items = projection.right.itemsByLeafId[leaf.id] ?? [];

        const expectedIds =
          owner.kind === "project" ? ["test:surface", "first", "second"] : ["first", "second"];
        expect(items.map((item) => item.id)).toEqual(expectedIds);
        expect(items.map((item) => item.closable)).toEqual(
          owner.kind === "project" ? [false, true, true] : [true, true],
        );
        expect(projection.right.activeTabIdsByLeafId[leaf.id]).toBe("first");
      },
    );
  });
});
