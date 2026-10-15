import { describe, expect, test } from "vite-plus/test";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  materializeInitialWorkbenchScene,
  type WorkbenchSceneOwner,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import { buildWorkbenchScenePanelTabShortcutProjection } from "./workbench-panel-tab-shortcut";

function pageSurface(id: string): WorkbenchSurfaceDescriptor {
  return {
    id,
    kind: "page_stage",
    titleSnapshot: id,
    stateKey: 0,
    state: null,
    config: {
      routingContext: { kind: "library" },
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
  test.each([[{ kind: "project", projectId: "alpha" }], [{ kind: "pages" }]] as const)(
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
