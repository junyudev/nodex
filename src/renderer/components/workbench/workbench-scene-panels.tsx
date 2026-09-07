import type { ReactNode } from "react";
import { BrowserTabFavicon } from "@/features/browser-sidebar/browser-tab-favicon";
import { isPanelActionTargetAllowed, type PanelNewTabAction } from "@/lib/workbench-panel-actions";
import { resolveWorkbenchSceneTabPresentation } from "@/lib/workbench-scene-tab-presentation";
import type { WorkbenchSceneDurablePanelCommands } from "@/lib/use-workbench-panel-controller";
import type { ExecuteWorkbenchUiCommand } from "@/lib/use-workbench-scene-commands";
import type { PanelId, Project } from "@/lib/types";
import {
  makePageTitleResourceKey,
  type PageTitleProjectionStore,
} from "@/lib/page-title-projection-store";
import type { CommandKeymapState } from "../../../shared/command-keybindings";
import {
  makeBrowserSidebarTabKey,
  type BrowserSidebarTabSnapshot,
} from "../../../shared/browser-sidebar";
import { listWorkbenchPanelLeaves } from "../../../shared/workbench-panel-layout";
import {
  makeWorkbenchSceneKey,
  resolveWorkbenchSceneSurface,
  type WorkbenchSceneSnapshot,
  type WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import type { AppShellTabItem } from "./app-shell-tabs";
import type { PanelDestination } from "./panel-destination-picker-model";
import { ProjectMarker } from "./project-marker";
import { WorkbenchPanelHost } from "./workbench-panel-host";

export interface WorkbenchScenePanelsProps {
  readonly scene: WorkbenchSceneSnapshot;
  readonly project: Project | null;
  readonly projects: Project[];
  readonly currentLibraryId: string | null;
  readonly browserViewScopeId: string;
  readonly browserTabSnapshotByKey: ReadonlyMap<string, BrowserSidebarTabSnapshot>;
  readonly pageTitleStore: PageTitleProjectionStore;
  readonly commands: WorkbenchSceneDurablePanelCommands;
  readonly executeCommand: ExecuteWorkbenchUiCommand;
  readonly previewSurfaceIds: ReadonlySet<string>;
  readonly isMac: boolean;
  readonly commandKeymapState?: CommandKeymapState | null;
  readonly availableActions: readonly PanelNewTabAction[];
  readonly currentProjectDbViewExists: boolean;
  readonly rightPanelHeaderAfterList: ReactNode;
  readonly rightPanelHeaderStartInsetWidth: number;
  readonly bottomPanelGlobalHeaderInsetWidth: number;
  readonly panelTabScrollEndPaddingPx: number;
  readonly renderNewTab?: (panelId: PanelId, leafId: string) => ReactNode;
  readonly renderEmptyLeaf?: (panelId: PanelId, leafId: string) => ReactNode;
  readonly renderSurface: (
    surface: WorkbenchSurfaceDescriptor,
    context: { readonly active: boolean; readonly panelId: PanelId },
  ) => ReactNode;
  readonly onOpenAction: (
    panelId: PanelId,
    leafId: string,
    action: PanelNewTabAction["kind"],
  ) => void;
  readonly onOpenDestination: (
    panelId: PanelId,
    leafId: string,
    destination: PanelDestination,
  ) => Promise<void>;
  readonly onFocusGroup?: (panelId: PanelId, leafId: string) => void;
  readonly onPinPreview: (panelId: PanelId, leafId: string, surfaceId: string) => void;
}

function makePanelItems(
  scene: WorkbenchSceneSnapshot,
  project: Project | null,
  currentLibraryId: string | null,
  browserConversationId: string,
  browserViewScopeId: string,
  browserTabSnapshotByKey: ReadonlyMap<string, BrowserSidebarTabSnapshot>,
  pageTitleStore: PageTitleProjectionStore,
  previewSurfaceIds: ReadonlySet<string>,
  panelId: PanelId,
  renderSurface: WorkbenchScenePanelsProps["renderSurface"],
): {
  readonly itemsByLeafId: Record<string, AppShellTabItem[]>;
  readonly activeTabIdsByLeafId: Record<string, string | null>;
} {
  const itemsByLeafId: Record<string, AppShellTabItem[]> = {};
  const activeTabIdsByLeafId: Record<string, string | null> = {};
  for (const leaf of listWorkbenchPanelLeaves(scene.panels[panelId].layout)) {
    const surfaces = leaf.tabIds.flatMap((surfaceId) => {
      const surface = resolveWorkbenchSceneSurface(scene, surfaceId);
      return surface ? [surface] : [];
    });
    itemsByLeafId[leaf.id] = surfaces.map((surface) => {
      const preview = previewSurfaceIds.has(surface.id);
      const isProjectHomeRoot =
        scene.owner.kind === "project" &&
        surface.id === scene.primary?.id &&
        surface.kind === "db_view";
      const presentation = resolveWorkbenchSceneTabPresentation(surface, isProjectHomeRoot);
      const browserTabSnapshot =
        surface.kind === "browser"
          ? browserTabSnapshotByKey.get(
              makeBrowserSidebarTabKey({
                browserConversationId,
                browserViewScopeId,
                browserTabId: surface.config.browserTabId,
              }),
            )
          : undefined;
      const title =
        scene.owner.kind === "pages"
          ? surface.titleSnapshot.trim() || presentation.title
          : presentation.title;
      const titleSource =
        surface.kind === "page_stage" && currentLibraryId
          ? pageTitleStore.createSource(
              makePageTitleResourceKey(currentLibraryId, surface.config.pageId),
              title,
            )
          : undefined;
      return {
        id: surface.id,
        title,
        titleSource,
        icon: presentation.icon,
        iconElement:
          surface.kind === "browser" ? (
            <BrowserTabFavicon
              className="icon-xs"
              faviconUrl={browserTabSnapshot?.faviconUrl ?? surface.config.faviconUrl}
              isLoading={browserTabSnapshot?.isLoading ?? false}
              isWaitingForResponse={browserTabSnapshot?.isWaitingForResponse ?? false}
            />
          ) : isProjectHomeRoot && project ? (
            <ProjectMarker
              appearance={project.appearance}
              className="size-4"
              data-project-home-tab-marker="true"
            />
          ) : undefined,
        closable: surface.id !== scene.primary?.id,
        preview,
        reorderable: !preview && surface.id !== scene.primary?.id,
        splittable: !preview && surface.id !== scene.primary?.id,
        renderPanel: (_close, context) =>
          renderSurface(surface, {
            active: context.active,
            panelId,
          }),
      };
    });
    activeTabIdsByLeafId[leaf.id] =
      leaf.activeTabId && resolveWorkbenchSceneSurface(scene, leaf.activeTabId)
        ? leaf.activeTabId
        : (surfaces[0]?.id ?? null);
  }
  return { itemsByLeafId, activeTabIdsByLeafId };
}

/** Panel chrome for durable and renderer-only preview surfaces in an owner Scene. */
export function buildWorkbenchScenePanels({
  scene,
  project,
  projects,
  currentLibraryId,
  browserViewScopeId,
  browserTabSnapshotByKey,
  pageTitleStore,
  commands,
  executeCommand,
  previewSurfaceIds,
  isMac,
  commandKeymapState,
  availableActions,
  currentProjectDbViewExists,
  rightPanelHeaderAfterList,
  rightPanelHeaderStartInsetWidth,
  bottomPanelGlobalHeaderInsetWidth,
  panelTabScrollEndPaddingPx,
  renderNewTab,
  renderEmptyLeaf,
  renderSurface,
  onOpenAction,
  onOpenDestination,
  onFocusGroup,
  onPinPreview,
}: WorkbenchScenePanelsProps) {
  const ownerKey = makeWorkbenchSceneKey(scene.owner);

  const renderPanel = (panelId: PanelId) => {
    const projection = makePanelItems(
      scene,
      project,
      currentLibraryId,
      ownerKey,
      browserViewScopeId,
      browserTabSnapshotByKey,
      pageTitleStore,
      previewSurfaceIds,
      panelId,
      renderSurface,
    );
    return (
      <WorkbenchPanelHost
        sessionId={ownerKey}
        sessionProjectId={project?.id ?? null}
        panelId={panelId}
        layout={scene.panels[panelId].layout}
        tabItemsByLeafId={projection.itemsByLeafId}
        activeTabIdsByLeafId={projection.activeTabIdsByLeafId}
        availableActions={availableActions.filter((action) =>
          isPanelActionTargetAllowed(action, panelId),
        )}
        projects={projects}
        isMac={isMac}
        commandKeymapState={commandKeymapState}
        currentProjectDbViewExists={currentProjectDbViewExists}
        renderAfterList={panelId === "right" ? () => rightPanelHeaderAfterList : undefined}
        headerStartInsetPx={panelId === "right" ? rightPanelHeaderStartInsetWidth : undefined}
        headerEndInsetPx={panelId === "bottom" ? bottomPanelGlobalHeaderInsetWidth : undefined}
        tabScrollEndPaddingPx={panelTabScrollEndPaddingPx}
        renderNewTab={renderNewTab ? (leafId) => renderNewTab(panelId, leafId) : undefined}
        renderEmptyLeaf={renderEmptyLeaf ? (leafId) => renderEmptyLeaf(panelId, leafId) : undefined}
        commands={{
          selectTab: (_leafId, surfaceId) => {
            void executeCommand(scene.owner, { kind: "activate_tab", tabId: surfaceId });
          },
          closeTab: (_leafId, surfaceId) => {
            void executeCommand(scene.owner, { kind: "close_tab", tabId: surfaceId });
          },
          pinTab: (leafId, surfaceId) => {
            if (!previewSurfaceIds.has(surfaceId)) return;
            onPinPreview(panelId, leafId, surfaceId);
          },
          reorderTab: (leafId, surfaceId, targetIndex) => {
            const leaf = listWorkbenchPanelLeaves(scene.panels[panelId].layout).find(
              (candidate) => candidate.id === leafId,
            );
            if (!leaf) return;
            const orderedSurfaceIds = [...leaf.tabIds];
            const sourceIndex = orderedSurfaceIds.indexOf(surfaceId);
            if (sourceIndex < 0) return;
            if (sourceIndex === targetIndex) return;
            orderedSurfaceIds.splice(sourceIndex, 1);
            orderedSurfaceIds.splice(targetIndex, 0, surfaceId);
            void executeCommand(scene.owner, {
              kind: "reorder_tabs",
              panelId,
              groupId: leafId,
              tabIds: orderedSurfaceIds,
            });
          },
          moveTab: (surfaceId, targetPanelId, targetLeafId, targetIndex, splitTarget) => {
            const groupId =
              splitTarget?.leafId ??
              targetLeafId ??
              scene.panels[targetPanelId].layout.activeLeafId;
            const leaf = listWorkbenchPanelLeaves(scene.panels[targetPanelId].layout).find(
              (candidate) => candidate.id === groupId,
            );
            if (!leaf) return;
            const index = splitTarget
              ? 0
              : Math.min(
                  targetIndex ?? leaf.tabIds.length,
                  leaf.tabIds.filter((id) => id !== surfaceId).length,
                );
            void executeCommand(scene.owner, {
              kind: "move_tab",
              tabId: surfaceId,
              panelId: targetPanelId,
              groupId,
              index,
              ...(splitTarget ? { splitSide: splitTarget.side } : {}),
            });
          },
          splitGroup: (leafId, side, surfaceId) => {
            void executeCommand(scene.owner, {
              kind: "split_group",
              panelId,
              groupId: leafId,
              side,
              ...(surfaceId ? { tabId: surfaceId } : {}),
            });
          },
          focusGroup: (leafId) => {
            onFocusGroup?.(panelId, leafId);
            commands.activateSurface(scene.owner, panelId, leafId);
          },
          activateGroup: (leafId, surfaceId) => {
            if (surfaceId) {
              void executeCommand(scene.owner, { kind: "activate_tab", tabId: surfaceId });
              return;
            }
            commands.activateSurface(scene.owner, panelId, leafId);
          },
          resizeGroup: (branchId, ratio) => {
            commands.resizeBranch(scene.owner, {
              panelId,
              branchId,
              ratio,
            });
          },
          openAction: (action, leafId) => {
            onOpenAction(panelId, leafId, action);
          },
          openDestination: async (destination, leafId) => {
            await onOpenDestination(panelId, leafId, destination);
          },
        }}
      />
    );
  };

  return {
    right: renderPanel("right"),
    bottom: renderPanel("bottom"),
  };
}
