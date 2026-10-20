import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { InboxItem, InboxWindowFilter } from "../../../shared/inbox";
import { SCROLL_SAVE_DEBOUNCE_MS } from "@/lib/timing";
import {
  captureInboxViewportPosition,
  readInboxViewport,
  recordInboxViewport,
  restoreInboxViewportPosition,
  type InboxViewportPosition,
} from "./inbox-viewport";

/** How many earlier windows a returning reader may load to find the message they left at. */
const MAX_RESTORE_WINDOWS = 2;
const LATEST: InboxViewportPosition = { kind: "latest" };

/** The view a reader left an Inbox in, so returning to it lands where they were. */
export const initialInboxView = (scopeKey: string): InboxWindowFilter =>
  readInboxViewport(scopeKey)?.view ?? "inbox";

/** Whether the Inbox follows new messages before its place is restored. */
export const initiallyFollowsInbox = (scopeKey: string): boolean =>
  readInboxViewport(scopeKey)?.positions.inbox?.kind !== "message";

/**
 * Keeps an Inbox's place per view while its surface unmounts and the app relaunches: records it
 * as the reader scrolls and restores it once the view's messages are rendered.
 */
export function useInboxViewport(input: {
  readonly scopeKey: string;
  readonly view: InboxWindowFilter;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly stickToBottomRef: { current: boolean };
  readonly items: readonly InboxItem[];
  readonly ready: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
}) {
  const { scopeKey, view, scrollRef, stickToBottomRef, items, ready } = input;
  /** The view whose place has been restored since it was shown. */
  const restoredViewRef = useRef<InboxWindowFilter | null>(null);
  const restoreWindowsRef = useRef<{ view: InboxWindowFilter; count: number } | null>(null);
  const lastRef = useRef<{ view: InboxWindowFilter; position: InboxViewportPosition } | null>(null);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = () => {
    if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
    const last = lastRef.current;
    if (last) recordInboxViewport(scopeKey, last.view, last.position, true);
  };

  // Every scroll already keeps its view's place in memory; showing a view keeps them all, and
  // which view is shown, across launches.
  useEffect(() => {
    recordInboxViewport(scopeKey, view, null, true);
  }, [scopeKey, view]);
  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
      const last = lastRef.current;
      if (last) recordInboxViewport(scopeKey, last.view, last.position, true);
    },
    [scopeKey],
  );

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (restoredViewRef.current === view || !scroller || !ready) return;
    const settle = (position: InboxViewportPosition) => {
      restoredViewRef.current = view;
      lastRef.current = { view, position };
    };
    const remembered = readInboxViewport(scopeKey)?.positions[view];
    if (remembered?.kind === "message") {
      const loaded = items.some((item) => item.pageId === remembered.pageId);
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
    // Nothing remembered, or the message was handled since: the live edge.
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
      lastRef.current = { view, position };
      recordInboxViewport(scopeKey, view, position, false);
      if (persistTimerRef.current !== null) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(persist, SCROLL_SAVE_DEBOUNCE_MS);
    },
    /** Sends the reader to the newest messages of a view, as a send does. */
    followLatest: (target: InboxWindowFilter) => {
      lastRef.current = { view: target, position: LATEST };
      recordInboxViewport(scopeKey, target, LATEST, true);
      if (target === view) restoredViewRef.current = null;
    },
  };
}
