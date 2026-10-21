import { useEffect, useRef, useState } from "react";
import type { InboxItem } from "../../../shared/inbox";
import { describeInboxDecision, type InboxDecision, type InboxOutcome } from "./inbox-presentation";

/** How long a decided message shows where it went before it folds away. */
export const INBOX_DEPARTURE_MS = 1_800;
/** The least it lingers after the pointer that held it leaves. */
export const INBOX_DEPARTURE_RELEASE_MS = 600;

interface Departure {
  readonly item: InboxItem;
  readonly outcome: InboxOutcome;
  /** When it may fold away, unless the pointer is resting on it then. */
  readonly until: number;
}

export interface InboxDepartures {
  /** Shows each decided message's outcome in its place, then lets it fold away. */
  readonly depart: (items: readonly InboxItem[], decision: InboxDecision) => void;
  /**
   * Hears the pointer resting on a message and leaving it. A decided message stays while it
   * rests there, including the pointer that just decided it, so its chat can still be opened.
   */
  readonly hold: (pageId: string, held: boolean) => void;
  readonly outcomeOf: (pageId: string) => InboxOutcome | null;
  /** The stream's newest-first items, with decided messages kept in their places. */
  readonly items: readonly InboxItem[];
}

/**
 * Keeps a message this window just decided in its place for a moment, showing where it went,
 * even after Core has taken it out of the Inbox. Then it leaves like any handled message.
 */
export function useInboxDepartures(items: readonly InboxItem[]): InboxDepartures {
  const [departures, setDepartures] = useState<ReadonlyMap<string, Departure>>(() => new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const held = useRef(new Set<string>());

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    };
  }, []);

  const stay = (pageId: string) => {
    clearTimeout(timers.current.get(pageId));
    timers.current.delete(pageId);
  };

  const leaveAfter = (pageId: string, delayMs: number) => {
    stay(pageId);
    timers.current.set(
      pageId,
      setTimeout(() => {
        timers.current.delete(pageId);
        setDepartures((current) => {
          const next = new Map(current);
          next.delete(pageId);
          return next;
        });
      }, delayMs),
    );
  };

  const depart = (decided: readonly InboxItem[], decision: InboxDecision) => {
    if (decided.length === 0) return;
    const until = Date.now() + INBOX_DEPARTURE_MS;
    setDepartures((current) => {
      const next = new Map(current);
      for (const item of decided) {
        next.set(item.pageId, { item, outcome: describeInboxDecision(item, decision), until });
      }
      return next;
    });
    for (const item of decided) {
      if (!held.current.has(item.pageId)) leaveAfter(item.pageId, INBOX_DEPARTURE_MS);
    }
  };

  const hold = (pageId: string, resting: boolean) => {
    if (resting) held.current.add(pageId);
    else held.current.delete(pageId);
    const departure = departures.get(pageId);
    if (!departure) return;
    if (resting) stay(pageId);
    else leaveAfter(pageId, Math.max(INBOX_DEPARTURE_RELEASE_MS, departure.until - Date.now()));
  };

  return {
    depart,
    hold,
    outcomeOf: (pageId) => departures.get(pageId)?.outcome ?? null,
    items: retainDeparted(
      items,
      [...departures.values()].map((departure) => departure.item),
    ),
  };
}

/**
 * Puts decided messages Core no longer lists back where they were in the newest-first stream:
 * before the first message sent earlier than each of them.
 */
export function retainDeparted(
  items: readonly InboxItem[],
  departed: readonly InboxItem[],
): readonly InboxItem[] {
  const listed = new Set(items.map((item) => item.pageId));
  const missing = departed.filter((item) => !listed.has(item.pageId));
  if (missing.length === 0) return items;
  const merged = [...items];
  for (const item of missing) {
    const index = merged.findIndex((other) => other.submittedAt < item.submittedAt);
    merged.splice(index === -1 ? merged.length : index, 0, item);
  }
  return merged;
}
