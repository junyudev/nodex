import type { Card, CardRunInTarget } from "@/lib/types";
import type { BranchSelectorState } from "@/components/workbench/stage-threads/branch-selector-state";

export function normalizeRunInTarget(value: Card["runInTarget"]): CardRunInTarget {
  if (value === "newWorktree") return "newWorktree";
  if (value === "cloud") return "cloud";
  return "localProject";
}

export function resolveDefaultRunInBaseBranch(state: BranchSelectorState): string {
  const normalizedBranches = state.branches.filter((branch) => branch.trim().length > 0);
  const candidates = [
    state.defaultBranch,
    "main",
    "master",
    state.currentBranch,
    normalizedBranches[0],
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (!normalized) continue;
    if (
      normalizedBranches.includes(normalized)
      || normalized === state.defaultBranch
      || normalized === state.currentBranch
    ) {
      return normalized;
    }
  }

  return "";
}
