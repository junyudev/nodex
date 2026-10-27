/**
 * One-shot requests to focus a Page's title the next time its Page surface opens. Creating
 * a Page records one and the opened surface consumes it, so a Page is named right after it
 * is made while reopening an existing Page, whatever its title, never moves focus.
 */
const pendingPageIds = new Set<string>();

export function requestPageTitleFocus(pageId: string): void {
  pendingPageIds.add(pageId);
}

export function consumePageTitleFocus(pageId: string): boolean {
  return pendingPageIds.delete(pageId);
}
