export const NODEX_DEEPLINK_PROTOCOL = "nodex:";
export const NODEX_PAGE_DEEPLINK_KIND = "pages";
export const NODEX_SESSION_DEEPLINK_KIND = "sessions";
export const NODEX_VIEW_DEEPLINK_KIND = "views";

const NODEX_PAGE_DEEPLINK_PREFIX = `${NODEX_DEEPLINK_PROTOCOL}//${NODEX_PAGE_DEEPLINK_KIND}/`;
const NODEX_SESSION_DEEPLINK_PREFIX = `${NODEX_DEEPLINK_PROTOCOL}//${NODEX_SESSION_DEEPLINK_KIND}/`;
const NODEX_VIEW_DEEPLINK_PREFIX = `${NODEX_DEEPLINK_PROTOCOL}//${NODEX_VIEW_DEEPLINK_KIND}/`;

export interface SpaceDeepLinkTarget {
  readonly spaceId?: string;
}

export interface PageDeepLinkTarget extends SpaceDeepLinkTarget {
  pageId: string;
}

export interface SessionDeepLinkTarget extends SpaceDeepLinkTarget {
  sessionId: string;
}

export interface ViewDeepLinkTarget extends SpaceDeepLinkTarget {
  viewId: string;
}

export type NodexDeepLinkTarget =
  | (PageDeepLinkTarget & { readonly kind: "page" })
  | (SessionDeepLinkTarget & { readonly kind: "session" })
  | (ViewDeepLinkTarget & { readonly kind: "view" });

export type ResolvedSpaceDeepLink = {
  readonly spaceId?: string;
  readonly projectId: string | null;
} & NodexDeepLinkTarget;

const spaceSuffix = (target: SpaceDeepLinkTarget): string =>
  target.spaceId === undefined ? "" : `?spaceId=${encodeDeepLinkId(target.spaceId)}`;

function normalizeDeepLinkId(value: string): string | null {
  const normalized = value.trim();
  return normalized === value &&
    normalized.length > 0 &&
    new TextEncoder().encode(normalized).length <= 512
    ? normalized
    : null;
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function buildPageDeepLink(target: PageDeepLinkTarget): string {
  return `${NODEX_PAGE_DEEPLINK_PREFIX}${encodeDeepLinkId(target.pageId)}${spaceSuffix(target)}`;
}

export function buildSessionDeepLink(target: SessionDeepLinkTarget): string {
  return `${NODEX_SESSION_DEEPLINK_PREFIX}${encodeDeepLinkId(target.sessionId)}${spaceSuffix(target)}`;
}

export function buildViewDeepLink(target: ViewDeepLinkTarget): string {
  return `${NODEX_VIEW_DEEPLINK_PREFIX}${encodeDeepLinkId(target.viewId)}${spaceSuffix(target)}`;
}

function encodeDeepLinkId(value: string): string {
  const normalized = normalizeDeepLinkId(value);
  if (!normalized || normalized !== value) {
    throw new TypeError("Nodex deep-link IDs must be non-empty, bounded, and already trimmed");
  }
  return encodeURIComponent(normalized);
}

function parseDeepLinkId(value: string, kind: string): string | null {
  if (
    value.trim() !== value ||
    value.slice(0, 8).toLowerCase() !== `${NODEX_DEEPLINK_PROTOCOL}//`
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== NODEX_DEEPLINK_PROTOCOL) {
    return null;
  }

  const host = url.hostname.trim().toLowerCase();
  const pathSegments = url.pathname.split("/");

  const encodedId =
    host === kind && pathSegments.length === 2
      ? normalizeDeepLinkId(decodePathSegment(pathSegments[1] ?? "") ?? "")
      : host.length === 0 && pathSegments.length === 3 && pathSegments[1]?.toLowerCase() === kind
        ? normalizeDeepLinkId(decodePathSegment(pathSegments[2] ?? "") ?? "")
        : null;

  return encodedId;
}

function parseSpace(value: string): SpaceDeepLinkTarget | null {
  const url = new URL(value);
  const ids = url.searchParams.getAll("spaceId");
  if (!ids.length) return {};
  if (ids.length !== 1 || !normalizeDeepLinkId(ids[0]!)) return null;
  return { spaceId: ids[0]! };
}

export function parsePageDeepLink(value: string): PageDeepLinkTarget | null {
  const pageId = parseDeepLinkId(value, NODEX_PAGE_DEEPLINK_KIND);
  const space = pageId ? parseSpace(value) : null;
  return pageId && space ? { ...space, pageId } : null;
}

export function parseSessionDeepLink(value: string): SessionDeepLinkTarget | null {
  const sessionId = parseDeepLinkId(value, NODEX_SESSION_DEEPLINK_KIND);
  const space = sessionId ? parseSpace(value) : null;
  return sessionId && space ? { ...space, sessionId } : null;
}

export function parseViewDeepLink(value: string): ViewDeepLinkTarget | null {
  const viewId = parseDeepLinkId(value, NODEX_VIEW_DEEPLINK_KIND);
  const space = viewId ? parseSpace(value) : null;
  return viewId && space ? { ...space, viewId } : null;
}
