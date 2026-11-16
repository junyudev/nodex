import { getIntl } from "@/lib/i18n";
import type { BrowserSidebarFindState } from "../../../shared/browser-sidebar";

export const CONTENT_SEARCH_INPUT_ID = "content-search-input";
export const CONTENT_SEARCH_DEBOUNCE_MS = 150;
export const CONTENT_SEARCH_LOCAL_MATCH_LIMIT = 250;

export type ContentSearchDomain = "conversation" | "diff" | "browser";
export type ContentSearchLocalDomain = Exclude<ContentSearchDomain, "browser">;
export type ContentSearchOpenSource = "keyboard_shortcut" | "menu" | "command_palette";

export interface ContentSearchOpenRequest {
  tick: number;
  source: ContentSearchOpenSource;
  preferredDomain?: ContentSearchDomain;
}

export interface ContentSearchLocalMatch {
  id: string;
  domain: ContentSearchLocalDomain;
  contextId: string;
  ordinal: number;
  label?: string;
  meta?: unknown;
}

export interface ContentSearchLocalResult {
  query: string;
  matches: ContentSearchLocalMatch[];
  totalMatches: number;
  capped: boolean;
}

export interface ContentSearchLabelInput {
  domain: ContentSearchDomain;
  query: string;
  loading: boolean;
  activeIndex: number;
  localResult?: ContentSearchLocalResult | null;
  browserFindState?: BrowserSidebarFindState | null;
}

export function normalizeContentSearchQuery(query: string): string {
  return query.trim();
}

export function readSingleLineSelectionText(text: string | null | undefined): string | null {
  const normalized = (text ?? "").trim();
  if (!normalized) return null;
  if (/[\r\n]/.test(normalized)) return null;
  return normalized;
}

export function cycleContentSearchDomain(
  current: ContentSearchDomain,
  hasBrowserTarget: boolean,
): ContentSearchDomain {
  if (current === "conversation") return "diff";
  if (current === "diff") return hasBrowserTarget ? "browser" : "conversation";
  return "conversation";
}

export function resolveContentSearchDomain(
  preferredDomain: ContentSearchDomain | undefined,
  currentDomain: ContentSearchDomain,
  hasBrowserTarget: boolean,
): ContentSearchDomain {
  if (preferredDomain === "browser" && hasBrowserTarget) return "browser";
  if (preferredDomain === "browser")
    return currentDomain === "browser" ? "conversation" : currentDomain;
  if (preferredDomain) return preferredDomain;
  return currentDomain;
}

export function buildContentSearchResultLabel(
  input: ContentSearchLabelInput,
  intl = getIntl(),
): string {
  const query = normalizeContentSearchQuery(input.query);
  if (!query) return "";
  if (input.loading)
    return intl.formatMessage({
      id: "contentSearch.contentSearchModel.searching",
      defaultMessage: "Searching…",
    });

  if (input.domain === "browser") {
    const matchCount = input.browserFindState?.matchCount ?? 0;
    if (matchCount <= 0)
      return intl.formatMessage({
        id: "contentSearch.contentSearchModel.noResults",
        defaultMessage: "No results",
      });
    const activeOrdinal = input.browserFindState?.activeMatchOrdinal ?? 1;
    return intl.formatMessage(
      {
        id: "contentSearch.contentSearchModel.results",
        defaultMessage: "{active} / {total} results",
      },
      { active: activeOrdinal, total: intl.formatNumber(matchCount, { useGrouping: false }) },
    );
  }

  const totalMatches = input.localResult?.totalMatches ?? 0;
  if (totalMatches <= 0)
    return intl.formatMessage({
      id: "contentSearch.contentSearchModel.noResults",
      defaultMessage: "No results",
    });
  const activeOrdinal = Math.min(input.activeIndex + 1, totalMatches);
  const total = intl.formatNumber(totalMatches, { useGrouping: false });
  const totalLabel = input.localResult?.capped ? `${total}+` : total;
  return intl.formatMessage(
    {
      id: "contentSearch.contentSearchModel.results",
      defaultMessage: "{active} / {total} results",
    },
    { active: activeOrdinal, total: totalLabel },
  );
}

export function canNavigateContentSearchMatches(input: ContentSearchLabelInput): boolean {
  if (input.loading || !normalizeContentSearchQuery(input.query)) return false;
  if (input.domain === "browser") return (input.browserFindState?.matchCount ?? 0) > 0;
  return (input.localResult?.matches.length ?? 0) > 0;
}
