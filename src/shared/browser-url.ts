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
