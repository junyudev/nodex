import { appScope, scopedAtom, scopedAtomFamily } from "@/lib/maitai";

export interface WorkspaceFileNavigationKey {
  readonly hostId: string;
  readonly includeHidden: boolean;
  readonly workspaceRoot: string;
}

/** How the Changed files / All files split is folded, and which section the open file shows in. */
export interface WorkspaceFileChangesNavigationState {
  readonly changedCollapsed: boolean;
  readonly allCollapsed: boolean;
  /** Changed-section folders (root-relative) the user collapsed; others start open. */
  readonly collapsedChangedPaths: readonly string[];
  readonly selectedSection: "changed" | "all";
}

export interface WorkspaceFileNavigationState {
  readonly expandedPaths: readonly string[];
  readonly selectedPath: string | null;
  readonly searchQuery: string;
  readonly scrollTop: number;
  readonly changes: WorkspaceFileChangesNavigationState;
}

export function normalizeWorkspaceFileNavigationKey(
  key: WorkspaceFileNavigationKey,
): WorkspaceFileNavigationKey {
  const workspaceRootWithForwardSlashes = key.workspaceRoot.replace(/\\/g, "/");
  const workspaceRoot = /^\/+$/.test(workspaceRootWithForwardSlashes)
    ? "/"
    : /^[a-z]:\/+$/i.test(workspaceRootWithForwardSlashes)
      ? `${workspaceRootWithForwardSlashes.slice(0, 2)}/`
      : workspaceRootWithForwardSlashes.replace(/\/+$/, "");

  return {
    hostId: key.hostId,
    includeHidden: key.includeHidden,
    workspaceRoot,
  };
}

export const EMPTY_WORKSPACE_FILE_NAVIGATION_STATE: WorkspaceFileNavigationState = Object.freeze({
  expandedPaths: Object.freeze([""]),
  selectedPath: null,
  searchQuery: "",
  scrollTop: 0,
  changes: Object.freeze({
    changedCollapsed: false,
    allCollapsed: false,
    collapsedChangedPaths: Object.freeze([]),
    selectedSection: "changed",
  }),
});

function normalizeNavigationPath(path: string): string | null {
  const segments: string[] = [];
  for (const segment of path.replace(/\\/g, "/").split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

function normalizedUniquePaths(paths: readonly string[]): readonly string[] {
  const result = [""];
  const seen = new Set(result);
  for (const rawPath of paths) {
    const path = normalizeNavigationPath(rawPath);
    if (path === null) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    result.push(path);
  }
  return result;
}

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function normalizeWorkspaceFileNavigationState(
  state: WorkspaceFileNavigationState,
): WorkspaceFileNavigationState {
  const expandedPaths = normalizedUniquePaths(state.expandedPaths);
  const selectedPath =
    state.selectedPath === null ? null : normalizeNavigationPath(state.selectedPath);
  const scrollTop = Number.isFinite(state.scrollTop) ? Math.max(0, state.scrollTop) : 0;

  if (
    equalStringArrays(state.expandedPaths, expandedPaths) &&
    state.selectedPath === selectedPath &&
    state.scrollTop === scrollTop
  ) {
    return state;
  }

  return {
    expandedPaths,
    selectedPath,
    searchQuery: state.searchQuery,
    scrollTop,
    changes: state.changes,
  };
}

export function selectWorkspaceFileNavigationPath(
  state: WorkspaceFileNavigationState,
  selectedPath: string | null,
): WorkspaceFileNavigationState {
  if (selectedPath === null) {
    if (state.selectedPath === null) return state;
    return { ...state, selectedPath: null };
  }

  const normalizedSelectedPath = normalizeNavigationPath(selectedPath);
  if (normalizedSelectedPath === null) {
    if (state.selectedPath === null) return state;
    return { ...state, selectedPath: null };
  }
  const segments = normalizedSelectedPath.split("/").filter(Boolean);
  const ancestors = [""];
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.push(segments.slice(0, index).join("/"));
  }
  const expandedPaths = normalizedUniquePaths([...state.expandedPaths, ...ancestors]);

  if (
    state.selectedPath === normalizedSelectedPath &&
    equalStringArrays(state.expandedPaths, expandedPaths)
  ) {
    return state;
  }

  return {
    ...state,
    expandedPaths,
    selectedPath: normalizedSelectedPath,
  };
}

export function updateWorkspaceFileNavigationExpansion(
  state: WorkspaceFileNavigationState,
  path: string,
  expanded: boolean,
): WorkspaceFileNavigationState {
  const normalizedPath = normalizeNavigationPath(path);
  if (normalizedPath === null) return state;
  const nextPaths = new Set(state.expandedPaths);
  if (expanded || normalizedPath === "") {
    nextPaths.add(normalizedPath);
  } else {
    nextPaths.delete(normalizedPath);
  }
  const expandedPaths = normalizedUniquePaths([...nextPaths]);
  return equalStringArrays(state.expandedPaths, expandedPaths)
    ? state
    : { ...state, expandedPaths };
}

export const workspaceFileNavigationStateFamily = scopedAtomFamily({
  scope: appScope,
  debugLabel: "workspace-file-navigation-state",
  key: normalizeWorkspaceFileNavigationKey,
  create: () =>
    scopedAtom<WorkspaceFileNavigationState>(appScope, EMPTY_WORKSPACE_FILE_NAVIGATION_STATE, {
      debugLabel: "navigation",
    }),
});
