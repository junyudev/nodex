import type { PluginRouteTarget } from "../../../shared/codex-plugin-management";

export const PLUGINS_ROOT_PATH = "/plugins";
export const SKILLS_ROOT_PATH = "/skills";

/** The plugin directory's tabs. `openai` is the public directory. */
export type PluginDirectoryTab = "openai" | "personal";

export type PluginMarketplaceLocator = PluginRouteTarget["marketplace"];

/** Where in the directory a page was opened from. */
export interface PluginDirectoryBrowse {
  readonly tab: PluginDirectoryTab;
  /** A category's complete listing, or the tab's sectioned overview when null. */
  readonly category: string | null;
  /** A search across the directory; it replaces the tab's sections while set. */
  readonly search: string;
}

export type PluginsRouteState =
  | ({ readonly page: "directory" } & PluginDirectoryBrowse)
  | {
      readonly page: "plugin";
      readonly target: PluginRouteTarget;
      /** The directory view the plugin was opened from, which its breadcrumb returns to. */
      readonly browse: PluginDirectoryBrowse;
    }
  | { readonly page: "skills" };

function normalize(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeDirectoryTab(value: string | null): PluginDirectoryTab {
  return value === "personal" ? "personal" : "openai";
}

function withQuery(pathname: string, searchParams: URLSearchParams): string {
  const query = searchParams.toString();
  return query ? `${pathname}?${query}` : pathname;
}

function setBrowseParams(
  searchParams: URLSearchParams,
  input: Partial<PluginDirectoryBrowse>,
): URLSearchParams {
  const tab = input.tab ?? "openai";
  if (tab !== "openai") searchParams.set("directoryTab", tab);
  const category = normalize(input.category);
  if (category) {
    searchParams.set("directoryTab", tab);
    searchParams.set("category", category);
  }
  if (input.search) searchParams.set("search", input.search);
  return searchParams;
}

function readBrowseParams(searchParams: URLSearchParams): PluginDirectoryBrowse {
  return {
    tab: normalizeDirectoryTab(searchParams.get("directoryTab")),
    category: normalize(searchParams.get("category")),
    search: searchParams.get("search") ?? "",
  };
}

export function buildPluginDirectoryPath(input: Partial<PluginDirectoryBrowse> = {}): string {
  return withQuery(PLUGINS_ROOT_PATH, setBrowseParams(new URLSearchParams(), input));
}

/** A plugin's page, remembering the directory view it was opened from. */
export function buildPluginDetailPath(
  target: PluginRouteTarget,
  browse: Partial<PluginDirectoryBrowse> = {},
): string {
  const searchParams = setBrowseParams(new URLSearchParams(), browse);
  setTargetParams(searchParams, target);
  return withQuery(`${PLUGINS_ROOT_PATH}/${encodeURIComponent(target.pluginId)}`, searchParams);
}

/** Settings › Plugins, or one installed plugin's settings within it. */
export const PLUGINS_SETTINGS_PATH = "/settings/plugins-settings";

function readTarget(pathname: string, searchParams: URLSearchParams, prefix: string) {
  if (!pathname.startsWith(prefix)) return null;
  const pluginId = normalize(safeDecode(pathname.slice(prefix.length)));
  const pluginName = normalize(searchParams.get("pluginName"));
  const marketplacePath = normalize(searchParams.get("marketplacePath"));
  const remoteMarketplaceName = normalize(searchParams.get("remoteMarketplaceName"));
  const marketplace: PluginMarketplaceLocator | null = marketplacePath
    ? { kind: "local", marketplacePath }
    : remoteMarketplaceName
      ? { kind: "remote", remoteMarketplaceName }
      : null;
  return pluginId && pluginName && marketplace ? { pluginId, pluginName, marketplace } : null;
}

function splitPath(path: string): { pathname: string; searchParams: URLSearchParams } {
  const queryStart = path.indexOf("?");
  return {
    pathname: queryStart >= 0 ? path.slice(0, queryStart) : path,
    searchParams: new URLSearchParams(queryStart >= 0 ? path.slice(queryStart + 1) : ""),
  };
}

function setTargetParams(searchParams: URLSearchParams, target: PluginRouteTarget) {
  if (target.marketplace.kind === "local") {
    searchParams.set("marketplacePath", target.marketplace.marketplacePath);
  } else {
    searchParams.set("remoteMarketplaceName", target.marketplace.remoteMarketplaceName);
  }
  searchParams.set("pluginName", target.pluginName);
}

/** An installed plugin's page in Settings › Plugins. */
export function buildPluginSettingsPath(target: PluginRouteTarget): string {
  const searchParams = new URLSearchParams();
  setTargetParams(searchParams, target);
  return withQuery(
    `${PLUGINS_SETTINGS_PATH}/plugins/${encodeURIComponent(target.pluginId)}`,
    searchParams,
  );
}

/** The plugin a Settings › Plugins path shows, or null for the plugin list. */
export function resolvePluginSettingsTarget(path: string): PluginRouteTarget | null {
  const { pathname, searchParams } = splitPath(path);
  return readTarget(pathname, searchParams, `${PLUGINS_SETTINGS_PATH}/plugins/`);
}

export function buildSkillsPath(): string {
  return SKILLS_ROOT_PATH;
}

/** Resolves any Customize path; unknown paths open the public directory. */
export function resolvePluginsRouteState(path: string): PluginsRouteState {
  const { pathname, searchParams } = splitPath(path);

  if (pathname === SKILLS_ROOT_PATH) return { page: "skills" };

  const target = readTarget(pathname, searchParams, `${PLUGINS_ROOT_PATH}/`);
  if (target != null) {
    return { page: "plugin", target, browse: readBrowseParams(searchParams) };
  }

  return { page: "directory", ...readBrowseParams(searchParams) };
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
