import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Page Stage toggle glyphs. They share the window toolbar's 20px grid, 1.33 stroke, and pane
 * frame, and each draws its active state as a change of shape at the same weight rather than as
 * a heavier fill.
 */
type PageStageToolbarIconProps = {
  /** Draw the glyph for the toggle's pressed state. */
  readonly active?: boolean;
  readonly className?: string;
};

const PANE_FRAME_PATH =
  "M5 3.75h10a2.5 2.5 0 0 1 2.5 2.5v7.5a2.5 2.5 0 0 1-2.5 2.5H5a2.5 2.5 0 0 1-2.5-2.5v-7.5A2.5 2.5 0 0 1 5 3.75Z";

/** `</>` on its own: the editor is showing. */
const RAW_CONTENT_IDLE_PATH =
  "M6.25 6.25 2.5 10l3.75 3.75M13.75 6.25 17.5 10l-3.75 3.75M11.25 4.75l-2.5 10.5";
/** The brackets move inside the pane: the Page's source is showing. */
const RAW_CONTENT_ACTIVE_PATH = "M8 7.75 5.75 10 8 12.25M12 7.75l2.25 2.25L12 12.25";

/** A short span inside the pane: the body keeps its reading width. */
const FULL_WIDTH_IDLE_PATH = "M6.75 10h6.5M8.25 8.5 6.75 10l1.5 1.5M11.75 8.5 13.25 10l-1.5 1.5";
/** The span reaches both sides of the pane: the body fills it. */
const FULL_WIDTH_ACTIVE_PATH = "M5.25 10h9.5M6.75 8.5 5.25 10l1.5 1.5M13.25 8.5 14.75 10l-1.5 1.5";

const HISTORY_DIAL_PATH =
  "M2.5 10a7.5 7.5 0 1 0 7.5-7.5 8.125 8.125 0 0 0-5.617 2.283L2.5 6.667M2.5 3.333v3.334h3.333";
const HISTORY_IDLE_HANDS_PATH = "M10 6.25V10l2.5 1.25";
/** The hands turn back a quarter, sweeping the dial: earlier versions are open. */
const HISTORY_ACTIVE_SWEEP_PATH = "M10 6.25V10H6.25A3.75 3.75 0 0 1 10 6.25Z";

function PageStageToolbarGlyph({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.33}
      strokeLinecap="round"
      strokeLinejoin="round"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
      className={cn("icon-sm shrink-0", className)}
    >
      {children}
    </svg>
  );
}

export function PageRawContentIcon({ active = false, className }: PageStageToolbarIconProps) {
  return (
    <PageStageToolbarGlyph className={className}>
      {active ? (
        <>
          <path d={PANE_FRAME_PATH} />
          <path d={RAW_CONTENT_ACTIVE_PATH} />
        </>
      ) : (
        <path d={RAW_CONTENT_IDLE_PATH} />
      )}
    </PageStageToolbarGlyph>
  );
}

export function PageFullWidthIcon({ active = false, className }: PageStageToolbarIconProps) {
  return (
    <PageStageToolbarGlyph className={className}>
      <path d={PANE_FRAME_PATH} />
      <path d={active ? FULL_WIDTH_ACTIVE_PATH : FULL_WIDTH_IDLE_PATH} />
    </PageStageToolbarGlyph>
  );
}

export function PageHistoryIcon({ active = false, className }: PageStageToolbarIconProps) {
  return (
    <PageStageToolbarGlyph className={className}>
      <path d={HISTORY_DIAL_PATH} />
      {active ? (
        <path d={HISTORY_ACTIVE_SWEEP_PATH} fill="currentColor" />
      ) : (
        <path d={HISTORY_IDLE_HANDS_PATH} />
      )}
    </PageStageToolbarGlyph>
  );
}
