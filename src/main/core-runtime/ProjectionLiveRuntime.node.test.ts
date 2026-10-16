import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import type { ProjectionScope } from "../../shared/projection-stream";
import type {
  CoreEventEnvelope,
  ProjectionLiveBarrier,
  ProjectionLiveRepair,
} from "../core-client/types";
import {
  make,
  type ProjectionLiveRuntimeOptions,
  type ProjectionLiveSubscription,
} from "./ProjectionLiveRuntime";

const projectScope = (projectId: string): ProjectionScope => ({
  kind: "project",
  libraryId: "library-1",
  projectId,
});

const barrierFor = (
  scopes: readonly ProjectionScope[],
  commitHead: number,
): ProjectionLiveBarrier => ({
  store_epoch: "epoch-1",
  core_generation: "generation-1",
  commit_head: commitHead,
  recipient_leases: scopes.map((candidate, index) => {
    const address =
      candidate.kind === "library"
        ? { kind: "library" as const, library_id: candidate.libraryId }
        : {
            kind: "project" as const,
            library_id: candidate.libraryId,
            project_id: candidate.projectId,
          };
    return {
      lease_id: String(index + 1)
        .padStart(64, "a")
        .slice(-64),
      delivery_address: address,
    };
  }),
});

interface PendingLease {
  readonly scopes: readonly ProjectionScope[];
  readonly opened: Deferred.Deferred<ProjectionLiveSubscription>;
  readonly done: Deferred.Deferred<void>;
  readonly onEvent: (event: CoreEventEnvelope) => void;
  readonly onRepair: (repair: ProjectionLiveRepair) => void;
  closeCount: number;
  interruptedCount: number;
}

interface BarrierObservation {
  readonly barrier: ProjectionLiveBarrier;
  readonly scopes: readonly ProjectionScope[];
  readonly resetScopes: readonly ProjectionScope[];
  readonly checkpointScopes: readonly ProjectionScope[];
}

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Projection live condition did not settle: ${label}`));
  });

const makeHarness = (
  hooks: Partial<Pick<ProjectionLiveRuntimeOptions, "onPacket" | "onBarrier">> = {},
) =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    const leases: PendingLease[] = [];
    const packets: CoreEventEnvelope[] = [];
    const repairs: ProjectionLiveRepair[] = [];
    const barriers: BarrierObservation[] = [];

    const open: ProjectionLiveRuntimeOptions["open"] = (scopes, onEvent, onRepair) =>
      Effect.gen(function* () {
        const opened = yield* Deferred.make<ProjectionLiveSubscription>();
        const done = yield* Deferred.make<void>();
        const lease: PendingLease = {
          scopes,
          opened,
          done,
          onEvent,
          onRepair,
          closeCount: 0,
          interruptedCount: 0,
        };
        leases.push(lease);
        return yield* Deferred.await(opened).pipe(
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              lease.interruptedCount += 1;
            }),
          ),
        );
      });

    const runtime = yield* make({
      open,
      onPacket: (packet) =>
        (hooks.onPacket?.(packet) ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              packets.push(packet);
            }),
          ),
        ),
      onBarrier: (barrier, scopes, resetScopes, checkpointScopes) =>
        (hooks.onBarrier?.(barrier, scopes, resetScopes, checkpointScopes) ?? Effect.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              barriers.push({ barrier, scopes, resetScopes, checkpointScopes });
            }),
          ),
        ),
      onRepair: (repair) =>
        Effect.sync(() => {
          repairs.push(repair);
        }),
      retryDelay: "10 millis",
    }).pipe(Effect.provideService(Scope.Scope, ownerScope));

    const activate = (
      lease: PendingLease,
      commitHead: number,
      storeEpoch = "epoch-1",
    ): Effect.Effect<void> =>
      Deferred.succeed(lease.opened, {
        barrier: { ...barrierFor(lease.scopes, commitHead), store_epoch: storeEpoch },
        done: Deferred.await(lease.done),
        close: Effect.sync(() => {
          lease.closeCount += 1;
        }),
      }).pipe(Effect.asVoid);

    return { activate, barriers, leases, ownerScope, packets, repairs, runtime };
  });

it.effect("keeps the old lease authoritative until the replacement barrier", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const firstScopes = [projectScope("project-1")];
    const replacementScopes = [...firstScopes, projectScope("project-2")];

    yield* harness.runtime.setScopes(firstScopes);
    yield* waitUntil("first open", () => harness.leases.length === 1);
    yield* harness.activate(harness.leases[0]!, 1);
    yield* waitUntil("first barrier", () => harness.barriers.length === 1);
    assert.deepEqual(harness.barriers[0]!.resetScopes, []);
    assert.deepEqual(harness.barriers[0]!.checkpointScopes, firstScopes);

    yield* harness.runtime.setScopes(replacementScopes);
    yield* waitUntil("replacement open", () => harness.leases.length === 2);
    assert.strictEqual(harness.leases[0]!.closeCount, 0);

    const activePacket = {} as CoreEventEnvelope;
    const bufferedPacket = {} as CoreEventEnvelope;
    harness.leases[0]!.onEvent(activePacket);
    harness.leases[1]!.onEvent(bufferedPacket);
    yield* waitUntil("old lease delivery", () => harness.packets.length === 1);
    assert.deepEqual(harness.packets, [activePacket]);

    yield* harness.activate(harness.leases[1]!, 2);
    yield* waitUntil(
      "replacement installation",
      () => harness.barriers.length === 2 && harness.packets.length === 2,
    );
    assert.strictEqual(harness.leases[0]!.closeCount, 1);
    assert.deepEqual(harness.packets, [activePacket, bufferedPacket]);
    assert.deepEqual(harness.barriers[1], {
      barrier: barrierFor(replacementScopes, 2),
      scopes: replacementScopes,
      resetScopes: [],
      checkpointScopes: replacementScopes,
    });

    harness.leases[0]!.onEvent({} as CoreEventEnvelope);
    yield* Effect.yieldNow;
    assert.strictEqual(harness.packets.length, 2);
    assert.deepEqual(yield* harness.runtime.diagnostics, {
      activeScopes: 2,
      connected: true,
      generation: 2,
    });

    yield* Scope.close(harness.ownerScope, Exit.void);
    assert.strictEqual(harness.leases[1]!.closeCount, 1);
  }),
);

it.effect("finishes the old consumer before installing a new epoch barrier", () =>
  Effect.gen(function* () {
    const blockedPacket = { sequence: 1 } as unknown as CoreEventEnvelope;
    const newPacket = { sequence: 2 } as unknown as CoreEventEnvelope;
    let oldPacketStarted = false;
    let oldPacketInterrupted = false;
    const harness = yield* makeHarness({
      onPacket: (packet) =>
        packet === blockedPacket
          ? Effect.sync(() => {
              oldPacketStarted = true;
            }).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  oldPacketInterrupted = true;
                }),
              ),
            )
          : Effect.void,
      onBarrier: (barrier) =>
        Effect.sync(() => {
          if (barrier.store_epoch === "epoch-2") assert.isTrue(oldPacketInterrupted);
        }),
    });
    yield* harness.runtime.setScopes([projectScope("project-1")]);
    yield* waitUntil("first open", () => harness.leases.length === 1);
    yield* harness.activate(harness.leases[0]!, 1);
    yield* waitUntil("first barrier", () => harness.barriers.length === 1);
    harness.leases[0]!.onEvent(blockedPacket);
    yield* waitUntil("old consumer blocked", () => oldPacketStarted);
    yield* harness.runtime.setScopes([projectScope("project-1"), projectScope("project-2")]);
    yield* waitUntil("new open", () => harness.leases.length === 2);
    harness.leases[1]!.onEvent(newPacket);
    yield* harness.activate(harness.leases[1]!, 0, "epoch-2");
    yield* waitUntil(
      "new barrier and packet",
      () => harness.barriers.length === 2 && harness.packets.length === 1,
    );
    assert.deepEqual(harness.packets, [newPacket]);
    assert.strictEqual(harness.leases[0]!.closeCount, 1);
    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);

it.effect("backs off and repairs every desired scope after a live lease ends", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const desired = [projectScope("project-1"), projectScope("project-2")];

    yield* harness.runtime.setScopes(desired);
    yield* waitUntil("first open", () => harness.leases.length === 1);
    yield* harness.activate(harness.leases[0]!, 1);
    yield* waitUntil("first barrier", () => harness.barriers.length === 1);
    yield* Deferred.succeed(harness.leases[0]!.done, undefined);
    yield* waitUntil("first lease close", () => harness.leases[0]!.closeCount === 1);
    assert.strictEqual(harness.leases.length, 1);

    yield* TestClock.adjust("10 millis");
    yield* waitUntil("reconnect open", () => harness.leases.length === 2);
    yield* harness.activate(harness.leases[1]!, 2);
    yield* waitUntil("reconnect barrier", () => harness.barriers.length === 2);
    assert.deepEqual(harness.barriers[1]!.resetScopes, desired);
    assert.deepEqual(harness.barriers[1]!.checkpointScopes, []);

    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);

it.effect(
  "preserves recovery scopes while separately initializing scopes added during reconnect",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const original = projectScope("project-1");
      const added = projectScope("project-2");
      yield* harness.runtime.setScopes([original]);
      yield* waitUntil("initial open", () => harness.leases.length === 1);
      yield* harness.activate(harness.leases[0]!, 1);
      yield* waitUntil("initial barrier", () => harness.barriers.length === 1);
      yield* Deferred.succeed(harness.leases[0]!.done, undefined);
      yield* waitUntil("disconnected lease", () => harness.leases[0]!.closeCount === 1);
      yield* harness.runtime.setScopes([original, added]);
      yield* waitUntil("expanded reconnect", () => harness.leases.length === 2);
      yield* harness.activate(harness.leases[1]!, 2);
      yield* waitUntil("expanded barrier", () => harness.barriers.length === 2);
      assert.deepEqual(harness.barriers[1]!.resetScopes, [original]);
      assert.deepEqual(harness.barriers[1]!.checkpointScopes, [added]);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
);

it.effect("keeps the active lease when scope churn returns to its exact set", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const stable = [projectScope("project-1")];

    yield* harness.runtime.setScopes(stable);
    yield* waitUntil("stable open", () => harness.leases.length === 1);
    yield* harness.activate(harness.leases[0]!, 1);
    yield* waitUntil("stable barrier", () => harness.barriers.length === 1);

    yield* harness.runtime.setScopes([...stable, projectScope("project-2")]);
    yield* waitUntil("expanded open", () => harness.leases.length === 2);
    yield* harness.runtime.setScopes(stable);
    yield* waitUntil("expanded open interruption", () => harness.leases[1]!.interruptedCount === 1);
    assert.strictEqual(harness.leases[0]!.closeCount, 0);
    assert.strictEqual(harness.leases.length, 2);

    yield* Deferred.succeed(harness.leases[0]!.done, undefined);
    yield* waitUntil("stable lease close", () => harness.leases[0]!.closeCount === 1);
    yield* TestClock.adjust("10 millis");
    yield* waitUntil("stable reconnect", () => harness.leases.length === 3);
    assert.deepEqual(harness.leases[2]!.scopes, stable);

    yield* Scope.close(harness.ownerScope, Exit.void);
    yield* waitUntil(
      "pending reconnect interruption",
      () => harness.leases[2]!.interruptedCount === 1,
    );
  }),
);

it.effect("canonicalizes scope requests and rejects an unbounded broker", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();

    yield* harness.runtime.setScopes([projectScope("project-1"), projectScope("project-1")]);
    yield* waitUntil("deduplicated open", () => harness.leases.length === 1);
    assert.deepEqual(harness.leases[0]!.scopes, [projectScope("project-1")]);

    const failure = yield* Effect.flip(
      harness.runtime.setScopes(
        Array.from({ length: 201 }, (_, index) => projectScope(`project-${index}`)),
      ),
    );
    assert.strictEqual(failure.operation, "scopes.canonicalize");
    assert.instanceOf(failure.cause, RangeError);

    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);

it.effect("closes the exact active lease and fences late callbacks with its owner Scope", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const desired = [projectScope("project-1")];

    yield* harness.runtime.setScopes(desired);
    yield* waitUntil("active open", () => harness.leases.length === 1);
    yield* harness.activate(harness.leases[0]!, 1);
    yield* waitUntil("active barrier", () => harness.barriers.length === 1);
    yield* Scope.close(harness.ownerScope, Exit.void);

    assert.strictEqual(harness.leases[0]!.closeCount, 1);
    assert.deepEqual(yield* harness.runtime.diagnostics, {
      activeScopes: 0,
      connected: false,
      generation: 2,
    });
    const closed = yield* Effect.flip(harness.runtime.setScopes(desired));
    assert.strictEqual(closed.operation, "scopes.closed");

    harness.leases[0]!.onEvent({} as CoreEventEnvelope);
    harness.leases[0]!.onRepair({
      store_epoch: "epoch-1",
      commit_head: 2,
      reason: "receiver_lagged",
    });
    yield* Effect.yieldNow;
    assert.lengthOf(harness.packets, 0);
    assert.lengthOf(harness.repairs, 0);
  }),
);

it.effect("preserves callback order across a live packet burst", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();

    yield* harness.runtime.setScopes([projectScope("project-1")]);
    yield* waitUntil("ordered open", () => harness.leases.length === 1);
    yield* harness.activate(harness.leases[0]!, 1);
    yield* waitUntil("ordered barrier", () => harness.barriers.length === 1);

    const packets = Array.from(
      { length: 128 },
      (_, sequence) => ({ sequence }) as unknown as CoreEventEnvelope,
    );
    for (const packet of packets) harness.leases[0]!.onEvent(packet);
    yield* waitUntil("ordered delivery", () => harness.packets.length === packets.length);
    assert.deepEqual(harness.packets, packets);

    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);

it.effect("drops an overflowing pre-barrier attempt and retries through Effect Clock", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();

    yield* harness.runtime.setScopes([projectScope("project-1")]);
    yield* waitUntil("overflowing open", () => harness.leases.length === 1);
    for (let index = 0; index < 513; index += 1) {
      harness.leases[0]!.onEvent({} as CoreEventEnvelope);
    }
    yield* waitUntil("overflow interruption", () => harness.leases[0]!.interruptedCount === 1);
    assert.lengthOf(harness.packets, 0);

    yield* TestClock.adjust("10 millis");
    yield* waitUntil("overflow retry", () => harness.leases.length === 2);
    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);
