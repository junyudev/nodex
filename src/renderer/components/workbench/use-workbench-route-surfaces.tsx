import { lazy, type ComponentProps } from "react";
import { ApplicationSurface } from "@/bootstrap/application-surface";
import { SettingsRouteShell } from "./workbench-settings-route-shell";

const PendingWorktreeRoute = lazy(async () => ({
  default: (await import("./pending-worktree-route")).PendingWorktreeRoute,
}));
const ScheduledRoute = lazy(async () => ({
  default: (await import("@/features/scheduled/scheduled-route")).ScheduledRoute,
}));
const PluginsRoute = lazy(async () => ({
  default: (await import("@/features/plugins/view/plugins-route")).PluginsRoute,
}));

type SettingsProps = Omit<ComponentProps<typeof SettingsRouteShell>, "path">;
type AutomationsProps = Omit<ComponentProps<typeof ScheduledRoute>, "path">;
type PluginsProps = Omit<ComponentProps<typeof PluginsRoute>, "path">;
type PendingWorktreeProps = Omit<ComponentProps<typeof PendingWorktreeRoute>, "clientThreadId">;

interface WorkbenchRouteSurfacesInput {
  readonly settings: {
    readonly path: string | null;
    readonly props: SettingsProps;
  };
  readonly automations: {
    readonly path: string | null;
    readonly props: AutomationsProps;
  };
  readonly plugins: {
    readonly path: string | null;
    readonly props: PluginsProps;
  };
  readonly pendingWorktree: {
    readonly clientThreadId: string | null;
    readonly props: PendingWorktreeProps;
  };
}

/**
 * Owns auxiliary route surface selection. The Shell supplies route state and
 * route-specific ports, then consumes the resulting mutually-exclusive views.
 */
export function useWorkbenchRouteSurfaces({
  settings,
  automations,
  plugins,
  pendingWorktree,
}: WorkbenchRouteSurfacesInput) {
  const settingsRouteShell = settings.path ? (
    <ApplicationSurface>
      <SettingsRouteShell path={settings.path} {...settings.props} />
    </ApplicationSurface>
  ) : null;

  const automationsRouteShell = automations.path ? (
    <ApplicationSurface>
      <ScheduledRoute path={automations.path} {...automations.props} />
    </ApplicationSurface>
  ) : null;

  const pluginsRouteShell = plugins.path ? (
    <ApplicationSurface>
      <PluginsRoute path={plugins.path} {...plugins.props} />
    </ApplicationSurface>
  ) : null;

  const pendingWorktreeRouteShell = pendingWorktree.clientThreadId ? (
    <ApplicationSurface>
      <PendingWorktreeRoute
        clientThreadId={pendingWorktree.clientThreadId}
        {...pendingWorktree.props}
      />
    </ApplicationSurface>
  ) : null;

  return {
    automationsRouteShell,
    pluginsRouteShell,
    pendingWorktreeRouteShell,
    settingsRouteShell,
  };
}
