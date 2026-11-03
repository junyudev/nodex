/**
 * Side chats are Session panel tabs, never Scenes of their own. These identities let Main name the
 * exact tab a notification reopens inside the source Session.
 */

const NATIVE_SIDE_CHAT_TAB_PREFIX = "sidechat:";
const RUNTIME_SIDE_CHAT_TAB_PREFIX = "sidechat-session:";

/** A native side chat is a temporary Thread forked from its parent conversation. */
export const nativeSideChatTabId = (threadId: string) =>
  `${NATIVE_SIDE_CHAT_TAB_PREFIX}${threadId}`;

/** A Runtime side chat is a temporary product Session bound to its source Session's context. */
export const runtimeSideChatTabId = (sessionId: string) =>
  `${RUNTIME_SIDE_CHAT_TAB_PREFIX}${sessionId}`;

/** The temporary Session a Runtime side-chat tab presents, if the tab is one. */
export function runtimeSideChatSessionIdFromTabId(tabId: string | null | undefined): string | null {
  if (!tabId?.startsWith(RUNTIME_SIDE_CHAT_TAB_PREFIX)) return null;
  const sessionId = tabId.slice(RUNTIME_SIDE_CHAT_TAB_PREFIX.length).trim();
  return sessionId.length > 0 ? sessionId : null;
}
