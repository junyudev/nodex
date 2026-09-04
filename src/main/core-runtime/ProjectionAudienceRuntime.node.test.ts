import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import { assert, it } from "@effect/vitest";
import type {
  AuthorizedRecipientLease,
  DeliveryAddress,
  RecipientDeliveryEnvelope,
} from "../../shared/recipient-delivery";
import type { ProjectionScope } from "../../shared/projection-stream";
import { createCoreLocalCommitFixture } from "../core-client/testing/local-commit-fixture";
import {
  make,
  ProjectionAudienceRuntimeError,
  type ProjectionAudienceRuntimeOptions,
  type ProjectionAudienceSubscription,
} from "./ProjectionAudienceRuntime";

const address = (projectId: string): DeliveryAddress => ({
  kind: "project",
  library_id: "library-1",
  project_id: projectId,
});

const lease = (projectId: string, fill = "a"): AuthorizedRecipientLease => ({
  lease_id: fill.repeat(64),
  delivery_address: address(projectId),
  authorization_scope: address(projectId),
});

const packet = (commitSeq: number, projectId = "project-1") =>
  createCoreLocalCommitFixture({
    commitSeq,
    authorizationScope: address(projectId),
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
    version: 2,
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

it.effect("reuses the active Core grant after all windows briefly release an address", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const first = sender(1);
    const subscription = yield* subscribeReady(harness, first);
    yield* subscription.release;

    // Scope churn can return before the broker replaces its physical stream.
    const next = sender(2);
    yield* harness.runtime.subscribe(next, address("project-1"));
    const reset = harness.sent.at(-1)!.envelope;
    assert.strictEqual(reset.payload.kind, "reset");
    assert.isTrue(yield* acknowledge(harness.runtime, next.id, reset));
    assert.strictEqual((yield* harness.runtime.publish(packet(1))).sent, 1);

    yield* harness.runtime.releaseSender(next.id);
    harness.sent.length = 0;
    yield* harness.runtime.subscribe(first, address("project-1"));
    const reopenedReset = harness.sent.at(-1)!.envelope;
    assert.strictEqual(reopenedReset.payload.kind, "reset");
    assert.isTrue(yield* acknowledge(harness.runtime, first.id, reopenedReset));
    assert.strictEqual((yield* harness.runtime.publish(packet(2))).sent, 1);

    // Only a replacement Core barrier retires the old grant.
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
        version: 2,
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
        version: 2,
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
    const overflow = yield* Effect.flip(harness.runtime.subscribe(target, address("project-200")));
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
    assert.strictEqual(secondReset.envelope.payload.kind, "reset");
    if (secondReset.envelope.payload.kind === "reset") {
      assert.strictEqual(secondReset.envelope.payload.reset.required_commit_seq, 4);
      assert.strictEqual(secondReset.envelope.payload.reset.reason, "stream_gap");
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

it.effect("does not reuse a grant retired by a replacement Core barrier", () =>
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
