type BrowserUsePipBackend = "cdp" | "chrome" | "iab";

export interface BrowserUsePipSurface {
  readonly backend: BrowserUsePipBackend;
  readonly browserFamily?: string;
  readonly browserId: string;
  readonly extensionInstanceId?: string;
  readonly openTabIds?: readonly string[];
  readonly screenshot?: {
    readonly tabId: string;
    readonly url: string;
  };
  readonly sessionEnded?: true;
}

export type DesktopToolActivity =
  | { readonly kind: "browser-use"; readonly surface: BrowserUsePipSurface }
  | { readonly kind: "computer-use"; readonly active: boolean; readonly itemId: string };

const MAX_BROWSER_PIP_IDENTIFIER_LENGTH = 1_024;
const MAX_BROWSER_PIP_SCREENSHOT_WIRE_LENGTH = 32 * 1024 * 1024;
const MAX_BROWSER_PIP_OPEN_TAB_IDS = 256;

export function asDesktopRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

export function parseDesktopIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = value.trim();
  if (
    parsed.length === 0 ||
    parsed.length > MAX_BROWSER_PIP_IDENTIFIER_LENGTH ||
    parsed.includes("\0")
  ) {
    return null;
  }
  return parsed;
}

/**
 * Decodes only bounded Browser surface metadata. Raster bytes are validated in Main after source admission.
 */
function parseBrowserUsePipSurface(value: unknown): BrowserUsePipSurface | null {
  const surface = asDesktopRecord(value);
  if (!surface || surface.kind !== "browserUse") return null;
  if (surface.backend !== "cdp" && surface.backend !== "chrome" && surface.backend !== "iab") {
    return null;
  }
  const browserId = parseDesktopIdentifier(surface.browserId);
  if (!browserId) return null;

  const browserFamily =
    surface.browserFamily === undefined ? undefined : parseDesktopIdentifier(surface.browserFamily);
  if (surface.browserFamily !== undefined && browserFamily === null) return null;
  const extensionInstanceId =
    surface.extensionInstanceId === undefined
      ? undefined
      : parseDesktopIdentifier(surface.extensionInstanceId);
  if (surface.extensionInstanceId !== undefined && extensionInstanceId === null) return null;
  if (surface.backend === "chrome" && (!browserFamily || !extensionInstanceId)) return null;
  if (surface.backend !== "chrome" && extensionInstanceId !== undefined) return null;

  let openTabIds: string[] | undefined;
  if (surface.openTabIds !== undefined) {
    if (
      !Array.isArray(surface.openTabIds) ||
      surface.openTabIds.length > MAX_BROWSER_PIP_OPEN_TAB_IDS
    ) {
      return null;
    }
    const parsed = surface.openTabIds.map(parseDesktopIdentifier);
    if (parsed.some((entry) => entry === null)) return null;
    openTabIds = parsed as string[];
    if (new Set(openTabIds).size !== openTabIds.length) return null;
  }

  let screenshot: BrowserUsePipSurface["screenshot"];
  if (surface.screenshot !== undefined) {
    const value = asDesktopRecord(surface.screenshot);
    const tabId = parseDesktopIdentifier(value?.tabId);
    const url = value?.url;
    if (
      !tabId ||
      typeof url !== "string" ||
      !url.startsWith("data:image/") ||
      url.length > MAX_BROWSER_PIP_SCREENSHOT_WIRE_LENGTH
    ) {
      return null;
    }
    screenshot = { tabId, url };
  }

  if (surface.sessionEnded !== undefined && surface.sessionEnded !== true) return null;
  return {
    backend: surface.backend,
    browserId,
    ...(browserFamily ? { browserFamily } : {}),
    ...(extensionInstanceId ? { extensionInstanceId } : {}),
    ...(openTabIds ? { openTabIds } : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(surface.sessionEnded === true ? { sessionEnded: true } : {}),
  };
}

/** Only metadata supplied by the local REPL result can describe a desktop surface. */
export function desktopToolResultActivity(
  itemId: unknown,
  result: unknown,
): DesktopToolActivity | null {
  const metadata = asDesktopRecord(asDesktopRecord(result)?._meta);
  const surface = metadata?.["codex/toolSurface"];
  if (asDesktopRecord(surface)?.kind === "computerUse") {
    const id = parseDesktopIdentifier(itemId);
    return id ? { kind: "computer-use", active: true, itemId: id } : null;
  }
  const browser = parseBrowserUsePipSurface(surface);
  return browser ? { kind: "browser-use", surface: browser } : null;
}

export function codexDesktopToolItemActivity(
  item: unknown,
  started: boolean,
): DesktopToolActivity | null {
  const call = asDesktopRecord(item);
  if (call?.type !== "mcpToolCall") return null;
  if (call.server === "computer-use") {
    const itemId = parseDesktopIdentifier(call.id);
    return itemId ? { kind: "computer-use", active: started, itemId } : null;
  }
  return !started && call.server === "node_repl"
    ? desktopToolResultActivity(call.id, call.result)
    : null;
}

/** Decode a host-bridge report using the same surface bounds as native Codex. */
export function parseDesktopToolActivity(value: unknown): DesktopToolActivity | null {
  const activity = asDesktopRecord(value);
  if (activity?.kind === "browser-use") {
    const surface = parseBrowserUsePipSurface({
      ...asDesktopRecord(activity.surface),
      kind: "browserUse",
    });
    return surface ? { kind: "browser-use", surface } : null;
  }
  if (activity?.kind !== "computer-use" || typeof activity.active !== "boolean") return null;
  const itemId = parseDesktopIdentifier(activity.itemId);
  return itemId ? { kind: "computer-use", active: activity.active, itemId } : null;
}
