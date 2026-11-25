import { useSyncExternalStore } from "react";
import { toast } from "@/components/ui/toast";
import { getIntl } from "@/lib/i18n";
import { acceptPageWork } from "./page-turn-runtime";

/**
 * How long an accept waits before it commits. Accepting finishes the Page, which can start the
 * work that waited on it, so Undo takes an accept back by never sending it rather than by
 * reversing it afterwards.
 */
export const ACCEPT_UNDO_WINDOW_MS = 6_000;

/** The review an accept decides: its Page and the episode the reader saw. */
export interface ReviewTurn {
  readonly page_id: string;
  readonly episode: string;
}

/** Names one review: the Page and the episode the reader saw. */
export const reviewKey = (turn: ReviewTurn) => `${turn.page_id}\u0000${turn.episode}`;

interface PendingAccept {
  readonly timer: ReturnType<typeof setTimeout>;
  readonly commit: () => void;
}

/** Accepts waiting out their Undo window. */
const waiting = new Map<string, PendingAccept>();
/** Accepts sent to Core whose result has not come back yet. */
const sending = new Set<string>();
const listeners = new Set<() => void>();
let decided: ReadonlySet<string> = new Set();
let flushesOnLeave = false;

function publish() {
  decided = new Set([...waiting.keys(), ...sending]);
  for (const listener of listeners) listener();
}

/** A window closing mid-window still sends the reader's decision. */
function flushOnLeave() {
  if (flushesOnLeave || typeof window === "undefined") return;
  flushesOnLeave = true;
  window.addEventListener("pagehide", flushPendingAccepts);
}

/**
 * Accepts a review after the Undo window, unless the returned `undo` runs first. `onSent`
 * reports Core's answer once the accept has been sent.
 */
export function scheduleAccept(
  turn: ReviewTurn,
  onSent: (result: { ok: true } | { ok: false; error: unknown }) => void = () => {},
  /**
   * Holds the accept to the episode the reader saw, so newer work is not accepted unseen. Core
   * fences only a review that asks the reader, so another Member's review is accepted unfenced.
   */
  fenced = true,
): { readonly undo: () => boolean; readonly commit: () => void } {
  const key = reviewKey(turn);
  const existing = waiting.get(key);
  if (existing || sending.has(key)) return { undo: () => false, commit: () => existing?.commit() };
  const commit = () => {
    const entry = waiting.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    waiting.delete(key);
    sending.add(key);
    publish();
    void acceptPageWork(turn.page_id, fenced ? turn.episode : undefined)
      .then(
        () => onSent({ ok: true }),
        (error: unknown) => onSent({ ok: false, error }),
      )
      .finally(() => {
        // The review stays decided until Core's answer, so nothing offers it again meanwhile.
        sending.delete(key);
        publish();
      });
  };
  waiting.set(key, { timer: setTimeout(commit, ACCEPT_UNDO_WINDOW_MS), commit });
  flushOnLeave();
  publish();
  return {
    commit,
    undo: () => {
      const entry = waiting.get(key);
      if (!entry) return false;
      clearTimeout(entry.timer);
      waiting.delete(key);
      publish();
      return true;
    },
  };
}

/** Sends every accept still waiting out its window. */
export function flushPendingAccepts(): void {
  for (const entry of [...waiting.values()]) entry.commit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the reader has accepted this review, sent or still within its Undo window. Every
 * surface treats such a review as decided, so none offers it again.
 */
export function useReviewAccepted(turn: ReviewTurn | null | undefined): boolean {
  const accepted = useSyncExternalStore(subscribe, () => decided);
  return turn ? accepted.has(reviewKey(turn)) : false;
}

/**
 * The reviews the reader has decided, for lists that check many at once: the set keeps its
 * identity until a decision changes, and `reviewKey` names a review in it.
 */
export function useAcceptedReviews(): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => decided);
}

/**
 * Accepts a review and confirms it with an Undo that lasts the whole window, so a decision made
 * from a list or a chat can be taken back before it finishes the Page.
 */
export function acceptReviewWithUndo(
  turn: ReviewTurn,
  { fenced = true }: { readonly fenced?: boolean } = {},
): void {
  const intl = getIntl();
  const accept = scheduleAccept(
    turn,
    (result) => {
      if (result.ok) return;
      toast.danger(
        intl.formatMessage({
          id: "lib.pageAcceptUndo.acceptFailed",
          defaultMessage: "Couldn’t accept the work",
        }),
      );
    },
    fenced,
  );
  const confirmation = toast.success(
    intl.formatMessage({ id: "lib.pageAcceptUndo.accepted", defaultMessage: "Accepted" }),
    {
      id: `accept-review-${reviewKey(turn)}`,
      duration: ACCEPT_UNDO_WINDOW_MS,
      action: {
        label: intl.formatMessage({ id: "lib.pageAcceptUndo.undo", defaultMessage: "Undo" }),
        onClick: () => {
          accept.undo();
        },
      },
    },
  );
  // The toast leaves when the accept is sent, even while hovered, so its Undo never outlives
  // the window.
  setTimeout(() => confirmation.close(), ACCEPT_UNDO_WINDOW_MS);
}
