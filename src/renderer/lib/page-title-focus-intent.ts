import { useEffect, useState } from "react";

/**
 * One-shot requests to focus a Page's title the next time its Page surface opens. Creating
 * a Page records one and the opened surface claims it after committing, so discarded renders
 * or lazy-surface retries never burn the intent while reopening an existing Page never moves focus.
 */
const pendingPageIds = new Set<string>();

export function requestPageTitleFocus(pageId: string): void {
  pendingPageIds.add(pageId);
}

export function hasPendingPageTitleFocus(pageId: string): boolean {
  return pendingPageIds.has(pageId);
}

export function consumePageTitleFocus(pageId: string): boolean {
  return pendingPageIds.delete(pageId);
}

/**
 * Claims a pending title-focus intent once this surface has committed and its Page content is
 * ready, keeping the `useState` initializer pure under Suspense, StrictMode, and concurrent renders.
 */
export function useConsumePageTitleFocus(pageId: string, ready = true): boolean {
  const [focusTitle] = useState(() => hasPendingPageTitleFocus(pageId));
  useEffect(() => {
    if (!focusTitle || !ready) return;
    consumePageTitleFocus(pageId);
  }, [focusTitle, pageId, ready]);
  return focusTitle;
}
