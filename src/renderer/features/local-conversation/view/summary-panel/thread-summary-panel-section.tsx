import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { ChevronDownIcon } from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { CODEX_SUMMARY_PANEL_TRANSITION } from "../../../../lib/codex-panel-motion";
import { useResolvedReducedMotion } from "../../../../lib/use-reduced-motion";
import { cn } from "../../../../lib/utils";

export const THREAD_SUMMARY_PANEL_SECTION_EXPANDED_STORAGE_PREFIX =
  "thread-summary-panel-section-expanded-";
export const THREAD_SUMMARY_PANEL_SECTION_AUTO_COLLAPSE_MS = 30_000;

type ThreadSummaryPanelSectionMode = "accordion" | "dropdown" | "headerless";
type ThreadSummaryPanelSectionAutoCollapseState = "pending" | "collapsed" | "canceled";
type ThreadSummaryPanelSectionAfter = ReactNode | ((state: { isExpanded: boolean }) => ReactNode);

export interface ThreadSummaryPanelSectionHandle {
  collapse: () => void;
  expand: () => void;
}

interface ThreadSummaryPanelSectionHeaderProps {
  after?: ReactNode;
  children: ReactNode;
  isExpanded: boolean;
  mode: ThreadSummaryPanelSectionMode;
  onChange?: (option: string) => void;
  onToggle: () => void;
  sectionOptions?: readonly string[];
  shouldUseReducedMotion: boolean;
  titleSuffix?: ReactNode;
}

export interface ThreadSummaryPanelSectionProps {
  sectionKey: string;
  title: ReactNode;
  titleSuffix?: ReactNode;
  after?: ThreadSummaryPanelSectionAfter;
  children: ReactNode;
  mode?: ThreadSummaryPanelSectionMode;
  sectionOptions?: readonly string[];
  defaultCollapsed?: boolean;
  autoCollapse?: boolean;
  onChange?: (option: string) => void;
}

function getSectionExpandedStorageKey(sectionKey: string): string {
  return `${THREAD_SUMMARY_PANEL_SECTION_EXPANDED_STORAGE_PREFIX}${sectionKey}`;
}

function getLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readPersistedSectionExpanded(sectionKey: string): boolean | null {
  const storage = getLocalStorage();
  if (!storage) return null;

  const value = storage.getItem(getSectionExpandedStorageKey(sectionKey));
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function writePersistedSectionExpanded(sectionKey: string, isExpanded: boolean) {
  const storage = getLocalStorage();
  if (!storage) return;

  storage.setItem(getSectionExpandedStorageKey(sectionKey), String(isExpanded));
}

function ThreadSummaryPanelSectionHeader({
  after,
  children,
  isExpanded,
  mode,
  onChange,
  onToggle,
  sectionOptions,
  shouldUseReducedMotion,
  titleSuffix,
}: ThreadSummaryPanelSectionHeaderProps) {
  const hasDropdownOptions = Boolean(sectionOptions && sectionOptions.length > 1);
  const handleToggle = mode === "accordion" ? onToggle : undefined;
  const collapsedTitleSuffix = isExpanded ? null : titleSuffix;
  const chevron =
    mode === "accordion" || hasDropdownOptions ? (
      <ChevronDownIcon
        aria-hidden="true"
        className={cn(
          "icon-2xs shrink-0 group-hover/section-toggle:opacity-100 group-focus-visible/section-toggle:opacity-100",
          !shouldUseReducedMotion && "transition-transform",
          isExpanded ? "opacity-0 rotate-0" : "opacity-100 -rotate-90",
        )}
      />
    ) : null;
  const button = (
    <button
      aria-expanded={isExpanded}
      className="group/section-toggle -ms-[3.5px] inline-flex min-w-0 flex-1 cursor-interaction items-center gap-1 rounded-xl py-0.5 ps-[3.5px] pe-1 text-start focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      onClick={handleToggle}
      type="button"
    >
      <span className="truncate">{children}</span>
      {collapsedTitleSuffix}
      {chevron}
    </button>
  );
  const trigger =
    mode === "dropdown" && hasDropdownOptions ? (
      <NodexDropdownMenu triggerButton={button}>
        {sectionOptions?.map((option) => (
          <NodexDropdownItem key={option} onSelect={() => onChange?.(option)}>
            {option}
          </NodexDropdownItem>
        ))}
      </NodexDropdownMenu>
    ) : (
      button
    );

  return (
    <header className="sticky top-2 z-10 flex h-7 w-full min-w-0 items-center justify-start gap-2 bg-token-dropdown-background ps-5 pe-3.5 pb-0.5 text-sm font-normal text-token-text-secondary before:pointer-events-none before:absolute before:inset-x-0 before:-top-2 before:h-2 before:bg-token-dropdown-background before:content-['']">
      {trigger}
      {after == null ? null : <div className="relative flex shrink-0">{after}</div>}
    </header>
  );
}

export const ThreadSummaryPanelSection = forwardRef<
  ThreadSummaryPanelSectionHandle,
  ThreadSummaryPanelSectionProps
>(function ThreadSummaryPanelSection(
  {
    sectionKey,
    title,
    titleSuffix,
    after,
    children,
    mode = "accordion",
    sectionOptions,
    defaultCollapsed = false,
    autoCollapse,
    onChange,
  },
  ref,
) {
  const prefersReducedMotion = useResolvedReducedMotion();
  const configuredReducedMotion = useReducedMotionConfig();
  const shouldUseReducedMotion = Boolean(prefersReducedMotion || configuredReducedMotion);
  const [persistedExpanded, setPersistedExpanded] = useState<boolean | null>(() =>
    readPersistedSectionExpanded(sectionKey),
  );
  const [autoCollapseState, setAutoCollapseState] =
    useState<ThreadSummaryPanelSectionAutoCollapseState>("pending");
  const autoCollapseActive = autoCollapse != null && autoCollapseState !== "canceled";
  const isExpanded =
    !(autoCollapse === true && autoCollapseState === "collapsed") &&
    (persistedExpanded ?? !defaultCollapsed);
  const shouldRenderContent = mode === "headerless" || isExpanded || mode === "dropdown";

  useEffect(() => {
    setPersistedExpanded(readPersistedSectionExpanded(sectionKey));
    setAutoCollapseState("pending");
  }, [sectionKey]);

  const setExpanded = useCallback(
    (nextExpanded: boolean) => {
      setPersistedExpanded(nextExpanded);
      writePersistedSectionExpanded(sectionKey, nextExpanded);
    },
    [sectionKey],
  );

  useImperativeHandle(
    ref,
    () => ({
      collapse: () => setExpanded(false),
      expand: () => setExpanded(true),
    }),
    [setExpanded],
  );

  useEffect(() => {
    if (!autoCollapseActive) return undefined;
    if (!autoCollapse) {
      if (autoCollapseState === "collapsed") setAutoCollapseState("pending");
      return undefined;
    }
    if (autoCollapseState !== "pending") return undefined;

    const timeoutId = window.setTimeout(() => {
      setAutoCollapseState("collapsed");
    }, THREAD_SUMMARY_PANEL_SECTION_AUTO_COLLAPSE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [autoCollapse, autoCollapseActive, autoCollapseState, sectionKey]);

  const cancelAutoCollapse = useCallback(() => {
    if (!autoCollapseActive) return;
    setAutoCollapseState("canceled");
  }, [autoCollapseActive]);

  const resolvedAfter = typeof after === "function" ? after({ isExpanded }) : after;

  const header =
    mode === "headerless" ? null : (
      <ThreadSummaryPanelSectionHeader
        after={resolvedAfter}
        isExpanded={isExpanded}
        mode={mode}
        onChange={onChange}
        onToggle={() => {
          if (mode !== "dropdown") setExpanded(!isExpanded);
        }}
        sectionOptions={sectionOptions}
        shouldUseReducedMotion={shouldUseReducedMotion}
        titleSuffix={titleSuffix}
      >
        {title}
      </ThreadSummaryPanelSectionHeader>
    );

  const staticContent = (
    <div className="relative z-0 mt-0.5 overflow-hidden">
      <div className="flex min-w-0 flex-col gap-0.5 px-5">{children}</div>
    </div>
  );
  const content = shouldUseReducedMotion ? (
    shouldRenderContent && staticContent
  ) : (
    <AnimatePresence initial={false}>
      {shouldRenderContent ? (
        <motion.div
          key="content"
          initial={{ height: 0, opacity: 0, marginTop: 0 }}
          animate={{ height: "auto", opacity: 1, marginTop: 2 }}
          exit={{ height: 0, opacity: 0, marginTop: 0 }}
          transition={CODEX_SUMMARY_PANEL_TRANSITION}
          className="relative z-0 overflow-hidden"
        >
          <div className="flex min-w-0 flex-col gap-0.5 px-5">{children}</div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );

  return (
    <section
      className={cn(
        "relative z-0 flex flex-col pb-2 after:absolute after:inset-x-5 after:bottom-0 after:h-[0.5px] after:bg-token-border-default after:content-[''] last:after:hidden",
        mode === "accordion" && !isExpanded ? "last:pb-0.5" : "last:pb-0",
      )}
      onClick={autoCollapseActive ? cancelAutoCollapse : undefined}
    >
      {header}
      {content}
    </section>
  );
});
