import { describe, expect, test } from "vite-plus/test";
import { findWorkbenchPanelLeafForTab } from "../../shared/workbench-panel-layout";
import {
  collectWorkbenchScenePresentedPageIds,
  materializeInitialWorkbenchScene,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import {
  makeWorkbenchScenePreviewSlotKey,
  projectWorkbenchScenePreviews,
} from "./workbench-scene-preview";

describe("Workbench Scene preview projection", () => {
  test("projects one active Page preview without mutating the durable Scene", () => {
    const owner = { kind: "project" as const, projectId: "project:one" };
    const scene = materializeInitialWorkbenchScene(owner);
    if (!scene.primary) throw new Error("Expected Project primary");
    const leaf = findWorkbenchPanelLeafForTab(scene.panels.right.layout, scene.primary.id);
    if (!leaf) throw new Error("Expected Project primary leaf");
    const durableLayout = scene.panels.right.layout;
    const preview: WorkbenchSurfaceDescriptor = {
      id: "preview:page:one",
      kind: "page_stage",
      titleSnapshot: "Page One",
      config: {
        routingContext: { kind: "project", projectId: "project:one" },
        pageId: "page:one",
      },
      stateKey: 0,
      state: null,
    };
    const projection = projectWorkbenchScenePreviews(scene, {
      [makeWorkbenchScenePreviewSlotKey(owner, "right", leaf.id)]: preview,
    });
    const projectedLeaf = findWorkbenchPanelLeafForTab(
      projection.scene.panels.right.layout,
      preview.id,
    );

    expect(scene.panelSurfacesById).not.toHaveProperty(preview.id);
    expect(scene.panels.right.layout).toBe(durableLayout);
    expect(projectedLeaf?.activeTabId).toBe(preview.id);
    expect(projection.scene.panelSurfacesById[preview.id]).toBe(preview);
    expect([...projection.previewSurfaceIds]).toEqual([preview.id]);
    expect([...collectWorkbenchScenePresentedPageIds(projection.scene)]).toEqual(["page:one"]);
  });
});
