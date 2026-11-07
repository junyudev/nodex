import { useState, type ReactNode } from "react";

import { WorkbenchInsightsIcon } from "@/components/shared/icons/workbench-navigation-icons";
import { BrowseTabs } from "@/components/ui/browse-tabs";
import { NodexButton } from "@/components/ui/button";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { SearchablePageLayout } from "@/components/ui/searchable-page-layout";

import { ActivityHeatmap, FAMILY_COLORS, HourRhythm, TokenTimeline } from "./insights-charts";
import { compactNumber, shareLabel, shortDay, wholeDollars, wholeNumber } from "./insights-format";
import {
  INSIGHTS_PERIODS,
  localToday,
  projectInsights,
  tokenSeries,
  type InsightsMetric,
  type InsightsPeriod,
  type InsightsView,
} from "./insights-model";
import { InsightsShareDialog } from "./insights-share-dialog";
import {
  insightsTimeZone,
  useInsightsAccess,
  useInsightsContent,
  useInsightsUsage,
} from "./use-insights";

const METRICS: readonly { readonly key: InsightsMetric; readonly name: string }[] = [
  { key: "tokens", name: "Tokens" },
  { key: "messages", name: "Messages" },
  { key: "tasks", name: "Tasks" },
  { key: "pages", name: "Pages" },
];

const ORIGINS = [
  { key: "all", name: "All agents" },
  { key: "nodex", name: "Nodex only" },
] as const;

const FAMILY_LEGEND = [
  ["claude", "Claude"],
  ["gpt", "GPT"],
  ["other", "Other"],
] as const;

function Stat({
  label,
  value,
  note,
}: {
  readonly label: string;
  readonly value: string;
  readonly note?: string | null;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-xs text-tertiary">{label}</div>
      <div className="text-2xl leading-8 font-semibold tracking-tight text-(--color-text)">
        {value}
      </div>
      {/* The line stays when empty, so every figure in a row keeps one baseline. */}
      <div className="min-h-4 truncate text-xs text-tertiary">{note}</div>
    </div>
  );
}

function Section({
  title,
  aside,
  children,
}: {
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex min-h-7 items-center justify-between gap-3">
        <h2 className="text-sm font-medium text-(--color-text)">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Rows({ rows }: { readonly rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="flex flex-col">
      {rows.map(([label, value]) => (
        <div
          key={label}
          className="flex items-baseline justify-between gap-4 border-t-[0.5px] border-default py-1.5 text-sm"
        >
          <dt className="semantic-text-secondary">{label}</dt>
          <dd className="text-(--color-text) tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

const countOrDash = (value: number | null) => (value === null ? "—" : wholeNumber(value));

function InsightsOverview({ view }: { readonly view: InsightsView }) {
  const [metric, setMetric] = useState<InsightsMetric>("tokens");
  const cachePart = `${Math.round(view.cachedShare * 100)}% cache reads`;
  const costNote =
    view.costUsd > 0
      ? `≈ ${wholeDollars(view.costUsd)} at API list price · ${cachePart}`
      : view.tokens > 0
        ? cachePart
        : null;
  return (
    <div className="flex flex-col gap-8 pb-10">
      <div className="grid grid-cols-[minmax(0,1.7fr)_repeat(4,minmax(0,1fr))] items-end gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="text-xs text-tertiary">Tokens processed</div>
          <div
            data-insights-tokens
            className="text-5xl leading-none font-semibold tracking-tight text-(--color-text)"
          >
            {compactNumber(view.tokens)}
          </div>
          {costNote ? <div className="text-xs text-tertiary">{costNote}</div> : null}
        </div>
        <Stat
          label="Agents at once"
          value={wholeNumber(view.peakAgents)}
          note={view.peakAgentsDay ? shortDay(view.peakAgentsDay) : null}
        />
        <Stat
          label="Tasks done"
          value={wholeNumber(view.tasksDone)}
          note={
            view.pagesCreated > 0
              ? `${wholeNumber(view.pagesCreated)} ${view.pagesCreated === 1 ? "page" : "pages"} written`
              : null
          }
        />
        <Stat
          label="Messages sent"
          value={wholeNumber(view.messages)}
          note={view.requests > 0 ? `${compactNumber(view.requests)} model requests` : null}
        />
        <Stat
          label="Longest streak"
          value={`${wholeNumber(view.longestStreak)} days`}
          note={`${wholeNumber(view.activeDays)} active days`}
        />
      </div>

      {view.highlights.length > 0 ? (
        <div className="grid grid-cols-3 gap-6 border-y-[0.5px] border-default py-3">
          {view.highlights.map((highlight) => (
            <p key={highlight.lead} className="text-sm semantic-text-secondary">
              <span className="font-medium text-(--color-text)">{highlight.lead}</span>{" "}
              {highlight.detail}
            </p>
          ))}
        </div>
      ) : null}

      <Section
        title="Activity"
        aside={
          <BrowseTabs
            ariaLabel="Activity metric"
            tabs={METRICS}
            selectedKey={metric}
            onSelect={setMetric}
          />
        }
      >
        <ActivityHeatmap calendar={view.calendar} metric={metric} />
      </Section>

      <div className="grid grid-cols-2 gap-8">
        <Section
          title="Tokens over time"
          aside={
            <div className="flex items-center gap-3 text-xs semantic-text-secondary">
              {FAMILY_LEGEND.map(([family, label]) => (
                <span key={family} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-xs"
                    style={{ backgroundColor: FAMILY_COLORS[family] }}
                  />
                  {label}
                </span>
              ))}
            </div>
          }
        >
          <TokenTimeline series={tokenSeries(view)} />
        </Section>
        <Section title="Models">
          <table className="w-full text-sm tabular-nums">
            <tbody>
              {view.models.slice(0, 6).map((model) => (
                <tr key={model.model} className="border-t-[0.5px] border-default">
                  <td className="py-1.5 pr-3 text-(--color-text)">
                    <span className="flex items-center gap-2">
                      <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-xs"
                        style={{ backgroundColor: FAMILY_COLORS[model.family] }}
                      />
                      <span className="truncate">{model.label}</span>
                    </span>
                  </td>
                  <td className="py-1.5 pr-3 text-right semantic-text-secondary">
                    {compactNumber(model.tokens)}
                  </td>
                  <td className="py-1.5 pr-3 text-right semantic-text-secondary">
                    {shareLabel(model.share)}
                  </td>
                  <td className="py-1.5 text-right semantic-text-secondary">
                    {model.priced ? wholeDollars(model.costUsd) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.unpricedModels > 0 ? (
            <p className="text-xs text-tertiary">
              {view.unpricedModels} model{view.unpricedModels === 1 ? " has" : "s have"} no known
              price and add nothing to the cost.
            </p>
          ) : null}
        </Section>
      </div>

      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-8">
        <Section title="Rhythm">
          <HourRhythm hours={view.hours} />
        </Section>
        <Section title="Agents">
          <Rows
            rows={[
              ["Conversations", wholeNumber(view.conversations)],
              ["Agent turns", wholeNumber(view.agentTurns)],
              ["Agent hours", wholeNumber(view.agentHours)],
              ["Saved by cache", wholeDollars(view.cacheSavingsUsd)],
            ]}
          />
        </Section>
        <Section title="Library">
          <Rows
            rows={[
              ["Tasks finished", countOrDash(view.tasksDoneTotal)],
              ["Tasks in all", countOrDash(view.taskTotal)],
              ["Pages", countOrDash(view.pageTotal)],
              ["Blocks", countOrDash(view.blockTotal)],
            ]}
          />
        </Section>
      </div>
    </div>
  );
}

/** Numbers in one place, from every agent on this device. */
export function InsightsRoute() {
  const [period, setPeriod] = useState<InsightsPeriod>("12m");
  const [origin, setOrigin] = useState<"all" | "nodex">("all");
  const [sharing, setSharing] = useState(false);
  const [stopping, setStopping] = useState(false);
  const usage = useInsightsUsage(origin);
  const content = useInsightsContent();
  const access = useInsightsAccess();

  // The last read says what day it is, so a page left open rolls over with its next refresh.
  const today = localToday(insightsTimeZone(), usage.dataUpdatedAt);
  const snapshot = usage.data;
  const contentSnapshot = content.data ?? null;
  const viewFor = (forPeriod: InsightsPeriod) =>
    snapshot
      ? projectInsights({ usage: snapshot, content: contentSnapshot, period: forPeriod, today })
      : null;
  const view = viewFor(period);
  const granted = snapshot?.access === "granted";
  const scanning = snapshot?.scan.state === "scanning";

  return (
    <SearchablePageLayout
      contentClassName="pt-2"
      title="Insights"
      subtitle={
        granted && scanning
          ? `Reading history, newest first · ${wholeNumber(snapshot.scan.filesDone)} of ${wholeNumber(snapshot.scan.filesTotal)} files`
          : granted && snapshot.scan.failedFiles > 0
            ? `${wholeNumber(snapshot.scan.failedFiles)} files could not be read and will be tried again`
            : "What your agents did, and what came of it"
      }
      headerAction={
        granted ? (
          <div className="flex items-center gap-2">
            <NodexButton
              variant="ghostSecondary"
              size="sm"
              disabled={access.isPending}
              onClick={() => setStopping(true)}
            >
              Stop reading history
            </NodexButton>
            <NodexButton
              variant="primary"
              size="sm"
              disabled={!view || view.tokens === 0}
              onClick={() => setSharing(true)}
            >
              Share
            </NodexButton>
          </div>
        ) : null
      }
      stickyControls={
        granted ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <BrowseTabs
              ariaLabel="Period"
              tabs={INSIGHTS_PERIODS.map(({ id, label }) => ({ key: id, name: label }))}
              selectedKey={period}
              onSelect={setPeriod}
            />
            <BrowseTabs
              ariaLabel="Agents"
              tabs={ORIGINS}
              selectedKey={origin}
              onSelect={setOrigin}
            />
          </div>
        ) : null
      }
    >
      {snapshot === undefined ? (
        usage.isError ? (
          <EmptyState
            className="py-24"
            width="wide"
            icon={<WorkbenchInsightsIcon />}
            title="Insights is unavailable right now"
            description="The agent runtime could not answer. Your history is untouched."
            actions={
              <NodexButton variant="outline" onClick={() => void usage.refetch()}>
                Try again
              </NodexButton>
            }
          />
        ) : (
          <div className="py-24 text-center text-sm text-tertiary">Starting up…</div>
        )
      ) : !granted ? (
        <EmptyState
          className="py-24"
          width="wide"
          icon={<WorkbenchInsightsIcon />}
          title="See everything your agents have done"
          description="Nodex can read your Claude Code and Codex history on this device to count tokens, models and messages. It keeps only those counts, and nothing leaves this device."
          actions={
            <NodexButton
              variant="primary"
              disabled={access.isPending}
              onClick={() => access.mutate(true)}
            >
              Read my agent history
            </NodexButton>
          }
        />
      ) : view === null ? null : view.tokens === 0 && !scanning ? (
        <EmptyState
          className="py-24"
          width="wide"
          icon={<WorkbenchInsightsIcon />}
          title="No agent activity in this period"
          description="Choose a longer period, or come back after your agents have done some work."
        />
      ) : (
        <InsightsOverview view={view} />
      )}
      <NodexDialog open={stopping} onOpenChange={setStopping}>
        <NodexDialogContent size="compact">
          <NodexDialogHeader>
            <NodexDialogTitle>Stop reading history?</NodexDialogTitle>
            <NodexDialogDescription>
              Nodex forgets everything it counted. Any history your agents have since deleted cannot
              be counted again.
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction onClick={() => setStopping(false)}>Keep reading</NodexDialogAction>
            <NodexDialogAction
              tone="danger"
              onClick={() => {
                setStopping(false);
                access.mutate(false);
              }}
            >
              Stop and forget
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogContent>
      </NodexDialog>
      {sharing && snapshot ? (
        <InsightsShareDialog
          onClose={() => setSharing(false)}
          initialPeriod={period}
          viewFor={(forPeriod) =>
            projectInsights({ usage: snapshot, content: contentSnapshot, period: forPeriod, today })
          }
        />
      ) : null}
    </SearchablePageLayout>
  );
}
