import { captureCodexTurnPresentation } from "@/lib/codex-turn-presentation";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { useCallback, useEffect, useEffectEvent, useMemo, useSyncExternalStore } from "react";
import {
  useCodexAppServerManagerForConversationId,
  useConversationRuntime,
} from "../local-conversation-store";
import { ReviewDiffPanel } from "@/components/workbench/review-diff-panel";
import type { CodexConversationItem, CodexConversationSnapshot } from "@/lib/types";
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
import type { AgentRuntimeSessionTarget } from "../../../../shared/agent-runtime-api";
import { acquireAgentRuntimeConversationOwner } from "../agent-runtime-conversation-owner";
import { createAgentRuntimeConversationRuntime } from "../agent-runtime-conversation-adapter";
import type { ConversationRuntime } from "../conversation-runtime";
import { useExternalSelector } from "@/lib/use-external-store-selector";
import { agentRuntimeRuntime } from "@/lib/agent-runtime-runtime";
import { createUuidV7 } from "../../../../shared/uuid-v7";
import type {
  CodexTranscriptReadOwner,
  CodexTranscriptTurnSlice,
} from "../normalized-transcript-read-owner";
import {
  buildCodexTurnDiffFromPatchBatches,
  materializeCodexFileChange,
} from "../../../../shared/codex-file-change";

interface ConnectedReviewDiffPanelProps {
  threadId: string | null;
  projectWorkspacePath?: string | null;
  searchOpenTick: number;
  pendingOpen?: WorkbenchPendingReviewOpen | null;
  onOpenConsumed?: (operationId: string) => void;
  runtimeTarget?: AgentRuntimeSessionTarget & { readonly threadId: string };
}

const emptySubscribe = () => () => {};
const reviewSlices = new WeakMap<CodexTranscriptReadOwner, Map<string, CodexTranscriptTurnSlice>>();
const reviewItemChanges = (item: CodexConversationItem | undefined) =>
  Object.entries(item?.fileChange?.changes ?? {}).map(([path, patch]) =>
    materializeCodexFileChange(path, patch),
  );

/** Review borrows only resident keyed Turns; it never requests another history window. */
function readReviewConversation(runtime: ConversationRuntime, threadId: string | null) {
  const conversation = runtime.read(threadId);
  const reader = runtime.transcriptReadOwner?.(threadId);
  if (!conversation || !reader) return conversation;
  const rows = reader.readStructure()?.turns ?? [];
  const slices = reviewSlices.get(reader) ?? new Map<string, CodexTranscriptTurnSlice>();
  reviewSlices.set(reader, slices);
  const keys = new Set(rows.map((row) => row.entityKey));
  for (const key of slices.keys()) if (!keys.has(key)) slices.delete(key);
  const turns = rows.flatMap(({ entityKey }) => {
    const itemIds = (reader.readItemSlots(entityKey)?.entries ?? []).flatMap(({ itemId }) => {
      const item = reader.readItem(entityKey, itemId);
      return item?.type === "fileChange" ||
        (item?.type === "agentMessage" && item.text.includes("::code-comment"))
        ? [itemId]
        : [];
    });
    const previous = slices.get(entityKey);
    const slice =
      previous &&
      previous.itemIds.length === itemIds.length &&
      previous.itemIds.every((id, index) => id === itemIds[index])
        ? previous
        : { itemIds, includeInput: false, includeTurnExtras: true };
    slices.set(entityKey, slice);
    const turn = reader.readTurnSlice(entityKey, slice);
    if (!turn) return [];
    if (turn.diff) return [turn];
    const patches = turn.items.flatMap(reviewItemChanges);
    return patches.length
      ? [
          {
            ...turn,
            diff: buildCodexTurnDiffFromPatchBatches([{ cwd: conversation.cwd, changes: patches }]),
          },
        ]
      : [turn];
  });
  return { ...conversation, turns };
}

function useReviewConversation<T>(
  runtime: ConversationRuntime,
  threadId: string | null,
  selector: (value: CodexConversationSnapshot | null) => T,
  equal: (left: T, right: T) => boolean,
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const reader = runtime.transcriptReadOwner?.(threadId);
      const turns = new Map<string, () => void>();
      const reconcile = () => {
        const keys = new Set(reader?.readStructure()?.turns.map((turn) => turn.entityKey));
        for (const [key, release] of turns) {
          if (keys.has(key)) continue;
          release();
          turns.delete(key);
        }
        for (const key of keys) {
          if (!turns.has(key) && reader) turns.set(key, reader.subscribeTurn(key, listener));
        }
        listener();
      };
      const releaseRuntime = runtime.subscribe(threadId, reconcile);
      const releaseStructure = reader?.subscribeStructure(reconcile);
      reconcile();
      return () => {
        releaseRuntime();
        releaseStructure?.();
        for (const release of turns.values()) release();
      };
    },
    [runtime, threadId],
  );
  return useExternalSelector(
    subscribe,
    () => selector(readReviewConversation(runtime, threadId)),
    equal,
  );
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
  const filePatches = reviewItemChanges(item);
  const fileBatches = filePatches.length ? [{ cwd: conversation.cwd, changes: filePatches }] : [];
  const itemPayload =
    rawItem !== null && typeof rawItem === "object"
      ? filterTurnDiffPayload(
          {
            unifiedDiff:
              typeof (rawItem as { unifiedDiff?: unknown }).unifiedDiff === "string"
                ? (rawItem as { unifiedDiff: string }).unifiedDiff
                : buildCodexTurnDiffFromPatchBatches(fileBatches),
            cwd:
              typeof (rawItem as { cwd?: unknown }).cwd === "string"
                ? (rawItem as { cwd: string }).cwd
                : (conversation.cwd ?? projectWorkspacePath ?? undefined),
            showRevertButton: (rawItem as { showRevertButton?: unknown }).showRevertButton === true,
            patchBatches: normalizeTurnDiffPatchBatches(
              (rawItem as { patchBatches?: unknown }).patchBatches ?? fileBatches,
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
  runtimeTarget,
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
  const targetSessionId = runtimeTarget?.sessionId;
  const targetThreadId = runtimeTarget?.threadId;
  const acquired = useMemo(
    () =>
      targetSessionId && targetThreadId
        ? acquireAgentRuntimeConversationOwner({
            sessionId: targetSessionId,
            threadId: targetThreadId,
          })
        : null,
    [targetSessionId, targetThreadId],
  );
  useEffect(() => acquired?.retain(), [acquired]);
  const readKind = () => {
    const projection = acquired?.owner.getSnapshot().conversation?.snapshot.projection;
    const driver = projection?.providerThreads.find(
      (item) => item.id === projection.thread.activeProviderThreadId,
    )?.driver;
    if (driver === "claudeAgent") return "claude";
    if (driver === "opencode") return "opencode";
    if (driver === "acpRegistry") return "acp";
    return "codex";
  };
  const kind = useSyncExternalStore(acquired?.owner.subscribe ?? emptySubscribe, readKind);
  const nativeRuntime = useConversationRuntime(transcriptThreadId);
  const runtime = acquired
    ? createAgentRuntimeConversationRuntime(kind, runtimeTarget!, acquired.owner)
    : nativeRuntime;
  const reviewProjectionSelector = useMemo(() => createReviewConversationProjectionSelector(), []);
  const conversationProjection = useReviewConversation(
    runtime,
    transcriptThreadId,
    reviewProjectionSelector,
    areReviewConversationProjectionsEqual,
  );
  const refreshedSelectedTurnDiff = useReviewConversation(
    runtime,
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
      if (runtimeTarget) {
        if (targetThreadId !== runtimeTarget.threadId)
          throw new Error("The Review execution target changed");
        return agentRuntimeRuntime.message({
          ...runtimeTarget,
          presentationTicket,
          message: { messageId: createUuidV7(), text: prompt, images: [] },
        });
      }
      return manager.startTurn(targetThreadId, prompt, undefined, presentationTicket);
    },
    [manager, workbenchOwner, runtimeTarget],
  );

  return (
    <ReviewDiffPanel
      conversationProjection={conversationProjection}
      onStartThreadPrompt={startThreadPrompt}
      threadId={transcriptThreadId}
      projectWorkspacePath={
        runtimeTarget ? conversationProjection.cwd : (projectWorkspacePath ?? null)
      }
      selectedTurnDiff={refreshedSelectedTurnDiff}
      searchOpenTick={searchOpenTick}
    />
  );
}

export const connectedReviewDiffPanelTestHelpers = {
  refreshSelectedTurnDiffTarget,
  readReviewConversation,
};
