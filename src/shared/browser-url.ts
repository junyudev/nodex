import { defineMessages } from "./i18n/messages";

export const BROWSER_TAB_FALLBACK_MESSAGES = defineMessages({
  newTab: { id: "shared.browserUrl.newTab", defaultMessage: "New tab" },
  browser: { id: "shared.browserUrl.browser", defaultMessage: "Browser" },
});

export function browserTabFallbackMessage(
  url: string | null | undefined,
  title: string | null | undefined,
) {
  if (isBlankBrowserUrl(url)) return BROWSER_TAB_FALLBACK_MESSAGES.newTab;
  return title?.trim() ? null : BROWSER_TAB_FALLBACK_MESSAGES.browser;
}

export function isBlankBrowserUrl(url: string | null | undefined): boolean {
  const value = url?.trim();
  return !value || value === "about:blank";
}

/** A blank Browser tab is a New tab; a page without a title yet reads as Browser. */
export const BROWSER_NEW_TAB_TITLE = "New tab";

export function resolveBrowserTabTitle(
  url: string | null | undefined,
  title: string | null | undefined,
): string {
  if (isBlankBrowserUrl(url)) return BROWSER_NEW_TAB_TITLE;
  return title?.trim() || "Browser";
}

/**
 * A Browser tab's label. A live page names its own tab, also while the tab is in the
 * background and no panel is mounted to store that title; a tab without a live page keeps the
 * title it stored.
 */
export function resolveLiveBrowserTabTitle(
  page: { readonly url: string; readonly title: string } | undefined,
  storedTitle: string,
): string {
  return page ? resolveBrowserTabTitle(page.url, page.title) : storedTitle;
}
