import { describe, expect, test } from "vite-plus/test";
import {
  activateWorkbenchSceneSurface,
  createWorkbenchSceneSurface,
  materializeInitialWorkbenchScene,
  patchWorkbenchScenePanel,
  removeWorkbenchSceneSurface,
  type WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import { listWorkbenchPanelLeaves } from "../../../shared/workbench-panel-layout";
import { activeLibrarySceneSurface } from "./library-scene-breadcrumb";

function pageSurface(id: string): WorkbenchSurfaceDescriptor {
  return {
    id,
    kind: "page_stage",
    titleSnapshot: id,
    config: {
      routingContext: { kind: "library" },
      pageId: `page:${id}`,
    },
    stateKey: 0,
    state: null,
  };
}

describe("activeLibrarySceneSurface", () => {
  test("falls back to the visible right panel after the focused bottom leaf empties", () => {
    const initial = materializeInitialWorkbenchScene({ kind: "library" });
    const withRight = createWorkbenchSceneSurface(initial, {
      panelId: "right",
      surface: pageSurface("right-page"),
    });
    const withBottom = patchWorkbenchScenePanel(
      createWorkbenchSceneSurface(withRight, {
        panelId: "bottom",
        surface: pageSurface("bottom-page"),
      }),
      "bottom",
      { collapsed: false },
    );
    const bottomLeaf = listWorkbenchPanelLeaves(withBottom.panels.bottom.layout)[0];
    if (!bottomLeaf) throw new Error("Expected a bottom leaf");
    const focusedBottom = activateWorkbenchSceneSurface(
      withBottom,
      "bottom",
      bottomLeaf.id,
      "bottom-page",
    );
    const withoutBottom = {
      ...removeWorkbenchSceneSurface(focusedBottom, "bottom-page"),
      lastFocusedPanelId: "bottom" as const,
    };

    expect(activeLibrarySceneSurface(withoutBottom)?.id).toBe("right-page");
  });
});
