import { createHash } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { AuthorizedDeliveryPacket } from "../../shared/authorized-delivery-packet";
import {
  RECIPIENT_DELIVERY_VERSION,
  deliveryAddressKey,
  deliveryAddressProjectionScope,
  type AddressReset,
  type AddressResetReason,
  type AuthorizedRecipientLease,
  type DeliveryAddress,
  type DeliveryAuthorizationScope,
  type RecipientAdmissionResult,
  type RecipientDeliveryEnvelope,
} from "../../shared/recipient-delivery";
import { projectionScopeKey, type ProjectionScope } from "../../shared/projection-stream";

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const MAX_ADDRESSES = 200;
const RESET_RETRY_WINDOW_MS = 10 * 60_000;
const RESET_RETRY_WINDOW_LIMIT = 20;

interface RecipientSender {
  readonly id: number;
  isDestroyed(): boolean;
  isLoadingMainFrame?(): boolean;
  send(channel: string, ...args: unknown[]): void;
}

interface DeliveryFloor {
  readonly storeEpoch: string;
  readonly commitSeq: number;
}

interface PendingAdmission {
  readonly deliveryId: string;
  readonly floor: DeliveryFloor;
  readonly reset: boolean;
  readonly timerKey: string;
}

interface AudienceSubscription {
  readonly address: DeliveryAddress;
  readonly key: string;
  readonly lease: AuthorizedRecipientLease | null;
  readonly leaseGeneration: number;
  readonly pending: ReadonlyMap<string, PendingAdmission>;
  readonly requiredFloor: DeliveryFloor | null;
  readonly resetReason: AddressResetReason;
  readonly retryAttempt: number;
  readonly retryTimerKey: string | null;
  readonly retryWindowAttempts: number;
  readonly retryWindowStartedAt: number;
  readonly sender: RecipientSender;
  readonly token: number;
}

interface DeliveryOwner {
  readonly subscriptionKey: string;
  readonly token: number;
}

interface ProjectionAudienceState {
  readonly closed: boolean;
  readonly deliveryOwners: ReadonlyMap<string, DeliveryOwner>;
  readonly leaseGrants: ReadonlyMap<string, CurrentLeaseGrant>;
  readonly nextTimerId: number;
  readonly nextToken: number;
  readonly subscriptions: ReadonlyMap<string, AudienceSubscription>;
}

interface ProjectionAudienceDraft {
  closed: boolean;
  readonly deliveryOwners: Map<string, DeliveryOwner>;
  readonly leaseGrants: Map<string, CurrentLeaseGrant>;
  nextTimerId: number;
  nextToken: number;
  readonly subscriptions: Map<string, AudienceSubscription>;
}

interface CurrentLeaseGrant {
  readonly floor: DeliveryFloor;
  readonly lease: AuthorizedRecipientLease;
}

export interface ProjectionAudienceDiagnostics {
  readonly addresses: number;
  readonly fencedRecipients: number;
  readonly leasedSubscriptions: number;
  readonly pendingAdmissions: number;
  readonly scheduledResetRetries: number;
  readonly subscriptions: number;
}

export interface ProjectionAudienceFanoutReport {
  readonly fenced: number;
  readonly recipients: number;
  readonly released: number;
  readonly sent: number;
}

export interface ProjectionAudienceSubscription {
  readonly release: Effect.Effect<void>;
}

export class ProjectionAudienceRuntimeError extends Schema.TaggedError<ProjectionAudienceRuntimeError>()(
  "ProjectionAudienceRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface ProjectionAudienceRuntimeOptions {
  readonly ackTimeout?: Duration.Input;
  readonly libraryId: string;
  readonly maxPendingPerRecipient?: number;
  readonly retryBase?: Duration.Input;
  readonly retryDelay?: (capMilliseconds: number, attempt: number) => Effect.Effect<number>;
  readonly retryMax?: Duration.Input;
  readonly send: (
    sender: RecipientSender,
    channel: string,
    envelope: RecipientDeliveryEnvelope,
  ) => boolean;
}

export class ProjectionAudienceRuntime extends Context.Service<
  ProjectionAudienceRuntime,
  {
    readonly admit: (senderId: number, result: unknown) => Effect.Effect<boolean>;
    readonly diagnostics: Effect.Effect<ProjectionAudienceDiagnostics>;
    readonly installLeases: (
      leases: readonly AuthorizedRecipientLease[],
      floor: DeliveryFloor,
      resetAddresses: readonly DeliveryAddress[],
      reason: AddressResetReason,
    ) => Effect.Effect<void, ProjectionAudienceRuntimeError>;
    readonly publish: (
      packet: AuthorizedDeliveryPacket,
    ) => Effect.Effect<ProjectionAudienceFanoutReport>;
    readonly releaseSender: (senderId: number) => Effect.Effect<void>;
    readonly reset: (
      floor: DeliveryFloor,
      reason: AddressResetReason,
      addresses?: readonly DeliveryAddress[],
    ) => Effect.Effect<void>;
    readonly scopes: Stream.Stream<readonly ProjectionScope[]>;
    readonly subscribe: (
      sender: RecipientSender,
      address: DeliveryAddress,
    ) => Effect.Effect<ProjectionAudienceSubscription, ProjectionAudienceRuntimeError>;
  }
>()("nodex/main/core-runtime/ProjectionAudienceRuntime") {}

const initialState: ProjectionAudienceState = {
  closed: false,
  deliveryOwners: new Map(),
  leaseGrants: new Map(),
  nextTimerId: 1,
  nextToken: 1,
  subscriptions: new Map(),
};

const draftFrom = (state: ProjectionAudienceState): ProjectionAudienceDraft => ({
  closed: state.closed,
  deliveryOwners: new Map(state.deliveryOwners),
  leaseGrants: new Map(state.leaseGrants),
  nextTimerId: state.nextTimerId,
  nextToken: state.nextToken,
  subscriptions: new Map(state.subscriptions),
});

const stateFrom = (draft: ProjectionAudienceDraft): ProjectionAudienceState => ({
  closed: draft.closed,
  deliveryOwners: draft.deliveryOwners,
  leaseGrants: draft.leaseGrants,
  nextTimerId: draft.nextTimerId,
  nextToken: draft.nextToken,
  subscriptions: draft.subscriptions,
});

const runtimeError = (operation: string, cause: unknown): ProjectionAudienceRuntimeError =>
  new ProjectionAudienceRuntimeError({ operation, cause });

const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const identityKey = (value: DeliveryAddress | DeliveryAuthorizationScope): string =>
  JSON.stringify(value);

const subscriptionKey = (senderId: number, address: DeliveryAddress): string =>
  `${senderId}:${deliveryAddressKey(address)}`;

const ownerKey = (senderId: number, deliveryId: string): string => `${senderId}:${deliveryId}`;

const floorMax = (left: DeliveryFloor | null, right: DeliveryFloor): DeliveryFloor => {
  if (!left || left.storeEpoch !== right.storeEpoch) return right;
  return left.commitSeq >= right.commitSeq ? left : right;
};

const packetFloor = (packet: AuthorizedDeliveryPacket): DeliveryFloor => ({
  storeEpoch: packet.manifest.identity.store_epoch,
  commitSeq: packet.manifest.identity.commit_seq,
});

const packetDeliveryId = (
  lease: AuthorizedRecipientLease,
  packet: AuthorizedDeliveryPacket,
): string =>
  digest([
    "recipient-packet-v2",
    lease.lease_id,
    lease.delivery_address,
    lease.authorization_scope,
    packet.manifest.identity.store_epoch,
    packet.manifest.identity.manifest_hash,
    packet.packet_hash,
  ]);

const validAddress = (address: DeliveryAddress): boolean => {
  if (!address.library_id || address.library_id !== address.library_id.trim()) return false;
  if (address.kind === "library") return true;
  if (address.kind === "project") {
    return Boolean(address.project_id && address.project_id === address.project_id.trim());
  }
  return Boolean(
    address.document_id &&
    address.document_id === address.document_id.trim() &&
    (address.project_id === null ||
      address.project_id === undefined ||
      address.project_id === address.project_id.trim()),
  );
};

const validLease = (lease: AuthorizedRecipientLease): boolean =>
  HASH_PATTERN.test(lease.lease_id) &&
  identityKey(lease.delivery_address) === identityKey(lease.authorization_scope);

const validPacketForLease = (
  lease: AuthorizedRecipientLease,
  packet: AuthorizedDeliveryPacket,
): boolean =>
  packet.packet_version === 4 &&
  identityKey(packet.delivery_address) === identityKey(lease.delivery_address) &&
  identityKey(packet.authorization_scope) === identityKey(lease.authorization_scope);

const isAdmission = (value: unknown): value is RecipientAdmissionResult => {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<RecipientAdmissionResult>;
  if (
    candidate.version !== RECIPIENT_DELIVERY_VERSION ||
    typeof candidate.deliveryId !== "string" ||
    !HASH_PATTERN.test(candidate.deliveryId) ||
    (candidate.outcome !== "ack" && candidate.outcome !== "nack")
  ) {
    return false;
  }
  if (candidate.outcome === "ack") return true;
  const reason = "reason" in candidate ? candidate.reason : undefined;
  return reason === "capacity" || reason === "causal_divergence" || reason === "invalid_message";
};

const desiredScopes = (
  subscriptions: ReadonlyMap<string, AudienceSubscription>,
): readonly ProjectionScope[] => {
  const scopes = new Map<string, ProjectionScope>();
  for (const subscription of subscriptions.values()) {
    const scope = deliveryAddressProjectionScope(subscription.address);
    if (scope) scopes.set(projectionScopeKey(scope), scope);
  }
  return [...scopes.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, scope]) => scope);
};

const fence = (
  subscription: AudienceSubscription,
  floor: DeliveryFloor,
  reason: AddressResetReason,
): AudienceSubscription => ({
  ...subscription,
  requiredFloor: floorMax(subscription.requiredFloor, floor),
  resetReason: reason,
});

const releasedReport = (): ProjectionAudienceFanoutReport => ({
  recipients: 1,
  sent: 0,
  fenced: 0,
  released: 1,
});

const emptyReport = (): ProjectionAudienceFanoutReport => ({
  recipients: 0,
  sent: 0,
  fenced: 0,
  released: 0,
});

const addReport = (
  left: ProjectionAudienceFanoutReport,
  right: ProjectionAudienceFanoutReport,
): ProjectionAudienceFanoutReport => ({
  recipients: left.recipients + right.recipients,
  sent: left.sent + right.sent,
  fenced: left.fenced + right.fenced,
  released: left.released + right.released,
});

/**
 * Owns renderer audience membership, Core-issued recipient leases, exact ACK
 * correlation, bounded admission, and reset recovery as one Main-scoped
 * aggregate. Electron send remains the synchronous outer Adapter; all time and
 * replacement work is represented by child fibers owned by this Module.
 */
export const make = (
  options: ProjectionAudienceRuntimeOptions,
): Effect.Effect<ProjectionAudienceRuntime["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const state = yield* Ref.make(initialState);
    const scopes = yield* SubscriptionRef.make<readonly ProjectionScope[]>([]);
    const transitions = yield* Semaphore.make(1);
    const timers = yield* FiberMap.make<string, void, never>();
    const ackTimeoutMs = Math.max(
      50,
      Math.floor(Duration.toMillis(options.ackTimeout ?? "1 second")),
    );
    const maxPending = Math.max(1, Math.floor(options.maxPendingPerRecipient ?? 128));
    const retryBaseMs = Math.max(
      1,
      Math.floor(Duration.toMillis(options.retryBase ?? "100 millis")),
    );
    const retryMaxMs = Math.max(
      retryBaseMs,
      Math.floor(Duration.toMillis(options.retryMax ?? "1 minute")),
    );
    const retryDelay =
      options.retryDelay ??
      ((capMilliseconds: number) =>
        Random.next.pipe(
          Effect.map((random) => Math.max(1, Math.floor(capMilliseconds * random))),
        ));

    const commit = (draft: ProjectionAudienceDraft): Effect.Effect<void> =>
      Ref.set(state, stateFrom(draft));

    const publishScopes = (draft: ProjectionAudienceDraft): Effect.Effect<void> =>
      SubscriptionRef.set(scopes, desiredScopes(draft.subscriptions));

    const clearRetry = Effect.fn("ProjectionAudienceRuntime.clearRetry")(function* (
      subscription: AudienceSubscription,
    ) {
      if (!subscription.retryTimerKey) return subscription;
      yield* FiberMap.remove(timers, subscription.retryTimerKey);
      return { ...subscription, retryTimerKey: null };
    });

    const forgetPending = Effect.fn("ProjectionAudienceRuntime.forgetPending")(function* (
      draft: ProjectionAudienceDraft,
      subscription: AudienceSubscription,
      pending: PendingAdmission,
      interruptTimer = true,
    ) {
      if (interruptTimer) yield* FiberMap.remove(timers, pending.timerKey);
      const pendingAdmissions = new Map(subscription.pending);
      pendingAdmissions.delete(pending.deliveryId);
      const deliveryOwnerKey = ownerKey(subscription.sender.id, pending.deliveryId);
      const owner = draft.deliveryOwners.get(deliveryOwnerKey);
      if (owner?.subscriptionKey === subscription.key && owner.token === subscription.token) {
        draft.deliveryOwners.delete(deliveryOwnerKey);
      }
      const next = { ...subscription, pending: pendingAdmissions };
      draft.subscriptions.set(next.key, next);
      return next;
    });

    const clearPending = Effect.fn("ProjectionAudienceRuntime.clearPending")(function* (
      draft: ProjectionAudienceDraft,
      subscription: AudienceSubscription,
      preserveReason: AddressResetReason | null,
    ) {
      let next = subscription;
      for (const pending of subscription.pending.values()) {
        if (preserveReason) next = fence(next, pending.floor, preserveReason);
        next = yield* forgetPending(draft, next, pending);
      }
      return next;
    });

    const detachLease = Effect.fn("ProjectionAudienceRuntime.detachLease")(function* (
      draft: ProjectionAudienceDraft,
      subscription: AudienceSubscription,
      preserveRecovery: boolean,
    ) {
      let next = yield* clearPending(draft, subscription, preserveRecovery ? "stream_gap" : null);
      next = yield* clearRetry(next);
      next = {
        ...next,
        lease: null,
        leaseGeneration: next.leaseGeneration + 1,
        requiredFloor: preserveRecovery ? next.requiredFloor : null,
        retryAttempt: 0,
        retryWindowAttempts: 0,
      };
      draft.subscriptions.set(next.key, next);
      return next;
    });

    function scheduleAck(
      subscription: AudienceSubscription,
      pending: PendingAdmission,
    ): Effect.Effect<void> {
      const timeout = Effect.sleep(ackTimeoutMs).pipe(
        Effect.andThen(handleAckTimeout(subscription.key, subscription.token, pending.deliveryId)),
      );
      return FiberMap.run(timers, pending.timerKey, timeout, { startImmediately: true }).pipe(
        Effect.asVoid,
      );
    }

    function scheduleReset(
      draft: ProjectionAudienceDraft,
      subscription: AudienceSubscription,
      requiredDelayMs?: number,
    ): Effect.Effect<AudienceSubscription> {
      return Effect.gen(function* () {
        if (subscription.retryTimerKey || !subscription.requiredFloor || !subscription.lease) {
          return subscription;
        }
        const cap = Math.min(
          retryMaxMs,
          retryBaseMs * 2 ** Math.min(subscription.retryAttempt, 16),
        );
        const delay = Math.max(
          1,
          Math.floor(requiredDelayMs ?? (yield* retryDelay(cap, subscription.retryAttempt))),
        );
        const timerKey = `retry:${subscription.token}:${draft.nextTimerId}`;
        draft.nextTimerId += 1;
        const next = {
          ...subscription,
          retryAttempt:
            requiredDelayMs === undefined
              ? subscription.retryAttempt + 1
              : subscription.retryAttempt,
          retryTimerKey: timerKey,
        };
        draft.subscriptions.set(next.key, next);
        const retry = Effect.sleep(delay).pipe(
          Effect.andThen(handleResetRetry(next.key, next.token, next.leaseGeneration, timerKey)),
        );
        yield* FiberMap.run(timers, timerKey, retry, { startImmediately: true });
        return next;
      });
    }

    function claimResetAttempt(
      subscription: AudienceSubscription,
    ): Effect.Effect<readonly [AudienceSubscription, number]> {
      return Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const windowEndsAt = subscription.retryWindowStartedAt + RESET_RETRY_WINDOW_MS;
        const current =
          now > windowEndsAt
            ? { ...subscription, retryWindowStartedAt: now, retryWindowAttempts: 0 }
            : subscription;
        if (current.retryWindowAttempts < RESET_RETRY_WINDOW_LIMIT) {
          return [{ ...current, retryWindowAttempts: current.retryWindowAttempts + 1 }, 0] as const;
        }
        return [
          current,
          Math.max(1, current.retryWindowStartedAt + RESET_RETRY_WINDOW_MS - now + 1),
        ] as const;
      });
    }

    function sendEnvelope(
      draft: ProjectionAudienceDraft,
      subscriptionKeyValue: string,
      envelope: RecipientDeliveryEnvelope,
      floor: DeliveryFloor,
      reset: boolean,
    ): Effect.Effect<boolean> {
      return Effect.gen(function* () {
        let subscription = draft.subscriptions.get(subscriptionKeyValue);
        if (!subscription || !subscription.lease) return false;
        if (subscription.pending.has(envelope.deliveryId)) return true;
        if (subscription.sender.isDestroyed() || subscription.sender.isLoadingMainFrame?.()) {
          subscription = fence(
            subscription,
            floor,
            reset ? subscription.resetReason : "stream_gap",
          );
          draft.subscriptions.set(subscription.key, subscription);
          return false;
        }
        if (subscription.pending.size >= maxPending) {
          subscription = yield* clearPending(draft, subscription, "queue_overflow");
          subscription = fence(subscription, floor, "queue_overflow");
          draft.subscriptions.set(subscription.key, subscription);
          if (!reset) yield* sendReset(draft, subscription.key);
          return false;
        }

        const sender = subscription.sender;
        const sent = yield* Effect.sync(() => {
          try {
            return options.send(sender, "recipient-delivery:message", envelope);
          } catch {
            return false;
          }
        });
        if (!sent) {
          subscription = fence(
            subscription,
            floor,
            reset ? subscription.resetReason : "stream_gap",
          );
          draft.subscriptions.set(subscription.key, subscription);
          return false;
        }

        const timerKey = `ack:${subscription.token}:${envelope.deliveryId}`;
        const pending: PendingAdmission = {
          deliveryId: envelope.deliveryId,
          floor,
          reset,
          timerKey,
        };
        const pendingAdmissions = new Map(subscription.pending);
        pendingAdmissions.set(pending.deliveryId, pending);
        subscription = { ...subscription, pending: pendingAdmissions };
        draft.subscriptions.set(subscription.key, subscription);
        draft.deliveryOwners.set(ownerKey(subscription.sender.id, pending.deliveryId), {
          subscriptionKey: subscription.key,
          token: subscription.token,
        });
        yield* scheduleAck(subscription, pending);
        return true;
      });
    }

    function sendReset(
      draft: ProjectionAudienceDraft,
      subscriptionKeyValue: string,
    ): Effect.Effect<boolean> {
      return Effect.gen(function* () {
        let subscription = draft.subscriptions.get(subscriptionKeyValue);
        if (!subscription?.requiredFloor || !subscription.lease) return false;
        if ([...subscription.pending.values()].some((pending) => pending.reset)) return true;

        const [claimed, retryBudgetDelay] = yield* claimResetAttempt(subscription);
        subscription = claimed;
        draft.subscriptions.set(subscription.key, subscription);
        if (retryBudgetDelay > 0) {
          yield* scheduleReset(draft, subscription, retryBudgetDelay);
          return false;
        }

        subscription = yield* clearPending(draft, subscription, subscription.resetReason);
        const floor = subscription.requiredFloor;
        const lease = subscription.lease;
        if (!floor || !lease) return false;
        subscription = yield* clearRetry(subscription);
        draft.subscriptions.set(subscription.key, subscription);
        const reset: AddressReset = {
          reset_id: digest([
            "address-reset-v1",
            lease.lease_id,
            lease.delivery_address,
            lease.authorization_scope,
            floor.storeEpoch,
            floor.commitSeq,
            subscription.resetReason,
          ]),
          store_epoch: floor.storeEpoch,
          recipient_lease_id: lease.lease_id,
          delivery_address: lease.delivery_address,
          authorization_scope: lease.authorization_scope,
          required_commit_seq: floor.commitSeq,
          reason: subscription.resetReason,
        };
        const envelope: RecipientDeliveryEnvelope = {
          version: RECIPIENT_DELIVERY_VERSION,
          deliveryId: reset.reset_id,
          recipientLeaseId: lease.lease_id,
          deliveryAddress: lease.delivery_address,
          authorizationScope: lease.authorization_scope,
          payload: { kind: "reset", reset },
        };
        const sent = yield* sendEnvelope(draft, subscription.key, envelope, floor, true);
        if (!sent) {
          const latest = draft.subscriptions.get(subscription.key);
          if (latest) yield* scheduleReset(draft, latest);
        }
        return sent;
      });
    }

    function publishOne(
      draft: ProjectionAudienceDraft,
      subscriptionKeyValue: string,
      packet: AuthorizedDeliveryPacket,
    ): Effect.Effect<ProjectionAudienceFanoutReport> {
      return Effect.gen(function* () {
        let subscription = draft.subscriptions.get(subscriptionKeyValue);
        if (!subscription) return releasedReport();
        const lease = subscription.lease;
        if (!lease) return emptyReport();
        const floor = packetFloor(packet);
        if (!validPacketForLease(lease, packet)) {
          subscription = fence(subscription, floor, "integrity_failure");
          draft.subscriptions.set(subscription.key, subscription);
          yield* sendReset(draft, subscription.key);
          return { recipients: 1, sent: 0, fenced: 1, released: 0 };
        }
        if (subscription.requiredFloor) {
          subscription = fence(subscription, floor, subscription.resetReason);
          draft.subscriptions.set(subscription.key, subscription);
          yield* sendReset(draft, subscription.key);
          return { recipients: 1, sent: 0, fenced: 1, released: 0 };
        }

        const envelope: RecipientDeliveryEnvelope = {
          version: RECIPIENT_DELIVERY_VERSION,
          deliveryId: packetDeliveryId(lease, packet),
          recipientLeaseId: lease.lease_id,
          deliveryAddress: lease.delivery_address,
          authorizationScope: lease.authorization_scope,
          payload: { kind: "packet", packet },
        };
        const sent = yield* sendEnvelope(draft, subscription.key, envelope, floor, false);
        if (!sent) {
          const latest = draft.subscriptions.get(subscription.key);
          if (latest) yield* sendReset(draft, latest.key);
        }
        return {
          recipients: 1,
          sent: sent ? 1 : 0,
          fenced: sent ? 0 : 1,
          released: 0,
        };
      });
    }

    function handleAckTimeout(
      subscriptionKeyValue: string,
      token: number,
      deliveryId: string,
    ): Effect.Effect<void> {
      return transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) return;
          const draft = draftFrom(current);
          let subscription = draft.subscriptions.get(subscriptionKeyValue);
          if (!subscription || subscription.token !== token) return;
          const pending = subscription.pending.get(deliveryId);
          if (!pending) return;
          subscription = yield* forgetPending(draft, subscription, pending, false);
          subscription = fence(subscription, pending.floor, "ack_timeout");
          draft.subscriptions.set(subscription.key, subscription);
          yield* sendReset(draft, subscription.key);
          yield* commit(draft);
        }),
      );
    }

    function handleResetRetry(
      subscriptionKeyValue: string,
      token: number,
      leaseGeneration: number,
      timerKey: string,
    ): Effect.Effect<void> {
      return transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) return;
          const draft = draftFrom(current);
          const subscription = draft.subscriptions.get(subscriptionKeyValue);
          if (
            !subscription ||
            subscription.token !== token ||
            subscription.leaseGeneration !== leaseGeneration ||
            subscription.retryTimerKey !== timerKey
          ) {
            return;
          }
          draft.subscriptions.set(subscription.key, {
            ...subscription,
            retryTimerKey: null,
          });
          yield* sendReset(draft, subscription.key);
          yield* commit(draft);
        }),
      );
    }

    const releaseSubscription = (key: string, token: number): Effect.Effect<void> =>
      transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const existing = current.subscriptions.get(key);
          if (!existing || existing.token !== token) return;
          const draft = draftFrom(current);
          const detached = yield* detachLease(draft, existing, false);
          draft.subscriptions.delete(detached.key);
          yield* commit(draft);
          yield* publishScopes(draft);
        }),
      );

    const subscribe = Effect.fn("ProjectionAudienceRuntime.subscribe")(function* (
      sender: RecipientSender,
      address: DeliveryAddress,
    ) {
      if (
        address.library_id !== options.libraryId ||
        !validAddress(address) ||
        !deliveryAddressProjectionScope(address)
      ) {
        return yield* runtimeError(
          "subscribe.validate",
          new TypeError("Local commit audience address is invalid"),
        );
      }
      return yield* transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) {
            return yield* runtimeError(
              "subscribe.closed",
              new Error("Projection audience runtime is closed"),
            );
          }
          const draft = draftFrom(current);
          const key = subscriptionKey(sender.id, address);
          const existing = draft.subscriptions.get(key);
          let recoveryFloor: DeliveryFloor | null = null;
          if (existing) {
            const detached = yield* detachLease(draft, existing, true);
            recoveryFloor = detached.requiredFloor;
            draft.subscriptions.delete(key);
          }

          const token = draft.nextToken;
          draft.nextToken += 1;
          const grant = draft.leaseGrants.get(deliveryAddressKey(address));
          const now = yield* Clock.currentTimeMillis;
          let subscription: AudienceSubscription = {
            address,
            key,
            lease: grant?.lease ?? null,
            leaseGeneration: 1,
            pending: new Map(),
            requiredFloor: recoveryFloor,
            resetReason: "stream_gap",
            retryAttempt: 0,
            retryTimerKey: null,
            retryWindowAttempts: 0,
            retryWindowStartedAt: now,
            sender,
            token,
          };
          if (grant) subscription = fence(subscription, grant.floor, "stream_gap");
          draft.subscriptions.set(key, subscription);
          if (desiredScopes(draft.subscriptions).length > MAX_ADDRESSES) {
            return yield* runtimeError(
              "subscribe.capacity",
              new RangeError(`Local commit audience supports at most ${MAX_ADDRESSES} addresses`),
            );
          }
          if (grant) yield* sendReset(draft, key);
          yield* commit(draft);
          yield* publishScopes(draft);
          return { release: releaseSubscription(key, token) };
        }),
      );
    });

    const installLeases = Effect.fn("ProjectionAudienceRuntime.installLeases")(function* (
      leases: readonly AuthorizedRecipientLease[],
      floor: DeliveryFloor,
      resetAddresses: readonly DeliveryAddress[],
      reason: AddressResetReason,
    ) {
      if (leases.length > MAX_ADDRESSES || leases.some((lease) => !validLease(lease))) {
        return yield* runtimeError(
          "leases.validate",
          new RangeError("Core recipient barrier is invalid or exceeds the audience bound"),
        );
      }
      yield* transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) return;
          const draft = draftFrom(current);
          // Grants belong to the active Core stream, not individual windows. Keep
          // them through audience churn until this replacement barrier supersedes
          // them; the broker may retain the same stream when scopes return.
          draft.leaseGrants.clear();
          for (const lease of leases) {
            draft.leaseGrants.set(deliveryAddressKey(lease.delivery_address), { lease, floor });
          }
          const resetKeys = new Set(resetAddresses.map(deliveryAddressKey));
          const now = yield* Clock.currentTimeMillis;
          for (const [key, initial] of [...draft.subscriptions]) {
            const lease = draft.leaseGrants.get(deliveryAddressKey(initial.address))?.lease ?? null;
            let subscription = initial;
            if (subscription.lease?.lease_id !== lease?.lease_id) {
              subscription = yield* detachLease(draft, subscription, true);
              subscription = {
                ...subscription,
                lease,
                retryWindowStartedAt: now,
              };
            }
            if (lease && resetKeys.has(deliveryAddressKey(subscription.address))) {
              subscription = fence(subscription, floor, reason);
            }
            draft.subscriptions.set(key, subscription);
            if (subscription.lease && subscription.requiredFloor) {
              yield* sendReset(draft, key);
            }
          }
          yield* commit(draft);
        }),
      );
    });

    const publish = Effect.fn("ProjectionAudienceRuntime.publish")(function* (
      packet: AuthorizedDeliveryPacket,
    ) {
      return yield* transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) return emptyReport();
          const draft = draftFrom(current);
          const packetAddressKey = deliveryAddressKey(packet.delivery_address);
          let report = emptyReport();
          for (const subscription of draft.subscriptions.values()) {
            if (deliveryAddressKey(subscription.address) !== packetAddressKey) continue;
            report = addReport(report, yield* publishOne(draft, subscription.key, packet));
          }
          yield* commit(draft);
          return report;
        }),
      );
    });

    const reset = Effect.fn("ProjectionAudienceRuntime.reset")(function* (
      floor: DeliveryFloor,
      reason: AddressResetReason,
      addresses?: readonly DeliveryAddress[],
    ) {
      yield* transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) return;
          const draft = draftFrom(current);
          const allowed = addresses ? new Set(addresses.map(deliveryAddressKey)) : null;
          for (const [key, initial] of draft.subscriptions) {
            if (!initial.lease) continue;
            if (allowed && !allowed.has(deliveryAddressKey(initial.address))) continue;
            const subscription = fence(initial, floor, reason);
            draft.subscriptions.set(key, subscription);
            yield* sendReset(draft, key);
          }
          yield* commit(draft);
        }),
      );
    });

    const admit = Effect.fn("ProjectionAudienceRuntime.admit")(function* (
      senderId: number,
      value: unknown,
    ) {
      if (!isAdmission(value)) return false;
      return yield* transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) return false;
          const draft = draftFrom(current);
          const owner = draft.deliveryOwners.get(ownerKey(senderId, value.deliveryId));
          if (!owner) return false;
          let subscription = draft.subscriptions.get(owner.subscriptionKey);
          if (
            !subscription ||
            subscription.token !== owner.token ||
            subscription.sender.id !== senderId
          ) {
            return false;
          }
          const pending = subscription.pending.get(value.deliveryId);
          if (!pending) return false;
          subscription = yield* forgetPending(draft, subscription, pending);
          if (value.outcome === "nack") {
            subscription = fence(subscription, pending.floor, "recipient_nack");
            draft.subscriptions.set(subscription.key, subscription);
            yield* sendReset(draft, subscription.key);
            yield* commit(draft);
            return true;
          }
          if (pending.reset) {
            const required = subscription.requiredFloor;
            if (
              required &&
              required.storeEpoch === pending.floor.storeEpoch &&
              required.commitSeq <= pending.floor.commitSeq
            ) {
              subscription = yield* clearRetry({
                ...subscription,
                requiredFloor: null,
                retryAttempt: 0,
                retryWindowAttempts: 0,
                retryWindowStartedAt: yield* Clock.currentTimeMillis,
              });
              draft.subscriptions.set(subscription.key, subscription);
            }
            if (subscription.requiredFloor) yield* sendReset(draft, subscription.key);
          }
          yield* commit(draft);
          return true;
        }),
      );
    });

    const releaseSender = Effect.fn("ProjectionAudienceRuntime.releaseSender")(function* (
      senderId: number,
    ) {
      yield* transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          const draft = draftFrom(current);
          for (const [key, subscription] of [...draft.subscriptions]) {
            if (subscription.sender.id !== senderId) continue;
            yield* detachLease(draft, subscription, false);
            draft.subscriptions.delete(key);
          }
          yield* commit(draft);
          yield* publishScopes(draft);
        }),
      );
    });

    yield* Effect.addFinalizer(() =>
      transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          yield* Ref.set(state, {
            ...current,
            closed: true,
            deliveryOwners: new Map(),
            leaseGrants: new Map(),
            subscriptions: new Map(),
          });
          yield* SubscriptionRef.set(scopes, []);
          yield* FiberMap.clear(timers);
        }),
      ),
    );

    return ProjectionAudienceRuntime.of({
      admit,
      diagnostics: Ref.get(state).pipe(
        Effect.map((current) => {
          const subscriptions = [...current.subscriptions.values()];
          return {
            addresses: desiredScopes(current.subscriptions).length,
            fencedRecipients: subscriptions.filter(
              (subscription) => subscription.requiredFloor !== null,
            ).length,
            leasedSubscriptions: subscriptions.filter((subscription) => subscription.lease !== null)
              .length,
            pendingAdmissions: subscriptions.reduce(
              (count, subscription) => count + subscription.pending.size,
              0,
            ),
            scheduledResetRetries: subscriptions.filter(
              (subscription) => subscription.retryTimerKey !== null,
            ).length,
            subscriptions: subscriptions.length,
          };
        }),
      ),
      installLeases,
      publish,
      releaseSender,
      reset,
      scopes: SubscriptionRef.changes(scopes),
      subscribe,
    });
  });
