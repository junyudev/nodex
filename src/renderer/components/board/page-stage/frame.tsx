import type { CSSProperties, ComponentPropsWithoutRef, ReactNode, Ref } from "react";
import { PAGE_TITLE_TEXT_CLASS_NAME } from "@/components/block-documents/page-title-typography";
import { LoadingResultsShimmer } from "@/components/ui/loading-results-shimmer";
import { readPageStageContentWidthPreference } from "@/lib/page-stage-layout";
import { RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE } from "@/lib/right-panel-composer-overlay-reserve";
import { cn } from "@/lib/utils";
import { PageStageToolbar } from "./toolbar";
import type { PageStageBreadcrumbProps } from "./breadcrumb";

const PAGE_STAGE_SCROLL_CONTAINER_TEST_ID = "page-stage-scroll-container";

const PAGE_STAGE_SCROLL_CONTAINER_STYLE = {
  ...RIGHT_PANEL_COMPOSER_OVERLAY_SCROLL_RESERVE_STYLE,
  overflowAnchor: "none",
} satisfies CSSProperties;

export const pageStageContentBodyClassName = (limitMainContentWidth: boolean): string =>
  cn(
    "mx-auto w-full px-(--page-stage-body-gutter-inline)",
    limitMainContentWidth && "max-w-(--page-stage-body-max-width)",
  );

interface PageStageFrameProps extends Omit<ComponentPropsWithoutRef<"div">, "children"> {
  readonly toolbar: ReactNode;
  readonly limitMainContentWidth: boolean;
  readonly scrollContainerRef?: Ref<HTMLDivElement>;
  readonly headingRailPortalRef?: Ref<HTMLDivElement>;
  readonly children: ReactNode;
}

/**
 * The one Page Stage geometry. Loading and editable states render inside the same frame,
 * so toolbar, gutters, and content width never move when a Page finishes opening.
 */
export function PageStageFrame({
  toolbar,
  limitMainContentWidth,
  scrollContainerRef,
  headingRailPortalRef,
  className,
  children,
  ...rootProps
}: PageStageFrameProps) {
  return (
    <div {...rootProps} className={cn("flex h-full w-full flex-col bg-(--background)", className)}>
      {toolbar}
      <div
        ref={headingRailPortalRef}
        className="relative min-h-0 flex-1"
        data-page-stage-heading-navigation-portal-target="true"
      >
        <div
          ref={scrollContainerRef}
          className="scrollbar-token h-full min-h-0 overflow-y-auto"
          data-testid={PAGE_STAGE_SCROLL_CONTAINER_TEST_ID}
          style={PAGE_STAGE_SCROLL_CONTAINER_STYLE}
        >
          <div
            className={pageStageContentBodyClassName(limitMainContentWidth)}
            data-page-stage-body="true"
            data-page-stage-body-width={limitMainContentWidth ? "constrained" : "full"}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Title, Page properties, and body in reading order; placeholders occupy the same slots. */
export function PageStageContentLayout({
  title,
  syncStatus,
  properties,
  body,
}: {
  readonly title: ReactNode;
  readonly syncStatus?: ReactNode;
  readonly properties?: ReactNode;
  readonly body: ReactNode;
}) {
  return (
    <div className="w-full">
      <div className="h-toolbar-sm" />
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">{title}</div>
        {/* A quiet status renders nothing and must not narrow the title. */}
        {syncStatus ? <div className="shrink-0 pt-1 empty:hidden">{syncStatus}</div> : null}
      </div>
      {properties}
      <div className="pt-3 pb-8">{body}</div>
    </div>
  );
}

/**
 * Read-only stand-in for the collaborative title with the editor's exact text geometry.
 * A known empty title shows the editor's own placeholder; an unknown one only holds its line.
 */
export function PageTitlePlaceholder({ title }: { readonly title: string | null }) {
  const text = title?.trim();
  return (
    <div
      aria-hidden="true"
      data-page-title-placeholder="true"
      className={cn(PAGE_TITLE_TEXT_CLASS_NAME, !text && "text-(--foreground-disabled)")}
    >
      {text || (title === null ? "\u00a0" : "Untitled")}
    </div>
  );
}

/**
 * Body stand-in while the Page Document syncs. Bars appear only after a short grace period,
 * so a fast open fills in calmly instead of flashing a skeleton.
 */
export function PageStageBodyPlaceholder({ seed }: { readonly seed: string }) {
  return (
    <div aria-hidden="true" className="nodex-loading-deferred pt-1">
      <LoadingResultsShimmer
        className="max-w-3xl"
        lineClassName="rounded-md"
        lines={3}
        maxWidth={92}
        minWidth={58}
        seed={`page-stage:${seed}`}
        size="md"
      />
    </div>
  );
}

/** The Page Stage before its Page Detail is readable: known chrome and title, nothing invented. */
export function PageStageLoadingFrame({
  titleSnapshot,
  breadcrumb,
}: {
  readonly titleSnapshot?: string;
  readonly breadcrumb?: PageStageBreadcrumbProps;
}) {
  const title = titleSnapshot === undefined ? null : titleSnapshot.trim();
  const limitMainContentWidth = readPageStageContentWidthPreference();
  return (
    <PageStageFrame
      role="status"
      aria-busy="true"
      aria-label={title ? `Loading ${title}` : "Loading page"}
      className="select-none"
      limitMainContentWidth={limitMainContentWidth}
      toolbar={
        <PageStageToolbar
          saving={false}
          pending={true}
          historyPanelActive={false}
          limitMainContentWidth={limitMainContentWidth}
          showRawContent={false}
          onCopyDeeplink={() => undefined}
          onDelete={() => undefined}
          onToggleContentWidth={() => undefined}
          onToggleShowRawContent={() => undefined}
          onToggleHistoryPanel={() => undefined}
          breadcrumb={breadcrumb}
        />
      }
    >
      <PageStageContentLayout
        title={<PageTitlePlaceholder title={title} />}
        body={<PageStageBodyPlaceholder seed={title ?? "untitled"} />}
      />
    </PageStageFrame>
  );
}
