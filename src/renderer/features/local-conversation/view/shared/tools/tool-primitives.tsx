import { useIntl } from "@/lib/i18n";
import { registerContentSearchRevealOwner } from "../../../../content-search/content-search-reveal-owner";
import { createContext, useCallback, useContext, useId, useMemo, useState } from "react";
import type { ReactNode, Ref } from "react";
import { ChevronRightIcon } from "@/components/shared/icons";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { AnimatePresence, motion, useIsPresent } from "motion/react";
import { cn } from "../../../../../lib/utils";
import type { SemanticActivityStatus } from "../../../../../lib/semantic-activity-status";
import { buildTextPreview, INLINE_TEXT_PREVIEW_MAX_CHARS } from "../../../../../lib/text-preview";
import { ToolCallCodePanel } from "./tool-call-inspection";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "../thread-motion";
import { CodexShimmerProvider } from "../codex-shimmer-text";

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
  id,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
}) {
  return (
    <span id={id} className={cn("font-sans inline-flex min-w-0 items-center gap-2", className)}>
      {children}
    </span>
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
  ref?: Ref<HTMLDivElement>;
  testId?: string;
}

export function ThreadActivityShell({
  body,
  className,
  header,
  ref,
  testId,
}: ThreadActivityShellProps) {
  return (
    <div ref={ref} className="min-w-0 text-size-chat relative overflow-visible py-0">
      <div data-testid={testId} className={cn("flex min-w-0 flex-col", className)}>
        {header}
        {body}
      </div>
    </div>
  );
}

export interface ThreadActivitySummaryTextProps {
  children: ReactNode;
  className?: string;
}

export function ThreadActivitySummaryText({ children, className }: ThreadActivitySummaryTextProps) {
  return (
    <span
      className={cn(
        "text-token-conversation-body flex min-w-0 max-w-full items-center truncate",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A named object inside an activity sentence: quiet like the sentence, marked as openable. */
export const ACTIVITY_INLINE_LINK_CLASS_NAME =
  "pointer-events-auto inline-block max-w-full cursor-interaction truncate align-bottom text-inherit underline decoration-dotted decoration-[0.5px] underline-offset-2 group-hover/activity-header:!text-token-foreground hover:!text-token-foreground";

/** Owns summary text across tool rows and group headers; icons and accessories stay outside. */
export function ThreadActivitySummaryLabel({
  children,
  className,
  id,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  interactive?: boolean;
}) {
  return (
    <span
      id={id}
      className={cn(
        "min-w-0 flex-1 truncate [--agent-activity-summary-color:var(--color-text-tertiary)] text-(--agent-activity-summary-color) [&_[data-codex-shimmer]]:align-top [&_*:not(button)]:!text-(--agent-activity-summary-color)",
        // File references wrap their labels; preserve the button's independent hover tone.
        "[&_[data-agent-activity-file-link]_*]:!text-inherit",
        interactive &&
          "[@media(hover:hover)]:group-[:hover:not(:has([data-agent-activity-file-link]:hover))]/activity-header:[--agent-activity-summary-color:var(--color-text)]",
        className,
      )}
    >
      {children}
    </span>
  );
}

/**
 * A disclosure header whose whole row is one toggle. The transparent button covers the row so
 * links and buttons inside the label keep their own clicks; the chevron trails the content.
 * Without a disclosure the same row renders without its toggle, so gaining one later never
 * remounts the label.
 */
export function ThreadActivityDisclosureHeader({
  accessibleLabel,
  accessory,
  children,
  className,
  disclosure,
  inspector,
  labelId,
  testId,
  toggleTestId,
}: {
  accessibleLabel?: string;
  accessory?: ReactNode;
  children: ReactNode;
  className?: string;
  disclosure?: ThreadActivityDisclosureState;
  /** A control at the row's end, above its disclosure target and revealed by the row's hover. */
  inspector?: ReactNode;
  /** The element that names the toggle when there is no accessible label. */
  labelId?: string;
  testId?: string;
  toggleTestId?: string;
}) {
  const contentId = useId();
  return (
    <div
      className={cn(
        "group/activity-header relative inline-flex max-w-full min-w-0 items-center gap-1 self-start",
        className,
      )}
      data-testid={testId}
    >
      {disclosure ? (
        <button
          type="button"
          aria-label={accessibleLabel}
          aria-labelledby={accessibleLabel === undefined ? (labelId ?? contentId) : undefined}
          aria-expanded={disclosure.expanded}
          className="absolute inset-0 cursor-interaction rounded-md focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:ring-inset focus-visible:outline-none"
          data-testid={toggleTestId}
          onClick={disclosure.onToggle}
        />
      ) : null}
      <ThreadActivityHeaderContent
        id={labelId === undefined ? contentId : undefined}
        className={cn(
          "text-size-chat relative shrink truncate",
          disclosure &&
            "pointer-events-none [&_a]:pointer-events-auto [&_button]:pointer-events-auto",
        )}
      >
        {children}
      </ThreadActivityHeaderContent>
      {accessory}
      {disclosure ? (
        <span className="pointer-events-none relative flex">
          <ThreadActivityChevron expanded={disclosure.expanded} />
        </span>
      ) : null}
      {inspector}
    </div>
  );
}

export function ThreadRichActivityHeader({
  accessibleLabel,
  accessory,
  className,
  disclosure,
  icon,
  inspector,
  summary,
  summaryClassName,
  testId,
}: {
  accessibleLabel?: string;
  accessory?: ReactNode;
  className?: string;
  disclosure?: ThreadActivityDisclosureState;
  icon: ReactNode;
  /** A control at the row's end, above its disclosure target and revealed by the row's hover. */
  inspector?: ReactNode;
  summary: ReactNode;
  summaryClassName?: string;
  testId?: string;
}) {
  const summaryId = useId();
  const content = (
    <>
      <span className="contents text-(--color-text-tertiary)">{icon}</span>
      <ThreadActivitySummaryLabel
        id={disclosure ? summaryId : undefined}
        className={summaryClassName}
        interactive={disclosure !== undefined}
      >
        {summary}
      </ThreadActivitySummaryLabel>
    </>
  );

  return (
    <ThreadActivityDisclosureHeader
      accessibleLabel={accessibleLabel}
      accessory={accessory}
      className={className}
      disclosure={disclosure}
      inspector={inspector}
      labelId={summaryId}
      testId={testId}
    >
      {content}
    </ThreadActivityDisclosureHeader>
  );
}

/* ------------------------------------------------------------------ */
/*  Disclosure body                                                    */
/* ------------------------------------------------------------------ */

function ThreadActivityRegionPanel({
  children,
  className,
  reducedMotion,
  testId,
}: {
  children: ReactNode;
  className?: string;
  reducedMotion: boolean;
  testId?: string;
}) {
  // A closing body keeps its height animation but leaves the tab order and pointer at once.
  const isPresent = useIsPresent();
  return (
    <motion.div
      aria-hidden={!isPresent}
      inert={!isPresent}
      className={cn("overflow-hidden", !isPresent && "pointer-events-none", className)}
      data-testid={testId}
      initial={reducedMotion ? false : { height: 0, opacity: 0 }}
      animate={{
        height: "auto",
        opacity: 1,
        overflow: "hidden",
        transitionEnd: { overflow: "visible" },
      }}
      exit={{ height: 0, opacity: 0, overflow: "hidden" }}
      transition={reducedMotion ? { duration: 0 } : CODEX_THREAD_ACCORDION_TRANSITION}
      style={{ overflow: "hidden" }}
    >
      {children}
    </motion.div>
  );
}

/**
 * The body of an activity disclosure. It exists only while open, grows to its natural height,
 * and settles with visible overflow so nested popovers and focus rings are never clipped.
 */
export function ThreadActivityDisclosureRegion({
  children,
  className,
  expanded,
  testId,
}: {
  children: ReactNode;
  className?: string;
  expanded: boolean;
  testId?: string;
}) {
  const reducedMotion = useResolvedReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {expanded ? (
        <ThreadActivityRegionPanel
          key="activity-region"
          className={className}
          reducedMotion={reducedMotion}
          testId={testId}
        >
          {children}
        </ThreadActivityRegionPanel>
      ) : null}
    </AnimatePresence>
  );
}

const ThreadActivityStepContext = createContext(false);

/** Whether a row is a step inside a work group, where it reads as terse as a log line. */
export function useIsThreadActivityStep(): boolean {
  return useContext(ThreadActivityStepContext);
}

/** Indents content under a hairline that starts beneath the glyph of the row above it. */
const ACTIVITY_RAIL_CLASS_NAME =
  "relative ps-6 pt-3 before:pointer-events-none before:absolute before:start-2 before:top-3 before:bottom-0 before:border-s before:border-(--color-border) before:content-['']";

/**
 * What a row reveals when opened. On its own it hangs from a hairline under the row's glyph, like
 * a work group's steps; inside those steps it sits flush under its row, so a list never nests a
 * second rail.
 */
export function ThreadActivityDetails({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const isStep = useIsThreadActivityStep();
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-3", !isStep && ACTIVITY_RAIL_CLASS_NAME, className)}
    >
      {children}
    </div>
  );
}

/**
 * The steps of a work group: an indented list hanging from a hairline that starts under the
 * header icon. It grows with its rows; only an individual row's own output may scroll. The group
 * header speaks for running work, so steps never shimmer.
 */
export function ThreadActivitySteps({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn("flex min-w-0 flex-col gap-3", ACTIVITY_RAIL_CLASS_NAME, className)}
      data-activity-steps=""
    >
      <ThreadActivityStepContext.Provider value>
        <CodexShimmerProvider enabled={false}>{children}</CodexShimmerProvider>
      </ThreadActivityStepContext.Provider>
    </div>
  );
}

export interface ThreadActivityDisclosureProps {
  accessibleLabel?: string;
  /** Rendered beside the summary, outside its muted text treatment. */
  accessory?: ReactNode;
  inspector?: ReactNode;
  autoExpandWhileRunning?: boolean;
  bodyClassName?: string;
  bodyTestId?: string;
  canExpand?: boolean;
  children: ReactNode | ((expanded: boolean) => ReactNode);
  className?: string;
  defaultExpanded?: boolean;
  indentContent?: boolean;
  headerClassName?: string;
  headerTestId?: string;
  icon?: ReactNode;
  onExpand?: () => void;
  revealForSearch?: boolean;
  /** Live content shown under the header while the body is collapsed. */
  preview?: ReactNode;
  status: SemanticActivityStatus;
  summary: ReactNode | ((expanded: boolean) => ReactNode);
  summaryClassName?: string;
  testId?: string;
}

/** Local open state that search can reveal while the body is closed and unmounted. */
export function useThreadActivityDisclosureState(input: {
  autoExpandWhileRunning?: boolean;
  canExpand: boolean;
  defaultExpanded?: boolean;
  isRunning: boolean;
  onExpand?: () => void;
  revealForSearch?: boolean;
}) {
  const [manuallyCollapsed, setManuallyCollapsed] = useState(false);
  const [normallyExpanded, setNormallyExpanded] = useState(input.defaultExpanded ?? false);
  const shouldUseRunningExpansion = input.autoExpandWhileRunning === true && input.isRunning;
  const expanded =
    input.canExpand && (shouldUseRunningExpansion ? !manuallyCollapsed : normallyExpanded);
  const { onExpand } = input;

  const toggle = () => {
    if (!expanded) onExpand?.();
    if (shouldUseRunningExpansion) {
      setManuallyCollapsed((current) => !current);
      return;
    }
    setNormallyExpanded((current) => !current);
  };
  const revealForSearch = input.revealForSearch === true && input.canExpand && !expanded;
  const bindRevealOwner = useCallback(
    (element: HTMLElement | null) => {
      if (!element || !revealForSearch) return;
      return registerContentSearchRevealOwner(element, () => {
        if (shouldUseRunningExpansion) setManuallyCollapsed(false);
        else setNormallyExpanded(true);
      });
    },
    [revealForSearch, shouldUseRunningExpansion],
  );

  return {
    bindRevealOwner,
    disclosure: input.canExpand ? { expanded, onToggle: toggle } : undefined,
    expanded,
  };
}

export function ThreadActivityDisclosure({
  accessibleLabel,
  accessory,
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
  inspector,
  onExpand,
  revealForSearch = false,
  preview,
  status,
  summary,
  summaryClassName,
  testId,
}: ThreadActivityDisclosureProps) {
  const hasBody = canExpand && children !== null && children !== undefined;
  const { bindRevealOwner, disclosure, expanded } = useThreadActivityDisclosureState({
    autoExpandWhileRunning,
    canExpand: hasBody,
    defaultExpanded,
    isRunning: status === "running",
    onExpand,
    revealForSearch,
  });
  const summaryNode = typeof summary === "function" ? summary(expanded) : summary;
  const header =
    icon === undefined ? (
      <ThreadActivityHeader
        className={headerClassName}
        disclosure={disclosure}
        testId={headerTestId}
      >
        <ThreadActivitySummaryText className={summaryClassName}>
          {summaryNode}
        </ThreadActivitySummaryText>
      </ThreadActivityHeader>
    ) : (
      <ThreadRichActivityHeader
        accessibleLabel={accessibleLabel}
        accessory={accessory}
        className={headerClassName}
        disclosure={disclosure}
        icon={icon}
        inspector={inspector}
        summary={summaryNode}
        summaryClassName={summaryClassName}
        testId={headerTestId}
      />
    );

  return (
    <ThreadActivityShell
      ref={bindRevealOwner}
      body={
        <>
          {expanded ? null : preview}
          {hasBody ? (
            <ThreadActivityDisclosureRegion expanded={expanded} testId={bodyTestId}>
              <div
                className={cn("flex flex-col gap-3 pt-3", indentContent && "ps-6", bodyClassName)}
              >
                {typeof children === "function" ? children(expanded) : children}
              </div>
            </ThreadActivityDisclosureRegion>
          ) : null}
        </>
      }
      className={className}
      header={header}
      testId={testId}
    />
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

export function ToolErrorDetail({
  error,
  className,
  showLabel = true,
}: {
  error: string;
  className?: string;
  showLabel?: boolean;
}) {
  const intl = useIntl();
  return (
    <div className={className}>
      {showLabel ? (
        <DetailLabel>
          {intl.formatMessage({ id: "conversation.toolPrimitives.error", defaultMessage: "Error" })}
        </DetailLabel>
      ) : null}
      <div className="rounded-md border border-(--destructive)/35 bg-(--destructive)/10 px-2.5 py-2 text-xs wrap-break-word text-(--destructive)">
        {error}
      </div>
    </div>
  );
}

export function CodeBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <pre
      className={cn(
        "codex-tool-code scrollbar-token max-h-80 overflow-auto rounded-md border border-(--border) bg-(--background) px-2.5 py-2 font-mono text-size-code wrap-break-word whitespace-pre-wrap",
        className,
      )}
    >
      {children}
    </pre>
  );
}

/** The title names the value's role when one is known, otherwise its format. */
export function JsonBlock({ title = "json", value }: { title?: string; value: unknown }) {
  const text = useMemo(() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }, [value]);

  return (
    <ToolCallCodePanel
      title={title}
      preview={buildTextPreview(text, INLINE_TEXT_PREVIEW_MAX_CHARS)}
      getCopyText={() => text}
      getFullText={() => text}
      preClassName="codex-tool-code font-mono text-size-code"
    />
  );
}
