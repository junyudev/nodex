import { BackIcon } from "@/components/shared/icons";
import { subscribeCodexEvents } from "@/lib/api";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT,
  CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT,
} from "../../../../../shared/codex-subagent-overview";
import type {
  CodexSubagentOverviewRow,
  CodexSubagentOverviewSection,
  CodexSubagentOverviewWindow,
} from "../../../../../shared/types";
import { useCodexAppServerControl } from "../../local-conversation-store";
import { SubagentAvatar } from "../shared/subagent-avatar";

const ACTIVE_CLOCK_INTERVAL_MS = 1_000;
const OVERVIEW_INVALIDATION_COALESCE_MS = 50;

type SubagentSectionId = "active" | "done";

const EMPTY_EXPANDED_SECTIONS: ReadonlySet<SubagentSectionId> = new Set();

function ignoreSubagentSectionToggle(): void {}

function normalizePreviewText(value: string): string {
  return value
    .replace(/\s+/gu, " ")
    .replace(/^\s*(?:>\s*|#{1,6}\s+|(?:[-*+]|\d+\.)\s+)*/u, "")
    .trim();
}

export function formatSubagentObjective(value: string | null): string | null {
  if (!value) return null;
  const normalized = normalizePreviewText(value);
  if (!normalized) return null;
  if (normalized.length <= 60) return normalized;
  return `${normalized.slice(0, 59).trimEnd()}…`;
}

export function formatSubagentElapsedTime(elapsedMs: number): string {
  const elapsedSeconds = Math.max(0, Math.floor(elapsedMs / 1_000));
  if (elapsedSeconds < 60) return `${elapsedSeconds}s`;
  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m`;
  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h`;
  return `${Math.floor(elapsedHours / 24)}d`;
}

export function formatSubagentRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - timestampMs);
  if (elapsedMs < 60_000) return "now";
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h`;
  return `${Math.floor(elapsedMs / 86_400_000)}d`;
}

function sectionCountLabel(section: CodexSubagentOverviewSection): string {
  return section.totalCount === null ? `${section.knownCount}+` : String(section.totalCount);
}

function sectionHasMore(section: CodexSubagentOverviewSection, initialLimit: number): boolean {
  if (section.continuation !== null) return true;
  const count = section.totalCount ?? section.knownCount;
  return count > initialLimit || section.rows.length > initialLimit;
}

function resolveRowPreview(row: CodexSubagentOverviewRow): string | null {
  const objective = formatSubagentObjective(row.objective);
  if (objective) return objective;
  if (row.statusSummary?.trim()) return row.statusSummary.trim();
  return row.status === "active" ? "Working" : null;
}

function SubagentOverviewTrailing({
  doneClockMs,
  nowMs,
  row,
}: {
  doneClockMs: number;
  nowMs: number;
  row: CodexSubagentOverviewRow;
}) {
  const elapsedMs =
    (row.status !== "active" && row.status !== "waiting") || row.startedAtMs === null
      ? null
      : Math.max(0, nowMs - row.startedAtMs);
  const completedAtMs = row.completedAtMs ?? row.lastActivityAtMs;

  return (
    <span className="flex shrink-0 items-center gap-3 whitespace-nowrap text-xs text-token-text-tertiary tabular-nums">
      {row.status === "waiting" ? <span>Waiting</span> : null}
      {row.status === "unknown" ? <span>Status unavailable</span> : null}
      {elapsedMs === null ? null : <span>{formatSubagentElapsedTime(elapsedMs)}</span>}
      {row.status === "done" && completedAtMs !== null ? (
        <time dateTime={new Date(completedAtMs).toISOString()}>
          {formatSubagentRelativeTime(completedAtMs, doneClockMs)} ago
        </time>
      ) : null}
    </span>
  );
}

function SubagentOverviewRowView({
  doneClockMs,
  nowMs,
  onSelect,
  previewLineCount,
  row,
}: {
  doneClockMs: number;
  nowMs: number;
  onSelect: (row: CodexSubagentOverviewRow) => void;
  previewLineCount: 1 | 2;
  row: CodexSubagentOverviewRow;
}) {
  const preview = resolveRowPreview(row);
  const className =
    "flex min-h-10 w-full items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-token-bg-secondary focus-visible:bg-token-bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2";
  const content = (
    <>
      <SubagentAvatar seed={row.threadId} className="size-6 shrink-0" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-token-foreground">{row.displayName}</span>
          <SubagentOverviewTrailing row={row} nowMs={nowMs} doneClockMs={doneClockMs} />
        </span>
        {preview ? (
          <span
            className={cn(
              "block text-sm leading-5 text-token-text-secondary",
              previewLineCount === 2 ? "line-clamp-2" : "truncate",
            )}
          >
            {preview}
          </span>
        ) : null}
      </span>
    </>
  );

  if (!row.canOpen) {
    return (
      <div className={cn(className, "cursor-default")} data-subagent-overview-unavailable="true">
        {content}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-label={`Open subagent ${row.displayName}`}
      className={cn(className, "cursor-interaction")}
      onClick={() => onSelect(row)}
    >
      {content}
    </button>
  );
}

function SubagentOverviewSectionView({
  className,
  doneClockMs,
  emptyState,
  expanded,
  initialLimit,
  nowMs,
  onSelect,
  onToggleExpanded,
  previewLineCount,
  section,
  sectionId,
  title,
  titleTrailing,
}: {
  className?: string;
  doneClockMs: number;
  emptyState?: string;
  expanded: boolean;
  initialLimit: number;
  nowMs: number;
  onSelect: (row: CodexSubagentOverviewRow) => void;
  onToggleExpanded: (sectionId: SubagentSectionId, expanded: boolean) => void;
  previewLineCount: 1 | 2;
  section: CodexSubagentOverviewSection;
  sectionId: SubagentSectionId;
  title: string;
  titleTrailing?: string | null;
}) {
  const visibleRows = expanded ? section.rows : section.rows.slice(0, initialLimit);
  const hasMore = sectionHasMore(section, initialLimit);

  return (
    <section className={className} data-subagent-overview-section={sectionId}>
      <h2 className="mb-2 flex min-w-0 items-center justify-between gap-3 px-2 text-sm text-token-text-tertiary">
        <span className="truncate">{title}</span>
        {titleTrailing ? (
          <span className="flex min-w-0 shrink items-center gap-1.5 truncate text-xs tabular-nums">
            {titleTrailing}
          </span>
        ) : null}
      </h2>
      {section.rows.length === 0 && emptyState ? (
        <div className="px-2 py-1 text-sm text-token-text-tertiary">{emptyState}</div>
      ) : (
        <div className="flex flex-col gap-1" data-slot="thread-summary-panel-item-group">
          {visibleRows.map((row) => (
            <SubagentOverviewRowView
              key={row.threadId}
              row={row}
              nowMs={nowMs}
              doneClockMs={doneClockMs}
              previewLineCount={previewLineCount}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {hasMore ? (
        <button
          type="button"
          className="mt-2 ml-10 cursor-interaction rounded-md px-1 text-sm text-token-text-secondary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={() => onToggleExpanded(sectionId, !expanded)}
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      ) : null}
    </section>
  );
}

function isSubagentOverviewInvalidationEvent(
  event: { type: string; rootThreadId?: string },
  rootThreadId: string,
): boolean {
  return event.type === "subagentOverviewInvalidated" && event.rootThreadId === rootThreadId;
}

export function SubagentsPanelOverview({
  onError,
  onSelect,
  projectId,
  rootThreadId,
}: {
  onError: (message: string) => void;
  onSelect: (row: CodexSubagentOverviewRow) => void;
  projectId: string;
  rootThreadId: string;
}) {
  const codexControl = useCodexAppServerControl(projectId);
  const readSubagentOverview = codexControl.readSubagentOverview;
  const [overview, setOverview] = useState<CodexSubagentOverviewWindow | null>(null);
  const [expandedSections, setExpandedSections] = useState<ReadonlySet<SubagentSectionId>>(
    () => new Set(),
  );
  const requestSequenceRef = useRef(0);
  const expandedSectionsRef = useRef(expandedSections);
  const onErrorRef = useRef(onError);
  const overviewRef = useRef(overview);
  expandedSectionsRef.current = expandedSections;
  onErrorRef.current = onError;
  overviewRef.current = overview;

  const loadOverview = useCallback(
    async (mode: "initial" | "expanded", showFailure: boolean): Promise<boolean> => {
      const requestSequence = ++requestSequenceRef.current;
      try {
        const next = await readSubagentOverview({ rootThreadId, mode });
        if (requestSequence !== requestSequenceRef.current || next.rootThreadId !== rootThreadId) {
          return false;
        }
        setOverview((current) => {
          if (
            next.completeness === "incomplete" &&
            current?.completeness === "complete" &&
            current.generation === next.generation
          ) {
            return current;
          }
          if (
            current &&
            current.generation === next.generation &&
            current.revision > next.revision
          ) {
            return current;
          }
          return next;
        });
        return true;
      } catch {
        if (requestSequence !== requestSequenceRef.current) return false;
        if (showFailure || overviewRef.current === null) {
          onErrorRef.current("Unable to load subagents");
        }
        return false;
      }
    },
    [readSubagentOverview, rootThreadId],
  );

  useEffect(() => {
    setExpandedSections(new Set());
    setOverview(null);
    void loadOverview("initial", true);
  }, [loadOverview, rootThreadId]);

  useEffect(() => {
    let timer: number | null = null;
    const unsubscribe = subscribeCodexEvents((event) => {
      if (!isSubagentOverviewInvalidationEvent(event, rootThreadId) || timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        void loadOverview(expandedSectionsRef.current.size > 0 ? "expanded" : "initial", false);
      }, OVERVIEW_INVALIDATION_COALESCE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [loadOverview, rootThreadId]);

  const toggleExpanded = useCallback(
    (sectionId: SubagentSectionId, expanded: boolean) => {
      if (expanded) {
        void loadOverview("expanded", true).then((loaded) => {
          if (!loaded) return;
          setExpandedSections((current) => new Set(current).add(sectionId));
        });
        return;
      }

      const next = new Set(expandedSectionsRef.current);
      next.delete(sectionId);
      setExpandedSections(next);
      if (next.size === 0) void loadOverview("initial", false);
    },
    [loadOverview],
  );

  if (!overview) {
    return (
      <div
        className="h-full min-h-0 overflow-y-auto px-3 py-5"
        data-subagents-panel-overview={rootThreadId}
      >
        <div className="mx-auto w-full max-w-[var(--thread-content-max-width)] px-2 text-sm text-token-text-tertiary">
          Loading subagents…
        </div>
      </div>
    );
  }

  return (
    <SubagentsPanelOverviewContent
      rootThreadId={rootThreadId}
      overview={overview}
      expandedSections={expandedSections}
      onSelect={onSelect}
      onToggleExpanded={toggleExpanded}
    />
  );
}

export function SubagentsPanelOverviewContent({
  expandedSections = EMPTY_EXPANDED_SECTIONS,
  onSelect,
  onToggleExpanded = ignoreSubagentSectionToggle,
  overview,
  rootThreadId,
}: {
  expandedSections?: ReadonlySet<SubagentSectionId>;
  onSelect: (row: CodexSubagentOverviewRow) => void;
  onToggleExpanded?: (sectionId: SubagentSectionId, expanded: boolean) => void;
  overview: CodexSubagentOverviewWindow;
  rootThreadId: string;
}) {
  const hasLiveRows = overview.active.rows.some(
    (row) => row.status === "active" || row.status === "waiting",
  );
  const [nowMs, setNowMs] = useState(Date.now);
  const doneClockMsRef = useRef(Date.now());

  useEffect(() => {
    if (!hasLiveRows) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), ACTIVE_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [hasLiveRows]);

  const waitingCount = overview.active.rows.filter((row) => row.status === "waiting").length;
  const doneCount = overview.done.totalCount ?? overview.done.knownCount;

  return (
    <div
      className="h-full min-h-0 overflow-y-auto px-3 py-5"
      data-subagents-panel-overview={rootThreadId}
      data-subagents-overview-revision={overview.revision}
    >
      <div className="mx-auto w-full max-w-[var(--thread-content-max-width)]">
        <SubagentOverviewSectionView
          doneClockMs={doneClockMsRef.current}
          emptyState="No active subagents"
          expanded={expandedSections.has("active")}
          initialLimit={CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT}
          nowMs={nowMs}
          onSelect={onSelect}
          onToggleExpanded={onToggleExpanded}
          previewLineCount={1}
          section={overview.active}
          sectionId="active"
          title={`Active · ${sectionCountLabel(overview.active)}`}
          titleTrailing={waitingCount > 0 ? `${waitingCount} waiting` : null}
        />
        {doneCount > 0 ? (
          <SubagentOverviewSectionView
            className="mt-6"
            doneClockMs={doneClockMsRef.current}
            expanded={expandedSections.has("done")}
            initialLimit={CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT}
            nowMs={nowMs}
            onSelect={onSelect}
            onToggleExpanded={onToggleExpanded}
            previewLineCount={1}
            section={overview.done}
            sectionId="done"
            title={`Done · ${sectionCountLabel(overview.done)}`}
          />
        ) : null}
      </div>
    </div>
  );
}

export function SubagentsPanelDetailHeader({
  displayName,
  onBack,
  threadId,
}: {
  displayName: string;
  onBack: () => void;
  threadId: string;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-token-border-heavy px-4">
      <button
        type="button"
        aria-label="Back to subagents"
        className="flex size-6 cursor-interaction items-center justify-center rounded-md text-token-text-secondary hover:bg-token-bg-secondary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={onBack}
      >
        <BackIcon className="icon-xs" />
      </button>
      <SubagentAvatar seed={threadId} className="size-6" />
      <div className="min-w-0 flex-1 truncate text-sm font-medium text-token-foreground">
        {displayName}
      </div>
    </div>
  );
}
