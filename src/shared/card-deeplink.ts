export const NODEX_DEEPLINK_PROTOCOL = "nodex:";
export const NODEX_CARD_DEEPLINK_KIND = "card";

export interface CardDeepLinkTarget {
  cardId: string;
}

function normalizeCardId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function decodePathSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function buildCardDeepLink(target: CardDeepLinkTarget): string {
  return `nodex://card/${encodeURIComponent(target.cardId)}`;
}

export function parseCardDeepLink(value: string): CardDeepLinkTarget | null {
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
  const pathSegments = url.pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  const cardId = host === NODEX_CARD_DEEPLINK_KIND
    ? normalizeCardId(decodePathSegment(pathSegments[0] ?? "") ?? "")
    : host.length === 0 && pathSegments[0]?.toLowerCase() === NODEX_CARD_DEEPLINK_KIND
      ? normalizeCardId(decodePathSegment(pathSegments[1] ?? "") ?? "")
      : null;

  if (!cardId) {
    return null;
  }

  return { cardId };
}
