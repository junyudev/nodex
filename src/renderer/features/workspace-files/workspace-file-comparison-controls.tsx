import { CheckmarkIcon } from "@/components/shared/icons";
import {
  ChevronDownMd16Icon,
  ChevronDownXs12Icon,
  ChevronUpMd16Icon,
  CloseMd16Icon,
  DiffSplitIcon,
  DiffUnifiedIcon,
  FileComparisonIcon,
} from "@/components/shared/icons/file-viewer-icons";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  ViewerButton,
  ViewerControlButton,
  ViewerControlGroup,
  ViewerIconButton,
} from "@/components/ui/viewer-header";
import {
  ReviewCommitMenuItems,
  type ReviewCommitListStatus,
} from "@/features/review/view/review-commit-menu-items";
import type { GitReviewBranchCommit } from "@/lib/types";
import type { WorkspaceFileChangeNavigationState } from "./workspace-file-change-blocks";
import type { WorkspaceFileGitSource } from "./workspace-file-git-model";
import type { WorkspaceFileDiffLayout } from "./workspace-file-preferences";

export interface WorkspaceFileComparisonControl {
  /** Whether the file shows its changes; otherwise the header offers Show changes. */
  readonly active: boolean;
  readonly loading: boolean;
  /** The comparison on screen, once resolved. */
  readonly source: WorkspaceFileGitSource | null;
  readonly commits: {
    readonly status: ReviewCommitListStatus;
    readonly commits: readonly GitReviewBranchCommit[];
    readonly errorMessage: string | null;
    readonly load: () => void;
  };
  readonly navigation: WorkspaceFileChangeNavigationState | null;
  readonly layout: WorkspaceFileDiffLayout;
  readonly onShow: () => void;
  readonly onHide: () => void;
  readonly onSelectSource: (source: WorkspaceFileGitSource) => void;
  readonly onNavigate: (direction: "previous" | "next") => void;
  readonly onToggleLayout: () => void;
}

const SOURCE_LABELS: Record<WorkspaceFileGitSource["kind"], string> = {
  uncommitted: "Uncommitted",
  unstaged: "Unstaged",
  staged: "Staged",
  commit: "Committed",
  branch: "Branch",
};

/** What the source picker shows beside its label: the commit or the base branch compared. */
function sourceDetail(source: WorkspaceFileGitSource | null): {
  readonly text: string;
  readonly attribute: "data-file-comparison-detail" | "data-review-source-branch";
} | null {
  if (source?.kind === "commit")
    return {
      text: source.title?.trim() || source.commitSha.slice(0, 8),
      attribute: "data-file-comparison-detail",
    };
  if (source?.kind === "branch" && source.baseBranch)
    return { text: source.baseBranch, attribute: "data-review-source-branch" };
  return null;
}

export function WorkspaceFileShowChangesButton({
  control,
}: {
  control: WorkspaceFileComparisonControl;
}) {
  return (
    <NodexTooltip tooltipContent="Show changes">
      <ViewerButton aria-label="Show changes" aria-busy={control.loading} onClick={control.onShow}>
        <FileComparisonIcon />
        <span data-file-comparison-label="">Show changes</span>
      </ViewerButton>
    </NodexTooltip>
  );
}

function SourceItem({
  source,
  selected,
  onSelect,
}: {
  source: WorkspaceFileGitSource;
  selected: boolean;
  onSelect: (source: WorkspaceFileGitSource) => void;
}) {
  return (
    <NodexDropdownItem
      onSelect={() => onSelect(source)}
      rightSlot={selected ? <CheckmarkIcon className="size-4" /> : null}
    >
      {SOURCE_LABELS[source.kind]}
    </NodexDropdownItem>
  );
}

/** The comparison source picker and the control that hides the changes again. */
export function WorkspaceFileComparisonGroup({
  control,
}: {
  control: WorkspaceFileComparisonControl;
}) {
  const { source, commits, onSelectSource } = control;
  const detail = sourceDetail(source);
  const label = source ? SOURCE_LABELS[source.kind] : "Changes";
  return (
    <div className="flex min-w-0 items-center gap-1" role="group" aria-label="File comparison">
      <ViewerControlGroup label="Review source" shrink>
        <NodexDropdownMenu
          align="start"
          contentWidth="menuBounded"
          triggerButton={
            <ViewerButton variant="dropdown" className="min-w-0" aria-busy={control.loading}>
              <span className="flex max-w-full min-w-0 items-center gap-1.5 truncate">
                <span className="min-w-0 truncate">{label}</span>
                {detail ? (
                  <span
                    {...{ [detail.attribute]: "" }}
                    className="min-w-0 truncate semantic-text-secondary"
                  >
                    {detail.text}
                  </span>
                ) : null}
              </span>
              <ChevronDownXs12Icon className="shrink-0" />
            </ViewerButton>
          }
        >
          {(["uncommitted", "unstaged", "staged"] as const).map((kind) => (
            <SourceItem
              key={kind}
              source={{ kind }}
              selected={source?.kind === kind}
              onSelect={onSelectSource}
            />
          ))}
          <NodexDropdownSeparator />
          <NodexDropdownFlyoutSubmenuItem
            label="Committed"
            onOpenChange={(open) => {
              if (open) commits.load();
            }}
            contentClassName="min-w-[320px]"
          >
            <ReviewCommitMenuItems
              status={commits.status}
              commits={commits.commits}
              errorMessage={commits.errorMessage}
              selectedSha={source?.kind === "commit" ? source.commitSha : null}
              onRetry={commits.load}
              onSelect={(commit) =>
                onSelectSource({ kind: "commit", commitSha: commit.sha, title: commit.subject })
              }
            />
          </NodexDropdownFlyoutSubmenuItem>
          <SourceItem
            source={{ kind: "branch" }}
            selected={source?.kind === "branch"}
            onSelect={onSelectSource}
          />
        </NodexDropdownMenu>
      </ViewerControlGroup>
      <ViewerControlGroup label="Hide changes">
        <ViewerIconButton label="Hide changes" onClick={control.onHide}>
          <CloseMd16Icon />
        </ViewerIconButton>
      </ViewerControlGroup>
    </div>
  );
}

/** Steps between changes; the count reads `position/count` while the caret is in a change. */
export function WorkspaceFileChangeNavigator({
  navigation,
  onNavigate,
}: {
  navigation: WorkspaceFileChangeNavigationState;
  onNavigate: (direction: "previous" | "next") => void;
}) {
  const { count, activeIndex, previousIndex, nextIndex } = navigation;
  const inChange = activeIndex >= 0;
  const visible = inChange ? `${activeIndex + 1}/${count}` : String(count);
  const spoken = inChange
    ? `${activeIndex + 1} of ${count}`
    : `${count} ${count === 1 ? "change" : "changes"}`;
  // Keep the caret in the editor so the next step starts from it.
  const keepEditorFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  return (
    <ViewerControlGroup label="Navigate changes">
      <ViewerControlButton
        label="Previous change"
        disabled={previousIndex < 0}
        onMouseDown={keepEditorFocus}
        onClick={() => onNavigate("previous")}
      >
        <ChevronUpMd16Icon />
      </ViewerControlButton>
      <span
        className="flex min-w-0 items-center gap-2 text-xs semantic-text-secondary tabular-nums select-none"
        role="status"
        aria-atomic="true"
      >
        <span aria-hidden="true">{visible}</span>
        <span className="sr-only">{spoken}</span>
      </span>
      <ViewerControlButton
        label="Next change"
        disabled={nextIndex < 0}
        onMouseDown={keepEditorFocus}
        onClick={() => onNavigate("next")}
      >
        <ChevronDownMd16Icon />
      </ViewerControlButton>
    </ViewerControlGroup>
  );
}

export function WorkspaceFileDiffLayoutToggle({
  layout,
  onToggle,
}: {
  layout: WorkspaceFileDiffLayout;
  onToggle: () => void;
}) {
  return (
    <ViewerControlButton
      label={layout === "split" ? "Switch to unified diff" : "Switch to split diff"}
      tone="toolbar"
      onClick={onToggle}
    >
      {layout === "split" ? <DiffSplitIcon /> : <DiffUnifiedIcon />}
    </ViewerControlButton>
  );
}
