import type { ThreadAgentRenderUnit, ThreadWorkedForBlockModel } from "../thread-stage-types";

export interface ThreadAgentBodyCollapsePresentation {
  collapsibleUnits: ThreadAgentRenderUnit[];
  expandedUnits: readonly ThreadAgentRenderUnit[];
  persistentUnits: ThreadAgentRenderUnit[];
  workedForItem: ThreadWorkedForBlockModel | null;
}

function isCollapsePersistentUnit(unit: ThreadAgentRenderUnit): boolean {
  if (unit.kind !== "entry" || unit.block.type !== "userMessage") return false;

  const steeringStatus = unit.block.entry.steeringStatus;
  return (
    (steeringStatus !== undefined && steeringStatus !== null) ||
    unit.block.entry.hookFeedback === true
  );
}

/**
 * Keeps steering and hook-feedback messages visible while historical agent
 * activity is collapsed. Expanded presentation preserves the canonical unit
 * order instead of maintaining a second transcript ordering model.
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
    if (isCollapsePersistentUnit(unit)) {
      persistentUnits.push(unit);
      continue;
    }

    collapsibleUnits.push(unit);
  }

  return {
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
