import type { LibraryRouteTarget } from "../../../shared/library-module";
import type {
  WorkbenchSceneOwner,
  WorkbenchSurfaceDescriptor,
} from "../../../shared/workbench-scene";
import { makeWorkbenchSceneKey } from "../../../shared/workbench-scene";
import { workbenchPageEditorKey } from "@/lib/workbench-page-editor-key";
import type { WorkbenchWindowOwner } from "@/lib/workbench-window-owner";
import { WorkbenchLibraryPageSurface } from "./workbench-library-page-surface";
import { WorkbenchDatabaseViewSurface } from "./workbench-database-view-surface";
import { WorkbenchCanvasStagePanel } from "./workbench-canvas-stage-panel";

type ResourceSurface = Extract<
  WorkbenchSurfaceDescriptor,
  { kind: "page_stage" | "db_view" | "canvas_stage" }
>;

/** Library access stays attached to the resource while its Scene supplies only placement and lifetime. */
export function WorkbenchLibraryResourceSurface({
  surface,
  owner,
  sceneOwner,
  windowSessionId,
  active,
  presentedPageIds,
  onClose,
  onTitleChange,
  onOpenTarget,
}: {
  readonly surface: ResourceSurface;
  readonly owner: WorkbenchWindowOwner;
  readonly sceneOwner: WorkbenchSceneOwner;
  readonly windowSessionId: string;
  readonly active: boolean;
  readonly presentedPageIds?: ReadonlySet<string>;
  readonly onClose: () => void;
  readonly onTitleChange: (title: string) => void;
  readonly onOpenTarget: (
    target: LibraryRouteTarget,
    options?: { readonly titleSnapshot?: string; readonly mode?: "durable" | "preview" },
  ) => void;
}) {
  if (surface.config.accessContext.kind !== "library")
    throw new Error("Library resource body requires Library access");
  if (surface.kind === "page_stage")
    return (
      <WorkbenchLibraryPageSurface
        surfaceId={surface.id}
        editorSessionKey={workbenchPageEditorKey(sceneOwner, surface.id)}
        pageId={surface.config.pageId}
        isActivePanelTab={active}
        onClose={onClose}
        onOpenDatabase={(databaseId) => onOpenTarget({ kind: "database", databaseId })}
        onOpenPage={(pageId, titleSnapshot) =>
          onOpenTarget({ kind: "page", pageId }, { titleSnapshot })
        }
        onOpenCanvas={(canvasId, titleSnapshot) =>
          onOpenTarget({ kind: "canvas", canvasId }, { titleSnapshot })
        }
      />
    );
  if (surface.kind === "canvas_stage")
    return (
      <WorkbenchCanvasStagePanel
        surface={surface}
        windowSessionId={windowSessionId}
        presentationOwnerId={
          sceneOwner.kind === "session" ? sceneOwner.sessionId : makeWorkbenchSceneKey(sceneOwner)
        }
        isActivePanelTab={active}
        onClose={onClose}
        onTitleChange={onTitleChange}
        onOpenPage={({ pageId, titleSnapshot }) =>
          onOpenTarget({ kind: "page", pageId }, { titleSnapshot })
        }
      />
    );
  if (surface.config.target.kind === "project-default")
    return <div role="status">Database View is unavailable</div>;
  return (
    <WorkbenchDatabaseViewSurface
      workbenchPresentation={{ owner, sceneOwner, surface }}
      accessContext={surface.config.accessContext}
      target={surface.config.target}
      keyboardSurface={{ surfaceId: surface.id, presentationId: surface.id }}
      presentedPageIds={presentedPageIds}
      onPresentationChange={({ databaseName, viewName }) => {
        const title = surface.config.target.kind === "database-default" ? databaseName : viewName;
        if (title !== surface.titleSnapshot) onTitleChange(title);
      }}
      onOpenPage={(pageId, titleSnapshot, mode) =>
        onOpenTarget({ kind: "page", pageId }, { titleSnapshot, mode })
      }
    />
  );
}
