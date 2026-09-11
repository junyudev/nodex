import { AssistantRatingMenu } from "./assistant-rating-menu";
import { useState, type MouseEvent } from "react";
import { motion } from "motion/react";
import {
  DownloadIcon,
  PlanSidePanelCloseIcon,
  PlanSidePanelOpenIcon,
  ComposerPlanModeIcon,
} from "@/components/shared/icons";
import { BudgetedMarkdownRenderer } from "./markdown/budgeted-markdown-renderer";
import { CodexShimmerText } from "./codex-shimmer-text";
import { cn } from "../../../../lib/utils";
import {
  type AssistantMessageRating,
  CopyMessageActionButton,
  ThreadActionIconButton,
} from "./thread-message-actions";
import { CODEX_THREAD_ACCORDION_TRANSITION } from "./thread-motion";

const PLAN_PREVIEW_MAX_HEIGHT_PX = 160;
const PLAN_DOWNLOAD_FILENAME = "PLAN.md";

interface PlanMessageProps {
  content: string;
  completed?: boolean;
  parseIncompleteMarkdown?: boolean;
  cwd?: string | null;
  projectWorkspacePath?: string | null;
  isSidePanelActive?: boolean;
  onOpenInSidePanel?: () => void | Promise<void>;
  onCloseSidePanel?: () => void | Promise<void>;
}

export function PlanMessage({
  content,
  completed = true,
  parseIncompleteMarkdown = false,
  cwd,
  projectWorkspacePath,
  isSidePanelActive = false,
  onOpenInSidePanel,
  onCloseSidePanel,
}: PlanMessageProps) {
  const [selectedRating, setSelectedRating] = useState<AssistantMessageRating | null>(null);
  const canOpenSidePanel = completed && Boolean(onOpenInSidePanel);

  const handleDownload = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (
      typeof document === "undefined" ||
      typeof URL === "undefined" ||
      typeof Blob === "undefined"
    ) {
      return;
    }

    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = PLAN_DOWNLOAD_FILENAME;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  };

  const handleOpenSidePanel = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!canOpenSidePanel) return;
    void onOpenInSidePanel?.();
  };

  const handleCloseSidePanel = () => {
    void onCloseSidePanel?.();
  };

  return (
    <div
      className="extension:!bg-token-input-background/50 relative max-h-[200px] cursor-default overflow-clip rounded-lg border border-token-border bg-token-foreground/5 !bg-token-dropdown-background/50 select-none"
      data-plan-side-panel-active={isSidePanelActive ? "true" : "false"}
    >
      {isSidePanelActive ? (
        <button
          type="button"
          aria-label="Close plan side panel"
          className="absolute inset-0 z-10 flex cursor-interaction items-center justify-end px-3 text-token-text-tertiary focus-visible:ring-1 focus-visible:ring-token-focus-border focus-visible:ring-inset focus-visible:outline-none"
          onClick={handleCloseSidePanel}
        >
          <span className="electron:rounded-md flex size-6 items-center justify-center rounded-full hover:bg-token-list-hover-background">
            <PlanSidePanelCloseIcon className="icon-sm shrink-0" />
          </span>
        </button>
      ) : canOpenSidePanel ? (
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          className="absolute inset-0 z-10 cursor-interaction"
          onClick={handleOpenSidePanel}
        />
      ) : null}

      <div className="relative flex h-10 flex-wrap items-center justify-between gap-2 px-3 py-2">
        <span className="inline-flex items-center gap-2 text-base leading-tight font-normal text-token-text-tertiary">
          <ComposerPlanModeIcon className="icon-2xs shrink-0" />
          <CodexShimmerText active={!completed}>
            {completed ? "Plan" : "Writing plan"}
          </CodexShimmerText>
        </span>

        <div
          data-plan-action-group="true"
          aria-hidden={isSidePanelActive ? "true" : "false"}
          hidden={isSidePanelActive}
          className="relative z-20 flex items-center gap-1"
        >
          <ThreadActionIconButton label="Download plan" onClick={handleDownload}>
            <DownloadIcon />
          </ThreadActionIconButton>
          <CopyMessageActionButton
            text={content}
            label="Copy"
            copiedLabel="Copied"
            stopPropagation
          />
          {completed ? (
            <>
              <AssistantRatingMenu selectedRating={selectedRating} onSelect={setSelectedRating} />
              {canOpenSidePanel ? (
                <ThreadActionIconButton
                  label="Open plan in side panel"
                  onClick={handleOpenSidePanel}
                >
                  <PlanSidePanelOpenIcon className="icon-2xs shrink-0" />
                </ThreadActionIconButton>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      <motion.div
        data-plan-preview-body="true"
        className={cn(
          "relative overflow-hidden",
          !isSidePanelActive &&
            "[mask-image:linear-gradient(to_bottom,black_calc(100%_-_4rem),transparent)]",
        )}
        initial={false}
        animate={{
          maxHeight: isSidePanelActive ? 0 : PLAN_PREVIEW_MAX_HEIGHT_PX,
          opacity: isSidePanelActive ? 0 : 1,
        }}
        transition={CODEX_THREAD_ACCORDION_TRANSITION}
        aria-hidden={isSidePanelActive ? true : undefined}
        inert={isSidePanelActive ? true : undefined}
      >
        <div className="px-4 py-3">
          <BudgetedMarkdownRenderer
            content={content}
            parseIncompleteMarkdown={parseIncompleteMarkdown}
            animateStreamingText={!completed && parseIncompleteMarkdown}
            cwd={cwd}
            projectWorkspacePath={projectWorkspacePath}
            className="codex-markdown-plan text-size-chat"
            sourceAriaLabel="Plan source"
          />
        </div>
      </motion.div>
    </div>
  );
}
