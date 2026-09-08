import { useMemo } from "react";
import { FileTreeContextMenu } from "@/components/workbench/file-tree-context-menu";
import { NodexDropdownMenu, NodexDropdownItem } from "@/components/ui/dropdown";
import { CheckmarkIcon, FilterIcon } from "@/components/shared/icons";
import { FileTree, getFileTreeEventPath } from "@/components/ui/file-tree";
import { FileTreeFilter } from "@/components/ui/file-tree-filter";
import {
  fileTreeCommentIcon,
  fileTreeCommentSprite,
} from "@/components/shared/icons/file-tree-comment-decoration";
import { buildFileTreePaths, buildFileTreeExpandedPaths } from "@/lib/file-tree-paths";
import { reviewFileTreeGitStatus } from "@/lib/review-file-tree-model";
import type { GitReviewFileStatus } from "@/lib/types";
import { RIGHT_PANEL_COMPOSER_OVERLAY_ZERO_RESERVE_VALUE } from "@/lib/right-panel-composer-overlay-reserve";

interface ReviewTreeEntry {
  readonly key: string;
  readonly displayPath: string;
  readonly openPath: string | null;
  readonly gitStatus: GitReviewFileStatus | null;
}

export function ReviewFileTree({
  entries,
  selectedPath,
  expandedPaths,
  filter,
  commentCountByPath,
  onFilterChange,
  onSelectPath,
  onExpandedPathsChange,
  threadId,
  filterGeneratedFiles,
  onFilterGeneratedFilesChange,
}: {
  readonly entries: readonly ReviewTreeEntry[];
  readonly threadId?: string | null;
  readonly filterGeneratedFiles?: boolean;
  readonly onFilterGeneratedFilesChange?: (value: boolean) => void;
  readonly selectedPath: string | null;
  readonly expandedPaths: readonly string[];
  readonly filter: string;
  readonly commentCountByPath: ReadonlyMap<string, number>;
  readonly onFilterChange: (value: string) => void;
  readonly onSelectPath: (path: string) => void;
  readonly onExpandedPathsChange: (paths: readonly string[]) => void;
}) {
  const mapped = useMemo(
    () =>
      buildFileTreePaths(
        entries.map((entry) => ({
          ...entry,
          path: entry.openPath ?? entry.displayPath,
        })),
      ),
    [entries],
  );
  const paths = useMemo(() => mapped.map(({ treePath }) => treePath), [mapped]);
  const byTreePath = useMemo(
    () => new Map(mapped.map(({ entry, treePath }) => [treePath, entry])),
    [mapped],
  );
  const gitStatus = useMemo(
    () =>
      mapped.flatMap(({ entry, treePath }) =>
        entry.gitStatus
          ? [{ path: treePath, status: reviewFileTreeGitStatus(entry.gitStatus) }]
          : [],
      ),
    [mapped],
  );
  const visibleSelectedPath =
    mapped.find(({ entry }) => entry.displayPath === selectedPath)?.treePath ?? null;
  const filteredExpansion = useMemo(() => buildFileTreeExpandedPaths(paths), [paths]);
  const icons = useMemo(
    () => ({
      set: "complete" as const,
      colored: true,
      spriteSheet: fileTreeCommentSprite(commentCountByPath.values()),
    }),
    [commentCountByPath],
  );

  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2 pt-2 pb-px">
        <div className="min-w-0 flex-1">
          <FileTreeFilter value={filter} onChange={onFilterChange} />
        </div>
        {onFilterGeneratedFilesChange ? (
          <NodexDropdownMenu
            align="end"
            contentWidth="menu"
            triggerButton={
              <button
                type="button"
                aria-label="Filter options"
                aria-pressed={filterGeneratedFiles}
                className="flex size-7 shrink-0 items-center justify-center rounded-md text-tertiary hover:bg-primary-ghost-hover aria-pressed:text-default"
              >
                <FilterIcon className="icon-sm" />
              </button>
            }
          >
            <NodexDropdownItem
              role="menuitemcheckbox"
              aria-checked={filterGeneratedFiles}
              onSelect={() => onFilterGeneratedFilesChange(!filterGeneratedFiles)}
              rightSlot={filterGeneratedFiles ? <CheckmarkIcon className="size-4" /> : null}
            >
              Filter generated files
            </NodexDropdownItem>
          </NodexDropdownMenu>
        ) : null}
      </div>
      <div
        className="min-h-0 flex-1 px-2"
        style={{ paddingBottom: RIGHT_PANEL_COMPOSER_OVERLAY_ZERO_RESERVE_VALUE }}
      >
        {paths.length > 0 ? (
          <FileTreeContextMenu
            threadId={threadId}
            resolvePath={(path) => byTreePath.get(path)?.openPath ?? null}
          >
            <FileTree
              ariaLabel="Review files"
              appearance="review"
              paths={paths}
              gitStatus={gitStatus}
              icons={icons}
              flattenEmptyDirectories
              expandedPaths={filter.trim() ? filteredExpansion : expandedPaths}
              selectedPath={visibleSelectedPath}
              revealSelectedPath
              renderRowDecoration={({ item }) => {
                if (item.kind !== "file") return null;
                const entry = byTreePath.get(item.path);
                const count = entry ? (commentCountByPath.get(entry.displayPath) ?? 0) : 0;
                return count > 0
                  ? {
                      icon: fileTreeCommentIcon(count),
                      title: `${count} ${count === 1 ? "comment" : "comments"}`,
                    }
                  : null;
              }}
              onSelectionChange={(selection) => {
                const entry = selection
                  .map((path) => byTreePath.get(path))
                  .find((item) => item != null);
                if (entry && entry.displayPath !== selectedPath) onSelectPath(entry.displayPath);
              }}
              onClick={(event) => {
                const path = getFileTreeEventPath(event.nativeEvent, true);
                const entry = path ? byTreePath.get(path) : undefined;
                if (entry?.displayPath === selectedPath) onSelectPath(entry.displayPath);
              }}
              onStateChange={(state) => {
                if (!filter.trim()) onExpandedPathsChange(state.expandedPaths);
              }}
            />
          </FileTreeContextMenu>
        ) : (
          <div className="px-2 py-2 text-sm text-tertiary">No matching files</div>
        )}
      </div>
    </div>
  );
}
