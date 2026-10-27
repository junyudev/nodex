import type { PluginRouteTarget } from "../../../shared/codex-plugin-management";

/** What Customize's sidebar and route ask of the Workbench. */
export interface CustomizeNavigation {
  /** The current Customize path, or null while another destination is showing. */
  readonly path: string | null;
  /** The Project whose working directories scope plugin discovery, if any. */
  readonly projectId: string | null;
  readonly onNavigate: (path: string, options?: { readonly replace?: boolean }) => void;
  /** Opens a new chat with an unsent draft, such as a plugin mention and a starter prompt. */
  readonly onStartChat: (prompt: string) => void;
  /** Opens Settings › Plugins, or one installed plugin's settings there. */
  readonly onOpenSettings: (target?: PluginRouteTarget) => void;
  /** Opens Settings › Hooks, where hooks are reviewed and trusted. */
  readonly onOpenHooksSettings: () => void;
}
