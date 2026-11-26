import { useState, type FocusEvent } from "react";
import { presentSnoozedLane, type SnoozedLanePresentation } from "@/lib/chat-snooze";
import { useIntl } from "@/lib/i18n";
import { useClockAt } from "@/lib/use-clock-at";
import {
  anchorSidebarChat,
  holdSidebarLanes,
  partitionSidebarChats,
  sidebarChatReaderMark,
  sidebarLaneOrder,
  type SidebarChatAnchor,
  type SidebarChatLane,
  type SidebarLaneOrder,
  type SidebarLifecycleChat,
} from "@/lib/sidebar-chat-lifecycle";

interface LaneHold {
  readonly order: SidebarLaneOrder;
  /** What the reader had set on each chat they saw; a change means they acted on it. */
  readonly marks: ReadonlyMap<string, string>;
}

/**
 * The reader's open chats in lanes, steady under their eyes. The chat on screen keeps the place it
 * had when they opened it, and while `holding` (they point at or work in the sidebar) every row
 * they saw keeps its place until they leave. A chat they pin, unpin, reorder among their pins or
 * snooze moves at once.
 */
export function useSidebarChatLanes<Chat extends SidebarLifecycleChat>({
  chats,
  activeSessionId,
  holding,
}: {
  chats: readonly Chat[];
  activeSessionId: string | null;
  holding: boolean;
}): Readonly<Record<SidebarChatLane, readonly Chat[]>> {
  const activeChat = chats.find((chat) => chat.id === activeSessionId) ?? null;
  const [anchored, setAnchored] = useState<{
    readonly sessionId: string | null;
    readonly anchor: SidebarChatAnchor | null;
  }>({ sessionId: null, anchor: null });
  if (anchored.sessionId !== activeSessionId || (anchored.anchor === null && activeChat !== null)) {
    setAnchored({
      sessionId: activeSessionId,
      anchor: activeChat ? anchorSidebarChat(activeChat) : null,
    });
  }
  const fresh = partitionSidebarChats(
    chats,
    anchored.sessionId === activeSessionId ? anchored.anchor : null,
  );

  const [hold, setHold] = useState<LaneHold | null>(null);
  if (holding && hold === null)
    setHold({
      order: sidebarLaneOrder(fresh),
      marks: new Map(chats.map((chat) => [chat.id, sidebarChatReaderMark(chat)])),
    });
  if (!holding && hold !== null) setHold(null);

  const released = new Set(
    chats
      .filter((chat) => {
        const mark = hold?.marks.get(chat.id);
        // A chat the reader just opened shows even when it arrived during the hold.
        return mark === undefined
          ? chat.id === activeSessionId
          : mark !== sidebarChatReaderMark(chat);
      })
      .map((chat) => chat.id),
  );
  return holdSidebarLanes(fresh, hold?.order ?? null, released);
}

function focusedByKeyboard(target: Element): boolean {
  try {
    return target.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Whether the reader is in the sidebar: pointing at it, or moving through it with the keyboard.
 * A click that leaves focus on a row does not count, so the lanes settle once they look away.
 */
export function useSidebarLaneHold() {
  const [pointing, setPointing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  return {
    holding: pointing || browsing,
    holdHandlers: {
      onPointerEnter: () => setPointing(true),
      onPointerLeave: () => setPointing(false),
      onFocus: (event: FocusEvent<HTMLElement>) => setBrowsing(focusedByKeyboard(event.target)),
      onBlur: (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBrowsing(false);
      },
    },
  };
}

/**
 * The Snoozed lane as it reads now: when each chat returns, which ones return after tomorrow, and
 * what the fold after the last sooner chat hides. It reads again as each day turns and as a return comes within hours.
 */
export function useSnoozedLanePresentation(
  chats: readonly { readonly id: string; readonly snoozedUntil: string | null }[],
  shownId: string | null,
): SnoozedLanePresentation {
  const intl = useIntl();
  const [now, setNow] = useState(Date.now);
  const presentation = presentSnoozedLane(chats, new Date(now), intl.locale, shownId);
  useClockAt(presentation.nextChangeAt, setNow);
  return presentation;
}
