import { OpenExternalIcon } from "@/components/shared/icons";
import type {
  ProjectAgentDockModel,
  ProjectAgentDockPendingWorktreeModel,
  ProjectAgentDockTargetRow,
} from "@/lib/project-agent-dock-model";
import {
  FloatingComposer,
  type FloatingComposerPlacement,
} from "@/features/floating-composer/floating-composer";
import {
  ComposerContextRail,
  ComposerContextRailSlot,
} from "@/features/local-conversation/view/composer-context-rail";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ProjectAgentDockTargetSelector } from "./project-agent-dock-target-selector";

export interface ProjectAgentDockLeadingRowProps {
  readonly model: ProjectAgentDockModel;
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly onSelect: (row: ProjectAgentDockTargetRow) => void;
  readonly onLoadMore: () => void;
  readonly onRetry: () => void;
  readonly onOpenChat: () => void;
  readonly pendingWorktree?: ProjectAgentDockPendingWorktreeModel | null;
  readonly onOpenPendingWorktreeDetails?: () => void;
}

export function ProjectAgentDockLeadingRow({
  model,
  query,
  onQueryChange,
  onSelect,
  onLoadMore,
  onRetry,
  onOpenChat,
  pendingWorktree = null,
  onOpenPendingWorktreeDetails,
}: ProjectAgentDockLeadingRowProps) {
  const canOpenChat = model.trigger.kind === "session";

  return (
    <div
      data-testid="project-agent-dock-target-row"
      className="order-1 flex min-w-0 shrink items-center gap-0.5"
    >
      <div className="min-w-0 shrink">
        <ProjectAgentDockTargetSelector
          model={model}
          query={query}
          onQueryChange={onQueryChange}
          onSelect={onSelect}
          onLoadMore={onLoadMore}
          onRetry={onRetry}
        />
      </div>
      {pendingWorktree && onOpenPendingWorktreeDetails ? (
        <button
          type="button"
          aria-label={`${pendingWorktree.statusLabel} View setup details`}
          data-project-agent-dock-pending-attention={pendingWorktree.attention}
          className="inline-flex h-7 shrink-0 cursor-interaction items-center gap-1 rounded-lg px-2 text-xs text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:bg-token-foreground/5 focus-visible:outline-none data-[project-agent-dock-pending-attention=request]:text-token-error-foreground"
          onClick={onOpenPendingWorktreeDetails}
        >
          {pendingWorktree.statusLabel}
          <OpenExternalIcon className="size-3" aria-hidden="true" />
        </button>
      ) : canOpenChat ? (
        <NodexTooltip tooltipContent="Open chat" side="bottom" delayOpen>
          <button
            type="button"
            aria-label="Open chat"
            className="inline-flex size-7 shrink-0 cursor-interaction items-center justify-center rounded-full text-token-description-foreground hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:bg-token-foreground/5 focus-visible:text-token-foreground focus-visible:outline-none"
            onClick={onOpenChat}
          >
            <OpenExternalIcon className="icon-2xs shrink-0" aria-hidden="true" />
          </button>
        </NodexTooltip>
      ) : null}
    </div>
  );
}

export function ProjectAgentDockUnavailableOverlay({
  target,
  placement,
  leadingContent,
  message,
}: {
  readonly target: HTMLElement | null;
  readonly placement?: FloatingComposerPlacement;
  readonly leadingContent: React.ReactNode;
  readonly message: string;
}) {
  return (
    <FloatingComposer target={target} {...placement} headerPinned>
      <ComposerContextRailSlot visible>
        <ComposerContextRail>
          {leadingContent}
          <span aria-hidden="true" className="order-2 min-w-0 flex-1" />
        </ComposerContextRail>
      </ComposerContextRailSlot>
      <div
        role="status"
        className="flex min-h-11 items-center px-3 text-sm text-token-description-foreground"
      >
        {message}
      </div>
    </FloatingComposer>
  );
}
