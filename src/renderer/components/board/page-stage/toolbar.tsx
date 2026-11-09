import { PageExecutionHoldItem } from "@/components/workbench/execution-hold-controls";
import type { ReactNode } from "react";
import {
  AutomationsIcon,
  BackIcon,
  ChatActionsIcon,
  DeleteIcon,
  PageMenuCopyLinkIcon,
} from "@/components/shared/icons";
import {
  PageFullWidthIcon,
  PageHistoryIcon,
  PageRawContentIcon,
} from "@/components/shared/icons/page-stage-toolbar-icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
  TOOLBAR_BUTTON_SECONDARY_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import { PageStageBreadcrumb, type PageStageBreadcrumbProps } from "./breadcrumb";

interface PageStageToolbarProps {
  pageId?: string;
  saving: boolean;
  /** The Page is still opening: actions are inert but keep their resting appearance. */
  pending?: boolean;
  historyPanelActive: boolean;
  limitMainContentWidth: boolean;
  showRawContent: boolean;
  onCopyDeeplink: () => void;
  /** Opens a new scheduled task that follows this Page as its runbook. */
  onSchedule?: () => void;
  onDelete: () => void;
  showDelete?: boolean;
  onToggleContentWidth: () => void;
  onToggleShowRawContent: () => void;
  onToggleHistoryPanel?: () => void;
  breadcrumb?: PageStageBreadcrumbProps;
  onNavigateBack?: () => void;
}

/**
 * Window toolbar chrome. A pending Page disables its actions without dimming them, so the
 * toolbar keeps its resting appearance while the Page opens.
 */
const pageStageToolbarButtonClass = cn(
  TOOLBAR_BUTTON_BASE_CLASS,
  "shrink-0 disabled:pointer-events-none disabled:opacity-100",
);

function PageStageToolbarToggle({
  label,
  tooltip = label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  tooltip?: string;
  pressed: boolean;
  disabled: boolean;
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <NodexTooltip tooltipContent={tooltip} side="bottom" delay={0}>
      <button
        type="button"
        onClick={onClick}
        aria-pressed={pressed}
        aria-label={label}
        disabled={disabled}
        className={cn(
          pageStageToolbarButtonClass,
          pressed ? TOOLBAR_BUTTON_SECONDARY_CLASS : TOOLBAR_BUTTON_GHOST_CLASS,
        )}
      >
        {children}
      </button>
    </NodexTooltip>
  );
}

export function PageStageToolbar({
  pageId,
  saving,
  pending = false,
  historyPanelActive,
  limitMainContentWidth,
  showRawContent,
  onCopyDeeplink,
  onSchedule,
  onDelete,
  showDelete = true,
  onToggleContentWidth,
  onToggleShowRawContent,
  onToggleHistoryPanel,
  breadcrumb,
  onNavigateBack,
}: PageStageToolbarProps) {
  return (
    <div className="flex h-11 items-center gap-2 px-3">
      {onNavigateBack ? (
        <NodexTooltip tooltipContent="Back to Library" side="bottom" delay={0}>
          <button
            type="button"
            aria-label="Back to Library"
            onClick={onNavigateBack}
            className={cn(pageStageToolbarButtonClass, TOOLBAR_BUTTON_GHOST_CLASS)}
          >
            <BackIcon className="icon-xs" />
          </button>
        </NodexTooltip>
      ) : null}
      {breadcrumb ? <PageStageBreadcrumb {...breadcrumb} /> : <div className="min-w-0 flex-1" />}

      <div className="flex shrink-0 items-center gap-1">
        {saving && <span className="mr-2 text-xs text-(--foreground-tertiary)">Saving...</span>}

        <PageStageToolbarToggle
          label="Show raw"
          tooltip={showRawContent ? "Show editor" : "Show raw-format content"}
          pressed={showRawContent}
          disabled={pending}
          onClick={onToggleShowRawContent}
        >
          <PageRawContentIcon active={showRawContent} />
        </PageStageToolbarToggle>

        <PageStageToolbarToggle
          label="Full width"
          pressed={!limitMainContentWidth}
          disabled={pending}
          onClick={onToggleContentWidth}
        >
          <PageFullWidthIcon active={!limitMainContentWidth} />
        </PageStageToolbarToggle>

        <PageStageToolbarToggle
          label="History"
          pressed={historyPanelActive}
          disabled={pending}
          onClick={onToggleHistoryPanel}
        >
          <PageHistoryIcon active={historyPanelActive} />
        </PageStageToolbarToggle>

        <NodexDropdownMenu
          align="end"
          side="bottom"
          sideOffset={6}
          contentWidth="xs"
          disabled={pending}
          triggerTooltipContent="Page actions"
          triggerButton={
            <button
              type="button"
              aria-label="Page actions"
              data-tab-preview-pin-exempt="true"
              disabled={pending}
              className={cn(pageStageToolbarButtonClass, TOOLBAR_BUTTON_GHOST_CLASS)}
            >
              <ChatActionsIcon />
            </button>
          }
        >
          {pageId ? <PageExecutionHoldItem pageId={pageId} /> : null}
          <NodexDropdownItem
            leftSlot={<PageMenuCopyLinkIcon className="icon-2xs" />}
            onSelect={onCopyDeeplink}
          >
            Copy deeplink
          </NodexDropdownItem>
          {onSchedule ? (
            <NodexDropdownItem
              leftSlot={<AutomationsIcon className="icon-2xs" />}
              onSelect={onSchedule}
            >
              Schedule…
            </NodexDropdownItem>
          ) : null}
          {showDelete ? (
            <>
              <NodexDropdownSeparator />
              <NodexDropdownItem
                leftSlot={<DeleteIcon className="icon-2xs shrink-0" />}
                onSelect={onDelete}
                className="text-(--destructive) hover:!bg-(--destructive)/10 focus:!bg-(--destructive)/10"
              >
                Delete
              </NodexDropdownItem>
            </>
          ) : null}
        </NodexDropdownMenu>
      </div>
    </div>
  );
}
