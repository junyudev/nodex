import { captureCodexTurnPresentation } from "@/lib/codex-turn-presentation";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { useCallback, useEffect, useEffectEvent, useMemo } from "react";
import {
  useCodexAppServerManagerForConversationId,
  useCodexConversationValue,
} from "../local-conversation-store";
import { ReviewDiffPanel } from "@/components/workbench/review-diff-panel";
import type { CodexConversationSnapshot } from "@/lib/types";
import { useScopedAtomValue, useSetScopedAtom } from "@/lib/maitai";
import {
  reviewRouteStateAtom,
  prepareReviewOpenAtom,
  type ResolvedTurnDiffReview,
  type ReviewSelectedTurnIdentity,
} from "@/features/review/model/review-view-state";
import {
  areReviewConversationProjectionsEqual,
  createReviewConversationProjectionSelector,
} from "@/features/review/model/review-conversation-projection";
import {
  filterTurnDiffPayload,
  normalizeTurnDiffPatchBatches,
} from "@/features/local-conversation/projection/projectless-output-scope";
import { recordReviewRuntimeEvent } from "@/features/review/testing/review-runtime-probe";
import type { WorkbenchPendingReviewOpen } from "../../../../shared/nodex-app-tools/workbench-reveal";
import { workbenchReviewOpenIntent } from "@/lib/workbench-review-open";

interface ConnectedReviewDiffPanelProps {
  threadId: string | null;
  projectWorkspacePath?: string | null;
  searchOpenTick: number;
  pendingOpen?: WorkbenchPendingReviewOpen | null;
  onOpenConsumed?: (operationId: string) => void;
}

function refreshSelectedTurnDiffTarget(
  selectedTurn: ReviewSelectedTurnIdentity | null,
  conversation: CodexConversationSnapshot | null,
  projectWorkspacePath: string | null,
): ResolvedTurnDiffReview | null {
  if (!selectedTurn || !conversation) return null;

  const turn = conversation.turns.find((candidate) => candidate.turnId === selectedTurn.turnId);
  const item = turn?.items.find(
    (candidate) => (candidate.entryId ?? candidate.itemId) === selectedTurn.entryId,
  );
  const rawItem = item?.rawItem;
  const itemPayload =
    rawItem !== null && typeof rawItem === "object"
      ? filterTurnDiffPayload(
          {
            unifiedDiff:
              typeof (rawItem as { unifiedDiff?: unknown }).unifiedDiff === "string"
                ? (rawItem as { unifiedDiff: string }).unifiedDiff
                : "",
            cwd:
              typeof (rawItem as { cwd?: unknown }).cwd === "string"
                ? (rawItem as { cwd: string }).cwd
                : (conversation.cwd ?? projectWorkspacePath ?? undefined),
            showRevertButton: (rawItem as { showRevertButton?: unknown }).showRevertButton === true,
            patchBatches: normalizeTurnDiffPatchBatches(
              (rawItem as { patchBatches?: unknown }).patchBatches,
            ),
          },
          {
            cwd: conversation.cwd ?? projectWorkspacePath,
            projectlessOutputDirectory: conversation.projectlessOutputDirectory,
          },
        )
      : null;
  const derivedTurnPayload =
    selectedTurn.entryId === `turn-diff:${turn?.turnId ?? ""}` && turn
      ? filterTurnDiffPayload(
          {
            unifiedDiff: turn.diff ?? "",
            cwd: conversation.cwd ?? projectWorkspacePath ?? undefined,
            patchBatches: [],
          },
          {
            cwd: conversation.cwd ?? projectWorkspacePath,
            projectlessOutputDirectory: conversation.projectlessOutputDirectory,
          },
        )
      : null;
  const payload = itemPayload ?? derivedTurnPayload;
  if (!payload) return null;

  const cwd = payload.cwd ?? conversation.cwd ?? projectWorkspacePath;

  return {
    threadId: selectedTurn.threadId,
    turnId: selectedTurn.turnId,
    entryId: selectedTurn.entryId,
    patch: payload.unifiedDiff,
    cwd: cwd ?? null,
    showRevertButton: payload.showRevertButton === true,
    patchBatches: payload.patchBatches ?? undefined,
  };
}

function areSelectedTurnDiffTargetsEqual(
  left: ResolvedTurnDiffReview | null,
  right: ResolvedTurnDiffReview | null,
): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const leftPatchBatches = left.patchBatches ?? [];
  const rightPatchBatches = right.patchBatches ?? [];
  const patchBatchesEqual =
    left.patchBatches === right.patchBatches ||
    (leftPatchBatches.length === rightPatchBatches.length &&
      leftPatchBatches.every(
        (batch, index) =>
          batch.cwd === rightPatchBatches[index]?.cwd &&
          batch.changes === rightPatchBatches[index]?.changes,
      ));
  return (
    left.threadId === right.threadId &&
    left.turnId === right.turnId &&
    left.entryId === right.entryId &&
    left.patch === right.patch &&
    left.cwd === right.cwd &&
    left.showRevertButton === right.showRevertButton &&
    patchBatchesEqual
  );
}

export function ConnectedReviewDiffPanel({
  threadId,
  projectWorkspacePath,
  searchOpenTick,
  pendingOpen,
  onOpenConsumed,
}: ConnectedReviewDiffPanelProps) {
  recordReviewRuntimeEvent({ type: "connected-render" });
  const reviewRouteState = useScopedAtomValue(reviewRouteStateAtom);
  const prepareOpen = useSetScopedAtom(prepareReviewOpenAtom);
  const consumeOpen = useEffectEvent(() => {
    if (!pendingOpen || pendingOpen.intent.threadId !== threadId) return;
    prepareOpen(workbenchReviewOpenIntent(pendingOpen));
    onOpenConsumed?.(pendingOpen.operationId);
  });
  useEffect(() => {
    consumeOpen();
  }, [pendingOpen?.operationId, threadId]);
  const transcriptThreadId = reviewRouteState.transcriptThreadId ?? threadId;
  const reviewProjectionSelector = useMemo(createReviewConversationProjectionSelector, []);
  const conversationProjection = useCodexConversationValue(
    transcriptThreadId,
    reviewProjectionSelector,
    areReviewConversationProjectionsEqual,
  );
  const refreshedSelectedTurnDiff = useCodexConversationValue(
    reviewRouteState.source === "selected-turn" ? transcriptThreadId : null,
    (conversation) =>
      refreshSelectedTurnDiffTarget(
        reviewRouteState.selectedTurn,
        conversation,
        projectWorkspacePath ?? null,
      ),
    areSelectedTurnDiffTargetsEqual,
  );
  const manager = useCodexAppServerManagerForConversationId(transcriptThreadId);
  const workbenchOwner = useWorkbenchWindowOwner();
  const startThreadPrompt = useCallback(
    async (targetThreadId: string, prompt: string) => {
      const presentationTicket = await captureCodexTurnPresentation(workbenchOwner, {
        kind: "thread",
        threadId: targetThreadId,
      });
      return manager.startTurn(targetThreadId, prompt, undefined, presentationTicket);
    },
    [manager, workbenchOwner],
  );

  return (
    <ReviewDiffPanel
      conversationProjection={conversationProjection}
      onStartThreadPrompt={startThreadPrompt}
      threadId={transcriptThreadId}
      projectWorkspacePath={projectWorkspacePath ?? null}
      selectedTurnDiff={refreshedSelectedTurnDiff}
      searchOpenTick={searchOpenTick}
    />
  );
}

export const connectedReviewDiffPanelTestHelpers = {
  refreshSelectedTurnDiffTarget,
};
