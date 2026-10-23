import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";
import {
  EMPTY_BRANCH_SELECTOR_STATE,
  isBranchSelectorMutationCurrent,
  parseBranchSelectorState,
  resolveBranchSelectorCwd,
  type BranchSelectorState,
} from "../shared/branch-selector-state";
import { changeComposerBranch } from "../../composer-git-context";
import { ConfigureLocalEnvironmentPopover } from "./configure-local-environment-popover";
import { ComposerContextControls } from "./composer-context-controls";
import { useGitBranchState } from "@/lib/use-git-branch-state";
import { ComposerContextRail } from "../composer-context-rail";
import { NewChatProjectSelector } from "./new-chat-project-selector";
import { NewChatLocationSelector } from "./new-chat-location-selector";

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

  const handleChangeBranch = useCallback(
    async (branch: string, create: boolean) => {
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
        const nextState = await changeComposerBranch({
          cwd: requestedCwd,
          branch,
          create,
        });
        if (!isCurrentRequest()) return false;
        setBranchState(parseBranchSelectorState(nextState));
        return true;
      } catch (error) {
        if (isCurrentRequest()) {
          onErrorMessage(
            error instanceof Error
              ? error.message
              : create
                ? "Could not create branch"
                : "Could not switch branches",
          );
        }
        return false;
      } finally {
        if (isCurrentRequest()) setIsBranchBusy(false);
      }
    },
    [branchCwd, onErrorMessage],
  );

  const handleCheckoutBranch = (branch: string) => handleChangeBranch(branch, false);
  const handleCreateBranch = (branch: string) => handleChangeBranch(branch, true);

  return (
    <ComposerContextRail className={className}>
      {contextRailLeadingContent}
      <ComposerContextControls>
        {showNewChatProjectSelector && model.newThreadProjectSelector ? (
          <NewChatProjectSelector
            model={model.newThreadProjectSelector}
            actions={actions}
            disabled={projectSelectorDisabled}
          />
        ) : null}
        <NewChatLocationSelector disabled={projectSelectorDisabled} />
      </ComposerContextControls>
      {showNewChatStartInSelector && model.newThreadStartInSelector ? (
        <div className="order-3 flex shrink-0">
          <ConfigureLocalEnvironmentPopover
            key={branchCwd ?? "projectless"}
            model={model.newThreadStartInSelector}
            actions={actions}
            cwd={branchCwd}
            branchState={branchState}
            branchBusy={isBranchBusy}
            branchLoading={
              branchStateLoading ||
              (branchStateFetching && branchState === EMPTY_BRANCH_SELECTOR_STATE)
            }
            branchError={branchStateError}
            startingState={selectedNewWorktreeStartingState}
            worktreeAvailable={worktreeAvailable}
            disabled={projectSelectorDisabled}
            onRefreshBranches={handleRefreshBranchState}
            onCheckoutBranch={handleCheckoutBranch}
            onCreateBranch={handleCreateBranch}
          />
        </div>
      ) : null}
    </ComposerContextRail>
  );
}
