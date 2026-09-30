import { useEffect, useState } from "react";
import {
  ActivitySpinnerIcon,
  CheckmarkIcon,
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
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { useThreadExecutionLocation } from "@/lib/use-thread-execution-location";
import { ThreadSummaryPanelRow } from "./thread-summary-panel-row";

export interface ThreadExecutionLocationModel {
  readonly threadId: string;
  readonly kind: "local" | "worktree";
  readonly canMove: boolean;
}

export function ThreadExecutionLocationSelector({
  model,
  disabled,
  worktreeAvailable,
  onErrorMessage,
}: {
  model: ThreadExecutionLocationModel;
  disabled: boolean;
  worktreeAvailable: boolean;
  onErrorMessage: (message: string | null) => void;
}) {
  const { operation, busy, blocked, move } = useThreadExecutionLocation(model.threadId);
  const [destination, setDestination] = useState<"local" | "worktree" | null>(null);
  const label = model.kind === "worktree" ? "Worktree" : "Local";
  const Icon = model.kind === "worktree" ? WorktreeStatusIcon : LocalStatusIcon;
  const title = destination === "local" ? "Move to local" : "Move to worktree";
  useEffect(() => {
    if (operation?.status === "error") onErrorMessage(operation.message ?? "Could not move chat");
    if (operation?.status === "success" || operation?.status === "warning") setDestination(null);
  }, [operation?.message, operation?.status, onErrorMessage]);

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
            title="Select where to run the task"
            disabled={disabled || busy || blocked}
            interactive
            data-thread-execution-location-trigger="true"
          />
        }
      >
        <NodexDropdownTitle>Continue in</NodexDropdownTitle>
        <NodexDropdownItem
          leftSlot={<LocalStatusIcon className="icon-sm" />}
          rightSlot={model.kind === "local" ? <NodexDropdownSelectedIcon /> : null}
          disabled={model.kind === "local"}
          onSelect={() => setDestination("local")}
          data-thread-execution-destination="local"
        >
          Local
        </NodexDropdownItem>
        <NodexDropdownItem
          leftSlot={<WorktreeStatusIcon className="icon-sm" />}
          rightSlot={model.kind === "worktree" ? <NodexDropdownSelectedIcon /> : null}
          disabled={model.kind === "worktree" || !worktreeAvailable}
          onSelect={() => setDestination("worktree")}
          data-thread-execution-destination="worktree"
        >
          Worktree
        </NodexDropdownItem>
      </NodexDropdownMenu>
      <NodexDialog
        open={destination !== null}
        onOpenChange={(open) => {
          if (!open) setDestination(null);
        }}
      >
        <NodexDialogContent size="compact" showCloseButton={false}>
          <NodexDialogFrame>
            <NodexDialogTitle>{title}</NodexDialogTitle>
            <NodexDialogDescription className="pt-3">
              Move this chat and its uncommitted changes to{" "}
              {destination === "local" ? "the Project folder" : "a managed worktree"}.
            </NodexDialogDescription>
            {busy ? (
              <div role="status" className="flex flex-col gap-2 pt-4 text-sm">
                {operation?.steps.map((step) => (
                  <div key={step.id} className="flex items-center gap-2">
                    {step.status === "running" ? (
                      <ActivitySpinnerIcon className="icon-xs" />
                    ) : step.status === "success" ? (
                      <CheckmarkIcon className="icon-xs" />
                    ) : null}
                    <span>{step.label}</span>
                  </div>
                ))}
              </div>
            ) : null}
            <NodexDialogFooter>
              <NodexDialogAction onClick={() => setDestination(null)}>
                {busy ? "Close" : "Cancel"}
              </NodexDialogAction>
              <NodexDialogAction
                tone="primary"
                disabled={busy || blocked}
                onClick={() => {
                  if (!destination) return;
                  onErrorMessage(null);
                  void move(destination).catch((cause) =>
                    onErrorMessage(cause instanceof Error ? cause.message : "Could not move chat"),
                  );
                }}
              >
                {busy ? "Moving…" : title}
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </>
  );
}
