import type { ThreadAgentRenderUnit, ThreadWorkedForBlockModel } from "../thread-stage-types";
import type { CodexConversationItem } from "../../../lib/types";
import { normalizeAutomaticApprovalReviewPayload } from "../../../../shared/codex-transcript-special-items";
import { wasToolExecutionDeclinedByAutomaticReview } from "./tool-metadata/automatic-approval-review";

/** One agent-body unit in canonical order; a persistent unit stays visible while work collapses. */
export interface ThreadAgentBodyUnit {
  readonly unit: ThreadAgentRenderUnit;
  readonly persistent: boolean;
}

export interface ThreadAgentBodyCollapsePresentation {
  /** The body's units in canonical order, without an extracted worked-for row. */
  bodyUnits: ThreadAgentBodyUnit[];
  /** False when collapsing would hide nothing but a lone context compaction row. */
  canCollapse: boolean;
  collapsibleUnits: ThreadAgentRenderUnit[];
  workedForItem: ThreadWorkedForBlockModel | null;
}

/**
 * Keeps questions, user messages, request recovery and the Turn's reply visible while activity
 * is collapsed. The reply is every final-answer message, plus `replyBlockId` for a harness that
 * reports no message phases. Units are only marked persistent, never moved into a second
 * transcript ordering, so folding work around them cannot reorder or remount what stays visible.
 */
export function projectAgentBodyCollapsePresentation(
  units: readonly ThreadAgentRenderUnit[],
  options: { readonly extractWorkedFor?: boolean; readonly replyBlockId?: string | null } = {},
): ThreadAgentBodyCollapsePresentation {
  const bodyUnits: ThreadAgentBodyUnit[] = [];
  const collapsibleUnits: ThreadAgentRenderUnit[] = [];
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

    const persistent =
      unit.kind === "entry" &&
      (unit.block.type === "userMessage" ||
        unit.block.id === options.replyBlockId ||
        (unit.block.type === "assistantMessage" &&
          (unit.block.entry.asyncQuestion !== undefined ||
            unit.block.entry.assistantPhase === "final_answer")) ||
        ("entry" in unit.block && unit.block.entry.recovery !== undefined));
    bodyUnits.push({ unit, persistent });
    if (!persistent) collapsibleUnits.push(unit);
  }

  const [onlyUnit] = collapsibleUnits;
  const isLoneContextCompaction =
    collapsibleUnits.length === 1 &&
    onlyUnit?.kind === "entry" &&
    onlyUnit.block.type === "contextCompaction";

  return {
    bodyUnits,
    canCollapse: collapsibleUnits.length > 0 && !isLoneContextCompaction,
    collapsibleUnits,
    workedForItem,
  };
}

export function countAgentBodyUnits(units: readonly ThreadAgentRenderUnit[]): number {
  return units.reduce(
    (count, unit) => count + (unit.kind === "agentActivityGroup" ? unit.block.entries.length : 1),
    0,
  );
}

/** Counts historical review decisions, independently of where their tool rows are rendered. */
export function countDeniedThreadActions(items: readonly CodexConversationItem[]): number {
  return items.filter(
    (item) =>
      item.semanticKind === "automaticApprovalReview" &&
      normalizeAutomaticApprovalReviewPayload(item.rawItem)?.status === "denied",
  ).length;
}

/** A refusal lives on its standalone review or the execution that owns that review. */
export function isDeniedAgentBodyUnit(unit: ThreadAgentRenderUnit): boolean {
  if (unit.kind !== "entry") return false;
  const { block } = unit;
  if (block.type === "automaticApprovalReview")
    return normalizeAutomaticApprovalReviewPayload(block.entry.rawItem)?.status === "denied";
  if (block.type !== "exec" && block.type !== "fileChange") return false;
  return wasToolExecutionDeclinedByAutomaticReview({
    type: block.type,
    entry: block.entry,
    automaticApprovalReviews: block.automaticApprovalReviews,
  });
}
