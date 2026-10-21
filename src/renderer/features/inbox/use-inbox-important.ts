import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

const messageSelector = (pageId: string) => `[data-inbox-page-id="${CSS.escape(pageId)}"]`;

interface Measured {
  readonly watched: string;
  readonly visible: ReadonlySet<string>;
}

/**
 * Whether each watched message shows, at least in part, in the stream's viewport. A message not
 * measured yet counts as in view, so nothing points at it before the stream has been looked at.
 */
export function useInboxMessagesInView(
  scrollRef: RefObject<HTMLElement | null>,
  pageIds: readonly string[],
): (pageId: string) => boolean {
  const watched = pageIds.join("\n");
  const [measured, setMeasured] = useState<Measured | null>(null);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller || watched === "") return;
    const ids = watched.split("\n");
    let frame: number | null = null;
    const measure = () => {
      frame = null;
      const bounds = scroller.getBoundingClientRect();
      const visible = new Set(
        ids.filter((pageId) => {
          const rect = scroller.querySelector(messageSelector(pageId))?.getBoundingClientRect();
          return rect != null && rect.bottom > bounds.top && rect.top < bounds.bottom;
        }),
      );
      setMeasured((current) =>
        current?.watched === watched &&
        current.visible.size === visible.size &&
        [...visible].every((pageId) => current.visible.has(pageId))
          ? current
          : { watched, visible },
      );
    };
    const schedule = () => {
      frame ??= requestAnimationFrame(measure);
    };
    schedule();
    scroller.addEventListener("scroll", schedule, { passive: true });
    // Messages arriving, leaving or loading earlier move the others without a scroll.
    const mutations = new MutationObserver(schedule);
    mutations.observe(scroller, { childList: true, subtree: true });
    const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resizes?.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", schedule);
      mutations.disconnect();
      resizes?.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [scrollRef, watched]);
  return (pageId) =>
    measured === null || !measured.watched.split("\n").includes(pageId)
      ? true
      : measured.visible.has(pageId);
}

/**
 * Brings a message into view and marks it for a moment. A message further back than the loaded
 * windows loads earlier ones until it is rendered; one handled meanwhile is simply not found.
 */
export function useInboxJump(input: {
  readonly scrollRef: RefObject<HTMLElement | null>;
  readonly stickToBottomRef: { current: boolean };
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly fetchNextPage: () => Promise<unknown>;
}) {
  const { scrollRef, stickToBottomRef } = input;
  const pendingRef = useRef<string | null>(null);
  const [arrival, setArrival] = useState<{ readonly pageId: string; readonly token: number }>({
    pageId: "",
    token: 0,
  });
  // Every render may have brought the message in, or may need the next earlier window.
  useLayoutEffect(() => {
    const pageId = pendingRef.current;
    if (pageId === null) return;
    const message = scrollRef.current?.querySelector<HTMLElement>(messageSelector(pageId));
    if (message) {
      pendingRef.current = null;
      stickToBottomRef.current = false;
      message.scrollIntoView({ block: "center", behavior: "smooth" });
    } else if (!input.hasNextPage) {
      pendingRef.current = null;
    } else if (!input.isFetchingNextPage) {
      void input.fetchNextPage();
    }
  });
  return {
    jump: (pageId: string) => {
      // Reading back through the stream, so new messages no longer pull it to the bottom.
      stickToBottomRef.current = false;
      pendingRef.current = pageId;
      setArrival((current) => ({ pageId, token: current.token + 1 }));
    },
    /** The message the reader was last brought to, and a token that changes on every arrival. */
    arrival,
  };
}
