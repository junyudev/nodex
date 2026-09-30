import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LocalStatusIcon } from "@/components/shared/icons";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";
import {
  EMPTY_BRANCH_SELECTOR_STATE,
  isBranchSelectorMutationCurrent,
  parseBranchSelectorState,
  resolveBranchSelectorCwd,
  type BranchSelectorState,
} from "../shared/branch-selector-state";
import {
  BranchSelectorPopover,
  EnvironmentSelectorPopover,
  getGitWorkerClient,
} from "./local-conversation-thread-composer-deps";
import { useGitBranchState } from "@/lib/use-git-branch-state";
import { ComposerContextRail } from "../composer-context-rail";
import { NewChatProjectSelector } from "./new-chat-project-selector";
import { NewChatStartInSelector } from "./new-chat-start-in-selector";
import { WorktreeStartingStatePopover } from "../shared/worktree-starting-state-popover";

interface ThreadComposerStatusStripProps {
  model: ThreadFooterModel;
  actions: ThreadStageActions;
  onErrorMessage: (message: string | null) => void;
  contextRailLeadingContent?: ReactNode;
  projectSelectorDisabled?: boolean;
  className?: string;
}

export function ThreadComposerStatusStrip({
  model,
  actions,
  onErrorMessage,
  contextRailLeadingContent,
  projectSelectorDisabled = false,
  className,
}: ThreadComposerStatusStripProps) {
  if (!shouldShowThreadComposerStatusStrip(model)) return null;

  return (
    <ThreadComposerStatusStripContent
      model={model}
      actions={actions}
      onErrorMessage={onErrorMessage}
      contextRailLeadingContent={contextRailLeadingContent}
      projectSelectorDisabled={projectSelectorDisabled}
      className={className}
    />
  );
}

export function shouldShowThreadComposerStatusStrip(model: ThreadFooterModel): boolean {
  return model.isNewThreadTab && model.conversation === null;
}

function ThreadComposerStatusStripContent({
  model,
  actions,
  onErrorMessage,
  contextRailLeadingContent,
  projectSelectorDisabled = false,
  className,
}: ThreadComposerStatusStripProps) {
  const [branchState, setBranchState] = useState<BranchSelectorState>(EMPTY_BRANCH_SELECTOR_STATE);
  const [isBranchBusy, setIsBranchBusy] = useState(false);
  const branchCwd = useMemo(
    () => resolveBranchSelectorCwd(model.conversation?.cwd, model.projectWorkspacePath),
    [model.conversation?.cwd, model.projectWorkspacePath],
  );
  const {
    data: branchStateData,
    isError: branchStateError,
    isFetching: branchStateFetching,
    isLoading: branchStateLoading,
    refetch: refetchBranchState,
  } = useGitBranchState(branchCwd, {
    watch: true,
  });
  const branchCwdRef = useRef<string | null>(branchCwd);
  const branchMutationRequestIdRef = useRef(0);
  branchCwdRef.current = branchCwd;
  const showNewChatProjectSelector = Boolean(
    model.isNewThreadTab &&
    model.conversation === null &&
    model.newThreadTarget?.sessionId &&
    !model.isCloudNewThreadTarget &&
    model.newThreadProjectSelector &&
    !model.newThreadProjectSelector.disabled,
  );
  const showNewChatStartInSelector = Boolean(
    model.isNewThreadTab &&
    model.conversation === null &&
    model.newThreadTarget?.sessionId &&
    !model.isCloudNewThreadTarget &&
    model.newThreadStartInSelector,
  );
  const worktreeAvailable = Boolean(
    branchCwd &&
    (branchState.currentBranch || branchState.defaultBranch || branchState.branches.length > 0),
  );
  const selectedNewWorktreeStartingState = model.newThreadStartInSelector?.target
    .worktreeStartingState ?? {
    type: "branch" as const,
    branchName:
      branchState.currentBranch ?? branchState.defaultBranch ?? branchState.branches[0] ?? "HEAD",
  };

  const handleRefreshBranchState = useCallback(async () => {
    const requestedCwd = branchCwdRef.current;
    if (!requestedCwd) {
      setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
      return;
    }
    try {
      const result = await refetchBranchState();
      if (branchCwdRef.current !== requestedCwd) return;
      setBranchState(
        result.data ? parseBranchSelectorState(result.data) : EMPTY_BRANCH_SELECTOR_STATE,
      );
    } catch {
      if (branchCwdRef.current !== requestedCwd) return;
      setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
    }
  }, [refetchBranchState]);

  useEffect(() => {
    branchMutationRequestIdRef.current += 1;
    setIsBranchBusy(false);

    if (!branchCwd) {
      setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
    }
  }, [branchCwd]);

  useEffect(() => {
    if (!branchCwd || !branchStateData) {
      setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
      return;
    }

    setBranchState(parseBranchSelectorState(branchStateData));
  }, [branchCwd, branchStateData]);

  const handleCheckoutBranch = useCallback(
    async (branch: string) => {
      const requestedCwd = branchCwd;
      if (!requestedCwd) return false;
      const requestId = branchMutationRequestIdRef.current + 1;
      branchMutationRequestIdRef.current = requestId;
      const isCurrentRequest = () =>
        isBranchSelectorMutationCurrent({
          activeRequestId: branchMutationRequestIdRef.current,
          requestId,
          activeCwd: branchCwdRef.current,
          requestedCwd,
        });

      setIsBranchBusy(true);
      onErrorMessage(null);
      try {
        const result = await getGitWorkerClient().request({
          method: "checkout-branch",
          params: { cwd: requestedCwd, branch },
        });
        if (!isCurrentRequest()) return false;
        if (result.type === "error") throw new Error(result.errorMessage);
        setBranchState(parseBranchSelectorState(result.value));
        return true;
      } catch (error) {
        if (isCurrentRequest()) {
          onErrorMessage(error instanceof Error ? error.message : "Could not switch branches");
        }
        return false;
      } finally {
        if (isCurrentRequest()) setIsBranchBusy(false);
      }
    },
    [branchCwd, onErrorMessage],
  );

  const handleCreateBranch = useCallback(
    async (branch: string) => {
      const requestedCwd = branchCwd;
      if (!requestedCwd) return false;
      const requestId = branchMutationRequestIdRef.current + 1;
      branchMutationRequestIdRef.current = requestId;
      const isCurrentRequest = () =>
        isBranchSelectorMutationCurrent({
          activeRequestId: branchMutationRequestIdRef.current,
          requestId,
          activeCwd: branchCwdRef.current,
          requestedCwd,
        });

      setIsBranchBusy(true);
      onErrorMessage(null);
      try {
        const result = await getGitWorkerClient().request({
          method: "create-branch",
          params: { cwd: requestedCwd, branch },
        });
        if (!isCurrentRequest()) return false;
        if (result.type === "error") throw new Error(result.errorMessage);
        setBranchState(parseBranchSelectorState(result.value));
        return true;
      } catch (error) {
        if (isCurrentRequest()) {
          onErrorMessage(error instanceof Error ? error.message : "Could not create branch");
        }
        return false;
      } finally {
        if (isCurrentRequest()) setIsBranchBusy(false);
      }
    },
    [branchCwd, onErrorMessage],
  );

  return (
    <ComposerContextRail className={className}>
      {contextRailLeadingContent}
      <div className="order-2 flex min-w-0 flex-1 flex-nowrap items-center gap-1">
        {showNewChatProjectSelector && model.newThreadProjectSelector ? (
          <NewChatProjectSelector
            model={model.newThreadProjectSelector}
            actions={actions}
            disabled={projectSelectorDisabled}
          />
        ) : null}
        {showNewChatStartInSelector && model.newThreadStartInSelector ? (
          <NewChatStartInSelector
            model={model.newThreadStartInSelector}
            actions={actions}
            disabled={projectSelectorDisabled}
            worktreeAvailable={worktreeAvailable}
          />
        ) : (
          <span className="inline-flex h-7 items-center gap-1 px-1.5 text-sm/4.5 text-(--foreground-tertiary)">
            <LocalStatusIcon className="size-3.5 shrink-0" />
            <span className="max-w-40 truncate text-sm">Work locally</span>
          </span>
        )}
        {showNewChatStartInSelector &&
        model.newThreadStartInSelector &&
        model.newThreadStartInSelector.environmentAvailable !== false &&
        model.newThreadStartInSelector.target.runInTarget === "newWorktree" ? (
          <EnvironmentSelectorPopover
            configs={model.newThreadStartInSelector.environments}
            selectedPath={model.newThreadStartInSelector.selectedEnvironmentPath}
            defaultPath={model.newThreadStartInSelector.defaultEnvironmentPath}
            needsAttention={model.newThreadStartInSelector.environmentNeedsAttention}
            repairConfigPath={model.newThreadStartInSelector.environmentRepairConfigPath}
            repositoryName={model.newThreadStartInSelector.repositoryName}
            showRepositoryName={
              (model.newThreadStartInSelector.additionalSourceFolderCount ?? 0) > 0
            }
            busy={model.newThreadStartInSelector.environmentsLoading}
            error={model.newThreadStartInSelector.environmentsError}
            disabled={projectSelectorDisabled || model.newThreadStartInSelector.disabled}
            onRefresh={() => actions.onRefreshNewThreadStartInEnvironments?.() ?? Promise.resolve()}
            onSelect={(environmentPath) => {
              actions.onNewThreadStartInEnvironmentChange?.(environmentPath);
              return true;
            }}
            onOpenSettings={(configPath) =>
              actions.onOpenNewThreadLocalEnvironmentsSettings?.(configPath)
            }
            triggerClassName="text-token-text-tertiary hover:text-token-foreground"
          />
        ) : null}
        {showNewChatStartInSelector &&
        model.newThreadStartInSelector?.target.runInTarget === "newWorktree" ? (
          <WorktreeStartingStatePopover
            cwd={branchCwd}
            state={branchState}
            startingState={selectedNewWorktreeStartingState}
            branchLoading={
              branchStateLoading ||
              (branchStateFetching && branchState === EMPTY_BRANCH_SELECTOR_STATE)
            }
            branchError={branchStateError}
            repositoryName={model.newThreadStartInSelector.repositoryName}
            disabled={projectSelectorDisabled || model.newThreadStartInSelector.disabled}
            onRefresh={handleRefreshBranchState}
            onChange={(worktreeStartingState) => {
              actions.onNewThreadStartInTargetChange?.({
                ...model.newThreadStartInSelector!.target,
                worktreeStartingState,
              });
            }}
          />
        ) : (
          <BranchSelectorPopover
            cwd={branchCwd}
            state={branchState}
            busy={isBranchBusy}
            loading={
              branchStateLoading ||
              (branchStateFetching && branchState === EMPTY_BRANCH_SELECTOR_STATE)
            }
            error={branchStateError}
            onRefresh={handleRefreshBranchState}
            onCheckout={handleCheckoutBranch}
            onCreate={handleCreateBranch}
          />
        )}
      </div>
    </ComposerContextRail>
  );
}
