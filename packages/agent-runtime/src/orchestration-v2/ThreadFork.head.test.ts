import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2Run,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import {
  OPENCODE_DEFAULT_INSTANCE_ID,
  OPENCODE_PROVIDER,
  OPENCODE_SDK_PROTOCOL,
} from "@t3tools/provider-opencode/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

import { CLAUDE_DEFAULT_INSTANCE_ID, CLAUDE_PROVIDER } from "./Adapters/ClaudeAdapterV2.ts";
import {
  CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
  ClaudeOrchestratorReplayHarness,
  type ClaudeOrchestratorReplayHarnessError,
} from "./Adapters/ClaudeAdapterV2.testkit.ts";
import {
  OpenCodeOrchestratorReplayHarness,
  type OpenCodeOrchestratorReplayHarnessError,
} from "./Adapters/OpenCodeAdapterV2.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const providers = [
  {
    driver: CLAUDE_PROVIDER,
    instanceId: CLAUDE_DEFAULT_INSTANCE_ID,
    registry: ClaudeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer({
      provider: CLAUDE_PROVIDER,
      protocol: CLAUDE_AGENT_SDK_REPLAY_PROTOCOL,
      version: "1",
      scenario: "head-fork",
      entries: [],
    }),
  },
  {
    driver: OPENCODE_PROVIDER,
    instanceId: OPENCODE_DEFAULT_INSTANCE_ID,
    registry: OpenCodeOrchestratorReplayHarness.makeProviderAdapterRegistryLayer({
      provider: OPENCODE_PROVIDER,
      protocol: OPENCODE_SDK_PROTOCOL,
      version: "1",
      scenario: "head-fork",
      entries: [],
    }),
  },
].map((provider) => ({
  ...provider,
  layer: ProviderReplayHarness.layerWithRegistry<
    ClaudeOrchestratorReplayHarnessError | OpenCodeOrchestratorReplayHarnessError
  >({ name: "head-fork" }, provider.registry, {
    runEffectWorker: false,
  }),
}));

const cases = providers.flatMap((provider) =>
  (["completed", "waiting", "failed", "interrupted", "cancelled"] as const).map((status) => ({
    ...provider,
    status,
  })),
);

it.effect.each(cases)(
  "forks the latest $status $driver conversation without a checkpoint or native identity",
  ({ instanceId, status, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("head-source");
      const targetThreadId = ThreadId.make("head-fork");
      const modelSelection = { instanceId, model: "test-model" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("head-project"),
        title: "Plain chat",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      assert.isNull(yield* orchestrator.getThreadForkSource(sourceThreadId));

      const sourceRunId = RunId.make("head-source-run");
      // Completed plain chats have never had a checkpoint. The other cases
      // also prove an older checkpoint cannot displace the newest settled Run.
      const runs: ReadonlyArray<{
        id: RunId;
        status: OrchestrationV2Run["status"];
        checkpointId?: CheckpointId;
      }> = [
        ...(status === "completed"
          ? []
          : [
              {
                id: RunId.make("old-checkpoint-run"),
                status: "completed" as const,
                checkpointId: CheckpointId.make("old-checkpoint"),
              },
            ]),
        { id: sourceRunId, status },
        ...(["queued", "preparing", "starting", "running", "rolled_back"] as const).map(
          (status) => ({ id: RunId.make(`later-${status}`), status }),
        ),
      ];
      for (const [index, run] of runs.entries()) {
        const ordinal = index + 1;
        const messageId = MessageId.make(`message-${run.id}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${run.id}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: run.id,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: null,
                status: run.status,
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: run.checkpointId ?? null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${run.id}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${run.id}`),
                threadId: sourceThreadId,
                runId: run.id,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: run.id === sourceRunId ? "INCLUDED_HEAD_MARKER" : `MESSAGE_${run.id}`,
                attachments: [],
              },
            },
          ],
        });
      }

      assert.equal(yield* orchestrator.getThreadForkSource(sourceThreadId), sourceRunId);
      assert.equal(
        yield* orchestrator.getThreadForkSource(sourceThreadId, sourceRunId),
        sourceRunId,
      );
      assert.isNull(yield* orchestrator.getThreadForkSource(sourceThreadId, RunId.make("missing")));
      assert.isNull(
        yield* orchestrator.getThreadForkSource(sourceThreadId, RunId.make("later-running")),
      );

      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("fork-head"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        rootPolicy: "independent_root",
        createdBy: "user",
        creationSource: "web",
      });
      const fork = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.deepEqual(fork.thread.forkedFrom, {
        type: "run",
        sourceHistoryRevision: 0,
        threadId: sourceThreadId,
        runId: sourceRunId,
      });
      assert.isNull(fork.thread.worktreePath);
      assert.lengthOf(fork.runs, 0);
      assert.isNull(yield* orchestrator.getThreadForkSource(targetThreadId, sourceRunId));

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-head-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-head-fork"),
        text: "Continue the chat",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const continued = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(continued.contextTransfers[0]?.resolution?.strategy, "portable_context");
      const handoff = continued.contextHandoffs[0]!;
      const context = `${handoff.summaryText}\n${handoff.history?.messages.map((message) => message.text).join("\n")}`;
      assert.include(context, "INCLUDED_HEAD_MARKER");
      assert.notInclude(context, "MESSAGE_later-");
      assert.isNull(continued.providerThreads[0]?.forkedFrom);
      if (status === "completed") {
        // Merge-back latest_stable keeps its checkpoint boundary. Chat forks
        // must not silently broaden the shared resolver for workspace merges.
        const forkRun = continued.runs[0]!;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("complete-fork-without-checkpoint"),
              type: "run.updated",
              threadId: targetThreadId,
              occurredAt: now,
              payload: { ...forkRun, status: "completed", completedAt: now, checkpointId: null },
            },
          ],
        });
        const error = yield* orchestrator
          .dispatch({
            type: "thread.merge_back",
            commandId: CommandId.make("merge-without-checkpoint"),
            sourceThreadId: targetThreadId,
            targetThreadId: sourceThreadId,
            sourcePoint: { type: "latest_stable" },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
        assert.equal(
          error.cause,
          "No stable source run was found for merge-back source latest_stable.",
        );
      }
    }).pipe(Effect.provide(layer)),
);

it.effect.each(providers)(
  "captures a running $driver side chat once without continuing its source",
  ({ instanceId, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const source = ThreadId.make("side-source");
      const child = ThreadId.make("side-child");
      const runId = RunId.make("source-running");
      const messageId = MessageId.make("source-request");
      const modelSelection = { instanceId, model: "test-model" };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("side-source-create"),
        threadId: source,
        projectId: ProjectId.make("side-project"),
        title: "Main task",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/work/current",
        createdBy: "user",
        creationSource: "web",
      });
      const run: OrchestrationV2Run = {
        id: runId,
        threadId: source,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status: "running",
        queuePosition: null,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      const partial = {
        id: TurnItemId.make("partial-reply"),
        threadId: source,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "running" as const,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "assistant_message" as const,
        messageId: MessageId.make("partial-message"),
        streaming: true,
        text: `CAPTURED_PARTIAL ${"detailed context ".repeat(60)}`,
        attachments: [],
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("source-run"),
            type: "run.created",
            threadId: source,
            runId,
            occurredAt: now,
            payload: run,
          },
          {
            id: EventId.make("partial-before"),
            type: "turn-item.updated",
            threadId: source,
            runId,
            occurredAt: now,
            payload: partial,
          },
        ],
      });
      const create = {
        type: "thread.fork" as const,
        sideChat: true as const,
        commandId: CommandId.make("side-capture"),
        sourceThreadId: source,
        targetThreadId: child,
        sourcePoint: { type: "latest_stable" as const },
        rootPolicy: "independent_root" as const,
        title: "Side chat",
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      yield* orchestrator.dispatch(create);
      const captured = yield* orchestrator.getThreadProjection(child);
      assert.lengthOf(captured.runs, 0);
      assert.equal(captured.thread.worktreePath, "/work/current");
      assert.equal(captured.thread.lineage.rootThreadId, child);
      assert.isNull(captured.thread.lineage.parentThreadId);
      assert.isFalse(captured.thread.sideChat!.nativeFork);
      assert.include(
        (yield* store.getSideChatContext(child))!.history.messages[0]!.text,
        "detailed context ".repeat(60).trim(),
      );
      const zeroBudget = yield* store.getHandoffHistory({
        threadId: child,
        scope: "conversation",
        budget: 0,
      });
      assert.lengthOf(zeroBudget.history.messages, 0);
      assert.isAbove(zeroBudget.history.omittedItems, 0);
      assert.notInclude(zeroBudget.context, "CAPTURED_PARTIAL");
      assert.lengthOf(
        (yield* orchestrator.getThreadSnapshotWindow(child, { rowLimit: 100 })).projection
          .visibleTurnItems,
        0,
      );
      yield* sink.write({
        events: [
          {
            id: EventId.make("partial-after"),
            type: "turn-item.updated",
            threadId: source,
            runId,
            occurredAt: now,
            payload: { ...partial, text: `${partial.text} LATE_PARENT_TEXT` },
          },
        ],
      });
      yield* orchestrator.dispatch(create);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(child)).thread.sideChat,
        captured.thread.sideChat,
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("side-question"),
        threadId: child,
        messageId: MessageId.make("side-question"),
        text: "Explain this detail",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const started = yield* orchestrator.getThreadProjection(child);
      const handed = started.contextHandoffs
        .flatMap((h) => h.history?.messages ?? [])
        .map((m) => m.text)
        .join("\n");
      assert.include(handed, "CAPTURED_PARTIAL");
      assert.notInclude(handed, "LATE_PARENT_TEXT");
      assert.equal((yield* orchestrator.getThreadProjection(source)).runs[0]!.status, "running");
      const sideRun = started.runs[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("side-completed"),
            type: "run.updated",
            threadId: child,
            runId: sideRun.id,
            occurredAt: now,
            payload: { ...sideRun, status: "completed", completedAt: now },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make("regular-fork-of-side"),
        sourceThreadId: child,
        targetThreadId: ThreadId.make("regular-fork"),
        sourcePoint: { type: "latest_stable" },
        rootPolicy: "independent_root",
        createdBy: "user",
        creationSource: "web",
      });
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(ThreadId.make("regular-fork"))).thread.sideChat,
      );
      const independent = yield* store.getHandoffHistory({
        threadId: ThreadId.make("regular-fork"),
        scope: "conversation",
        budget: 16000,
      });
      const inherited = independent.history.messages;
      assert.include(inherited.map((m) => m.text).join("\n"), "CAPTURED_PARTIAL");
      assert.notInclude(inherited.map((m) => m.text).join("\n"), "LATE_PARENT_TEXT");
      assert.isBelow(
        inherited.findIndex((m) => m.kind === "side_chat_boundary"),
        inherited.findIndex((m) => m.text === "Explain this detail"),
      );
      const portable = yield* store.getHandoffHistory({
        threadId: child,
        scope: "conversation",
        budget: 16000,
      });
      assert.include(portable.history.messages.map((m) => m.text).join("\n"), "CAPTURED_PARTIAL");
      assert.notInclude(
        portable.history.messages.map((m) => m.text).join("\n"),
        "LATE_PARENT_TEXT",
      );
      yield* orchestrator.dispatch({
        type: "thread.clear_context",
        threadId: child,
        commandId: CommandId.make("side-clear"),
      });
      const cleared = yield* store.getHandoffHistory({
        threadId: child,
        scope: "conversation",
        budget: 16000,
      });
      assert.notInclude(cleared.history.messages.map((m) => m.text).join("\n"), "CAPTURED_PARTIAL");
      const beforeClear = yield* store.getHandoffHistory({
        threadId: child,
        scope: "conversation",
        runOrdinalTo: sideRun.ordinal,
        asOfRunOrdinalTo: true,
        historyRevision: 0,
        budget: 16000,
      });
      assert.include(
        beforeClear.history.messages.map((m) => m.text).join("\n"),
        "CAPTURED_PARTIAL",
      );
      const currentSide = (yield* orchestrator.getThreadProjection(child)).thread;
      yield* sink.write({
        events: [
          {
            id: EventId.make("rewind-clear-run"),
            type: "run.updated",
            threadId: child,
            runId: sideRun.id,
            occurredAt: now,
            payload: {
              ...sideRun,
              status: "rolled_back",
              rolledBackAtRevision: 1,
              completedAt: now,
            },
          },
          {
            id: EventId.make("rewind-side-revision"),
            type: "thread.metadata-updated",
            threadId: child,
            occurredAt: now,
            payload: { ...currentSide, historyRevision: 1 },
          },
        ],
      });
      const rewound = yield* store.getHandoffHistory({
        threadId: child,
        scope: "conversation",
        budget: 16000,
      });
      assert.include(rewound.history.messages.map((m) => m.text).join("\n"), "CAPTURED_PARTIAL");
      yield* orchestrator.dispatch({
        type: "thread.delete",
        threadId: child,
        commandId: CommandId.make("side-dispose"),
      });
      const afterDispose = yield* store.getHandoffHistory({
        threadId: ThreadId.make("regular-fork"),
        scope: "conversation",
        budget: 16000,
      });
      assert.deepEqual(afterDispose.history.messages, independent.history.messages);
      assert.equal(
        (yield* orchestrator.getThreadProjection(source)).turnItems[0]!.type,
        "assistant_message",
      );
    }).pipe(Effect.provide(layer)),
);

it.effect.each(providers)(
  "opens an idle $driver side chat when the source has no Runs",
  ({ instanceId, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sourceThreadId = ThreadId.make("empty-source");
      const targetThreadId = ThreadId.make("empty-side");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("empty-create"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("empty-project"),
        title: "Empty",
        modelSelection: { instanceId, model: "test-model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "thread.fork",
        sideChat: true,
        commandId: CommandId.make("empty-side-create"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "latest_stable" },
        rootPolicy: "independent_root",
        createdBy: "user",
        creationSource: "web",
      });
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const side = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.lengthOf(side.runs, 0);
      assert.deepEqual(
        (yield* store.getSideChatContext(targetThreadId))!.history.messages.map(
          (message) => message.kind,
        ),
        ["side_chat_boundary"],
      );
      assert.isNull(side.thread.forkedFrom);
      yield* orchestrator.dispatch({
        type: "thread.clear_context",
        threadId: targetThreadId,
        commandId: CommandId.make("empty-side-clear"),
      });
      assert.isNull(yield* store.getSideChatContext(targetThreadId));
      assert.isUndefined((yield* orchestrator.getThreadProjection(sourceThreadId)).thread.sideChat);
    }).pipe(Effect.provide(layer)),
);

const sideSwitchLayer = ProviderReplayHarness.layerWithRegistry(
  { name: "side-provider-switch" },
  ProviderAdapterRegistry.layerFromAdaptersEffect(
    Effect.gen(function* () {
      const adapters = [];
      for (const provider of providers) {
        const services = yield* Layer.build<
          Layer.Services<typeof provider.registry>,
          Layer.Error<typeof provider.registry>,
          ProviderAdapterRegistry.ProviderAdapterRegistryV2
        >(provider.registry);
        const registry = Context.get(services, ProviderAdapterRegistry.ProviderAdapterRegistryV2);
        adapters.push(yield* registry.get(provider.instanceId));
      }
      return adapters;
    }),
  ),
  { runEffectWorker: false },
);

it.effect("delivers frozen source facts and side-local history once when switching Agent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const source = ThreadId.make("switch-source");
    const child = ThreadId.make("switch-side");
    const sourceSelection = { instanceId: CLAUDE_DEFAULT_INSTANCE_ID, model: "source-model" };
    const targetSelection = { instanceId: OPENCODE_DEFAULT_INSTANCE_ID, model: "target-model" };
    const sourceText = "The source marker is ORCHID. Keep it as conversation context.";
    const sideText = "The side marker is SIDECAR. What was the source marker?";
    const send = Effect.fnUntraced(function* (
      threadId: ThreadId,
      id: string,
      text: string,
      modelSelection = sourceSelection,
    ) {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId,
        messageId: MessageId.make(id),
        text,
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
    });
    const complete = Effect.fnUntraced(function* (threadId: ThreadId) {
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`complete:${run.id}`),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("switch-source-create"),
      threadId: source,
      projectId: ProjectId.make("switch-project"),
      title: "Source",
      modelSelection: sourceSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(source, "source-fact", sourceText);
    yield* complete(source);
    yield* orchestrator.dispatch({
      type: "thread.fork",
      sideChat: true,
      commandId: CommandId.make("switch-side-create"),
      sourceThreadId: source,
      targetThreadId: child,
      sourcePoint: { type: "latest_stable" },
      rootPolicy: "independent_root",
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(source, "later-parent-fact", "The later parent marker is LATER.");
    yield* complete(source);
    yield* send(child, "side-fact", sideText);
    yield* complete(child);
    yield* send(child, "switch-and-recall", "Recall the source and side markers.", targetSelection);
    const switched = yield* orchestrator.getThreadProjection(child);
    const run = switched.runs.at(-1)!;
    const handoff = switched.contextHandoffs.find((candidate) => candidate.targetRunId === run.id)!;
    assert.isDefined(handoff);
    assert.equal(handoff.strategy, "full_thread_summary");
    assert.deepEqual(
      handoff
        .history!.messages.map((message) => message.text)
        .filter((text) => text === sourceText || text === sideText),
      [sourceText, sideText],
    );
    const providerThread = {
      ...switched.providerThreads.find((candidate) => candidate.id === run.providerThreadId)!,
      nativeThreadRef: {
        driver: OPENCODE_PROVIDER,
        nativeId: "switched-native",
        strength: "strong" as const,
      },
    };
    let delivered = handoff;
    const deliveryInput = {
      handoffs: [handoff],
      providerThread,
      budget: 16_000,
      alreadyDeliveredItemIds: new Set<string>(),
      persist: (next: typeof handoff) =>
        Effect.sync(() => {
          delivered = next;
        }),
    };
    const delivery = yield* deliverContextHandoffs(deliveryInput);
    assert.include(delivery.context, sourceText);
    assert.include(delivery.context, sideText);
    assert.notInclude(delivery.context, "LATER");
    assert.isBelow(
      delivery.context.indexOf(sourceText),
      delivery.context.indexOf("Side conversation boundary."),
    );
    assert.isBelow(
      delivery.context.indexOf("Side conversation boundary."),
      delivery.context.indexOf(sideText),
    );
    yield* delivery.delivered;
    assert.lengthOf(delivered.delivery!.itemIds, handoff.history!.messages.length);
    const next = yield* deliverContextHandoffs({ ...deliveryInput, handoffs: [delivered] });
    assert.equal(next.context, "");
  }).pipe(Effect.provide(sideSwitchLayer)),
);
