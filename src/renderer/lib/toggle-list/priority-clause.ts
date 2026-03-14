import type { Priority } from "../types";
import { TOGGLE_LIST_PRIORITY_ORDER } from "./types";

interface PriorityClauseLike {
  values: readonly Priority[];
  includeEmpty?: boolean;
}

export function priorityClauseIncludesEmpty(
  clause: PriorityClauseLike,
): boolean {
  return clause.includeEmpty ?? clause.values.length === TOGGLE_LIST_PRIORITY_ORDER.length;
}

export function normalizePriorityClauseIncludeEmpty(
  value: unknown,
  priorities: readonly Priority[],
): boolean {
  if (typeof value === "boolean") return value;
  return priorities.length === TOGGLE_LIST_PRIORITY_ORDER.length;
}
