import type { ThreadAgentRenderUnit, ThreadWorkedForBlockModel } from "../thread-stage-types";

export interface ThreadAgentBodyCollapsePresentation {
  /** False when collapsing would hide nothing but a lone context compaction row. */
  canCollapse: boolean;
  collapsibleUnits: ThreadAgentRenderUnit[];
  expandedUnits: readonly ThreadAgentRenderUnit[];
  persistentUnits: ThreadAgentRenderUnit[];
  workedForItem: ThreadWorkedForBlockModel | null;
}

/**
 * Keeps complete user messages visible while historical agent activity is collapsed.
 * Expanded presentation preserves the canonical unit order instead of maintaining
 * a second transcript ordering model.
 */
export function projectAgentBodyCollapsePresentation(
  units: readonly ThreadAgentRenderUnit[],
  options: { readonly extractWorkedFor?: boolean } = {},
): ThreadAgentBodyCollapsePresentation {
  const collapsibleUnits: ThreadAgentRenderUnit[] = [];
  const expandedUnits: ThreadAgentRenderUnit[] = [];
  const persistentUnits: ThreadAgentRenderUnit[] = [];
  let workedForItem: ThreadWorkedForBlockModel | null = null;

  for (const unit of units) {
    if (
      options.extractWorkedFor === true &&
      unit.kind === "entry" &&
      unit.block.type === "workedFor"
    ) {
      workedForItem = unit.block;
      continue;
    }

    expandedUnits.push(unit);
    if (unit.kind === "entry" && unit.block.type === "userMessage") {
      persistentUnits.push(unit);
      continue;
    }

    collapsibleUnits.push(unit);
  }

  const [onlyUnit] = collapsibleUnits;
  const isLoneContextCompaction =
    collapsibleUnits.length === 1 &&
    onlyUnit?.kind === "entry" &&
    onlyUnit.block.type === "contextCompaction";

  return {
    canCollapse: collapsibleUnits.length > 0 && !isLoneContextCompaction,
    collapsibleUnits,
    expandedUnits: options.extractWorkedFor === true ? expandedUnits : units,
    persistentUnits,
    workedForItem,
  };
}

export function countAgentBodyUnits(units: readonly ThreadAgentRenderUnit[]): number {
  return units.reduce(
    (count, unit) => count + (unit.kind === "agentActivityGroup" ? unit.block.entries.length : 1),
    0,
  );
}
