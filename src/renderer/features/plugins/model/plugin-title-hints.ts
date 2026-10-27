/*
 * The names of plugins whose pages were just opened, so a page can title its breadcrumb before
 * its details load. Like navigation state, the hints live only as long as the window.
 */
const titles = new Map<string, string>();

export function rememberPluginTitle(pluginId: string, title: string): void {
  titles.set(pluginId, title);
}

export function pluginTitleHint(pluginId: string): string | null {
  return titles.get(pluginId) ?? null;
}
