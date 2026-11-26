import { useIntl } from "@/lib/i18n";
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
  readonly pluginApp?: ReactNode;
  readonly insights: WorkbenchRouteSlot;
  readonly settled: WorkbenchRouteSlot;
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
    <WorkbenchMainSurface as="main" besideSidebar={sidebarMounted} headerRule>
      {children}
    </WorkbenchMainSurface>
  );
}

/**
 * The one opaque content surface inside the window frame, shared by every route. It reaches the
 * window's top, end and bottom edges and rises under the titlebar, so each pane's titlebar row
 * sits on the surface it heads; its content starts below that row. Beside a sidebar it rounds
 * its start corners against the sidebar's chrome.
 */
export function WorkbenchMainSurface({
  as: Element = "div",
  besideSidebar,
  headerRule = false,
  children,
}: {
  readonly as?: "main" | "div";
  readonly besideSidebar: boolean;
  /** A hairline closes the titlebar band above the content while the content dock shows. */
  readonly headerRule?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <Element
      data-workbench-main-surface={Element === "main" ? "" : undefined}
      data-app-shell-main-surface="default"
      data-contextual-sidebar-open={besideSidebar}
      className={workbenchMainSurfaceClassName(besideSidebar)}
    >
      <div
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 flex-col",
          headerRule &&
            "[[data-app-shell-content-dock-rule=true]_&]:border-t-[length:var(--border-width-hairline)] [[data-app-shell-content-dock-rule=true]_&]:border-(--color-border)",
        )}
      >
        {children}
      </div>
    </Element>
  );
}

/** Surface paint and placement; the titlebar band is padding above the content. */
export function workbenchMainSurfaceClassName(besideSidebar: boolean): string {
  return cn(
    "relative isolate -mt-(--app-shell-surface-lift) flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--color-surface) pt-(--app-shell-surface-header-height)",
    besideSidebar &&
      "rounded-s-(--app-shell-surface-radius) border-s-[length:var(--border-width-hairline)] border-(--color-border)",
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
  plugins,
  pluginApp,
  insights,
  settled,
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

  if (location.kind === "plugin_app") {
    return <WorkbenchRouteMain sidebarMounted={false}>{pluginApp}</WorkbenchRouteMain>;
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

  if (location.kind === "insights" || location.kind === "settled") {
    const slot = location.kind === "insights" ? insights : settled;
    return (
      <>
        {sidebar}
        <WorkbenchRouteMain sidebarMounted={sidebarMounted}>{slot.content()}</WorkbenchRouteMain>
        {slot.afterMain}
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
  const intl = useIntl();
  if (activeProjectId !== null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-token-text-secondary">
        {intl.formatMessage({
          id: "workbench.workbenchRouteHost.selectSession",
          defaultMessage: "Select a project session.",
        })}
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
      <p className="text-sm text-token-description-foreground">
        {projectCatalogError
          ? intl.formatMessage({
              id: "workbench.workbenchRouteHost.projectsUnavailable",
              defaultMessage: "Projects could not be loaded",
            })
          : intl.formatMessage({
              id: "workbench.workbenchRouteHost.noProjectSelected",
              defaultMessage: "No project selected",
            })}
      </p>
      {projectCatalogError ? (
        <p className="max-w-sm text-xs text-token-text-secondary">{projectCatalogError}</p>
      ) : null}
      {projectCatalogError && onRetryProjects ? (
        <NodexButton size="sm" variant="secondary" onClick={() => void onRetryProjects()}>
          {intl.formatMessage({
            id: "workbench.workbenchRouteHost.retry",
            defaultMessage: "Retry",
          })}
        </NodexButton>
      ) : null}
      <NodexButton size="sm" variant="secondary" onClick={onStartProjectlessChat}>
        {intl.formatMessage({
          id: "workbench.workbenchRouteHost.startProjectlessChat",
          defaultMessage: "Start a projectless chat",
        })}
      </NodexButton>
    </div>
  );
}
