import { FileBlankIcon } from "@/components/shared/icons/file-viewer-icons";
import { EmptyState } from "@/components/ui/empty-state";
import { ReadOnlyFileDiff } from "@/components/ui/read-only-file-diff";
import { useMemo } from "react";
import {
  NODEX_DIFF_HOST_CLASS,
  getNodexDiffHostStyle,
  getNodexReviewDiffOptions,
} from "@/lib/diff-presentation";
import { useTheme } from "@/lib/use-theme";
import { compareWorkspaceFileContents } from "./workspace-file-editor-diff";

interface WorkspaceFileConflictProps {
  readonly filename: string;
  readonly diskValue: string;
  readonly localValue: string;
  readonly onUseDisk: () => void;
  readonly onKeepLocal: () => void;
}

export function WorkspaceFileConflict({
  filename,
  diskValue,
  localValue,
  onUseDisk,
  onKeepLocal,
}: WorkspaceFileConflictProps) {
  const { resolved } = useTheme();
  // Bounded like every comparison: a version too large or slow to diff stays a choice.
  const comparison = useMemo(
    () =>
      compareWorkspaceFileContents({
        path: filename,
        oldContent: diskValue,
        newContent: localValue,
      }),
    [diskValue, filename, localValue],
  );
  const options = useMemo(
    () =>
      getNodexReviewDiffOptions(resolved, true, {
        diffStyle: "split",
        wrap: true,
        collapsed: false,
      }),
    [resolved],
  );
  const style = useMemo(() => getNodexDiffHostStyle(resolved), [resolved]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-token-main-surface-primary">
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b-[0.5px] border-token-border px-3">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-token-text-primary">File changed on disk</div>
          <div className="truncate text-xs text-token-text-secondary">
            {comparison.status === "ready"
              ? "Compare the disk version (left) with your local changes (right)."
              : "Choose the version to keep."}
          </div>
        </div>
        <button
          type="button"
          className="h-7 rounded-md px-2 text-xs text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-text-primary"
          onClick={onUseDisk}
        >
          Use disk version
        </button>
        <button
          type="button"
          className="h-7 rounded-md bg-token-foreground px-2 text-xs text-token-side-bar-background hover:opacity-90"
          onClick={onKeepLocal}
        >
          Keep my changes
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {comparison.status === "ready" ? (
          <ReadOnlyFileDiff
            fileDiff={comparison.diff}
            options={options}
            className={`${NODEX_DIFF_HOST_CLASS} min-h-full`}
            style={style}
          />
        ) : (
          <EmptyState
            className="h-full min-h-0 px-4"
            icon={<FileBlankIcon aria-hidden="true" />}
            title="This comparison is too large to show"
          />
        )}
      </div>
    </div>
  );
}
