export interface CodexWebSearchCompletionView {
  webSearch?: {
    completed: boolean;
  } | null;
}

/**
 * Reads the semantic completion bit projected from app-server lifecycle state.
 * Web-search protocol items do not carry a canonical top-level status.
 */
export function isCodexWebSearchActivityInProgress(item: CodexWebSearchCompletionView): boolean {
  return item.webSearch?.completed === false;
}

/** A web page an Agent's search returned, safe to link to. */
export interface WebSource {
  /** Normalized `http(s)` address without credentials. */
  url: string;
  /** The page title reported by the search, when there is one. */
  title: string | null;
  /** Host and path, shown when there is no title. */
  label: string;
}

function trimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Accepts only plain `http(s)` addresses without embedded credentials. */
export function toWebSource(input: { url: unknown; title?: unknown }): WebSource | null {
  const rawUrl = trimmedString(input.url);
  if (rawUrl == null) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return {
    url: url.href,
    title: trimmedString(input.title),
    label: `${url.host.replace(/^www\./u, "")}${url.pathname}`,
  };
}

/**
 * Reads the pages a web search returned. Provider results stay opaque at the protocol boundary;
 * an entry counts as a search hit when it is a typed text result, or an untyped result that names
 * its page. Page previews (an address and excerpt without a title) are not search hits.
 */
export function readWebSearchSources(results: unknown): WebSource[] {
  if (!Array.isArray(results)) return [];
  const sources = new Map<string, WebSource>();
  for (const result of results) {
    if (typeof result !== "object" || result === null || Array.isArray(result)) continue;
    const record = result as Record<string, unknown>;
    const type = record.type;
    const isSearchHit =
      type === "text_result" || (type === undefined && trimmedString(record.title) != null);
    if (!isSearchHit) continue;
    const source = toWebSource({ url: record.url, title: record.title });
    if (source != null && !sources.has(source.url)) sources.set(source.url, source);
  }
  return [...sources.values()];
}
