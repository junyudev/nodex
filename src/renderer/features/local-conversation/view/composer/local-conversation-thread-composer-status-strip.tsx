import { runWithCleanup } from "@/lib/run-with-cleanup";
import { toastFailure } from "@/lib/failure-toast";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  contextRailLeadingContent?: ReactNode;
  projectSelectorDisabled?: boolean;
  className?: string;
}

export function ThreadComposerStatusStrip({
  model,
  actions,
  contextRailLeadingContent,
  projectSelectorDisabled = false,
  className,
}: ThreadComposerStatusStripProps) {
  if (!shouldShowThreadComposerStatusStrip(model)) return null;

  return (
    <ThreadComposerStatusStripContent
      model={model}
      actions={actions}
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
  contextRailLeadingContent,
  projectSelectorDisabled = false,
  className,
}: ThreadComposerStatusStripProps) {
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
  const [branchState, setBranchState] = useState<BranchSelectorState>(() =>
    branchCwd && branchStateData
      ? parseBranchSelectorState(branchStateData)
      : EMPTY_BRANCH_SELECTOR_STATE,
  );
  const branchCwdRef = useRef<string | null>(branchCwd);
  const branchMutationRequestIdRef = useRef(0);
  useLayoutEffect(() => {
    if (branchCwdRef.current !== branchCwd) branchMutationRequestIdRef.current += 1;
    branchCwdRef.current = branchCwd;
  }, [branchCwd]);
  const showNewChatProjectSelector = Boolean(
    model.isNewThreadTab &&
    model.conversation === null &&
    model.newThreadTarget?.sessionId &&
    model.newThreadProjectSelector &&
    !model.newThreadProjectSelector.disabled,
  );
  const showNewChatStartInSelector = Boolean(
    model.isNewThreadTab &&
    model.conversation === null &&
    model.newThreadTarget?.sessionId &&
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
    return runWithCleanup(
      async () => {
        const result = await refetchBranchState();
        if (branchCwdRef.current !== requestedCwd) return;
        setBranchState(
          result.data ? parseBranchSelectorState(result.data) : EMPTY_BRANCH_SELECTOR_STATE,
        );
      },
      {
        onError: () => {
          if (branchCwdRef.current !== requestedCwd) return;
          setBranchState(EMPTY_BRANCH_SELECTOR_STATE);
        },
      },
    );
  }, [refetchBranchState]);

  const [previousBranch, setPreviousBranch] = useState({ cwd: branchCwd, data: branchStateData });
  if (previousBranch.cwd !== branchCwd || previousBranch.data !== branchStateData) {
    setPreviousBranch({ cwd: branchCwd, data: branchStateData });
    if (previousBranch.cwd !== branchCwd) setIsBranchBusy(false);
    setBranchState(
      branchCwd && branchStateData
        ? parseBranchSelectorState(branchStateData)
        : EMPTY_BRANCH_SELECTOR_STATE,
    );
  }

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
      return runWithCleanup(
        async () => {
          const nextState = await changeComposerBranch({
            cwd: requestedCwd,
            branch,
            create,
          });
          if (!isCurrentRequest()) return false;
          setBranchState(parseBranchSelectorState(nextState));
          return true;
        },
        {
          onError: (error) => {
            if (isCurrentRequest()) {
              toastFailure(create ? "Couldn’t create a branch" : "Couldn’t switch branches", error);
            }
            return false;
          },
          cleanup: () => {
            if (isCurrentRequest()) setIsBranchBusy(false);
          },
        },
      );
    },
    [branchCwd],
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
