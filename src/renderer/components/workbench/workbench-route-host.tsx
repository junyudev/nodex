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
  readonly inbox: WorkbenchRouteSlot;
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
      data-contextual-sidebar-open={sidebarMounted}
      className={cn(
        "main-surface relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden !rounded-none",
        sidebarMounted && "border-s-[0.5px] border-token-border",
      )}
      style={{
        clipPath: sidebarMounted ? "inset(0 0 0 -12px round 12px)" : "inset(0 round 12px)",
      }}
    >
      {children}
    </main>
  );
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
  inbox,
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

  if (location.kind === "inbox") {
    return (
      <>
        {sidebar}
        <WorkbenchRouteMain sidebarMounted={sidebarMounted}>{inbox.content()}</WorkbenchRouteMain>
        {inbox.afterMain}
      </>
    );
  }

  if (
    location.kind === "project" ||
    location.kind === "session" ||
    location.kind === "pages" ||
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
