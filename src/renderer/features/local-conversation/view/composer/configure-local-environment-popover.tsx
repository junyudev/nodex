import { useLayoutEffect, useRef, useState } from "react";
import {
  BranchStatusIcon,
  ChevronRightIcon,
  ConfigStatusIcon,
  WorktreeStatusIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownContent,
  NodexDropdownItem,
  NodexDropdownPortal,
  NodexDropdownRoot,
  NodexDropdownTitle,
  NodexDropdownTrigger,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { CodexPendingWorktreeStartingState } from "../../../../../shared/codex-pending-worktree";
import type { NewChatStartInSelectorModel, ThreadStageActions } from "../../thread-stage-types";
import { BranchSelectorPopover } from "../shared/branch-selector-popover";
import type { BranchSelectorState } from "../shared/branch-selector-state";
import {
  EnvironmentSelectorPopover,
  resolveEnvironmentSelectorLabel,
} from "../shared/environment-selector-popover";
import { WorktreeStartingStatePopover } from "../shared/worktree-starting-state-popover";

type ConfigurationPage = "settings" | "branch" | "environment";

const configurationRowClassName =
  "h-7 min-h-7 justify-center border border-transparent px-2 py-0 text-sm/4.5 [&>div]:gap-1";

interface ConfigureLocalEnvironmentPopoverProps {
  model: NewChatStartInSelectorModel;
  actions: Pick<
    ThreadStageActions,
    | "onNewThreadStartInTargetChange"
    | "onNewThreadStartInEnvironmentChange"
    | "onRefreshNewThreadStartInEnvironments"
    | "onOpenNewThreadLocalEnvironmentsSettings"
  >;
  cwd: string | null;
  branchState: BranchSelectorState;
  branchBusy: boolean;
  branchLoading: boolean;
  branchError: boolean;
  startingState: CodexPendingWorktreeStartingState;
  worktreeAvailable: boolean;
  disabled?: boolean;
  onRefreshBranches: () => Promise<void>;
  onCheckoutBranch: (branch: string) => Promise<boolean>;
  onCreateBranch: (branch: string) => Promise<boolean>;
}

export function ConfigureLocalEnvironmentPopover({
  model,
  actions,
  cwd,
  branchState,
  branchBusy,
  branchLoading,
  branchError,
  startingState,
  worktreeAvailable,
  disabled = false,
  onRefreshBranches,
  onCheckoutBranch,
  onCreateBranch,
}: ConfigureLocalEnvironmentPopoverProps) {
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ConfigurationPage>("settings");
  const [pickerContainer, setPickerContainer] = useState<HTMLDivElement | null>(null);
  const branchRowRef = useRef<HTMLDivElement>(null);
  const environmentRowRef = useRef<HTMLDivElement>(null);
  const returnFocus = useRef<ConfigurationPage | null>(null);
  const isWorktree = model.target.runInTarget === "newWorktree";
  const unavailable = disabled || model.disabled;
  const currentBranch = branchState.currentBranch ?? branchState.defaultBranch ?? "No branch";
  const branchLabel = isWorktree
    ? startingState.type === "working-tree"
      ? `${currentBranch} (current)`
      : startingState.branchName
    : currentBranch;
  const environmentLabel = isWorktree
    ? resolveEnvironmentSelectorLabel({
        configs: model.environments,
        selectedPath: model.selectedEnvironmentPath,
        busy: model.environmentsLoading,
        error: model.environmentsError,
        needsAttention: model.environmentNeedsAttention,
      })
    : "No environment";
  const environmentDisabled = unavailable || !isWorktree || model.environmentAvailable === false;

  useLayoutEffect(() => {
    if (!open || page !== "settings" || !returnFocus.current) return;
    const target =
      returnFocus.current === "branch" ? branchRowRef.current : environmentRowRef.current;
    returnFocus.current = null;
    target?.focus();
  }, [open, page]);

  const closePicker = () => {
    returnFocus.current = page;
    setPage("settings");
  };
  const onPickerOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) closePicker();
  };
  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    setPage("settings");
    returnFocus.current = null;
  };
  const inlineBranch = {
    container: pickerContainer,
    open: open && page === "branch",
    onOpenChange: onPickerOpenChange,
  };

  return (
    <>
      <NodexDropdownRoot open={open} onOpenChange={onOpenChange}>
        <NodexTooltip tooltipContent="Configure local environment">
          <NodexDropdownTrigger disabled={unavailable}>
            <button
              type="button"
              aria-label="Configure local environment"
              data-composer-configuration-trigger="true"
              className="inline-flex h-7 shrink-0 items-center justify-center rounded-lg border border-transparent px-1.5 text-token-text-secondary hover:bg-token-foreground/5 hover:text-token-foreground focus-visible:ring-2 focus-visible:ring-token-focus-border data-popup-open:bg-token-foreground/10 disabled:opacity-50"
            >
              <ConfigStatusIcon className="size-4" />
            </button>
          </NodexDropdownTrigger>
        </NodexTooltip>
        <NodexDropdownPortal>
          <NodexDropdownContent
            side="top"
            align="end"
            sideOffset={4}
            // A 4px gutter, 26px title, and three centered 28px rows form the compact settings surface.
            className="m-0 w-[260px] rounded-2xl bg-token-dropdown-background p-1 [&_[data-slot=dropdown-trigger]:focus:not(:focus-visible):not(:hover)]:bg-transparent"
          >
            <div
              data-composer-configuration-page={page}
              className="flex min-w-0 flex-col"
              onKeyDownCapture={(event) => {
                if (
                  event.key !== "Escape" ||
                  page === "settings" ||
                  event.nativeEvent.isComposing ||
                  event.nativeEvent.keyCode === 229
                )
                  return;
                event.preventDefault();
                event.stopPropagation();
                closePicker();
              }}
            >
              <div hidden={page !== "settings"}>
                <NodexDropdownTitle>Configure local environment</NodexDropdownTitle>
                <NodexDropdownItem
                  role="switch"
                  aria-label="New worktree"
                  aria-checked={isWorktree}
                  closeOnClick={false}
                  disabled={
                    page !== "settings" ||
                    unavailable ||
                    (!isWorktree && (!worktreeAvailable || !model.worktreeAvailable)) ||
                    !actions.onNewThreadStartInTargetChange
                  }
                  tooltipText={
                    !worktreeAvailable
                      ? "Initialize a git repo to run tasks in worktrees"
                      : (model.additionalSourceFolderCount ?? 0) > 0
                        ? `Create a worktree for ${model.repositoryName || "the primary repository"}. Other source folders are used directly.`
                        : undefined
                  }
                  className={configurationRowClassName}
                  leftSlot={<WorktreeStatusIcon className="size-4" />}
                  rightSlot={
                    <span
                      aria-hidden="true"
                      className={cn(
                        "flex h-4 w-7 rounded-full p-0.5",
                        isWorktree ? "bg-token-foreground" : "bg-token-foreground/10",
                      )}
                    >
                      <span
                        className={cn(
                          "size-3 rounded-full transition-transform",
                          isWorktree
                            ? "translate-x-3 bg-token-main-surface-primary"
                            : "bg-control-thumb-on-accent",
                        )}
                      />
                    </span>
                  }
                  onSelect={() =>
                    actions.onNewThreadStartInTargetChange?.({
                      ...model.target,
                      runInTarget: isWorktree ? "localProject" : "newWorktree",
                    })
                  }
                >
                  New worktree
                </NodexDropdownItem>
                {isWorktree ? (
                  <NodexDropdownItem
                    ref={branchRowRef}
                    aria-label={`Branch: ${branchLabel}`}
                    closeOnClick={false}
                    disabled={page !== "settings" || unavailable || !cwd || branchBusy}
                    className={configurationRowClassName}
                    leftSlot={<BranchStatusIcon className="size-4" />}
                    rightSlot={<ConfigurationValue>{branchLabel}</ConfigurationValue>}
                    onSelect={() => {
                      setPage("branch");
                    }}
                  >
                    Branch
                  </NodexDropdownItem>
                ) : (
                  <BranchSelectorPopover
                    cwd={cwd}
                    state={branchState}
                    busy={branchBusy}
                    loading={branchLoading}
                    error={branchError}
                    disabled={page !== "settings" || unavailable}
                    onRefresh={onRefreshBranches}
                    onCheckout={onCheckoutBranch}
                    onCreate={onCreateBranch}
                    side="top"
                    align="start"
                    renderTrigger={({ disabled: branchDisabled }) => (
                      <NodexDropdownItem
                        role="menuitem"
                        aria-label={`Branch: ${branchLabel}`}
                        disabled={branchDisabled}
                        closeOnClick={false}
                        className={configurationRowClassName}
                        leftSlot={<BranchStatusIcon className="size-4 shrink-0" />}
                        rightSlot={<ConfigurationValue>{branchLabel}</ConfigurationValue>}
                      >
                        Branch
                      </NodexDropdownItem>
                    )}
                  />
                )}
                <NodexDropdownItem
                  ref={environmentRowRef}
                  aria-label={`Environment: ${environmentLabel}`}
                  closeOnClick={false}
                  disabled={page !== "settings" || environmentDisabled}
                  focusableWhenDisabled={page === "settings"}
                  tooltipText={!isWorktree ? "Enable worktree to choose an environment" : undefined}
                  className={configurationRowClassName}
                  leftSlot={<ConfigStatusIcon className="size-4" />}
                  rightSlot={<ConfigurationValue>{environmentLabel}</ConfigurationValue>}
                  onSelect={() => {
                    setPage("environment");
                    void actions.onRefreshNewThreadStartInEnvironments?.();
                  }}
                >
                  Environment
                </NodexDropdownItem>
              </div>
              <div
                hidden={page === "settings"}
                role="group"
                aria-label={page === "branch" ? "Branch" : "Environment"}
              >
                <NodexDropdownItem
                  aria-label="Back to chat settings"
                  disabled={page === "settings"}
                  closeOnClick={false}
                  className={cn(configurationRowClassName, "mb-1")}
                  leftSlot={<ChevronRightIcon className="size-4 rotate-180" />}
                  onSelect={closePicker}
                >
                  {page === "branch" ? "Branch" : "Environment"}
                </NodexDropdownItem>
                <div ref={setPickerContainer} className="min-w-0" />
              </div>
              <WorktreeStartingStatePopover
                inline={{ ...inlineBranch, open: inlineBranch.open && isWorktree }}
                cwd={cwd}
                state={branchState}
                startingState={startingState}
                branchLoading={branchLoading}
                branchError={branchError}
                repositoryName={model.repositoryName}
                onRefresh={onRefreshBranches}
                onChange={(worktreeStartingState) =>
                  actions.onNewThreadStartInTargetChange?.({
                    ...model.target,
                    worktreeStartingState,
                  })
                }
              />
              <EnvironmentSelectorPopover
                inline={{
                  container: pickerContainer,
                  open: open && page === "environment",
                  onOpenChange: onPickerOpenChange,
                }}
                configs={model.environments}
                selectedPath={model.selectedEnvironmentPath}
                defaultPath={model.defaultEnvironmentPath}
                repairConfigPath={model.environmentRepairConfigPath}
                needsAttention={model.environmentNeedsAttention}
                busy={model.environmentsLoading}
                error={model.environmentsError}
                repositoryName={model.repositoryName}
                showRepositoryName={(model.additionalSourceFolderCount ?? 0) > 0}
                onRefresh={() =>
                  actions.onRefreshNewThreadStartInEnvironments?.() ?? Promise.resolve()
                }
                onSelect={(environmentPath) => {
                  actions.onNewThreadStartInEnvironmentChange?.(environmentPath);
                  return true;
                }}
                onOpenSettings={(configPath) => {
                  onOpenChange(false);
                  return actions.onOpenNewThreadLocalEnvironmentsSettings?.(configPath);
                }}
              />
            </div>
          </NodexDropdownContent>
        </NodexDropdownPortal>
      </NodexDropdownRoot>
    </>
  );
}

function ConfigurationValue({ children }: { children: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1 text-token-text-secondary">
      <span className="max-w-40 truncate">{children}</span>
      <ChevronRightIcon className="size-4 shrink-0 text-token-text-tertiary" />
    </span>
  );
}
