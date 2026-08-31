import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import {
  RENDERER_DELIVERY_CHUNK_BYTES,
  RENDERER_DELIVERY_INLINE_MAX_BYTES,
  type RendererDeliveryDataEnvelope,
  type RendererDeliveryTarget,
  type RendererDeliveryTransferAckEnvelope,
} from "../../shared/renderer-delivery-transport";
import {
  make,
  RendererDeliveryAdapter,
  type RendererDeliveryAdapterService,
  type RendererDeliveryOptions,
} from "./RendererDelivery";

const TARGET: RendererDeliveryTarget = { targetId: "slow-renderer", generation: 7 };
const MAX_PENDING = 4;
const MAX_PENDING_BYTES = 24 * 1024 * 1024;

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
  options: RendererDeliveryOptions,
) =>
  Effect.gen(function* () {
    const ownerScope = yield* Scope.make();
    let nextId = 1;
    const runtime = yield* make({
      deliveryIdFactory: () => `slow-delivery-${nextId++}`,
      ...options,
    }).pipe(
      Effect.provideService(RendererDeliveryAdapter, RendererDeliveryAdapter.of({ deliver })),
      Effect.provideService(Scope.Scope, ownerScope),
    );
    return { ownerScope, runtime };
  });

it.effect("bounds queued bytes and keeps only one slow-ACK chunk in flight", () =>
  Effect.gen(function* () {
    const gates = yield* Effect.all(
      Array.from({ length: 5 }, () => Deferred.make<RendererDeliveryTransferAckEnvelope>()),
    );
    const delivered: RendererDeliveryDataEnvelope[] = [];
    const harness = yield* makeHarness(
      (envelope) => {
        if (envelope.kind === "transferAbort") return Effect.succeed(null);
        const index = delivered.push(envelope) - 1;
        const gate = gates[index];
        return gate
          ? Deferred.await(gate)
          : Effect.die(new Error(`Unexpected renderer frame ${index}`));
      },
      {
        maxAttempts: 1,
        maxPendingPerTarget: MAX_PENDING,
        maxPendingProcess: MAX_PENDING,
        maxPendingBytesPerTarget: MAX_PENDING_BYTES,
        maxPendingBytesProcess: MAX_PENDING_BYTES,
      },
    );
    const payload = { value: "x".repeat(RENDERER_DELIVERY_INLINE_MAX_BYTES + 1_024) };
    const heapBefore = process.memoryUsage().heapUsed;
    const startedAt = process.hrtime.bigint();
    const receipts = yield* Effect.forEach(
      Array.from({ length: MAX_PENDING }, () => payload),
      (value) => harness.runtime.enqueue(TARGET, value),
      { concurrency: 1 },
    );

    yield* waitUntil("first transfer start", () => delivered.length === 1);
    assert.strictEqual(receipts.length, MAX_PENDING);
    assert.isTrue(receipts.every((receipt) => receipt.frameCount === 5));
    assert.deepEqual(
      delivered.map((envelope) => envelope.kind),
      ["transferStart"],
    );

    let overflowPayloadReads = 0;
    const overflowPayload = {} as { readonly value: string };
    Object.defineProperty(overflowPayload, "value", {
      enumerable: true,
      get: () => {
        overflowPayloadReads += 1;
        return payload.value;
      },
    });
    const overflow = yield* harness.runtime.enqueue(TARGET, overflowPayload).pipe(Effect.flip);
    assert.strictEqual(overflow.reason, "target-capacity");
    assert.strictEqual(overflowPayloadReads, 0);
    const beforeFirstAck = yield* harness.runtime.metrics;
    assert.strictEqual(beforeFirstAck.pendingCount, MAX_PENDING);
    assert.strictEqual(beforeFirstAck.peakPendingCount, MAX_PENDING);
    assert.strictEqual(
      beforeFirstAck.pendingBytes,
      receipts.reduce((total, receipt) => total + receipt.encodedBytes, 0),
    );
    assert.isAtMost(beforeFirstAck.pendingBytes, MAX_PENDING_BYTES);
    assert.strictEqual(beforeFirstAck.sentFrames, 1);
    assert.strictEqual(beforeFirstAck.acknowledgedFrames, 0);
    assert.strictEqual(beforeFirstAck.rejected, 1);

    const firstAck = acknowledge(delivered[0]!);
    if (!firstAck) return yield* Effect.die(new Error("Transfer start produced no ACK"));
    yield* Deferred.succeed(gates[0]!, firstAck);
    yield* waitUntil("first transfer chunk", () => delivered.length === 2);
    const chunk = delivered[1];
    if (chunk?.kind !== "transferChunk") {
      return yield* Effect.die(new Error("The next renderer frame was not a transfer chunk"));
    }
    assert.isAtMost(chunk.payloadUtf8.byteLength, RENDERER_DELIVERY_CHUNK_BYTES);
    const whileChunkAckIsSlow = yield* harness.runtime.metrics;
    assert.strictEqual(whileChunkAckIsSlow.sentFrames, 2);
    assert.strictEqual(whileChunkAckIsSlow.acknowledgedFrames, 1);
    assert.strictEqual(whileChunkAckIsSlow.pendingCount, MAX_PENDING);

    yield* harness.runtime.releaseTarget(TARGET);
    const failures = yield* Effect.forEach(receipts, (receipt) =>
      receipt.completion.pipe(Effect.flip),
    );
    assert.isTrue(failures.every((failure) => failure.reason === "released"));
    const released = yield* harness.runtime.metrics;
    assert.strictEqual(released.pendingCount, 0);
    assert.strictEqual(released.pendingBytes, 0);
    assert.strictEqual(released.activeTargets, 0);

    const elapsed = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    process.stdout.write(
      `\nNODEX_LAZY_HISTORY_ACCEPTANCE ${JSON.stringify({
        kind: "renderer-delivery-slow-ack",
        elapsedMs: elapsed,
        heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore,
        admitted: receipts.length,
        frameCountPerDelivery: receipts[0]?.frameCount ?? 0,
        maxChunkBytes: RENDERER_DELIVERY_CHUNK_BYTES,
        peakPendingCount: released.peakPendingCount,
        peakPendingBytes: released.peakPendingBytes,
        sentFramesBeforeRelease: whileChunkAckIsSlow.sentFrames,
        acknowledgedFramesBeforeRelease: whileChunkAckIsSlow.acknowledgedFrames,
        overflowPayloadReads,
      })}\n`,
    );
    yield* Scope.close(harness.ownerScope, Exit.void);
  }),
);
