import { spaceHeld } from "../work-application/execution-holds";
import { createHash } from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import type { components } from "@nodex/core-protocol";
import { createUuidV7 } from "../../shared/uuid-v7";
import { AgentRuntimeApplication } from "../../main/agent-runtime/AgentRuntimeApplication";
import { CoreModules } from "../../main/core-runtime/CoreModules";
import { DatabaseNotifierRuntime } from "../../main/host-runtime/DatabaseNotifierRuntime";
import { getLogger } from "../../main/logging/logger";
import { CoordinatorSession } from "./CoordinatorSession";
import { renderWorkEventBatch } from "./work-event-message";

type Batch = components["schemas"]["CoordinatorEventBatch"];
export const make = Effect.gen(function* () {
  const core = yield* CoreModules;
  const runtime = yield* AgentRuntimeApplication;
  const coordinator = yield* CoordinatorSession;
  const lane = yield* Semaphore.make(1);
  const logger = getLogger({ component: "coordinator-delivery" });
  const settle = Effect.fn("CoordinatorDeliveryRuntime.settle")(function* (batch: Batch) {
    const acceptedAt = DateTime.formatIso(yield* DateTime.now);
    yield* core.workspace.apply(
      {
        operationId: `coordinator:settle:${batch.batch_id}:${acceptedAt}`,
        intent: { kind: "settle_event_batch", batch_id: batch.batch_id, accepted_at: acceptedAt },
      },
      undefined,
      null,
    );
  });
  const reconcile = Effect.fn("CoordinatorDeliveryRuntime.reconcile")(function* (batch: Batch) {
    const admission = yield* runtime.messageAdmission({
      sessionId: batch.coordinator_session_id,
      messageId: batch.message_id,
    });
    if (admission?.status !== "accepted") return false;
    yield* settle(batch);
    return true;
  });
  const deliver = Effect.fn("CoordinatorDeliveryRuntime.deliver")(function* (batch: Batch) {
    if (yield* reconcile(batch)) return;
    if (yield* spaceHeld(core)) return;
    const current = yield* core.workspace.read(
      { kind: "read_event_batch", batch_id: batch.batch_id },
      undefined,
      null,
    );
    if (
      current.value.kind !== "read_event_batch" ||
      !current.value.batch ||
      current.value.batch.accepted_at
    )
      return;
    if (current.value.batch.invalidated_at) {
      yield* core.workspace.apply(
        {
          operationId: `coordinator:discard:${batch.batch_id}`,
          intent: { kind: "discard_event_batch", batch_id: batch.batch_id },
        },
        undefined,
        null,
      );
      return;
    }
    if (yield* coordinator.isCoordinator(batch.coordinator_session_id)) yield* coordinator.ensure();
    yield* runtime.sendMessage({
      sessionId: batch.coordinator_session_id,
      mode: "queue",
      origin: "host",
      messageFingerprint: batch.fingerprint,
      message: { messageId: batch.message_id, text: batch.body, agentConfigs: [] },
    });
    // Re-read admission rather than waiting for the Coordinator's response.
    yield* reconcile(batch);
  });
  const drain = lane.withPermits(1)(
    Effect.gen(function* () {
      if (yield* spaceHeld(core)) return;
      const open = yield* core.workspace.read(
        { kind: "read_open_event_batches", limit: 100 },
        undefined,
        null,
      );
      if (open.value.kind !== "read_open_event_batches") return;
      for (const batch of open.value.batches)
        yield* deliver(batch).pipe(
          Effect.timeout("30 seconds"),
          Effect.catchCause(() =>
            Effect.sync(() =>
              logger.warn("Coordinator batch awaits admission reconciliation", {
                batchId: batch.batch_id,
              }),
            ),
          ),
        );
      const pending = yield* core.workspace.read(
        { kind: "read_pending_work_events", limit: 20 },
        undefined,
        null,
      );
      if (pending.value.kind !== "read_pending_work_events" || pending.value.events.length === 0)
        return;
      const sessionId = yield* coordinator.ensure();
      const batchId = createUuidV7();
      const messageId = createUuidV7();
      const { events, body } = renderWorkEventBatch(pending.value.events);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(["coordinator-work", 1, sessionId, messageId, body]))
        .digest("hex");
      yield* core.workspace.apply(
        {
          operationId: `coordinator:batch:${batchId}`,
          intent: {
            kind: "create_event_batch",
            batch_id: batchId,
            coordinator_session_id: sessionId,
            event_ids: events.map((event) => event.event_id),
            message_id: messageId,
            body,
            fingerprint,
          },
        },
        undefined,
        null,
      );
      yield* deliver({
        batch_id: batchId,
        coordinator_session_id: sessionId,
        message_id: messageId,
        body,
        fingerprint,
        created_at: DateTime.formatIso(yield* DateTime.now),
        accepted_at: null,
      }).pipe(Effect.timeout("30 seconds"));
    }).pipe(
      Effect.catchCause(() =>
        Effect.sync(() => logger.warn("Coordinator delivery awaits reconciliation")),
      ),
    ),
  );
  return { drain, reconcile };
});

/** Scope-owned wakeups resume the Core outbox after startup, reconnect, or a lost reply. */
export const live = Layer.effectDiscard(
  Effect.gen(function* () {
    const { drain } = yield* make;
    const notifier = yield* DatabaseNotifierRuntime;
    yield* Stream.mergeAll(
      [
        notifier.projectSessionInvalidations.pipe(Stream.map(() => undefined)),
        Stream.fromSchedule(Schedule.spaced("30 seconds")).pipe(Stream.map(() => undefined)),
      ],
      { concurrency: "unbounded" },
    ).pipe(
      Stream.debounce("250 millis"),
      Stream.runForEach(() => drain),
      Effect.forkScoped,
    );
    yield* drain.pipe(Effect.forkScoped);
  }),
);
