import { type ComposerChatKey } from "@/lib/composer-draft-intents";
import { useMemo } from "react";
import type { FileTreeRowDecoration } from "@pierre/trees";
import { FileTreeContextMenu } from "@/components/workbench/file-tree-context-menu";
import { resolveWorkspaceTreeFilePath } from "./workspace-file-model";
import { FileTree, getFileTreeEventPath } from "@/components/ui/file-tree";
import { preloadSourceViewer } from "@/components/ui/lazy-source-viewer";
import {
  buildWorkspaceFileChangesTreeModel,
  readWorkspaceFileTreeExpansion,
  resolveWorkspaceFileChangesTreePath,
  sortWorkspaceFileChangesTree,
  WORKSPACE_ALL_FILES_SECTION,
  type WorkspaceFileChange,
  type WorkspaceFileChangesTreeItem,
  type WorkspaceFileTreeExpansion,
} from "./workspace-file-changes-tree-model";
import type { WorkspaceFileChangesNavigationState } from "./workspace-file-navigation-state";

export interface WorkspaceFileTreePath {
  readonly path: string;
  readonly kind: "directory" | "file";
}

export interface WorkspaceFileTreeProps {
  readonly workspaceRoot?: string | null;
  readonly composerChatKey?: ComposerChatKey | null;
  /** Browse entries, or the file search's matches while `searchQuery` is set. */
  readonly paths: readonly WorkspaceFileTreePath[];
  /** Expanded browse folders, relative to the workspace root; the root is implied. */
  readonly expandedPaths: readonly string[];
  /** Expanded browse folders whose entries are still loading. */
  readonly loadingDirectoryPaths?: readonly string[];
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
  /** The user expanded or collapsed browse folders or sections; search results never report. */
  readonly onExpansionChange: (expansion: WorkspaceFileTreeExpansion) => void;
  readonly onScrollTopChange?: (scrollTop: number) => void;
}

export function toPierreWorkspaceTreePaths(paths: readonly WorkspaceFileTreePath[]): string[] {
  return paths.map((item) =>
    item.kind === "directory" ? item.path.replace(/\/+$/, "") + "/" : item.path,
  );
}

const ALL_FILES_ROOT = `${WORKSPACE_ALL_FILES_SECTION}/`;
const NO_PATHS: readonly string[] = [];

export function WorkspaceFileTree({
  paths,
  expandedPaths,
  loadingDirectoryPaths = NO_PATHS,
  selectedPath,
  searchQuery,
  changes,
  changesState,
  allFilesStatus = null,
  surface,
  initialScrollTop = 0,
  workspaceRoot,
  composerChatKey,
  revealSelectedPath = false,
  revealSelectedPathScrollOffset = "nearest",
  className,
  onOpen,
  onOpenChange = onOpen,
  onExpansionChange,
  onScrollTopChange,
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
    const relativePath = selectedPath.replace(/\/$/, "");
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
      composerChatKey={composerChatKey}
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
        expandedPaths={model.expandedPaths}
        loadingDirectoryPaths={
          searching
            ? NO_PATHS
            : model.sectioned
              ? loadingDirectoryPaths.map((path) => `${WORKSPACE_ALL_FILES_SECTION}/${path}`)
              : loadingDirectoryPaths
        }
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
        onExpandedPathsChange={(treeExpandedPaths) => {
          if (!searching)
            onExpansionChange(
              readWorkspaceFileTreeExpansion(model, treeExpandedPaths, changesState),
            );
        }}
        onScrollTopChange={searching ? undefined : onScrollTopChange}
      />
    </FileTreeContextMenu>
  );
}
