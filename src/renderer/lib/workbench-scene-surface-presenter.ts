import { getIntl } from "@/lib/i18n";
import {
  findNearestWorkbenchPanelLeafToRight,
  findWorkbenchPanelLeafForTab,
} from "../../shared/workbench-panel-layout";
import { createSecureRuntimeId } from "../../shared/secure-runtime-id";
import {
  getWorkbenchSurfaceReuseKey,
  insertWorkbenchSceneLeaf,
  maximizeWorkbenchSceneLeaf,
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
    const matches =
      observed?.tabs.filter(
        (tab) =>
          reuseKey !== null &&
          tab.surface &&
          getWorkbenchSurfaceReuseKey({ ...tab.surface, stateKey: 0, state: null }) === reuseKey,
      ) ?? [];
    const placement = input.target.placement;
    const source =
      surface.kind === "page_stage" && placement?.kind === "adjacent-right"
        ? matches.find((tab) => tab.tabId === placement.sourceSurfaceId)
        : undefined;
    const adjacent =
      source?.panelId && source.groupId
        ? openBeside(initialScene, source.panelId, source.groupId)
        : null;
    if (source && !adjacent)
      return {
        status: "unavailable",
        reason: getIntl().formatMessage({
          id: "lib.workbenchSceneSurfacePresenter.tabGroupFailed",
          defaultMessage: "Could not open a tab group to the right",
        }),
      };

    const matching = adjacent
      ? matches.find((tab) => tab.panelId === adjacent.panelId && tab.groupId === adjacent.leafId)
      : matches[0];
    const inboxLeaf =
      !matching &&
      surface.kind === "agents" &&
      placement?.kind === "adjacent-right" &&
      initialScene.primary?.kind === "inbox" &&
      findWorkbenchPanelLeafForTab(initialScene.panels.right.layout, initialScene.primary.id);
    const besideInbox = inboxLeaf ? openBeside(initialScene, "right", inboxLeaf.id) : null;
    const target =
      adjacent ??
      besideInbox ??
      (matching?.panelId && matching.groupId
        ? { scene: initialScene, panelId: matching.panelId, leafId: matching.groupId }
        : resolvePanelSurfaceTarget(
            initialScene,
            input.target,
            listWorkbenchScenePreviewEntries(
              initialScene,
              state.ephemeralPanels.previewSurfacesByPanel,
            ),
          ));
    const { id: _id, state: _state, stateKey: _stateKey, ...opening } = surface;
    const generationIsCurrent = captureIsCurrent?.();
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
      () => (generationIsCurrent?.() ?? true) && (input.isCurrent?.() ?? true),
      {
        preparedScene: target.scene,
        surfaceId: surface.id,
        ...((input.request.kind === "files" ||
          input.request.kind === "page_stage" ||
          input.request.kind === "github_thread") &&
        input.request.reveal
          ? { reveal: input.request.reveal }
          : {}),
        open: {
          openerTabId: input.target.placement?.sourceSurfaceId,
          ...(adjacent ? { reuseInTargetGroup: true } : {}),
          targetIndex: "targetIndex" in target ? target.targetIndex : undefined,
          ...(input.tab === "background" ? { presentation: "background" as const } : {}),
        },
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
            ? getIntl().formatMessage({
                id: "lib.workbenchSceneSurfacePresenter.sceneChanged",
                defaultMessage: "The Scene changed while this tab was opening",
              })
            : getIntl().formatMessage({
                id: "lib.workbenchSceneSurfacePresenter.tabFailed",
                defaultMessage: "This tab could not be opened",
              }),
      };
    return { status: "presented", surfaceId: receipt.tabId, reused: Boolean(matching) };
  };
}

function openBeside(
  scene: Parameters<typeof insertWorkbenchSceneLeaf>[0],
  panelId: PresentWorkbenchPanelSurfaceInput["target"]["panelId"],
  groupId: string,
) {
  const layout = scene.panels[panelId].layout;
  const neighbor = findNearestWorkbenchPanelLeafToRight(layout, groupId);
  if (neighbor) {
    return {
      scene: layout.maximizedLeafId
        ? maximizeWorkbenchSceneLeaf(scene, { panelId, leafId: null })
        : scene,
      panelId,
      leafId: neighbor,
    };
  }
  const inserted = insertWorkbenchSceneLeaf(scene, { panelId, leafId: groupId, side: "right" });
  return inserted.leafId ? { scene: inserted.scene, panelId, leafId: inserted.leafId } : null;
}
