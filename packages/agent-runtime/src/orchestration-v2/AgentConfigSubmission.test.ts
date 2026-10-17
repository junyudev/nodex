import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  EventId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as EventSink from "./EventSink.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Native effects are not run in this receipt test"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "agent-config-submission" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
);

it.effect.each([
  { deliveryIntent: "auto" as const },
  { deliveryIntent: "auto" as const, interactionMode: "default" as const },
])("a first message deferred for its worktree waits for it (%o)", (delivery) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make("deferred-worktree-root");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("deferred:create"),
      threadId,
      projectId: ProjectId.make("project"),
      title: "Worktree",
      modelSelection: { instanceId, model: "model-a" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace",
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("deferred:message"),
      threadId,
      messageId: MessageId.make("deferred:message"),
      text: "Work in a new worktree",
      attachments: [],
      ...delivery,
      dispatchMode: {
        type: "defer_start",
        workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
      },
      createdBy: "user",
      creationSource: "web",
    });
    const [run] = (yield* orchestrator.getThreadProjection(threadId)).runs;
    assert.equal(run?.status, "preparing");
    assert.deepEqual(run?.workspacePreparation, { type: "worktree", baseRef: "HEAD" });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "captures queued intelligence and planning without changing the active Turn, then applies them on promotion",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("agent-config-root");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("config:create"),
        threadId,
        projectId: ProjectId.make("project"),
        title: "Preferences",
        modelSelection: { instanceId, model: "model-a" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("config:active"),
        threadId,
        messageId: MessageId.make("config:active"),
        text: "Active",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      });
      const queuedCommand = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("config:queued"),
        threadId,
        messageId: MessageId.make("config:queued"),
        text: "Plan next",
        attachments: [],
        modelSelection: {
          instanceId,
          model: "model-b",
          options: [
            { id: "reasoningEffort", value: "high" },
            { id: "serviceTier", value: "fast" },
          ],
        },
        interactionMode: "plan" as const,
        deliveryIntent: "steer" as const,
        dispatchMode: { type: "start_immediately" as const },
        createdBy: "user" as const,
        creationSource: "web" as const,
      };
      yield* orchestrator.dispatch(queuedCommand);
      yield* orchestrator.dispatch(queuedCommand);
      let projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 2);
      assert.equal(projection.thread.interactionMode, "default");
      assert.equal(projection.thread.modelSelection.model, "model-a");
      const queued = projection.runs.find((run) => run.status === "queued")!;
      const active = projection.runs.find((run) => run.status === "preparing")!;
      assert.equal(queued.interactionMode, "plan");
      assert.deepEqual(queued.modelSelection, queuedCommand.modelSelection);
      const steer = yield* orchestrator
        .dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("config:no-steer"),
          threadId,
          queuedRunId: queued.id,
          targetRunId: active.id,
        })
        .pipe(Effect.result);
      assert.equal(steer._tag, "Failure");
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("config:edit"),
        threadId,
        runId: queued.id,
        text: "Edited plan",
        modelSelection: {
          instanceId,
          model: "model-b",
          options: [
            { id: "reasoningEffort", value: "low" },
            { id: "serviceTier", value: "default" },
          ],
        },
        interactionMode: "plan",
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.thread.interactionMode, "default");
      assert.equal(
        projection.runs.find((run) => run.id === queued.id)?.modelSelection.options?.[0]?.value,
        "low",
      );
      const now = yield* DateTime.now;
      yield* events.write({
        events: [
          {
            id: EventId.make("config:active-completed"),
            type: "run.updated",
            threadId,
            runId: active.id,
            occurredAt: now,
            payload: { ...active, status: "completed", completedAt: now },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("config:resume"),
        threadId,
      });
      projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs.find((run) => run.id === queued.id)?.status, "starting");
      assert.equal(projection.thread.interactionMode, "plan");
      assert.equal(projection.thread.modelSelection.model, "model-b");
      assert.equal(projection.thread.modelSelection.options?.[0]?.value, "low");
    }).pipe(Effect.provide(layer)),
);
