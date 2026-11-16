import { getIntl } from "@/lib/i18n";
interface WebSearchActionSnapshot {
  type: string | null;
  query: string | null;
  queries: string[];
  url: string | null;
  pattern: string | null;
}

const SITE_FILTER_PATTERN = /\bsite:([^\s]+)/giu;
const SEARCH_OR_PATTERN = /\bOR\b/gu;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null) return null;
  return value as Record<string, unknown>;
}

function getString(candidate: Record<string, unknown> | null, key: string): string | null {
  const value = candidate?.[key];
  return typeof value === "string" ? value : null;
}

function getStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value.reduce<string[]>((acc, entry) => {
    if (typeof entry !== "string") return acc;
    const trimmed = entry.trim();
    if (trimmed.length === 0) return acc;
    acc.push(trimmed);
    return acc;
  }, []);
}

function normalizeWebSearchAction(action: unknown): WebSearchActionSnapshot | null {
  const candidate = asRecord(action);
  if (!candidate) return null;

  const query = getString(candidate, "query")?.trim() ?? null;
  const url = getString(candidate, "url")?.trim() ?? null;
  const pattern = getString(candidate, "pattern")?.trim() ?? null;

  return {
    type: getString(candidate, "type"),
    query: query && query.length > 0 ? query : null,
    queries: getStringArray(candidate.queries),
    url: url && url.length > 0 ? url : null,
    pattern: pattern && pattern.length > 0 ? pattern : null,
  };
}

function normalizeSiteFilterHostname(value: string): string | null {
  try {
    return new URL(`https://${value}`).hostname.replace(/^www\./u, "");
  } catch {
    return null;
  }
}

export function formatWebSearchQueryDetail(query: string): string {
  const sites: string[] = [];
  const queryWithoutSites = query.replace(SITE_FILTER_PATTERN, (match, siteValue: string) => {
    const hostname = normalizeSiteFilterHostname(siteValue);
    if (!hostname) return match;
    if (!sites.includes(hostname)) sites.push(hostname);
    return "";
  });

  if (sites.length === 0) return query;

  const searchText = queryWithoutSites.replace(SEARCH_OR_PATTERN, " ").replace(/\s+/gu, " ").trim();

  if (searchText.length === 0) return query;
  return `${searchText} | ${sites.join(" \u00b7 ")}`;
}

export function selectPrimaryWebSearchQuery(
  query: string | null,
  queries: readonly string[],
): string {
  if (query && query.length > 0) return formatWebSearchQueryDetail(query);
  const firstQuery = queries.find((entry) => entry.length > 0) ?? "";
  return formatWebSearchQueryDetail(firstQuery);
}

export function describeWebSearchAction(action: unknown, fallbackQuery: string): string {
  const snapshot = normalizeWebSearchAction(action);
  if (!snapshot) return fallbackQuery.trim();

  if (snapshot.type === "search") {
    const selectedQuery = selectPrimaryWebSearchQuery(snapshot.query, snapshot.queries);
    if (selectedQuery.length === 0) return fallbackQuery.trim();
    return snapshot.queries.length > 1 && snapshot.query === null
      ? `${selectedQuery} ...`
      : selectedQuery;
  }

  if (snapshot.type === "openPage") return snapshot.url ?? "";

  if (snapshot.type === "findInPage") {
    if (snapshot.pattern && snapshot.url)
      return getIntl().formatMessage(
        {
          id: "conversation.webSearchDisplay.findInPage",
          defaultMessage: "''{pattern}'' in {url}",
        },
        { pattern: snapshot.pattern, url: snapshot.url },
      );
    if (snapshot.pattern) return `'${snapshot.pattern}'`;
    if (snapshot.url) return snapshot.url;
    return "";
  }

  return fallbackQuery.trim();
}
