import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { useIntl } from "@/lib/i18n";
import { marginModeForSpace, measureAnchorTop, type MarginMode } from "../anchor-geometry";
import type { PageDiscussionsController } from "../use-page-discussions-controller";
import type { DiscussionAnchorView } from "../discussion-view-model";
import { DiscussionCard } from "./discussion-card";
import { DiscussionComposer } from "./discussion-composer";
import { DiscussionMargin } from "./discussion-margin";
import {
  subscribeVisualDatumGeometry,
  visualDatumTop,
} from "@/features/visual/visual-datum-geometry";

const sameTops = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>) =>
  a.size === b.size && [...a].every(([id, top]) => b.get(id) === top);

/** Elements that keep the active Discussion open when pointed at. */
const DISCUSSION_SURFACE =
  "[data-discussion-card], [data-discussion-marker], [data-discussion-mark], [data-slot='popover-content'], [role='listbox']";

/**
 * Places a Page's Discussions beside its body. It measures anchors against `origin` (the
 * positioned wrapper around the editor) after every document change and resize, chooses cards
 * or markers from the room left in the scrollport, and closes the active card on outside clicks.
 */
export function PageDiscussionsMarginHost({
  controller,
  origin,
  scrollContainerRef,
}: {
  readonly controller: PageDiscussionsController;
  readonly origin: HTMLElement | null;
  readonly scrollContainerRef: RefObject<HTMLElement | null>;
}) {
  const intl = useIntl();
  const { editor, views, activeId, setActiveId } = controller;
  const [tops, setTops] = useState<ReadonlyMap<string, number>>(new Map());
  const [mode, setMode] = useState<MarginMode>("markers");
  const shown = views.filter((view) => !view.resolved || view.id === activeId);
  // Re-measure when the set of anchors changes, not on every render of new view objects.
  const anchorsJson = JSON.stringify(shown.map((view) => [view.id, view.anchor]));

  useLayoutEffect(() => {
    const root = editor?.domElement;
    const scrollport = scrollContainerRef.current;
    if (!root || !origin) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = new Map<string, number>();
      const anchors = JSON.parse(anchorsJson) as [string, DiscussionAnchorView][];
      for (const [discussionId, anchor] of anchors) {
        const top = measureAnchorTop({
          discussionId,
          anchor,
          editorRoot: root,
          origin,
          datums: { datumTop: visualDatumTop },
        });
        if (top !== null) next.set(discussionId, top);
      }
      setTops((current) => (sameTops(current, next) ? current : next));
      if (scrollport) {
        const free =
          scrollport.getBoundingClientRect().right - origin.getBoundingClientRect().right;
        setMode(marginModeForSpace(free));
      }
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule();
    const resize = new ResizeObserver(schedule);
    resize.observe(origin);
    if (scrollport) resize.observe(scrollport);
    const unsubscribe = editor.onChange(schedule);
    const unsubscribeVisuals = subscribeVisualDatumGeometry(schedule);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      unsubscribe?.();
      unsubscribeVisuals();
    };
  }, [anchorsJson, editor, origin, scrollContainerRef]);

  useEffect(() => {
    if (!activeId) return;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest(DISCUSSION_SURFACE)) return;
      setActiveId(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [activeId, setActiveId]);

  return (
    <DiscussionMargin
      mode={mode}
      discussions={shown}
      anchorTops={tops}
      activeId={activeId}
      onActiveChange={setActiveId}
      renderCard={(discussion, active) => (
        <DiscussionCard
          discussion={discussion}
          active={active}
          nowMs={controller.nowMs}
          actions={controller.actions}
          onActivate={() => setActiveId(discussion.id)}
          composer={
            <DiscussionComposer
              placeholder={intl.formatMessage({
                id: "pageDiscussions.margin.replyPlaceholder",
                defaultMessage: "Reply, or @mention someone…",
              })}
              members={controller.members}
              sendToNodex={controller.sendToNodex}
              onSendToNodexChange={controller.setSendToNodex}
              onSubmit={(submit) => controller.reply(discussion.id, submit)}
              onCancel={() => setActiveId(null)}
            />
          }
        />
      )}
    />
  );
}
