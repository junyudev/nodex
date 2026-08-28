import { useCallback, useMemo, useState } from "react";
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
} from "@/components/ui/dropdown";
import { NodexButton } from "@/components/ui/button";
import { getGitWorkerClient } from "@/lib/api";
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
  const [open, setOpen] = useState(defaultOpen);
  const [query, setQuery] = useState("");
  const [, setStatusLoading] = useState(false);
  const [hasLocalChanges, setHasLocalChanges] = useState(false);
  const currentBranch = state.currentBranch ?? state.defaultBranch ?? state.branches[0] ?? "HEAD";
  const localBranches = useMemo(
    () =>
      filterValues(
        [currentBranch, ...state.branches.filter((branch) => branch !== currentBranch)],
        query,
      ),
    [currentBranch, query, state.branches],
  );
  const remoteBranchRefs = useMemo(
    () =>
      state.remoteBranchRefs.filter((remoteRef) =>
        remoteBranchName(remoteRef).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
      ),
    [query, state.remoteBranchRefs],
  );
  const triggerLabel =
    startingState.type === "working-tree" ? `${currentBranch} (current)` : startingState.branchName;

  const refreshStatus = useCallback(async () => {
    if (!cwd) {
      setHasLocalChanges(false);
      return;
    }
    setStatusLoading(true);
    try {
      if (loadLocalChanges) {
        setHasLocalChanges(await loadLocalChanges(cwd));
        return;
      }
      const result = await getGitWorkerClient().request({
        method: "status-summary",
        params: { cwd, includeUntrackedFiles: true },
      });
      if (result.type !== "success") {
        setHasLocalChanges(false);
        return;
      }
      setHasLocalChanges(
        result.stagedCount + result.unstagedCount + (result.untrackedCount ?? 0) > 0,
      );
    } catch {
      setHasLocalChanges(false);
    } finally {
      setStatusLoading(false);
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
    [refresh],
  );

  const choose = useCallback(
    (next: CodexPendingWorktreeStartingState) => {
      onChange(next);
      setOpen(false);
    },
    [onChange],
  );

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
      contentClassName="p-0"
    >
      <div className="flex w-72 flex-col gap-1.5 overflow-hidden">
        <NodexDropdownSearchInput
          autoFocus={false}
          aria-label="Search repository branches"
          placeholder={`Search ${repositoryName?.trim() || "repository"} branches`}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            setOpen(false);
          }}
        />
        <div className="vertical-scroll-fade-mask flex h-[200px] flex-col gap-1.5 overflow-y-auto">
          {hasLocalChanges ? (
            <div className="flex flex-col">
              <NodexDropdownSectionLabel>Local file state</NodexDropdownSectionLabel>
              <NodexDropdownItem
                leftSlot={<BranchStatusIcon className="icon-xs" />}
                rightSlot={
                  startingState.type === "working-tree" ? (
                    <CheckmarkIcon className="icon-xs" />
                  ) : null
                }
                subText="with local code changes"
                onSelect={() => choose({ type: "working-tree" })}
              >
                {currentBranch}
              </NodexDropdownItem>
            </div>
          ) : null}

          <NodexDropdownSectionLabel>
            {remoteBranchRefs.length > 0 ? "Local branches" : "Branches"}
          </NodexDropdownSectionLabel>
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
                    key={branch}
                    leftSlot={<BranchStatusIcon className="icon-xs" />}
                    rightSlot={
                      isStartingStateSelected(startingState, candidate) ? (
                        <CheckmarkIcon className="icon-xs" />
                      ) : null
                    }
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
                        key={remoteRef}
                        leftSlot={<BranchStatusIcon className="icon-xs" />}
                        rightSlot={
                          isStartingStateSelected(startingState, candidate) ? (
                            <CheckmarkIcon className="icon-xs" />
                          ) : null
                        }
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
    </NodexDropdownMenu>
  );
}
