import type { PluginRow } from "../plugin-management";
import { resolvePluginsRouteState } from "../plugins-routes";

/** Which Customize sidebar row reflects the current route. */
export type CustomizeSelection =
  | { readonly kind: "none" }
  | { readonly kind: "plugins" }
  | { readonly kind: "skills" }
  | { readonly kind: "plugin"; readonly pluginId: string };

export function resolveCustomizeSelection(path: string | null): CustomizeSelection {
  if (path === null) return { kind: "none" };
  const state = resolvePluginsRouteState(path);
  if (state.page === "skills") return { kind: "skills" };
  if (state.page === "plugin") return { kind: "plugin", pluginId: state.target.pluginId };
  return { kind: "plugins" };
}

/** A detail route names a plugin by its native ID; remote rows may also be named by remote ID. */
export function isPluginRowSelected(row: PluginRow, selection: CustomizeSelection): boolean {
  if (selection.kind !== "plugin") return false;
  return (
    row.nativeId === selection.pluginId ||
    row.stableIdentity === selection.pluginId ||
    row.summary.remotePluginId === selection.pluginId
  );
}
