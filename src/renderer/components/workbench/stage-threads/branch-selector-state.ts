export interface BranchSelectorState {
  currentBranch: string | null;
  defaultBranch: string | null;
  branches: string[];
}

export const EMPTY_BRANCH_SELECTOR_STATE: BranchSelectorState = {
  currentBranch: null,
  defaultBranch: null,
  branches: [],
};

function normalizePath(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function resolveBranchSelectorCwd(
  threadCwd: string | null | undefined,
  projectWorkspacePath: string | null | undefined,
): string | null {
  return normalizePath(threadCwd) ?? normalizePath(projectWorkspacePath);
}

export function parseBranchSelectorState(result: unknown): BranchSelectorState {
  if (!result || typeof result !== "object") {
    return EMPTY_BRANCH_SELECTOR_STATE;
  }

  const candidate = result as {
    error?: unknown;
    currentBranch?: unknown;
    defaultBranch?: unknown;
    branches?: unknown;
  };

  if (typeof candidate.error === "string" && candidate.error.trim()) {
    throw new Error(candidate.error);
  }

  const currentBranch =
    typeof candidate.currentBranch === "string" && candidate.currentBranch.trim()
      ? candidate.currentBranch.trim()
      : null;

  const defaultBranch =
    typeof candidate.defaultBranch === "string" && candidate.defaultBranch.trim()
      ? candidate.defaultBranch.trim()
      : null;

  const branches = Array.isArray(candidate.branches)
    ? candidate.branches
      .filter((branch): branch is string => typeof branch === "string")
      .map((branch) => branch.trim())
      .filter((branch, index, items) => branch.length > 0 && items.indexOf(branch) === index)
    : [];

  return {
    currentBranch,
    defaultBranch,
    branches,
  };
}

export function filterBranchSelectorBranches(
  branches: string[],
  query: string,
): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return branches;

  return branches.filter((branch) =>
    branch.toLowerCase().includes(normalizedQuery),
  );
}

export function isBranchSelectorMutationCurrent(input: {
  activeRequestId: number;
  requestId: number;
  activeCwd: string | null | undefined;
  requestedCwd: string;
}): boolean {
  const requestedCwd = normalizePath(input.requestedCwd);
  if (!requestedCwd) return false;

  return (
    input.activeRequestId === input.requestId &&
    normalizePath(input.activeCwd) === requestedCwd
  );
}
