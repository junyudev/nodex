import { describe, expect, test } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import {
  RECIPIENT_DELIVERY_VERSION,
  type AuthorizedRecipientLease,
  type DeliveryAddress,
  type RecipientDeliveryEnvelope,
} from "../../shared/recipient-delivery";
import type { ProjectionScope } from "../../shared/projection-stream";
import { createCoreLocalCommitFixture } from "../core-client/testing/local-commit-fixture";
import { RendererLocalCommitIngress } from "../../renderer/lib/local-commit-ingress";
import { ProjectionInvalidationRegistry } from "../../renderer/lib/projection-invalidation-registry";
import {
  make,
  ProjectionAudienceRuntimeError,
  type ProjectionAudienceRuntimeOptions,
  type ProjectionAudienceSubscription,
} from "./ProjectionAudienceRuntime";
import * as Deferred from "effect/Deferred";
import type {
  CoreEventEnvelope,
  ProjectionLiveBarrier,
  ProjectionLiveRepair,
} from "../core-client/types";
import {
  make as makeProjectionLiveRuntime,
  type ProjectionLiveRuntimeOptions,
  type ProjectionLiveSubscription,
} from "./ProjectionLiveRuntime";
import { projectCoreApplicationEvent } from "./CoreApplicationEventProjection";

describe("ProjectionAudienceRuntime", () => {
  const address = (projectId: string): DeliveryAddress => ({
    kind: "project",
    library_id: "library-1",
    project_id: projectId,
  });

  const lease = (projectId: string, fill = "a"): AuthorizedRecipientLease => ({
    lease_id: fill.repeat(64),
    delivery_address: address(projectId),
  });

  const packet = (commitSeq: number, projectId = "project-1") =>
    createCoreLocalCommitFixture({
      commitSeq,
      deliveryAddress: address(projectId),
    });

  const sender = (id = 1) => ({
    id,
    destroyed: false,
    loading: false,
    isDestroyed() {
      return this.destroyed;
    },
    isLoadingMainFrame() {
      return this.loading;
    },
    send() {},
  });

  interface SentEnvelope {
    readonly envelope: RecipientDeliveryEnvelope;
    readonly senderId: number;
  }

  const makeHarness = (input: Partial<ProjectionAudienceRuntimeOptions> = {}) =>
    Effect.gen(function* () {
      const ownerScope = yield* Scope.make();
      const sent: SentEnvelope[] = [];
      const runtime = yield* make({
        libraryId: "library-1",
        retryDelay: () => Effect.succeed(10),
        send: (target, _channel, envelope) => {
          sent.push({ senderId: target.id, envelope });
          return true;
        },
        ...input,
      }).pipe(Effect.provideService(Scope.Scope, ownerScope));
      return { ownerScope, runtime, sent };
    });

  const acknowledge = (
    runtime: Effect.Success<ReturnType<typeof make>>,
    targetId: number,
    envelope: RecipientDeliveryEnvelope,
  ) =>
    runtime.admit(targetId, {
      version: RECIPIENT_DELIVERY_VERSION,
      deliveryId: envelope.deliveryId,
      outcome: "ack",
    });

  const subscribeReady = (
    harness: Effect.Success<ReturnType<typeof makeHarness>>,
    target: ReturnType<typeof sender>,
    projectId = "project-1",
  ): Effect.Effect<ProjectionAudienceSubscription, ProjectionAudienceRuntimeError> =>
    Effect.gen(function* () {
      const subscription = yield* harness.runtime.subscribe(target, address(projectId));
      yield* harness.runtime.installLeases(
        [lease(projectId)],
        { storeEpoch: "epoch-1", commitSeq: 0 },
        [address(projectId)],
        "stream_gap",
      );
      const reset = harness.sent.at(-1)?.envelope;
      if (!reset) return yield* Effect.die(new Error("Ready recipient received no reset"));
      assert.isTrue(yield* acknowledge(harness.runtime, target.id, reset));
      harness.sent.length = 0;
      return subscription;
    });

  it.effect(
    "checks every advancing subscription floor through renderer ingress without resetting covered reads",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const target = sender();
        const ingress = new RendererLocalCommitIngress();
        const registry = new ProjectionInvalidationRegistry({
          subscribeProjection: (scope, listener) => ingress.subscribeProjection(scope, listener),
        });
        const fences: number[] = [];
        const reads: number[] = [];
        let cursor = { storeEpoch: "epoch-1", commitSeq: 1 };
        registry.register({
          scope: { kind: "project", libraryId: "library-1", projectId: "project-1" },
          consumerKey: "covered-board",
          getDependencies: () => ({ aggregate: true }),
          getCursor: () => cursor,
          fence: (message) => fences.push(message.stream.commitSeq),
          invalidate: (message) => {
            reads.push(message.stream.commitSeq);
            cursor = message.stream;
          },
        });
        yield* harness.runtime.subscribe(target, address("project-1"));
        yield* harness.runtime.installLeases([lease("project-1")], cursor, [], "stream_gap", [
          address("project-1"),
        ]);
        const first = harness.sent.at(-1)!.envelope;
        assert.strictEqual(first.payload.kind, "checkpoint");
        if (first.payload.kind !== "checkpoint") return yield* Effect.die("Expected checkpoint");
        ingress.admitAddressCheckpoint(first, first.payload.stream);
        assert.deepEqual(fences, []);

        // Commit 2 races the first checkpoint ACK, so the next control must repair it.
        assert.strictEqual((yield* harness.runtime.publish(packet(2))).fenced, 1);
        assert.lengthOf(harness.sent, 1);
        assert.isTrue(yield* acknowledge(harness.runtime, target.id, first));
        const second = harness.sent.at(-1)!.envelope;
        assert.strictEqual(second.payload.kind, "checkpoint");
        assert.notStrictEqual(second.deliveryId, first.deliveryId);
        if (second.payload.kind !== "checkpoint") return yield* Effect.die("Expected checkpoint");
        ingress.admitAddressCheckpoint(second, second.payload.stream);
        assert.deepEqual(fences, [2]);
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
        assert.deepEqual(reads, [2]);
        assert.deepEqual(cursor, { storeEpoch: "epoch-1", commitSeq: 2 });
        assert.isTrue(yield* acknowledge(harness.runtime, target.id, second));
        assert.strictEqual((yield* harness.runtime.publish(packet(3))).sent, 1);
        registry.dispose();
        yield* Scope.close(harness.ownerScope, Exit.void);
      }),
  );

  it.effect("keeps late checkpoint and reset ACKs from clearing a newer same-floor recovery", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = sender();
      const floor = { storeEpoch: "epoch-1", commitSeq: 7 };
      yield* harness.runtime.subscribe(target, address("project-1"));
      yield* harness.runtime.installLeases([lease("project-1")], floor, [], "stream_gap", [
        address("project-1"),
      ]);
      const checkpoint = harness.sent.at(-1)!.envelope;
      yield* harness.runtime.reset(floor, "stream_gap");
      assert.isTrue(yield* acknowledge(harness.runtime, target.id, checkpoint));
      const firstReset = harness.sent.at(-1)!.envelope;
      assert.strictEqual(firstReset.payload.kind, "reset");
      assert.notStrictEqual(firstReset.deliveryId, checkpoint.deliveryId);

      yield* harness.runtime.reset(floor, "stream_gap");
      assert.isTrue(yield* acknowledge(harness.runtime, target.id, firstReset));
      const secondReset = harness.sent.at(-1)!.envelope;
      assert.strictEqual(secondReset.payload.kind, "reset");
      assert.notStrictEqual(secondReset.deliveryId, firstReset.deliveryId);
      assert.strictEqual((yield* harness.runtime.diagnostics).fencedRecipients, 1);
      assert.isTrue(yield* acknowledge(harness.runtime, target.id, secondReset));
      assert.strictEqual((yield* harness.runtime.diagnostics).fencedRecipients, 0);

      const invalidPacket = { ...packet(7), packet_version: 4 } as unknown as ReturnType<
        typeof packet
      >;
      yield* harness.runtime.publish(invalidPacket);
      const integrityReset = harness.sent.at(-1)!.envelope;
      yield* harness.runtime.publish(invalidPacket);
      assert.isTrue(yield* acknowledge(harness.runtime, target.id, integrityReset));
      const nextIntegrityReset = harness.sent.at(-1)!.envelope;
      assert.notStrictEqual(nextIntegrityReset.deliveryId, integrityReset.deliveryId);
      assert.strictEqual((yield* harness.runtime.diagnostics).fencedRecipients, 1);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect(
    "retains checkpoint obligations across lease churn and forces a reset across epochs",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const target = sender();
        yield* harness.runtime.subscribe(target, address("project-1"));
        yield* harness.runtime.installLeases(
          [lease("project-1")],
          { storeEpoch: "epoch-1", commitSeq: 4 },
          [],
          "stream_gap",
          [address("project-1")],
        );
        const first = harness.sent.at(-1)!.envelope;
        yield* harness.runtime.installLeases(
          [lease("project-1", "b")],
          { storeEpoch: "epoch-1", commitSeq: 5 },
          [],
          "stream_gap",
          [address("project-1")],
        );
        const replacement = harness.sent.at(-1)!.envelope;
        // Commit 5 was only observed by the replacement barrier, not the old queue.
        assert.deepEqual(replacement.payload, {
          kind: "checkpoint",
          stream: { storeEpoch: "epoch-1", commitSeq: 5 },
        });
        assert.isFalse(yield* acknowledge(harness.runtime, target.id, first));

        yield* harness.runtime.installLeases(
          [lease("project-1", "c")],
          { storeEpoch: "epoch-2", commitSeq: 0 },
          [],
          "stream_gap",
          [address("project-1")],
        );
        const newEpoch = harness.sent.at(-1)!.envelope;
        assert.strictEqual(newEpoch.payload.kind, "reset");
        if (newEpoch.payload.kind === "reset") {
          assert.strictEqual(newEpoch.payload.reset.store_epoch, "epoch-2");
          assert.strictEqual(newEpoch.payload.reset.required_commit_seq, 0);
          assert.strictEqual(newEpoch.payload.reset.reason, "store_epoch_replacement");
        }
        assert.isFalse(yield* acknowledge(harness.runtime, target.id, replacement));
        assert.isTrue(yield* acknowledge(harness.runtime, target.id, newEpoch));
        yield* Scope.close(harness.ownerScope, Exit.void);
      }),
  );

  it.effect(
    "keeps the current epoch while retiring old pending deliveries and retrying recovery",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ ackTimeout: "50 millis" });
        const target = sender();
        yield* subscribeReady(harness, target);
        yield* harness.runtime.publish(packet(9));
        yield* harness.runtime.reset(
          { storeEpoch: "epoch-2", commitSeq: 0 },
          "store_epoch_replacement",
        );
        const reset = harness.sent.at(-1)!.envelope;
        assert.strictEqual(reset.payload.kind, "reset");
        if (reset.payload.kind === "reset") {
          assert.strictEqual(reset.payload.reset.store_epoch, "epoch-2");
          assert.strictEqual(reset.payload.reset.required_commit_seq, 0);
        }
        yield* TestClock.adjust("50 millis");
        assert.deepEqual(harness.sent.at(-1)!.envelope, reset);
        yield* Scope.close(harness.ownerScope, Exit.void);
      }),
  );

  it.effect(
    "advances retained subscription floors with commits and repairs even without recipients",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const target = sender();
        const subscription = yield* subscribeReady(harness, target);
        yield* subscription.release;
        yield* harness.runtime.publish(packet(9));
        yield* harness.runtime.publish(packet(5));
        yield* harness.runtime.installLeases(
          [lease("project-1", "b")],
          { storeEpoch: "epoch-1", commitSeq: 7 },
          [],
          "stream_gap",
        );
        yield* harness.runtime.subscribe(target, address("project-1"));
        assert.deepEqual(harness.sent.at(-1)!.envelope.payload, {
          kind: "checkpoint",
          stream: { storeEpoch: "epoch-1", commitSeq: 9 },
        });
        yield* harness.runtime.releaseSender(target.id);
        yield* harness.runtime.reset({ storeEpoch: "epoch-1", commitSeq: 11 }, "stream_gap");
        yield* harness.runtime.subscribe(target, address("project-1"));
        assert.deepEqual(harness.sent.at(-1)!.envelope.payload, {
          kind: "checkpoint",
          stream: { storeEpoch: "epoch-1", commitSeq: 11 },
        });
        yield* Scope.close(harness.ownerScope, Exit.void);
      }),
  );

  it.effect("retries the same checkpoint identity after a failed send", () =>
    Effect.gen(function* () {
      const attempts: RecipientDeliveryEnvelope[] = [];
      const harness = yield* makeHarness({
        send: (_target, _channel, envelope) => {
          attempts.push(envelope);
          return attempts.length > 1;
        },
      });
      yield* harness.runtime.subscribe(sender(), address("project-1"));
      yield* harness.runtime.installLeases(
        [lease("project-1")],
        { storeEpoch: "epoch-1", commitSeq: 1 },
        [],
        "stream_gap",
        [address("project-1")],
      );
      yield* TestClock.adjust("10 millis");
      assert.lengthOf(attempts, 2);
      assert.deepEqual(attempts[0], attempts[1]);
      assert.strictEqual(attempts[0]!.payload.kind, "checkpoint");
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("reuses the active Core lease after all windows briefly release an address", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = sender(1);
      const subscription = yield* subscribeReady(harness, first);
      yield* subscription.release;

      // Scope churn can return before the broker replaces its physical stream.
      const next = sender(2);
      yield* harness.runtime.subscribe(next, address("project-1"));
      const reset = harness.sent.at(-1)!.envelope;
      assert.strictEqual(reset.payload.kind, "checkpoint");
      assert.isTrue(yield* acknowledge(harness.runtime, next.id, reset));
      assert.strictEqual((yield* harness.runtime.publish(packet(1))).sent, 1);

      yield* harness.runtime.releaseSender(next.id);
      harness.sent.length = 0;
      yield* harness.runtime.subscribe(first, address("project-1"));
      const reopenedReset = harness.sent.at(-1)!.envelope;
      assert.strictEqual(reopenedReset.payload.kind, "checkpoint");
      assert.isTrue(yield* acknowledge(harness.runtime, first.id, reopenedReset));
      assert.strictEqual((yield* harness.runtime.publish(packet(2))).sent, 1);

      // Only a replacement Core barrier retires the old lease.
      yield* harness.runtime.installLeases(
        [lease("project-2")],
        { storeEpoch: "epoch-1", commitSeq: 2 },
        [address("project-2")],
        "stream_gap",
      );
      assert.strictEqual((yield* harness.runtime.publish(packet(3))).sent, 0);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("tracks a complete packet until the exact renderer ACK", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = sender();
      yield* subscribeReady(harness, target);

      assert.deepEqual(yield* harness.runtime.publish(packet(3)), {
        recipients: 1,
        sent: 1,
        fenced: 0,
        released: 0,
      });
      const envelope = harness.sent[0]!.envelope;
      assert.strictEqual(envelope.payload.kind, "packet");
      if (envelope.payload.kind === "packet") {
        assert.strictEqual(envelope.payload.packet.manifest.identity.commit_seq, 3);
      }
      assert.isFalse(
        yield* harness.runtime.admit(target.id, {
          version: RECIPIENT_DELIVERY_VERSION,
          deliveryId: "b".repeat(64),
          outcome: "ack",
        }),
      );
      assert.isTrue(yield* acknowledge(harness.runtime, target.id, envelope));
      assert.deepInclude(yield* harness.runtime.diagnostics, {
        pendingAdmissions: 0,
        fencedRecipients: 0,
      });

      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("actively retries a lease-bound reset after send failure", () =>
    Effect.gen(function* () {
      let available = true;
      const sent: SentEnvelope[] = [];
      const harness = yield* makeHarness({
        retryBase: "10 millis",
        retryMax: "10 millis",
        retryDelay: () => Effect.succeed(10),
        send: (target, _channel, envelope) => {
          if (!available) return false;
          sent.push({ senderId: target.id, envelope });
          return true;
        },
      });
      const target = sender();
      yield* subscribeReady({ ...harness, sent }, target);
      available = false;

      assert.strictEqual((yield* harness.runtime.publish(packet(4))).fenced, 1);
      assert.deepInclude(yield* harness.runtime.diagnostics, {
        fencedRecipients: 1,
        scheduledResetRetries: 1,
      });
      available = true;
      yield* TestClock.adjust("10 millis");

      const retried = sent.at(-1)!.envelope.payload;
      assert.strictEqual(retried.kind, "reset");
      if (retried.kind === "reset") {
        assert.strictEqual(retried.reset.recipient_lease_id, lease("project-1").lease_id);
        assert.strictEqual(retried.reset.required_commit_seq, 4);
        assert.strictEqual(retried.reset.reason, "stream_gap");
      }
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("turns NACK and ACK timeout into an address reset", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ ackTimeout: "50 millis" });
      const target = sender();
      yield* subscribeReady(harness, target);

      yield* harness.runtime.publish(packet(5));
      const packetDelivery = harness.sent[0]!.envelope;
      assert.isTrue(
        yield* harness.runtime.admit(target.id, {
          version: RECIPIENT_DELIVERY_VERSION,
          deliveryId: packetDelivery.deliveryId,
          outcome: "nack",
          reason: "capacity",
        }),
      );
      const nackReset = harness.sent.at(-1)!.envelope;
      assert.strictEqual(nackReset.payload.kind, "reset");
      if (nackReset.payload.kind === "reset") {
        assert.strictEqual(nackReset.payload.reset.reason, "recipient_nack");
        assert.strictEqual(nackReset.payload.reset.required_commit_seq, 5);
      }
      assert.isTrue(yield* acknowledge(harness.runtime, target.id, nackReset));

      harness.sent.length = 0;
      yield* harness.runtime.publish(packet(6));
      yield* TestClock.adjust("50 millis");
      const timeoutReset = harness.sent.at(-1)!.envelope.payload;
      assert.strictEqual(timeoutReset.kind, "reset");
      if (timeoutReset.kind === "reset") {
        assert.strictEqual(timeoutReset.reset.reason, "ack_timeout");
        assert.strictEqual(timeoutReset.reset.required_commit_seq, 6);
      }
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("bounds pending packets and repairs queue overflow with one reset", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ maxPendingPerRecipient: 1 });
      const target = sender();
      yield* subscribeReady(harness, target);

      yield* harness.runtime.publish(packet(7));
      assert.strictEqual((yield* harness.runtime.publish(packet(8))).fenced, 1);
      assert.isAtMost((yield* harness.runtime.diagnostics).pendingAdmissions, 1);
      const overflowReset = harness.sent.at(-1)!.envelope.payload;
      assert.strictEqual(overflowReset.kind, "reset");
      if (overflowReset.kind === "reset") {
        assert.strictEqual(overflowReset.reset.reason, "queue_overflow");
        assert.strictEqual(overflowReset.reset.required_commit_seq, 8);
      }
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("releases timers and rejects a destroyed renderer's late ACK", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = sender();
      yield* subscribeReady(harness, target);
      yield* harness.runtime.publish(packet(9));
      const delivery = harness.sent[0]!.envelope;

      yield* harness.runtime.releaseSender(target.id);
      assert.isFalse(yield* acknowledge(harness.runtime, target.id, delivery));
      assert.deepEqual(yield* harness.runtime.diagnostics, {
        subscriptions: 0,
        leasedSubscriptions: 0,
        addresses: 0,
        pendingAdmissions: 0,
        fencedRecipients: 0,
        scheduledResetRetries: 0,
      });
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("bounds quiet reset retries over ten minutes and closes the retry fiber", () =>
    Effect.gen(function* () {
      let resetAttempts = 0;
      const harness = yield* makeHarness({
        retryDelay: () => Effect.succeed(1),
        send: (_target, _channel, envelope) => {
          if (envelope.payload.kind === "reset") resetAttempts += 1;
          return false;
        },
      });
      yield* harness.runtime.subscribe(sender(), address("project-1"));
      yield* harness.runtime.installLeases(
        [lease("project-1")],
        { storeEpoch: "epoch-1", commitSeq: 10 },
        [address("project-1")],
        "stream_gap",
      );

      yield* TestClock.adjust("10 minutes");
      assert.isAtMost(resetAttempts, 20);
      assert.strictEqual((yield* harness.runtime.diagnostics).scheduledResetRetries, 1);
      yield* TestClock.adjust("1 milli");
      assert.strictEqual(resetAttempts, 21);

      yield* Scope.close(harness.ownerScope, Exit.void);
      const attemptsAtClose = resetAttempts;
      yield* TestClock.adjust("10 minutes");
      assert.strictEqual(resetAttempts, attemptsAtClose);
    }),
  );

  it.effect("rejects foreign and 201st addresses without losing prior subscriptions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = sender();
      const foreign = yield* Effect.flip(
        harness.runtime.subscribe(target, {
          ...address("foreign"),
          library_id: "library-other",
        }),
      );
      assert.strictEqual(foreign.operation, "subscribe.validate");

      for (let index = 0; index < 200; index += 1) {
        yield* harness.runtime.subscribe(target, address(`project-${index}`));
      }
      const overflow = yield* Effect.flip(
        harness.runtime.subscribe(target, address("project-200")),
      );
      assert.strictEqual(overflow.operation, "subscribe.capacity");
      assert.deepInclude(yield* harness.runtime.diagnostics, {
        subscriptions: 200,
        addresses: 200,
      });
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("routes only through the exact Core-issued address lease", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = sender();
      const subscription = yield* harness.runtime.subscribe(target, address("project-1"));
      assert.strictEqual((yield* harness.runtime.publish(packet(1))).recipients, 0);

      yield* harness.runtime.installLeases(
        [lease("project-1")],
        { storeEpoch: "epoch-1", commitSeq: 0 },
        [],
        "stream_gap",
      );
      assert.strictEqual((yield* harness.runtime.publish(packet(2, "project-2"))).recipients, 0);
      assert.strictEqual((yield* harness.runtime.publish(packet(1))).sent, 1);
      const delivered = harness.sent.at(-1)!.envelope.payload;
      assert.strictEqual(delivered.kind, "packet");
      if (delivered.kind === "packet") {
        assert.deepEqual(delivered.packet.delivery_address, address("project-1"));
      }

      yield* subscription.release;
      assert.strictEqual((yield* harness.runtime.diagnostics).subscriptions, 0);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("uses a replacement lease to author an address reset", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.runtime.subscribe(sender(), address("project-1"));

      yield* harness.runtime.installLeases(
        [lease("project-1", "b")],
        { storeEpoch: "epoch-2", commitSeq: 7 },
        [address("project-1")],
        "store_epoch_replacement",
      );
      const replacement = harness.sent[0]!.envelope;
      assert.strictEqual(replacement.recipientLeaseId, "b".repeat(64));
      assert.strictEqual(replacement.payload.kind, "reset");
      if (replacement.payload.kind === "reset") {
        assert.strictEqual(replacement.payload.reset.required_commit_seq, 7);
        assert.strictEqual(replacement.payload.reset.reason, "store_epoch_replacement");
      }
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("binds a later recipient when its address is already leased", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const first = sender(1);
      yield* harness.runtime.subscribe(first, address("project-1"));
      yield* harness.runtime.installLeases(
        [lease("project-1", "c")],
        { storeEpoch: "epoch-1", commitSeq: 4 },
        [address("project-1")],
        "stream_gap",
      );
      assert.isTrue(yield* acknowledge(harness.runtime, first.id, harness.sent.at(-1)!.envelope));
      harness.sent.length = 0;

      const second = sender(2);
      yield* harness.runtime.subscribe(second, address("project-1"));
      const secondReset = harness.sent[0]!;
      assert.strictEqual(secondReset.senderId, 2);
      assert.strictEqual(secondReset.envelope.recipientLeaseId, "c".repeat(64));
      assert.strictEqual(secondReset.envelope.payload.kind, "checkpoint");
      if (secondReset.envelope.payload.kind === "checkpoint") {
        assert.deepEqual(secondReset.envelope.payload.stream, {
          storeEpoch: "epoch-1",
          commitSeq: 4,
        });
      }
      assert.isTrue(yield* acknowledge(harness.runtime, second.id, harness.sent.at(-1)!.envelope));
      harness.sent.length = 0;

      assert.deepInclude(yield* harness.runtime.publish(packet(5)), {
        recipients: 2,
        sent: 2,
      });
      assert.deepEqual(
        harness.sent.map((entry) => entry.senderId),
        [1, 2],
      );
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("carries an in-flight floor across exact lease replacement", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = sender();
      yield* subscribeReady(harness, target);
      yield* harness.runtime.publish(packet(11));
      const retiredDelivery = harness.sent.at(-1)!.envelope;

      yield* harness.runtime.installLeases(
        [lease("project-1", "d")],
        { storeEpoch: "epoch-1", commitSeq: 12 },
        [],
        "stream_gap",
      );
      const recovery = harness.sent.at(-1)!.envelope;
      assert.strictEqual(recovery.recipientLeaseId, "d".repeat(64));
      assert.strictEqual(recovery.payload.kind, "reset");
      if (recovery.payload.kind === "reset") {
        assert.strictEqual(recovery.payload.reset.required_commit_seq, 11);
        assert.strictEqual(recovery.payload.reset.reason, "stream_gap");
      }
      assert.isFalse(yield* acknowledge(harness.runtime, target.id, retiredDelivery));
      assert.isTrue(yield* acknowledge(harness.runtime, target.id, recovery));
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("does not reuse a lease retired by a replacement Core barrier", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const target = sender();
      yield* subscribeReady(harness, target);

      yield* harness.runtime.releaseSender(target.id);
      yield* harness.runtime.installLeases(
        [],
        { storeEpoch: "epoch-1", commitSeq: 1 },
        [],
        "stream_gap",
      );
      harness.sent.length = 0;
      yield* harness.runtime.subscribe(target, address("project-1"));
      assert.lengthOf(harness.sent, 0);
      assert.strictEqual((yield* harness.runtime.diagnostics).leasedSubscriptions, 0);
      yield* Scope.close(harness.ownerScope, Exit.void);
    }),
  );

  it.effect("publishes canonical desired scopes and closes every admission with its Scope", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const observed = yield* harness.runtime.scopes.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      const first = yield* harness.runtime.subscribe(sender(), address("project-2"));
      yield* harness.runtime.subscribe(sender(2), address("project-1"));
      const changes = yield* Fiber.join(observed);
      assert.deepEqual(changes, [
        [],
        [
          {
            kind: "project",
            libraryId: "library-1",
            projectId: "project-2",
          } satisfies ProjectionScope,
        ],
        [
          {
            kind: "project",
            libraryId: "library-1",
            projectId: "project-1",
          } satisfies ProjectionScope,
          {
            kind: "project",
            libraryId: "library-1",
            projectId: "project-2",
          } satisfies ProjectionScope,
        ],
      ]);

      yield* Scope.close(harness.ownerScope, Exit.void);
      assert.deepEqual(yield* harness.runtime.diagnostics, {
        subscriptions: 0,
        leasedSubscriptions: 0,
        addresses: 0,
        pendingAdmissions: 0,
        fencedRecipients: 0,
        scheduledResetRetries: 0,
      });
      yield* first.release;
    }),
  );
});

describe("ProjectionLiveRuntime", () => {
  const make = makeProjectionLiveRuntime;
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
      // oxlint-disable-next-line nodex/no-polling-loop-in-tests -- Yield across the projection subscription fibers without advancing the test clock.
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
      yield* waitUntil(
        "expanded open interruption",
        () => harness.leases[1]!.interruptedCount === 1,
      );
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
});

describe("CoreApplicationEventProjection", () => {
  const envelope = (packet: ReturnType<typeof createCoreLocalCommitFixture>) => ({
    transport_version: 4 as const,
    packet,
  });

  test("projects every Core application event through one discriminated boundary", () => {
    const automation = createCoreLocalCommitFixture({
      commitSeq: 1,
      storeEpoch: "epoch:test",
      payload: {
        module: "automation",
        library_id: "library:test",
        project_id: "project:one",
        event: {
          kind: "automation_changed",
          automation_ids: ["automation:one"],
          lease_ids: [],
          run_ids: ["run:one"],
          reminder_lease_ids: [],
          snooze_ids: [],
          page_ids: [],
          document_ids: [],
          database_ids: [],
        },
      },
    });
    const projectDatabase = createCoreLocalCommitFixture({
      commitSeq: 2,
      storeEpoch: "epoch:test",
      operationId: "operation:database",
      payload: {
        module: "database",
        library_id: "library:test",
        event: {
          kind: "database_changed",
          project_id: "project:one",
          database_ids: ["database:one"],
          data_source_ids: [],
          page_ids: [],
          view_ids: [],
        },
      },
    });
    const libraryDatabase = createCoreLocalCommitFixture({
      commitSeq: 3,
      storeEpoch: "epoch:test",
      operationId: "operation:library-database",
      payload: {
        module: "database",
        library_id: "library:test",
        event: {
          kind: "database_changed",
          project_id: null,
          database_ids: ["database:two"],
          data_source_ids: [],
          page_ids: [],
          view_ids: [],
        },
      },
    });
    const workspace = createCoreLocalCommitFixture({
      commitSeq: 4,
      storeEpoch: "epoch:test",
      payload: {
        module: "project_workspace",
        library_id: "library:test",
        event: {
          kind: "workspace_changed",
          project_catalog_change: "created",
          project_ids: ["project:one"],
          session_ids: [],
          thread_ids: [],
          session_summary_scopes: [{ kind: "project", project_id: "project:one" }],
          session_detail_ids: [],
        },
      },
    });
    const administration = createCoreLocalCommitFixture({
      commitSeq: 5,
      storeEpoch: "epoch:test",
      payload: {
        module: "store_administration",
        library_id: "library:test",
        event: {
          kind: "store_administration_changed",
          operation: "create_backup",
          backup_ids: ["backup:one"],
          readiness_changed: true,
        },
      },
    });

    expect(
      projectCoreApplicationEvent(envelope(automation), automation.atoms[0]!, "library:test"),
    ).toEqual({
      kind: "automation",
      value: { automationIds: ["automation:one"], runIds: ["run:one"] },
    });
    expect(
      projectCoreApplicationEvent(
        envelope(projectDatabase),
        projectDatabase.atoms[0]!,
        "library:test",
      )?.kind,
    ).toBe("database");
    expect(
      projectCoreApplicationEvent(
        envelope(libraryDatabase),
        libraryDatabase.atoms[0]!,
        "library:test",
      ),
    ).toMatchObject({
      kind: "library-navigation",
      value: { changeKind: "database", affectedDatabaseIds: ["database:two"] },
    });
    expect(
      projectCoreApplicationEvent(envelope(workspace), workspace.atoms[0]!, "library:test"),
    ).toMatchObject({
      kind: "project-workspace",
      value: {
        projectCatalogChange: "created",
        sessionSummaryScopes: [{ kind: "project", projectId: "project:one" }],
      },
    });
    expect(
      projectCoreApplicationEvent(
        envelope(administration),
        administration.atoms[0]!,
        "library:test",
      ),
    ).toEqual({
      kind: "store-administration",
      value: { operation: "create_backup", backupIds: ["backup:one"], readinessChanged: true },
    });
  });

  test("repairs historical personal filter drafts before strict renderer parsing", () => {
    const database = createCoreLocalCommitFixture({
      commitSeq: 6,
      storeEpoch: "epoch:test",
      operationId: "operation:personal-filter-draft",
      payload: {
        module: "database",
        library_id: "library:test",
        event: {
          kind: "database_changed",
          project_id: "project:one",
          database_ids: [],
          data_source_ids: [],
          page_ids: [],
          view_ids: [],
          personal_view_changes: [
            {
              kind: "preferences",
              member_id: "member-local",
              view_id: "view:one",
              value: {
                rules_override: {
                  advanced_filter: {
                    kind: "filter",
                    filter: {
                      kind: "group",
                      operator: "and",
                      children: [
                        {
                          kind: "clause",
                          propertyId: "assignee",
                          operator: "select_is",
                        },
                      ],
                    },
                  },
                },
                presentation_override: {},
                revision: 1,
              },
            },
          ],
        },
      },
    });

    expect(
      projectCoreApplicationEvent(envelope(database), database.atoms[0]!, "library:test"),
    ).toMatchObject({
      kind: "database",
      value: {
        personalViewChanges: [
          {
            kind: "preferences",
            rulesOverride: {
              advancedFilter: {
                children: [{ propertyId: "assignee", operator: "select_is", value: null }],
              },
            },
          },
        ],
      },
    });
  });
});
