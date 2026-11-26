import { useSyncExternalStore } from "react";
import type { InboxRowEdit } from "./inbox-presentation";

/**
 * What the reader changed on a suggestion before deciding it: dropped additions or skills, or the
 * model it runs on. A suggestion shows wherever its message does, in the Inbox and on its Page,
 * often side by side, so the change belongs to the suggestion in this window rather than to one
 * of its views.
 */
const edits = new Map<string, InboxRowEdit>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

type InboxRowEditUpdate = (current: InboxRowEdit | null) => InboxRowEdit | null;

const update = (proposalId: string, next: InboxRowEditUpdate) => {
  const value = next(edits.get(proposalId) ?? null);
  if (value) edits.set(proposalId, value);
  else edits.delete(proposalId);
  for (const listener of listeners) listener();
};

/** The reader's change to one suggestion, shared by every view of it in the window. */
export function useInboxRowEdit(
  proposalId: string | null,
): readonly [InboxRowEdit | null, (next: InboxRowEditUpdate) => void] {
  const edit = useSyncExternalStore(subscribe, () =>
    proposalId ? (edits.get(proposalId) ?? null) : null,
  );
  return [
    edit,
    (next) => {
      if (proposalId) update(proposalId, next);
    },
  ];
}
