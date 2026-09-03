export type BrowserUsePipBackend = "cdp" | "chrome" | "iab";

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

export type RemoteHostedPipNotification =
  | {
      readonly kind: "browser-use";
      readonly surface: BrowserUsePipSurface;
      readonly threadId: string;
    }
  | {
      readonly kind: "computer-use";
      readonly active: boolean;
      readonly itemId: string;
      readonly threadId: string;
    }
  | { readonly kind: "thread-ended"; readonly deleted: boolean; readonly threadId: string }
  | {
      readonly kind: "turn-ended";
      readonly completed: boolean;
      readonly threadId: string;
      readonly turnId: string;
    };

export const MAX_BROWSER_PIP_IDENTIFIER_LENGTH = 1_024;
export const MAX_BROWSER_PIP_SCREENSHOT_WIRE_LENGTH = 32 * 1024 * 1024;
export const MAX_BROWSER_PIP_OPEN_TAB_IDS = 256;

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function parseIdentifier(value: unknown): string | null {
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
 * Decodes only bounded Browser surface metadata. Raster bytes are validated after physical-host
 * and durable-backend admission so remote or ACP-owned payloads never allocate image buffers.
 */
export function parseBrowserUsePipSurface(value: unknown): BrowserUsePipSurface | null {
  const surface = asRecord(value);
  if (!surface || surface.kind !== "browserUse") return null;
  if (surface.backend !== "cdp" && surface.backend !== "chrome" && surface.backend !== "iab") {
    return null;
  }
  const browserId = parseIdentifier(surface.browserId);
  if (!browserId) return null;

  const browserFamily =
    surface.browserFamily === undefined ? undefined : parseIdentifier(surface.browserFamily);
  if (surface.browserFamily !== undefined && browserFamily === null) return null;
  const extensionInstanceId =
    surface.extensionInstanceId === undefined
      ? undefined
      : parseIdentifier(surface.extensionInstanceId);
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
    const parsed = surface.openTabIds.map(parseIdentifier);
    if (parsed.some((entry) => entry === null)) return null;
    openTabIds = parsed as string[];
    if (new Set(openTabIds).size !== openTabIds.length) return null;
  }

  let screenshot: BrowserUsePipSurface["screenshot"];
  if (surface.screenshot !== undefined) {
    const value = asRecord(surface.screenshot);
    const tabId = parseIdentifier(value?.tabId);
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

function isComputerUseItem(item: Readonly<Record<string, unknown>>): boolean {
  if (item.server === "computer-use") return true;
  if (item.server !== "node_repl") return false;
  const result = asRecord(item.result);
  const metadata = asRecord(result?._meta);
  return asRecord(metadata?.["codex/toolSurface"])?.kind === "computerUse";
}

/** Derives a bounded PiP consequence from an already decoded official notification. */
export function parseRemoteHostedPipNotification(
  value: unknown,
): RemoteHostedPipNotification | null {
  const notification = asRecord(value);
  const params = asRecord(notification?.params);
  const method = notification?.method;
  const threadId = parseIdentifier(params?.threadId);
  if (!threadId || typeof method !== "string") return null;

  if (method === "thread/archived" || method === "thread/closed" || method === "thread/deleted") {
    return { deleted: method === "thread/deleted", kind: "thread-ended", threadId };
  }

  if (method === "turn/completed") {
    const turn = asRecord(params?.turn);
    const turnId = parseIdentifier(turn?.id);
    if (!turnId) return null;
    return {
      completed: turn?.status === "completed",
      kind: "turn-ended",
      threadId,
      turnId,
    };
  }

  if (method !== "item/started" && method !== "item/completed") return null;
  const item = asRecord(params?.item);
  if (item?.type !== "mcpToolCall") return null;
  if (isComputerUseItem(item)) {
    const itemId = parseIdentifier(item.id);
    if (!itemId) return null;
    return {
      active: method === "item/started" || item.server === "node_repl",
      itemId,
      kind: "computer-use",
      threadId,
    };
  }
  if (method !== "item/completed" || item.server !== "node_repl") return null;
  const result = asRecord(item.result);
  const metadata = asRecord(result?._meta);
  const surface = parseBrowserUsePipSurface(metadata?.["codex/toolSurface"]);
  return surface ? { kind: "browser-use", surface, threadId } : null;
}
