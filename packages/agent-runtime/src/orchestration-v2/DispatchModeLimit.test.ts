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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider is started in command admission tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layer = Layer.merge(
  ProviderReplayHarness.layerWithRegistry(
    { name: "dispatch-mode-limit" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  ),
  ThreadCommandExecutor.layer,
);

it.effect(
  "rechecks Plan permissions after waiting for the canonical command lock without poisoning retry",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const events = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("limit:plan");
      const before = {
        runtimeMode: "full-access" as const,
        interactionMode: "plan" as const,
      };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:plan"),
        threadId,
        projectId: ProjectId.make("project"),
        title: "Plan",
        modelSelection: { instanceId, model: "model-a" },
        ...before,
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const initial = (yield* orchestrator.getThreadProjection(threadId)).thread;
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const waiting = yield* Deferred.make<void>();
      const mutation = yield* executor
        .withLock(
          threadId,
          Effect.gen(function* () {
            yield* Deferred.succeed(locked, undefined);
            yield* Deferred.await(release);
            // The same event owner commits a user's mode change before the queued command acquires its lock.
            yield* events.write({
              events: [
                {
                  id: EventId.make("mode:plan"),
                  type: "thread.metadata-updated",
                  threadId,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...initial,
                    interactionMode: "default",
                  },
                },
              ],
            });
          }),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      const command = {
        type: "message.dispatch" as const,
        commandId: CommandId.make("send:plan"),
        threadId,
        messageId: MessageId.make("message:plan"),
        text: "Continue",
        attachments: [],
        dispatchMode: { type: "start_immediately" as const },
        createdBy: "agent" as const,
        creationSource: "mcp" as const,
      };
      const attempt = yield* Effect.gen(function* () {
        yield* Deferred.succeed(waiting, undefined);
        return yield* orchestrator
          .dispatch(command)
          .pipe(Effect.provideService(DispatchModeLimit, before), Effect.result);
      }).pipe(Effect.forkChild);
      yield* Deferred.await(waiting);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(mutation);
      const result = yield* Fiber.join(attempt);
      assert.equal(result._tag, "Failure");
      if (result._tag !== "Failure") return;
      assert.equal(result.failure._tag, "OrchestratorThreadAboveModeLimitError");
      if (result.failure._tag !== "OrchestratorThreadAboveModeLimitError") return;
      assert.equal(result.failure.reason, "interaction_mode_escalation_denied");
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(projection.runs.length, 0);
      assert.equal(projection.messages.length, 0);
      assert.isTrue(Option.isNone(yield* orchestrator.getReceipt(command.commandId)));
      yield* events.write({
        events: [
          {
            id: EventId.make("restore:plan"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: yield* DateTime.now,
            payload: initial,
          },
        ],
      });
      yield* orchestrator.dispatch(command).pipe(Effect.provideService(DispatchModeLimit, before));
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 1);
      // An accepted receipt replays even if the current target has since acquired wider modes.
      yield* events.write({
        events: [
          {
            id: EventId.make("later:plan"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: yield* DateTime.now,
            payload: { ...initial, interactionMode: "default", runtimeMode: "full-access" },
          },
        ],
      });
      yield* orchestrator.dispatch(command).pipe(Effect.provideService(DispatchModeLimit, before));
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 1);
    }).pipe(Effect.provide(layer)),
);
