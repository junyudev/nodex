import {
  resolveDefaultSettingsSectionId,
  resolveVisibleSettingsSections,
  type SettingsSectionDefinition,
  type SettingsSectionId,
} from "./workbench-settings-sections";

export const SETTINGS_ROOT_PATH = "/settings";
export const OPEN_SOURCE_LICENSES_SETTINGS_PATH = "/settings/open-source-licenses";

export type SettingsDetailPageId = "open-source-licenses";

export type BrowserSettingsAnchor =
  | "general"
  | "autofill-and-passwords"
  | "extensions"
  | "downloads"
  | "permissions"
  | "site-permissions"
  | "developer-mode";

export type BrowserSettingsDetail =
  | "passwords"
  | "contact-info"
  | "history"
  | "extensions"
  | "downloads";

export type BrowserSettingsDestination = "browser" | BrowserSettingsDetail;

const BROWSER_SETTINGS_ANCHORS = new Set<BrowserSettingsAnchor>([
  "general",
  "autofill-and-passwords",
  "extensions",
  "downloads",
  "permissions",
  "site-permissions",
  "developer-mode",
]);

const BROWSER_SETTINGS_DETAILS = new Set<BrowserSettingsDetail>([
  "passwords",
  "contact-info",
  "history",
  "extensions",
  "downloads",
]);

function readSettingsUrl(path: string | null | undefined): URL {
  try {
    return new URL(path || SETTINGS_ROOT_PATH, "nodex://settings");
  } catch {
    return new URL(SETTINGS_ROOT_PATH, "nodex://settings");
  }
}

function normalizeSettingsPath(path: string | null | undefined): string {
  const pathname = readSettingsUrl(path).pathname;
  if (pathname === "/settings/") {
    return SETTINGS_ROOT_PATH;
  }

  return pathname;
}

function parseBrowserAnchor(path: string | null | undefined): BrowserSettingsAnchor | null {
  const hash = readSettingsUrl(path).hash.slice(1);
  return BROWSER_SETTINGS_ANCHORS.has(hash as BrowserSettingsAnchor)
    ? (hash as BrowserSettingsAnchor)
    : null;
}

function parseSettingsAnchor(path: string | null | undefined): string | null {
  const hash = readSettingsUrl(path).hash.slice(1);
  if (!hash) return null;

  try {
    return decodeURIComponent(hash);
  } catch {
    return hash;
  }
}

function parseBrowserDetail(slug: string): BrowserSettingsDetail | null {
  return BROWSER_SETTINGS_DETAILS.has(slug as BrowserSettingsDetail)
    ? (slug as BrowserSettingsDetail)
    : null;
}

export function buildSettingsPath(sectionId: SettingsSectionId): string {
  return `${SETTINGS_ROOT_PATH}/${sectionId}`;
}

export function buildBrowserSettingsPath(
  detail?: BrowserSettingsDetail,
  anchor?: BrowserSettingsAnchor,
): string {
  const path = detail ? `${SETTINGS_ROOT_PATH}/browser/${detail}` : `${SETTINGS_ROOT_PATH}/browser`;
  return !detail && anchor ? `${path}#${anchor}` : path;
}

export function buildSettingsAnchorPath(sectionId: SettingsSectionId, anchor: string): string {
  return `${buildSettingsPath(sectionId)}#${encodeURIComponent(anchor)}`;
}

export function resolveBrowserSettingsDestination(destination: BrowserSettingsDestination): string {
  return destination === "browser"
    ? buildBrowserSettingsPath()
    : buildBrowserSettingsPath(destination);
}

export function parseSettingsPath(path: string | null | undefined): string | null {
  const normalizedPath = normalizeSettingsPath(path);
  if (normalizedPath === SETTINGS_ROOT_PATH) {
    return null;
  }

  if (!normalizedPath.startsWith(`${SETTINGS_ROOT_PATH}/`)) {
    return null;
  }

  const slug = normalizedPath.slice(`${SETTINGS_ROOT_PATH}/`.length);
  return slug || null;
}

export interface ResolvedSettingsShellState {
  activeSectionId: SettingsSectionId;
  browserAnchor: BrowserSettingsAnchor | null;
  browserDetail: BrowserSettingsDetail | null;
  detailPageId: SettingsDetailPageId | null;
  settingsAnchor: string | null;
  visibleSections: SettingsSectionDefinition[];
}

export function resolveSettingsShellState(
  path: string | null | undefined,
): ResolvedSettingsShellState {
  const visibleSections = resolveVisibleSettingsSections();
  const defaultSectionId = resolveDefaultSettingsSectionId(visibleSections);
  const normalizedPath = normalizeSettingsPath(path);
  const requestedSlug = parseSettingsPath(path);
  const settingsAnchor = parseSettingsAnchor(path);
  const detailPageId =
    normalizedPath === OPEN_SOURCE_LICENSES_SETTINGS_PATH ? "open-source-licenses" : null;

  let activeSectionId = defaultSectionId;
  let browserAnchor: BrowserSettingsAnchor | null = null;
  let browserDetail: BrowserSettingsDetail | null = null;

  if (detailPageId) {
    activeSectionId = "general-settings";
  } else if (requestedSlug === "browser") {
    activeSectionId = "browser";
    browserAnchor = parseBrowserAnchor(path);
  } else if (requestedSlug?.startsWith("plugins-settings/")) {
    // An installed plugin's settings page belongs to Settings › Plugins.
    activeSectionId = "plugins-settings";
  } else if (requestedSlug?.startsWith("browser/")) {
    const detail = parseBrowserDetail(requestedSlug.slice("browser/".length));
    if (detail) {
      activeSectionId = "browser";
      browserDetail = detail;
    }
  } else {
    const matchingSection = visibleSections.find((section) => section.id === requestedSlug);
    if (matchingSection) {
      activeSectionId = matchingSection.id;
    }
  }

  return {
    activeSectionId,
    browserAnchor,
    browserDetail,
    detailPageId,
    settingsAnchor,
    visibleSections,
  };
}
