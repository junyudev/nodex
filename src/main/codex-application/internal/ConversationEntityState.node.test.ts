import {
  residentConversationTurns,
  residentConversationTurnEntries,
  conversationTurnDraft,
} from "../../../shared/codex-conversation-state/codex-turn-mutation";
import { applyPatches, produce } from "immer";
import type { CodexPreparedTurnExecution } from "../../../shared/codex-conversation-state/codex-turn-execution";
import { CodexConversationEntityDocument } from "../../../shared/codex-conversation-entity-document";
import { measureCodexHistoryResidency } from "../../../shared/codex-conversation-state/codex-history-topology";
import { compactCodexApplicationProtocolOccurrences } from "../CodexConversationEventProjection";
import type { CodexApplicationNotificationOccurrence } from "../../codex-runtime/CodexApplicationRequestInbox";
import type { Thread, ThreadGoal, ThreadItem, Turn } from "@nodex/codex-app-server-protocol/v2";
import { assert, it } from "@effect/vitest";
import type { CodexConversationSnapshot } from "../../../shared/types";
import { CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID } from "../../../shared/codex-conversation-state/codex-conversation-reducer";
import {
  createCodexCanonicalConversationState,
  createCodexCanonicalHydratedConversationState,
} from "../../../shared/codex-conversation-state/codex-conversation-state";
import {
  exhaustedCodexHistoryBoundary,
  flattenCodexHistoryTopology,
  opaqueCodexHistoryBoundary,
} from "../../../shared/codex-conversation-state/codex-history-topology";
import { createCodexQueuedFollowUp } from "../../../shared/codex-queued-follow-up-state";
import { makeConversationEntityStateRegistry } from "./ConversationEntityState";
import { projectCodexConversationSnapshot } from "../CodexConversationSnapshotProjection";
import {
  codexHostMessageParts,
  CodexHostMessageReceiver,
} from "../../../shared/codex-host-chunked-message";

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

const hydratedState = (
  turns: readonly Turn[],
  turnItemsPaginationById?: Parameters<
    typeof createCodexCanonicalHydratedConversationState
  >[1]["turnItemsPaginationById"],
) =>
  createCodexCanonicalHydratedConversationState(
    { ...thread, turns: [...turns] },
    {
      hostId: "local",
      ...{
        model: "gpt-test",
        reasoningEffort: "high",
        cwd: "/workspace/project",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace/project"],
        turnItemsPaginationById,
      },
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

it("reads resume readiness from the received owner document through successive snapshots", () => {
  const entity = makeConversationEntityStateRegistry().acquire(threadId);
  entity.installSnapshot(snapshot());
  entity.setResumeState("needs_resume");
  for (const resumeState of ["resumed", "resuming", "needs_resume", "resumed"] as const) {
    entity.installFollowerCanonicalState({ ...hydratedState([]), resumeState });
    assert.strictEqual(entity.readResumeState(), resumeState);
    assert.strictEqual(entity.read().resumeState, resumeState);
    assert.strictEqual(entity.readSnapshot()?.resumeState, resumeState);
  }
});

it("reports retirement only for the released generation after removing its authority", () => {
  const registry = makeConversationEntityStateRegistry();
  const first = registry.acquire(threadId);
  const observed: number[] = [];
  const listener = registry.subscribeRetired((id, generation) => {
    assert.strictEqual(id, threadId);
    assert.isNull(registry.current(id));
    observed.push(generation);
  });
  registry.releaseGeneration(threadId, first.generation);
  const replacement = registry.acquire(threadId);
  registry.releaseGeneration(threadId, first.generation);
  assert.strictEqual(registry.current(threadId), replacement);
  assert.deepEqual(observed, [first.generation]);
  listener[Symbol.dispose]();
  registry.releaseAll();
  assert.deepEqual(observed, [first.generation]);
});

it("keeps explicitly incomplete Turn history through live metadata updates without a cursor", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  aggregate.acceptCanonicalState(hydratedState([completedTurn("turn-incomplete")]));
  aggregate.initializeHistory(
    {
      olderCursor: null,
      backwardsCursor: null,
      oldestLoadedTurnId: "turn-incomplete",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      loadedTurnCount: 1,
      itemsView: "full",
    },
    1,
  );
  assert.isFalse(aggregate.readHistoryTopology().isComplete);
  aggregate.commitProtocolNotification({
    notification: { method: "thread/name/updated", params: { threadId, threadName: "New title" } },
    observedAtMs: 3000,
    createId: () => "00000000-0000-4000-8000-000000000000",
  });
  assert.isFalse(aggregate.readHistoryTopology().isComplete);
});

const commandItem = (
  id: string,
): Extract<
  ThreadItem,
  {
    type: "commandExecution";
  }
> => ({
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
    turns: residentConversationTurns(state).map((turn) => ({
      threadId,
      turnId: turn.turnId,
      items: [],
    })),
  }) as unknown as CodexConversationSnapshot;

it("delivers a completed canonical Turn projection without undefined fields", () => {
  const state = hydratedState([
    {
      ...completedTurn("turn-boot"),
      items: [
        {
          type: "agentMessage",
          id: "answer-boot",
          text: "BOOT_OK",
          phase: "final_answer",
          memoryCitation: null,
          delivery: null,
          questions: null,
        },
      ],
    },
  ]);
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  aggregate.acceptCanonicalState(state);
  aggregate.installSnapshot(
    projectCodexConversationSnapshot({
      conversation: snapshot(),
      before: null,
      after: state,
      observedAtMs: 10,
    }),
  );
  const message = aggregate.readSnapshot()!;
  const receiver = new CodexHostMessageReceiver();
  let received: unknown = null;
  for (const part of codexHostMessageParts(message, { transferId: "follower-boot" })) {
    const transition = receiver.receive(part);
    if (transition.type === "complete") received = transition.message;
  }
  assert.deepEqual(received, message);
  assert.strictEqual(message.turns[0]?.items[0]?.markdownText, "BOOT_OK");
  assert.notProperty(message.turns[0], "errorMessage");
});

it("keeps request ownership independent of history and isolates retained reducer views", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const request = {
    id: "request-before-history",
    method: "item/tool/requestOptionPicker" as const,
    params: { threadId, turnId: "turn", question: "Choose", options: [{ label: "Continue" }] },
  };
  aggregate.replaceServerRequests([request]);
  aggregate.seedHasUnreadTurn(true);
  assert.isNull(aggregate.readCanonicalState());
  assert.deepEqual(aggregate.readServerRequests(), [request]);
  assert.isTrue(aggregate.readHasUnreadTurn());

  const history = hydratedState([]);
  aggregate.acceptCanonicalState({
    ...history,
    requests: aggregate.readServerRequests(),
    hasUnreadTurn: aggregate.readHasUnreadTurn(),
  });
  const retained = aggregate.readCanonicalState();
  aggregate.replaceServerRequests([]);
  aggregate.setHasUnreadTurn(false);
  assert.deepEqual(aggregate.readServerRequests(), []);
  assert.deepEqual(aggregate.readCanonicalState()?.requests, []);
  assert.isFalse(aggregate.readCanonicalState()?.hasUnreadTurn);
  assert.deepEqual(
    residentConversationTurns(aggregate.readCanonicalState()),
    residentConversationTurns(retained),
  );
  assert.deepEqual(retained?.requests, [request]);
  assert.isTrue(retained?.hasUnreadTurn);

  aggregate.reset();
  aggregate.replaceServerRequests([request]);
  aggregate.seedHasUnreadTurn(true);
  aggregate.reset();
  assert.deepEqual(aggregate.readServerRequests(), []);
  assert.isFalse(aggregate.readHasUnreadTurn());
});

it("projects semantic canonical mutations into the current presentation", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  aggregate.acceptCanonicalState(
    createCodexCanonicalConversationState(thread, { hostId: "local", ...{ turnParamsById: {} } }),
  );
  aggregate.installSnapshot(snapshot());

  assert.isTrue(aggregate.renameThread({ name: "Canonical title", observedAtMs: 1000 }));
  assert.isTrue(
    aggregate.acceptThreadGoal({
      goal,
      appendTranscriptItem: true,
      dismissResumeConfirmation: true,
    }),
  );
  aggregate.admitManualCompaction({ observedAtMs: 3000 });
  const current = aggregate.readSnapshot();
  assert.strictEqual(current?.threadName, "Canonical title");
  assert.strictEqual(current?.threadGoal, goal);
  assert.isTrue(
    current?.turns.some((turn) =>
      turn.items.some((item) => item.itemId === CODEX_PENDING_MANUAL_CONTEXT_COMPACTION_ITEM_ID),
    ),
  );
  const goalInput = residentConversationTurns(aggregate.readCanonicalState())[0]?.params.input[0];
  assert.strictEqual(goalInput?.type === "text" ? goalInput.text : null, `/goal ${goal.objective}`);
  assert.isTrue(aggregate.rollbackManualCompaction({ observedAtMs: 4000 }));
  assert.strictEqual(aggregate.readSnapshot()?.turns.length, 1);
});

it("keeps notification-owned goal completion metadata when accepting a command response", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const completedGoal = { ...goal, status: "complete" as const, updatedAt: 1 };
  const confirmation = { ...goal, status: "paused" as const };
  aggregate.acceptCanonicalState({
    ...createCodexCanonicalConversationState(thread, { hostId: "local", turnParamsById: {} }),
    completedThreadGoal: completedGoal,
    threadGoalResumeConfirmation: confirmation,
  });

  aggregate.acceptThreadGoal({
    goal,
    appendTranscriptItem: false,
    dismissResumeConfirmation: false,
  });
  assert.strictEqual(aggregate.readCanonicalState()?.threadGoal, goal);
  assert.strictEqual(aggregate.readCanonicalState()?.completedThreadGoal, completedGoal);
  assert.strictEqual(aggregate.readCanonicalState()?.threadGoalResumeConfirmation, confirmation);

  aggregate.acceptThreadGoal({
    goal: null,
    appendTranscriptItem: false,
    dismissResumeConfirmation: true,
  });
  assert.strictEqual(aggregate.readCanonicalState()?.threadGoal, null);
  assert.strictEqual(aggregate.readCanonicalState()?.completedThreadGoal, completedGoal);
  assert.strictEqual(aggregate.readCanonicalState()?.threadGoalResumeConfirmation, null);
});

it("installs the owner's canonical state without host reconciliation or a local mutation echo", () => {
  const registry = makeConversationEntityStateRegistry();
  const aggregate = registry.acquire(threadId);
  const activeTurn = { ...completedTurn("turn-owner-lag"), status: "inProgress" as const };
  const activeState = hydratedState([activeTurn]);
  const activeSnapshot = snapshotWithCanonicalTurns(activeState);
  aggregate.acceptCanonicalState(activeState);
  aggregate.installSnapshot(activeSnapshot);

  aggregate.commitProtocolNotification({
    notification: {
      method: "turn/completed",
      params: {
        threadId,
        turn: completedTurn(activeTurn.id),
      },
    },
    observedAtMs: 10,
    createId: () => "00000000-0000-4000-8000-000000000000",
  });
  assert.strictEqual(aggregate.readSnapshot()?.turns[0]?.status, "completed");

  const changes: Array<{ origin: string }> = [];
  const subscription = registry.subscribeCanonicalMutations((change) => changes.push(change));
  aggregate.installFollowerCanonicalState(activeState);
  assert.deepEqual(aggregate.readCanonicalState(), activeState);
  assert.strictEqual(aggregate.readSnapshot()?.turns[0]?.status, "inProgress");
  assert.deepEqual(
    changes.map((change) => change.origin),
    ["follower"],
  );
  subscription[Symbol.dispose]();
});

it("reads item pagination directly after a canonical owner mutation", () => {
  const registry = makeConversationEntityStateRegistry();
  const aggregate = registry.acquire(threadId);
  aggregate.acceptCanonicalState(hydratedState([completedTurn("turn-live")]));
  aggregate.mutateCanonicalState((draft) => {
    const entry = residentConversationTurnEntries(draft)[0]!;
    const turn = conversationTurnDraft(draft, entry.address)!;
    turn.itemsPagination = {
      olderCursor: "native-cursor",
      isLoadingOlder: false,
      hasLoadedOldest: false,
      itemsView: "summary",
    };
  }, Date.now());
  assert.strictEqual(aggregate.readTurnItemsPagination("turn-live")?.olderCursor, "native-cursor");
  assert.strictEqual(aggregate.readAllTurnItemsPagination()["turn-live"]?.hasLoadedOldest, false);
});

it("preserves cumulative large live deltas in canonical state and its presentation", () => {
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

  aggregate.commitFrameTextDeltas({
    updates: [
      {
        conversationId: threadId,
        turnId: liveTurn.id,
        itemId: "agent-live-overflow",
        target: { type: "agentMessage" },
        delta: "x".repeat(2 * 1024 * 1024 + 1024),
      },
    ],
    observedAtMs: 10,
  });
  aggregate.commitFrameTextDeltas({
    updates: [
      {
        conversationId: threadId,
        turnId: liveTurn.id,
        itemId: "agent-live-overflow",
        target: { type: "agentMessage" },
        delta: "y".repeat(2 * 1024 * 1024 + 1024),
      },
    ],
    observedAtMs: 11,
  });

  const projections = [aggregate.readCanonicalState(), aggregate.readSnapshot()?.canonicalState];
  for (const projection of projections) {
    const item = residentConversationTurns(projection)[0]?.items[0];
    assert.strictEqual(item?.id, "agent-live-overflow");
    assert.strictEqual(
      item?.type === "agentMessage" ? item.text : null,
      "x".repeat(2 * 1024 * 1024 + 1024) + "y".repeat(2 * 1024 * 1024 + 1024),
    );
  }
});

it("preserves a large terminal item payload in the transcript", () => {
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
          text: "z".repeat(2 * 1024 * 1024 + 1024),
          phase: null,
          memoryCitation: null,
          delivery: null,
        },
        completedAtMs: 12,
      },
    },
    observedAtMs: 12,
    createId: () => "00000000-0000-4000-8000-000000000000",
  });

  const turn = residentConversationTurns(aggregate.readCanonicalState())[0];
  assert.strictEqual(turn?.items[0]?.type, "agentMessage");
  assert.isAbove(Buffer.byteLength(JSON.stringify(turn), "utf8"), 2 * 1024 * 1024);
});

it("releases the stream role and requires resume when the endpoint is lost", () => {
  const registry = makeConversationEntityStateRegistry();
  const aggregate = registry.acquire(threadId);
  aggregate.installSnapshot(snapshot());
  aggregate.setStreamRole("owner");
  aggregate.setStreaming(true);

  assert.deepEqual(registry.markAllNeedsResume(), [threadId]);
  const state = aggregate.read();
  assert.strictEqual(state.resumeState, "needs_resume");
  assert.strictEqual(state.streamRole, null);
  assert.isFalse(state.isStreaming);
  assert.strictEqual(aggregate.readSnapshot()?.resumeState, "needs_resume");
});

it("preserves queue state across presentation replacement", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  aggregate.installSnapshot(snapshot());
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

  assert.isTrue(aggregate.installQueuedFollowUpProjection(projection));
  assert.deepEqual(aggregate.readQueuedFollowUpProjection(), projection);
  assert.deepEqual(aggregate.readSnapshot()?.queuedFollowUps, projection);
  assert.isFalse(aggregate.installQueuedFollowUpProjection(projection));

  aggregate.installSnapshot({
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
  });
  assert.deepEqual(aggregate.readSnapshot()?.queuedFollowUps, projection);
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
      hostId: "local",
      ...{
        model: "gpt-test",
        reasoningEffort: "high",
        cwd: "/workspace/project",
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
        activePermissionProfile: null,
        runtimeWorkspaceRoots: ["/workspace/project"],
      },
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
  assert.strictEqual(measureCodexHistoryResidency(topology).turnCount, 1);
  assert.strictEqual(measureCodexHistoryResidency(topology).itemCount, 0);
  assert.isAbove(measureCodexHistoryResidency(topology).approximateBytes, 0);
  assert.deepEqual(
    flattenCodexHistoryTopology(topology).map((row) => row.kind),
    ["gap", "content"],
  );
});

it("retains all hydrated Turns and pagination alongside a null-id live Turn", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire("thread-residency-count");
  const turns = Array.from({ length: 105 }, (_, index) => completedTurn(`turn-${index + 1}`));
  const hydrated = hydratedState(turns);
  const optimistic = {
    ...hydrated.turns.at(-1)!,
    turnId: null,
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

  aggregate.acceptCanonicalState(state);

  const expectedResidentIds = turns.map((turn) => turn.id);
  assert.deepEqual(
    Object.values(aggregate.readHistoryTopology().entitiesByKey).map((turn) => turn.turnId),
    [...expectedResidentIds, null],
  );
  assert.strictEqual(measureCodexHistoryResidency(aggregate.readHistoryTopology()).turnCount, 106);
  assert.strictEqual(aggregate.readTurnPagination().backwardsCursor, "cursor:newer");
  assert.deepEqual(Object.keys(aggregate.readAllTurnItemsPagination()), expectedResidentIds);
  for (const projected of [
    aggregate.readCanonicalState(),
    aggregate.readSnapshot()?.canonicalState,
  ]) {
    assert.deepEqual(
      residentConversationTurns(projected).flatMap((turn) =>
        turn.turnId === null ? [null] : [turn.turnId],
      ),
      [...expectedResidentIds, null],
    );
  }
  for (const projected of [aggregate.readSnapshot()]) {
    assert.deepEqual(
      projected?.turns.map((turn) => turn.turnId),
      [...expectedResidentIds, null],
    );
  }
});

it("skips command bytes covered by the resume baseline but retains identical live occurrences", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const line = "same\n";
  const command = {
    ...commandItem("exec-output"),
    status: "inProgress" as const,
    aggregatedOutput: line,
  };
  const turn = { ...completedTurn("turn-output"), status: "inProgress" as const, items: [command] };
  aggregate.acceptCanonicalState(hydratedState([turn]));
  const event: CodexApplicationNotificationOccurrence = {
    kind: "notification",
    protocol: "generated",
    hostId: "local",
    generation: 1,
    occurrenceId: "output-occurrence",
    occurrenceToken: 1,
    method: "item/commandExecution/outputDelta",
    params: { threadId, turnId: turn.id, itemId: command.id, delta: line },
  };
  const replay = compactCodexApplicationProtocolOccurrences({
    threadId,
    canonicalState: aggregate.readCanonicalState(),
    events: [event],
  });
  assert.deepStrictEqual(replay, []);
  const update = { conversationId: threadId, turnId: turn.id, itemId: command.id, delta: line };
  aggregate.commitCommandOutputDeltas({
    updates: [update],
    observedAtMs: 10,
  });
  {
    const item = residentConversationTurns(aggregate.readCanonicalState())[0]?.items[0];
    assert.strictEqual(
      item?.type === "commandExecution" ? item.aggregatedOutput : undefined,
      line.repeat(2),
    );
  }

  // The same overlap accounting applies to restored final output; ordinary live deltas
  // remain separate occurrences and are never filtered by their text or command status.
  aggregate.acceptCanonicalState(
    hydratedState([
      {
        ...turn,
        status: "completed",
        items: [{ ...command, status: "completed", aggregatedOutput: line.repeat(2) }],
      },
    ]),
  );
  const covered = compactCodexApplicationProtocolOccurrences({
    threadId,
    canonicalState: aggregate.readCanonicalState(),
    events: [event, { ...event, occurrenceId: "output-second", occurrenceToken: 2 }],
  });
  assert.deepStrictEqual(covered, []);
  {
    const item = residentConversationTurns(aggregate.readCanonicalState())[0]?.items[0];
    assert.strictEqual(
      item?.type === "commandExecution" ? item.aggregatedOutput : undefined,
      line.repeat(2),
    );
  }
});

it("rejects a follower document for another conversation before replacing state", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const before = aggregate.acceptCanonicalState(hydratedState([completedTurn("retained")]));
  assert.throws(
    () => aggregate.installFollowerCanonicalState({ ...before, id: "another-thread" }),
    "Follower document belongs to another conversation",
  );
  assert.strictEqual(aggregate.readCanonicalState(), before);
});

it("keeps raw thread metadata independently of conversation hydration", () => {
  const registry = makeConversationEntityStateRegistry();
  const incoming = { ...thread, name: "Server title" };
  registry.registerThreadMetadata(incoming);
  assert.strictEqual(registry.current(threadId), null);
  assert.strictEqual(registry.readThreadMetadata(threadId)?.name, "Server title");
  assert.deepStrictEqual(registry.readThreadMetadata(threadId)?.turns, []);
  assert.notStrictEqual(registry.readThreadMetadata(threadId), incoming);
  registry.releaseAll();
  assert.strictEqual(registry.readThreadMetadata(threadId), null);
});

it("refreshes resident receiver metadata when its raw Thread arrives", () => {
  const registry = makeConversationEntityStateRegistry();
  const entity = registry.acquire(threadId);
  const state = hydratedState([
    {
      ...completedTurn("collab-turn"),
      items: [
        {
          id: "spawn",
          type: "collabAgentToolCall",
          tool: "spawnAgent",
          status: "inProgress",
          senderThreadId: threadId,
          receiverThreadIds: ["receiver"],
          prompt: "Work",
          model: null,
          reasoningEffort: null,
          agentsStates: {},
        },
      ],
    },
  ]);
  entity.acceptCanonicalState(state);
  registry.registerThreadMetadata({
    ...thread,
    id: "receiver",
    name: "Raw receiver",
    agentNickname: "Nick",
  });
  const item = residentConversationTurns(entity.readCanonicalState())[0]?.items[0];
  assert.isTrue(item?.type === "collabAgentToolCall" && "receiverThreads" in item);
  if (item?.type !== "collabAgentToolCall" || !("receiverThreads" in item)) return;
  assert.strictEqual(item.receiverThreads[0]?.thread?.name, "Raw receiver");
  assert.deepStrictEqual(item.receiverThreads[0]?.thread?.turns, []);
  assert.strictEqual(registry.current("receiver"), null);
  const unchanged = entity.readCanonicalState();
  registry.registerThreadMetadata({
    ...thread,
    id: "receiver",
    name: "Raw receiver",
    agentNickname: "Nick",
  });
  assert.strictEqual(entity.readCanonicalState(), unchanged);
});

it("derives configuration and relocated cwd from the authoritative conversation document", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const canonical = hydratedState([]);
  aggregate.acceptCanonicalState(canonical);
  aggregate.installSnapshot(snapshotWithCanonicalTurns(canonical));
  const permissions = canonical.currentPermissions!;
  aggregate.applyTurnConfiguration({
    settings: {
      model: "configured-model",
      modelProvider: "openai",
      reasoningEffort: "low",
      collaborationMode: canonical.latestCollaborationMode,
      personality: null,
    },
    permissions,
  });
  assert.strictEqual(aggregate.readCanonicalState()?.latestModel, "configured-model");
  assert.strictEqual(aggregate.readSnapshot()?.latestThreadSettings?.model, "configured-model");
  aggregate.relocateExecution({
    cwd: "/workspace/moved",
    managedWorktreePath: null,
    projectId: "project",
    projectlessOutputDirectory: null,
    projectlessWorkspaceBrowserRoot: null,
    permissions,
  });
  assert.strictEqual(aggregate.readCanonicalState()?.cwd, "/workspace/moved");
  assert.strictEqual(aggregate.readSnapshot()?.cwd, "/workspace/moved");
  aggregate.relocateExecution({
    cwd: "/workspace/browser/child",
    managedWorktreePath: null,
    projectId: null,
    projectlessOutputDirectory: null,
    projectlessWorkspaceBrowserRoot: "/workspace/browser",
    permissions: {
      approvalPolicy: permissions.approvalPolicy,
      approvalsReviewer: permissions.approvalsReviewer,
      sandboxPolicy: permissions.sandboxPolicy,
    },
  });
  const relocated = aggregate.readCanonicalState()!;
  assert.strictEqual(relocated.workspaceKind, "projectless");
  assert.strictEqual(relocated.workspaceBrowserRoot, "/workspace/browser");
  assert.strictEqual(relocated.currentPermissions!.runtimeWorkspaceRoots, undefined);
  assert.strictEqual(relocated.currentPermissions!.activePermissionProfile, undefined);
});

it("applies Turn execution atomically and restores permissions without replacing saved settings", () => {
  const entity = makeConversationEntityStateRegistry().acquire(threadId);
  const before = hydratedState([]);
  entity.acceptCanonicalState(before);
  const settings = {
    model: "saved-model",
    effort: "high" as const,
    collaborationMode: before.latestCollaborationMode,
    personality: "friendly" as const,
  };
  const configured = produce(before, (draft) => {
    draft.latestThreadSettings = settings;
  });
  entity.acceptCanonicalState(configured);
  entity.installSnapshot(snapshotWithCanonicalTurns(configured));
  const execution: CodexPreparedTurnExecution = {
    model: null,
    reasoningEffort: null,
    shouldUpdateReasoningEffort: true,
    collaborationMode: {
      mode: "plan",
      settings: {
        model: "turn-model",
        reasoning_effort: "low",
        developer_instructions: "Selected instructions",
      },
    },
    permissions: {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
    },
    previousPermissions: before.currentPermissions,
  };
  const params = {
    threadId,
    input: [],
    clientUserMessageId: "execution-context",
    cwd: before.cwd,
    approvalPolicy: "never" as const,
    approvalsReviewer: "user" as const,
    sandboxPolicy: execution.permissions.sandboxPolicy,
    permissions: null,
    runtimeWorkspaceRoots: null,
    useAppServerPermissionDefault: false,
    model: null,
    effort: null,
    serviceTier: null,
    summary: null,
    personality: null,
    collaborationMode: execution.collaborationMode,
    multiAgentMode: "explicitRequestOnly" as const,
    outputSchema: null,
    attachments: [],
  };
  assert.isTrue(entity.admitOptimisticTurn({ params, execution, startedAtMs: 10 }));
  const pending = entity.readCanonicalState()!;
  assert.strictEqual(pending.latestModel, before.latestModel);
  assert.strictEqual(pending.latestReasoningEffort, null);
  assert.deepEqual(pending.latestCollaborationMode, execution.collaborationMode);
  assert.strictEqual(pending.latestThreadSettings, settings);
  assert.deepEqual(pending.currentPermissions, execution.permissions);
  assert.strictEqual(entity.readSnapshot()?.latestThreadSettings?.model, settings.model);
  entity.rejectOptimisticTurn({
    clientUserMessageId: "execution-context",
    previousPermissions: before.currentPermissions,
    failureItemId: "rejected",
    message: "Native refusal",
    observedAtMs: 20,
  });
  const rejected = entity.readCanonicalState()!;
  assert.strictEqual(rejected.latestThreadSettings, settings);
  assert.deepEqual(rejected.currentPermissions, before.currentPermissions);
  assert.strictEqual(residentConversationTurns(rejected).length, 0);
});

it("records canonical entity writes and applies them to a follower without replacing the document", () => {
  const raw = hydratedState([completedTurn("detached"), completedTurn("tail")]);
  const detached = raw.turns[0]!;
  const tail = raw.turns[1]!;
  const canonical: import("../../../shared/types").CodexCanonicalConversationState = {
    ...raw,
    turns: [],
    turnHistory: {
      kind: "canonical" as const,
      history: {
        generation: 1,
        isComplete: false,
        entitiesByKey: { "stable-detached": detached, "stable-tail": tail },
        islands: [
          {
            id: "search",
            entries: [{ key: "stable-detached", value: "stable-detached" }],
            olderBoundary: exhaustedCodexHistoryBoundary("search:older"),
            newerBoundary: opaqueCodexHistoryBoundary("search:newer"),
          },
          {
            id: "tail",
            entries: [{ key: "stable-tail", value: "stable-tail" }],
            olderBoundary: opaqueCodexHistoryBoundary("tail:older"),
            newerBoundary: exhaustedCodexHistoryBoundary("tail:newer"),
          },
        ],
      },
    },
  };
  const document = new CodexConversationEntityDocument().withCanonicalState(canonical);
  const mutation = document.mutate((draft) => {
    draft.turnHistory!.history.entitiesByKey["stable-detached"]!.durationMs = 77;
    return "updated";
  })!;
  assert.strictEqual(mutation.result, "updated");
  assert.deepEqual(mutation.patches, [
    {
      op: "replace",
      path: ["turnHistory", "history", "entitiesByKey", "stable-detached", "durationMs"],
      value: 77,
    },
  ]);
  assert.deepEqual(applyPatches(canonical, [...mutation.patches]), mutation.after);
  assert.strictEqual(mutation.after.turnHistory!.history.entitiesByKey["stable-tail"], tail);
  assert.strictEqual(document.canonicalState, canonical);
  const noOp = mutation.document.mutate((draft) => {
    draft.turnHistory!.history.entitiesByKey["stable-detached"]!.durationMs = 77;
  })!;
  assert.strictEqual(noOp.document, mutation.document);
  assert.deepEqual(noOp.patches, []);
  assert.throws(
    () =>
      mutation.document.mutate((draft) => {
        draft.title = "uncommitted";
        throw new Error("discard recipe");
      }),
    /discard recipe/,
  );
  assert.strictEqual(mutation.document.canonicalState, mutation.after);
});

it("releases canonical-only history and preserves pending request status without a UI snapshot", () => {
  const entity = makeConversationEntityStateRegistry().acquire(threadId);
  const state = hydratedState([completedTurn("pending-turn")]);
  entity.installFollowerCanonicalState({
    ...state,
    resumeState: "resumed",
    requests: [
      {
        id: 1,
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId: "pending-turn",
          itemId: "question",
          questions: [],
          isBlocking: true,
          autoResolutionMs: null,
        },
      },
    ],
  });
  assert.strictEqual(entity.readSnapshot(), null);
  assert.deepEqual(entity.readRetentionState(), {
    primaryRequest: "userInput",
    ephemeralSide: false,
  });
  entity.completeHistoryUnsubscribe(false);
  assert.strictEqual(entity.readCanonicalState()?.resumeState, "needs_resume");
  assert.deepEqual(entity.readCanonicalState()?.threadRuntimeStatus, {
    type: "active",
    activeFlags: ["waitingOnUserInput"],
  });
  assert.strictEqual(residentConversationTurns(entity.readCanonicalState()).length, 0);
  assert.strictEqual(entity.readCanonicalState()?.requests.length, 1);
});

it("retains ephemeral side conversation history when unsubscribing without a snapshot", () => {
  const entity = makeConversationEntityStateRegistry().acquire(threadId);
  entity.installFollowerCanonicalState({
    ...hydratedState([completedTurn("side-turn")]),
    resumeState: "resumed",
    ephemeral: true,
    sideConversation: true,
  });
  assert.strictEqual(entity.readRetentionState().ephemeralSide, true);
  entity.completeHistoryUnsubscribe(false);
  assert.strictEqual(residentConversationTurns(entity.readCanonicalState()).length, 1);
  assert.deepEqual(entity.readCanonicalState()?.threadRuntimeStatus, { type: "notLoaded" });
});

it("optimistic Main turns retain admitted local metadata and app context through native binding", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const state = hydratedState([completedTurn("original")]);
  aggregate.acceptCanonicalState(state);
  const params = {
    ...state.turns[0]!.params,
    permissions: null,
    sandboxPolicy: { type: "readOnly" as const, networkAccess: false },
    runtimeWorkspaceRoots: null,
    useAppServerPermissionDefault: false,
    attachments: [],
    clientUserMessageId: "native-start",
    input: [{ type: "text" as const, text: "next", text_elements: [] }],
  };
  const localMetadata = { captureId: "context-1" };
  const mcpAppModelContextAttachments = [{ source: "tool-result", text: "untrusted" }];
  assert.isTrue(
    aggregate.admitOptimisticTurn({
      params,
      localMetadata,
      mcpAppModelContextAttachments,
      startedAtMs: 10,
    }),
  );
  assert.isTrue(
    aggregate.acceptOptimisticTurn({
      clientUserMessageId: "native-start",
      turn: { ...completedTurn("accepted"), status: "inProgress" },
      observedAtMs: 11,
    }),
  );
  const accepted = residentConversationTurns(aggregate.readCanonicalState()).find(
    (turn) => turn.turnId === "accepted",
  );
  assert.deepEqual(accepted?.localMetadata, localMetadata);
  assert.deepEqual(accepted?.mcpAppModelContextAttachments, mcpAppModelContextAttachments);
});

it("accepted Main turns preserve an environment selection that changed after dispatch", () => {
  const aggregate = makeConversationEntityStateRegistry().acquire(threadId);
  const initial = produce(hydratedState([]), (draft) => {
    draft.environments = [{ environmentId: "old", cwd: "/old", runtimeWorkspaceRoots: ["/old"] }];
    draft.environmentSelectionEvidence = { source: "live", updatedAt: 10 };
  });
  aggregate.acceptCanonicalState(initial);
  const execution: CodexPreparedTurnExecution = {
    model: "gpt-test",
    reasoningEffort: "high",
    shouldUpdateReasoningEffort: false,
    collaborationMode: null,
    permissions: initial.currentPermissions!,
    environments: [
      {
        environmentId: "prepared",
        cwd: "/prepared",
        runtimeWorkspaceRoots: ["/prepared"],
      },
    ],
  };
  const params = {
    clientUserMessageId: "environment-race",
  } as Parameters<typeof aggregate.admitOptimisticTurn>[0]["params"];

  assert.isTrue(aggregate.admitOptimisticTurn({ execution, params, startedAtMs: 11_000 }));
  const captured = aggregate.readCanonicalState()!.environmentSelectionEvidence;
  aggregate.mutateCanonicalState((draft) => {
    draft.environments = [
      { environmentId: "newer", cwd: "/newer", runtimeWorkspaceRoots: ["/newer"] },
    ];
    draft.environmentSelectionEvidence = { source: "live", updatedAt: 12 };
  }, 12_000);

  assert.isTrue(
    aggregate.acceptOptimisticTurn({
      execution,
      environmentSelectionEvidence: captured,
      clientUserMessageId: "environment-race",
      turn: { ...completedTurn("environment-race-turn"), status: "inProgress" },
      observedAtMs: 13_000,
    }),
  );
  assert.deepEqual(aggregate.readCanonicalState()?.environments, [
    { environmentId: "newer", cwd: "/newer", runtimeWorkspaceRoots: ["/newer"] },
  ]);
  assert.deepEqual(aggregate.readCanonicalState()?.environmentSelectionEvidence, {
    source: "live",
    updatedAt: 12,
  });
});
