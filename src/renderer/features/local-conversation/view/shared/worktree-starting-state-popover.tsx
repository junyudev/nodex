import { createPortal } from "react-dom";
import {
  COMPOSER_PICKER_ITEM_CLASS_NAME,
  handleInlineComposerPickerKeyDown,
  handleComposerPickerSearchKeyDown,
  type InlineComposerPickerPresentation,
} from "./inline-composer-picker";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivitySpinnerIcon,
  BranchStatusIcon,
  CheckmarkIcon,
  RetryIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownButtonTrigger,
  NodexDropdownItem,
  NodexDropdownMessage,
  NodexDropdownMenu,
  NodexDropdownSearchInput,
  NodexDropdownSection,
  NodexDropdownSectionLabel,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { NodexButton } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useDebouncedValue } from "@/lib/use-debounced-value";
import { loadComposerWorkingTreeChanges } from "../../composer-git-context";
import type { CodexPendingWorktreeStartingState } from "../../../../../shared/codex-pending-worktree";
import type { BranchSelectorState } from "./branch-selector-state";

function remoteBranchName(remoteRef: string): string {
  return remoteRef.replace(/^refs\/remotes\//, "");
}

function filterValues(values: readonly string[], query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [...values];
  return values.filter((value) => value.toLocaleLowerCase().includes(normalized));
}

function isStartingStateSelected(
  selected: CodexPendingWorktreeStartingState,
  candidate: CodexPendingWorktreeStartingState,
): boolean {
  if (selected.type !== candidate.type) return false;
  if (selected.type === "working-tree") return true;
  if (candidate.type !== "branch") return false;
  return selected.branchName === candidate.branchName && selected.remoteRef === candidate.remoteRef;
}

export function WorktreeStartingStatePopover({
  inline,
  cwd,
  state,
  startingState,
  branchLoading,
  branchError,
  disabled = false,
  repositoryName,
  defaultOpen = false,
  loadLocalChanges,
  onRefresh,
  onChange,
}: {
  inline?: InlineComposerPickerPresentation;
  cwd: string | null;
  state: BranchSelectorState;
  startingState: CodexPendingWorktreeStartingState;
  branchLoading: boolean;
  branchError: boolean;
  disabled?: boolean;
  repositoryName?: string | null;
  defaultOpen?: boolean;
  loadLocalChanges?: (cwd: string) => Promise<boolean>;
  onRefresh: () => Promise<void>;
  onChange: (state: CodexPendingWorktreeStartingState) => void;
}) {
  const [localOpen, setLocalOpen] = useState(defaultOpen);
  const open = inline?.open ?? localOpen;
  const setOpen = inline?.onOpenChange ?? setLocalOpen;
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const settledQuery = query ? debouncedQuery : "";
  const searchPending = query !== settledQuery;
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const currentBranch = state.currentBranch ?? state.defaultBranch ?? state.branches[0] ?? "HEAD";
  const localBranches = useMemo(
    () =>
      filterValues(
        [
          ...new Set(
            [state.defaultBranch, currentBranch, ...state.branches].filter(
              (branch): branch is string => Boolean(branch),
            ),
          ),
        ],
        settledQuery,
      ),
    [currentBranch, settledQuery, state.branches, state.defaultBranch],
  );
  const remoteBranchRefs = useMemo(
    () =>
      state.remoteBranchRefs.filter((remoteRef) =>
        remoteBranchName(remoteRef)
          .toLocaleLowerCase()
          .includes(settledQuery.trim().toLocaleLowerCase()),
      ),
    [settledQuery, state.remoteBranchRefs],
  );
  const triggerLabel =
    startingState.type === "working-tree" ? `${currentBranch} (current)` : startingState.branchName;

  const refreshStatus = useCallback(async () => {
    if (!cwd) {
      setHasLocalChanges(false);
      return;
    }
    try {
      if (loadLocalChanges) {
        setHasLocalChanges(await loadLocalChanges(cwd));
        return;
      }
      setHasLocalChanges(await loadComposerWorkingTreeChanges(cwd));
    } catch {
      setHasLocalChanges(false);
    }
  }, [cwd, loadLocalChanges]);

  const refresh = useCallback(async () => {
    await Promise.all([onRefresh(), refreshStatus()]);
  }, [onRefresh, refreshStatus]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      setOpen(nextOpen);
      if (!nextOpen) {
        setQuery("");
        return;
      }
      void refresh();
    },
    [refresh, setOpen],
  );

  const inlineOpen = inline?.open === true;
  useEffect(() => {
    if (inlineOpen) void refresh();
  }, [inlineOpen, refresh]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const choose = useCallback(
    (next: CodexPendingWorktreeStartingState) => {
      if (searchPending || branchLoading || branchError) return;
      onChange(next);
      setOpen(false);
    },
    [branchError, branchLoading, onChange, searchPending, setOpen],
  );

  const pickerContent = (
    <div
      data-composer-picker="branch"
      aria-label={repositoryName ? `Branches in ${repositoryName}` : undefined}
      className={cn("flex flex-col gap-1.5 overflow-hidden", inline ? "w-full" : "w-72")}
      onKeyDownCapture={(event) => handleInlineComposerPickerKeyDown(event, inline)}
    >
      <NodexDropdownSearchInput
        autoFocus={Boolean(inline)}
        aria-label="Search repository branches"
        placeholder="Search branches…"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        onKeyDown={(event) =>
          handleComposerPickerSearchKeyDown(event, searchPending || branchLoading || branchError)
        }
      />
      {inline ? <NodexDropdownSeparator /> : null}
      <div className="vertical-scroll-fade-mask flex max-h-[200px] flex-col overflow-y-auto">
        {hasLocalChanges &&
        currentBranch.toLocaleLowerCase().includes(settledQuery.trim().toLocaleLowerCase()) ? (
          <div className="flex flex-col">
            <NodexDropdownSectionLabel>Local file state</NodexDropdownSectionLabel>
            <NodexDropdownItem
              data-composer-picker-option="true"
              className={COMPOSER_PICKER_ITEM_CLASS_NAME}
              disabled={searchPending || branchLoading || branchError}
              leftSlot={<BranchStatusIcon className="icon-xs" />}
              rightSlot={
                startingState.type === "working-tree" ? <CheckmarkIcon className="icon-xs" /> : null
              }
              closeOnClick={false}
              onSelect={() => choose({ type: "working-tree" })}
            >
              <span className="flex flex-col">
                <span>{currentBranch}</span>
                <span className="text-token-description-foreground">with local code changes</span>
              </span>
            </NodexDropdownItem>
          </div>
        ) : null}

        <NodexDropdownSectionLabel>Local branches</NodexDropdownSectionLabel>
        {branchLoading ? (
          <div className="flex h-full items-center justify-center">
            <ActivitySpinnerIcon className="icon-xxs" />
          </div>
        ) : branchError ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-sm text-token-error-foreground">
            <span>Error loading branches</span>
            <NodexButton
              aria-label="Retry loading branches"
              variant="ghost"
              size="icon"
              className="text-token-description-foreground"
              onClick={() => void refresh()}
            >
              <RetryIcon className="icon-xxs" />
            </NodexButton>
          </div>
        ) : (
          <NodexDropdownSection className="flex flex-col">
            {localBranches.map((branch) => {
              const candidate = { type: "branch", branchName: branch } as const;
              return (
                <NodexDropdownItem
                  data-composer-picker-option="true"
                  className={COMPOSER_PICKER_ITEM_CLASS_NAME}
                  disabled={searchPending || branchLoading || branchError}
                  key={branch}
                  leftSlot={<BranchStatusIcon className="icon-xs" />}
                  rightSlot={
                    isStartingStateSelected(startingState, candidate) ? (
                      <CheckmarkIcon className="icon-xs" />
                    ) : null
                  }
                  closeOnClick={false}
                  onSelect={() => choose(candidate)}
                >
                  {branch}
                </NodexDropdownItem>
              );
            })}
            {localBranches.length === 0 && remoteBranchRefs.length === 0 ? (
              <NodexDropdownMessage compact>No branches found</NodexDropdownMessage>
            ) : null}
            {remoteBranchRefs.length > 0 ? (
              <>
                <NodexDropdownSectionLabel className="mt-1">
                  Remote branches
                </NodexDropdownSectionLabel>
                {remoteBranchRefs.map((remoteRef) => {
                  const candidate = {
                    type: "branch",
                    branchName: remoteBranchName(remoteRef),
                    remoteRef,
                  } as const;
                  return (
                    <NodexDropdownItem
                      data-composer-picker-option="true"
                      className={COMPOSER_PICKER_ITEM_CLASS_NAME}
                      disabled={searchPending || branchLoading || branchError}
                      key={remoteRef}
                      leftSlot={<BranchStatusIcon className="icon-xs" />}
                      rightSlot={
                        isStartingStateSelected(startingState, candidate) ? (
                          <CheckmarkIcon className="icon-xs" />
                        ) : null
                      }
                      closeOnClick={false}
                      onSelect={() => choose(candidate)}
                    >
                      {candidate.branchName}
                    </NodexDropdownItem>
                  );
                })}
              </>
            ) : null}
          </NodexDropdownSection>
        )}
      </div>
    </div>
  );

  if (inline) {
    return inline.open && inline.container ? createPortal(pickerContent, inline.container) : null;
  }

  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={handleOpenChange}
      disabled={disabled || !cwd}
      side="top"
      align="start"
      triggerTooltipContent="What branch should this chat start from?"
      triggerButton={
        <NodexDropdownButtonTrigger
          aria-label="Select starting state"
          data-composer-navigation-target="starting-state"
          disabled={disabled || !cwd}
          size="sm"
          chrome="transparent"
          shape="pill"
          muted
          className="whitespace-nowrap px-1.5 text-token-text-tertiary hover:text-token-foreground"
        >
          <span className="relative inline-flex shrink-0">
            <BranchStatusIcon className="icon-xs" />
            {startingState.type === "working-tree" && hasLocalChanges ? (
              <span
                aria-hidden
                className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full border border-token-side-bar-background bg-token-charts-blue"
              />
            ) : null}
          </span>
          <span className="max-w-40 truncate">{triggerLabel}</span>
        </NodexDropdownButtonTrigger>
      }
    >
      {pickerContent}
    </NodexDropdownMenu>
  );
}
