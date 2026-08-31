import { CloudOff } from "@/components/shared/icons/generic-icons";
import { type ReactElement, type ReactNode } from "react";
import { LocalStatusIcon, WorktreeStatusIcon } from "@/components/shared/icons";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexDropdownTitle,
  type NodexDropdownContentWidth,
  type NodexDropdownMenuProps,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  getNewChatStartInTriggerIconKey,
  getNewChatStartInTriggerLabel,
  resolveNewChatStartInOptions,
  type NewChatStartInIconKey,
} from "@/lib/new-chat-start-in-selector";
import { cn } from "@/lib/utils";
import type { NewChatStartInSelectorModel, ThreadStageActions } from "../../thread-stage-types";

interface NewChatStartInSelectorProps {
  model: NewChatStartInSelectorModel;
  actions: Pick<ThreadStageActions, "onNewThreadStartInTargetChange">;
  disabled?: boolean;
  worktreeAvailable: boolean;
  renderTrigger?: (state: NewChatStartInTriggerRenderState) => ReactElement;
  side?: NodexDropdownMenuProps["side"];
  align?: NodexDropdownMenuProps["align"];
  sideOffset?: number;
  contentWidth?: NodexDropdownContentWidth;
  contentClassName?: string;
  menuTitle?: ReactNode;
  tooltipContent?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export interface NewChatStartInTriggerRenderState {
  triggerLabel: string;
  iconKey: NewChatStartInIconKey;
  title: string;
  disabled: boolean;
}

export function NewChatStartInSelector({
  model,
  actions,
  disabled = false,
  worktreeAvailable,
  renderTrigger,
  side = "top",
  align = "start",
  sideOffset = 8,
  contentWidth = "menuFixed",
  contentClassName = "flex w-52 max-w-78 flex-col",
  menuTitle = "Work in",
  tooltipContent = "Select start location",
  open,
  onOpenChange,
}: NewChatStartInSelectorProps) {
  const selectorDisabled = disabled || model.disabled || !actions.onNewThreadStartInTargetChange;
  const options = resolveNewChatStartInOptions({
    selectedRunInTarget: model.target.runInTarget,
    worktreeAvailable: model.worktreeAvailable && worktreeAvailable,
    cloudAvailable: false,
  }).filter((option) => option.value !== "cloud");
  const triggerIconKey = getNewChatStartInTriggerIconKey(model.target.runInTarget);
  const triggerLabel = getNewChatStartInTriggerLabel(model.target.runInTarget);
  const repositoryName = model.repositoryName?.trim() || null;
  const additionalSourceFolderCount = Math.max(0, model.additionalSourceFolderCount ?? 0);
  const triggerButton = renderTrigger ? (
    renderTrigger({
      triggerLabel,
      iconKey: triggerIconKey,
      title: "Select where to run the task",
      disabled: selectorDisabled,
    })
  ) : (
    <NodexDropdownButtonTrigger
      size="sm"
      shape="pill"
      muted
      chrome="transparent"
      disabled={selectorDisabled}
      aria-label="Start in"
      data-new-chat-start-in-trigger="true"
      className="max-w-full px-1.5 text-token-text-tertiary hover:text-token-foreground"
    >
      <StartInIcon iconKey={triggerIconKey} />
      <span className="max-w-40 truncate whitespace-nowrap text-left">{triggerLabel}</span>
    </NodexDropdownButtonTrigger>
  );

  const menu = (
    <NodexDropdownMenu
      disabled={selectorDisabled}
      side={side}
      align={align}
      sideOffset={sideOffset}
      contentWidth={contentWidth}
      contentClassName={contentClassName}
      open={open}
      onOpenChange={onOpenChange}
      triggerButton={triggerButton}
      triggerNativeButton={!renderTrigger}
    >
      <NodexDropdownTitle>{menuTitle}</NodexDropdownTitle>

      {options.map((option) => {
        const isWorktree = option.value === "newWorktree";
        const hasAdditionalSources = isWorktree && additionalSourceFolderCount > 0;
        const label =
          hasAdditionalSources && repositoryName
            ? `New worktree · ${repositoryName}`
            : option.label;
        const subText = hasAdditionalSources
          ? `Work locally in ${additionalSourceFolderCount} other ${additionalSourceFolderCount === 1 ? "folder" : "folders"}`
          : null;
        const worktreeTooltip =
          isWorktree && repositoryName
            ? [
                `Create a copy of ${repositoryName} to work in parallel.`,
                hasAdditionalSources
                  ? "Other project source folders will be accessed directly."
                  : null,
              ]
                .filter(Boolean)
                .join(" ")
            : null;
        return (
          <NodexDropdownItem
            key={option.value}
            leftSlot={
              <StartInIcon
                iconKey={option.iconKey}
                className={cn(
                  "size-3.5 text-token-description-foreground",
                  hasAdditionalSources && "icon-sm self-start",
                )}
              />
            }
            rightSlot={option.selected ? <NodexDropdownSelectedIcon /> : null}
            disabled={option.disabled}
            tooltipText={option.tooltipText ?? worktreeTooltip}
            tooltipSide="right"
            onSelect={() => {
              actions.onNewThreadStartInTargetChange?.({
                ...model.target,
                runInTarget: option.value,
              });
            }}
            data-new-chat-start-in-option={option.value}
            data-selected={option.selected ? "true" : undefined}
            className={cn(option.selected && "text-token-foreground")}
            allowWrap={hasAdditionalSources}
            subText={subText}
            subTextAllowWrap={hasAdditionalSources}
            alignSlotsToStart={hasAdditionalSources}
          >
            {label}
          </NodexDropdownItem>
        );
      })}
    </NodexDropdownMenu>
  );

  if (renderTrigger) return menu;

  return (
    <NodexTooltip tooltipContent={tooltipContent} side="bottom">
      <div className="inline-flex w-fit max-w-full">{menu}</div>
    </NodexTooltip>
  );
}

export function StartInIcon({
  iconKey,
  className,
}: {
  iconKey: NewChatStartInIconKey;
  className?: string;
}) {
  if (iconKey === "worktree") return <WorktreeStatusIcon className={className} />;
  if (iconKey === "cloud") return <CloudOff className={cn("icon-xs", className)} />;
  return <LocalStatusIcon className={className} />;
}
