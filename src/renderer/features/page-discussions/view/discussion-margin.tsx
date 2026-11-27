import { useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from "react";
import { useIntl } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { NodexPopover, NodexPopoverAnchor, NodexPopoverContent } from "@/components/ui/popover";
import { ActivitySpinnerIcon, TextActionCommentIcon } from "@/components/shared/icons/app-icons";
import { layoutMarginCards } from "../margin-layout";
import { MARGIN_CARD_GAP, MARGIN_CARD_WIDTH, type MarginMode } from "../anchor-geometry";
import type { DiscussionView } from "../discussion-view-model";

export interface DiscussionMarginProps {
  readonly mode: MarginMode;
  /** Discussions shown in the margin, in any order; layout follows their anchors. */
  readonly discussions: readonly DiscussionView[];
  /** Measured anchor tops in the rail's coordinate space; unmeasured Discussions are hidden. */
  readonly anchorTops: ReadonlyMap<string, number>;
  readonly activeId: string | null;
  readonly onActiveChange: (discussionId: string | null) => void;
  readonly renderCard: (discussion: DiscussionView, active: boolean) => ReactNode;
}

const CARD_GAP = 8;

/**
 * Tabbing into a Discussion opens it. A pointer press on one of its controls also focuses the
 * control, but opening the card then would re-lay out the margin and move the control out from
 * under the click.
 */
const isKeyboardFocus = (event: FocusEvent<HTMLElement>) =>
  event.target instanceof Element && event.target.matches(":focus-visible");

/**
 * The Page's margin: Discussion cards aligned with their anchors when there is room, or compact
 * markers in the gutter that open the same card in a popover. Positioned absolutely against the
 * Page body, so it scrolls with the text it annotates.
 */
export function DiscussionMargin(props: DiscussionMarginProps) {
  const placed = props.discussions.filter((discussion) => props.anchorTops.has(discussion.id));
  if (placed.length === 0) return null;
  return props.mode === "cards" ? (
    <DiscussionCardColumn {...props} discussions={placed} />
  ) : (
    <DiscussionMarkerColumn {...props} discussions={placed} />
  );
}

/** The measured card heights after a resize, or the same map when nothing changed. */
function mergeCardHeights(
  current: ReadonlyMap<string, number>,
  entries: readonly ResizeObserverEntry[],
): ReadonlyMap<string, number> {
  let next: Map<string, number> | null = null;
  for (const entry of entries) {
    const id = (entry.target as HTMLElement).dataset.marginCardId;
    if (!id) continue;
    const height = Math.ceil(entry.borderBoxSize[0]?.blockSize ?? entry.contentRect.height);
    if (current.get(id) === height) continue;
    if (!next) next = new Map(current);
    next.set(id, height);
  }
  return next ?? current;
}

function DiscussionCardColumn({
  discussions,
  anchorTops,
  activeId,
  onActiveChange,
  renderCard,
}: DiscussionMarginProps) {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(new Map());
  const observerRef = useRef<ResizeObserver | null>(null);
  const elementsRef = useRef(new Map<string, HTMLElement>());

  useLayoutEffect(() => {
    const observer = new ResizeObserver((entries) => {
      setHeights((current) => mergeCardHeights(current, entries));
    });
    observerRef.current = observer;
    for (const element of elementsRef.current.values()) observer.observe(element);
    return () => {
      observer.disconnect();
      observerRef.current = null;
    };
  }, []);

  const tops = layoutMarginCards(
    discussions.map((discussion) => ({
      id: discussion.id,
      anchorTop: anchorTops.get(discussion.id)!,
      height: heights.get(discussion.id) ?? 72,
    })),
    { gap: CARD_GAP, activeId, minTop: 0 },
  );

  return (
    <div
      data-discussion-margin="cards"
      className="pointer-events-none absolute top-0 left-full h-0"
      style={{ marginLeft: MARGIN_CARD_GAP, width: MARGIN_CARD_WIDTH }}
    >
      {discussions.map((discussion) => {
        const active = discussion.id === activeId;
        return (
          <div
            key={discussion.id}
            data-margin-card-id={discussion.id}
            ref={(element) => {
              const elements = elementsRef.current;
              if (element) {
                elements.set(discussion.id, element);
                observerRef.current?.observe(element);
              } else {
                const previous = elements.get(discussion.id);
                if (previous) observerRef.current?.unobserve(previous);
                elements.delete(discussion.id);
              }
            }}
            className={cn("pointer-events-auto absolute inset-x-0", active && "z-10")}
            style={{ top: tops.get(discussion.id) ?? 0 }}
            onFocusCapture={(event) => {
              if (!active && isKeyboardFocus(event)) onActiveChange(discussion.id);
            }}
          >
            {renderCard(discussion, active)}
          </div>
        );
      })}
    </div>
  );
}

function DiscussionMarkerColumn({
  discussions,
  anchorTops,
  activeId,
  onActiveChange,
  renderCard,
}: DiscussionMarginProps) {
  // Discussions anchored on the same line share one marker.
  const rows = new Map<number, DiscussionView[]>();
  for (const discussion of discussions) {
    const line = Math.round(anchorTops.get(discussion.id)! / 4) * 4;
    rows.set(line, [...(rows.get(line) ?? []), discussion]);
  }
  return (
    <div
      data-discussion-margin="markers"
      className="pointer-events-none absolute top-0 left-full h-0 w-10"
      style={{ marginLeft: 12 }}
    >
      {[...rows].map(([top, row]) => (
        <DiscussionMarker
          key={row[0]!.id}
          top={top}
          discussions={row}
          activeId={activeId}
          onActiveChange={onActiveChange}
          renderCard={renderCard}
        />
      ))}
    </div>
  );
}

function DiscussionMarker({
  top,
  discussions,
  activeId,
  onActiveChange,
  renderCard,
}: {
  readonly top: number;
  readonly discussions: readonly DiscussionView[];
  readonly activeId: string | null;
  readonly onActiveChange: (discussionId: string | null) => void;
  readonly renderCard: (discussion: DiscussionView, active: boolean) => ReactNode;
}) {
  const intl = useIntl();
  const active = discussions.find((discussion) => discussion.id === activeId) ?? null;
  const working = discussions.some((discussion) => discussion.waiting === "nodex");
  const forMe = discussions.some((discussion) => discussion.waiting === "me");
  const count = discussions.reduce(
    (total, discussion) => total + discussion.comments.filter((comment) => !comment.deleted).length,
    0,
  );
  return (
    <NodexPopover
      open={active !== null}
      onOpenChange={(open) => onActiveChange(open ? discussions[0]!.id : null)}
    >
      <NodexPopoverAnchor>
        <button
          type="button"
          data-discussion-marker={discussions.map((discussion) => discussion.id).join(" ")}
          aria-label={intl.formatMessage(
            {
              id: "pageDiscussions.margin.marker",
              defaultMessage: "{count, plural, one {# comment} other {# comments}}",
            },
            { count },
          )}
          aria-expanded={active !== null}
          onClick={() => onActiveChange(active ? null : discussions[0]!.id)}
          className={cn(
            "pointer-events-auto absolute left-0 flex h-5 cursor-interaction items-center gap-1 rounded-full px-1.5 text-xs tabular-nums",
            active
              ? "bg-token-foreground/10 text-token-foreground"
              : forMe
                ? "bg-text-info/12 text-info"
                : "text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground",
          )}
          style={{ top }}
        >
          {working ? (
            <ActivitySpinnerIcon className="size-3 shrink-0" />
          ) : (
            <TextActionCommentIcon className="size-3.5" />
          )}
          {count > 1 ? <span>{count}</span> : null}
        </button>
      </NodexPopoverAnchor>
      <NodexPopoverContent
        initialFocus={() =>
          document.querySelector<HTMLElement>(
            `[data-margin-popover-for="${discussions[0]!.id}"] textarea`,
          ) ?? true
        }
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-[min(20rem,calc(100vw-24px))] overflow-hidden rounded-xl bg-token-main-surface-primary p-0 shadow-xl-spread ring-[0.5px] ring-token-border"
      >
        <div
          data-margin-popover-for={discussions[0]!.id}
          className="flex max-h-[70vh] flex-col divide-y-[0.5px] divide-token-border overflow-y-auto [&_[data-discussion-card]]:rounded-none [&_[data-discussion-card]]:shadow-none [&_[data-discussion-card]]:ring-0"
        >
          {discussions.map((discussion) => (
            <div
              key={discussion.id}
              onFocusCapture={(event) => {
                if (isKeyboardFocus(event)) onActiveChange(discussion.id);
              }}
            >
              {renderCard(discussion, discussion.id === activeId)}
            </div>
          ))}
        </div>
      </NodexPopoverContent>
    </NodexPopover>
  );
}
