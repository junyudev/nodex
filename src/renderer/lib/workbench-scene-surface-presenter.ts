import { createSecureRuntimeId } from "../../shared/secure-runtime-id";
import {
  getWorkbenchSurfaceReuseKey,
  makeWorkbenchSceneKey,
  materializeInitialWorkbenchScene,
  type WorkbenchSurfaceDescriptor,
} from "../../shared/workbench-scene";
import { readWorkbenchAgentContext } from "./workbench-agent-context";
import type { WorkbenchSceneCommandExecutor } from "./workbench-scene-commands";
import {
  resolvePanelSurfaceTarget,
  sceneLocationForOwner,
  type PresentWorkbenchPanelSurfaceInput,
  type PresentWorkbenchPanelSurfaceResult,
} from "./workbench-scene-navigator";
import { listWorkbenchScenePreviewEntries } from "./workbench-scene-preview";
import type { WorkbenchWindowOwner } from "./workbench-window-owner";

/** UI opening supplies navigation and relative placement; the shared executor owns the Scene change. */
export function createWorkbenchSceneSurfacePresenter(
  owner: WorkbenchWindowOwner,
  executor: WorkbenchSceneCommandExecutor,
  captureIsCurrent?: () => () => boolean,
) {
  return async (
    input: PresentWorkbenchPanelSurfaceInput,
    surface: WorkbenchSurfaceDescriptor,
  ): Promise<PresentWorkbenchPanelSurfaceResult> => {
    const state = owner.read();
    const initialScene =
      state.windowState.scenesByOwnerKey[makeWorkbenchSceneKey(input.owner)] ??
      materializeInitialWorkbenchScene(input.owner);
    const observed = readWorkbenchAgentContext(state, input.owner);
    const reuseKey = getWorkbenchSurfaceReuseKey(surface);
    const matching =
      reuseKey === null
        ? null
        : observed?.tabs.find(
            (tab) =>
              tab.surface &&
              getWorkbenchSurfaceReuseKey({ ...tab.surface, stateKey: 0, state: null }) ===
                reuseKey,
          );
    const target =
      matching?.panelId && matching.groupId
        ? { scene: initialScene, panelId: matching.panelId, leafId: matching.groupId }
        : resolvePanelSurfaceTarget(
            initialScene,
            input.target,
            listWorkbenchScenePreviewEntries(
              initialScene,
              state.ephemeralPanels.previewSurfacesByPanel,
            ),
          );
    const { id: _id, state: _state, stateKey: _stateKey, ...opening } = surface;
    const receipt = await executor.execute(
      {
        operationId: createSecureRuntimeId("ui-open"),
        sceneOwner: input.owner,
        expectedPresentationRevision: state.presentationRevision,
        command: {
          kind: "open_tab",
          panelId: target.panelId,
          groupId: target.leafId ?? target.scene.panels[target.panelId].layout.activeLeafId,
          surface: opening,
        },
      },
      captureIsCurrent?.(),
      {
        preparedScene: target.scene,
        surfaceId: surface.id,
        ...(input.navigation === "select-owner"
          ? { location: sceneLocationForOwner(input.owner) }
          : {}),
      },
    );
    if (!receipt.tabId || receipt.error)
      return {
        status: "unavailable",
        reason:
          receipt.error === "stale_presentation"
            ? "The Scene changed while this tab was opening"
            : "This tab could not be opened",
      };
    return { status: "presented", surfaceId: receipt.tabId, reused: Boolean(matching) };
  };
}
