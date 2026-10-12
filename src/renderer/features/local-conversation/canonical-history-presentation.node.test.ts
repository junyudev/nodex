import { expect, test } from "vitest";
import { produce, produceWithPatches, enablePatches } from "immer";
import { buildAgentActivityV2CorpusThread } from "../../../shared/codex-conversation-state/test-fixtures/agent-activity-v2-corpus-provenance";
import { createCodexCanonicalHydratedConversationState } from "../../../shared/codex-conversation-state/codex-conversation-state";
import { replaceCanonicalHistoryDraft } from "../../../shared/codex-conversation-state/codex-canonical-history-loader";
import {
  conversationTurnDraft,
  residentConversationTurnEntries,
  residentConversationTurns,
} from "../../../shared/codex-conversation-state/codex-turn-mutation";
import {
  createCodexConversationHistoryTurnItemsRef,
  isCodexConversationHistoryTurnItemsRefCurrent,
} from "../../../shared/codex-conversation-history-page";
import { projectCanonicalHistoryPresentation } from "./canonical-history-presentation";

enablePatches();
function fixture() {
  const state = createCodexCanonicalHydratedConversationState(
    buildAgentActivityV2CorpusThread([
      {
        type: "agentMessage",
        id: "retained",
        text: "answer",
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    ]),
    {
      hostId: "local",
      model: "model",
      reasoningEffort: null,
      cwd: "/work",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/work"],
    },
  );
  return produce(state, (draft) => {
    replaceCanonicalHistoryDraft(draft, state.turns, false, {
      cursor: "older-turns",
      source: "ordinary",
      oldestLoadedTurnId: state.turns[0]!.turnId,
    });
    const turn = conversationTurnDraft(draft, residentConversationTurnEntries(draft)[0]!.address)!;
    turn.itemsPagination = {
      source: "ordinary",
      olderCursor: null,
      olderItemId: "retained",
      evicted: true,
      hasLoadedOldest: false,
      isLoadingOlder: false,
      itemsView: "full",
    };
  });
}

test("compact history metadata exposes its topology and full released Turn recovery boundary", () => {
  const state = fixture();
  const metadata = projectCanonicalHistoryPresentation(state);
  const turn = residentConversationTurns(state)[0]!;
  expect(metadata.conversationEntityGeneration).toBe(0);
  expect(metadata.historyTopologyGeneration).toBe(state.turnHistory!.history.generation);
  expect(metadata.historyRows?.[0]).toMatchObject({
    kind: "gap",
    newerBoundary: { handle: { source: "ordinary", cursor: "older-turns" } },
  });
  expect(metadata.turnPagination).toMatchObject({
    olderCursor: "older-turns",
    hasLoadedOldest: false,
    loadedTurnCount: 1,
  });
  expect(metadata.turnItemsPaginationById?.[turn.turnId!]).toBe(turn.itemsPagination);
  expect(
    createCodexConversationHistoryTurnItemsRef({
      turnId: turn.turnId!,
      expectedTopologyGeneration: metadata.historyTopologyGeneration!,
      pagination: metadata.turnItemsPaginationById![turn.turnId!]!,
    }),
  ).not.toBeNull();
});

test("a cold paginated seed remains incomplete until its history is installed", () => {
  const state = fixture();
  const seed: typeof state = {
    ...state,
    turnHistory: undefined,
    turns: [],
    turnsPagination: undefined,
    resumeState: "resuming" as const,
    historyMode: "paginated" as const,
  };
  const before = projectCanonicalHistoryPresentation(seed);
  expect(before.turnPagination).toMatchObject({ hasLoadedOldest: false, loadedTurnCount: 0 });
  const [after, patches] = produceWithPatches(seed, (draft) => {
    draft.resumeState = "resumed";
  });
  const next = projectCanonicalHistoryPresentation(
    after,
    { ...before, canonicalState: seed },
    patches,
  );
  expect(next.turnPagination?.hasLoadedOldest).toBe(true);
  expect(next.historyMutationRevision).toBe(before.historyMutationRevision! + 1);
});

test("accepted text receipts and ordinary text snapshots preserve history references and revision", () => {
  const before = fixture();
  const metadata = projectCanonicalHistoryPresentation(before);
  const previous = { ...metadata, canonicalState: before, conversationEntityGeneration: 12 };
  const [after, patches] = produceWithPatches(before, (draft) => {
    const item = conversationTurnDraft(draft, residentConversationTurnEntries(draft)[0]!.address)!
      .items[0]!;
    if (item.type === "agentMessage") item.text += " updated";
  });
  for (const hints of [patches, undefined]) {
    const next = projectCanonicalHistoryPresentation(after, previous, hints);
    expect(next.historyRows).toBe(metadata.historyRows);
    expect(next.turnPagination).toBe(metadata.turnPagination);
    expect(next.turnItemsPaginationById).toBe(metadata.turnItemsPaginationById);
    expect(next.historyMutationRevision).toBe(metadata.historyMutationRevision);
    expect(next.conversationEntityGeneration).toBe(12);
  }
});

test("history admission rejects retired generations, anchors and sources while allowing text changes", () => {
  const before = fixture();
  const turn = residentConversationTurns(before)[0]!;
  const ref = createCodexConversationHistoryTurnItemsRef({
    turnId: turn.turnId!,
    expectedTopologyGeneration: before.turnHistory!.history.generation,
    pagination: turn.itemsPagination!,
  })!;
  expect(isCodexConversationHistoryTurnItemsRefCurrent(before, ref)).toBe(true);
  const [changed, patches] = produceWithPatches(before, (draft) => {
    conversationTurnDraft(
      draft,
      residentConversationTurnEntries(draft)[0]!.address,
    )!.itemsPagination!.olderItemId = "new-anchor";
  });
  const metadata = projectCanonicalHistoryPresentation(before);
  const next = projectCanonicalHistoryPresentation(
    changed,
    { ...metadata, canonicalState: before },
    patches,
  );
  expect(next.historyRows).toBe(metadata.historyRows);
  expect(next.turnItemsPaginationById).not.toBe(metadata.turnItemsPaginationById);
  expect(next.historyMutationRevision).toBe(metadata.historyMutationRevision! + 1);
  expect(isCodexConversationHistoryTurnItemsRefCurrent(changed, ref)).toBe(false);
  expect(
    isCodexConversationHistoryTurnItemsRefCurrent(
      produce(before, (draft) => {
        draft.turnHistory!.history.generation += 1;
      }),
      ref,
    ),
  ).toBe(false);
  expect(
    isCodexConversationHistoryTurnItemsRefCurrent(
      produce(before, (draft) => {
        conversationTurnDraft(
          draft,
          residentConversationTurnEntries(draft)[0]!.address,
        )!.itemsPagination!.source = "timeline";
      }),
      ref,
    ),
  ).toBe(false);
  const empty = produce(before, (draft) => {
    const current = conversationTurnDraft(
      draft,
      residentConversationTurnEntries(draft)[0]!.address,
    )!;
    current.items = [];
    delete current.itemsPagination!.olderItemId;
  });
  const emptyTurn = residentConversationTurns(empty)[0]!;
  const emptyRef = createCodexConversationHistoryTurnItemsRef({
    turnId: emptyTurn.turnId!,
    expectedTopologyGeneration: ref.expectedTopologyGeneration,
    pagination: emptyTurn.itemsPagination!,
  })!;
  expect(isCodexConversationHistoryTurnItemsRefCurrent(empty, emptyRef)).toBe(true);
  expect(isCodexConversationHistoryTurnItemsRefCurrent(empty, { ...emptyRef, edge: "newer" })).toBe(
    false,
  );
});
