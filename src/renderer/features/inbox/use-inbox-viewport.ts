import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ActivityFilter } from "../../../shared/inbox";
import { SCROLL_SAVE_DEBOUNCE_MS } from "@/lib/timing";
import {
  captureInboxViewportPosition,
  readInboxViewport,
  recordInboxViewport,
  restoreInboxViewportPosition,
  type InboxView,
  type InboxViewportPosition,
} from "./inbox-viewport";

/** How many earlier windows a returning reader may load to find the row they left at. */
const MAX_RESTORE_WINDOWS = 2;
const LATEST: InboxViewportPosition = { kind: "latest" };

/** The view and Activity filter a reader left an Inbox in, so returning lands where they were. */
export const initialInboxPlace = (
  scopeKey: string,
): { readonly view: InboxView; readonly activityFilter: ActivityFilter } => {
  const remembered = readInboxViewport(scopeKey);
  return { view: remembered?.view ?? "inbox", activityFilter: remembered?.activityFilter ?? "all" };
};

/** Whether the Inbox follows new messages before its place is restored. */
export const initiallyFollowsInbox = (scopeKey: string): boolean =>
  readInboxViewport(scopeKey)?.positions.inbox?.kind !== "anchor";

/**
 * Keeps an Inbox's place per view while its surface unmounts and the app relaunches: records it
 * as the reader scrolls and restores it once the view's rows are rendered. `anchorIds` are the
 * loaded rows of the view shown: message Pages in the Inbox, facts in Activity.
 */
export function useInboxViewport(input: {
  readonly scopeKey: string;
  readonly view: InboxView;
  readonly activityFilter: ActivityFilter;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly stickToBottomRef: { current: boolean };
  readonly anchorIds: readonly string[];
  readonly ready: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
}) {
  const { scopeKey, view, activityFilter, scrollRef, stickToBottomRef, anchorIds, ready } = input;
  /** The view whose place has been restored since it was shown. */
  const restoredViewRef = useRef<InboxView | null>(null);
  const restoreWindowsRef = useRef<{ view: InboxView; count: number } | null>(null);
  const lastRef = useRef<{
    view: InboxView;
    activityFilter: ActivityFilter;
    position: InboxViewportPosition;
  } | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = () => {
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
    const last = lastRef.current;
    if (last) recordInboxViewport(scopeKey, last, last.position, true);
  };

  // Every scroll already keeps its view's place in memory; showing a view keeps them all, and
  // which view and filter are shown, across launches.
  useEffect(() => {
    recordInboxViewport(scopeKey, { view, activityFilter }, null, true);
  }, [scopeKey, view, activityFilter]);
  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
      const last = lastRef.current;
      if (last) recordInboxViewport(scopeKey, last, last.position, true);
    },
    [scopeKey],
  );

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (restoredViewRef.current === view || !scroller || !ready) return;
    const settle = (position: InboxViewportPosition) => {
      restoredViewRef.current = view;
      lastRef.current = { view, activityFilter, position };
    };
    const remembered = readInboxViewport(scopeKey)?.positions[view];
    if (remembered?.kind === "anchor") {
      const loaded = anchorIds.includes(remembered.id);
      const windows =
        restoreWindowsRef.current?.view === view ? restoreWindowsRef.current.count : 0;
      if (!loaded && input.hasNextPage && windows < MAX_RESTORE_WINDOWS) {
        if (!input.isFetchingNextPage) {
          restoreWindowsRef.current = { view, count: windows + 1 };
          void input.fetchNextPage();
        }
        return;
      }
      if (loaded && restoreInboxViewportPosition(scroller, view, remembered)) {
        stickToBottomRef.current = false;
        settle(remembered);
        return;
      }
    }
    // Nothing remembered, or the row is gone since: the live edge.
    restoreInboxViewportPosition(scroller, view, LATEST);
    stickToBottomRef.current = view === "inbox";
    settle(LATEST);
  });

  return {
    /** Records the place as the reader scrolls; nothing is recorded while it is being restored. */
    onScroll: () => {
      const scroller = scrollRef.current;
      if (!scroller || restoredViewRef.current !== view) return;
      const position = captureInboxViewportPosition(scroller, view);
      lastRef.current = { view, activityFilter, position };
      recordInboxViewport(scopeKey, { view, activityFilter }, position, false);
      if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(persist, SCROLL_SAVE_DEBOUNCE_MS);
    },
    /**
     * Sends the reader to the live edge of a view: the newest messages after a send, or the
     * newest facts of another Activity filter.
     */
    followLatest: (target: InboxView, filter: ActivityFilter = activityFilter) => {
      lastRef.current = { view: target, activityFilter: filter, position: LATEST };
      recordInboxViewport(scopeKey, { view: target, activityFilter: filter }, LATEST, true);
      if (target === view) restoredViewRef.current = null;
    },
  };
}
