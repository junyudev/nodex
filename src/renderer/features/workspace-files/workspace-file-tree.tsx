import { useMemo } from "react";
import type { FileTreeRowDecoration } from "@pierre/trees";
import { FileTreeContextMenu } from "@/components/workbench/file-tree-context-menu";
import { resolveWorkspaceTreeFilePath } from "./workspace-file-model";
import { FileTree, getFileTreeEventPath } from "@/components/ui/file-tree";
import { preloadSourceViewer } from "@/components/ui/lazy-source-viewer";
import {
  buildWorkspaceFileChangesTreeModel,
  resolveWorkspaceFileChangesTreePath,
  sortWorkspaceFileChangesTree,
  WORKSPACE_ALL_FILES_SECTION,
  WORKSPACE_CHANGED_FILES_SECTION,
  type WorkspaceFileChange,
  type WorkspaceFileChangesTreeItem,
} from "./workspace-file-changes-tree-model";
import type { WorkspaceFileChangesNavigationState } from "./workspace-file-navigation-state";

export interface WorkspaceFileTreePath {
  readonly path: string;
  readonly kind: "directory" | "file";
}

export interface WorkspaceFileTreeState {
  /** Expanded browse folders, relative to the workspace root, including `""`. */
  readonly expandedPaths: readonly string[];
  readonly scrollTop: number;
  /** Present when the tree is split into Changed files and All files. */
  readonly changes?: Omit<WorkspaceFileChangesNavigationState, "selectedSection">;
}

export interface WorkspaceFileTreeProps {
  readonly workspaceRoot?: string | null;
  readonly threadId?: string | null;
  /** Browse entries, or the file search's matches while `searchQuery` is set. */
  readonly paths: readonly WorkspaceFileTreePath[];
  readonly expandedPaths: ReadonlySet<string>;
  /** Root-relative path of the open file, or of a folder with a trailing `/`. */
  readonly selectedPath: string | null;
  readonly searchQuery: string;
  /**
   * Root-relative changes of the current comparison. Any change splits the tree into Changed
   * files and All files; the split stays while a filter hides every change.
   */
  readonly changes?: readonly WorkspaceFileChange[];
  readonly changesState?: WorkspaceFileChangesNavigationState;
  /** Shown on the All files row while browse entries are loading, failed, or being searched. */
  readonly allFilesStatus?: FileTreeRowDecoration | null;
  readonly surface?: "main" | "dropdown";
  readonly initialScrollTop?: number;
  readonly revealSelectedPath?: boolean;
  readonly revealSelectedPathScrollOffset?: "top" | "center" | "nearest";
  readonly className?: string;
  readonly onOpen: (path: string, mode: "preview" | "durable") => void;
  /** Opens a Changed files entry; falls back to `onOpen`. */
  readonly onOpenChange?: (path: string, mode: "preview" | "durable") => void;
  readonly onStateChange: (state: WorkspaceFileTreeState) => void;
}

export function toPierreWorkspaceTreePaths(paths: readonly WorkspaceFileTreePath[]): string[] {
  return paths.map((item) =>
    item.kind === "directory" ? item.path.replace(/\/+$/, "") + "/" : item.path,
  );
}

const ALL_FILES_ROOT = `${WORKSPACE_ALL_FILES_SECTION}/`;
const stripTrailingSlash = (path: string) => path.replace(/\/$/, "");

export function WorkspaceFileTree({
  paths,
  expandedPaths,
  selectedPath,
  searchQuery,
  changes,
  changesState,
  allFilesStatus = null,
  surface,
  initialScrollTop = 0,
  workspaceRoot,
  threadId,
  revealSelectedPath = false,
  revealSelectedPathScrollOffset = "nearest",
  className,
  onOpen,
  onOpenChange = onOpen,
  onStateChange,
}: WorkspaceFileTreeProps) {
  const searching = searchQuery.trim().length > 0;
  const model = useMemo(
    () =>
      buildWorkspaceFileChangesTreeModel({
        changedFiles: changes ?? [],
        browsePaths: paths,
        searchQuery,
        expandedPaths,
        state: changesState,
      }),
    [changes, changesState, expandedPaths, paths, searchQuery],
  );
  const selectedTreePath = useMemo(() => {
    if (searching || !selectedPath) return null;
    if (!model.sectioned) return selectedPath;
    const relativePath = stripTrailingSlash(selectedPath);
    if (changesState?.selectedSection !== "all") {
      for (const item of model.itemsByPath.values()) {
        if (
          item.section === "changed" &&
          item.kind === "file" &&
          item.relativePath === relativePath
        )
          return item.treePath;
      }
    }
    return `${WORKSPACE_ALL_FILES_SECTION}/${selectedPath}`;
  }, [changesState?.selectedSection, model, searching, selectedPath]);

  const resolveFile = (treePath: string): WorkspaceFileChangesTreeItem | null => {
    const item = resolveWorkspaceFileChangesTreePath(model, treePath);
    return item?.kind === "file" ? item : null;
  };
  const open = (item: WorkspaceFileChangesTreeItem, mode: "preview" | "durable") =>
    (item.section === "changed" ? onOpenChange : onOpen)(item.relativePath, mode);

  return (
    <FileTreeContextMenu
      threadId={threadId}
      resolvePath={(treePath) => {
        const item = resolveFile(treePath);
        return item && workspaceRoot
          ? resolveWorkspaceTreeFilePath(workspaceRoot, item.relativePath)
          : null;
      }}
    >
      <FileTree
        key={searching ? "search" : "browse"}
        ariaLabel="Workspace files"
        appearance="workspace"
        surface={surface}
        sectioned={model.sectioned}
        decorationAlignment={model.sectioned ? "end" : "inline"}
        className={className}
        paths={model.paths}
        expandedPaths={model.defaultExpandedPaths}
        selectedPath={selectedTreePath}
        flattenEmptyDirectories={model.flattenEmptyDirectories}
        {...(model.sectioned
          ? { sort: sortWorkspaceFileChangesTree, gitStatus: model.gitStatus }
          : {})}
        renderRowDecoration={({ item }) =>
          model.sectioned && item.path === ALL_FILES_ROOT ? allFilesStatus : null
        }
        initialScrollTop={searching ? 0 : initialScrollTop}
        revealSelectedPath={!searching && revealSelectedPath}
        revealSelectedPathScrollOffset={revealSelectedPathScrollOffset}
        resetKey={searching ? searchQuery : undefined}
        onSelectionChange={(selection) => {
          const item = selection.map(resolveFile).find((item) => item !== null);
          if (item) open(item, "preview");
        }}
        onClick={(event) => {
          // Selecting the selected changed file again re-opens it, e.g. to show its changes.
          const treePath = getFileTreeEventPath(event.nativeEvent, true);
          const item = treePath && treePath === selectedTreePath ? resolveFile(treePath) : null;
          if (item?.section === "changed") open(item, "preview");
        }}
        onDoubleClick={(event) => {
          const treePath = getFileTreeEventPath(event.nativeEvent, true);
          const item = treePath ? resolveFile(treePath) : null;
          if (item) open(item, "durable");
        }}
        onPointerOver={(event) => {
          if (getFileTreeEventPath(event.nativeEvent, true)) preloadSourceViewer();
        }}
        onStateChange={(state) => {
          if (searching) return;
          if (!model.sectioned) {
            onStateChange({
              expandedPaths: ["", ...state.expandedPaths],
              scrollTop: state.scrollTop,
            });
            return;
          }
          const expanded = new Set(state.expandedPaths.map(stripTrailingSlash));
          const browseExpanded: string[] = [""];
          const collapsedChangedPaths: string[] = [];
          for (const item of model.itemsByPath.values()) {
            if (item.kind !== "directory" || !item.relativePath) continue;
            const isExpanded = expanded.has(stripTrailingSlash(item.treePath));
            if (item.section === "all" && isExpanded) browseExpanded.push(item.relativePath);
            if (item.section === "changed" && !isExpanded)
              collapsedChangedPaths.push(item.relativePath);
          }
          onStateChange({
            expandedPaths: browseExpanded,
            scrollTop: state.scrollTop,
            changes: {
              changedCollapsed: !expanded.has(WORKSPACE_CHANGED_FILES_SECTION),
              allCollapsed: !expanded.has(WORKSPACE_ALL_FILES_SECTION),
              collapsedChangedPaths,
            },
          });
        }}
      />
    </FileTreeContextMenu>
  );
}
