import type { Thread, ThreadGoal, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import type { CodexConversationSnapshot } from "../../../shared/types";
import { CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID } from "../../../shared/codex-conversation-state/codex-conversation-reducer";
import {
  createCodexCanonicalConversationState,
  createCodexCanonicalHydratedConversationState,
} from "../../../shared/codex-conversation-state/codex-conversation-state";
import {
  flattenCodexHistoryTopology,
  opaqueCodexHistoryBoundary,
} from "../../../shared/codex-conversation-state/codex-history-topology";
import { createCodexQueuedFollowUp } from "../../../shared/codex-queued-follow-up-state";
import type { CodexConversationHistoryItemWindowSnapshot } from "../../../shared/codex-conversation-history-page";
import { makeConversationEntityStateRegistry } from "./ConversationEntityState";
import {
  CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES,
  CODEX_LIVE_TURN_OVERFLOW_ITEM_ID,
} from "../../../shared/codex-conversation-state/codex-live-turn-residency";

const threadId = "thread-canonical-projection";

const thread: Thread = {
  model: null,
  reasoningEffort: null,
  id: threadId,
  extra: null,
  sessionId: "session-canonical-projection",
  forkedFromId: null,
  parentThreadId: null,
  preview: "Canonical projection fixture",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "openai",
  createdAt: 1,
  updatedAt: 2,
  recencyAt: 2,
  status: { type: "idle" },
  path: null,
  cwd: "/workspace/project",
  cliVersion: "fixture",
  source: "unknown",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: "Initial title",
  turns: [],
};

const snapshot = (): CodexConversationSnapshot =>
  ({
    threadId,
    threadName: "Initial title",
    threadPreview: thread.preview,
    cwd: thread.cwd,
    modelProvider: thread.modelProvider,
    resumeState: "resumed",
    turns: [],
    requests: [],
    queuedFollowUps: {
      status: "ready",
      ledgerRevision: 0,
      projectionRevision: 0,
      entries: [],
      inFlightFollowUpId: null,
      editingFollowUpId: null,
      error: null,
    },
    pendingSteers: [],
  }) as unknown as CodexConversationSnapshot;

const goal: ThreadGoal = {
  threadId,
  objective: "Finish the canonical application kernel",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 2,
};

const hydratedState = (turns: readonly Turn[]) =>
  createCodexCanonicalHydratedConversationState(
    { ...thread, turns: [...turns] },
    {
      model: "gpt-test",
      reasoningEffort: "high",
      cwd: "/workspace/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace/project"],
    },
  );

const completedTurn = (id: string): Turn => ({
  id,
  items: [],
  itemsView: "full",
  status: "completed",
  error: null,
  startedAt: null,
  completedAt: null,
  durationMs: null,
});

const commandItem = (id: string): Extract<ThreadItem, { type: "commandExecution" }> => ({
  type: "commandExecution",
  id,
  command: "printf history",
  cwd: "/workspace/project",
  processId: null,
  pluginId: null,
  scriptPath: null,
  source: "agent",
  status: "inProgress",
  commandActions: [],
  aggregatedOutput: null,
  exitCode: null,
  durationMs: null,
});

const snapshotWithCanonicalTurns = (
  state: ReturnType<typeof hydratedState>,
): CodexConversationSnapshot =>
  ({
    ...snapshot(),
    canonicalState: state,
    turns: state.turns.map((turn) => ({
      threadId,
      turnId: turn.protocol.id,
      items: [],
    })),
  }) as unknown as CodexConversationSnapshot;

it("projects semantic canonical mutations into both the snapshot and dormant replica", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  aggregate.acceptCanonicalState(
    createCodexCanonicalConversationState(thread, { turnParamsById: {} }),
  );
  aggregate.acceptReplica({ conversation: snapshot(), revision: 1, ownerEpoch: 0 });

  assert.isTrue(
    aggregate.renameThread({ name: "Canonical title", observedAtMs: 1_000, projectReplica: true }),
  );
  assert.isTrue(
    aggregate.acceptThreadGoal({
      goal,
      appendTranscriptItem: true,
      dismissResumeConfirmation: true,
      projectReplica: true,
    }),
  );
  aggregate.admitManualCompaction({ observedAtMs: 3_000, projectReplica: true });

  const current = aggregate.readSnapshot();
  const replica = aggregate.read().acceptedReplica?.conversation ?? null;
  for (const projected of [current, replica]) {
    assert.strictEqual(projected?.threadName, "Canonical title");
    assert.strictEqual(projected?.threadGoal, goal);
    assert.isTrue(
      projected?.turns.some((turn) =>
        turn.items.some((item) => item.itemId === CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID),
      ),
    );
  }
  const goalInput = aggregate.readCanonicalState()?.turns[0]?.sidecar.params.input[0];
  assert.strictEqual(goalInput?.type === "text" ? goalInput.text : null, `/goal ${goal.objective}`);
  assert.strictEqual(aggregate.read().revision, 4);

  assert.isTrue(aggregate.rollbackManualCompaction({ observedAtMs: 4_000, projectReplica: true }));
  assert.strictEqual(aggregate.readSnapshot()?.turns.length, 1);
  assert.strictEqual(aggregate.read().acceptedReplica?.conversation.turns.length, 1);
});

it("rebases an older owner publication onto the terminal Turn for renderer recovery", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const activeTurn = { ...completedTurn("turn-owner-lag"), status: "inProgress" as const };
  const activeState = hydratedState([activeTurn]);
  const activeSnapshot = snapshotWithCanonicalTurns(activeState);
  aggregate.acceptCanonicalState(activeState);
  aggregate.installSnapshot(activeSnapshot);
  aggregate.acceptReplica({ conversation: activeSnapshot, revision: 1, ownerEpoch: 1 });

  aggregate.commitProtocolNotification({
    notification: {
      method: "turn/completed",
      params: {
        threadId,
        turn: completedTurn(activeTurn.id),
      },
    },
    observedAtMs: 10,
    projectReplica: false,
    createId: () => "00000000-0000-4000-8000-000000000000",
  });
  assert.strictEqual(aggregate.readSnapshot()?.turns[0]?.status, "completed");

  const recovered = aggregate.acceptReplica({
    conversation: activeSnapshot,
    revision: 2,
    ownerEpoch: 1,
  });

  assert.strictEqual(
    aggregate.read().acceptedReplica?.conversation.canonicalState?.turns[0]?.protocol.status,
    "completed",
  );
  assert.strictEqual(recovered.conversation.turns[0]?.status, "completed");
  assert.strictEqual(aggregate.readSnapshot()?.turns[0]?.status, "completed");
  assert.strictEqual(
    aggregate.readSnapshot()?.canonicalState?.turns[0]?.protocol.status,
    "completed",
  );
});

it("invalidates a stale item-window digest before hashing live text and command output", () => {
  const cases = [
    {
      name: "agent text",
      mutate: (
        aggregate: ReturnType<ReturnType<typeof makeConversationEntityStateRegistry>["acquire"]>,
      ) =>
        aggregate.commitFrameTextDeltas({
          updates: [
            {
              conversationId: threadId,
              turnId: "turn-live",
              itemId: "agent-live",
              target: { type: "agentMessage" },
              delta: "live text",
            },
          ],
          observedAtMs: 10,
          projectReplica: true,
        }),
    },
    {
      name: "command output",
      mutate: (
        aggregate: ReturnType<ReturnType<typeof makeConversationEntityStateRegistry>["acquire"]>,
      ) =>
        aggregate.commitCommandOutputDeltas({
          updates: [
            {
              conversationId: threadId,
              turnId: "turn-live",
              itemId: "command-live",
              delta: "command output",
            },
          ],
          observedAtMs: 10,
          projectReplica: true,
        }),
    },
  ] as const;

  for (const mutationCase of cases) {
    const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
    const agentItem = {
      questions: null,
      type: "agentMessage",
      id: "agent-live",
      text: "",
      phase: null,
      memoryCitation: null,
      delivery: null,
    } satisfies Extract<ThreadItem, { type: "agentMessage" }>;
    const initialState = hydratedState([
      { ...completedTurn("turn-live"), items: [agentItem, commandItem("command-live")] },
    ]);
    aggregate.acceptCanonicalState(initialState);
    const canonicalItems = initialState.turns[0]!.items;
    const itemWindow: CodexConversationHistoryItemWindowSnapshot = {
      turnId: "turn-live",
      limits: { maxItems: 500, maxApproximateBytes: 8 * 1024 * 1024 },
      olderBoundary: { status: "exhausted" },
      newerBoundary: { status: "exhausted" },
      segments: [
        {
          segmentId: `resident:${mutationCase.name}`,
          turnId: "turn-live",
          olderCursor: null,
          newerCursor: null,
          items: {
            itemIds: canonicalItems.map((item) => item.id),
            canonicalItems,
            rendererItems: [],
          },
          approximateBytes: 1,
        },
      ],
    };
    const installed = {
      ...snapshotWithCanonicalTurns(initialState),
      historyItemWindowsByTurnId: { "turn-live": itemWindow },
    };
    aggregate.installSnapshot(installed);
    const before = aggregate.acceptReplica({ conversation: installed, revision: 1, ownerEpoch: 1 });

    mutationCase.mutate(aggregate);

    const after = aggregate.read().acceptedReplica;
    assert.isNotNull(after);
    assert.notStrictEqual(after?.checkpoint.canonicalHash, before.checkpoint.canonicalHash);
    assert.isUndefined(after?.conversation.historyItemWindowsByTurnId?.["turn-live"]);
    assert.isUndefined(aggregate.readSnapshot()?.historyItemWindowsByTurnId?.["turn-live"]);
  }
});

it("bounds cumulative live deltas in canonical state, snapshots, and dormant replicas", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const liveTurn: Turn = {
    ...completedTurn("turn-live-overflow"),
    status: "inProgress",
    items: [
      {
        questions: null,
        type: "agentMessage",
        id: "agent-live-overflow",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
      },
    ],
  };
  const initial = hydratedState([liveTurn]);
  const installed = snapshotWithCanonicalTurns(initial);
  aggregate.acceptCanonicalState(initial);
  aggregate.installSnapshot(installed);
  aggregate.acceptReplica({ conversation: installed, revision: 1, ownerEpoch: 1 });

  aggregate.commitFrameTextDeltas({
    updates: [
      {
        conversationId: threadId,
        turnId: liveTurn.id,
        itemId: "agent-live-overflow",
        target: { type: "agentMessage" },
        delta: "x".repeat(CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES + 1_024),
      },
    ],
    observedAtMs: 10,
    projectReplica: true,
  });
  aggregate.commitFrameTextDeltas({
    updates: [
      {
        conversationId: threadId,
        turnId: liveTurn.id,
        itemId: CODEX_LIVE_TURN_OVERFLOW_ITEM_ID,
        target: { type: "agentMessage" },
        delta: "y".repeat(CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES + 1_024),
      },
    ],
    observedAtMs: 11,
    projectReplica: true,
  });

  const projections = [
    aggregate.readCanonicalState(),
    aggregate.readSnapshot()?.canonicalState,
    aggregate.read().acceptedReplica?.conversation.canonicalState,
  ];
  for (const projection of projections) {
    const turn = projection?.turns[0];
    assert.strictEqual(turn?.items[0]?.id, CODEX_LIVE_TURN_OVERFLOW_ITEM_ID);
    assert.isAtMost(
      Buffer.byteLength(JSON.stringify(turn), "utf8"),
      CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES,
    );
  }
});

it("prevents a terminal item payload from restoring oversized live output", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const liveTurn: Turn = {
    ...completedTurn("turn-terminal-overflow"),
    status: "inProgress",
    items: [
      {
        questions: null,
        type: "agentMessage",
        id: "agent-terminal-overflow",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
      },
    ],
  };
  const initial = hydratedState([liveTurn]);
  aggregate.acceptCanonicalState(initial);
  aggregate.installSnapshot(snapshotWithCanonicalTurns(initial));

  aggregate.commitProtocolNotification({
    notification: {
      method: "item/completed",
      params: {
        threadId,
        turnId: liveTurn.id,
        item: {
          questions: null,
          type: "agentMessage",
          id: "agent-terminal-overflow",
          text: "z".repeat(CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES + 1_024),
          phase: null,
          memoryCitation: null,
          delivery: null,
        },
        completedAtMs: 12,
      },
    },
    observedAtMs: 12,
    projectReplica: true,
    createId: () => "00000000-0000-4000-8000-000000000000",
  });

  const turn = aggregate.readCanonicalState()?.turns[0];
  assert.strictEqual(turn?.items[0]?.id, CODEX_LIVE_TURN_OVERFLOW_ITEM_ID);
  assert.isAtMost(
    Buffer.byteLength(JSON.stringify(turn), "utf8"),
    CODEX_LIVE_TURN_MAX_APPROXIMATE_BYTES,
  );
});

it("invalidates generation-bound renderer checkpoints when the endpoint is lost", () => {
  const registry = makeConversationEntityStateRegistry();
  const aggregate = registry.acquire(threadId);
  aggregate.installSnapshot(snapshot());
  aggregate.acceptReplica({ conversation: snapshot(), revision: 4, ownerEpoch: 2 });
  aggregate.setStreamRole("owner");
  aggregate.setStreaming(true);

  assert.deepEqual(registry.markAllNeedsResume(), [threadId]);
  const state = aggregate.read();
  assert.strictEqual(state.resumeState, "needs_resume");
  assert.strictEqual(state.streamRole, null);
  assert.isFalse(state.isStreaming);
  assert.strictEqual(state.acceptedReplica, null);
  assert.strictEqual(state.revision, 0);
  assert.strictEqual(state.checkpoint, null);
  assert.strictEqual(aggregate.readSnapshot()?.resumeState, "needs_resume");
});

it("installs exact Main queue projections without trusting the renderer replica", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  aggregate.acceptReplica({ conversation: snapshot(), revision: 4, ownerEpoch: 2 });
  const row = createCodexQueuedFollowUp({
    followUpId: "follow-up-1",
    clientUserMessageId: "client-follow-up-1",
    threadId,
    prompt: "Preserve the exact projection.",
    createdAtMs: 5,
  });
  const projection = {
    status: "error" as const,
    ledgerRevision: 9,
    projectionRevision: 12,
    entries: [row],
    inFlightFollowUpId: row.followUpId,
    editingFollowUpId: row.followUpId,
    error: "Awaiting retry",
  };

  assert.isTrue(aggregate.installQueuedFollowUpProjection(projection, true));
  assert.deepEqual(aggregate.readQueuedFollowUpProjection(), projection);
  assert.deepEqual(aggregate.readSnapshot()?.queuedFollowUps, projection);
  assert.deepEqual(aggregate.read().acceptedReplica?.conversation.queuedFollowUps, projection);
  assert.strictEqual(aggregate.read().revision, 5);
  assert.isFalse(aggregate.installQueuedFollowUpProjection(projection, true));

  aggregate.acceptReplica({
    conversation: {
      ...snapshot(),
      queuedFollowUps: {
        status: "ready",
        ledgerRevision: 99,
        projectionRevision: 99,
        entries: [],
        inFlightFollowUpId: null,
        editingFollowUpId: null,
        error: null,
      },
    },
    revision: 6,
    ownerEpoch: 2,
  });
  assert.deepEqual(aggregate.read().acceptedReplica?.conversation.queuedFollowUps, projection);
});

it("owns a bounded sparse history topology with an explicit older gap", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const hydratedThread: Thread = {
    ...thread,
    turns: [
      {
        id: "turn-tail",
        items: [],
        itemsView: "full",
        status: "completed",
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    ],
  };
  aggregate.acceptCanonicalState(
    createCodexCanonicalHydratedConversationState(hydratedThread, {
      model: "gpt-test",
      reasoningEffort: "high",
      cwd: "/workspace/project",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      activePermissionProfile: null,
      runtimeWorkspaceRoots: ["/workspace/project"],
    }),
  );
  aggregate.initializeHistory(
    {
      olderCursor: "turns:older",
      backwardsCursor: null,
      oldestLoadedTurnId: "turn-tail",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 1,
      itemsView: "full",
    },
    1,
  );

  const topology = aggregate.readHistoryTopology();
  assert.strictEqual(topology.isComplete, false);
  assert.strictEqual(topology.residency.turnCount, 1);
  assert.strictEqual(topology.residency.itemCount, 0);
  assert.isAbove(topology.residency.approximateBytes, 0);
  assert.deepEqual(
    flattenCodexHistoryTopology(topology).map((row) => row.kind),
    ["gap", "content"],
  );
});

it("atomically preserves a sparse search island across later live canonical updates", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const tailTurn = { ...completedTurn("turn-tail"), durationMs: 25 };
  const initialState = hydratedState([tailTurn]);
  aggregate.acceptCanonicalState(initialState);
  aggregate.installSnapshot(snapshotWithCanonicalTurns(initialState));
  aggregate.initializeHistory(
    {
      olderCursor: "turns:older",
      backwardsCursor: null,
      oldestLoadedTurnId: tailTurn.id,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 1,
      itemsView: "full",
    },
    1,
  );

  const topologyGeneration = aggregate.readHistoryTopology().generation;
  const oldTurn = completedTurn("turn-search-old");
  const inserted = aggregate.insertHistoryIsland({
    mutationId: "search:occurrence-1",
    expectedTopologyGeneration: topologyGeneration,
    index: 0,
    islandId: "search:occurrence-1",
    state: hydratedState([oldTurn, completedTurn(tailTurn.id)]),
    turnIds: [oldTurn.id],
    itemsPaginationByTurnId: {},
    olderBoundary: opaqueCodexHistoryBoundary("search:occurrence-1:older"),
    newerBoundary: opaqueCodexHistoryBoundary("search:occurrence-1:newer"),
    observedAtMs: 10,
    projectReplica: false,
  });

  assert.strictEqual(inserted.status, "committed");
  if (inserted.status === "committed") {
    assert.strictEqual(inserted.topologyGeneration, topologyGeneration);
  }
  assert.strictEqual(
    aggregate.readCanonicalState()?.turns.find((turn) => turn.protocol.id === tailTurn.id)?.protocol
      .durationMs,
    25,
  );
  assert.deepEqual(
    flattenCodexHistoryTopology(aggregate.readHistoryTopology())
      .filter((row) => row.kind === "content")
      .map((row) => ({ turnKey: row.turnKey, entityKey: row.entityKey })),
    [
      { turnKey: oldTurn.id, entityKey: oldTurn.id },
      { turnKey: tailTurn.id, entityKey: tailTurn.id },
    ],
  );

  const liveTail = { ...tailTurn, durationMs: 50 };
  aggregate.acceptCanonicalState(hydratedState([liveTail]));
  const current = aggregate.readHistoryTopology();
  assert.deepEqual(
    current.islands.map((island) => island.id),
    ["search:occurrence-1", `tail:${topologyGeneration}`],
  );
  assert.strictEqual(current.entitiesByKey[oldTurn.id]?.authority, "history");
  assert.strictEqual(current.entitiesByKey[tailTurn.id]?.authority, "live");
  assert.deepEqual(
    aggregate
      .readCanonicalState()
      ?.turns.flatMap((turn) => (turn.protocol.id === null ? [] : [turn.protocol.id])),
    [oldTurn.id, tailTurn.id],
  );
});

it("rejects a search island from a stale topology generation without mutation", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const tailTurn = completedTurn("turn-tail");
  aggregate.acceptCanonicalState(hydratedState([tailTurn]));
  aggregate.initializeHistory(
    {
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: tailTurn.id,
      isLoadingOlder: false,
      hasLoadedOldest: true,
      loadedTurnCount: 1,
      itemsView: "full",
    },
    1,
  );
  const before = aggregate.readHistoryTopology();
  assert.deepEqual(
    aggregate.insertHistoryIsland({
      mutationId: "search:stale",
      expectedTopologyGeneration: before.generation - 1,
      index: 0,
      islandId: "search:stale",
      state: hydratedState([completedTurn("turn-old"), tailTurn]),
      turnIds: ["turn-old"],
      itemsPaginationByTurnId: {},
      olderBoundary: opaqueCodexHistoryBoundary("search:stale:older"),
      newerBoundary: opaqueCodexHistoryBoundary("search:stale:newer"),
      observedAtMs: 10,
      projectReplica: false,
    }),
    { status: "staleGeneration" },
  );
  assert.strictEqual(aggregate.readHistoryTopology(), before);
});

it("bounds every resident conversation object graph while preserving a null-id live Turn", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire("thread-residency-count");
  const turns = Array.from({ length: 105 }, (_, index) => completedTurn(`turn-${index + 1}`));
  const hydrated = hydratedState(turns);
  const optimistic = {
    ...hydrated.turns.at(-1)!,
    protocol: { ...hydrated.turns.at(-1)!.protocol, id: null },
  };
  const state = { ...hydrated, turns: [...hydrated.turns, optimistic] };
  const turnItemsPaginationById = Object.fromEntries(
    turns.map((turn) => [
      turn.id,
      {
        olderCursor: null,
        isLoadingOlder: false,
        hasLoadedOldest: true,
        oldestUserInput: null,
        openingUserMessageId: null,
        itemsView: "full" as const,
      },
    ]),
  );
  aggregate.initializeHistory(
    {
      olderCursor: null,
      backwardsCursor: "cursor:newer",
      oldestLoadedTurnId: turns[0]!.id,
      isLoadingOlder: false,
      hasLoadedOldest: true,
      loadedTurnCount: turns.length,
      itemsView: "full",
    },
    turns.length,
    turnItemsPaginationById,
  );
  const fullSnapshot = {
    ...snapshotWithCanonicalTurns(state),
    turnItemsPaginationById,
  };
  aggregate.installSnapshot(fullSnapshot);
  const initialReplica = aggregate.acceptReplica({
    conversation: fullSnapshot,
    revision: 1,
    ownerEpoch: 3,
  });

  aggregate.acceptCanonicalState(state);
  aggregate.advanceReplica({
    conversation: aggregate.readSnapshot()!,
    ownerEpoch: initialReplica.checkpoint.ownerEpoch,
  });

  const expectedResidentIds = turns.slice(-100).map((turn) => turn.id);
  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey), expectedResidentIds);
  assert.strictEqual(aggregate.readHistoryTopology().residency.turnCount, 100);
  assert.strictEqual(aggregate.readTurnPagination().backwardsCursor, null);
  assert.deepEqual(Object.keys(aggregate.readAllTurnItemsPagination()), expectedResidentIds);
  for (const projected of [
    aggregate.readCanonicalState(),
    aggregate.readSnapshot()?.canonicalState,
    aggregate.read().acceptedReplica?.conversation.canonicalState,
  ]) {
    assert.deepEqual(
      projected?.turns.flatMap((turn) => (turn.protocol.id === null ? [null] : [turn.protocol.id])),
      [...expectedResidentIds, null],
    );
  }
  for (const projected of [
    aggregate.readSnapshot(),
    aggregate.read().acceptedReplica?.conversation,
  ]) {
    assert.deepEqual(
      projected?.turns.map((turn) => turn.turnId),
      [...expectedResidentIds, null],
    );
  }
  assert.notStrictEqual(
    aggregate.read().acceptedReplica?.checkpoint.canonicalHash,
    initialReplica.checkpoint.canonicalHash,
  );
  assert.strictEqual(aggregate.read().revision, 2);
});

it("uses the byte budget independently from the Turn-count budget", () => {
  const aggregate = makeConversationEntityStateRegistry({
    historyResidencyLimits: { maxTurns: 100, maxApproximateBytes: 1 },
    historyTailTurnCount: 1,
  }).acquire("thread-residency-bytes");
  const turns = [completedTurn("turn-1"), completedTurn("turn-2"), completedTurn("turn-3")];

  aggregate.acceptCanonicalState(hydratedState(turns));

  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey), ["turn-3"]);
  assert.isAbove(aggregate.readHistoryTopology().residency.approximateBytes, 1);
  assert.deepEqual(
    aggregate
      .readCanonicalState()
      ?.turns.flatMap((turn) => (turn.protocol.id === null ? [] : [turn.protocol.id])),
    ["turn-3"],
  );
});

it("keeps the just-revealed older page resident beside the bounded tail", () => {
  const aggregate = makeConversationEntityStateRegistry({
    historyResidencyLimits: { maxTurns: 3, maxApproximateBytes: 1024 * 1024 },
    historyTailTurnCount: 1,
  }).acquire("thread-residency-revealed-page");
  const initialTurns = [completedTurn("turn-4"), completedTurn("turn-5"), completedTurn("turn-6")];
  aggregate.acceptCanonicalState(hydratedState(initialTurns));
  aggregate.initializeHistory(
    {
      olderCursor: "cursor:3",
      backwardsCursor: null,
      oldestLoadedTurnId: "turn-4",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 3,
      itemsView: "full",
    },
    3,
  );
  const fence = aggregate.beginHistoryLoad(3);
  assert.isNotNull(fence);
  const revealedTurns = [completedTurn("turn-1"), completedTurn("turn-2"), completedTurn("turn-3")];

  assert.isTrue(
    aggregate.commitHistoryProjection({
      fence: fence!,
      state: hydratedState([...revealedTurns, ...initialTurns]),
      pagination: {
        olderCursor: "cursor:1",
        backwardsCursor: null,
        oldestLoadedTurnId: "turn-1",
        isLoadingOlder: false,
        hasLoadedOldest: false,
        loadedTurnCount: 6,
        itemsView: "full",
      },
      loadedTurnCount: 6,
      observedAtMs: 1,
      projectReplica: false,
    }),
  );
  assert.deepEqual(
    flattenCodexHistoryTopology(aggregate.readHistoryTopology()).flatMap((row) =>
      row.kind === "content" ? [row.entityKey] : [],
    ),
    ["turn-1", "turn-2", "turn-3", "turn-6"],
  );
  assert.deepEqual(
    aggregate
      .readCanonicalState()
      ?.turns.flatMap((turn) => (turn.protocol.id === null ? [] : [turn.protocol.id])),
    ["turn-1", "turn-2", "turn-3", "turn-6"],
  );
  const generation = aggregate.readHistoryTopology().generation;
  assert.deepEqual(
    aggregate.setHistoryResidencyPins({
      clientId: "test-client",
      expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
      expectedTopologyGeneration: generation,
      islandIds: [],
      turnIds: ["turn-6"],
    }),
    { status: "applied", evictedTurnIds: [], limitsSatisfied: false },
  );
  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey), [
    "turn-1",
    "turn-2",
    "turn-3",
    "turn-6",
  ]);
  assert.deepEqual(
    aggregate.setHistoryResidencyPins({
      clientId: "test-client",
      expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
      expectedTopologyGeneration: generation,
      islandIds: [],
      turnIds: ["turn-1", "turn-2", "turn-3"],
    }),
    { status: "applied", evictedTurnIds: ["turn-3"], limitsSatisfied: true },
  );
  assert.deepEqual(
    aggregate.setHistoryResidencyPins({
      clientId: "test-client",
      expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
      expectedTopologyGeneration: generation,
      islandIds: [],
      turnIds: ["turn-1"],
    }),
    { status: "applied", evictedTurnIds: [], limitsSatisfied: true },
  );
});

it("protects the current search island until explicit viewport pins supersede it", () => {
  const aggregate = makeConversationEntityStateRegistry({
    historyResidencyLimits: { maxTurns: 1, maxApproximateBytes: 1024 * 1024 },
    historyTailTurnCount: 1,
  }).acquire("thread-residency-search");
  const tailTurn = completedTurn("turn-tail");
  const initialState = hydratedState([tailTurn]);
  aggregate.acceptCanonicalState(initialState);
  aggregate.installSnapshot(snapshotWithCanonicalTurns(initialState));
  aggregate.initializeHistory(
    {
      olderCursor: "turns:older",
      backwardsCursor: null,
      oldestLoadedTurnId: tailTurn.id,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 1,
      itemsView: "full",
    },
    1,
  );
  const generation = aggregate.readHistoryTopology().generation;
  const searchTurn = completedTurn("turn-search");

  const inserted = aggregate.insertHistoryIsland({
    mutationId: "search:visible",
    expectedTopologyGeneration: generation,
    index: 0,
    islandId: "search:visible",
    state: hydratedState([searchTurn, tailTurn]),
    turnIds: [searchTurn.id],
    itemsPaginationByTurnId: {},
    olderBoundary: opaqueCodexHistoryBoundary("search:visible:older"),
    newerBoundary: opaqueCodexHistoryBoundary("search:visible:newer"),
    observedAtMs: 1,
    projectReplica: false,
  });
  assert.strictEqual(inserted.status, "committed");
  if (inserted.status === "committed") {
    assert.strictEqual(inserted.topologyGeneration, generation);
  }
  assert.deepEqual(
    flattenCodexHistoryTopology(aggregate.readHistoryTopology()).flatMap((row) =>
      row.kind === "content" ? [row.entityKey] : [],
    ),
    [searchTurn.id, tailTurn.id],
  );
  assert.deepEqual(
    aggregate.setHistoryResidencyPins({
      clientId: "test-client",
      expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
      expectedTopologyGeneration: generation + 1,
      islandIds: [],
      turnIds: [],
    }),
    { status: "staleGeneration" },
  );
  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey).toSorted(), [
    searchTurn.id,
    tailTurn.id,
  ]);

  assert.deepEqual(
    aggregate.setHistoryResidencyPins({
      clientId: "test-client",
      expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
      expectedTopologyGeneration: generation,
      islandIds: [],
      turnIds: [],
    }),
    { status: "applied", evictedTurnIds: [], limitsSatisfied: false },
  );
  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey).toSorted(), [
    searchTurn.id,
    tailTurn.id,
  ]);
  assert.deepEqual(
    aggregate.setHistoryResidencyPins({
      clientId: "test-client",
      expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
      expectedTopologyGeneration: generation,
      islandIds: [],
      turnIds: [tailTurn.id],
    }),
    { status: "applied", evictedTurnIds: [], limitsSatisfied: false },
  );
  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey).toSorted(), [
    searchTurn.id,
    tailTurn.id,
  ]);
  const handedOff = aggregate.setHistoryResidencyPins({
    clientId: "test-client",
    expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
    expectedTopologyGeneration: generation,
    islandIds: [],
    turnIds: [searchTurn.id],
  });
  assert.strictEqual(handedOff.status, "applied");
  if (handedOff.status === "applied") {
    assert.deepEqual(handedOff.evictedTurnIds, [searchTurn.id]);
    assert.isTrue(handedOff.limitsSatisfied);
    assert.isDefined(handedOff.mutation);
  }
  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey), [tailTurn.id]);
  assert.deepEqual(
    aggregate
      .readCanonicalState()
      ?.turns.flatMap((turn) => (turn.protocol.id === null ? [] : [turn.protocol.id])),
    [tailTurn.id],
  );
});

it("bounds reveal leases by count and bytes until the exact revealed Turn reaches the viewport", () => {
  const aggregate = makeConversationEntityStateRegistry({
    historyResidencyLimits: { maxTurns: 1, maxApproximateBytes: 1024 * 1024 },
    historyTailTurnCount: 1,
    historyRevealLeaseLimits: { maxTurns: 32, maxApproximateBytes: 1 },
  }).acquire(threadId);
  const tail = completedTurn("turn-tail");
  const initial = hydratedState([tail]);
  aggregate.acceptCanonicalState(initial);
  aggregate.installSnapshot(snapshotWithCanonicalTurns(initial));
  aggregate.initializeHistory(
    {
      olderCursor: "turns:older",
      backwardsCursor: null,
      oldestLoadedTurnId: tail.id,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 1,
      itemsView: "full",
    },
    1,
  );
  const generation = aggregate.readHistoryTopology().generation;
  const first = completedTurn("turn-reveal-1");
  const second = completedTurn("turn-reveal-2");
  const insertReveal = (turn: Turn, turns: readonly Turn[]) =>
    aggregate.insertHistoryIsland({
      mutationId: `page-reveal:${turn.id}`,
      expectedTopologyGeneration: generation,
      index: 0,
      islandId: `page-reveal:${turn.id}`,
      state: hydratedState(turns),
      turnIds: [turn.id],
      itemsPaginationByTurnId: {},
      olderBoundary: opaqueCodexHistoryBoundary(`page-reveal:${turn.id}:older`),
      newerBoundary: opaqueCodexHistoryBoundary(`page-reveal:${turn.id}:newer`),
      observedAtMs: 1,
      projectReplica: false,
    });

  assert.strictEqual(insertReveal(first, [first, tail]).status, "committed");
  assert.strictEqual(insertReveal(second, [second, first, tail]).status, "committed");
  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey).toSorted(), [
    second.id,
    tail.id,
  ]);

  const tailOnly = aggregate.setHistoryResidencyPins({
    clientId: "test-client",
    expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
    expectedTopologyGeneration: generation,
    islandIds: [],
    turnIds: [tail.id],
  });
  assert.deepEqual(tailOnly, { status: "applied", evictedTurnIds: [], limitsSatisfied: false });
  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey).toSorted(), [
    second.id,
    tail.id,
  ]);

  const visibleReveal = aggregate.setHistoryResidencyPins({
    clientId: "test-client",
    expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
    expectedTopologyGeneration: generation,
    islandIds: [],
    turnIds: [second.id],
  });
  assert.strictEqual(visibleReveal.status, "applied");
  if (visibleReveal.status === "applied") {
    assert.deepEqual(visibleReveal.evictedTurnIds, [second.id]);
    assert.isTrue(visibleReveal.limitsSatisfied);
  }
  const handedOff = aggregate.setHistoryResidencyPins({
    clientId: "test-client",
    expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
    expectedTopologyGeneration: generation,
    islandIds: [],
    turnIds: [tail.id],
  });
  assert.strictEqual(handedOff.status, "applied");
  if (handedOff.status === "applied") {
    assert.deepEqual(handedOff.evictedTurnIds, []);
    assert.isTrue(handedOff.limitsSatisfied);
  }
  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey), [tail.id]);
});

it("drops viewport pins when a replacement history topology generation is initialized", () => {
  const aggregate = makeConversationEntityStateRegistry({
    historyResidencyLimits: { maxTurns: 2, maxApproximateBytes: 1024 * 1024 },
    historyTailTurnCount: 1,
  }).acquire("thread-residency-generation-pins");
  const first = completedTurn("turn-1");
  const second = completedTurn("turn-2");
  const pagination = {
    olderCursor: "turns:older",
    backwardsCursor: null,
    oldestLoadedTurnId: first.id,
    isLoadingOlder: false,
    hasLoadedOldest: false,
    loadedTurnCount: 2,
    itemsView: "full" as const,
  };
  const initialState = hydratedState([first, second]);
  aggregate.acceptCanonicalState(initialState);
  aggregate.installSnapshot(snapshotWithCanonicalTurns(initialState));
  aggregate.initializeHistory(pagination, 2);
  const generation = aggregate.readHistoryTopology().generation;
  assert.deepEqual(
    aggregate.setHistoryResidencyPins({
      clientId: "test-client",
      expectedHistoryMutationRevision: aggregate.read().historyMutationRevision,
      expectedTopologyGeneration: generation,
      islandIds: [],
      turnIds: [first.id],
    }),
    { status: "applied", evictedTurnIds: [], limitsSatisfied: true },
  );

  aggregate.initializeHistory(pagination, 2);
  aggregate.acceptCanonicalState(hydratedState([first, second, completedTurn("turn-3")]));

  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey), [
    second.id,
    "turn-3",
  ]);
  assert.strictEqual(
    aggregate.readSnapshot()?.historyTopologyGeneration,
    aggregate.readHistoryTopology().generation,
  );
});

it("replaces stale client viewport pins before a new owner grows resident history", () => {
  const aggregate = makeConversationEntityStateRegistry({
    historyResidencyLimits: { maxTurns: 2, maxApproximateBytes: 1024 * 1024 },
    historyTailTurnCount: 1,
  }).acquire("thread-residency-owner-handoff");
  const first = completedTurn("turn-1");
  const second = completedTurn("turn-2");
  const initial = hydratedState([first, second]);
  aggregate.acceptCanonicalState(initial);
  aggregate.installSnapshot(snapshotWithCanonicalTurns(initial));
  aggregate.initializeHistory(
    {
      olderCursor: "turns:older",
      backwardsCursor: null,
      oldestLoadedTurnId: first.id,
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 2,
      itemsView: "full",
    },
    2,
  );
  const generation = aggregate.readHistoryTopology().generation;
  const mutationRevision = aggregate.read().historyMutationRevision;

  assert.strictEqual(
    aggregate.setHistoryResidencyPins({
      clientId: "owner-a",
      expectedHistoryMutationRevision: mutationRevision,
      expectedTopologyGeneration: generation,
      islandIds: [],
      turnIds: [first.id],
    }).status,
    "applied",
  );
  assert.strictEqual(
    aggregate.setHistoryResidencyPins({
      clientId: "owner-b",
      expectedHistoryMutationRevision: mutationRevision,
      expectedTopologyGeneration: generation,
      islandIds: [],
      turnIds: [second.id],
    }).status,
    "applied",
  );

  aggregate.acceptCanonicalState(hydratedState([first, second, completedTurn("turn-3")]));

  assert.deepEqual(Object.keys(aggregate.readHistoryTopology().entitiesByKey), [
    second.id,
    "turn-3",
  ]);
  assert.isAtMost(aggregate.readHistoryTopology().residency.turnCount, 2);
});
