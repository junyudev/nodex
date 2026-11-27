/**
 * A one-shot request to open a Page at one of its Discussions, made by surfaces outside the Page
 * (such as the Inbox) just before they open it. The Page's Discussions owner takes it once the
 * Discussion has loaded.
 */
const pending = new Map<string, string>();
const listeners = new Set<() => void>();

export function requestDiscussionReveal(pageId: string, discussionId: string): void {
  pending.set(pageId, discussionId);
  for (const listener of listeners) listener();
}

/** The Discussion to reveal on this Page, if one was requested and is now present. */
export function takeDiscussionReveal(
  pageId: string,
  isPresent: (discussionId: string) => boolean,
): string | null {
  const discussionId = pending.get(pageId);
  if (!discussionId || !isPresent(discussionId)) return null;
  pending.delete(pageId);
  return discussionId;
}

export function subscribeDiscussionReveal(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
