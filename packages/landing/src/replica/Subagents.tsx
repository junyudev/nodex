import { AnimatePresence, motion } from "motion/react";
import { useState, type CSSProperties, type ReactNode } from "react";
import type { AgentChoice, ProviderKind } from "../demos/lumen";
import { PROVIDER_NAMES } from "../demos/lumen";
import { useReplicaCopy } from "./copy";
import { SubagentAvatar } from "./Chat";
import { ProviderMark, cx } from "./Window";
import { AgentQuestionIcon, DelegationMapIcon, ListIcon } from "./icons";
import styles from "./delegation-map.module.css";

/**
 * Each harness's line color, as its Agent definition in src/shared/agents/ names it. A DeepSeek
 * key runs on Nodex's Codex, so its work takes Codex's color.
 */
export const HARNESS_ACCENT: Record<ProviderKind, string> = {
  claude: "#d97757",
  codex: "#8e9bff",
  antigravity: "#4fbf8b",
  deepseek: "#8e9bff",
  opencode: "#e7b549",
};

/**
 * What the line to a subagent says (delegation-map-model.ts): work under way, work held for an
 * answer, a result that came back, or work that ended without one.
 */
export type EdgeState = "flowing" | "paused" | "returned" | "ended";

export type StatusTone = "plain" | "settled" | "attention" | "failed";

const STATUS_TONE: Record<StatusTone, string> = {
  plain: "text-app-faint",
  settled: "text-app-muted",
  attention: "text-app-fg",
  failed: "text-[#e02e2a] dark:text-[#ff6764]",
};

/** One subagent on a map, in the order it was delegated. */
export interface MapSubagent {
  readonly id: string;
  /** The subagent that delegated this one; without one it hangs from the lead. */
  readonly parent?: string;
  readonly name: string;
  readonly avatar: string;
  readonly agent: AgentChoice;
  readonly edge: EdgeState;
  /** What its card says about the work: elapsed time while it runs, Done once it is back. */
  readonly status: ReactNode;
  readonly tone?: StatusTone;
  readonly diff?: { readonly added: number; readonly removed?: number };
  readonly cursorTarget?: string;
}

// DELEGATION_MAP_GEOMETRY in px; the app lays the same numbers out in rem at a 16px root.
const GEOMETRY = {
  leadHeight: 104,
  fanWidth: 64,
  cardHeight: 84,
  gap: 8,
  indent: 28,
  railX: 12,
  railRadius: 8,
  leadGap: 12,
  leadPinY: 188,
} as const;

interface PlacedNode {
  readonly subagent: MapSubagent;
  readonly depth: number;
  readonly top: number;
  readonly centerY: number;
}

interface Rail {
  readonly parent: string | null;
  readonly depth: number;
  readonly top: number;
  readonly nodes: readonly PlacedNode[];
}

/** projectDelegationMap: each subagent beneath whoever delegated it, in delegation order. */
function projectMap(subagents: readonly MapSubagent[], leadPlacement: "centered" | "top") {
  const children = new Map<string | null, MapSubagent[]>();
  for (const subagent of subagents) {
    const parent = subagent.parent ?? null;
    children.set(parent, [...(children.get(parent) ?? []), subagent]);
  }
  const nodes: PlacedNode[] = [];
  const rails: Rail[] = [];
  let top = 0;
  let maxDepth = 0;
  const place = (parent: string | null, depth: number, railTop: number) => {
    const placed: PlacedNode[] = [];
    for (const subagent of children.get(parent) ?? []) {
      const node = { subagent, depth, top, centerY: top + GEOMETRY.cardHeight / 2 };
      nodes.push(node);
      placed.push(node);
      maxDepth = Math.max(maxDepth, depth);
      top += GEOMETRY.cardHeight + GEOMETRY.gap;
      place(subagent.id, depth + 1, node.top + GEOMETRY.cardHeight);
    }
    if (placed.length > 0) rails.push({ parent, depth: depth - 1, top: railTop, nodes: placed });
  };
  place(null, 1, -GEOMETRY.leadGap);
  const columnHeight = Math.max(0, top - GEOMETRY.gap);
  const halfLead = GEOMETRY.leadHeight / 2;
  const atTop = leadPlacement === "top";
  const leadCenterY = atTop
    ? halfLead
    : Math.min(Math.max(columnHeight / 2, halfLead), GEOMETRY.leadPinY);
  const columnTop = atTop ? 0 : Math.max(0, halfLead - columnHeight / 2);
  return {
    nodes,
    rails,
    columnHeight,
    maxDepth,
    height: Math.max(columnTop + columnHeight, leadCenterY + halfLead),
    leadTop: leadCenterY - halfLead,
    leadCenterY,
    columnTop,
  };
}

const fanPath = (fromY: number, toY: number) => {
  const bend = GEOMETRY.fanWidth / 2;
  return `M0,${fromY} C${bend},${fromY} ${bend},${toY} ${GEOMETRY.fanWidth},${toY}`;
};
const railX = (depth: number) => depth * GEOMETRY.indent + GEOMETRY.railX;
const trunkPath = (rail: Rail, through: PlacedNode = rail.nodes.at(-1)!) =>
  `M${railX(rail.depth)},${rail.top} V${through.centerY - GEOMETRY.railRadius}`;
const turn = (rail: Rail, node: PlacedNode) => {
  const x = railX(rail.depth);
  const r = GEOMETRY.railRadius;
  return `Q${x},${node.centerY} ${x + r},${node.centerY} H${(rail.depth + 1) * GEOMETRY.indent}`;
};
const branchPath = (rail: Rail, node: PlacedNode) =>
  `M${railX(rail.depth)},${node.centerY - GEOMETRY.railRadius} ${turn(rail, node)}`;
const runPath = (rail: Rail, node: PlacedNode) =>
  `M${railX(rail.depth)},${rail.top} V${node.centerY - GEOMETRY.railRadius} ${turn(rail, node)}`;

/**
 * DelegationMap (subagents-panel/delegation-map.tsx): a chat's lead and every subagent it
 * delegated to, with the ones a subagent delegated beneath it. Wide enough, the lead sits beside
 * its subagents and fans out to them; narrower, it sits above and a rail runs down to them.
 */
export function DelegationMap({
  subagents,
  lead,
  leadPlacement = "centered",
  leadWidth = 208,
  still = false,
}: {
  readonly subagents: readonly MapSubagent[];
  readonly lead: ReactNode;
  readonly leadPlacement?: "centered" | "top";
  readonly leadWidth?: number;
  /** Holds every line still, as reduced motion does. */
  readonly still?: boolean;
}) {
  const map = projectMap(subagents, leadPlacement);
  const fan = map.rails.find((rail) => rail.parent === null);
  const railWidth = (map.maxDepth + 1) * GEOMETRY.indent;
  return (
    <div className="@container">
      <div
        className="grid gap-y-3 @[34rem]:grid-cols-[var(--map-lead)_64px_minmax(0,352px)] @[34rem]:justify-center @[34rem]:gap-y-0"
        style={
          {
            "--map-lead": `${leadWidth}px`,
            "--map-lead-top": `${map.leadTop}px`,
            "--map-column-top": `${map.columnTop}px`,
          } as CSSProperties
        }
      >
        <div className="min-w-0 @[34rem]:mt-(--map-lead-top) @[34rem]:h-26">{lead}</div>
        {subagents.length > 0 ? (
          <>
            <svg
              aria-hidden="true"
              className="hidden text-app-faint @[34rem]:block"
              viewBox={`0 0 ${GEOMETRY.fanWidth} ${map.height}`}
              style={{ width: GEOMETRY.fanWidth, height: map.height }}
              fill="none"
            >
              {fan?.nodes.map((node) => {
                const path = fanPath(map.leadCenterY, map.columnTop + node.centerY);
                return (
                  <Edge
                    key={node.subagent.id}
                    provider={node.subagent.agent.provider}
                    state={node.subagent.edge}
                    line={path}
                    returnPath={path}
                    still={still}
                  />
                );
              })}
            </svg>
            <div className="min-w-0 @[34rem]:mt-(--map-column-top)">
              <div className="relative pl-7 @[34rem]:pl-0">
                <svg
                  aria-hidden="true"
                  className="pointer-events-none absolute top-0 left-0 overflow-visible text-app-faint @[34rem]:-translate-x-7"
                  viewBox={`0 0 ${railWidth} ${map.columnHeight}`}
                  style={{ width: railWidth, height: map.columnHeight }}
                  fill="none"
                >
                  {map.rails.map((rail) => {
                    const lastWorking = [...rail.nodes]
                      .reverse()
                      .find((node) => node.subagent.edge === "flowing");
                    return (
                      <g
                        key={rail.parent ?? "lead"}
                        // Beside its subagents the lead fans out instead of running a rail.
                        className={rail.parent === null ? "@[34rem]:hidden" : undefined}
                      >
                        <path
                          d={trunkPath(rail)}
                          stroke="currentColor"
                          strokeOpacity={0.3}
                          strokeWidth={1.5}
                        />
                        {/* A rail shared across harnesses runs in no harness's color. */}
                        {lastWorking ? (
                          <FlowDashes
                            d={trunkPath(rail, lastWorking)}
                            color="currentColor"
                            opacity={0.6}
                            moving={!still}
                          />
                        ) : null}
                        {rail.nodes.map((node) => (
                          <Edge
                            key={node.subagent.id}
                            provider={node.subagent.agent.provider}
                            state={node.subagent.edge}
                            line={branchPath(rail, node)}
                            returnPath={runPath(rail, node)}
                            still={still}
                          />
                        ))}
                      </g>
                    );
                  })}
                </svg>
                <ol className="flex flex-col gap-2">
                  <AnimatePresence initial={false}>
                    {map.nodes.map((node) => (
                      <motion.li
                        key={node.subagent.id}
                        initial={still ? false : { opacity: 0, x: 8 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ duration: 0.2, ease: "easeOut" }}
                        className="h-21"
                        style={{ marginLeft: (node.depth - 1) * GEOMETRY.indent }}
                      >
                        <SubagentNodeCard subagent={node.subagent} />
                      </motion.li>
                    ))}
                  </AnimatePresence>
                </ol>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

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
    strokeDasharray: "3 9",
    strokeLinecap: "round",
  } as const;
  return <path {...stroke} className={moving ? styles.flow : undefined} />;
}

/**
 * One line of the map. Work under way runs dashes toward the subagent, work held for an answer
 * holds them still, a result that came back draws the line solid and sends a dot home, and work
 * that ended without one leaves a faint neutral trace.
 */
function Edge({
  provider,
  state,
  line,
  returnPath,
  still,
}: {
  readonly provider: ProviderKind;
  readonly state: EdgeState;
  readonly line: string;
  readonly returnPath: string;
  readonly still: boolean;
}) {
  const color = HARNESS_ACCENT[provider];
  // Only a result seen arriving travels back along the line; one already in when it drew does not.
  const [arrival] = useState(() => ({ watched: state === "flowing" || state === "paused" }));
  if (state === "ended")
    return (
      <path
        d={line}
        stroke="currentColor"
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
        {arrival.watched && !still ? (
          <circle
            r={3}
            fill={color}
            className={styles.homing}
            style={{ offsetPath: `path("${returnPath}")` }}
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
        moving={state === "flowing" && !still}
      />
    </>
  );
}

/** HarnessMark: a mark in the slot every card shares, so marks, avatars and words line up. */
export function HarnessMark({ provider }: { readonly provider: ProviderKind }) {
  return (
    <span className="flex w-4.5 shrink-0 justify-center">
      <ProviderMark kind={provider} className="size-3.5" />
    </span>
  );
}

export function StatusText({
  tone = "plain",
  className,
  children,
}: {
  readonly tone?: StatusTone;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <span
      className={cx(
        "ml-auto flex shrink-0 items-center gap-1 pl-2 tabular-nums",
        STATUS_TONE[tone],
        className,
      )}
    >
      {tone === "attention" ? <ChatWaitingIcon className="size-3.5" /> : null}
      {children}
    </span>
  );
}

/** ChatWaitingIcon: the question bubble in the attention tone, never the blue unread dot. */
export function ChatWaitingIcon({ className = "size-3" }: { readonly className?: string }) {
  return (
    <AgentQuestionIcon className={cx("shrink-0 text-[#e25507] dark:text-[#ff8549]", className)} />
  );
}

const DIFF_ADDED = "text-[#00a240]";
const DIFF_REMOVED = "text-[#e02e2a]";

function DiffStats({ added, removed }: { readonly added: number; readonly removed?: number }) {
  return (
    <span className="ml-auto flex shrink-0 gap-1 pl-2 tabular-nums">
      <span className={DIFF_ADDED}>+{added}</span>
      {removed ? <span className={DIFF_REMOVED}>−{removed}</span> : null}
    </span>
  );
}

const CARD = "rounded-[15px] bg-app ring-[0.5px] ring-app-line";
const LEAD_SHADOW = "shadow-[0_8px_24px_-12px_rgb(0_0_0/0.28)]";

/** DelegationNodeCard: the subagent's Agent and status, its avatar and name, model and effort. */
function SubagentNodeCard({ subagent }: { readonly subagent: MapSubagent }) {
  const copy = useReplicaCopy();
  const { agent } = subagent;
  return (
    <div
      data-cursor-target={subagent.cursorTarget}
      className={cx(CARD, "flex size-full min-w-0 flex-col justify-center gap-1 px-3 ring-inset")}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-app-faint">
        <HarnessMark provider={agent.provider} />
        <span className="truncate">{PROVIDER_NAMES[agent.provider]}</span>
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span
            key={subagent.edge}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="ml-auto flex max-w-[60%] shrink-0"
          >
            <StatusText tone={subagent.tone}>{subagent.status}</StatusText>
          </motion.span>
        </AnimatePresence>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 text-[13px] leading-5 font-medium text-app-fg">
        <SubagentAvatar avatar={subagent.avatar} className="size-4.5" />
        <span className="truncate">{subagent.name}</span>
      </span>
      <span className="flex min-w-0 items-center gap-1.5 pl-6 text-[12px] leading-4 text-app-muted">
        <span className="truncate">
          {agent.model} · {copy.effort[agent.effort]}
        </span>
        {subagent.diff && subagent.edge === "returned" ? (
          <motion.span initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="ml-auto flex">
            <DiffStats {...subagent.diff} />
          </motion.span>
        ) : null}
      </span>
    </div>
  );
}

/** DelegationLead: the chat a Subagents map belongs to, and how many of its subagents are back. */
export function MapLead({
  agent,
  title,
  summary,
  cursorTarget,
}: {
  readonly agent: AgentChoice;
  readonly title: string;
  readonly summary: ReactNode;
  readonly cursorTarget?: string;
}) {
  const copy = useReplicaCopy();
  return (
    <div
      data-cursor-target={cursorTarget}
      className={cx(CARD, LEAD_SHADOW, "flex h-full min-w-0 flex-col justify-center gap-1 p-3")}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-app-faint">
        <HarnessMark provider={agent.provider} />
        <span className="truncate">{copy.leadAgent(PROVIDER_NAMES[agent.provider])}</span>
      </span>
      <span className="truncate text-[13px] leading-5 font-medium text-app-fg">{title}</span>
      <span className="truncate text-[12px] leading-4 text-app-muted">
        {agent.model} · {copy.effort[agent.effort]}
      </span>
      <span className="truncate text-[12px] leading-4 text-app-faint tabular-nums">{summary}</span>
    </div>
  );
}

/**
 * AgentsChatLead (agents/agents-chat-band.tsx): a chat in Aerial view, with its Agent and how its
 * work stands, its title, one line about the work, then its model and how many are back.
 */
export function AerialLead({
  agent,
  title,
  status,
  tone = "plain",
  line,
  back,
  queued = false,
}: {
  readonly agent: AgentChoice;
  readonly title: string;
  readonly status: ReactNode;
  readonly tone?: StatusTone;
  readonly line?: string;
  readonly back?: ReactNode;
  readonly queued?: boolean;
}) {
  const copy = useReplicaCopy();
  return (
    <div
      className={cx(
        CARD,
        !queued && LEAD_SHADOW,
        "flex size-full min-w-0 flex-col justify-center gap-1 p-3",
      )}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-app-faint">
        <HarnessMark provider={agent.provider} />
        <span className="truncate">{PROVIDER_NAMES[agent.provider]}</span>
        <StatusText tone={tone}>{status}</StatusText>
      </span>
      <span className="truncate text-[13px] leading-5 font-medium text-app-fg">{title}</span>
      {line ? (
        <span
          className={cx(
            "truncate text-[12px] leading-4",
            tone === "attention" ? "text-app-fg" : "text-app-faint",
          )}
        >
          {line}
        </span>
      ) : null}
      <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-app-muted">
        <span className="truncate">
          {agent.model} · {copy.effort[agent.effort]}
        </span>
        {back ? (
          <span className="ml-auto shrink-0 pl-2 text-app-faint tabular-nums">{back}</span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * A chat's Subagents tab on its Map (subagents-panel.tsx): whether its subagents may delegate,
 * Aerial view and the Map and List switch above the chat's own map.
 */
export function SubagentsOverview({
  lead,
  subagents,
  still = false,
}: {
  readonly lead: ReactNode;
  readonly subagents: readonly MapSubagent[];
  readonly still?: boolean;
}) {
  const copy = useReplicaCopy();
  return (
    <div className="absolute inset-0 overflow-hidden bg-app px-3 py-5">
      <div className="mx-auto w-full max-w-[768px]">
        <div className="mb-3 flex min-h-6 items-center justify-between gap-3 px-2">
          <span className="flex min-w-0 items-center gap-2 text-[13px] text-app-muted">
            <span className="truncate">{copy.letSubagentsDelegate}</span>
            <span className="relative h-3.5 w-5.5 shrink-0 rounded-full bg-[#3a83f7]">
              <span className="absolute top-px left-[9px] size-3 rounded-full bg-white shadow-[0_1px_2px_-1px_#00000014]" />
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-2">
            <span className="px-1 text-[12px] text-app-faint">{copy.aerialView}</span>
            <span className="flex gap-0.5">
              <span
                aria-label={copy.map}
                className="flex size-6 items-center justify-center rounded-[10px] bg-app-fg/5 text-app-fg"
              >
                <DelegationMapIcon className="size-4" />
              </span>
              <span
                aria-label={copy.list}
                className="flex size-6 items-center justify-center rounded-[10px] text-app-faint"
              >
                <ListIcon className="size-4" />
              </span>
            </span>
          </span>
        </div>
        <DelegationMap subagents={subagents} lead={lead} still={still} />
      </div>
    </div>
  );
}
