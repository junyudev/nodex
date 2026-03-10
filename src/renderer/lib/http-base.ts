const DEFAULT_HTTP_BASE = "http://localhost:51283";
const HTTP_PROTOCOLS = new Set(["http:", "https:"]);
const LOCALHOST_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);
const RENDERER_DEV_PORT = "51284";

type LocationLike = {
  origin?: string;
  protocol?: string;
};

type ApiBridgeLike = {
  serverUrl?: string;
};

type WindowLike = {
  api?: ApiBridgeLike;
  location?: LocationLike;
};

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeBase(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimTrailingSlashes(trimmed);
}

function shouldUseDevDefaultForBrowser(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return LOCALHOST_HOSTNAMES.has(parsed.hostname) && parsed.port === RENDERER_DEV_PORT;
  } catch {
    return false;
  }
}

export function resolveHttpBase(windowLike?: WindowLike): string {
  const runtimeWindow = windowLike ?? (typeof window !== "undefined" ? (window as WindowLike) : undefined);
  if (!runtimeWindow) return DEFAULT_HTTP_BASE;

  const bridgeBase = normalizeBase(runtimeWindow.api?.serverUrl ?? "");
  if (bridgeBase) return bridgeBase;

  // In Electron, renderer origin can be Vite dev server or file:// and is not the API origin.
  if (runtimeWindow.api) return DEFAULT_HTTP_BASE;

  const protocol = runtimeWindow.location?.protocol;
  const origin = runtimeWindow.location?.origin;
  if (
    typeof origin === "string" &&
    origin !== "null" &&
    typeof protocol === "string" &&
    HTTP_PROTOCOLS.has(protocol)
  ) {
    if (shouldUseDevDefaultForBrowser(origin)) return DEFAULT_HTTP_BASE;

    const normalizedOrigin = normalizeBase(origin);
    if (normalizedOrigin) return normalizedOrigin;
  }

  return DEFAULT_HTTP_BASE;
}

export function toApiUrl(pathname: string, windowLike?: WindowLike): string {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${resolveHttpBase(windowLike)}${normalizedPath}`;
}
