import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import type { DocumentSyncRealtimeEvent } from "../../shared/block-documents/document-sync";
import type {
  CoreEventEnvelope,
  DocumentLiveBarrier,
  DocumentLiveRepair,
} from "../core-client/types";
import {
  documentLiveRuntimeError,
  make,
  type DocumentLivePhysicalSubscription,
  type DocumentLiveSubscriptionInput,
} from "./DocumentLiveRuntime";

const barrier: DocumentLiveBarrier = {
  store_epoch: "epoch:test",
  core_generation: "generation:test",
  document_id: "document:test",
  document_generation: 1,
  head_seq: 3,
  commit_head: 7,
  engine: "yjs",
};

const repair: DocumentLiveRepair = {
  document_id: barrier.document_id,
  store_epoch: barrier.store_epoch,
  document_generation: barrier.document_generation,
  head_seq: barrier.head_seq,
  commit_head: 8,
  reason: "receiver_lagged",
};

interface PendingOpening {
  readonly opened: Deferred.Deferred<
    DocumentLivePhysicalSubscription,
    ReturnType<typeof documentLiveRuntimeError>
  >;
  readonly done: Deferred.Deferred<void, ReturnType<typeof documentLiveRuntimeError>>;
  readonly onEvent: (event: CoreEventEnvelope) => void;
  readonly onRepair: (repair: DocumentLiveRepair) => void;
  readonly onRealtime: (event: DocumentSyncRealtimeEvent) => void;
  closeCount: number;
  interruptedCount: number;
}

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Document live condition did not settle: ${label}`));
  });

const makeHarness = Effect.gen(function* () {
  const ownerScope = yield* Scope.make();
  const runtime = yield* make.pipe(Effect.provideService(Scope.Scope, ownerScope));
  const openings: PendingOpening[] = [];
  const observations: string[] = [];
  const events: CoreEventEnvelope[] = [];

  const input: DocumentLiveSubscriptionInput = {
    open: (onEvent, onRepair, onRealtime) =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<
          DocumentLivePhysicalSubscription,
          ReturnType<typeof documentLiveRuntimeError>
        >();
        const done = yield* Deferred.make<void, ReturnType<typeof documentLiveRuntimeError>>();
        const opening: PendingOpening = {
          opened,
          done,
          onEvent,
          onRepair,
          onRealtime,
          closeCount: 0,
          interruptedCount: 0,
        };
        openings.push(opening);
        return yield* Deferred.await(opened).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              opening.interruptedCount += 1;
            }),
          ),
        );
      }),
    onEvent: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    onRepair: () =>
      Effect.sync(() => {
        observations.push("repair");
      }),
    onRealtime: () => Effect.void,
    onOpened: () => Effect.void,
    onInterrupted: (cause) =>
      Effect.sync(() => {
        observations.push(cause === null ? "interrupted:null" : "interrupted:error");
      }),
    onConnectionStateChanged: (state) =>
      Effect.sync(() => {
        observations.push(state);
      }),
    shouldRetry: () => true,
    maxInitialOpenAttempts: 3,
    retryDelay: "10 millis",
    maxRetryDelay: "40 millis",
  };

  const activate = (opening: PendingOpening): Effect.Effect<void> => {
    let closed = false;
    return Deferred.succeed(opening.opened, {
      barrier,
      done: Deferred.await(opening.done),
      close: Effect.sync(() => {
        if (closed) return;
        closed = true;
        opening.closeCount += 1;
        Deferred.doneUnsafe(opening.done, Effect.void);
      }),
    }).pipe(Effect.asVoid);
  };

  return { activate, events, input, observations, openings, ownerScope, runtime };
});

it.effect("disconnects and closes the old lease before delivering repair", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const lease = yield* harness.runtime.subscribe(harness.input);
    yield* waitUntil("first opening", () => harness.openings.length === 1);
    yield* harness.activate(harness.openings[0]!);
    yield* lease.ready;
    assert.deepEqual(harness.observations, ["connected"]);

    harness.openings[0]!.onRepair(repair);
    yield* waitUntil("replacement opening", () => harness.openings.length === 2);
    assert.deepEqual(harness.observations.slice(0, 3), ["connected", "disconnected", "repair"]);
    assert.strictEqual(harness.openings[0]!.closeCount, 1);

    yield* lease.close;
    yield* lease.done;
    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);

it.effect("backs off through Effect Clock after a failed opening", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const lease = yield* harness.runtime.subscribe(harness.input);
    yield* waitUntil("failed opening", () => harness.openings.length === 1);
    yield* Deferred.fail(
      harness.openings[0]!.opened,
      documentLiveRuntimeError("test.open", new Error("offline")),
    );
    yield* waitUntil("retry wait", () => harness.observations.includes("interrupted:error"));
    yield* TestClock.adjust("9 millis");
    yield* Effect.yieldNow;
    assert.strictEqual(harness.openings.length, 1);
    yield* TestClock.adjust("1 millis");
    yield* waitUntil("retry opening", () => harness.openings.length === 2);

    yield* harness.activate(harness.openings[1]!);
    yield* lease.ready;
    yield* lease.close;
    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);

it.effect("interrupts an opening and settles its public lease on close", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const lease = yield* harness.runtime.subscribe(harness.input);
    yield* waitUntil("pending opening", () => harness.openings.length === 1);
    yield* lease.close;
    yield* waitUntil("opening interruption", () => harness.openings[0]!.interruptedCount === 1);
    harness.openings[0]!.onEvent({} as CoreEventEnvelope);
    yield* Effect.yieldNow;
    assert.lengthOf(harness.events, 0);
    yield* lease.done;
    const ready = yield* Effect.flip(lease.ready);
    assert.strictEqual(ready.operation, "subscription.closed");
    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);

it.effect("bounds callback ingress before the physical barrier", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const lease = yield* harness.runtime.subscribe(harness.input);
    yield* waitUntil("overflowing opening", () => harness.openings.length === 1);
    for (let index = 0; index < 513; index += 1) {
      harness.openings[0]!.onEvent({ sequence: index } as unknown as CoreEventEnvelope);
    }
    yield* waitUntil("overflow interruption", () => harness.openings[0]!.interruptedCount === 1);
    assert.lengthOf(harness.events, 0);
    yield* TestClock.adjust("10 millis");
    yield* waitUntil("overflow retry", () => harness.openings.length === 2);
    yield* lease.close;
    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);

it.effect("wakes a disconnected retry when recovery is explicitly requested", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const lease = yield* harness.runtime.subscribe(harness.input);
    yield* waitUntil("first opening", () => harness.openings.length === 1);
    yield* harness.activate(harness.openings[0]!);
    yield* lease.ready;
    const connectionVersion = yield* lease.waitUntilConnected;
    yield* Deferred.succeed(harness.openings[0]!.done, undefined);
    yield* waitUntil("disconnected", () => harness.observations.includes("disconnected"));
    const reconnected = yield* Effect.forkChild(
      lease.reconnectAfterSubscriptionLoss(connectionVersion),
    );
    yield* waitUntil("explicit retry opening", () => harness.openings.length === 2);
    yield* harness.activate(harness.openings[1]!);
    yield* Fiber.join(reconnected);
    yield* lease.close;
    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);

it.effect("does not retire a replacement for a late failure from an older connection", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness;
    const lease = yield* harness.runtime.subscribe(harness.input);
    yield* waitUntil("first opening", () => harness.openings.length === 1);
    yield* harness.activate(harness.openings[0]!);
    const oldVersion = yield* lease.waitUntilConnected;
    const first = yield* Effect.forkChild(lease.reconnectAfterSubscriptionLoss(oldVersion));
    const concurrent = yield* Effect.forkChild(lease.reconnectAfterSubscriptionLoss(oldVersion));
    yield* waitUntil("disconnected", () => harness.observations.includes("disconnected"));
    yield* TestClock.adjust("10 millis");
    yield* waitUntil("replacement", () => harness.openings.length === 2);
    yield* harness.activate(harness.openings[1]!);
    yield* Fiber.join(first);
    yield* Fiber.join(concurrent);
    yield* lease.reconnectAfterSubscriptionLoss(oldVersion);
    assert.strictEqual(harness.openings.length, 2);
    assert.strictEqual(harness.openings[1]!.closeCount, 0);
    assert.isAbove(yield* lease.waitUntilConnected, oldVersion);
    yield* lease.close;
    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);
