import type {
  BrowserSidebarCommand,
  BrowserSidebarCommandResult,
} from "../../../shared/browser-sidebar";
import type { IpcApi } from "../../../shared/ipc-api";
import type { IpcOperationDefinitionMap } from "../../../shared/ipc-endpoint-policy";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "@/lib/renderer-command";

type IpcArgs<Channel extends keyof IpcApi> = IpcApi[Channel]["args"] extends readonly unknown[]
  ? IpcApi[Channel]["args"]
  : never;

const defineBrowserSidebarCommand = <const Type extends BrowserSidebarCommand["type"]>(
  type: Type,
) =>
  defineRendererCommand({
    key: `browser_sidebar.${type}`,
    channel: "browser-sidebar-command",
    authority: "main",
    owner: "BrowserSidebarRuntime",
    protocol: { kind: "returned_value" },
  });

type BrowserSidebarRegisteredCommand = ReturnType<typeof defineBrowserSidebarCommand>;

/** Exhaustive semantic registration for the aggregate Browser runtime channel. */
const browserSidebarCommandDefinitions = {
  "attach-dragged-image": defineBrowserSidebarCommand("attach-dragged-image"),
  "browser-use-cursor-arrived": defineBrowserSidebarCommand("browser-use-cursor-arrived"),
  "browser-use-release-tab": defineBrowserSidebarCommand("browser-use-release-tab"),
  "browser-use-resolve-presentation": defineBrowserSidebarCommand(
    "browser-use-resolve-presentation",
  ),
  "browser-use-set-active-tab": defineBrowserSidebarCommand("browser-use-set-active-tab"),
  "browser-use-set-capture-surface": defineBrowserSidebarCommand("browser-use-set-capture-surface"),
  "browser-use-set-cursor": defineBrowserSidebarCommand("browser-use-set-cursor"),
  "browser-use-set-viewport": defineBrowserSidebarCommand("browser-use-set-viewport"),
  "browser-use-upsert-tab": defineBrowserSidebarCommand("browser-use-upsert-tab"),
  "capture-browser-use-route": defineBrowserSidebarCommand("capture-browser-use-route"),
  "capture-screenshot": defineBrowserSidebarCommand("capture-screenshot"),
  "close-find": defineBrowserSidebarCommand("close-find"),
  "close-tab": defineBrowserSidebarCommand("close-tab"),
  "find-next": defineBrowserSidebarCommand("find-next"),
  "find-previous": defineBrowserSidebarCommand("find-previous"),
  "go-back": defineBrowserSidebarCommand("go-back"),
  "go-forward": defineBrowserSidebarCommand("go-forward"),
  "hide-local-server": defineBrowserSidebarCommand("hide-local-server"),
  "local-servers-refresh": defineBrowserSidebarCommand("local-servers-refresh"),
  navigate: defineBrowserSidebarCommand("navigate"),
  "open-external": defineBrowserSidebarCommand("open-external"),
  "open-find": defineBrowserSidebarCommand("open-find"),
  print: defineBrowserSidebarCommand("print"),
  "quick-annotate": defineBrowserSidebarCommand("quick-annotate"),
  "register-host": defineBrowserSidebarCommand("register-host"),
  "register-renderer-session": defineBrowserSidebarCommand("register-renderer-session"),
  "register-tab": defineBrowserSidebarCommand("register-tab"),
  reload: defineBrowserSidebarCommand("reload"),
  "remove-local-server-route": defineBrowserSidebarCommand("remove-local-server-route"),
  "reset-zoom": defineBrowserSidebarCommand("reset-zoom"),
  "set-device-toolbar-visible": defineBrowserSidebarCommand("set-device-toolbar-visible"),
  "set-favicon": defineBrowserSidebarCommand("set-favicon"),
  "set-find-query": defineBrowserSidebarCommand("set-find-query"),
  "set-interaction-mode": defineBrowserSidebarCommand("set-interaction-mode"),
  "set-title": defineBrowserSidebarCommand("set-title"),
  "set-viewport": defineBrowserSidebarCommand("set-viewport"),
  "set-zoom-percent": defineBrowserSidebarCommand("set-zoom-percent"),
  "step-zoom": defineBrowserSidebarCommand("step-zoom"),
  stop: defineBrowserSidebarCommand("stop"),
  "sync-host": defineBrowserSidebarCommand("sync-host"),
  "sync-theme": defineBrowserSidebarCommand("sync-theme"),
  "unhide-local-server": defineBrowserSidebarCommand("unhide-local-server"),
} satisfies IpcOperationDefinitionMap<
  BrowserSidebarCommand["type"],
  BrowserSidebarRegisteredCommand
>;

const updateBrowserLocalServerPreferencesCommand = defineRendererCommand({
  key: "browser_sidebar.update_local_server_preferences",
  channel: "browser-local-server-preferences-update",
  authority: "main",
  owner: "BrowserSidebarRuntime",
  protocol: { kind: "returned_value" },
});

export function invokeBrowserSidebarCommand(
  command: BrowserSidebarCommand,
): Promise<BrowserSidebarCommandResult> {
  const definition = browserSidebarCommandDefinitions[command.type];
  return invokePlainCommand(definition, command);
}

export const updateBrowserLocalServerPreferences = (
  ...args: IpcArgs<"browser-local-server-preferences-update">
) => invokePlainCommand(updateBrowserLocalServerPreferencesCommand, ...args);

export const readBrowserLocalServerPreferences = () =>
  invokeRendererQuery("browser-local-server-preferences-get");

export const readBrowserLocalServerThumbnail = (
  ...args: IpcArgs<"browser-local-server-thumbnail">
) => invokeRendererQuery("browser-local-server-thumbnail", ...args);

export const notifyBrowserWebviewHostCreated = (
  ...args: IpcArgs<"browser-sidebar-webview-host-created">
) => invokeRendererControl("browser-sidebar-webview-host-created", ...args);

export const notifyBrowserWebviewDestroyed = (
  ...args: IpcArgs<"browser-sidebar-webview-destroyed">
) => invokeRendererControl("browser-sidebar-webview-destroyed", ...args);
