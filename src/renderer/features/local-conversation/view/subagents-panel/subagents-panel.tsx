import { BackIcon } from "@/components/shared/icons";
import { useEffect, useCallback, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  useCodexAppServerControl,
  useConversationChildMemberships,
  useConversationSubset,
  useConversationTurns,
  useThreadSummarySubset,
} from "../../local-conversation-store";
import { buildBackgroundSubagentRows } from "../../projection/background-subagent-row-model";
import type { ThreadComposerShellBackgroundAgentRowModel } from "../../thread-stage-types";
import { SubagentAvatar } from "../shared/subagent-avatar";
import type {
  CodexConversationChildMembership,
  CodexThreadSummary,
} from "../../../../../shared/types";

const ACTIVE_PAGE_SIZE = 4;
const DONE_PAGE_SIZE = 10;
const RELATIVE_TIME_REFRESH_MS = 30_000;

function mergeUniqueThreadIds(...groups: readonly (readonly string[])[]): string[] {
  return Array.from(new Set(groups.flat()));
}

function resolveSummaryDisplayName(summary: CodexThreadSummary): string {
  const displayName =
    summary.agentNickname?.trim() || summary.threadName?.trim() || summary.threadId;
  return displayName.startsWith("@") ? displayName.slice(1) : displayName;
}

function buildPanelMembershipFromSummary(
  summary: CodexThreadSummary,
  rootThreadId: string,
  showInlineActivity: boolean,
): CodexConversationChildMembership {
  const displayName = resolveSummaryDisplayName(summary);
  return {
    threadId: summary.threadId,
    parentThreadId: summary.source?.parentThreadId ?? rootThreadId,
    role: "backgroundChild",
    actorName: displayName,
    displayName,
    agentRole: summary.agentRole,
    agentPath: summary.agentPath,
    createdAtMs: summary.createdAt,
    updatedAtMs: summary.updatedAt,
    statusType: summary.statusType,
    showInlineActivity,
    thread: {
      displayName,
      name: summary.threadName,
      nickname: summary.agentNickname,
      model: summary.modelProvider,
      agentRole: summary.agentRole,
    },
  };
}

export function buildSubagentsPanelMemberships(input: {
  discoveredThreadIds: readonly string[];
  memberships: readonly CodexConversationChildMembership[];
  rootThreadId: string;
  summaries: Record<string, CodexThreadSummary>;
}): CodexConversationChildMembership[] {
  const membershipById = new Map(
    input.memberships.map((membership) => [membership.threadId, membership] as const),
  );
  const hasInlineActivity =
    input.memberships.some((membership) => membership.showInlineActivity) ||
    Object.values(input.summaries).some((summary) => Boolean(summary.agentPath));
  for (const threadId of input.discoveredThreadIds) {
    if (membershipById.has(threadId)) continue;
    const summary = input.summaries[threadId];
    if (!summary) continue;
    membershipById.set(
      threadId,
      buildPanelMembershipFromSummary(
        summary,
        input.rootThreadId,
        Boolean(summary.agentPath) || hasInlineActivity,
      ),
    );
  }
  return Array.from(membershipById.values());
}

export function formatSubagentRelativeTime(timestampMs: number, nowMs = Date.now()): string {
  const elapsedMs = Math.max(0, nowMs - timestampMs);
  if (elapsedMs < 60_000) return "now";
  if (elapsedMs < 3_600_000) return `${Math.floor(elapsedMs / 60_000)}m`;
  if (elapsedMs < 86_400_000) return `${Math.floor(elapsedMs / 3_600_000)}h`;
  return `${Math.floor(elapsedMs / 86_400_000)}d`;
}

function useRelativeTime(timestampMs: number): string {
  const [nowMs, setNowMs] = useState(Date.now);
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(Date.now()), RELATIVE_TIME_REFRESH_MS);
    return () => window.clearInterval(interval);
  }, []);
  return formatSubagentRelativeTime(timestampMs, nowMs);
}

function SubagentRelativeTime({ timestampMs }: { timestampMs: number }) {
  const label = useRelativeTime(timestampMs);
  return (
    <time
      dateTime={new Date(timestampMs).toISOString()}
      className="shrink-0 text-token-text-tertiary"
    >
      {label}
    </time>
  );
}

function SubagentOverviewRow({
  onSelect,
  previewLineCount,
  row,
}: {
  onSelect: (row: ThreadComposerShellBackgroundAgentRowModel) => void;
  previewLineCount: 1 | 2;
  row: ThreadComposerShellBackgroundAgentRowModel;
}) {
  const preview =
    row.lastAssistantMessage ??
    row.statusSummary ??
    (row.status === "active" ? "Working" : row.status === "waiting" ? "Thinking" : null);
  return (
    <button
      type="button"
      className="flex min-h-8 w-full cursor-interaction items-start gap-2 rounded-md px-1 py-1 text-left hover:bg-token-bg-secondary focus-visible:bg-token-bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2"
      onClick={() => onSelect(row)}
    >
      <SubagentAvatar seed={row.conversationId} className="mt-0.5 size-6" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-sm">
          <span className="min-w-0 flex-1 truncate text-token-foreground">{row.displayName}</span>
          {row.lastAssistantMessageAtMs === null ? null : (
            <SubagentRelativeTime timestampMs={row.lastAssistantMessageAtMs} />
          )}
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
    </button>
  );
}

function PaginatedSubagentOverviewSection({
  className,
  emptyState,
  onSelect,
  onVisibleRowsChange,
  pageSize,
  previewLineCount,
  rows,
  title,
}: {
  className?: string;
  emptyState?: string;
  onSelect: (row: ThreadComposerShellBackgroundAgentRowModel) => void;
  onVisibleRowsChange: (rows: readonly ThreadComposerShellBackgroundAgentRowModel[]) => void;
  pageSize: number;
  previewLineCount: 1 | 2;
  rows: readonly ThreadComposerShellBackgroundAgentRowModel[];
  title: string;
}) {
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const visibleRows = useMemo(() => rows.slice(0, visibleCount), [rows, visibleCount]);

  useEffect(() => setVisibleCount(pageSize), [pageSize, rows.length]);
  useEffect(() => {
    onVisibleRowsChange(visibleRows);
  }, [onVisibleRowsChange, visibleRows]);

  return (
    <section className={className}>
      <h2 className="mb-2 text-sm text-token-text-tertiary">{title}</h2>
      {rows.length === 0 && emptyState ? (
        <div className="py-1 text-sm text-token-text-tertiary">{emptyState}</div>
      ) : (
        <div className="flex flex-col gap-1">
          {visibleRows.map((row) => (
            <SubagentOverviewRow
              key={row.conversationId}
              row={row}
              previewLineCount={previewLineCount}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
      {visibleCount < rows.length ? (
        <button
          type="button"
          className="mt-2 ml-9 cursor-interaction rounded-md px-1 text-sm text-token-text-secondary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={() => setVisibleCount((current) => current + pageSize)}
        >
          Show more
        </button>
      ) : null}
    </section>
  );
}

export function SubagentsPanelOverview({
  onError,
  onSelect,
  projectId,
  rootThreadId,
}: {
  onError: (message: string) => void;
  onSelect: (row: ThreadComposerShellBackgroundAgentRowModel) => void;
  projectId: string;
  rootThreadId: string;
}) {
  const turns = useConversationTurns(rootThreadId);
  const memberships = useConversationChildMemberships(rootThreadId);
  const [discoveredThreadIds, setDiscoveredThreadIds] = useState<string[]>([]);
  const childThreadIds = useMemo(
    () =>
      mergeUniqueThreadIds(
        memberships.map((membership) => membership.threadId),
        discoveredThreadIds,
      ),
    [discoveredThreadIds, memberships],
  );
  const summaries = useThreadSummarySubset(rootThreadId, childThreadIds);
  const children = useConversationSubset(childThreadIds);
  const panelMemberships = useMemo(
    () =>
      buildSubagentsPanelMemberships({
        discoveredThreadIds,
        memberships,
        rootThreadId,
        summaries,
      }),
    [discoveredThreadIds, memberships, rootThreadId, summaries],
  );
  const rows = useMemo(
    () =>
      buildBackgroundSubagentRows({
        childMemberships: panelMemberships,
        knownConversationsById: children,
        parentTurns: turns,
      }).filter((row) => row.showInlineActivity),
    [children, panelMemberships, turns],
  );
  const codexControl = useCodexAppServerControl(projectId);
  const hydrateSubagentPanel = codexControl.hydrateSubagentPanel;
  const requestedPreviewIds = useRef(new Set<string>());

  useEffect(() => {
    void hydrateSubagentPanel({ rootThreadId })
      .then((discovered) => {
        setDiscoveredThreadIds(discovered.map((summary) => summary.threadId));
      })
      .catch(() => {
        onError("Unable to load subagents");
      });
  }, [hydrateSubagentPanel, onError, rootThreadId]);

  const hydrateVisibleRows = useCallback(
    (visibleRows: readonly ThreadComposerShellBackgroundAgentRowModel[]) => {
      const threadIds = visibleRows
        .filter(
          (row) =>
            row.lastAssistantMessage === null &&
            !requestedPreviewIds.current.has(row.conversationId),
        )
        .map((row) => row.conversationId);
      if (threadIds.length === 0) return;
      for (const threadId of threadIds) requestedPreviewIds.current.add(threadId);
      void hydrateSubagentPanel({
        rootThreadId,
        threadIds,
        includeTail: true,
      }).catch(() => {
        for (const threadId of threadIds) requestedPreviewIds.current.delete(threadId);
        onError("Unable to load subagent previews");
      });
    },
    [hydrateSubagentPanel, onError, rootThreadId],
  );

  return (
    <SubagentsPanelOverviewContent
      rootThreadId={rootThreadId}
      rows={rows}
      onSelect={onSelect}
      onVisibleRowsChange={hydrateVisibleRows}
    />
  );
}

export function SubagentsPanelOverviewContent({
  onSelect,
  onVisibleRowsChange,
  rootThreadId,
  rows,
}: {
  onSelect: (row: ThreadComposerShellBackgroundAgentRowModel) => void;
  onVisibleRowsChange: (rows: readonly ThreadComposerShellBackgroundAgentRowModel[]) => void;
  rootThreadId: string;
  rows: readonly ThreadComposerShellBackgroundAgentRowModel[];
}) {
  const activeRows = rows.filter((row) => row.status !== "done");
  const doneRows = rows.filter((row) => row.status === "done");
  return (
    <div
      className="h-full min-h-0 overflow-y-auto px-3 py-5"
      data-subagents-panel-overview={rootThreadId}
    >
      <PaginatedSubagentOverviewSection
        emptyState="No active subagents"
        onSelect={onSelect}
        onVisibleRowsChange={onVisibleRowsChange}
        pageSize={ACTIVE_PAGE_SIZE}
        previewLineCount={2}
        rows={activeRows}
        title="Active"
      />
      {doneRows.length > 0 ? (
        <PaginatedSubagentOverviewSection
          className="mt-6"
          onSelect={onSelect}
          onVisibleRowsChange={onVisibleRowsChange}
          pageSize={DONE_PAGE_SIZE}
          previewLineCount={1}
          rows={doneRows}
          title={`Done · ${doneRows.length}`}
        />
      ) : null}
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
