import { useIntl } from "@/lib/i18n";
import { useState } from "react";
import {
  ActivitySpinnerIcon,
  ChevronDownIcon,
  LocalStatusIcon,
  WorktreeStatusIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSelectedIcon,
  NodexDropdownTitle,
} from "@/components/ui/dropdown";
import { useThreadExecutionLocation } from "@/lib/use-thread-execution-location";
import { ThreadMoveDialog, type ThreadMoveSource } from "../thread-move-dialog";
import { ThreadSummaryPanelRow } from "./thread-summary-panel-row";

export interface ThreadExecutionLocationModel {
  readonly threadId: string;
  readonly kind: "local" | "worktree";
  readonly canMove: boolean;
  /** Whether the chat's current location is still there to move changes from. */
  readonly source: ThreadMoveSource;
}

export function ThreadExecutionLocationSelector({
  model,
  disabled,
  worktreeAvailable,
}: {
  model: ThreadExecutionLocationModel;
  disabled: boolean;
  worktreeAvailable: boolean;
}) {
  const intl = useIntl();
  const location = useThreadExecutionLocation(model.threadId);
  const { busy, blocked } = location;
  const [destination, setDestination] = useState<"local" | "worktree" | null>(null);
  const label =
    model.kind === "worktree"
      ? intl.formatMessage({
          id: "conversation.threadExecutionLocationSelector.worktree",
          defaultMessage: "Worktree",
        })
      : intl.formatMessage({
          id: "conversation.threadExecutionLocationSelector.local",
          defaultMessage: "Local",
        });
  const Icon = model.kind === "worktree" ? WorktreeStatusIcon : LocalStatusIcon;

  if (!model.canMove)
    return (
      <ThreadSummaryPanelRow
        label={label}
        icon={<Icon className="icon-sm text-token-foreground" />}
      />
    );
  return (
    <>
      <NodexDropdownMenu
        disabled={disabled || busy || blocked}
        side="left"
        align="start"
        sideOffset={4}
        contentWidth="menuFixed"
        triggerNativeButton={false}
        triggerButton={
          <ThreadSummaryPanelRow
            label={
              <span className="flex min-w-0 items-center gap-1">
                {label}
                <ChevronDownIcon className="icon-xs shrink-0 text-token-text-tertiary" />
              </span>
            }
            labelClassName="flex min-w-0 items-center"
            icon={
              busy ? (
                <ActivitySpinnerIcon className="icon-sm" />
              ) : (
                <Icon className="icon-sm text-token-foreground" />
              )
            }
            title={intl.formatMessage({
              id: "conversation.threadExecutionLocationSelector.location",
              defaultMessage: "Select where to run the task",
            })}
            disabled={disabled || busy || blocked}
            interactive
            data-thread-execution-location-trigger="true"
          />
        }
      >
        <NodexDropdownTitle>
          {intl.formatMessage({
            id: "conversation.threadExecutionLocationSelector.continueIn",
            defaultMessage: "Continue in",
          })}
        </NodexDropdownTitle>
        <NodexDropdownItem
          leftSlot={<LocalStatusIcon className="icon-sm" />}
          rightSlot={model.kind === "local" ? <NodexDropdownSelectedIcon /> : null}
          disabled={model.kind === "local"}
          onSelect={() => setDestination("local")}
          data-thread-execution-destination="local"
        >
          {intl.formatMessage({
            id: "conversation.threadExecutionLocationSelector.local",
            defaultMessage: "Local",
          })}
        </NodexDropdownItem>
        <NodexDropdownItem
          leftSlot={<WorktreeStatusIcon className="icon-sm" />}
          rightSlot={model.kind === "worktree" ? <NodexDropdownSelectedIcon /> : null}
          disabled={model.kind === "worktree" || !worktreeAvailable}
          onSelect={() => setDestination("worktree")}
          data-thread-execution-destination="worktree"
        >
          {intl.formatMessage({
            id: "conversation.threadExecutionLocationSelector.worktree",
            defaultMessage: "Worktree",
          })}
        </NodexDropdownItem>
      </NodexDropdownMenu>
      <ThreadMoveDialog
        location={location}
        destination={destination}
        source={model.source}
        onClose={() => setDestination(null)}
      />
    </>
  );
}
