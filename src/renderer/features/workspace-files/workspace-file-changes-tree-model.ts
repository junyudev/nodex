import {
  prepareFileTreeInput,
  type FileTreeSortComparator,
  type GitStatusEntry,
} from "@pierre/trees";
import type { GitReviewFileSummary } from "@/lib/types";
import { buildFileTreeExpandedPaths, buildFileTreePaths } from "@/lib/file-tree-paths";
import { createFuzzyQueryScorer } from "@/lib/settings-search-score";
import type { WorkspaceFileTreePath } from "./workspace-file-tree";

export const WORKSPACE_CHANGED_FILES_SECTION = "Changed files";
export const WORKSPACE_ALL_FILES_SECTION = "All files";

/** Paths here are relative to the selected workspace root, not necessarily the Git root. */
export type WorkspaceFileChange = Pick<GitReviewFileSummary, "path" | "status">;
export type WorkspaceFileTreeSection = "changed" | "all";

export interface WorkspaceFileChangesTreeItem {
  readonly treePath: string;
  readonly section: WorkspaceFileTreeSection;
  readonly relativePath: string;
  readonly kind: "file" | "directory";
}

export interface WorkspaceFileChangesTreeState {
  readonly changedCollapsed?: boolean;
  readonly allCollapsed?: boolean;
  readonly collapsedChangedPaths?: readonly string[];
}

export interface WorkspaceFileChangesTreeModel {
  readonly sectioned: boolean;
  readonly flattenEmptyDirectories: boolean;
  readonly paths: readonly string[];
  readonly itemsByPath: ReadonlyMap<string, WorkspaceFileChangesTreeItem>;
  readonly gitStatus: readonly GitStatusEntry[];
  readonly decorationsByPath: ReadonlyMap<string, GitStatusEntry["status"]>;
  readonly defaultExpandedPaths: readonly string[];
  readonly changedFileCount: number;
  readonly matchingChangedFileCount: number;
}

/**
 * Puts Changed files first. Entries within a section compare equal, so the tree keeps the
 * model's default directory/name order for them.
 */
export const sortWorkspaceFileChangesTree: FileTreeSortComparator = (left, right) =>
  Number(right.segments[0] === WORKSPACE_CHANGED_FILES_SECTION) -
  Number(left.segments[0] === WORKSPACE_CHANGED_FILES_SECTION);

/**
 * Builds one tree; section presence depends on unfiltered changes so filtering cannot switch
 * layouts. The query filters changed files only; browse paths arrive already searched.
 */
export function buildWorkspaceFileChangesTreeModel({
  changedFiles,
  browsePaths,
  searchQuery = "",
  expandedPaths = [],
  state = {},
  enabled = true,
}: {
  readonly changedFiles: readonly WorkspaceFileChange[];
  /** During search, supply the native search's root-relative file results here. */
  readonly browsePaths: readonly WorkspaceFileTreePath[];
  readonly searchQuery?: string;
  readonly expandedPaths?: Iterable<string>;
  readonly state?: WorkspaceFileChangesTreeState;
  readonly enabled?: boolean;
}): WorkspaceFileChangesTreeModel {
  const changesByPath = new Map<string, WorkspaceFileChange>();
  for (const file of changedFiles) {
    if (!changesByPath.has(file.path)) changesByPath.set(file.path, file);
  }
  const changed = [...changesByPath.values()];
  const searching = searchQuery.trim().length > 0;
  const score = createFuzzyQueryScorer(searchQuery);
  const matches = (path: string) => !searching || score(path) > 0;
  const matchingChanged = changed.filter((file) => matches(file.path));
  const sectioned = enabled && changed.length > 0;
  const items = new Map<string, WorkspaceFileChangesTreeItem>();
  const gitStatus: GitStatusEntry[] = [];
  const add = (
    section: WorkspaceFileTreeSection,
    path: string,
    kind: "file" | "directory",
    treePath = path,
  ) => {
    const prefix =
      section === "changed" ? WORKSPACE_CHANGED_FILES_SECTION : WORKSPACE_ALL_FILES_SECTION;
    const displayPath = sectioned ? `${prefix}/${treePath}` : treePath;
    const key = kind === "directory" ? `${displayPath.replace(/\/$/, "")}/` : displayPath;
    items.set(key, { treePath: key, section, relativePath: path.replace(/\/$/, ""), kind });
    return key;
  };
  const addParents = (section: WorkspaceFileTreeSection, path: string) => {
    for (const parent of buildFileTreeExpandedPaths([path])) add(section, parent, "directory");
  };
  if (sectioned) {
    add("changed", "", "directory");
    add("all", "", "directory");
    const mapped = buildFileTreePaths(
      matchingChanged.map((file) => ({ ...file, displayPath: file.path })),
    );
    for (const { entry, treePath } of mapped) {
      addParents("changed", treePath);
      const path = add("changed", entry.path, "file", treePath);
      // The section represents the comparison, rather than today's porcelain status letters.
      const status =
        entry.status === "deleted"
          ? "deleted"
          : ["added", "untracked", "copied"].includes(entry.status)
            ? "added"
            : "modified";
      gitStatus.push({ path, status });
    }
  }
  const browse = [
    ...new Map(browsePaths.map((entry) => [`${entry.kind}:${entry.path}`, entry])).values(),
  ];
  // While searching, browse paths already are the native search's results.
  const files = browse.filter((entry) => entry.kind === "file");
  const mappedFiles = searching
    ? buildFileTreePaths(files.map((entry) => ({ ...entry, displayPath: entry.path })))
    : files.map((entry) => ({ entry, treePath: entry.path }));
  for (const { entry, treePath } of mappedFiles) {
    addParents("all", treePath);
    add("all", entry.path, "file", treePath);
  }
  if (!searching) {
    for (const entry of browse.filter((entry) => entry.kind === "directory")) {
      addParents("all", entry.path);
      add("all", entry.path, "directory");
    }
  }
  const sorted = prepareFileTreeInput([...items.keys()], { flattenEmptyDirectories: false }).paths;
  const inChanged = (path: string) => path.startsWith(`${WORKSPACE_CHANGED_FILES_SECTION}/`);
  const paths = sectioned
    ? [...sorted.filter(inChanged), ...sorted.filter((path) => !inChanged(path))]
    : sorted;
  const allExpanded = searching
    ? buildFileTreeExpandedPaths(mappedFiles.map(({ treePath }) => treePath))
    : [...expandedPaths].filter(Boolean);
  const collapsedChanged = new Set(state.collapsedChangedPaths);
  const defaultExpandedPaths = sectioned
    ? [
        ...(!state.changedCollapsed ? [WORKSPACE_CHANGED_FILES_SECTION] : []),
        ...(!state.allCollapsed ? [WORKSPACE_ALL_FILES_SECTION] : []),
        ...[...items.values()]
          .filter(
            (item) =>
              item.section === "changed" &&
              item.kind === "directory" &&
              item.relativePath &&
              !collapsedChanged.has(item.relativePath),
          )
          .map((item) => item.treePath.replace(/\/$/, "")),
        ...allExpanded.map((path) => `${WORKSPACE_ALL_FILES_SECTION}/${path}`),
      ]
    : allExpanded;
  return {
    sectioned,
    flattenEmptyDirectories: !sectioned && searching,
    paths,
    itemsByPath: items,
    gitStatus,
    decorationsByPath: new Map(gitStatus.map(({ path, status }) => [path, status])),
    defaultExpandedPaths: [...new Set(defaultExpandedPaths)],
    changedFileCount: changed.length,
    matchingChangedFileCount: matchingChanged.length,
  };
}

/** Resolve through the model so real folders named like a section and display collisions stay unambiguous. */
export function resolveWorkspaceFileChangesTreePath(
  model: WorkspaceFileChangesTreeModel,
  treePath: string,
): WorkspaceFileChangesTreeItem | null {
  return model.itemsByPath.get(treePath) ?? model.itemsByPath.get(`${treePath}/`) ?? null;
}
