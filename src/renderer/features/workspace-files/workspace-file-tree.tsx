import { useMemo } from "react";
import { FileTreeContextMenu } from "@/components/workbench/file-tree-context-menu";
import { resolveWorkspaceTreeFilePath } from "./workspace-file-model";
import { FileTree, getFileTreeEventPath, type FileTreeState } from "@/components/ui/file-tree";
import { preloadSourceViewer } from "@/components/ui/lazy-source-viewer";
import { buildFileTreeExpandedPaths, buildFileTreePaths } from "@/lib/file-tree-paths";

export interface WorkspaceFileTreePath {
  readonly path: string;
  readonly kind: "directory" | "file";
}
export type WorkspaceFileTreeState = FileTreeState;

export interface WorkspaceFileTreeProps {
  readonly workspaceRoot?: string | null;
  readonly threadId?: string | null;
  readonly paths: readonly WorkspaceFileTreePath[];
  readonly expandedPaths: ReadonlySet<string>;
  readonly selectedPath: string | null;
  readonly searchQuery: string;
  readonly initialScrollTop?: number;
  readonly revealSelectedPath?: boolean;
  readonly revealSelectedPathScrollOffset?: "top" | "center" | "nearest";
  readonly className?: string;
  readonly onOpen: (path: string, mode: "preview" | "durable") => void;
  readonly onStateChange: (state: WorkspaceFileTreeState) => void;
}

export function toPierreWorkspaceTreePaths(paths: readonly WorkspaceFileTreePath[]): string[] {
  return paths.map((item) =>
    item.kind === "directory" ? item.path.replace(/\/+$/, "") + "/" : item.path,
  );
}

export function WorkspaceFileTree({
  paths,
  expandedPaths,
  selectedPath,
  searchQuery,
  initialScrollTop = 0,
  workspaceRoot,
  threadId,
  revealSelectedPath = false,
  revealSelectedPathScrollOffset = "nearest",
  className,
  onOpen,
  onStateChange,
}: WorkspaceFileTreeProps) {
  const searching = searchQuery.trim().length > 0;
  const mapped = useMemo(
    () =>
      searching
        ? buildFileTreePaths(
            paths
              .filter((item) => item.kind === "file")
              .map((item) => ({
                path: item.path,
                displayPath: item.path,
              })),
          )
        : [],
    [paths, searching],
  );
  const treePaths = useMemo(
    () => (searching ? mapped.map(({ treePath }) => treePath) : toPierreWorkspaceTreePaths(paths)),
    [mapped, paths, searching],
  );
  const searchPaths = useMemo(
    () => new Map(mapped.map(({ entry, treePath }) => [treePath, entry.path])),
    [mapped],
  );
  const initialExpandedPaths = useMemo(
    () => (searching ? buildFileTreeExpandedPaths(treePaths) : [...expandedPaths]),
    [expandedPaths, searching, treePaths],
  );
  const resolveFilePath = (treePath: string) =>
    searching
      ? searchPaths.get(treePath)
      : paths.find((item) => item.kind === "file" && item.path === treePath)?.path;

  return (
    <FileTreeContextMenu
      threadId={threadId}
      resolvePath={(treePath) => {
        const path = resolveFilePath(treePath);
        return path && workspaceRoot ? resolveWorkspaceTreeFilePath(workspaceRoot, path) : null;
      }}
    >
      <FileTree
        key={searching ? "search" : "browse"}
        ariaLabel="Workspace files"
        appearance="workspace"
        className={className}
        paths={treePaths}
        expandedPaths={initialExpandedPaths}
        selectedPath={searching ? null : selectedPath}
        flattenEmptyDirectories={searching}
        initialScrollTop={searching ? 0 : initialScrollTop}
        revealSelectedPath={!searching && revealSelectedPath}
        revealSelectedPathScrollOffset={revealSelectedPathScrollOffset}
        resetKey={searching ? searchQuery : undefined}
        onSelectionChange={(selection) => {
          const path = selection.map(resolveFilePath).find((path) => path !== undefined);
          if (path) onOpen(path, "preview");
        }}
        onDoubleClick={(event) => {
          const treePath = getFileTreeEventPath(event.nativeEvent, true);
          const path = treePath ? resolveFilePath(treePath) : undefined;
          if (path) onOpen(path, "durable");
        }}
        onPointerOver={(event) => {
          if (getFileTreeEventPath(event.nativeEvent, true)) preloadSourceViewer();
        }}
        onStateChange={(state) => {
          if (searching) return;
          onStateChange({ ...state, expandedPaths: ["", ...state.expandedPaths] });
        }}
      />
    </FileTreeContextMenu>
  );
}
