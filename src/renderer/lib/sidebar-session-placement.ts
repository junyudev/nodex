import type { ProjectSessionPlacement } from "./types";

/**
 * Every lane sorts its chats by durable Session, whichever Agent runs them and whether or not
 * they are pinned. Rows still waiting for a Session, and rows leaving the list, stay in place.
 */
export function listSortableSidebarSessionKeys({
  threadKeys,
  getSessionId,
  excludedKeys,
}: {
  threadKeys: readonly string[];
  getSessionId: (threadKey: string) => string | null;
  excludedKeys?: ReadonlySet<string>;
}): string[] {
  return threadKeys.filter(
    (threadKey) => !excludedKeys?.has(threadKey) && getSessionId(threadKey) !== null,
  );
}

/**
 * Resolves a same-lane drop to one Session placement. The anchor is the chat now directly below
 * the moved chat, or the one directly above it when it lands last; Core applies the placement to
 * the complete lane, including chats beyond the loaded page.
 */
export function resolveSidebarSessionPlacement({
  activeThreadKey,
  nextVisibleThreadKeys,
  getSessionId,
}: {
  activeThreadKey: string;
  nextVisibleThreadKeys: readonly string[];
  getSessionId: (threadKey: string) => string | null;
}): { readonly sessionId: string; readonly placement: ProjectSessionPlacement } | null {
  const sessionId = getSessionId(activeThreadKey);
  const index = nextVisibleThreadKeys.indexOf(activeThreadKey);
  if (sessionId === null || index === -1) return null;
  const below = nextVisibleThreadKeys[index + 1];
  const belowSessionId = below === undefined ? null : getSessionId(below);
  if (belowSessionId !== null) {
    return { sessionId, placement: { kind: "before", sessionId: belowSessionId } };
  }
  const above = index > 0 ? nextVisibleThreadKeys[index - 1] : undefined;
  const aboveSessionId = above === undefined ? null : getSessionId(above);
  if (aboveSessionId !== null) {
    return { sessionId, placement: { kind: "after", sessionId: aboveSessionId } };
  }
  return null;
}
