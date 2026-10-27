import type { ReactNode } from "react";
import type { WorkbenchLocation } from "../../../shared/workbench-layout";
import { NodexButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface WorkbenchRouteSlot {
  readonly content: () => ReactNode;
  readonly afterMain?: ReactNode;
}

interface WorkbenchRouteHostProps {
  readonly location: WorkbenchLocation;
  readonly sidebar: ReactNode;
  readonly sidebarMounted: boolean;
  readonly settings: ReactNode;
  readonly pendingWorktree: WorkbenchRouteSlot;
  readonly automations: WorkbenchRouteSlot;
  readonly plugins: WorkbenchRouteSlot;
  /** The selected Scene: a Project, a Session, the Library, the Library Inbox, or empty. */
  readonly session: WorkbenchRouteSlot;
}

function WorkbenchRouteMain({
  sidebarMounted,
  children,
}: {
  readonly sidebarMounted: boolean;
  readonly children: ReactNode;
}) {
  return (
    <main
      data-workbench-main-surface
      data-app-shell-main-surface="default"
      data-contextual-sidebar-open={sidebarMounted}
      className={cn("flex-col", workbenchMainSurfaceClassName(sidebarMounted))}
      style={{ clipPath: resolveWorkbenchMainSurfaceClip(sidebarMounted) }}
    >
      {children}
    </main>
  );
}

/** The one opaque content surface inside the window frame, shared by every route. */
export function workbenchMainSurfaceClassName(sidebarMounted: boolean): string {
  return cn(
    "relative flex min-h-0 min-w-0 flex-1 overflow-hidden bg-(--color-surface)",
    sidebarMounted &&
      "border-s-[length:var(--border-width-hairline)] border-(--app-shell-sidebar-divider)",
  );
}

/**
 * A pinned sidebar owns the outer start corners; the main surface owns the end
 * corners and extends its clip under the shared flat divider.
 */
export function resolveWorkbenchMainSurfaceClip(sidebarMounted: boolean): string {
  return sidebarMounted
    ? "inset(0 0 0 calc(-1 * var(--app-shell-surface-radius)) round var(--app-shell-surface-radius))"
    : "inset(0 round var(--app-shell-surface-radius))";
}

/**
 * Exhaustive selected-route host. Inactive route trees are never mounted, so
 * their header, overlay, Browser, and editor effects cannot remain live.
 */
export function WorkbenchRouteHost({
  location,
  sidebar,
  sidebarMounted,
  settings,
  pendingWorktree,
  automations,
  plugins,
  session,
}: WorkbenchRouteHostProps) {
  if (location.kind === "settings") return settings;

  if (location.kind === "pending-worktree") {
    return (
      <>
        {sidebar}
        <WorkbenchRouteMain sidebarMounted={sidebarMounted}>
          {pendingWorktree.content()}
        </WorkbenchRouteMain>
        {pendingWorktree.afterMain}
      </>
    );
  }

  if (location.kind === "automations") {
    return (
      <>
        {sidebar}
        <WorkbenchRouteMain sidebarMounted={sidebarMounted}>
          {automations.content()}
        </WorkbenchRouteMain>
        {automations.afterMain}
      </>
    );
  }

  if (location.kind === "plugins") {
    return (
      <>
        {sidebar}
        <WorkbenchRouteMain sidebarMounted={sidebarMounted}>{plugins.content()}</WorkbenchRouteMain>
        {plugins.afterMain}
      </>
    );
  }

  if (
    location.kind === "project" ||
    location.kind === "session" ||
    location.kind === "library" ||
    location.kind === "inbox" ||
    location.kind === "empty"
  ) {
    return (
      <>
        {sidebar}
        <WorkbenchRouteMain sidebarMounted={sidebarMounted}>{session.content()}</WorkbenchRouteMain>
        {session.afterMain}
      </>
    );
  }

  location satisfies never;
  return null;
}

export function WorkbenchEmptyRoute({
  activeProjectId,
  projectCatalogError,
  onRetryProjects,
  onStartProjectlessChat,
}: {
  readonly activeProjectId: string | null;
  readonly projectCatalogError: string | null;
  readonly onRetryProjects?: () => void | Promise<void>;
  readonly onStartProjectlessChat: () => void;
}) {
  if (activeProjectId !== null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-token-text-secondary">
        Select a project session.
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-token-description-foreground">
        {projectCatalogError ? "Projects could not be loaded" : "No project selected"}
      </p>
      {projectCatalogError ? (
        <p className="max-w-sm text-xs text-token-text-secondary">{projectCatalogError}</p>
      ) : null}
      {projectCatalogError && onRetryProjects ? (
        <NodexButton size="sm" variant="secondary" onClick={() => void onRetryProjects()}>
          Retry
        </NodexButton>
      ) : null}
      <NodexButton size="sm" variant="secondary" onClick={onStartProjectlessChat}>
        Start a projectless chat
      </NodexButton>
    </div>
  );
}
