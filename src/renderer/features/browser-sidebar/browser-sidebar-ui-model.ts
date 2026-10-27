import {
  BROWSER_SIDEBAR_ZOOM_OPTIONS,
  DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES,
  type BrowserLocalServerPreferences,
  type BrowserLocalServerShowMode,
  type BrowserLocalServerSortMode,
  type BrowserSidebarLocalServer,
  type BrowserSidebarLocalServersSnapshot,
  type BrowserSidebarViewport,
} from "../../../shared/browser-sidebar";
import { isBlankBrowserUrl, normalizeBrowserNavigationUrl } from "../../../shared/browser-url";

export type { BrowserLocalServerShowMode, BrowserLocalServerSortMode };

export interface BrowserLocalServerSettings {
  showMode: BrowserLocalServerShowMode;
  sortMode: BrowserLocalServerSortMode;
  expandedProjectIds: ReadonlySet<string>;
}

export interface BrowserVisibleLocalServers {
  servers: BrowserSidebarLocalServer[];
  hiddenServers: BrowserSidebarLocalServer[];
  hasMore: boolean;
}

/** One row of the New tab's four-column local server tiles. */
const VISIBLE_LOCAL_SERVER_LIMIT = 4;

export function readBrowserAddressValue(url: string): string {
  if (isBlankBrowserUrl(url)) return "";
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url;
    const host = parsed.host.replace(/^www\./i, "");
    const path = parsed.pathname === "/" ? "" : parsed.pathname;
    return `${host}${path}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

export function shouldSkipBrowserAddressCommit(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest(
      "[data-browser-sidebar-open-external],[data-browser-sidebar-skip-address-commit]",
    ),
  );
}

export function shouldCommitBrowserAddressEdit(currentUrl: string, draft: string): boolean {
  const trimmed = draft.trim();
  if (trimmed.length === 0) return !isBlankBrowserUrl(currentUrl);
  if (trimmed === readBrowserAddressValue(currentUrl)) return false;
  return normalizeBrowserNavigationUrl(trimmed) !== normalizeBrowserNavigationUrl(currentUrl);
}

export function resolveBrowserLocalServerSettings(
  preferences: BrowserLocalServerPreferences | null | undefined,
): BrowserLocalServerSettings {
  const resolved = preferences ?? DEFAULT_BROWSER_LOCAL_SERVER_PREFERENCES;
  return {
    showMode: resolved.showMode,
    sortMode: resolved.sortMode,
    expandedProjectIds: new Set(resolved.expandedProjectIds),
  };
}

export function resolveVisibleLocalServers(
  snapshot: BrowserSidebarLocalServersSnapshot | null,
  settings: BrowserLocalServerSettings,
): BrowserVisibleLocalServers {
  const servers = snapshot?.servers ?? [];
  const hiddenServers = sortLocalServers(
    servers.filter((server) => server.hidden),
    settings.sortMode,
  );
  const candidates =
    settings.showMode === "hidden"
      ? hiddenServers
      : servers.filter((server) => {
          if (server.hidden) return false;
          if (settings.showMode === "online") return server.online;
          return true;
        });
  const sorted = sortLocalServers(candidates, settings.sortMode);
  const expanded = snapshot ? settings.expandedProjectIds.has(snapshot.projectId) : false;
  return {
    servers: expanded ? sorted : sorted.slice(0, VISIBLE_LOCAL_SERVER_LIMIT),
    hiddenServers,
    hasMore: !expanded && sorted.length > VISIBLE_LOCAL_SERVER_LIMIT,
  };
}

export function stepBrowserZoomPercent(current: number, delta: number): number {
  const clamped = clampBrowserZoomPercent(current);
  if (delta === 0) return clamped;
  if (delta > 0) {
    return (
      BROWSER_SIDEBAR_ZOOM_OPTIONS.find((option) => option > clamped) ??
      BROWSER_SIDEBAR_ZOOM_OPTIONS.at(-1) ??
      clamped
    );
  }
  return (
    [...BROWSER_SIDEBAR_ZOOM_OPTIONS].reverse().find((option) => option < clamped) ??
    BROWSER_SIDEBAR_ZOOM_OPTIONS[0] ??
    clamped
  );
}

export function clampBrowserZoomPercent(value: number): number {
  if (!Number.isFinite(value)) return 100;
  return Math.min(500, Math.max(25, Math.round(value)));
}

export function resolveBrowserZoomOptions(current: number): number[] {
  const clamped = clampBrowserZoomPercent(current);
  if (BROWSER_SIDEBAR_ZOOM_OPTIONS.some((option) => option === clamped))
    return [...BROWSER_SIDEBAR_ZOOM_OPTIONS];
  return [...BROWSER_SIDEBAR_ZOOM_OPTIONS, clamped].sort((a, b) => a - b);
}

export function rotateBrowserViewport(viewport: BrowserSidebarViewport): BrowserSidebarViewport {
  return {
    ...viewport,
    width: Math.max(160, viewport.height),
    height: Math.max(240, viewport.width),
    presetId: "responsive",
  };
}

export function updateBrowserViewportDimension(
  viewport: BrowserSidebarViewport,
  dimension: "width" | "height",
  value: number,
): BrowserSidebarViewport {
  const minimum = dimension === "width" ? 240 : 160;
  return {
    ...viewport,
    [dimension]: Math.max(minimum, Math.round(value)),
    presetId: "responsive",
  };
}

function sortLocalServers(
  servers: BrowserSidebarLocalServer[],
  sortMode: BrowserLocalServerSortMode,
): BrowserSidebarLocalServer[] {
  const next = [...servers];
  if (sortMode === "origin") return next.sort((a, b) => a.origin.localeCompare(b.origin));
  return next.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}
