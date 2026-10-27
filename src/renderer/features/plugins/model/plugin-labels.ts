import type { PluginRow } from "../plugin-management";

/** The name people see: the manifest's display name, else the plugin's name. */
export function pluginDisplayName(row: Pick<PluginRow, "summary">): string {
  const displayName = row.summary.interface?.displayName?.trim();
  return displayName && displayName.length > 0 ? displayName : row.summary.name;
}

/** The one-line description shown under a plugin's name in lists. */
export function pluginShortDescription(row: Pick<PluginRow, "summary">): string | null {
  const description = row.summary.interface?.shortDescription?.trim();
  return description && description.length > 0 ? description : null;
}
