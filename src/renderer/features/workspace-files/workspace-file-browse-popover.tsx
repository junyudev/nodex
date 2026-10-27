import { useState, type ReactNode } from "react";
import { NodexPopover, NodexPopoverContent, NodexPopoverTrigger } from "@/components/ui/popover";
import { useWorkspaceDirectoryTree } from "./use-workspace-directory-tree";
import { WorkspaceFileTree } from "./workspace-file-tree";

export interface WorkspaceBrowseListing {
  /** The listed folder, relative to the workspace root; `""` is the root. */
  readonly directoryPath: string;
  /** The segment's entry within the listed folder, selected when the listing opens. */
  readonly selectedChild: string | null;
  /** Whether that entry starts expanded, which a folder segment does. */
  readonly expandSelected: boolean;
}

/**
 * What a breadcrumb segment lists: its parent folder with the segment selected, so siblings are
 * one click away. The workspace root lists its own contents.
 */
export function workspaceBrowseListing(path: string, isDirectory: boolean): WorkspaceBrowseListing {
  const parts = path.split("/").filter(Boolean);
  const child = parts.pop();
  if (child === undefined) return { directoryPath: "", selectedChild: null, expandSelected: false };
  return { directoryPath: parts.join("/"), selectedChild: child, expandSelected: isDirectory };
}

const joinPath = (directory: string, path: string) => (directory ? `${directory}/${path}` : path);

function WorkspaceFileBrowseTree({
  workspaceRoot,
  listing,
  onOpenFile,
}: {
  workspaceRoot: string;
  listing: WorkspaceBrowseListing;
  onOpenFile: (relativePath: string, mode: "preview" | "durable") => void;
}) {
  const { directoryPath, selectedChild, expandSelected } = listing;
  // Expansion is relative to the listed folder; the directory reads are relative to the root.
  const [expandedPaths, setExpandedPaths] = useState<ReadonlySet<string>>(
    () => new Set(["", ...(expandSelected && selectedChild ? [selectedChild] : [])]),
  );
  const tree = useWorkspaceDirectoryTree({
    workspaceRoot,
    expandedPaths: new Set([...expandedPaths].map((path) => joinPath(directoryPath, path))),
  });
  const prefix = directoryPath ? `${directoryPath}/` : "";
  const paths = tree.paths.flatMap((entry) =>
    entry.path.startsWith(prefix) ? [{ ...entry, path: entry.path.slice(prefix.length) }] : [],
  );
  if (paths.length === 0) {
    return tree.error ? (
      <div className="px-2 py-2 text-sm text-tertiary" role="alert">
        Couldn't load folder contents
      </div>
    ) : (
      <div className="px-2 py-2 text-sm text-tertiary" role="status">
        {tree.isPending(directoryPath) ? "Loading…" : "This folder is empty"}
      </div>
    );
  }
  return (
    <WorkspaceFileTree
      workspaceRoot={joinPath(workspaceRoot, directoryPath)}
      paths={paths}
      expandedPaths={expandedPaths}
      selectedPath={selectedChild ? (expandSelected ? `${selectedChild}/` : selectedChild) : null}
      searchQuery=""
      surface="dropdown"
      revealSelectedPath
      revealSelectedPathScrollOffset="center"
      onOpen={(path, mode) => onOpenFile(joinPath(directoryPath, path), mode)}
      onStateChange={(state) => setExpandedPaths(new Set(state.expandedPaths))}
    />
  );
}

/**
 * A breadcrumb segment that opens its folder's listing, so a sibling or nearby file opens without
 * leaving the viewer.
 */
export function WorkspaceFileBrowsePopover({
  workspaceRoot,
  focusPath,
  focusIsDirectory,
  label,
  labelClassName,
  onOpenFile,
}: {
  workspaceRoot: string;
  /** The segment's path relative to the workspace root; `""` is the root. */
  focusPath: string;
  focusIsDirectory: boolean;
  label: ReactNode;
  labelClassName: string;
  onOpenFile: (relativePath: string, mode: "preview" | "durable") => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <NodexPopover open={open} onOpenChange={setOpen}>
      <NodexPopoverTrigger>
        <button
          type="button"
          className={`${labelClassName} cursor-interaction outline-none hover:text-(--color-text) focus-visible:ring-2 focus-visible:ring-token-focus-border`}
        >
          {label}
        </button>
      </NodexPopoverTrigger>
      <NodexPopoverContent
        side="bottom"
        align="start"
        className="h-80 w-96 bg-surface-elevated-secondary [--color-surface:var(--color-surface-elevated-secondary)]"
        data-tab-preview-pin-exempt="true"
      >
        {open ? (
          <div className="h-full min-h-0 w-full">
            <WorkspaceFileBrowseTree
              workspaceRoot={workspaceRoot}
              listing={workspaceBrowseListing(focusPath, focusIsDirectory)}
              onOpenFile={(relativePath, mode) => {
                setOpen(false);
                onOpenFile(relativePath, mode);
              }}
            />
          </div>
        ) : null}
      </NodexPopoverContent>
    </NodexPopover>
  );
}
