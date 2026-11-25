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
  blockId?: string;
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
  readonly projectId: string | null;
} & NodexDeepLinkTarget;

export type QualifiedSpaceDeepLink = ResolvedSpaceDeepLink & { readonly spaceId: string };

export type DeepLinkOpenEvents = {
  [Target in QualifiedSpaceDeepLink as `deeplink:open-${Target["kind"]}`]: Omit<Target, "kind">;
};

export function isDeepLinkOpenChannel(channel: string): channel is keyof DeepLinkOpenEvents {
  return (
    channel === "deeplink:open-page" ||
    channel === "deeplink:open-session" ||
    channel === "deeplink:open-view"
  );
}

export function isDeepLinkOpenPayload<Channel extends keyof DeepLinkOpenEvents>(
  channel: Channel,
  value: unknown,
): value is DeepLinkOpenEvents[Channel] {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  if (typeof payload.spaceId !== "string" || !normalizeDeepLinkId(payload.spaceId)) return false;
  if (typeof payload.projectId !== "string" && payload.projectId !== null) return false;

  switch (channel) {
    case "deeplink:open-page":
      return (
        typeof payload.pageId === "string" &&
        !!normalizeDeepLinkId(payload.pageId) &&
        (payload.blockId === undefined ||
          (typeof payload.blockId === "string" && !!normalizeDeepLinkId(payload.blockId)))
      );
    case "deeplink:open-session":
      return typeof payload.sessionId === "string" && !!normalizeDeepLinkId(payload.sessionId);
    case "deeplink:open-view":
      return typeof payload.viewId === "string" && !!normalizeDeepLinkId(payload.viewId);
  }
}

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

function decodeDeepLinkId(value: string): string | null {
  try {
    return normalizeDeepLinkId(decodeURIComponent(value));
  } catch {
    return null;
  }
}

export function buildPageDeepLink(target: PageDeepLinkTarget): string {
  const fragment = target.blockId === undefined ? "" : `#${encodeDeepLinkId(target.blockId)}`;
  return `${NODEX_PAGE_DEEPLINK_PREFIX}${encodeDeepLinkId(target.pageId)}${spaceSuffix(target)}${fragment}`;
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

function parseDeepLinkTarget(
  value: string,
  kind: string,
): { url: URL; id: string; space: SpaceDeepLinkTarget } | null {
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

  const id =
    host === kind && pathSegments.length === 2
      ? decodeDeepLinkId(pathSegments[1] ?? "")
      : host.length === 0 && pathSegments.length === 3 && pathSegments[1]?.toLowerCase() === kind
        ? decodeDeepLinkId(pathSegments[2] ?? "")
        : null;
  if (!id) return null;
  const space = parseSpace(url);
  return space ? { url, id, space } : null;
}

function parseSpace(url: URL): SpaceDeepLinkTarget | null {
  const ids = url.searchParams.getAll("spaceId");
  if (!ids.length) return {};
  if (ids.length !== 1 || !normalizeDeepLinkId(ids[0]!)) return null;
  return { spaceId: ids[0]! };
}

export function parsePageDeepLink(value: string): PageDeepLinkTarget | null {
  const target = parseDeepLinkTarget(value, NODEX_PAGE_DEEPLINK_KIND);
  if (!target) return null;
  const { url, id: pageId, space } = target;
  if (!url.hash) return url.href.endsWith("#") ? null : { ...space, pageId };
  const blockId = decodeDeepLinkId(url.hash.slice(1));
  return blockId ? { ...space, pageId, blockId } : null;
}

export function parseSessionDeepLink(value: string): SessionDeepLinkTarget | null {
  const target = parseDeepLinkTarget(value, NODEX_SESSION_DEEPLINK_KIND);
  return target ? { ...target.space, sessionId: target.id } : null;
}

export function parseViewDeepLink(value: string): ViewDeepLinkTarget | null {
  const target = parseDeepLinkTarget(value, NODEX_VIEW_DEEPLINK_KIND);
  return target ? { ...target.space, viewId: target.id } : null;
}
