import type { SubagentOverviewRow } from "../../agent-runtime-subagent-overview";

/**
 * The map's geometry, in CSS pixels at the default root font size. The view lays the same
 * numbers out in rem, so cards and the edges drawn between them scale together.
 */
export const DELEGATION_MAP_GEOMETRY = {
  leadHeight: 104,
  /** The lane the lead's edges fan across when the lead sits beside its subagents. */
  fanWidth: 64,
  fullHeight: 84,
  compactHeight: 36,
  moreHeight: 28,
  gap: 8,
  /** How far each level of delegation steps in, and where its rail runs inside that step. */
  indent: 28,
  railX: 12,
  railRadius: 8,
  /** The space between the lead and its subagents when the lead sits above them. */
  leadGap: 12,
  /** The lead stays centered on a short column and stops here beside a long one. */
  leadPinY: 188,
  /** Every subagent keeps a full card up to this many; beyond it, settled ones fold to a line. */
  fullCardBudget: 6,
} as const;

/**
 * What the line between a subagent and whoever delegated it says: work under way, work held for
 * an answer, a result that came back, or work that ended without one.
 */
export type DelegationEdgeState = "flowing" | "paused" | "returned" | "ended";

export interface DelegationMapNode {
  readonly row: SubagentOverviewRow;
  /** 1 for a subagent the lead delegated, 2 for one that subagent delegated, and so on. */
  readonly depth: number;
  readonly density: "full" | "compact";
  readonly top: number;
  readonly height: number;
  readonly centerY: number;
  readonly edge: DelegationEdgeState;
}

/** One delegator's line down to the subagents it delegated, in delegation order. */
export interface DelegationMapRail {
  /** The delegating subagent's row key, or null for the lead. */
  readonly parentKey: string | null;
  /** The delegator's own depth; the lead is 0. */
  readonly depth: number;
  /** Where the rail leaves its delegator, in the column's coordinates. */
  readonly top: number;
  readonly nodes: readonly DelegationMapNode[];
}

export interface DelegationMap {
  /** Every subagent top to bottom, each beneath whoever delegated it. */
  readonly nodes: readonly DelegationMapNode[];
  readonly rails: readonly DelegationMapRail[];
  readonly columnHeight: number;
  readonly maxDepth: number;
  /** The lead beside its subagents: where each sits so the lead's edges fan evenly. */
  readonly beside: {
    readonly height: number;
    readonly leadTop: number;
    readonly leadCenterY: number;
    readonly columnTop: number;
  };
}

export function delegationEdgeState(row: SubagentOverviewRow): DelegationEdgeState {
  if (row.status === "done")
    // An idle batch handed control back to its delegator, whatever became of its children.
    return row.outcome === "failed" || row.outcome === "stopped" || row.outcome === "cancelled"
      ? "ended"
      : "returned";
  if (row.status === "active" && !row.attentionKind) return "flowing";
  return "paused";
}

/** When the subagent was first delegated; a later turn never moves its card. */
const delegatedAt = (row: SubagentOverviewRow) =>
  row.delegatedAtMs ?? row.startedAtMs ?? row.recencyAtMs ?? 0;

/**
 * Places a conversation's subagents as a tree under their lead. Subagents keep the order they
 * were delegated in, so a card holds its place while its status changes. A subagent whose
 * delegator is not among the rows hangs from the lead.
 */
export function projectDelegationMap(input: {
  readonly rootThreadId: string;
  readonly rows: readonly SubagentOverviewRow[];
  /** Whether a control for the subagents not shown yet takes the top of the column. */
  readonly moreAbove: boolean;
  /**
   * Where the lead sits beside its subagents: centered on a short column, or at the top, where a
   * stack of maps keeps every lead in line under its caption.
   */
  readonly leadPlacement?: "centered" | "top";
}): DelegationMap {
  const geometry = DELEGATION_MAP_GEOMETRY;
  const byKey = new Map(input.rows.map((row) => [row.threadId, row]));
  const delegatorOf = (row: SubagentOverviewRow): string | null => {
    const parent = row.parentThreadId;
    if (parent === null || parent === input.rootThreadId || parent === row.threadId) return null;
    if (!byKey.has(parent)) return null;
    // A chain that loops back never reaches the lead; its members hang from the lead instead.
    const seen = new Set([row.threadId]);
    for (let key: string | null = parent; key !== null && key !== input.rootThreadId;) {
      if (seen.has(key)) return null;
      seen.add(key);
      key = byKey.get(key)?.parentThreadId ?? null;
    }
    return parent;
  };
  const children = new Map<string | null, SubagentOverviewRow[]>();
  for (const row of byKey.values()) {
    const parent = delegatorOf(row);
    children.set(parent, [...(children.get(parent) ?? []), row]);
  }
  for (const siblings of children.values())
    siblings.sort(
      (left, right) =>
        delegatedAt(left) - delegatedAt(right) || left.threadId.localeCompare(right.threadId),
    );

  const foldSettled = byKey.size > geometry.fullCardBudget;
  const nodes: DelegationMapNode[] = [];
  const rails: DelegationMapRail[] = [];
  let top = input.moreAbove ? geometry.moreHeight + geometry.gap : 0;
  let maxDepth = 0;
  const place = (parentKey: string | null, depth: number, railTop: number) => {
    const placed: DelegationMapNode[] = [];
    for (const row of children.get(parentKey) ?? []) {
      const density = foldSettled && row.status === "done" ? "compact" : "full";
      const height = density === "full" ? geometry.fullHeight : geometry.compactHeight;
      const node: DelegationMapNode = {
        row,
        depth,
        density,
        top,
        height,
        centerY: top + height / 2,
        edge: delegationEdgeState(row),
      };
      nodes.push(node);
      placed.push(node);
      maxDepth = Math.max(maxDepth, depth);
      top += height + geometry.gap;
      place(row.threadId, depth + 1, node.top + height);
    }
    if (placed.length > 0) rails.push({ parentKey, depth: depth - 1, top: railTop, nodes: placed });
  };
  place(null, 1, -geometry.leadGap);

  const columnHeight = Math.max(0, top - geometry.gap);
  const halfLead = geometry.leadHeight / 2;
  const atTop = input.leadPlacement === "top";
  const leadCenterY = atTop
    ? halfLead
    : Math.min(Math.max(columnHeight / 2, halfLead), geometry.leadPinY);
  const columnTop = atTop ? 0 : Math.max(0, halfLead - columnHeight / 2);
  return {
    nodes,
    rails,
    columnHeight,
    maxDepth,
    beside: {
      height: Math.max(columnTop + columnHeight, leadCenterY + halfLead),
      leadTop: leadCenterY - halfLead,
      leadCenterY,
      columnTop,
    },
  };
}

/** An edge from the lead's side across the fan lane to a subagent's side. */
export function delegationFanPath(fromY: number, toY: number): string {
  const { fanWidth } = DELEGATION_MAP_GEOMETRY;
  const bend = fanWidth / 2;
  return `M0,${fromY} C${bend},${fromY} ${bend},${toY} ${fanWidth},${toY}`;
}

/** Where a rail runs for a delegator at `depth`, in the column's coordinates. */
export function delegationRailX(depth: number): number {
  return depth * DELEGATION_MAP_GEOMETRY.indent + DELEGATION_MAP_GEOMETRY.railX;
}

/**
 * The shared line a delegator's subagents branch from, down to the turn into `through`: its last
 * subagent unless another is named.
 */
export function delegationRailTrunkPath(
  rail: DelegationMapRail,
  through: DelegationMapNode = rail.nodes[rail.nodes.length - 1]!,
): string {
  const x = delegationRailX(rail.depth);
  return `M${x},${rail.top} V${through.centerY - DELEGATION_MAP_GEOMETRY.railRadius}`;
}

/** The turn off a rail into one subagent's card. */
export function delegationRailBranchPath(rail: DelegationMapRail, node: DelegationMapNode): string {
  const { indent, railRadius } = DELEGATION_MAP_GEOMETRY;
  const x = delegationRailX(rail.depth);
  const y = node.centerY;
  return `M${x},${y - railRadius} Q${x},${y} ${x + railRadius},${y} H${(rail.depth + 1) * indent}`;
}

/** The whole way from a delegator down its rail and into one subagent's card. */
export function delegationRailRunPath(rail: DelegationMapRail, node: DelegationMapNode): string {
  const { indent, railRadius } = DELEGATION_MAP_GEOMETRY;
  const x = delegationRailX(rail.depth);
  const y = node.centerY;
  return `M${x},${rail.top} V${y - railRadius} Q${x},${y} ${x + railRadius},${y} H${(rail.depth + 1) * indent}`;
}

/** How many subagents a conversation's work tree holds and how many have reported back. */
export function summarizeDelegation(overview: {
  readonly active: { readonly totalCount: number | null; readonly knownCount: number };
  readonly done: { readonly totalCount: number | null; readonly knownCount: number };
}): { readonly total: number; readonly back: number } {
  const count = (section: { readonly totalCount: number | null; readonly knownCount: number }) =>
    section.totalCount ?? section.knownCount;
  const back = count(overview.done);
  return { total: count(overview.active) + back, back };
}
