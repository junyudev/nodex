import { defineMessages, useIntl, type IntlShape } from "@/lib/i18n";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useState, type CSSProperties } from "react";
import { AgentInstanceIcon } from "@/components/shared/icons/provider-icons";
import { conversationIdentityQueryOptions } from "@/lib/conversation-identity";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/utils";
import type { ConversationAgent } from "../../../../../shared/conversation-identity";
import {
  agentIdentityText,
  type AgentIdentityPresentation,
} from "../../agent-identity-presentation";
import {
  subagentAttentionLabel,
  type SubagentOutcome,
  type SubagentOverviewRow,
} from "../../agent-runtime-subagent-overview";
import { useAgentIdentity } from "../shared/agent-identity";
import { SubagentAvatar, SubagentGlyphIcon } from "../shared/subagent-avatar";
import { DiffStats } from "../shared/tools/diff-file-shared";
import {
  DELEGATION_MAP_GEOMETRY,
  delegationFanPath,
  delegationRailBranchPath,
  delegationRailRunPath,
  delegationRailTrunkPath,
  projectDelegationMap,
  type DelegationEdgeState,
  type DelegationMapNode,
} from "./delegation-map-model";
import { formatSubagentElapsedTime } from "./subagent-overview-format";

const GEOMETRY = DELEGATION_MAP_GEOMETRY;
/** Model geometry is in pixels at the default root size; rem keeps it in step with the text. */
const rem = (pixels: number) => `${pixels / 16}rem`;
const NEUTRAL_EDGE = "currentColor";
const FLOW_DASH = "3 9";

/** The subagents the overview holds beyond the ones drawn, and how to bring them in. */
export interface DelegationMapMore {
  readonly label: string;
  readonly onClick: () => void;
}

/**
 * A conversation's work tree as a map: the lead, each subagent it delegated to, and under a
 * subagent the ones that subagent delegated to. An edge takes the color of the harness the work
 * went to and says how the work stands, so who leads and who runs what reads at a glance.
 */
export function DelegationMap({
  rootThreadId,
  rows,
  summary,
  more,
  nowMs,
  onSelect,
  onStop,
  isStopping,
}: {
  readonly rootThreadId: string;
  readonly rows: readonly SubagentOverviewRow[];
  readonly summary: { readonly total: number; readonly back: number };
  readonly more: DelegationMapMore | null;
  readonly nowMs: number;
  readonly onSelect: (row: SubagentOverviewRow) => void;
  readonly onStop?: (row: SubagentOverviewRow) => void;
  readonly isStopping?: (row: SubagentOverviewRow) => boolean;
}) {
  const reducedMotion = useResolvedReducedMotion();
  const map = projectDelegationMap({ rootThreadId, rows, moreAbove: more !== null });
  const settle = reducedMotion ? "" : "transition-[margin] duration-200 ease-out";
  const fan = map.rails.find((rail) => rail.parentKey === null);
  const railWidth = (map.maxDepth + 1) * GEOMETRY.indent;

  return (
    <div className="@container" data-delegation-map={rootThreadId}>
      <div
        className="grid gap-y-3 @[34rem]:grid-cols-[13rem_4rem_minmax(0,22rem)] @[34rem]:justify-center @[34rem]:gap-y-0"
        style={
          {
            "--delegation-lead-top": rem(map.beside.leadTop),
            "--delegation-column-top": rem(map.beside.columnTop),
          } as CSSProperties
        }
      >
        <DelegationLead
          rootThreadId={rootThreadId}
          summary={summary}
          className={cn("@[34rem]:mt-(--delegation-lead-top) @[34rem]:h-26", settle)}
        />
        <svg
          aria-hidden="true"
          className="hidden text-token-text-tertiary @[34rem]:block"
          viewBox={`0 0 ${GEOMETRY.fanWidth} ${map.beside.height}`}
          style={{ width: rem(GEOMETRY.fanWidth), height: rem(map.beside.height) }}
          fill="none"
        >
          {fan?.nodes.map((node) => {
            const path = delegationFanPath(
              map.beside.leadCenterY,
              map.beside.columnTop + node.centerY,
            );
            return (
              <DelegationEdge
                key={node.row.threadId}
                agent={node.row.agent}
                state={node.edge}
                line={path}
                returnPath={path}
                reducedMotion={reducedMotion}
              />
            );
          })}
        </svg>
        <div className={cn("min-w-0 @[34rem]:mt-(--delegation-column-top)", settle)}>
          <div className="relative pl-7 @[34rem]:pl-0">
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute top-0 left-0 overflow-visible text-token-text-tertiary @[34rem]:-translate-x-7"
              viewBox={`0 0 ${railWidth} ${map.columnHeight}`}
              style={{ width: rem(railWidth), height: rem(map.columnHeight) }}
              fill="none"
            >
              {map.rails.map((rail) => {
                const lastWorking = rail.nodes.findLast((node) => node.edge === "flowing");
                return (
                  <g
                    key={rail.parentKey ?? "lead"}
                    // Beside its subagents the lead fans out instead of running a rail.
                    className={rail.parentKey === null ? "@[34rem]:hidden" : undefined}
                  >
                    <path
                      d={delegationRailTrunkPath(rail)}
                      stroke={NEUTRAL_EDGE}
                      strokeOpacity={0.3}
                      strokeWidth={1.5}
                    />
                    {/* Subagents on different harnesses share this line, so work runs down it in
                        no harness's color and takes one where it turns off. */}
                    {lastWorking ? (
                      <FlowDashes
                        d={delegationRailTrunkPath(rail, lastWorking)}
                        color={NEUTRAL_EDGE}
                        opacity={0.6}
                        moving={!reducedMotion}
                      />
                    ) : null}
                    {rail.nodes.map((node) => (
                      <DelegationEdge
                        key={node.row.threadId}
                        agent={node.row.agent}
                        state={node.edge}
                        line={delegationRailBranchPath(rail, node)}
                        returnPath={delegationRailRunPath(rail, node)}
                        reducedMotion={reducedMotion}
                      />
                    ))}
                  </g>
                );
              })}
            </svg>
            <ol className="flex flex-col gap-2">
              {more ? (
                <li className="flex h-7 items-center">
                  <button
                    type="button"
                    className="cursor-interaction rounded-md px-3 text-xs text-token-text-secondary hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
                    onClick={more.onClick}
                  >
                    {more.label}
                  </button>
                </li>
              ) : null}
              <AnimatePresence initial={false}>
                {map.nodes.map((node) => (
                  <motion.li
                    key={node.row.threadId}
                    initial={reducedMotion ? false : { opacity: 0, x: 8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.2, ease: "easeOut" }}
                    className={node.density === "full" ? "h-21" : "h-9"}
                    style={{ marginLeft: rem((node.depth - 1) * GEOMETRY.indent) }}
                    data-delegation-node={node.row.threadId}
                    data-delegation-edge={node.edge}
                  >
                    <DelegationNodeCard
                      node={node}
                      nowMs={nowMs}
                      onSelect={onSelect}
                      onStop={onStop}
                      stopping={isStopping?.(node.row) === true}
                    />
                  </motion.li>
                ))}
              </AnimatePresence>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Dashes along a line, travelling from its start while work is under way. */
function FlowDashes({
  d,
  color,
  opacity = 1,
  moving,
}: {
  readonly d: string;
  readonly color: string;
  readonly opacity?: number;
  readonly moving: boolean;
}) {
  const stroke = {
    d,
    stroke: color,
    strokeOpacity: opacity,
    strokeWidth: 1.5,
    strokeDasharray: FLOW_DASH,
    strokeLinecap: "round",
  } as const;
  return moving ? (
    <motion.path
      {...stroke}
      initial={{ strokeDashoffset: 0 }}
      animate={{ strokeDashoffset: -48 }}
      transition={{ duration: 1.2, repeat: Infinity, ease: "linear" }}
    />
  ) : (
    <path {...stroke} />
  );
}

/**
 * One line of the map. Work under way runs dashes from the delegator toward the subagent, work
 * held for an answer holds them still, a result that came back draws the line solid, and work
 * that ended without one leaves a faint neutral trace.
 */
function DelegationEdge({
  agent,
  state,
  line,
  returnPath,
  reducedMotion,
}: {
  readonly agent: ConversationAgent | null | undefined;
  readonly state: DelegationEdgeState;
  readonly line: string;
  /** The whole way from the delegator, which a result travels back along. */
  readonly returnPath: string;
  readonly reducedMotion: boolean;
}) {
  const color = useAgentIdentity(agent)?.accent ?? NEUTRAL_EDGE;
  // Only a result seen arriving is sent back along the edge; one that was already in is not.
  const [arrival] = useState(() => ({ watched: state === "flowing" || state === "paused" }));
  if (state === "ended")
    return (
      <path
        d={line}
        stroke={NEUTRAL_EDGE}
        strokeOpacity={0.4}
        strokeWidth={1.5}
        strokeDasharray="2 5"
        strokeLinecap="round"
      />
    );
  if (state === "returned")
    return (
      <>
        <path d={line} stroke={color} strokeOpacity={0.65} strokeWidth={1.5} />
        {arrival.watched && !reducedMotion ? (
          <motion.circle
            r={3}
            fill={color}
            style={{ offsetPath: `path("${returnPath}")` }}
            initial={{ offsetDistance: "100%", opacity: 1 }}
            animate={{ offsetDistance: "0%", opacity: 0 }}
            transition={{
              offsetDistance: { duration: 0.7, ease: "easeIn" },
              opacity: { delay: 0.6, duration: 0.2 },
            }}
          />
        ) : null}
      </>
    );
  return (
    <>
      <path d={line} stroke={color} strokeOpacity={0.28} strokeWidth={1.5} />
      <FlowDashes
        d={line}
        color={color}
        opacity={state === "flowing" ? 1 : 0.7}
        moving={state === "flowing" && !reducedMotion}
      />
    </>
  );
}

function DelegationLead({
  rootThreadId,
  summary,
  className,
}: {
  readonly rootThreadId: string;
  readonly summary: { readonly total: number; readonly back: number };
  readonly className?: string;
}) {
  const intl = useIntl();
  const conversation = useQuery(conversationIdentityQueryOptions(rootThreadId)).data ?? null;
  const agent = useAgentIdentity(conversation?.agent);
  const settings = agent ? agentIdentityText(agent, "settings") : null;
  const settled = summary.back >= summary.total;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-center gap-1 rounded-xl bg-token-main-surface-primary px-3 py-3 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.28)] ring-[0.5px] ring-token-border",
        className,
      )}
      data-delegation-lead={rootThreadId}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs/4 text-token-text-tertiary">
        <HarnessMark agent={conversation?.agent} identity={agent} />
        <span className="truncate">
          {agent?.agentName
            ? intl.formatMessage(
                { id: "conversation.delegationMap.leadAgent", defaultMessage: "{agent} · lead" },
                { agent: agent.agentName },
              )
            : intl.formatMessage({
                id: "conversation.delegationMap.lead",
                defaultMessage: "Lead",
              })}
        </span>
      </span>
      {conversation ? (
        <span className="truncate text-sm/5 font-medium text-token-foreground">
          {conversation.title}
        </span>
      ) : null}
      {settings ? (
        <span className="truncate text-xs/4 text-token-text-secondary">{settings}</span>
      ) : null}
      <span className="truncate text-xs/4 text-token-text-tertiary tabular-nums" role="status">
        {settled
          ? intl.formatMessage(
              {
                id: "conversation.delegationMap.allBack",
                defaultMessage: "{total, plural, one {# subagent back} other {All # back}}",
              },
              { total: summary.total },
            )
          : intl.formatMessage(
              {
                id: "conversation.delegationMap.delegating",
                defaultMessage: "Delegating · {back}/{total} back",
              },
              { back: summary.back, total: summary.total },
            )}
      </span>
    </div>
  );
}

/** A harness mark in the slot the cards share, so marks, avatars and words line up down a map. */
function HarnessMark({
  agent,
  identity,
}: {
  readonly agent: ConversationAgent | null | undefined;
  readonly identity: AgentIdentityPresentation | null;
}) {
  if (!identity?.driver) return null;
  return (
    <span className="flex w-4.5 shrink-0 justify-center">
      <AgentInstanceIcon
        binding={{ driver: identity.driver, instanceId: agent?.providerInstanceId ?? undefined }}
        className="size-3.5"
      />
    </span>
  );
}

type NodeStatusTone = "plain" | "settled" | "attention" | "failed";

const OUTCOME_LABELS = defineMessages({
  completed: { id: "conversation.delegationMap.done", defaultMessage: "Done" },
  failed: { id: "conversation.agentRuntimeSubagentOverview.failed", defaultMessage: "Failed" },
  stopped: { id: "conversation.agentRuntimeSubagentOverview.stopped", defaultMessage: "Stopped" },
  cancelled: {
    id: "conversation.agentRuntimeSubagentOverview.cancelled",
    defaultMessage: "Cancelled",
  },
  idle: { id: "conversation.delegatedTaskPresentation.idle", defaultMessage: "Idle" },
}) satisfies Record<SubagentOutcome, unknown>;

/** What a card says about its subagent's work, in the words the list uses for the same state. */
function nodeStatus(
  intl: IntlShape,
  row: SubagentOverviewRow,
  nowMs: number,
): { readonly text: string; readonly tone: NodeStatusTone } {
  if (row.attentionKind)
    return { text: subagentAttentionLabel(row.attentionKind, intl), tone: "attention" };
  const summary = row.statusSummary?.trim() || null;
  if (row.status === "done") {
    const outcome = row.outcome ?? "completed";
    return {
      // A clean finish reads the same on every card; any other ending keeps its owner's words.
      text:
        (outcome === "completed" ? null : summary) ?? intl.formatMessage(OUTCOME_LABELS[outcome]),
      tone: outcome === "failed" ? "failed" : "settled",
    };
  }
  if (row.status === "unknown")
    return {
      text: intl.formatMessage({
        id: "conversation.subagentsPanel.unavailable",
        defaultMessage: "Status unavailable",
      }),
      tone: "plain",
    };
  if (summary) return { text: summary, tone: "plain" };
  if (row.status === "waiting")
    return {
      text: intl.formatMessage({
        id: "conversation.subagentsPanel.waiting",
        defaultMessage: "Waiting",
      }),
      tone: "plain",
    };
  return {
    text:
      row.startedAtMs === null
        ? intl.formatMessage({
            id: "conversation.subagentsPanel.working",
            defaultMessage: "Working",
          })
        : formatSubagentElapsedTime(Math.max(0, nowMs - row.startedAtMs), intl),
    tone: "plain",
  };
}

const STATUS_TONE: Record<NodeStatusTone, string> = {
  plain: "text-token-text-tertiary",
  settled: "text-token-text-secondary",
  attention: "text-token-foreground",
  failed: "text-danger",
};

function DelegationNodeCard({
  node,
  nowMs,
  onSelect,
  onStop,
  stopping,
}: {
  readonly node: DelegationMapNode;
  readonly nowMs: number;
  readonly onSelect: (row: SubagentOverviewRow) => void;
  readonly onStop?: (row: SubagentOverviewRow) => void;
  readonly stopping: boolean;
}) {
  const intl = useIntl();
  const { row } = node;
  const identity = useAgentIdentity(row.agent);
  const live = row.status === "active" || row.status === "waiting";
  const canStop = onStop !== undefined && row.canStop === true && live;
  const status = stopping
    ? {
        text: intl.formatMessage({
          id: "conversation.subagentsPanel.stopping",
          defaultMessage: "Stopping…",
        }),
        tone: "plain" as const,
      }
    : nodeStatus(intl, row, nowMs);
  const statusText = (
    <span
      className={cn(
        "ml-auto max-w-[60%] shrink-0 truncate pl-2 text-xs/4 tabular-nums",
        STATUS_TONE[status.tone],
        // Stop takes this corner while the card is pointed at or holds focus.
        canStop && !stopping && "group-focus-within/node:invisible group-hover/node:invisible",
      )}
      role={stopping ? "status" : undefined}
    >
      {status.text}
    </span>
  );
  const avatar =
    row.identityThreadId === null ? (
      <SubagentGlyphIcon className="size-4.5 shrink-0 text-token-text-tertiary" />
    ) : (
      <SubagentAvatar seed={row.identityThreadId} className="size-4.5 shrink-0" />
    );
  const agentName =
    identity?.agentName ??
    intl.formatMessage({
      id: "conversation.agentRuntimeSubagentOverview.subagent",
      defaultMessage: "Subagent",
    });
  const settings = [identity?.modelName, identity?.effortName].filter(Boolean).join(" · ");
  const content =
    node.density === "full" ? (
      <>
        <span className="flex min-w-0 items-center gap-1.5 text-xs/4 text-token-text-tertiary">
          <HarnessMark agent={row.agent} identity={identity} />
          <span className="truncate">{agentName}</span>
          {statusText}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm/5 font-medium text-token-foreground">
          {avatar}
          <span className="truncate">{row.displayName}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 pl-6 text-xs/4 text-token-text-secondary">
          <span className="truncate">{settings}</span>
          {row.diffStats ? (
            <DiffStats
              additions={row.diffStats.linesAdded}
              deletions={row.diffStats.linesRemoved}
              className="ml-auto shrink-0 pl-2"
            />
          ) : null}
        </span>
      </>
    ) : (
      // A folded card is one that reported back: its solid edge says so, and its line keeps
      // words for an ending that was anything else.
      <span className="flex min-w-0 items-center gap-1.5 text-sm/5 text-token-text-tertiary">
        <HarnessMark agent={row.agent} identity={identity} />
        {avatar}
        <span className="min-w-0 truncate text-token-foreground">{row.displayName}</span>
        {identity?.modelName ? (
          <span className="min-w-0 shrink-[4] truncate text-xs/4">{identity.modelName}</span>
        ) : null}
        {status.tone === "settled" && (row.outcome ?? "completed") === "completed"
          ? null
          : statusText}
      </span>
    );
  const surface = cn(
    "flex size-full min-w-0 flex-col justify-center gap-1 rounded-xl bg-token-main-surface-primary px-3 text-left ring-[0.5px] ring-token-border ring-inset",
    row.canOpen
      ? "cursor-interaction hover:bg-token-foreground/5 focus-visible:outline-2 focus-visible:outline-offset-2"
      : "cursor-default",
  );
  return (
    <div
      className="group/node relative size-full"
      data-agent-driver={identity?.driver ?? undefined}
    >
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
          className={surface}
          onClick={() => onSelect(row)}
        >
          {content}
        </button>
      ) : (
        <div className={surface} data-subagent-overview-unavailable="true">
          {content}
        </div>
      )}
      {canStop && !stopping ? (
        <button
          type="button"
          aria-label={intl.formatMessage(
            { id: "conversation.subagentsPanel.stopAgent", defaultMessage: "Stop {name}" },
            { name: row.displayName },
          )}
          onClick={() => onStop(row)}
          className="absolute top-3 right-3 cursor-interaction rounded-sm text-xs/4 text-token-text-secondary opacity-0 group-focus-within/node:opacity-100 group-hover/node:opacity-100 hover:text-token-foreground focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          {intl.formatMessage({ id: "conversation.subagentsPanel.stop", defaultMessage: "Stop" })}
        </button>
      ) : null}
    </div>
  );
}
