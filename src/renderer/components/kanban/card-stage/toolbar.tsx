import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface CardStageToolbarProps {
  saving: boolean;
  historyPanelActive: boolean;
  limitMainContentWidth: boolean;
  showRawContent: boolean;
  onClose: () => void;
  onDelete: () => void;
  onToggleContentWidth: () => void;
  onToggleShowRawContent: () => void;
  onOpenHistoryPanel?: () => void;
}

const cardStageToolbarButtonChrome =
  "inline-flex size-7 items-center justify-center rounded-md";

const cardStageToolbarButtonHover =
  "hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)]";

export function CardStageToolbar({
  saving,
  historyPanelActive,
  limitMainContentWidth,
  showRawContent,
  onClose,
  onDelete,
  onToggleContentWidth,
  onToggleShowRawContent,
  onOpenHistoryPanel,
}: CardStageToolbarProps) {
  return (
    <div className="flex h-11 items-center justify-between px-3">
      <div className="flex items-center gap-1">
        <Tooltip content="Close" side="bottom" disableAnimation delayDuration={0}>
          <button
            type="button"
            onClick={onClose}
            className={cn(
              cardStageToolbarButtonChrome,
              "text-(--foreground-secondary)",
              cardStageToolbarButtonHover,
            )}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M12 4L4 12M4 4l8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </Tooltip>

        <Tooltip content="Copy deeplink" side="bottom" disableAnimation delayDuration={0}>
          <button
            type="button"
            className={cn(
              cardStageToolbarButtonChrome,
              "text-(--foreground-tertiary)",
              cardStageToolbarButtonHover,
              "hover:text-(--foreground-secondary)",
            )}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M9 2h5v5M7 9l7-7M6 3H3a1 1 0 00-1 1v9a1 1 0 001 1h9a1 1 0 001-1v-3"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </Tooltip>
      </div>

      <div className="flex items-center gap-1">
        {saving && (
          <span className="mr-2 text-xs text-(--foreground-tertiary)">
            Saving...
          </span>
        )}

        <Tooltip content={showRawContent ? "Show editor" : "Show raw-format content"} side="bottom" disableAnimation delayDuration={0}>
          <button
            type="button"
            onClick={onToggleShowRawContent}
            aria-pressed={showRawContent}
            aria-label="Show raw"
            className={cn(
              cardStageToolbarButtonChrome,
              showRawContent
                ? "bg-(--background-tertiary) text-(--foreground)"
                : "text-(--foreground-secondary)",
              cardStageToolbarButtonHover,
              "hover:text-(--foreground)",
            )}
          >
            <RawContentIcon />
          </button>
        </Tooltip>

        <Tooltip content="Full width" side="bottom" disableAnimation delayDuration={0}>
          <button
            type="button"
            onClick={onToggleContentWidth}
            aria-pressed={!limitMainContentWidth}
            aria-label="Full width"
            className={cn(
              cardStageToolbarButtonChrome,
              !limitMainContentWidth
                ? "bg-(--background-tertiary) text-(--foreground)"
                : "text-(--foreground-tertiary)",
              cardStageToolbarButtonHover,
              "hover:text-(--foreground-secondary)",
            )}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M13 3v10M3 3v10M10.5 8H13M6 8l1.5-1.5M6 8l1.5 1.5M10 8l-1.5-1.5M10 8l-1.5 1.5M3 8h2.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </Tooltip>

        <Tooltip content="History" side="bottom" disableAnimation delayDuration={0}>
          <button
            type="button"
            onClick={onOpenHistoryPanel}
            className={cn(
              cardStageToolbarButtonChrome,
              historyPanelActive
                ? "bg-(--background-tertiary) text-(--foreground)"
                : "text-(--foreground-tertiary)",
              cardStageToolbarButtonHover,
              "hover:text-(--foreground-secondary)",
            )}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M8 4v4l3 1.5M14 8a6 6 0 11-12 0 6 6 0 0112 0z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </Tooltip>

        <Tooltip content="Delete" side="bottom" disableAnimation delayDuration={0}>
          <button
            type="button"
            onClick={onDelete}
            className={cn(
              cardStageToolbarButtonChrome,
              "text-(--foreground-tertiary)",
              cardStageToolbarButtonHover,
              "hover:text-(--destructive)",
            )}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 4h12M5.333 4V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4m2 0v9.333a1.333 1.333 0 01-1.334 1.334H4.667a1.333 1.333 0 01-1.334-1.334V4h9.334z"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

function RawContentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
      <path
        d="M4.75 3.5L2.25 7l2.5 3.5M9.25 3.5L11.75 7l-2.5 3.5M6.1 10.75l1.8-7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
