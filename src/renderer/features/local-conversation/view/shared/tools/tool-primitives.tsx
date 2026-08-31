import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { ChevronRightIcon } from "@/components/shared/icons";
import { readResizeObserverBorderBoxSize } from "@/lib/resize-observer-size";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { motion } from "motion/react";
import { cn } from "../../../../../lib/utils";
import { semanticActivitySummaryClassName } from "../../../../../lib/semantic-activity-status";
import type { SemanticActivityStatus } from "../../../../../lib/semantic-activity-status";
import { buildTextPreview, INLINE_TEXT_PREVIEW_MAX_CHARS } from "../../../../../lib/text-preview";
import { ToolCallCodePanel } from "./tool-call-inspection";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "../thread-motion";

const THREAD_ACTIVITY_SUMMARY_DEFER_MS = 1000;

/* ------------------------------------------------------------------ */
/*  ThreadActivityShell                                                */
/* ------------------------------------------------------------------ */

export interface ThreadActivityDisclosureState {
  expanded: boolean;
  onToggle: () => void;
}

export interface ThreadActivityHeaderProps {
  accessory?: ReactNode;
  children: ReactNode;
  className?: string;
  disclosure?: ThreadActivityDisclosureState;
  testId?: string;
}

export function ThreadActivityChevron({ expanded }: { expanded: boolean }) {
  const reducedMotion = useResolvedReducedMotion();
  return (
    <ChevronRightIcon
      aria-hidden="true"
      className={cn(
        "icon-2xs shrink-0 text-token-conversation-body opacity-0",
        !reducedMotion && "transition-transform duration-relaxed",
        "group-focus-visible/activity-header:text-token-foreground group-focus-visible/activity-header:opacity-100",
        "group-has-[:focus-visible]/activity-header:text-token-foreground group-has-[:focus-visible]/activity-header:opacity-100",
        "[@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:opacity-100",
        expanded && "rotate-90 opacity-100",
      )}
    />
  );
}

function ThreadActivityHeaderContent({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>{children}</span>
  );
}

export function ThreadActivityHeader({
  accessory,
  children,
  className,
  disclosure,
  testId,
}: ThreadActivityHeaderProps) {
  const content = (
    <>
      <ThreadActivityHeaderContent className="text-size-chat shrink truncate">
        {children}
      </ThreadActivityHeaderContent>
      {accessory}
      {disclosure ? <ThreadActivityChevron expanded={disclosure.expanded} /> : null}
    </>
  );
  const headerClassName = cn(
    "group/activity-header inline-flex min-w-0 max-w-full self-start items-center gap-1 p-0 text-left",
    disclosure && "cursor-interaction",
    className,
  );

  if (!disclosure) {
    return (
      <div className={headerClassName} data-testid={testId}>
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      className={headerClassName}
      data-testid={testId}
      aria-expanded={disclosure.expanded}
      onClick={disclosure.onToggle}
    >
      {content}
    </button>
  );
}

export interface ThreadActivityShellProps {
  body?: ReactNode;
  className?: string;
  header: ReactNode;
  testId?: string;
}

export function ThreadActivityShell({ body, className, header, testId }: ThreadActivityShellProps) {
  return (
    <div className="min-w-0 text-size-chat relative overflow-visible py-0">
      <div data-testid={testId} className={cn("flex min-w-0 flex-col", className)}>
        {header}
        {body}
      </div>
    </div>
  );
}

export type ThreadActivitySummaryTransition = "static" | "immediate" | "deferred";

interface ThreadActivitySummaryTransitionState {
  key: string;
  node: ReactNode;
}

interface ThreadActivitySummaryTransitionProps {
  summary: ReactNode;
  summaryKey: string;
  summaryTransition: Exclude<ThreadActivitySummaryTransition, "static">;
}

function ThreadActivitySummaryTransitionNode({
  summary,
  summaryKey,
  summaryTransition,
}: ThreadActivitySummaryTransitionProps) {
  const [renderedSummary, setRenderedSummary] = useState<ThreadActivitySummaryTransitionState>(
    () => ({
      key: summaryKey,
      node: summary,
    }),
  );
  const lastCommitAtRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);

  useEffect(() => {
    const now = Date.now();
    lastCommitAtRef.current ??= now;
    if (summaryKey === renderedSummary.key) return;

    const nextSummary = {
      key: summaryKey,
      node: summary,
    };
    const commit = () => {
      timeoutRef.current = null;
      lastCommitAtRef.current = Date.now();
      setRenderedSummary(nextSummary);
    };

    if (summaryTransition === "immediate") {
      if (timeoutRef.current !== null) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      commit();
      return;
    }

    const remainingMs = THREAD_ACTIVITY_SUMMARY_DEFER_MS - (now - lastCommitAtRef.current);
    if (remainingMs <= 0) {
      commit();
      return;
    }

    timeoutRef.current = window.setTimeout(commit, remainingMs);
    return () => {
      if (timeoutRef.current === null) return;
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    };
  }, [renderedSummary.key, summary, summaryKey, summaryTransition]);

  return (
    <span className="flex min-h-4 max-w-full min-w-0 items-center truncate">
      {summaryTransition === "immediate" || renderedSummary.key === summaryKey
        ? summary
        : renderedSummary.node}
    </span>
  );
}

export interface ThreadActivitySummaryTextProps {
  children: ReactNode;
  className?: string;
  summaryKey?: string | null;
  summaryTransition?: ThreadActivitySummaryTransition;
}

export function ThreadActivitySummaryText({
  children,
  className,
  summaryKey,
  summaryTransition = "static",
}: ThreadActivitySummaryTextProps) {
  const content =
    summaryKey == null || summaryTransition === "static" ? (
      children
    ) : (
      <ThreadActivitySummaryTransitionNode
        summary={children}
        summaryKey={summaryKey}
        summaryTransition={summaryTransition}
      />
    );

  return (
    <span
      className={cn(
        "text-token-conversation-body flex min-w-0 max-w-full items-center truncate",
        className,
      )}
    >
      {content}
    </span>
  );
}

export interface ThreadActivityDisclosureProps {
  accessibleLabel?: string;
  autoExpandWhileRunning?: boolean;
  bodyClassName?: string;
  bodyTestId?: string;
  canExpand?: boolean;
  children: ReactNode;
  className?: string;
  defaultExpanded?: boolean;
  indentContent?: boolean;
  headerClassName?: string;
  headerTestId?: string;
  icon?: ReactNode;
  onExpand?: () => void;
  shouldAnimateInitialCollapse?: boolean;
  status: SemanticActivityStatus;
  summary: ReactNode;
  summaryClassName?: string;
  summaryKey?: string | null;
  summaryTransition?: ThreadActivitySummaryTransition;
  testId?: string;
}

function useMeasuredThreadActivityBodyHeight(): {
  elementHeightPx: number;
  elementRef: (element: HTMLDivElement | null) => void;
} {
  const [elementHeightPx, setElementHeightPx] = useState(0);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const updateHeight = useCallback((height: number) => {
    setElementHeightPx((current) => (current === height ? current : height));
  }, []);
  const elementRef = useCallback(
    (element: HTMLDivElement | null) => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      if (!element) return;

      updateHeight(element.scrollHeight);
      if (typeof ResizeObserver === "undefined") return;

      const resizeObserver = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (!entry) return;
        updateHeight(readResizeObserverBorderBoxSize(entry).height);
      });
      resizeObserver.observe(element);
      resizeObserverRef.current = resizeObserver;
    },
    [updateHeight],
  );

  useEffect(
    () => () => {
      resizeObserverRef.current?.disconnect();
    },
    [],
  );

  return { elementHeightPx, elementRef };
}

export function ThreadRichActivityHeader({
  accessibleLabel,
  accessory,
  className,
  disclosure,
  icon,
  summary,
  summaryClassName,
  status,
  testId,
}: {
  accessibleLabel?: string;
  accessory?: ReactNode;
  className?: string;
  disclosure?: ThreadActivityDisclosureState;
  icon: ReactNode;
  summary: ReactNode;
  summaryClassName?: string;
  status: SemanticActivityStatus;
  testId?: string;
}) {
  const summaryId = useId();
  const content = (
    <>
      <span className={cn("contents", semanticActivitySummaryClassName(status))}>{icon}</span>
      <span
        id={disclosure ? summaryId : undefined}
        className={cn(
          "min-w-0 flex-1 truncate [&_[data-codex-shimmer]]:align-top",
          semanticActivitySummaryClassName(status),
          disclosure &&
            "[@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:!text-token-foreground [@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:[&_*:not(button)]:!text-token-foreground",
          summaryClassName,
        )}
      >
        {summary}
      </span>
    </>
  );

  if (!disclosure) {
    return (
      <ThreadActivityHeader className={cn("max-w-full", className)} testId={testId}>
        {content}
      </ThreadActivityHeader>
    );
  }

  return (
    <div
      className={cn(
        "group/activity-header relative inline-flex max-w-full min-w-0 items-center gap-1 self-start",
        className,
      )}
      data-testid={testId}
    >
      <button
        type="button"
        aria-label={accessibleLabel}
        aria-labelledby={accessibleLabel === undefined ? summaryId : undefined}
        aria-expanded={disclosure.expanded}
        className="absolute inset-0 cursor-interaction focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:ring-inset focus-visible:outline-none"
        onClick={disclosure.onToggle}
      />
      <ThreadActivityHeaderContent className="text-size-chat pointer-events-none relative shrink truncate [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
        {content}
      </ThreadActivityHeaderContent>
      {accessory}
      <span className="pointer-events-none relative flex">
        <ThreadActivityChevron expanded={disclosure.expanded} />
      </span>
    </div>
  );
}

export function ThreadActivityDisclosure({
  accessibleLabel,
  autoExpandWhileRunning = false,
  bodyClassName,
  bodyTestId,
  canExpand = true,
  children,
  className,
  defaultExpanded = false,
  indentContent = true,
  headerClassName,
  headerTestId,
  icon,
  onExpand,
  status,
  summary,
  summaryClassName,
  summaryKey,
  summaryTransition,
  testId,
}: ThreadActivityDisclosureProps) {
  const hasBody = canExpand && children !== null && children !== undefined;
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
  const [normallyExpanded, setNormallyExpanded] = useState(defaultExpanded);
  const { elementHeightPx, elementRef } = useMeasuredThreadActivityBodyHeight();
  const isRunning = status === "running";
  const shouldUseRunningExpansion = autoExpandWhileRunning && isRunning;
  const expanded = hasBody && (shouldUseRunningExpansion ? !manuallyCollapsed : normallyExpanded);

  const handleToggle = () => {
    if (!expanded) onExpand?.();
    if (shouldUseRunningExpansion) {
      setManuallyCollapsed((current) => !current);
      return;
    }
    setNormallyExpanded((current) => !current);
  };

  const disclosure = hasBody ? { expanded, onToggle: handleToggle } : undefined;
  const header =
    icon === undefined ? (
      <ThreadActivityHeader
        className={headerClassName}
        disclosure={disclosure}
        testId={headerTestId}
      >
        <ThreadActivitySummaryText
          className={summaryClassName}
          summaryKey={summaryKey}
          summaryTransition={summaryTransition}
        >
          {summary}
        </ThreadActivitySummaryText>
      </ThreadActivityHeader>
    ) : (
      <ThreadRichActivityHeader
        accessibleLabel={accessibleLabel}
        className={headerClassName}
        disclosure={disclosure}
        icon={icon}
        summary={summary}
        summaryClassName={summaryClassName}
        status={status}
        testId={headerTestId}
      />
    );
  const body = hasBody ? (
    <motion.div
      initial={false}
      animate={{
        height: expanded ? elementHeightPx : 0,
        opacity: expanded ? 1 : 0,
      }}
      aria-hidden={!expanded}
      inert={!expanded}
      className={expanded ? "overflow-visible" : "overflow-hidden"}
      data-testid={bodyTestId}
      style={{ pointerEvents: expanded ? "auto" : "none" }}
      transition={CODEX_THREAD_ACCORDION_TRANSITION}
    >
      <div
        ref={elementRef}
        className={cn("flex flex-col gap-2 pt-2 pb-1", indentContent && "ps-6", bodyClassName)}
      >
        {children}
      </div>
    </motion.div>
  ) : null;

  return <ThreadActivityShell body={body} className={className} header={header} testId={testId} />;
}

export type ThreadActivityListViewState = "preview" | "collapsed" | "expanded";

export interface ThreadActivityListItem {
  key: string;
  node: ReactNode;
}

export type ThreadActivityListMaxHeightByState = Record<
  ThreadActivityListViewState,
  CSSProperties["maxHeight"]
>;

export const THREAD_ACTIVITY_LIST_20_REM_MAX_HEIGHT_BY_STATE = {
  preview: "20rem",
  expanded: "20rem",
  collapsed: "0px",
} satisfies ThreadActivityListMaxHeightByState;

export const THREAD_ACTIVITY_LIST_7_TO_20_REM_MAX_HEIGHT_BY_STATE = {
  preview: "7rem",
  expanded: "20rem",
  collapsed: "0px",
} satisfies ThreadActivityListMaxHeightByState;

export interface ThreadActivityListProps {
  allowHorizontalScroll?: boolean;
  autoScrollToBottom?: boolean;
  className?: string;
  contentClassName?: string;
  disableMaxHeight?: boolean;
  items: readonly ThreadActivityListItem[];
  maxHeightByState: ThreadActivityListMaxHeightByState;
  testId?: string;
  viewState?: ThreadActivityListViewState;
}

export function ThreadActivityList({
  allowHorizontalScroll = false,
  autoScrollToBottom = true,
  className,
  contentClassName,
  disableMaxHeight = false,
  items,
  maxHeightByState,
  testId,
  viewState = "preview",
}: ThreadActivityListProps) {
  const maxHeight = maxHeightByState[viewState];
  const style = disableMaxHeight ? undefined : { maxHeight };
  const renderedItems =
    viewState === "collapsed" ? null : items.map((item) => <div key={item.key}>{item.node}</div>);

  return (
    <div
      className={cn(
        "vertical-scroll-fade-mask [--edge-fade-distance:1.5rem] overflow-y-auto",
        autoScrollToBottom && "flex flex-col-reverse",
        !allowHorizontalScroll && "overflow-x-hidden",
        className,
      )}
      data-testid={testId}
      style={style}
    >
      <div
        className={cn("flex flex-col gap-1", contentClassName, viewState === "preview" && "pb-1")}
      >
        {renderedItems}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared primitives (kept for expanded body sections)                */
/* ------------------------------------------------------------------ */

export function DetailLabel({ children }: { children: ReactNode }) {
  return (
    <div className="mb-1 text-xs font-semibold tracking-wide text-(--foreground-tertiary) uppercase">
      {children}
    </div>
  );
}

export function ToolJsonDetail({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="mb-2">
      <DetailLabel>{label}</DetailLabel>
      <JsonBlock value={value} />
    </div>
  );
}

export function ToolErrorDetail({
  error,
  className,
  showLabel = true,
}: {
  error: string;
  className?: string;
  showLabel?: boolean;
}) {
  return (
    <div className={className}>
      {showLabel ? <DetailLabel>Error</DetailLabel> : null}
      <div className="rounded-md border border-(--destructive)/35 bg-(--destructive)/10 px-2.5 py-2 text-xs text-(--destructive)">
        {error}
      </div>
    </div>
  );
}

export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "codex-tool-code scrollbar-token max-h-80 overflow-auto rounded-md border border-(--border) bg-(--background) px-2.5 py-2 font-mono text-xs/normal wrap-break-word whitespace-pre-wrap",
        className,
      )}
    >
      {children}
    </pre>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  return (
    <ToolCallCodePanel
      title="json"
      preview={buildTextPreview(text, INLINE_TEXT_PREVIEW_MAX_CHARS)}
      getCopyText={() => text}
      getFullText={() => text}
      preClassName="font-mono text-xs/normal"
    />
  );
}
