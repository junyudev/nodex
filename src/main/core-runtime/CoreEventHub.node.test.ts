import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import type {
  CoreEventEnvelope,
  CoreEventReplayRequired,
  CoreStreamCheckpoint,
} from "../core-client/types";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import { createCoreLocalCommitFixture } from "../core-client/testing/local-commit-fixture";
import { CoreAuthority, CoreSessionAccess } from "./CoreAuthority";
import {
  CoreEventHub,
  deliveryFrom,
  live as eventHubLive,
  type CoreEventDeliveryService,
  type CoreEventHubService,
} from "./CoreEventHub";
import { CoreTransportError } from "../core-client/uds-http";
import { classifyCoreOperationFailure, coreRuntimeError } from "./CoreRuntimeError";

interface OpenedStream {
  readonly after: number;
  readonly onEvent: (event: CoreEventEnvelope) => void;
  readonly onCheckpoint: (checkpoint: CoreStreamCheckpoint) => void;
  readonly onResync: (boundary: CoreEventReplayRequired) => void;
  readonly finish: () => void;
  readonly fail: (cause: unknown) => void;
}

const envelope = (sequence: number): CoreEventEnvelope => ({
  transport_version: 4,
  packet: createCoreLocalCommitFixture({
    commitSeq: sequence,
    storeEpoch: "epoch:test",
    committedAt: "2026-08-21T00:00:00.000Z",
    payload: {
      module: "project_workspace",
      library_id: "library-a",
      event: {
        kind: "workspace_changed",
        project_ids: [],
        session_ids: [],
        thread_ids: [],
        session_summary_scopes: [],
        session_detail_ids: [],
      },
    },
    canonicalHash: "0".repeat(64),
  }),
});

const checkpoint = (sequence: number): CoreStreamCheckpoint => ({
  store_epoch: "epoch:test",
  generation: "generation:test",
  scanned_through_seq: sequence,
  oldest_available_seq: 0,
  resync_token: null,
});

const eventClient = (opened: OpenedStream[]): CoreGenerationClient => {
  const handshake = createFakeCoreHandshake({
    profileId: "profile-a",
    libraryId: "library-a",
    storeEpoch: "epoch:test",
    connectionBinding: "binding-a",
  });
  const resolvedHandshake = {
    ...handshake,
    generation: { ...handshake.generation, start_nonce: "generation-a" },
  };
  const health = (): ReturnType<CoreGenerationClient["health"]> =>
    Promise.resolve({
      pid: 1,
      start_nonce: "generation-a",
      status: "ready" as const,
    } as Awaited<ReturnType<CoreGenerationClient["health"]>>);
  const client = new FakeCoreClient();
  return Object.assign(client, {
    handshake: resolvedHandshake,
    forProject: () => eventClient(opened),
    health,
    shutdown: () => Promise.resolve({ status: "draining" as const }),
    openEventStream: (
      after: number,
      onEvent: (event: CoreEventEnvelope) => void,
      onCheckpoint: (value: CoreStreamCheckpoint) => void,
      onResync: (boundary: CoreEventReplayRequired) => void,
    ) => {
      const completion = new EventEmitter();
      const done = once(completion, "done").then(() => undefined);
      const finish = (): void => {
        completion.emit("done");
      };
      opened.push({
        after,
        onEvent,
        onCheckpoint,
        onResync,
        finish,
        fail: (cause) => {
          completion.emit("error", cause);
        },
      });
      return Promise.resolve({ done, close: finish });
    },
  });
};

const accessLayer = (client: CoreGenerationClient): Layer.Layer<CoreSessionAccess> =>
  Layer.succeed(
    CoreSessionAccess,
    CoreSessionAccess.of({
      use: (operation, run) =>
        Effect.tryPromise({
          try: (signal) => run(client, signal),
          catch: (cause) =>
            classifyCoreOperationFailure(operation, cause, client.handshake.generation.start_nonce),
        }),
      handshake: Effect.succeed(client.handshake),
    }),
  );

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Core event test condition did not settle: ${label}`));
  });

const waitForBackoff = (hub: CoreEventHubService) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((yield* SubscriptionRef.get(hub.connection)).kind === "backing-off") return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("Core event hub did not enter backoff"));
  });

const waitForCursor = (hub: CoreEventHubService, cursor: number) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((yield* hub.cursor) === cursor) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error("Core event cursor did not advance"));
  });

const buildHub = (
  client: CoreGenerationClient,
  delivery: CoreEventDeliveryService,
  scope: Scope.Closeable,
  failApplication: CoreAuthority["Service"]["failApplication"] = () => Effect.succeed(true),
  options: Partial<Parameters<typeof eventHubLive>[0]> = {},
) =>
  Layer.buildWithScope(
    eventHubLive({
      initialAfter: 0,
      retryBase: "1 second",
      retryCap: "1 second",
      jitter: false,
      ...options,
    }).pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          accessLayer(client),
          deliveryFrom(delivery),
          Layer.succeed(
            CoreAuthority,
            CoreAuthority.of({ failApplication } as CoreAuthority["Service"]),
          ),
        ),
      ),
    ),
    scope,
  );

it.effect("advances the durable cursor only after ordered delivery succeeds", () =>
  Effect.gen(function* () {
    const opened: OpenedStream[] = [];
    const delivered: string[] = [];
    const scope = yield* Scope.make();
    const context = yield* buildHub(
      eventClient(opened),
      {
        event: (event) =>
          Effect.sync(() =>
            delivered.push(`event:${event.packet.manifest.identity.commit_seq}`),
          ).pipe(Effect.asVoid),
        checkpoint: (value) =>
          Effect.sync(() => delivered.push(`checkpoint:${value.scanned_through_seq}`)).pipe(
            Effect.asVoid,
          ),
        resync: () => Effect.void,
      },
      scope,
    );
    const hub = Context.get(context, CoreEventHub);
    yield* waitUntil("first stream open", () => opened.length === 1);

    opened[0]!.onEvent(envelope(7));
    opened[0]!.onCheckpoint(checkpoint(7));
    for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow;
    assert.deepEqual(delivered, ["event:7", "checkpoint:7"]);
    assert.strictEqual(yield* hub.cursor, 7);

    opened[0]!.finish();
    yield* waitForBackoff(hub);
    yield* TestClock.adjust("1 second");
    yield* waitUntil("second stream open", () => opened.length === 2);
    assert.deepEqual(
      opened.map((stream) => stream.after),
      [0, 7],
    );
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("replays from the old cursor when reliable delivery fails", () =>
  Effect.gen(function* () {
    const opened: OpenedStream[] = [];
    let deliveries = 0;
    const scope = yield* Scope.make();
    const context = yield* buildHub(
      eventClient(opened),
      {
        event: () => {
          deliveries += 1;
          return deliveries === 1
            ? Effect.fail(
                coreRuntimeError({
                  operation: "events.deliver",
                  reason: "delivery",
                  retryable: true,
                }),
              )
            : Effect.void;
        },
        checkpoint: () => Effect.void,
        resync: () => Effect.void,
      },
      scope,
    );
    const hub = Context.get(context, CoreEventHub);
    yield* waitUntil("first replay stream open", () => opened.length === 1);

    opened[0]!.onEvent(envelope(1));
    yield* waitUntil("failed delivery", () => deliveries === 1);
    yield* waitForBackoff(hub);
    yield* TestClock.adjust("1 second");
    yield* waitUntil("replay stream open", () => opened.length === 2);
    assert.deepEqual(
      opened.map((stream) => stream.after),
      [0, 0],
    );

    opened[1]!.onEvent(envelope(1));
    opened[1]!.onCheckpoint(checkpoint(1));
    yield* waitUntil("successful replay delivery", () => deliveries === 2);
    yield* waitForCursor(hub, 1);
    opened[1]!.finish();
    yield* waitForBackoff(hub);
    yield* TestClock.adjust("1 second");
    yield* waitUntil("checkpointed stream open", () => opened.length === 3);
    assert.strictEqual(opened[2]!.after, 1);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("resyncs explicitly and fences the next subscription at the repaired boundary", () =>
  Effect.gen(function* () {
    const opened: OpenedStream[] = [];
    const boundaries: number[] = [];
    const scope = yield* Scope.make();
    yield* buildHub(
      eventClient(opened),
      {
        event: () => Effect.void,
        checkpoint: () => Effect.void,
        resync: (boundary) =>
          Effect.sync(() => boundaries.push(boundary.commit_head)).pipe(Effect.asVoid),
      },
      scope,
    );
    yield* waitUntil("resync stream open", () => opened.length === 1);
    opened[0]!.onResync({
      requested_after: 0,
      oldest_available: 5,
      commit_head: 9,
      generation: "generation-a",
      resync_token: "resync-a",
    });
    yield* waitUntil("resync delivery", () => boundaries.length === 1);
    yield* waitUntil("post-resync stream open", () => opened.length === 2);
    assert.deepEqual(boundaries, [9]);
    assert.strictEqual(opened[1]!.after, 9);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("fails application health when canonical delivery cannot be replayed", () =>
  Effect.gen(function* () {
    const opened: OpenedStream[] = [];
    const failures: string[] = [];
    const scope = yield* Scope.make();
    const context = yield* buildHub(
      eventClient(opened),
      {
        event: () =>
          Effect.fail(
            coreRuntimeError({
              operation: "events.deliver",
              reason: "delivery",
              retryable: false,
            }),
          ),
        checkpoint: () => Effect.void,
        resync: () => Effect.void,
      },
      scope,
      (error) =>
        Effect.sync(() => {
          failures.push(error.operation);
          return true;
        }),
    );
    const hub = Context.get(context, CoreEventHub);
    yield* waitUntil("terminal stream open", () => opened.length === 1);

    opened[0]!.onEvent(envelope(1));
    yield* waitUntil("application health failure", () => failures.length === 1);

    const connection = yield* SubscriptionRef.get(hub.connection);
    assert.strictEqual(connection.kind, "failed");
    assert.deepEqual(failures, ["events.deliver"]);
    yield* TestClock.adjust("1 hour");
    assert.strictEqual(opened.length, 1);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("reopens from the durable cursor when callback ingress overflows", () =>
  Effect.gen(function* () {
    const opened: OpenedStream[] = [];
    const blocked = yield* Deferred.make<void>();
    let deliveries = 0;
    const fatal: string[] = [];
    const scope = yield* Scope.make();
    const context = yield* buildHub(
      eventClient(opened),
      {
        event: () => {
          deliveries += 1;
          return Deferred.await(blocked);
        },
        checkpoint: () => Effect.void,
        resync: () => Effect.void,
      },
      scope,
      (error) =>
        Effect.sync(() => {
          fatal.push(error.operation);
          return true;
        }),
      { inboundCapacity: 1 },
    );
    const hub = Context.get(context, CoreEventHub);
    yield* waitUntil("capacity stream open", () => opened.length === 1);

    opened[0]!.onEvent(envelope(1));
    yield* waitUntil("first capacity delivery", () => deliveries === 1);
    opened[0]!.onEvent(envelope(2));
    opened[0]!.onEvent(envelope(3));
    yield* waitForBackoff(hub);
    assert.deepEqual(fatal, []);
    yield* TestClock.adjust("1 second");
    yield* waitUntil("capacity replay stream", () => opened.length === 2);
    assert.strictEqual(opened[1]!.after, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);
import { EventEmitter, once } from "node:events";

it.effect(
  "recovers remote stream loss from the committed cursor without failing the application",
  () =>
    Effect.gen(function* () {
      const opened: OpenedStream[] = [];
      const delivered: number[] = [];
      const fatal: string[] = [];
      const scope = yield* Scope.make();
      const context = yield* buildHub(
        eventClient(opened),
        {
          event: (event) =>
            Effect.sync(() => {
              delivered.push(event.packet.manifest.identity.commit_seq);
            }),
          checkpoint: () => Effect.void,
          resync: () => Effect.void,
        },
        scope,
        (error) =>
          Effect.sync(() => {
            fatal.push(error.operation);
            return true;
          }),
      );
      const hub = Context.get(context, CoreEventHub);
      yield* waitUntil("initial stream", () => opened.length === 1);
      opened[0]!.onEvent(envelope(7));
      opened[0]!.onCheckpoint(checkpoint(7));
      yield* waitForCursor(hub, 7);
      opened[0]!.fail(new CoreTransportError("connection_lost", "response", "ECONNRESET", null));
      yield* waitForBackoff(hub);
      yield* TestClock.adjust("1 second");
      yield* waitUntil("replacement stream", () => opened.length === 2);
      assert.strictEqual(opened[1]!.after, 7);
      opened[1]!.onEvent(envelope(8));
      opened[1]!.onCheckpoint(checkpoint(8));
      yield* waitForCursor(hub, 8);
      assert.deepEqual(delivered, [7, 8]);
      assert.deepEqual(fatal, []);
      assert.strictEqual((yield* SubscriptionRef.get(hub.connection)).kind, "ready");
      yield* Scope.close(scope, Exit.void);
    }),
);
