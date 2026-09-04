import { useQueries } from "@tanstack/react-query";
import { CanvasIcon, ChevronRightIcon, DatabaseIcon, PageIcon } from "@/components/shared/icons";
import { libraryPathQueryOptions } from "@/lib/use-library-navigation";
import {
  areLibraryResourceTargetsEqual,
  resolveLibraryPathRoot,
} from "@/lib/library-resource-routing";
import { parseDatabaseViewId } from "../../../shared/database-identities";
import { AppShellHeaderContentRegistrar } from "@/lib/workbench-ui-scopes";
import { listWorkbenchPanelLeaves } from "../../../shared/workbench-panel-layout";
import type {
  LibraryNavigationNode,
  LibraryPlacedResourceTarget,
  LibraryRouteTarget,
} from "../../../shared/library-module";
import type {
  WorkbenchSceneSnapshot,
  WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import { usePresentedPageTitle } from "@/lib/page-title-projection-context";

export function activePagesSceneSurface(
  scene: WorkbenchSceneSnapshot | null,
): WorkbenchSurfaceDescriptor | null {
  if (!scene || scene.owner.kind !== "pages") return null;
  const preferredPanelId = scene.lastFocusedPanelId ?? "right";
  const panelIds =
    preferredPanelId === "right" ? (["right", "bottom"] as const) : (["bottom", "right"] as const);
  for (const panelId of panelIds) {
    const panel = scene.panels[panelId];
    if (panel.collapsed) continue;
    const leaves = listWorkbenchPanelLeaves(panel.layout);
    const orderedLeaves = [
      ...leaves.filter((leaf) => leaf.id === panel.layout.activeLeafId),
      ...leaves.filter((leaf) => leaf.id !== panel.layout.activeLeafId),
    ];
    for (const leaf of orderedLeaves) {
      if (!leaf.activeTabId) continue;
      const surface = scene.panelSurfacesById[leaf.activeTabId];
      if (surface) return surface;
    }
  }
  return null;
}

export function libraryTargetForPagesSurface(
  surface: WorkbenchSurfaceDescriptor | null,
): LibraryRouteTarget | null {
  if (!surface) return null;
  if (surface.kind === "page_stage") {
    return surface.config.accessContext.kind === "library"
      ? { kind: "page", pageId: surface.config.pageId }
      : null;
  }
  if (surface.kind === "canvas_stage") {
    return surface.config.accessContext.kind === "library"
      ? { kind: "canvas", canvasId: surface.config.canvasBlockId }
      : null;
  }
  if (surface.kind !== "db_view" || surface.config.accessContext.kind !== "library") {
    return null;
  }
  if (surface.config.target.kind === "database-default") {
    return {
      kind: "database",
      databaseId: surface.config.target.databaseId,
    };
  }
  if (surface.config.target.kind === "database-view") {
    return {
      kind: "view",
      viewId: parseDatabaseViewId(surface.config.target.databaseViewId),
    };
  }
  return null;
}

export function usePagesSceneNavigation(scene: WorkbenchSceneSnapshot | null): {
  readonly activeSurface: WorkbenchSurfaceDescriptor | null;
  readonly activeRoot: LibraryPlacedResourceTarget | null;
  readonly activeRootNode: LibraryNavigationNode | null;
  readonly activeTargetNode: LibraryNavigationNode | null;
} {
  const activeSurface = activePagesSceneSurface(scene);
  const target = libraryTargetForPagesSurface(activeSurface);
  const pathQueries: Array<ReturnType<typeof libraryPathQueryOptions>> = target
    ? [libraryPathQueryOptions(target)]
    : [];
  const path = useQueries({
    queries: pathQueries,
  })[0];
  return {
    activeSurface,
    activeRoot: target && path?.data ? resolveLibraryPathRoot(target, path.data.nodes) : null,
    activeRootNode: path?.data?.nodes[0] ?? null,
    activeTargetNode: path?.data?.nodes.at(-1) ?? null,
  };
}

export function PagesSceneBreadcrumb({ scene }: { readonly scene: WorkbenchSceneSnapshot }) {
  const navigation = usePagesSceneNavigation(scene);
  const surface = navigation.activeSurface;
  const target = libraryTargetForPagesSurface(surface);
  const root = navigation.activeRoot;
  const Icon =
    root?.kind === "database" ? DatabaseIcon : root?.kind === "canvas" ? CanvasIcon : PageIcon;
  const surfaceTitle = usePresentedPageTitle(
    surface?.kind === "page_stage" ? surface.config.pageId : null,
    surface?.titleSnapshot ?? "Untitled",
    undefined,
    surface?.kind === "page_stage" &&
      navigation.activeTargetNode?.kind === "page" &&
      navigation.activeTargetNode.pageId === surface.config.pageId
      ? {
          generation: navigation.activeTargetNode.documentGeneration,
          headSeq: navigation.activeTargetNode.documentHeadSeq,
        }
      : undefined,
  );
  const rootTitle = usePresentedPageTitle(
    root?.kind === "page" ? root.pageId : null,
    navigation.activeRootNode?.title ?? surfaceTitle,
    undefined,
    navigation.activeRootNode?.kind === "page"
      ? {
          generation: navigation.activeRootNode.documentGeneration,
          headSeq: navigation.activeRootNode.documentHeadSeq,
        }
      : undefined,
  );
  const childTitle =
    target && root && (target.kind === "view" || !areLibraryResourceTargetsEqual(target, root))
      ? surfaceTitle
      : null;

  return (
    <AppShellHeaderContentRegistrar
      content={
        <div className="no-drag flex h-full min-w-0 items-center gap-1.5 text-sm">
          <span
            className={
              surface ? "shrink-0 text-token-text-secondary" : "shrink-0 text-token-text-primary"
            }
          >
            Pages
          </span>
          {surface ? (
            <>
              <ChevronRightIcon
                className="icon-2xs shrink-0 text-token-description-foreground"
                aria-hidden
              />
              <Icon className="icon-2xs shrink-0 text-token-text-secondary" aria-hidden />
              <span className="min-w-0 truncate text-token-text-primary">{rootTitle}</span>
              {childTitle ? (
                <>
                  <ChevronRightIcon
                    className="icon-2xs shrink-0 text-token-description-foreground"
                    aria-hidden
                  />
                  <span className="min-w-0 truncate text-token-text-secondary">{childTitle}</span>
                </>
              ) : null}
            </>
          ) : null}
        </div>
      }
    />
  );
}
