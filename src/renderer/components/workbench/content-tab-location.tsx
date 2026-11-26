import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { usePageTargetReadModel } from "@/lib/block-reference-queries";
import {
  presentResourceLocation,
  resourceLocationProjectId,
} from "@/lib/resource-location-presentation";
import { resourceLocationTargetKey, useResourceLocations } from "@/lib/resource-location-queries";
import type { Project, WorkbenchTabProjection } from "@/lib/types";
import type { ContentRoutingContext } from "../../../shared/content-routing-context";
import { parseDatabaseId, parseDatabaseViewId } from "../../../shared/database-identities";
import type { LibraryRouteTarget } from "../../../shared/library-module";
import type { ResourceLocationSegment } from "../../../shared/resource-locations";
import type { WorkbenchSurfaceDescriptor } from "../../../shared/workbench-scene";
import { AppShellTabLocationTooltip, type AppShellTabItem } from "./app-shell-tabs";

type SurfaceShape<Surface> = Surface extends {
  readonly kind: infer Kind;
  readonly config: infer Config;
}
  ? { readonly kind: Kind; readonly config: Config }
  : never;

/** A Scene surface or a Session tab, by kind and configuration. */
export type LocatedTabSurface =
  | SurfaceShape<WorkbenchSurfaceDescriptor>
  | SurfaceShape<WorkbenchTabProjection>;

/** A file's folders below its workspace root, or below the filesystem root without one. */
function fileFolders(config: { readonly workspaceRoot: string | null; readonly path?: string }) {
  if (!config.path) return [];
  const root = config.workspaceRoot?.replace(/[\\/]+$/u, "");
  const relative =
    root && config.path.startsWith(`${root}/`) ? config.path.slice(root.length + 1) : config.path;
  return relative.split(/[\\/]/u).filter(Boolean).slice(0, -1);
}

const projectDatabaseId = (projects: readonly Project[], projectId: string): string | null =>
  projects.find((project) => project.id === projectId)?.databaseId ?? null;

/**
 * The Library resource a content tab shows. Its location comes from that resource's ownership,
 * never from the route the tab was opened through.
 */
export function contentTabLocationTarget(
  surface: LocatedTabSurface,
  projects: readonly Project[],
): LibraryRouteTarget | null {
  switch (surface.kind) {
    case "page_stage":
    case "page_file":
      return { kind: "page", pageId: surface.config.pageId };
    case "canvas_stage":
      return { kind: "canvas", canvasId: surface.config.canvasBlockId };
    case "db_view": {
      const { target, routingContext } = surface.config;
      if (target.kind === "database-default")
        return { kind: "database", databaseId: target.databaseId };
      if (target.kind === "database-view")
        return { kind: "view", viewId: parseDatabaseViewId(target.databaseViewId) };
      const databaseId =
        routingContext.kind === "project"
          ? projectDatabaseId(projects, routingContext.projectId)
          : null;
      return databaseId ? { kind: "database", databaseId: parseDatabaseId(databaseId) } : null;
    }
    default:
      return null;
  }
}

/** Where a content tab lives; undefined until its location is read. */
export type ContentTabLocationLookup = (
  surface: LocatedTabSurface,
) => readonly ResourceLocationSegment[] | undefined;

/**
 * Reads where every content tab of a strip lives, together, so a tab can tell itself apart
 * from same-titled content elsewhere. A tab whose location is still unread has none yet.
 */
export function useContentTabLocations(
  surfaces: readonly LocatedTabSurface[],
  projects: readonly Project[],
): ContentTabLocationLookup {
  const targets = surfaces.flatMap((surface) => {
    const target = contentTabLocationTarget(surface, projects);
    return target ? [target] : [];
  });
  const locations = useResourceLocations(targets);
  return (surface) => {
    const target = contentTabLocationTarget(surface, projects);
    if (!target) return undefined;
    const location = locations.get(resourceLocationTargetKey(target));
    return location?.status === "available" ? location.segments : undefined;
  };
}

/** The Project a tab's content belongs to: the Project whose primary Database holds or is it. */
function contentProjectId(
  surface: LocatedTabSurface,
  segments: readonly ResourceLocationSegment[],
  projects: readonly Project[],
): string | null {
  if (surface.kind === "db_view") {
    const target = contentTabLocationTarget(surface, projects);
    const owner =
      target?.kind === "database"
        ? projects.find((project) => project.databaseId === target.databaseId)
        : undefined;
    if (owner) return owner.id;
  }
  return resourceLocationProjectId(segments);
}

/**
 * Where a tab's content lives, for its tooltip and for telling it apart from same-titled tabs:
 * a file's folders, or the Databases and Pages that own a Page, Database, or Canvas, with Space
 * for content at its top level. Content that belongs to another Project than the Scene's also
 * names its location to assistive technology, since the tab itself shows only the title.
 */
export function resolveContentTabLocation(
  surface: LocatedTabSurface,
  options: {
    readonly projects: readonly Project[];
    /** The Scene's own presentation: a Project, the Library, or none for a projectless chat. */
    readonly home: ContentRoutingContext | null;
    /** The content's owners, from `useContentTabLocations`; absent until read. */
    readonly location: readonly ResourceLocationSegment[] | undefined;
  },
  intl: IntlShape = getIntl(),
): Pick<AppShellTabItem, "location" | "titleLabel" | "renderTooltip"> {
  if (surface.kind === "files") {
    const folders = fileFolders(surface.config);
    return folders.length > 0 ? { location: folders } : {};
  }
  if (!options.location || !contentTabLocationTarget(surface, options.projects)) return {};

  const path = presentResourceLocation(options.location, intl);
  const homeProjectId = options.home?.kind === "project" ? options.home.projectId : null;
  const elsewhere = contentProjectId(surface, options.location, options.projects) !== homeProjectId;

  return {
    location: path,
    ...(elsewhere
      ? {
          titleLabel: (title: string) =>
            intl.formatMessage(
              {
                id: "workbench.contentTabLocation.titleAndLocation",
                defaultMessage: "{title}, {location}",
              },
              { title, location: path.join(" / ") },
            ),
        }
      : {}),
    ...(surface.kind === "page_file"
      ? {
          renderTooltip: (title: string) => (
            <PageFileTabTooltip
              title={title}
              routingContext={surface.config.routingContext}
              pageId={surface.config.pageId}
              location={path}
              filePath={surface.config.logicalPath}
            />
          ),
        }
      : {}),
  };
}

/** A Page File tab's tooltip follows its Page's location with the Page and the File's folders. */
function PageFileTabTooltip({
  title,
  routingContext,
  pageId,
  location,
  filePath,
}: {
  readonly title: string;
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly location: readonly string[];
  readonly filePath?: string | null;
}) {
  const intl = useIntl();
  const page = usePageTargetReadModel(routingContext, pageId);
  const pageTitle =
    page.data?.status === "available"
      ? page.data.page.title.trim() ||
        intl.formatMessage({
          id: "workbench.contentTabLocation.untitled",
          defaultMessage: "Untitled",
        })
      : pageId;
  return (
    <AppShellTabLocationTooltip
      title={title}
      location={[...location, pageTitle, ...(filePath?.split("/").slice(0, -1) ?? [])]}
    />
  );
}
