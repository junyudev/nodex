import { useSyncExternalStore } from "react";
import { inboxScopeKey, type InboxScope } from "../../shared/inbox";

/** An Inbox's two views: what still needs the reader, and what was handled or done. */
export type InboxView = "inbox" | "activity";

/** Opens a message where it is: waiting in the Inbox, or handled in Activity. */
interface InboxEntryOpen {
  readonly pageId: string;
  readonly scope: InboxScope;
  readonly view: InboxView;
}
let pending: InboxEntryOpen | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const requestInboxEntryOpen = (request: InboxEntryOpen) => {
  pending = request;
  for (const listener of listeners) listener();
};
export const consumeInboxEntryOpen = (request: InboxEntryOpen) => {
  if (pending !== request) return;
  pending = null;
  for (const listener of listeners) listener();
};
/** Window-local presentation intent survives navigation until its Inbox mounts. */
export const useInboxEntryOpen = (scope: InboxScope) =>
  useSyncExternalStore(subscribe, () =>
    pending && inboxScopeKey(pending.scope) === inboxScopeKey(scope) ? pending : null,
  );
