import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { decodeCodexAsyncQuestionReplies } from "../nodex/CodexConventions.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata controls"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "question-responses" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerReceipt = Layer.mergeAll(
  layerTest,
  ProviderEventIngestor.layer.pipe(
    Layer.provide(Layer.mergeAll(layerTest, IdAllocator.layer, ThreadCommandExecutor.layer)),
  ),
);

const seedQuestion = (suffix: string, running = false) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make(`question-test:${suffix}`);
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${suffix}`),
      threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Questions",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    let runId: RunId | null = null;
    let providerThreadId: ProviderThreadId | null = null;
    let providerTurnId: ProviderTurnId | null = null;
    if (running) {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`start:${suffix}`),
        threadId,
        messageId: MessageId.make(`start:${suffix}`),
        text: "Work while I decide",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const projection = yield* projections.getThreadProjection(threadId);
      const run = projection.runs[0]!;
      const attempt = projection.attempts[0]!;
      runId = run.id;
      providerThreadId = run.providerThreadId;
      providerTurnId = ProviderTurnId.make(`turn:${suffix}`);
      for (const event of [
        {
          type: "run.updated" as const,
          payload: { ...run, status: "running" as const, startedAt: now },
        },
        {
          type: "run-attempt.updated" as const,
          payload: { ...attempt, status: "running" as const, providerTurnId, startedAt: now },
        },
        {
          type: "provider-turn.updated" as const,
          payload: {
            id: providerTurnId,
            providerThreadId: providerThreadId!,
            nodeId: run.rootNodeId!,
            runAttemptId: run.activeAttemptId!,
            nativeTurnRef: null,
            ordinal: 1,
            status: "running" as const,
            startedAt: now,
            completedAt: null,
          },
        },
      ])
        yield* projections.apply({
          id: EventId.make(`seed:${suffix}:${event.type}`),
          threadId,
          occurredAt: now,
          ...event,
        });
    }
    const requestId = RuntimeRequestId.make(`question:${suffix}`);
    const nodeId = NodeId.make(`question:${suffix}`);
    const itemId = TurnItemId.make(`question:${suffix}`);
    yield* projections.apply({
      id: EventId.make(`request:${suffix}`),
      type: "runtime-request.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message", replyFormat: "codex_question_reply" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`node:${suffix}`),
      type: "node.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: nodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId: nodeId,
        kind: "user_input_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* projections.apply({
      id: EventId.make(`item:${suffix}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: itemId,
        threadId,
        runId,
        nodeId,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 100,
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId,
        responseMode: "message",
        questions: [
          {
            id: "first",
            header: "First",
            question: "Which screenshot?",
            options: [],
            required: false,
          },
          {
            id: "second",
            header: "Second",
            question: "Which branch?",
            options: [],
            required: false,
          },
        ],
      },
    });
    return { orchestrator, projections, threadId, requestId, runId, itemId };
  });

it.effect("keeps unanswered siblings pending and records each answer batch exactly once", () =>
  Effect.gen(function* () {
    const fixture = yield* seedQuestion("partial");
    const first = {
      type: "runtime-request.respond" as const,
      commandId: CommandId.make("answer:partial:first"),
      threadId: fixture.threadId,
      requestId: fixture.requestId,
      answers: { first: "Use the screenshot" },
    };
    const accepted = yield* fixture.orchestrator.dispatch(first);
    assert.deepEqual(yield* fixture.orchestrator.dispatch(first), accepted);
    const partial = yield* fixture.projections.getRuntimeResponseContext(
      fixture.threadId,
      fixture.requestId,
    );
    assert.equal(partial.request?.status, "pending");
    assert.deepEqual(partial.request?.answers, { first: "Use the screenshot" });
    assert.equal(partial.node?.status, "waiting");
    assert.equal(partial.item?.status, "waiting");

    const second = {
      ...first,
      commandId: CommandId.make("answer:partial:second"),
      answers: { second: "main" },
    };
    yield* fixture.orchestrator.dispatch(second);
    const completed = yield* fixture.projections.getRuntimeResponseContext(
      fixture.threadId,
      fixture.requestId,
    );
    assert.equal(completed.request?.status, "resolved");
    assert.deepEqual(completed.request?.answers, { first: "Use the screenshot", second: "main" });
    assert.equal(completed.node?.status, "completed");
    assert.ok(completed.item?.type === "user_input_request");
    assert.equal(completed.item.questionAnswer?.messageIds?.length, 2);
    const projection = yield* fixture.projections.getThreadRecords(fixture.threadId, ["messages"]);
    assert.equal(projection.messages.length, 2);
    assert.deepEqual(
      projection.messages.map((message) =>
        decodeCodexAsyncQuestionReplies(message.text)?.map((reply) => reply.questionItemId),
      ),
      [["first"], ["second"]],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["queue_after_active", "start_immediately"] as const)(
  "retains a refused steer's pending receipt through %s until provider acceptance",
  (type) =>
    Effect.gen(function* () {
      const fixture = yield* seedQuestion(`steer-fallback:${type}`, true);
      const initial = yield* fixture.projections.getThreadProjection(fixture.threadId);
      const original = initial.messages[0]!;
      yield* fixture.orchestrator.dispatch({
        type: "message.delivery.update",
        commandId: CommandId.make(`pending:${type}`),
        threadId: fixture.threadId,
        messageId: original.id,
        delivery: "pending",
      });
      if (type === "start_immediately") {
        const now = yield* DateTime.now;
        yield* fixture.projections.apply({
          id: EventId.make("fallback:completed"),
          type: "run.updated",
          threadId: fixture.threadId,
          occurredAt: now,
          payload: { ...initial.runs[0]!, status: "completed", completedAt: now },
        });
      }
      yield* fixture.orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`fallback:${type}`),
        threadId: fixture.threadId,
        messageId: original.id,
        text: original.text,
        attachments: original.attachments,
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type },
      });
      const queued = yield* fixture.projections.getThreadRecords(fixture.threadId, ["messages"], {
        messageIds: [original.id],
      });
      assert.equal(queued.messages[0]?.delivery, "pending");
      yield* fixture.orchestrator.dispatch({
        type: "message.delivery.update",
        commandId: CommandId.make(`accepted:${type}`),
        threadId: fixture.threadId,
        messageId: original.id,
        delivery: "accepted",
      });
      const accepted = yield* fixture.projections.getThreadRecords(fixture.threadId, [
        "messages",
        "turnItems",
      ]);
      assert.equal(accepted.messages.length, 1);
      assert.equal(accepted.messages[0]?.delivery, "accepted");
      const item = accepted.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === original.id,
      );
      assert.ok(item?.type === "user_message");
      assert.equal(item.delivery, "accepted");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("delivers only this batch's attachments and preserves earlier answer history", () =>
  Effect.gen(function* () {
    const fixture = yield* seedQuestion("attachment");
    const attachment = {
      type: "image" as const,
      id: "question_image",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 40,
    };
    yield* fixture.orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer:attachment:first"),
      threadId: fixture.threadId,
      requestId: fixture.requestId,
      answers: { first: "Use the screenshot" },
      attachmentsByQuestionId: { first: [attachment] },
    });
    yield* fixture.orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer:attachment:second"),
      threadId: fixture.threadId,
      requestId: fixture.requestId,
      answers: { second: "main" },
    });
    const response = yield* fixture.projections.getRuntimeResponseContext(
      fixture.threadId,
      fixture.requestId,
    );
    assert.ok(response.item?.type === "user_input_request");
    assert.deepEqual(response.item.questionAnswer?.attachmentsByQuestionId, {
      first: [attachment],
      second: [],
    });
    const data = yield* fixture.projections.getThreadRecords(fixture.threadId, ["messages"]);
    assert.deepEqual(
      data.messages.map((message) => message.attachments),
      [[attachment], []],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("accepts newer answer edits after an earlier batch completes", () =>
  Effect.gen(function* () {
    const fixture = yield* seedQuestion("revision");
    const command = {
      type: "runtime-request.respond" as const,
      threadId: fixture.threadId,
      requestId: fixture.requestId,
      commandId: CommandId.make("answer:revision:first"),
      answers: { first: "original", second: "main" },
    };
    yield* fixture.orchestrator.dispatch(command);
    const revision = {
      ...command,
      commandId: CommandId.make("answer:revision:second"),
      answers: { first: "edited while submitting" },
    };
    yield* fixture.orchestrator.dispatch(revision);
    const result = yield* fixture.projections.getRuntimeResponseContext(
      fixture.threadId,
      fixture.requestId,
    );
    assert.deepEqual(result.request?.answers, { first: "edited while submitting", second: "main" });
    const data = yield* fixture.projections.getThreadRecords(fixture.threadId, ["messages"]);
    assert.equal(data.messages.length, 2);
    assert.deepEqual(
      decodeCodexAsyncQuestionReplies(data.messages[1]!.text)?.map((reply) => reply.answer),
      ["edited while submitting"],
    );
    yield* fixture.orchestrator.dispatch({
      ...revision,
      commandId: CommandId.make("answer:revision:unchanged"),
    });
    assert.equal(
      (yield* fixture.projections.getThreadRecords(fixture.threadId, ["messages"])).messages.length,
      2,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "preserves explicit empty and whitespace answers for editable initial-value questions",
  () =>
    Effect.gen(function* () {
      const fixture = yield* seedQuestion("editable");
      const context = yield* fixture.projections.getRuntimeResponseContext(
        fixture.threadId,
        fixture.requestId,
      );
      assert.ok(context.item?.type === "user_input_request");
      const now = yield* DateTime.now;
      yield* fixture.projections.apply({
        id: EventId.make("editable:question"),
        type: "turn-item.updated",
        threadId: fixture.threadId,
        occurredAt: now,
        payload: {
          ...context.item,
          questions: context.item.questions.map((question) =>
            question.id === "first"
              ? { ...question, required: true, initialAnswer: "original" }
              : question,
          ),
        },
      });
      const reply = {
        type: "runtime-request.respond" as const,
        threadId: fixture.threadId,
        requestId: fixture.requestId,
        commandId: CommandId.make("editable:empty"),
        answers: { first: "" },
      };
      yield* fixture.orchestrator.dispatch(reply);
      assert.deepEqual(
        (yield* fixture.projections.getRuntimeRequest(fixture.threadId, fixture.requestId))
          ?.answers,
        { first: "" },
      );
      yield* fixture.orchestrator.dispatch({
        ...reply,
        commandId: CommandId.make("editable:whitespace"),
        answers: { first: "  exact text  " },
      });
      const messages = (yield* fixture.projections.getThreadRecords(fixture.threadId, ["messages"]))
        .messages;
      assert.deepEqual(
        messages.map((message) => decodeCodexAsyncQuestionReplies(message.text)?.[0]?.answer),
        ["", "  exact text  "],
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects foreign question identities without settling the original request", () =>
  Effect.gen(function* () {
    const fixture = yield* seedQuestion("foreign");
    const outcome = yield* fixture.orchestrator
      .dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("answer:foreign"),
        threadId: fixture.threadId,
        requestId: fixture.requestId,
        answers: { other: "not this request" },
      })
      .pipe(Effect.result);
    assert.equal(outcome._tag, "Failure");
    assert.equal(
      (yield* fixture.projections.getRuntimeRequest(fixture.threadId, fixture.requestId))?.status,
      "pending",
    );
    assert.equal(
      (yield* fixture.projections.getThreadRecords(fixture.threadId, ["messages"])).messages.length,
      0,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("preserves message-capable questions when Stop finds no provider session", () =>
  Effect.gen(function* () {
    const fixture = yield* seedQuestion("lost-session", true);
    yield* fixture.orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("stop:lost-session"),
      threadId: fixture.threadId,
      runId: fixture.runId!,
      holdQueue: true,
    });
    const result = yield* fixture.projections.getRuntimeRequest(
      fixture.threadId,
      fixture.requestId,
    );
    assert.equal(result?.status, "pending");
    assert.deepEqual(result?.responseCapability, {
      type: "message",
      replyFormat: "codex_question_reply",
    });
    const stillWaiting = yield* fixture.projections.getRuntimeResponseContext(
      fixture.threadId,
      fixture.requestId,
    );
    assert.equal(stillWaiting.node?.status, "waiting");
    assert.equal(stillWaiting.item?.status, "waiting");
    yield* fixture.orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make("answer:after-stop"),
      threadId: fixture.threadId,
      requestId: fixture.requestId,
      answers: { first: "still answerable" },
    });
    assert.deepEqual(
      (yield* fixture.projections.getRuntimeRequest(fixture.threadId, fixture.requestId))?.answers,
      { first: "still answerable" },
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "settles the original unknown answer from a later receipt without appending or downgrading it",
  () =>
    Effect.gen(function* () {
      const fixture = yield* seedQuestion("receipt");
      const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
      yield* fixture.orchestrator.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("answer:receipt"),
        threadId: fixture.threadId,
        requestId: fixture.requestId,
        answers: { first: "answer" },
      });
      const initial = yield* fixture.projections.getThreadRecords(fixture.threadId, ["messages"]);
      const messageId = initial.messages[0]!.id;
      yield* fixture.orchestrator.dispatch({
        type: "message.delivery.update",
        commandId: CommandId.make("receipt:unknown"),
        threadId: fixture.threadId,
        messageId,
        delivery: "unknown",
      });
      assert.equal(
        (yield* fixture.projections.getThreadRecords(fixture.threadId, ["messages"])).messages[0]
          ?.delivery,
        "unknown",
      );
      const nativeItemRef = {
        driver: adapter.driver,
        nativeId: "server-message-id",
        strength: "strong" as const,
      };
      yield* ingestor.ingestNormalized({
        providerSessionId: ProviderSessionId.make("receipt-session"),
        providerInstanceId: instanceId,
        threadId: fixture.threadId,
        event: {
          type: "message.delivery.updated",
          driver: adapter.driver,
          threadId: fixture.threadId,
          messageId,
          delivery: "accepted",
          nativeItemRef,
        },
      });
      yield* fixture.orchestrator.dispatch({
        type: "message.delivery.update",
        commandId: CommandId.make("receipt:late-unknown"),
        threadId: fixture.threadId,
        messageId,
        delivery: "unknown",
      });
      const final = yield* fixture.projections.getThreadRecords(fixture.threadId, [
        "messages",
        "turnItems",
      ]);
      assert.equal(final.messages.length, 1);
      assert.equal(final.messages[0]?.id, messageId);
      assert.equal(final.messages[0]?.delivery, "accepted");
      const item = final.turnItems.find(
        (item) => item.type === "user_message" && item.messageId === messageId,
      );
      assert.ok(item?.type === "user_message");
      assert.equal(item.delivery, "accepted");
      assert.deepEqual(item.nativeItemRef, nativeItemRef);
    }).pipe(Effect.provide(layerReceipt)),
);
