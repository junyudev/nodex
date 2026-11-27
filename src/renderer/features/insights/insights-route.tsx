import { defineMessage, useIntl, type MessageDescriptor, type IntlShape } from "@/lib/i18n";
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
import { InsightsShareCards } from "./insights-share-cards";
import {
  insightsTimeZone,
  useInsightsAccess,
  useInsightsContent,
  useInsightsUsage,
} from "./use-insights";

const METRICS: readonly { readonly key: InsightsMetric; readonly name: MessageDescriptor }[] = [
  {
    key: "tokens",
    name: defineMessage({ id: "insights.insightsRoute.tokens", defaultMessage: "Tokens" }),
  },
  {
    key: "messages",
    name: defineMessage({ id: "insights.insightsRoute.messages", defaultMessage: "Messages" }),
  },
  {
    key: "tasks",
    name: defineMessage({ id: "insights.insightsRoute.tasks", defaultMessage: "Tasks" }),
  },
  {
    key: "pages",
    name: defineMessage({ id: "insights.insightsRoute.pagesMetric", defaultMessage: "Pages" }),
  },
];

const ORIGINS = [
  {
    key: "all",
    name: defineMessage({ id: "insights.insightsRoute.allAgents", defaultMessage: "All agents" }),
  },
  {
    key: "nodex",
    name: defineMessage({ id: "insights.insightsRoute.nodexOnly", defaultMessage: "Nodex only" }),
  },
] as const;

const FAMILY_LEGEND = [
  ["claude", "Claude"],
  ["gpt", "GPT"],
  ["other", defineMessage({ id: "insights.insightsRoute.otherModels", defaultMessage: "Other" })],
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

const countOrDash = (value: number | null, intl: IntlShape) =>
  value === null ? "—" : wholeNumber(value, intl);

function InsightsOverview({ view }: { readonly view: InsightsView }) {
  const intl = useIntl();
  const [metric, setMetric] = useState<InsightsMetric>("tokens");
  const cachePart = intl.formatMessage(
    { id: "insights.insightsRoute.cacheReads", defaultMessage: "{share} cache reads" },
    { share: intl.formatNumber(view.cachedShare, { style: "percent" }) },
  );
  const costNote =
    view.costUsd > 0
      ? intl.formatMessage(
          {
            id: "insights.insightsRoute.apiCost",
            defaultMessage: "≈ {cost} at API list price · {cache}",
          },
          { cost: wholeDollars(view.costUsd, intl), cache: cachePart },
        )
      : view.tokens > 0
        ? cachePart
        : null;
  return (
    <div className="flex flex-col gap-8 pb-10">
      <InsightsShareCards view={view} />

      <div className="grid grid-cols-[minmax(0,2.2fr)_repeat(4,minmax(0,1fr))] gap-6">
        <Stat
          label={intl.formatMessage({
            id: "insights.insightsRoute.tokensProcessed",
            defaultMessage: "Tokens processed",
          })}
          value={compactNumber(view.tokens, intl)}
          note={costNote}
        />
        <Stat
          label={intl.formatMessage({
            id: "insights.insightsRoute.concurrentAgents",
            defaultMessage: "Agents at once",
          })}
          value={wholeNumber(view.peakAgents, intl)}
          note={view.peakAgentsDay ? shortDay(view.peakAgentsDay, intl) : null}
        />
        <Stat
          label={intl.formatMessage({
            id: "insights.insightsRoute.tasksDone",
            defaultMessage: "Tasks done",
          })}
          value={wholeNumber(view.tasksDone, intl)}
          note={
            view.pagesCreated > 0
              ? intl.formatMessage(
                  {
                    id: "insights.insightsRoute.pagesWritten",
                    defaultMessage: "{count, plural, one {# page written} other {# pages written}}",
                  },
                  { count: view.pagesCreated },
                )
              : null
          }
        />
        <Stat
          label={intl.formatMessage({
            id: "insights.insightsRoute.messagesSent",
            defaultMessage: "Messages sent",
          })}
          value={wholeNumber(view.messages, intl)}
          note={
            view.requests > 0
              ? intl.formatMessage(
                  {
                    id: "insights.insightsRoute.modelRequests",
                    defaultMessage: "{count} model requests",
                  },
                  { count: compactNumber(view.requests, intl) },
                )
              : null
          }
        />
        <Stat
          label={intl.formatMessage({
            id: "insights.insightsRoute.longestStreak",
            defaultMessage: "Longest streak",
          })}
          value={intl.formatMessage(
            { id: "insights.insightsRoute.days", defaultMessage: "{days} days" },
            { days: wholeNumber(view.longestStreak, intl) },
          )}
          note={intl.formatMessage(
            { id: "insights.insightsRoute.activeDays", defaultMessage: "{days} active days" },
            { days: wholeNumber(view.activeDays, intl) },
          )}
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
        title={intl.formatMessage({
          id: "insights.insightsRoute.activity",
          defaultMessage: "Activity",
        })}
        aside={
          <BrowseTabs
            ariaLabel={intl.formatMessage({
              id: "insights.insightsRoute.activityMetric",
              defaultMessage: "Activity metric",
            })}
            tabs={METRICS.map(({ key, name }) => ({ key, name: intl.formatMessage(name) }))}
            selectedKey={metric}
            onSelect={setMetric}
          />
        }
      >
        <ActivityHeatmap calendar={view.calendar} metric={metric} />
      </Section>

      <div className="grid grid-cols-2 gap-8">
        <Section
          title={intl.formatMessage({
            id: "insights.insightsRoute.tokensOverTime",
            defaultMessage: "Tokens over time",
          })}
          aside={
            <div className="flex items-center gap-3 text-xs semantic-text-secondary">
              {FAMILY_LEGEND.map(([family, label]) => (
                <span key={family} className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-xs"
                    style={{ backgroundColor: FAMILY_COLORS[family] }}
                  />
                  {typeof label === "string" ? label : intl.formatMessage(label)}
                </span>
              ))}
            </div>
          }
        >
          <TokenTimeline series={tokenSeries(view, intl)} />
        </Section>
        <Section
          title={intl.formatMessage({
            id: "insights.insightsRoute.models",
            defaultMessage: "Models",
          })}
        >
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
                    {compactNumber(model.tokens, intl)}
                  </td>
                  <td className="py-1.5 pr-3 text-right semantic-text-secondary">
                    {shareLabel(model.share, intl)}
                  </td>
                  <td className="py-1.5 text-right semantic-text-secondary">
                    {model.priced ? wholeDollars(model.costUsd, intl) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.unpricedModels > 0 ? (
            <p className="text-xs text-tertiary">
              {intl.formatMessage(
                {
                  id: "insights.insightsRoute.unpricedModels",
                  defaultMessage:
                    "{count, plural, one {# model has} other {# models have}} no known price and add nothing to the cost.",
                },
                { count: view.unpricedModels },
              )}
            </p>
          ) : null}
        </Section>
      </div>

      <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)] gap-8">
        <Section
          title={intl.formatMessage({
            id: "insights.insightsRoute.rhythm",
            defaultMessage: "Rhythm",
          })}
        >
          <HourRhythm hours={view.hours} />
        </Section>
        <Section
          title={intl.formatMessage({
            id: "insights.insightsRoute.agents",
            defaultMessage: "Agents",
          })}
        >
          <Rows
            rows={[
              [
                intl.formatMessage({
                  id: "insights.insightsRoute.conversations",
                  defaultMessage: "Conversations",
                }),
                wholeNumber(view.conversations, intl),
              ],
              [
                intl.formatMessage({
                  id: "insights.insightsRoute.agentTurns",
                  defaultMessage: "Agent turns",
                }),
                wholeNumber(view.agentTurns, intl),
              ],
              [
                intl.formatMessage({
                  id: "insights.insightsRoute.agentHours",
                  defaultMessage: "Agent hours",
                }),
                wholeNumber(view.agentHours, intl),
              ],
              [
                intl.formatMessage({
                  id: "insights.insightsRoute.cacheSavings",
                  defaultMessage: "Saved by cache",
                }),
                wholeDollars(view.cacheSavingsUsd, intl),
              ],
            ]}
          />
        </Section>
        <Section
          title={intl.formatMessage({
            id: "insights.insightsRoute.library",
            defaultMessage: "Library",
          })}
        >
          <Rows
            rows={[
              [
                intl.formatMessage({
                  id: "insights.insightsRoute.tasksFinished",
                  defaultMessage: "Tasks finished",
                }),
                countOrDash(view.tasksDoneTotal, intl),
              ],
              [
                intl.formatMessage({
                  id: "insights.insightsRoute.totalTasks",
                  defaultMessage: "Tasks in all",
                }),
                countOrDash(view.taskTotal, intl),
              ],
              [
                intl.formatMessage({ id: "insights.insightsRoute.pages", defaultMessage: "Pages" }),
                countOrDash(view.pageTotal, intl),
              ],
              [
                intl.formatMessage({
                  id: "insights.insightsRoute.blocks",
                  defaultMessage: "Blocks",
                }),
                countOrDash(view.blockTotal, intl),
              ],
            ]}
          />
        </Section>
      </div>
    </div>
  );
}

/** Numbers in one place, from every agent on this device. */
export function InsightsRoute() {
  const intl = useIntl();
  const [period, setPeriod] = useState<InsightsPeriod>("12m");
  const [origin, setOrigin] = useState<"all" | "nodex">("all");
  const [stopping, setStopping] = useState(false);
  const usage = useInsightsUsage(origin);
  const content = useInsightsContent();
  const access = useInsightsAccess();

  // The last read says what day it is, so a page left open rolls over with its next refresh.
  const today = localToday(insightsTimeZone(), usage.dataUpdatedAt);
  const snapshot = usage.data;
  const contentSnapshot = content.data ?? null;
  const view = snapshot
    ? projectInsights({ usage: snapshot, content: contentSnapshot, period, today }, intl)
    : null;
  const granted = snapshot?.access === "granted";
  const scanning = snapshot?.scan.state === "scanning";

  return (
    <SearchablePageLayout
      contentClassName="pt-2"
      title={intl.formatMessage({ id: "insights.insightsRoute.title", defaultMessage: "Insights" })}
      subtitle={
        granted && scanning
          ? intl.formatMessage(
              {
                id: "insights.insightsRoute.scanProgress",
                defaultMessage: "Reading history, newest first · {done} of {total} files",
              },
              {
                done: wholeNumber(snapshot.scan.filesDone, intl),
                total: wholeNumber(snapshot.scan.filesTotal, intl),
              },
            )
          : granted && snapshot.scan.failedFiles > 0
            ? intl.formatMessage(
                {
                  id: "insights.insightsRoute.scanFailures",
                  defaultMessage: "{count} files could not be read and will be tried again",
                },
                { count: wholeNumber(snapshot.scan.failedFiles, intl) },
              )
            : intl.formatMessage({
                id: "insights.insightsRoute.subtitle",
                defaultMessage: "What your agents did, and what came of it",
              })
      }
      headerAction={
        granted ? (
          <NodexButton
            variant="ghostSecondary"
            size="sm"
            disabled={access.isPending}
            onClick={() => setStopping(true)}
          >
            {intl.formatMessage({
              id: "insights.insightsRoute.stopReading",
              defaultMessage: "Stop reading history",
            })}
          </NodexButton>
        ) : null
      }
      stickyControls={
        granted ? (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <BrowseTabs
              ariaLabel={intl.formatMessage({
                id: "insights.insightsRoute.period",
                defaultMessage: "Period",
              })}
              tabs={INSIGHTS_PERIODS.map(({ id, label }) => ({
                key: id,
                name: intl.formatMessage(label),
              }))}
              selectedKey={period}
              onSelect={setPeriod}
            />
            <BrowseTabs
              ariaLabel={intl.formatMessage({
                id: "insights.insightsRoute.agents",
                defaultMessage: "Agents",
              })}
              tabs={ORIGINS.map(({ key, name }) => ({ key, name: intl.formatMessage(name) }))}
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
            title={intl.formatMessage({
              id: "insights.insightsRoute.unavailable",
              defaultMessage: "Insights is unavailable right now",
            })}
            description={intl.formatMessage({
              id: "insights.insightsRoute.unavailableDescription",
              defaultMessage: "The agent runtime could not answer. Your history is untouched.",
            })}
            actions={
              <NodexButton variant="outline" onClick={() => void usage.refetch()}>
                {intl.formatMessage({
                  id: "insights.insightsRoute.retry",
                  defaultMessage: "Try again",
                })}
              </NodexButton>
            }
          />
        ) : (
          <div className="py-24 text-center text-sm text-tertiary">
            {intl.formatMessage({
              id: "insights.insightsRoute.starting",
              defaultMessage: "Starting up…",
            })}
          </div>
        )
      ) : !granted ? (
        <EmptyState
          className="py-24"
          width="wide"
          icon={<WorkbenchInsightsIcon />}
          title={intl.formatMessage({
            id: "insights.insightsRoute.onboardingTitle",
            defaultMessage: "See everything your agents have done",
          })}
          description={intl.formatMessage({
            id: "insights.insightsRoute.onboardingDescription",
            defaultMessage:
              "Nodex can read your Claude Code and Codex history on this device to count tokens, models and messages. It keeps only those counts, and nothing leaves this device.",
          })}
          actions={
            <NodexButton
              variant="primary"
              disabled={access.isPending}
              onClick={() => access.mutate(true)}
            >
              {intl.formatMessage({
                id: "insights.insightsRoute.readHistory",
                defaultMessage: "Read my agent history",
              })}
            </NodexButton>
          }
        />
      ) : view === null ? null : view.tokens === 0 && !scanning ? (
        <EmptyState
          className="py-24"
          width="wide"
          icon={<WorkbenchInsightsIcon />}
          title={intl.formatMessage({
            id: "insights.insightsRoute.empty",
            defaultMessage: "No agent activity in this period",
          })}
          description={intl.formatMessage({
            id: "insights.insightsRoute.emptyDescription",
            defaultMessage:
              "Choose a longer period, or come back after your agents have done some work.",
          })}
        />
      ) : (
        <InsightsOverview view={view} />
      )}
      <NodexDialog open={stopping} onOpenChange={setStopping}>
        <NodexDialogContent size="compact">
          <NodexDialogHeader>
            <NodexDialogTitle>
              {intl.formatMessage({
                id: "insights.insightsRoute.stopTitle",
                defaultMessage: "Stop reading history?",
              })}
            </NodexDialogTitle>
            <NodexDialogDescription>
              {intl.formatMessage({
                id: "insights.insightsRoute.stopDescription",
                defaultMessage:
                  "Nodex forgets everything it counted. Any history your agents have since deleted cannot be counted again.",
              })}
            </NodexDialogDescription>
          </NodexDialogHeader>
          <NodexDialogFooter>
            <NodexDialogAction onClick={() => setStopping(false)}>
              {intl.formatMessage({
                id: "insights.insightsRoute.keepReading",
                defaultMessage: "Keep reading",
              })}
            </NodexDialogAction>
            <NodexDialogAction
              tone="danger"
              onClick={() => {
                setStopping(false);
                access.mutate(false);
              }}
            >
              {intl.formatMessage({
                id: "insights.insightsRoute.stopAndForget",
                defaultMessage: "Stop and forget",
              })}
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogContent>
      </NodexDialog>
    </SearchablePageLayout>
  );
}
