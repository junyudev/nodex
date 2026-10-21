import type { CSSProperties, ReactNode } from "react";
import { useLayoutEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "@/components/shared/icons";
import { cn } from "../../../../lib/utils";
import { useClippedFocusSafety } from "./use-clipped-focus-safety";
import { useContentOverflow } from "./use-content-overflow";
import { resolveUserMessageCollapsedHeightPx } from "./user-message-collapse-layout";
import { registerContentSearchRevealOwner } from "../../../content-search/content-search-reveal-owner";

export const DEFAULT_USER_MESSAGE_COLLAPSED_LINES = 20;

const USER_MESSAGE_COLLAPSED_STYLE: CSSProperties = {
  overflow: "hidden",
};

/**
 * Collapses a written message after `collapsedLineCount` lines, with `Show more` to read the
 * rest. `contentKey` identifies the message: an expanded message collapses again when it changes.
 */
export function UserMessageCollapse({
  contentKey,
  collapsedLineCount = DEFAULT_USER_MESSAGE_COLLAPSED_LINES,
  children,
}: {
  readonly contentKey: string;
  readonly collapsedLineCount?: number;
  readonly children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const clipRef = useRef<HTMLDivElement>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const { collapsedHeightPx, isOverflowing } = useContentOverflow(contentRef, collapsedLineCount);

  const expanded = expandedKey === contentKey;
  const collapsed = isOverflowing && !expanded;
  useLayoutEffect(() => {
    const clip = clipRef.current;
    if (!collapsed || !clip) return;
    return registerContentSearchRevealOwner(clip, () => setExpandedKey(contentKey));
  }, [collapsed, contentKey]);
  useClippedFocusSafety(clipRef, collapsed);
  const showEllipsis = collapsed && collapsedLineCount > 2;
  const visibleLines = collapsedLineCount - Number(showEllipsis);
  useLayoutEffect(() => {
    const clip = clipRef.current;
    const content = contentRef.current;
    if (!collapsed || !clip || !content) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(clip).lineHeight);
      if (!Number.isFinite(lineHeight)) return;
      const bounds = clip.getBoundingClientRect();
      clip.style.maxHeight = `${resolveUserMessageCollapsedHeightPx({
        lineHeightPx: lineHeight,
        visibleLineCount: visibleLines,
        rootTopPx: bounds.top,
        physicalScale: clip.offsetHeight === 0 ? 1 : bounds.height / clip.offsetHeight,
        codeBlocks: [...clip.querySelectorAll('[data-streamdown="code-block"]')].map((element) =>
          element.getBoundingClientRect(),
        ),
      })}px`;
    };
    measure();
    const resize = new ResizeObserver(measure);
    resize.observe(content);
    const mutation = new MutationObserver(measure);
    mutation.observe(content, { childList: true, subtree: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [collapsed, contentKey, visibleLines]);
  const collapsedStyle =
    collapsed && collapsedHeightPx !== null
      ? {
          ...USER_MESSAGE_COLLAPSED_STYLE,
          maxHeight: `${visibleLines}lh`,
        }
      : undefined;

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="contentKey-size-chat relative w-full min-w-0 leading-relaxed">
        <div ref={clipRef} style={collapsedStyle}>
          <div ref={contentRef}>{children}</div>
        </div>
        {showEllipsis ? (
          <span
            aria-hidden="true"
            data-content-search-skip="true"
            data-markdown-copy="exclude"
            className="block"
          >
            …
          </span>
        ) : null}
      </div>
      {!isOverflowing ? null : (
        <button
          type="button"
          aria-expanded={expanded}
          data-thread-find-skip="true"
          data-content-search-skip="true"
          data-markdown-copy="exclude"
          className="contentKey-size-chat mt-1.5 inline-flex cursor-interaction items-center gap-1 self-start contentKey-token-description-foreground hover:contentKey-token-foreground"
          onClick={() => setExpandedKey((current) => (current === contentKey ? null : contentKey))}
        >
          <span>{expanded ? "Show less" : "Show more"}</span>
          <ChevronDownIcon
            className={cn("icon-2xs transition-transform duration-150", expanded && "rotate-180")}
          />
        </button>
      )}
    </div>
  );
}
