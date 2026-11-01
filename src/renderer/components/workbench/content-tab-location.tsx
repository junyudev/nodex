import {
  usePageTargetReadModel,
  usePageOwnershipPathReadModel,
} from "@/lib/block-reference-queries";
import type { Project, WorkbenchTabProjection } from "@/lib/types";
import {
  contentRoutingContextKey,
  type ContentRoutingContext,
} from "../../../shared/content-routing-context";
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

/**
 * Where a tab's content lives, for its tooltip and for telling it apart from same-titled tabs:
 * a file's folders, or the Library or Project holding a Page, Database, or Canvas. Content
 * outside the Scene's `home` also names its location to assistive technology, since the tab
 * itself shows only the title.
 */
export function resolveContentTabLocation(
  surface: LocatedTabSurface,
  options: { readonly projects: readonly Project[]; readonly home: ContentRoutingContext | null },
): Pick<AppShellTabItem, "location" | "titleLabel" | "renderTooltip"> {
  if (surface.kind === "files") {
    const folders = fileFolders(surface.config);
    return folders.length > 0 ? { location: folders } : {};
  }
  if (
    surface.kind !== "page_stage" &&
    surface.kind !== "page_file" &&
    surface.kind !== "db_view" &&
    surface.kind !== "canvas_stage"
  )
    return {};

  const { routingContext } = surface.config;
  const projectLabel =
    routingContext.kind === "project"
      ? options.projects.find((project) => project.id === routingContext.projectId)?.name.trim() ||
        routingContext.projectId
      : null;
  const root = projectLabel ?? "Library";
  const elsewhere =
    !options.home ||
    contentRoutingContextKey(options.home) !== contentRoutingContextKey(routingContext);
  const accessibleRoot = projectLabel === null ? "Library" : `${projectLabel} project`;

  return {
    location: [root],
    ...(elsewhere ? { titleLabel: (title: string) => `${title}, ${accessibleRoot}` } : {}),
    ...(surface.kind === "page_stage" || surface.kind === "page_file"
      ? {
          renderTooltip: (title: string) => (
            <PageTabTooltip
              title={title}
              root={root}
              routingContext={routingContext}
              pageId={surface.config.pageId}
              filePath={surface.kind === "page_file" ? surface.config.logicalPath : undefined}
              isPageFile={surface.kind === "page_file"}
            />
          ),
        }
      : {}),
  };
}

/** A Page tab's tooltip follows its Library or Project with the Page's parents, read on hover. */
function PageTabTooltip({
  title,
  root,
  routingContext,
  pageId,
  filePath,
  isPageFile = false,
}: {
  readonly title: string;
  readonly root: string;
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly filePath?: string | null;
  readonly isPageFile?: boolean;
}) {
  const path = usePageOwnershipPathReadModel(routingContext, pageId);
  const parents =
    path.data?.status === "available"
      ? path.data.ancestors.map((ancestor) => ancestor.title.trim() || "Untitled")
      : [];
  if (isPageFile)
    return (
      <PageFileTabTooltip
        title={title}
        routingContext={routingContext}
        pageId={pageId}
        location={[root, ...parents]}
        filePath={filePath}
      />
    );
  return <AppShellTabLocationTooltip title={title} location={[root, ...parents]} />;
}

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
  const page = usePageTargetReadModel(routingContext, pageId);
  const pageTitle =
    page.data?.status === "available" ? page.data.page.title.trim() || "Untitled" : pageId;
  return (
    <AppShellTabLocationTooltip
      title={title}
      location={[...location, pageTitle, ...(filePath?.split("/").slice(0, -1) ?? [])]}
    />
  );
}
