import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import {
  RENDERER_DELIVERY_INLINE_MAX_BYTES,
  type RendererDeliveryDataEnvelope,
  type RendererDeliveryTarget,
  type RendererDeliveryTransferAbortEnvelope,
  type RendererDeliveryTransferAckEnvelope,
} from "../../shared/renderer-delivery-transport";
import {
  make,
  RendererDeliveryAdapter,
  RendererDeliveryAdapterError,
  type RendererDeliveryAdapterService,
  type RendererDeliveryOptions,
} from "./RendererDelivery";

const target = (targetId: string, generation = 1): RendererDeliveryTarget => ({
  targetId,
  generation,
});

const acknowledge = (
  envelope: RendererDeliveryDataEnvelope,
): RendererDeliveryTransferAckEnvelope | null => {
  if (envelope.kind === "inline") return null;
  return {
    version: envelope.version,
    kind: "transferAck",
    targetId: envelope.targetId,
    generation: envelope.generation,
    transferId: envelope.transferId,
    sequence: envelope.sequence,
  };
};

const waitUntil = (label: string, predicate: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(new Error(`Renderer delivery condition did not settle: ${label}`));
  });

const makeHarness = (
  deliver: RendererDeliveryAdapterService["deliver"],
  options: RendererDeliveryOptions = {},
) =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    let nextId = 1;
    const runtime = yield* make({
      deliveryIdFactory: () => `delivery-${nextId++}`,
      ...options,
    }).pipe(
      Effect.provideService(RendererDeliveryAdapter, RendererDeliveryAdapter.of({ deliver })),
      Effect.provideService(Scope.Scope, ownerScope),
    );
    return { ownerScope, runtime };
  });

const closeHarness = (ownerScope: Scope.Scope): Effect.Effect<void> =>
  Scope.close(ownerScope, Exit.void);

it.effect("serializes one target without blocking another target", () =>
  Effect.gen(function* () {
    const firstTargetGate = yield* Deferred.make<void>();
    const delivered: string[] = [];
    const harness = yield* makeHarness((envelope) => {
      if (envelope.kind === "transferAbort") return Effect.succeed(null);
      if (envelope.kind !== "inline") return Effect.succeed(acknowledge(envelope));
      const payload = JSON.parse(new TextDecoder().decode(envelope.payloadUtf8)) as {
        readonly value: string;
      };
      delivered.push(payload.value);
      if (payload.value === "a-1") return Deferred.await(firstTargetGate).pipe(Effect.as(null));
      return Effect.succeed(null);
    });

    const first = yield* harness.runtime.enqueue(target("a"), { value: "a-1" });
    const second = yield* harness.runtime.enqueue(target("a"), { value: "a-2" });
    const independent = yield* harness.runtime.enqueue(target("b"), { value: "b-1" });
    yield* waitUntil("first and independent targets started", () => delivered.length === 2);
    assert.deepEqual(delivered, ["a-1", "b-1"]);

    yield* Deferred.succeed(firstTargetGate, undefined);
    yield* Effect.all([first.completion, second.completion, independent.completion]);
    assert.deepEqual(delivered, ["a-1", "b-1", "a-2"]);
    assert.deepInclude(yield* harness.runtime.metrics, {
      activeTargets: 0,
      pendingCount: 0,
      delivered: 3,
    });
    yield* closeHarness(harness.ownerScope);
  }),
);

it.effect("waits for the exact ACK before sending each chunked frame", () =>
  Effect.gen(function* () {
    const gates = yield* Effect.all(
      Array.from({ length: 5 }, () => Deferred.make<RendererDeliveryTransferAckEnvelope>()),
    );
    const delivered: RendererDeliveryDataEnvelope[] = [];
    const harness = yield* makeHarness((envelope) => {
      if (envelope.kind === "transferAbort") return Effect.succeed(null);
      const index = delivered.push(envelope) - 1;
      return Deferred.await(gates[index]!);
    });
    const receipt = yield* harness.runtime.enqueue(target("chunked"), {
      value: "x".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES + 1),
    });
    assert.strictEqual(receipt.frameCount, 5);

    for (let index = 0; index < receipt.frameCount; index += 1) {
      yield* waitUntil(`frame ${index} started`, () => delivered.length === index + 1);
      assert.strictEqual(delivered.length, index + 1);
      const ack = acknowledge(delivered[index]!);
      if (!ack) return yield* Effect.die(new Error("Chunked frame produced no ACK"));
      yield* Deferred.succeed(gates[index]!, ack);
    }
    yield* receipt.completion;
    assert.deepEqual(
      delivered.map((envelope) => envelope.kind),
      ["transferStart", "transferChunk", "transferChunk", "transferChunk", "transferEnd"],
    );
    assert.strictEqual((yield* harness.runtime.metrics).acknowledgedFrames, 5);
    yield* closeHarness(harness.ownerScope);
  }),
);

it.effect("fails closed at per-target and process count and byte budgets", () =>
  Effect.gen(function* () {
    const never = (): Effect.Effect<never> => Effect.never;

    const targetCount = yield* makeHarness(never, {
      maxPendingPerTarget: 1,
      maxPendingProcess: 4,
    });
    yield* targetCount.runtime.enqueue(target("a"), { value: 1 });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const targetCountError = yield* targetCount.runtime
      .enqueue(target("a"), cyclic as never)
      .pipe(Effect.flip);
    assert.strictEqual(targetCountError.reason, "target-capacity");
    yield* closeHarness(targetCount.ownerScope);

    const processCount = yield* makeHarness(never, {
      maxPendingPerTarget: 4,
      maxPendingProcess: 1,
    });
    yield* processCount.runtime.enqueue(target("a"), { value: 1 });
    const processCountError = yield* processCount.runtime
      .enqueue(target("b"), { value: 2 })
      .pipe(Effect.flip);
    assert.strictEqual(processCountError.reason, "process-capacity");
    yield* closeHarness(processCount.ownerScope);

    const targetBytes = yield* makeHarness(never, {
      maxPendingBytesPerTarget: 8,
      maxPendingBytesProcess: 1_000,
    });
    const targetBytesError = yield* targetBytes.runtime
      .enqueue(target("a"), { value: 1 })
      .pipe(Effect.flip);
    assert.strictEqual(targetBytesError.reason, "target-capacity");
    yield* closeHarness(targetBytes.ownerScope);

    const processBytes = yield* makeHarness(never, {
      maxPendingBytesPerTarget: 1_000,
      maxPendingBytesProcess: 8,
    });
    const processBytesError = yield* processBytes.runtime
      .enqueue(target("a"), { value: 1 })
      .pipe(Effect.flip);
    assert.strictEqual(processBytesError.reason, "process-capacity");
    yield* closeHarness(processBytes.ownerScope);
  }),
);

it.effect("aborts and retries a transfer after a mismatched ACK", () =>
  Effect.gen(function* () {
    let starts = 0;
    const delivered: (RendererDeliveryDataEnvelope | RendererDeliveryTransferAbortEnvelope)[] = [];
    const harness = yield* makeHarness(
      (envelope) => {
        delivered.push(envelope);
        if (envelope.kind === "transferAbort") return Effect.succeed(null);
        if (envelope.kind === "transferStart") starts += 1;
        const ack = acknowledge(envelope);
        if (!ack) return Effect.succeed(null);
        if (starts === 1) return Effect.succeed({ ...ack, sequence: ack.sequence + 1 });
        return Effect.succeed(ack);
      },
      { retryDelay: 0 },
    );
    const receipt = yield* harness.runtime.enqueue(target("retry"), {
      value: "x".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES + 1),
    });

    const completion = yield* receipt.completion;
    assert.strictEqual(completion.attempts, 2);
    assert.strictEqual(starts, 2);
    assert.strictEqual(delivered.filter((envelope) => envelope.kind === "transferAbort").length, 1);
    assert.deepInclude(yield* harness.runtime.metrics, {
      retries: 1,
      wrongAcknowledgments: 1,
      aborts: 1,
    });
    yield* closeHarness(harness.ownerScope);
  }),
);

it.effect("uses the ACK deadline before a bounded retry", () =>
  Effect.gen(function* () {
    let calls = 0;
    const harness = yield* makeHarness(
      () => {
        calls += 1;
        if (calls === 1) return Effect.never;
        return Effect.succeed(null);
      },
      { ackTimeout: "10 millis", retryDelay: "5 millis", maxAttempts: 2 },
    );
    const receipt = yield* harness.runtime.enqueue(target("timeout"), { value: 1 });
    const completion = yield* Effect.forkChild(receipt.completion);
    yield* waitUntil("first send started", () => calls === 1);
    yield* TestClock.adjust("10 millis");
    yield* TestClock.adjust("5 millis");
    yield* Fiber.join(completion);

    assert.strictEqual(calls, 2);
    assert.deepInclude(yield* harness.runtime.metrics, { retries: 1, timeouts: 1 });
    yield* closeHarness(harness.ownerScope);
  }),
);

it.effect("releases queued work when a renderer target is destroyed", () =>
  Effect.gen(function* () {
    let calls = 0;
    let aborts = 0;
    const harness = yield* makeHarness((envelope) => {
      if (envelope.kind === "transferAbort") {
        aborts += 1;
        return Effect.succeed(null);
      }
      calls += 1;
      return Effect.never;
    });
    const first = yield* harness.runtime.enqueue(target("destroyed"), {
      value: "x".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES + 1),
    });
    const second = yield* harness.runtime.enqueue(target("destroyed"), { value: 2 });
    yield* waitUntil("active send started", () => calls === 1);

    yield* harness.runtime.releaseTarget(target("destroyed"));
    const [firstError, secondError] = yield* Effect.all([
      Effect.flip(first.completion),
      Effect.flip(second.completion),
    ]);
    assert.strictEqual(firstError.reason, "released");
    assert.strictEqual(secondError.reason, "released");
    assert.strictEqual(calls, 1);
    assert.strictEqual(aborts, 1);
    assert.deepInclude(yield* harness.runtime.metrics, {
      activeTargets: 0,
      pendingCount: 0,
      failed: 2,
      aborts: 1,
    });
    yield* closeHarness(harness.ownerScope);
  }),
);

it.effect("does not retry an adapter that reports a destroyed renderer", () =>
  Effect.gen(function* () {
    let calls = 0;
    const harness = yield* makeHarness(() => {
      calls += 1;
      return Effect.fail(
        new RendererDeliveryAdapterError({
          operation: "deliver",
          reason: "destroyed",
          cause: new Error("renderer destroyed"),
        }),
      );
    });
    const receipt = yield* harness.runtime.enqueue(target("destroyed"), { value: 1 });
    const error = yield* receipt.completion.pipe(Effect.flip);
    assert.strictEqual(error.reason, "destroyed");
    assert.strictEqual(calls, 1);
    assert.strictEqual((yield* harness.runtime.metrics).retries, 0);
    yield* closeHarness(harness.ownerScope);
  }),
);
