import { createHash } from "node:crypto";
import { CommandId, ThreadId } from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import * as Admission from "../orchestration-v2/RunAdmission.ts";

/** Pause has its own durable fence and never disposes a Stop cohort or holds the input queue. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const writer = yield* OrchestratorV2;
  const projections = yield* ProjectionStoreV2;
  const outbox = yield* EffectOutboxV2;
  const pause = Effect.fn("SessionPause.pause")(function* (input: {
    readonly threadId: string;
    readonly revision: string;
  }) {
    const thread = yield* projections.getThread(ThreadId.make(input.threadId));
    const root = thread.lineage.rootThreadId;
    yield* sql`INSERT INTO orchestration_v2_execution_pauses VALUES(${root},${input.revision},datetime('now')) ON CONFLICT DO NOTHING`;
    const row = (yield* sql<{
      revision: string;
    }>`SELECT revision FROM orchestration_v2_execution_pauses WHERE root_thread_id=${root}`)[0]!;
    const prefix = `pause:${createHash("sha256")
      .update(JSON.stringify([root, row.revision]))
      .digest("hex")}`;
    let cursor: string | undefined;
    let stopped = true;
    do {
      const actors: import("../orchestration-v2/ProjectionStore.ts").ProjectionExecutionActorPage =
        yield* projections.getExecutionActors(root, cursor);
      for (const actor of actors.items) {
        yield* writer.dispatch({
          type: "thread.execution-pause",
          threadId: actor.threadId,
          commandId: CommandId.make(`${prefix}:hold:${actor.threadId}`),
          phase: "hold",
        });
        if (actor.providerSessionId) {
          const commandId = CommandId.make(
            `${prefix}:detach:${actor.threadId}:${actor.providerSessionId}`,
          );
          yield* writer.dispatch({
            type: "provider-session.detach",
            threadId: actor.threadId,
            providerSessionId: actor.providerSessionId,
            commandId,
            revokeMcpCredential: true,
            reason: "Work paused",
          });
          const effect = yield* outbox.get(
            `effect:${commandId}:provider-session.detach:${actor.providerSessionId}`,
          );
          if (Option.isNone(effect) || effect.value.status !== "succeeded") stopped = false;
        }
      }
      cursor = actors.nextCursor ?? undefined;
    } while (cursor);
    const barrier = yield* projections.getExecutionDetachBarrier(root);
    if (barrier !== null) {
      stopped = false;
      const retirement = yield* outbox.get(barrier);
      if (
        Option.isSome(retirement) &&
        (retirement.value.status === "failed" || retirement.value.status === "cancelled")
      )
        yield* outbox.retryReplaySafe({
          effectId: barrier,
          effectType: "provider-session.detach",
          expectedStatus: retirement.value.status,
        });
    }
    // A start claimed before the fence may still be opening a native source. Its
    // effect and any newly attached source must both disappear before quiescence.
    const active = (yield* sql<{
      active: number;
    }>`SELECT EXISTS(SELECT 1 FROM orchestration_v2_projection_threads thread JOIN orchestration_v2_projection_provider_session_bindings binding USING(thread_id) WHERE json_extract(thread.payload_json,'$.lineage.rootThreadId')=${root}) OR EXISTS(SELECT 1 FROM orchestration_v2_projection_threads thread JOIN orchestration_v2_effect_outbox effect USING(thread_id) WHERE json_extract(thread.payload_json,'$.lineage.rootThreadId')=${root} AND effect.status='running' AND effect.effect_type IN ${sql.in(Admission.ADMISSION_EFFECT_TYPES)}) AS active`)[0];
    if (active?.active) stopped = false;
    if (stopped) {
      cursor = undefined;
      do {
        const actors: import("../orchestration-v2/ProjectionStore.ts").ProjectionExecutionActorPage =
          yield* projections.getExecutionActors(root, cursor);
        for (const actor of actors.items)
          yield* writer.dispatch({
            type: "thread.execution-pause",
            threadId: actor.threadId,
            commandId: CommandId.make(`${prefix}:settled:${actor.threadId}`),
            phase: "settled",
          });
        cursor = actors.nextCursor ?? undefined;
      } while (cursor);
      yield* Admission.reconcile().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    }
    return { status: stopped ? ("stopped" as const) : ("requested" as const) };
  });
  const resume = Effect.fn("SessionPause.resume")(function* (input: { readonly threadId: string }) {
    const thread = yield* projections.getThread(ThreadId.make(input.threadId));
    const root = thread.lineage.rootThreadId;
    const row = (yield* sql<{
      revision: string;
    }>`SELECT revision FROM orchestration_v2_execution_pauses WHERE root_thread_id=${root}`)[0];
    if (!row) return { status: "resumed" as const };
    if ((yield* pause({ threadId: root, revision: row.revision })).status !== "stopped")
      return { status: "requested" as const };
    yield* sql`DELETE FROM orchestration_v2_execution_pauses WHERE root_thread_id=${root}`;
    let cursor: string | undefined;
    do {
      const actors: import("../orchestration-v2/ProjectionStore.ts").ProjectionExecutionActorPage =
        yield* projections.getExecutionActors(root, cursor);
      for (const actor of actors.items) yield* writer.resumeThreadQueue(actor.threadId);
      cursor = actors.nextCursor ?? undefined;
    } while (cursor);
    return { status: "resumed" as const };
  });
  return { pause, resume };
});
