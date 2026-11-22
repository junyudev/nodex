import { getIntl, useIntl, type IntlShape } from "@/lib/i18n";
import { BackIcon, DelegationMapIcon, ListLayoutIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { IntelligenceModeIndicatorIcon } from "@/components/shared/agent-runtime/intelligence-controls";
import { subscribeCodexEvents } from "@/lib/api";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "@/lib/utils";
import {
  CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT,
  CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT,
} from "../../../../../shared/codex-subagent-overview";
import type {
  CodexSubagentOverviewSection,
  CodexSubagentOverviewWindow,
} from "../../../../../shared/types";
import {
  subagentAttentionLabel,
  type SubagentOverviewRow as CodexSubagentOverviewRow,
} from "../../agent-runtime-subagent-overview";
import { useCodexAppServerControl } from "../../local-conversation-store";
import type { ConversationAgent } from "../../../../../shared/conversation-identity";
import type { CodexSpeed } from "../../../../../shared/codex-service-tier";
import { AgentIdentity } from "../shared/agent-identity";
import { SubagentAvatar, SubagentGlyphIcon } from "../shared/subagent-avatar";
import { DelegationMap, type DelegationMapMore } from "./delegation-map";
import { summarizeDelegation } from "./delegation-map-model";
import {
  formatSubagentElapsedTime,
  formatSubagentObjective,
  formatSubagentRelativeTime,
} from "./subagent-overview-format";
import { useSubagentsOverviewView, type SubagentsOverviewView } from "./subagents-overview-view";

const ACTIVE_CLOCK_INTERVAL_MS = 1_000;
const OVERVIEW_INVALIDATION_COALESCE_MS = 50;

type SubagentSectionId = "active" | "done";

const EMPTY_EXPANDED_SECTIONS: ReadonlySet<SubagentSectionId> = new Set();

function ignoreSubagentSectionToggle(): void {}

function sectionCountLabel(intl: IntlShape, section: CodexSubagentOverviewSection): string {
  return section.totalCount === null
    ? `${intl.formatNumber(section.knownCount)}+`
    : intl.formatNumber(section.totalCount);
}

function sectionHasMore(section: CodexSubagentOverviewSection, initialLimit: number): boolean {
  if (section.continuation !== null) return true;
  const count = section.totalCount ?? section.knownCount;
  return count > initialLimit || section.rows.length > initialLimit;
}

/** The rows a section presents now, and whether the overview holds more of it. */
function shownSection(
  section: CodexSubagentOverviewSection,
  input: { expanded: boolean; initialLimit: number; paged: boolean },
): { rows: readonly CodexSubagentOverviewRow[]; hasMore: boolean } {
  return {
    rows: input.paged || input.expanded ? section.rows : section.rows.slice(0, input.initialLimit),
    hasMore: input.paged
      ? section.continuation !== null
      : sectionHasMore(section, input.initialLimit),
  };
}

function resolveRowPreview(intl: IntlShape, row: CodexSubagentOverviewRow): string | null {
  const objective = formatSubagentObjective(row.objective);
  if (objective) return objective;
  if (row.attentionKind) return null;
  if (row.statusSummary?.trim()) return row.statusSummary.trim();
  return row.status === "done"
    ? null
    : intl.formatMessage({ id: "conversation.subagentsPanel.working", defaultMessage: "Working" });
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
  const intl = useIntl();
  const elapsedMs =
    row.status === "done" || row.startedAtMs === null ? null : Math.max(0, nowMs - row.startedAtMs);
  const completedAtMs = row.lastAssistantMessageAtMs ?? row.recencyAtMs ?? null;

  return (
    <span className="flex shrink-0 items-center gap-3 whitespace-nowrap text-xs text-token-text-tertiary tabular-nums">
      {row.attentionKind ? (
        <span>{subagentAttentionLabel(row.attentionKind, intl)}</span>
      ) : row.status === "waiting" ? (
        <span>
          {intl.formatMessage({
            id: "conversation.subagentsPanel.waiting",
            defaultMessage: "Waiting",
          })}
        </span>
      ) : null}
      {row.status === "unknown" ? (
        <span>
          {intl.formatMessage({
            id: "conversation.subagentsPanel.unavailable",
            defaultMessage: "Status unavailable",
          })}
        </span>
      ) : null}
      {elapsedMs === null ? null : <span>{formatSubagentElapsedTime(elapsedMs, intl)}</span>}
      {row.status === "done" && completedAtMs !== null ? (
        <time dateTime={new Date(completedAtMs).toISOString()}>
          {doneClockMs - completedAtMs < 60_000
            ? intl.formatMessage({
                id: "conversation.subagentsPanel.justNow",
                defaultMessage: "now ago",
              })
            : intl.formatMessage(
                { id: "conversation.subagentsPanel.relativeTime", defaultMessage: "{time} ago" },
                { time: formatSubagentRelativeTime(completedAtMs, doneClockMs, intl) },
              )}
        </time>
      ) : null}
    </span>
  );
}

function SubagentOverviewRowView({
  doneClockMs,
  nowMs,
  onSelect,
  onStop,
  isStopping,
  previewLineCount,
  row,
}: {
  doneClockMs: number;
  nowMs: number;
  onSelect: (row: CodexSubagentOverviewRow) => void;
  onStop?: (row: CodexSubagentOverviewRow) => void;
  isStopping?: (row: CodexSubagentOverviewRow) => boolean;
  previewLineCount: 1 | 2;
  row: CodexSubagentOverviewRow;
}) {
  const intl = useIntl();
  const preview = resolveRowPreview(intl, row);
  const className =
    "flex min-h-10 min-w-0 flex-1 items-start gap-3 rounded-lg px-2 py-2 text-left hover:bg-token-bg-secondary focus-visible:bg-token-bg-secondary focus-visible:outline-2 focus-visible:outline-offset-2";
  const content = (
    <>
      {row.identityThreadId === null ? (
        <SubagentGlyphIcon className="size-6 shrink-0" />
      ) : (
        <SubagentAvatar seed={row.identityThreadId} className="size-6 shrink-0" />
      )}
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2 text-sm">
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 truncate text-token-foreground">{row.displayName}</span>
            <AgentIdentity
              agent={row.agent}
              className="min-w-0 shrink-[3] text-token-text-tertiary"
            />
          </span>
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
  const live = row.status === "active" || row.status === "waiting";
  const stopping = live && isStopping?.(row) === true;
  const stop =
    onStop && row.canStop === true && live ? (
      stopping ? (
        <span className="shrink-0 px-1 py-2 text-xs text-token-text-tertiary" role="status">
          {intl.formatMessage({
            id: "conversation.subagentsPanel.stopping",
            defaultMessage: "Stopping…",
          })}
        </span>
      ) : (
        <button
          type="button"
          aria-label={intl.formatMessage(
            { id: "conversation.subagentsPanel.stopAgent", defaultMessage: "Stop {name}" },
            { name: row.displayName },
          )}
          onClick={() => onStop(row)}
          className="shrink-0 cursor-interaction px-1 py-2 text-xs text-token-text-tertiary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {intl.formatMessage({ id: "conversation.subagentsPanel.stop", defaultMessage: "Stop" })}
        </button>
      )
    ) : null;

  return (
    <div className="flex min-w-0 items-start gap-1">
      {row.canOpen ? (
        <button
          type="button"
          aria-label={intl.formatMessage(
            {
              id: "conversation.subagentsPanel.openSubagent",
              defaultMessage: "Open subagent {name}",
            },
            { name: row.displayName },
          )}
          className={cn(className, "cursor-interaction")}
          onClick={() => onSelect(row)}
        >
          {content}
        </button>
      ) : (
        <div className={cn(className, "cursor-default")} data-subagent-overview-unavailable="true">
          {content}
        </div>
      )}
      {stop}
    </div>
  );
}

function SubagentOverviewSectionView({
  className,
  doneClockMs,
  emptyState,
  expanded,
  shown,
  nowMs,
  onSelect,
  onStop,
  isStopping,
  onToggleExpanded,
  onLoadMore,
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
  shown: ReturnType<typeof shownSection>;
  nowMs: number;
  onSelect: (row: CodexSubagentOverviewRow) => void;
  onStop?: (row: CodexSubagentOverviewRow) => void;
  isStopping?: (row: CodexSubagentOverviewRow) => boolean;
  onToggleExpanded: (sectionId: SubagentSectionId, expanded: boolean) => void;
  onLoadMore?: (sectionId: SubagentSectionId) => void;
  previewLineCount: 1 | 2;
  section: CodexSubagentOverviewSection;
  sectionId: SubagentSectionId;
  title: string;
  titleTrailing?: string | null;
}) {
  const intl = useIntl();
  const { rows: visibleRows, hasMore } = shown;

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
              onStop={onStop}
              isStopping={isStopping}
            />
          ))}
        </div>
      )}
      {hasMore ? (
        <button
          type="button"
          className="mt-2 ml-10 cursor-interaction rounded-md px-1 text-sm text-token-text-secondary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
          onClick={() =>
            onLoadMore ? onLoadMore(sectionId) : onToggleExpanded(sectionId, !expanded)
          }
        >
          {!onLoadMore && expanded
            ? intl.formatMessage({
                id: "conversation.subagentsPanel.showLess",
                defaultMessage: "Show less",
              })
            : intl.formatMessage({
                id: "conversation.subagentsPanel.showMore",
                defaultMessage: "Show more",
              })}
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

export function SubagentsPanelOverview(
  props: ComponentProps<typeof SubagentsPanelOverviewInstance>,
) {
  return <SubagentsPanelOverviewInstance key={props.rootThreadId} {...props} />;
}

function SubagentsPanelOverviewInstance({
  onError,
  onSelect,
  rootThreadId,
}: {
  onError: (message: string) => void;
  onSelect: (row: CodexSubagentOverviewRow) => void;
  projectId: string | null;
  rootThreadId: string;
}) {
  const intl = useIntl();
  const codexControl = useCodexAppServerControl(rootThreadId);
  const readSubagentOverview = codexControl.readSubagentOverview;
  const [overview, setOverview] = useState<CodexSubagentOverviewWindow | null>(null);
  const [expandedSections, setExpandedSections] = useState<ReadonlySet<SubagentSectionId>>(
    () => new Set(),
  );
  const requestSequenceRef = useRef(0);
  const overviewLoadInFlightRef = useRef(false);
  const pendingOverviewReloadRef = useRef(false);
  const expandedSectionsRef = useRef(expandedSections);
  const onErrorRef = useRef(onError);
  const overviewRef = useRef(overview);
  useLayoutEffect(() => {
    expandedSectionsRef.current = expandedSections;
    onErrorRef.current = onError;
    overviewRef.current = overview;
  }, [expandedSections, onError, overview]);

  const loadOverview = useCallback(
    (mode: "initial" | "expanded", showFailure: boolean): Promise<boolean> => {
      function readOverview(mode: "initial" | "expanded", showFailure: boolean): Promise<boolean> {
        if (overviewLoadInFlightRef.current) {
          pendingOverviewReloadRef.current = true;
          return Promise.resolve(false);
        }
        overviewLoadInFlightRef.current = true;
        const requestSequence = ++requestSequenceRef.current;
        return readSubagentOverview({ rootThreadId, mode })
          .then((next) => {
            if (
              requestSequence !== requestSequenceRef.current ||
              next.rootThreadId !== rootThreadId
            ) {
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
          })
          .catch(() => {
            if (requestSequence !== requestSequenceRef.current) return false;
            if (showFailure || overviewRef.current === null) {
              onErrorRef.current(
                getIntl().formatMessage({
                  id: "conversation.subagentsPanel.loadError",
                  defaultMessage: "Unable to load subagents",
                }),
              );
            }
            return false;
          })
          .finally(() => {
            overviewLoadInFlightRef.current = false;
            if (pendingOverviewReloadRef.current) {
              pendingOverviewReloadRef.current = false;
              void readOverview(
                expandedSectionsRef.current.size > 0 ? "expanded" : "initial",
                false,
              );
            }
          });
      }
      return readOverview(mode, showFailure);
    },
    [readSubagentOverview, rootThreadId],
  );

  useEffect(() => {
    void loadOverview("initial", true);
    return () => {
      requestSequenceRef.current += 1;
      pendingOverviewReloadRef.current = false;
    };
  }, [loadOverview]);

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
          {intl.formatMessage({
            id: "conversation.subagentsPanel.loading",
            defaultMessage: "Loading subagents…",
          })}
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

const VIEW_OPTIONS = [
  { view: "map", Icon: DelegationMapIcon },
  { view: "list", Icon: ListLayoutIcon },
] as const;

/** How the overview draws a work tree: as a map of who delegated what, or as a list by status. */
function SubagentsOverviewViewToggle({
  view,
  onChange,
}: {
  view: SubagentsOverviewView;
  onChange: (view: SubagentsOverviewView) => void;
}) {
  const intl = useIntl();
  const labels: Record<SubagentsOverviewView, string> = {
    map: intl.formatMessage({ id: "conversation.subagentsPanel.viewMap", defaultMessage: "Map" }),
    list: intl.formatMessage({
      id: "conversation.subagentsPanel.viewList",
      defaultMessage: "List",
    }),
  };
  return (
    <div
      role="radiogroup"
      aria-label={intl.formatMessage({
        id: "conversation.subagentsPanel.view",
        defaultMessage: "View",
      })}
      className="flex items-center gap-0.5"
    >
      {VIEW_OPTIONS.map(({ view: option, Icon }) => (
        <NodexTooltip key={option} tooltipContent={labels[option]}>
          <button
            type="button"
            role="radio"
            aria-checked={view === option}
            aria-label={labels[option]}
            className={cn(
              "flex size-6 cursor-interaction items-center justify-center rounded-md focus-visible:outline-2 focus-visible:outline-offset-2",
              view === option
                ? "bg-token-foreground/5 text-token-foreground"
                : "text-token-text-tertiary hover:bg-token-foreground/5 hover:text-token-foreground",
            )}
            onClick={() => onChange(option)}
          >
            <Icon className="size-4" />
          </button>
        </NodexTooltip>
      ))}
    </div>
  );
}

export function SubagentsPanelOverviewContent({
  expandedSections = EMPTY_EXPANDED_SECTIONS,
  onSelect,
  onStop,
  isStopping,
  onToggleExpanded = ignoreSubagentSectionToggle,
  onLoadMore,
  overview,
  rootThreadId,
  delegation,
}: {
  expandedSections?: ReadonlySet<SubagentSectionId>;
  onSelect: (row: CodexSubagentOverviewRow) => void;
  onStop?: (row: CodexSubagentOverviewRow) => void;
  isStopping?: (row: CodexSubagentOverviewRow) => boolean;
  onToggleExpanded?: (sectionId: SubagentSectionId, expanded: boolean) => void;
  onLoadMore?: (sectionId: SubagentSectionId) => void;
  overview: CodexSubagentOverviewWindow;
  rootThreadId: string;
  /** Whether this conversation's subagents may delegate, shown even before the first one. */
  delegation?: ReactNode;
}) {
  const intl = useIntl();
  const { view, setView } = useSubagentsOverviewView();
  const hasLiveRows = overview.active.rows.some(
    (row) => row.status === "active" || row.status === "waiting",
  );
  const [nowMs, setNowMs] = useState(Date.now);
  const [doneClockMs] = useState(Date.now);

  useEffect(() => {
    if (!hasLiveRows) return;
    const interval = window.setInterval(() => setNowMs(Date.now()), ACTIVE_CLOCK_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [hasLiveRows]);

  const waitingCount = overview.active.rows.filter((row) => row.status === "waiting").length;
  const doneCount = overview.done.totalCount ?? overview.done.knownCount;
  const paged = onLoadMore !== undefined;
  const sections = [
    {
      id: "active",
      section: overview.active,
      shown: shownSection(overview.active, {
        expanded: expandedSections.has("active"),
        initialLimit: CODEX_SUBAGENT_OVERVIEW_INITIAL_ACTIVE_LIMIT,
        paged,
      }),
    },
    {
      id: "done",
      section: overview.done,
      shown: shownSection(overview.done, {
        expanded: expandedSections.has("done"),
        initialLimit: CODEX_SUBAGENT_OVERVIEW_INITIAL_DONE_LIMIT,
        paged,
      }),
    },
  ] as const;
  const [active, done] = sections;
  // A map needs something to draw; until a subagent exists the list says so in words.
  const hasSubagents = sections.some(({ section }) => section.rows.length > 0);
  const showMap = view === "map" && hasSubagents;

  // The map draws one tree, so one control stands for whatever either section still holds.
  const more = ((): DelegationMapMore | null => {
    const withMore = sections.filter(({ shown }) => shown.hasMore);
    if (withMore.length === 0) return null;
    const collapsible = !paged && withMore.every(({ id }) => expandedSections.has(id));
    if (collapsible)
      return {
        label: intl.formatMessage({
          id: "conversation.subagentsPanel.showLess",
          defaultMessage: "Show less",
        }),
        onClick: () => withMore.forEach(({ id }) => onToggleExpanded(id, false)),
      };
    const counted = withMore.every(({ section }) => section.totalCount !== null);
    const hidden = withMore.reduce(
      (count, { section, shown }) =>
        count + Math.max(0, (section.totalCount ?? 0) - shown.rows.length),
      0,
    );
    return {
      label:
        counted && hidden > 0
          ? intl.formatMessage(
              {
                id: "conversation.subagentsPanel.showMoreCount",
                defaultMessage: "Show {count} more",
              },
              { count: hidden },
            )
          : intl.formatMessage({
              id: "conversation.subagentsPanel.showMore",
              defaultMessage: "Show more",
            }),
      onClick: () =>
        withMore.forEach(({ id }) => (onLoadMore ? onLoadMore(id) : onToggleExpanded(id, true))),
    };
  })();

  return (
    <div
      className="h-full min-h-0 overflow-y-auto px-3 py-5"
      data-subagents-panel-overview={rootThreadId}
      data-subagents-overview-revision={overview.revision}
      data-subagents-overview-view={showMap ? "map" : "list"}
    >
      <div className="mx-auto w-full max-w-[var(--thread-content-max-width)]">
        {hasSubagents || delegation ? (
          <div className="mb-3 flex min-h-6 items-center justify-between gap-3 px-2">
            {delegation ?? <span />}
            {hasSubagents ? <SubagentsOverviewViewToggle view={view} onChange={setView} /> : null}
          </div>
        ) : null}
        {showMap ? (
          <DelegationMap
            rootThreadId={rootThreadId}
            rows={[...active.shown.rows, ...done.shown.rows]}
            summary={summarizeDelegation(overview)}
            more={more}
            nowMs={nowMs}
            onSelect={onSelect}
            onStop={onStop}
            isStopping={isStopping}
          />
        ) : (
          <>
            <SubagentOverviewSectionView
              doneClockMs={doneClockMs}
              emptyState={intl.formatMessage({
                id: "conversation.subagentsPanel.empty",
                defaultMessage: "No active subagents",
              })}
              expanded={expandedSections.has("active")}
              shown={active.shown}
              nowMs={nowMs}
              onSelect={onSelect}
              onStop={onStop}
              isStopping={isStopping}
              onToggleExpanded={onToggleExpanded}
              onLoadMore={onLoadMore}
              previewLineCount={1}
              section={overview.active}
              sectionId="active"
              title={intl.formatMessage(
                { id: "conversation.subagentsPanel.active", defaultMessage: "Active · {count}" },
                { count: sectionCountLabel(intl, overview.active) },
              )}
              titleTrailing={
                waitingCount > 0
                  ? intl.formatMessage(
                      {
                        id: "conversation.subagentsPanel.waitingCount",
                        defaultMessage: "{count} waiting",
                      },
                      { count: waitingCount },
                    )
                  : null
              }
            />
            {doneCount > 0 ? (
              <SubagentOverviewSectionView
                className="mt-6"
                doneClockMs={doneClockMs}
                expanded={expandedSections.has("done")}
                shown={done.shown}
                nowMs={nowMs}
                onSelect={onSelect}
                onToggleExpanded={onToggleExpanded}
                onLoadMore={onLoadMore}
                previewLineCount={1}
                section={overview.done}
                sectionId="done"
                title={intl.formatMessage(
                  { id: "conversation.subagentsPanel.done", defaultMessage: "Done · {count}" },
                  { count: sectionCountLabel(intl, overview.done) },
                )}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The selected subagent's own header: back, its identity, then the Agent that runs it with the
 * model, effort and speed it was given.
 */
export function SubagentsPanelDetailHeader({
  agent,
  displayName,
  speed = null,
  onBack,
  threadId,
}: {
  agent?: ConversationAgent | null;
  displayName: string;
  /** The speed tier the subagent runs at; Standard shows nothing. */
  speed?: CodexSpeed | null;
  onBack: () => void;
  threadId: string;
}) {
  const intl = useIntl();
  return (
    <div className="flex h-12 shrink-0 items-center gap-2 border-b border-token-border-heavy px-4">
      <button
        type="button"
        aria-label={intl.formatMessage({
          id: "conversation.subagentsPanel.back",
          defaultMessage: "Back to subagents",
        })}
        className="flex size-6 cursor-interaction items-center justify-center rounded-md text-token-text-secondary hover:bg-token-bg-secondary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        onClick={onBack}
      >
        <BackIcon className="icon-xs" />
      </button>
      <SubagentAvatar seed={threadId} className="size-6" />
      <div className="min-w-0 flex-1 truncate text-sm font-medium text-token-foreground">
        {displayName}
      </div>
      {agent?.model ? (
        <span className="flex max-w-1/2 min-w-0 items-center gap-1.5 text-xs text-token-text-tertiary select-none">
          {speed ? (
            <span
              role="img"
              aria-label={
                speed === "ultrafast"
                  ? intl.formatMessage({
                      id: "conversation.subagentsPanel.ultrafastMode",
                      defaultMessage: "Ultrafast mode",
                    })
                  : intl.formatMessage({
                      id: "conversation.subagentsPanel.fastMode",
                      defaultMessage: "Fast mode",
                    })
              }
              className="inline-flex shrink-0"
            >
              <IntelligenceModeIndicatorIcon mode={speed} />
            </span>
          ) : null}
          <AgentIdentity agent={agent} detail="settings" />
        </span>
      ) : null}
    </div>
  );
}
