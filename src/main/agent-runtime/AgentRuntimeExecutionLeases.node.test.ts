import { assert, it } from "@effect/vitest";
import type { components } from "@nodex/core-protocol";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "@nodex/agent-runtime/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import type {
  AgentRuntimeProcessConnection,
  AgentRuntimeProcessDelivery,
} from "../platform/node/AgentRuntimeProcess";
import type { AgentRuntimeAuthorityIdentity } from "./AgentRuntimeAuthority";
import { make } from "./AgentRuntimeExecutionLeases";

type Admission =
  components["schemas"]["CollectionWindow_ProjectWorkspaceAgentRuntimeAdmission"]["items"][number];
const identity = (thread = "root", run = "run"): AgentRuntimeAuthorityIdentity => ({
  runtime_id: "runtime",
  lease_id: "generation",
  thread_id: thread,
  run_id: run,
});
const source = { providerSessionId: "provider-session", nativeGeneration: 1 };
const fixture = (
  initial: readonly AgentRuntimeAuthorityIdentity[] = [identity(), identity("child")],
) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<AgentRuntimeProcessDelivery>();
    const ended = yield* Deferred.make<never>();
    const retired = yield* Deferred.make<void>();
    const allRetired = yield* Deferred.make<void>();
    const repaired = yield* Deferred.make<void>();
    const failed = yield* Deferred.make<void>();
    const revoked: AgentRuntimeAuthorityIdentity[] = [];
    const presentationFinished: unknown[][] = [];
    const reads: string[] = [];
    const rosterReads: Array<string | undefined> = [];
    const live = new Set(["root", "child"]);
    const nativeLive = new Set(["incarnation:one", "incarnation:next"]);
    const records: Array<{ admission: Admission; active: boolean }> = [];
    const admit = (id: AgentRuntimeAuthorityIdentity, nativeSource = source) =>
      records.push({
        active: true,
        admission:
          "run_id" in id
            ? {
                kind: "run",
                identity: id,
                native_source: {
                  provider_session_id: nativeSource.providerSessionId,
                  native_generation: nativeSource.nativeGeneration,
                },
              }
            : { kind: "native_session", identity: id },
      });
    initial.forEach((id) => admit(id));
    let subscribed = false;
    let unsubscribed = false;
    const request: AgentRuntimeProcessConnection["request"] = <M extends AgentRuntimeMethod>(
      method: M,
      input: AgentRuntimeOperations[M]["input"],
    ) =>
      Effect.sync(() => {
        if (method === "execution.observe") {
          assert.isTrue(subscribed);
          return {
            subscribed: true,
            subscriptionId: "lifecycle",
            afterSequence: 0,
          } as AgentRuntimeOperations[M]["output"];
        }
        if (method === "events.unobserve") {
          unsubscribed = true;
          return { unsubscribed: true } as AgentRuntimeOperations[M]["output"];
        }
        if (method === "native-session.authority") {
          const native = input as AgentRuntimeOperations["native-session.authority"]["input"];
          reads.push(`native:${native.incarnationId}`);
          return (
            nativeLive.has(native.incarnationId)
              ? {
                  providerSessionId: native.providerSessionId,
                  nativeGeneration: native.nativeGeneration,
                  status: null,
                  runtimeId: "runtime",
                  runtimeGeneration: "generation",
                }
              : null
          ) as AgentRuntimeOperations[M]["output"];
        }
        if (method !== "thread.authority")
          throw Error("Transcript read attempted by authority observer");
        const thread = (input as AgentRuntimeOperations["thread.authority"]["input"]).threadId;
        reads.push(thread);
        return (
          live.has(thread)
            ? {
                providerSessionId: source.providerSessionId,
                nativeGeneration: source.nativeGeneration,
                status: "running",
                runtimeId: "runtime",
                runtimeGeneration: "generation",
              }
            : null
        ) as AgentRuntimeOperations[M]["output"];
      }).pipe(
        Effect.tap(() =>
          reads.filter((thread) => thread === "child").length === 2
            ? Deferred.succeed(repaired, undefined)
            : Effect.void,
        ),
      );
    const connection: AgentRuntimeProcessConnection = {
      identity: {
        runtimeId: "runtime",
        runtimeGeneration: "generation",
        schemaVersion: 1,
        databasePath: "/runtime.sqlite",
        mcpEndpoint: "http://localhost:1/mcp",
        lastSequence: 0,
      },
      request,
      terminated: Deferred.await(ended),
      notifications: Stream.fromPubSub(events),
      subscribeNotifications: PubSub.subscribe(events).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            subscribed = true;
          }),
        ),
        Effect.map(Stream.fromSubscription),
      ),
      subscribeExecutionNotifications: PubSub.subscribe(events).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            subscribed = true;
          }),
        ),
        Effect.map(Stream.fromSubscription),
      ),
    };
    const revoke = (id: AgentRuntimeAuthorityIdentity) =>
      Effect.sync(() => {
        const record = records.find(
          (record) => JSON.stringify(record.admission.identity) === JSON.stringify(id),
        );
        if (record?.active) {
          record.active = false;
          revoked.push(id);
        }
      }).pipe(
        Effect.andThen(Deferred.succeed(retired, undefined)),
        Effect.andThen(
          Effect.suspend(() =>
            revoked.length >= 2 ? Deferred.succeed(allRetired, undefined) : Effect.void,
          ),
        ),
        Effect.asVoid,
      );
    const leases = yield* make(
      connection,
      {
        revoke,
        revokeNativeSource: (native) =>
          Effect.forEach(
            records.filter((record) => {
              if (!record.active) return false;
              const id = record.admission.identity;
              const captured =
                record.admission.kind === "run"
                  ? record.admission.native_source
                  : record.admission.identity;
              return (
                id.runtime_id === "runtime" &&
                id.lease_id === "generation" &&
                captured.provider_session_id === native.providerSessionId &&
                captured.native_generation === native.nativeGeneration
              );
            }),
            (record) => revoke(record.admission.identity),
            { discard: true },
          ),
        readAdmissions: (after) =>
          Effect.sync(() => {
            rosterReads.push(after);
            const candidates = records
              .map((record, index) => ({ ...record, index }))
              .filter((record) => record.active && record.index > Number(after ?? -1));
            return {
              items: candidates.slice(0, 1).map((record) => record.admission),
              next_cursor: candidates.length > 1 ? String(candidates[0]!.index) : null,
              authority: { projection_revision: 1 },
            };
          }),
      },
      Deferred.succeed(failed, undefined).pipe(Effect.asVoid),
      {
        finish: (...args) => presentationFinished.push(["run", ...args]),
        finishRuntimeSource: (value) => presentationFinished.push(["source", value]),
        finishRuntimeLease: (...args) => presentationFinished.push(["lease", ...args]),
      },
    );
    const publish = (
      delivery: number,
      threadId: string,
      status: "completed" | "running" | "cancelled",
      generation = "generation",
    ) =>
      PubSub.publish(events, {
        delivery,
        notification: {
          type: "execution.lifecycle",
          subscriptionId: "lifecycle",
          runtimeGeneration: generation,
          sequence: delivery,
          threadId,
          eventType: "run.updated",
          runId: "run",
          runStatus: status,
        },
      });
    const close = (delivery: number, nativeGeneration = 1, runtimeGeneration = "generation") =>
      PubSub.publish(events, {
        delivery,
        notification: {
          type: "execution.native-session.closed",
          runtimeId: "runtime",
          runtimeGeneration,
          providerSessionId: "provider-session",
          nativeGeneration,
          incarnationId: "incarnation:one",
        },
      });
    return {
      leases,
      live,
      nativeLive,
      reads,
      rosterReads,
      revoked,
      presentationFinished,
      retired,
      allRetired,
      repaired,
      failed,
      publish,
      close,
      events,
      admit,
      unsubscribed: () => unsubscribed,
    };
  });

it.live(
  "completed Run tools stay live while cancellation revokes the exact Run without a roster read",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.leases.track(identity(), source);
      yield* f.leases.track(identity("child"), source);
      yield* f.publish(1, "root", "completed", "old-generation");
      yield* f.publish(2, "root", "completed");
      yield* f.publish(3, "root", "cancelled");
      yield* Deferred.await(f.retired).pipe(Effect.timeout("2 seconds"));
      yield* Effect.yieldNow;
      assert.deepEqual(f.revoked, [identity()]);
      assert.deepEqual(f.presentationFinished, [["run", "root", "run"]]);
      assert.deepEqual(f.reads, ["root", "child"]);
      assert.deepEqual(f.rosterReads, []);
    }).pipe(Effect.scoped),
);
it.live("skipped lifecycle deliveries reconcile the durable roster in bounded metadata pages", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.leases.track(identity(), source);
    yield* f.leases.track(identity("child"), source);
    yield* f.publish(1, "root", "running");
    f.live.delete("root");
    yield* f.publish(7, "child", "running");
    yield* Deferred.await(f.retired).pipe(Effect.timeout("2 seconds"));
    yield* Deferred.await(f.repaired).pipe(Effect.timeout("2 seconds"));
    yield* Effect.yieldNow;
    assert.deepEqual(f.revoked, [identity()]);
    assert.deepEqual(f.presentationFinished, [["run", "root", "run"]]);
    assert.deepEqual(f.reads, ["root", "child", "root", "child"]);
    assert.deepEqual(f.rosterReads, [undefined, "0"]);
  }).pipe(Effect.scoped),
);
it.live("a failed lifecycle stream closes authority and releases its subscription", () =>
  Effect.gen(function* () {
    let f: Effect.Success<ReturnType<typeof fixture>> | undefined;
    yield* Effect.gen(function* () {
      f = yield* fixture();
      yield* PubSub.publish(f.events, {
        delivery: 1,
        notification: { type: "event.error", subscriptionId: "lifecycle", message: "failure" },
      });
      yield* Deferred.await(f.failed).pipe(Effect.timeout("2 seconds"));
    }).pipe(Effect.scoped);
    assert.isTrue(f!.unsubscribed());
    assert.deepEqual(f!.presentationFinished, [["lease", "runtime", "generation"]]);
  }),
);
it.live(
  "physical source close revokes completed Run and native actors without retaining or scanning their history",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture([]);
      const native = (
        incarnation_id: string,
        native_generation = 1,
      ): AgentRuntimeAuthorityIdentity => ({
        runtime_id: "runtime",
        lease_id: "generation",
        thread_id: "root",
        provider_session_id: "provider-session",
        native_generation,
        incarnation_id,
      });
      f.admit(identity());
      f.admit(native("incarnation:one"));
      f.admit(native("incarnation:next", 2));
      // The completed Run is deliberately never tracked in Main; Core owns its source binding.
      yield* f.leases.track(native("incarnation:one"), source);
      yield* f.leases.track(native("incarnation:next", 2), { ...source, nativeGeneration: 2 });
      yield* f.publish(1, "root", "completed");
      yield* f.close(2, 2, "old-generation");
      yield* f.close(3);
      yield* Deferred.await(f.allRetired).pipe(Effect.timeout("2 seconds"));
      yield* Effect.yieldNow;
      assert.deepEqual(f.revoked, [identity(), native("incarnation:one")]);
      assert.deepEqual(f.presentationFinished, [
        [
          "source",
          {
            runtimeId: "runtime",
            runtimeGeneration: "generation",
            providerSessionId: "provider-session",
            nativeGeneration: 1,
          },
        ],
      ]);
      assert.deepEqual(f.reads, ["native:incarnation:one", "native:incarnation:next"]);
      assert.deepEqual(f.rosterReads, []);
    }).pipe(Effect.scoped),
);
