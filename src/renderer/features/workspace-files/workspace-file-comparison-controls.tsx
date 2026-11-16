import { defineMessage, useIntl, type MessageDescriptor } from "@/lib/i18n";
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

const SOURCE_LABELS: Record<WorkspaceFileGitSource["kind"], MessageDescriptor> = {
  uncommitted: defineMessage({
    id: "workspaceFiles.workspaceFileComparisonControls.uncommitted",
    defaultMessage: "Uncommitted",
  }),
  unstaged: defineMessage({
    id: "workspaceFiles.workspaceFileComparisonControls.unstaged",
    defaultMessage: "Unstaged",
  }),
  staged: defineMessage({
    id: "workspaceFiles.workspaceFileComparisonControls.staged",
    defaultMessage: "Staged",
  }),
  commit: defineMessage({
    id: "workspaceFiles.workspaceFileComparisonControls.committed",
    defaultMessage: "Committed",
  }),
  branch: defineMessage({
    id: "workspaceFiles.workspaceFileComparisonControls.branch",
    defaultMessage: "Branch",
  }),
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
  const intl = useIntl();
  return (
    <NodexTooltip
      tooltipContent={intl.formatMessage({
        id: "workspaceFiles.workspaceFileComparisonControls.show",
        defaultMessage: "Show changes",
      })}
    >
      <ViewerButton
        aria-label={intl.formatMessage({
          id: "workspaceFiles.workspaceFileComparisonControls.show",
          defaultMessage: "Show changes",
        })}
        aria-busy={control.loading}
        onClick={control.onShow}
      >
        <FileComparisonIcon />
        <span data-file-comparison-label="">
          {intl.formatMessage({
            id: "workspaceFiles.workspaceFileComparisonControls.show",
            defaultMessage: "Show changes",
          })}
        </span>
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
  const intl = useIntl();
  return (
    <NodexDropdownItem
      onSelect={() => onSelect(source)}
      rightSlot={selected ? <CheckmarkIcon className="size-4" /> : null}
    >
      {intl.formatMessage(SOURCE_LABELS[source.kind])}
    </NodexDropdownItem>
  );
}

/** The comparison source picker and the control that hides the changes again. */
export function WorkspaceFileComparisonGroup({
  control,
}: {
  control: WorkspaceFileComparisonControl;
}) {
  const intl = useIntl();
  const { source, commits, onSelectSource } = control;
  const detail = sourceDetail(source);
  const label = source
    ? intl.formatMessage(SOURCE_LABELS[source.kind])
    : intl.formatMessage({
        id: "workspaceFiles.workspaceFileComparisonControls.changes",
        defaultMessage: "Changes",
      });
  return (
    <div
      className="flex min-w-0 items-center gap-1"
      role="group"
      aria-label={intl.formatMessage({
        id: "workspaceFiles.workspaceFileComparisonControls.comparison",
        defaultMessage: "File comparison",
      })}
    >
      <ViewerControlGroup
        label={intl.formatMessage({
          id: "workspaceFiles.workspaceFileComparisonControls.source",
          defaultMessage: "Review source",
        })}
        shrink
      >
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
            label={intl.formatMessage(SOURCE_LABELS.commit)}
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
      <ViewerControlGroup
        label={intl.formatMessage({
          id: "workspaceFiles.workspaceFileComparisonControls.hide",
          defaultMessage: "Hide changes",
        })}
      >
        <ViewerIconButton
          label={intl.formatMessage({
            id: "workspaceFiles.workspaceFileComparisonControls.hide",
            defaultMessage: "Hide changes",
          })}
          onClick={control.onHide}
        >
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
  const intl = useIntl();
  const { count, activeIndex, previousIndex, nextIndex } = navigation;
  const inChange = activeIndex >= 0;
  const visible = inChange ? `${activeIndex + 1}/${count}` : String(count);
  const spoken = inChange
    ? intl.formatMessage(
        {
          id: "workspaceFiles.workspaceFileComparisonControls.changePosition",
          defaultMessage: "{index} of {count}",
        },
        { index: activeIndex + 1, count },
      )
    : `${count} ${count === 1 ? "change" : "changes"}`;
  // Keep the caret in the editor so the next step starts from it.
  const keepEditorFocus = (event: { preventDefault: () => void }) => event.preventDefault();
  return (
    <ViewerControlGroup
      label={intl.formatMessage({
        id: "workspaceFiles.workspaceFileComparisonControls.navigate",
        defaultMessage: "Navigate changes",
      })}
    >
      <ViewerControlButton
        label={intl.formatMessage({
          id: "workspaceFiles.workspaceFileComparisonControls.previous",
          defaultMessage: "Previous change",
        })}
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
        label={intl.formatMessage({
          id: "workspaceFiles.workspaceFileComparisonControls.next",
          defaultMessage: "Next change",
        })}
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
  const intl = useIntl();
  return (
    <ViewerControlButton
      label={
        layout === "split"
          ? intl.formatMessage({
              id: "workspaceFiles.workspaceFileComparisonControls.switchUnified",
              defaultMessage: "Switch to unified diff",
            })
          : intl.formatMessage({
              id: "workspaceFiles.workspaceFileComparisonControls.switchSplit",
              defaultMessage: "Switch to split diff",
            })
      }
      tone="toolbar"
      onClick={onToggle}
    >
      {layout === "split" ? <DiffSplitIcon /> : <DiffUnifiedIcon />}
    </ViewerControlButton>
  );
}
