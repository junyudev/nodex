import {
  BackIcon,
  CodeIcon,
  DeleteIcon,
  FullWidthIcon,
  PageHistoryIcon,
  PageMenuCopyLinkIcon,
  ProjectActionsIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PageStageBreadcrumb, type PageStageBreadcrumbProps } from "./breadcrumb";

interface PageStageToolbarProps {
  saving: boolean;
  disabled?: boolean;
  historyPanelActive: boolean;
  limitMainContentWidth: boolean;
  showRawContent: boolean;
  onCopyDeeplink: () => void;
  onDelete: () => void;
  showDelete?: boolean;
  onToggleContentWidth: () => void;
  onToggleShowRawContent: () => void;
  onToggleHistoryPanel?: () => void;
  breadcrumb?: Omit<PageStageBreadcrumbProps, "disabled">;
  onNavigateBack?: () => void;
}

const pageStageToolbarButtonChrome = "inline-flex size-7 items-center justify-center rounded-md";

const pageStageToolbarButtonHover =
  "hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]";

export function PageStageToolbar({
  saving,
  disabled = false,
  historyPanelActive,
  limitMainContentWidth,
  showRawContent,
  onCopyDeeplink,
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
            className={cn(
              pageStageToolbarButtonChrome,
              "shrink-0 text-(--foreground-tertiary)",
              pageStageToolbarButtonHover,
              "hover:text-(--foreground-secondary)",
            )}
          >
            <BackIcon className="icon-sm" />
          </button>
        </NodexTooltip>
      ) : null}
      {breadcrumb ? (
        <PageStageBreadcrumb {...breadcrumb} disabled={disabled} />
      ) : (
        <div className="min-w-0 flex-1" />
      )}

      <div className="flex shrink-0 items-center gap-1">
        {saving && <span className="mr-2 text-xs text-(--foreground-tertiary)">Saving...</span>}

        <NodexTooltip
          tooltipContent={showRawContent ? "Show editor" : "Show raw-format content"}
          side="bottom"
          delay={0}
        >
          <button
            type="button"
            onClick={onToggleShowRawContent}
            aria-pressed={showRawContent}
            aria-label="Show raw"
            disabled={disabled}
            className={cn(
              pageStageToolbarButtonChrome,
              showRawContent
                ? "bg-(--background-tertiary) text-(--foreground-secondary)"
                : "text-(--foreground-tertiary)",
              pageStageToolbarButtonHover,
              "hover:text-(--foreground-secondary)",
              disabled &&
                "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-(--foreground-tertiary)",
            )}
          >
            <CodeIcon className="icon-xs" />
          </button>
        </NodexTooltip>

        <NodexTooltip tooltipContent="Full width" side="bottom" delay={0}>
          <button
            type="button"
            onClick={onToggleContentWidth}
            aria-pressed={!limitMainContentWidth}
            aria-label="Full width"
            disabled={disabled}
            className={cn(
              pageStageToolbarButtonChrome,
              !limitMainContentWidth
                ? "bg-(--background-tertiary) text-(--foreground)"
                : "text-(--foreground-tertiary)",
              pageStageToolbarButtonHover,
              "hover:text-(--foreground-secondary)",
              disabled &&
                "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-(--foreground-tertiary)",
            )}
          >
            <FullWidthIcon className="icon-xs" />
          </button>
        </NodexTooltip>

        <NodexTooltip tooltipContent="History" side="bottom" delay={0}>
          <button
            type="button"
            onClick={onToggleHistoryPanel}
            aria-pressed={historyPanelActive}
            aria-label="History"
            disabled={disabled}
            className={cn(
              pageStageToolbarButtonChrome,
              historyPanelActive
                ? "bg-(--background-tertiary) text-(--foreground)"
                : "text-(--foreground-tertiary)",
              pageStageToolbarButtonHover,
              "hover:text-(--foreground-secondary)",
              disabled &&
                "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-(--foreground-tertiary)",
            )}
          >
            <PageHistoryIcon className="icon-xs" />
          </button>
        </NodexTooltip>

        <NodexDropdownMenu
          align="end"
          side="bottom"
          sideOffset={6}
          contentWidth="xs"
          disabled={disabled}
          triggerTooltipContent="Page actions"
          triggerButton={
            <button
              type="button"
              aria-label="Page actions"
              data-tab-preview-pin-exempt="true"
              disabled={disabled}
              className={cn(
                pageStageToolbarButtonChrome,
                "text-(--foreground-tertiary)",
                pageStageToolbarButtonHover,
                "hover:text-(--foreground-secondary)",
                disabled &&
                  "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-(--foreground-tertiary)",
              )}
            >
              <ProjectActionsIcon className="icon-sm shrink-0" />
            </button>
          }
        >
          <NodexDropdownItem
            leftSlot={<PageMenuCopyLinkIcon className="icon-2xs" />}
            onSelect={onCopyDeeplink}
          >
            Copy deeplink
          </NodexDropdownItem>
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
