import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberSet from "effect/FiberSet";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import type { CoreProjectionEffect } from "../../shared/projection-stream";
import type {
  CoreAuthorizedDeliveryAtom,
  CoreAuthorizedDeliveryPacket,
  CoreStreamCheckpoint,
} from "../core-client/types";

export type LocalCommitIngress = "projection_live" | "tailer";
export type LocalCommitLaneKind = "document" | "projection" | "notification";
export type LocalCommitStreamResetReason = "event_gap" | "reconnect" | "store_epoch_changed";

export type LocalCommitAdmission =
  | { readonly kind: "accepted"; readonly key: string }
  | { readonly kind: "duplicate"; readonly key: string }
  | { readonly kind: "enriched"; readonly key: string };

export interface LocalCommitDeliveryError {
  readonly lane: LocalCommitLaneKind;
  readonly laneKey: string;
  readonly packet: CoreAuthorizedDeliveryPacket;
  readonly error: unknown;
}

export class LocalCommitRuntimeError extends Schema.TaggedError<LocalCommitRuntimeError>()(
  "LocalCommitRuntimeError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface LocalCommitRuntimeOptions {
  readonly onDocument: (
    packet: CoreAuthorizedDeliveryPacket,
    documentId: string,
    ingress: LocalCommitIngress,
  ) => Effect.Effect<void, LocalCommitRuntimeError>;
  readonly onProjection: (
    packet: CoreAuthorizedDeliveryPacket,
    effect: CoreProjectionEffect,
    ingress: LocalCommitIngress,
  ) => Effect.Effect<void, LocalCommitRuntimeError>;
  readonly onNotification: (
    packet: CoreAuthorizedDeliveryPacket,
    atom: CoreAuthorizedDeliveryAtom,
    ingress: LocalCommitIngress,
  ) => Effect.Effect<void, LocalCommitRuntimeError>;
  readonly onError?: (failure: LocalCommitDeliveryError) => Effect.Effect<void>;
  readonly expectedLibraryId: string;
  readonly expectedStoreEpoch: string;
  readonly maxRememberedCommits?: number;
  readonly maxDeliveryAttempts?: number;
  readonly maxPendingDeliveries?: number;
}

export interface LocalCommitRuntimeDiagnostics {
  readonly rememberedCommits: number;
  readonly activeLanes: Readonly<Record<LocalCommitLaneKind, number>>;
  readonly pendingDeliveries: number;
  readonly checkpoint: CoreStreamCheckpoint | null;
  readonly lastResetReason: LocalCommitStreamResetReason | null;
}

export class LocalCommitRuntime extends Context.Service<
  LocalCommitRuntime,
  {
    readonly admit: (
      packet: CoreAuthorizedDeliveryPacket,
      ingress: LocalCommitIngress,
    ) => Effect.Effect<LocalCommitAdmission, LocalCommitRuntimeError>;
    readonly admitAndWait: (
      packet: CoreAuthorizedDeliveryPacket,
      ingress: "tailer",
    ) => Effect.Effect<LocalCommitAdmission, LocalCommitRuntimeError>;
    readonly diagnostics: Effect.Effect<LocalCommitRuntimeDiagnostics>;
    readonly observeCheckpoint: (
      checkpoint: CoreStreamCheckpoint,
    ) => Effect.Effect<void, LocalCommitRuntimeError>;
    readonly resetStream: (reason: LocalCommitStreamResetReason) => Effect.Effect<void>;
  }
>()("nodex/main/core-runtime/LocalCommitRuntime") {}

interface ResourceClaim {
  readonly key: string;
  readonly fingerprint: string;
}

interface RememberedResource {
  readonly completion: Deferred.Deferred<void, LocalCommitRuntimeError>;
  readonly fingerprint: string;
  readonly status: "in_flight" | "completed";
  readonly token: number;
}

interface AdmittedClaim extends ResourceClaim {
  readonly completion: Deferred.Deferred<void, LocalCommitRuntimeError>;
  readonly token: number;
}

interface DocumentDelivery {
  readonly documentId: string;
  readonly claims: readonly AdmittedClaim[];
}

interface RememberedCommit {
  readonly manifestHash: string;
  readonly resources: ReadonlyMap<string, RememberedResource>;
}

interface DeliveryTask {
  readonly claims: readonly AdmittedClaim[];
  readonly commitKey: string;
  readonly kind: LocalCommitLaneKind;
  readonly laneKey: string;
  readonly packet: CoreAuthorizedDeliveryPacket;
  readonly work: Effect.Effect<void, LocalCommitRuntimeError>;
}

interface QueuedDelivery {
  readonly laneToken: number;
  readonly task: DeliveryTask;
}

interface DeliveryLane {
  readonly pending: number;
  readonly queue: Queue.Queue<QueuedDelivery>;
  readonly token: number;
}

type DeliveryLanes = Readonly<Record<LocalCommitLaneKind, ReadonlyMap<string, DeliveryLane>>>;

interface LocalCommitState {
  readonly checkpoint: CoreStreamCheckpoint | null;
  readonly closed: boolean;
  readonly lanes: DeliveryLanes;
  readonly lastResetReason: LocalCommitStreamResetReason | null;
  readonly nextLaneToken: number;
  readonly nextResourceToken: number;
  readonly pendingDeliveries: number;
  readonly remembered: ReadonlyMap<string, RememberedCommit>;
}

interface PlannedAdmission {
  readonly admission: LocalCommitAdmission;
  readonly completions: readonly Deferred.Deferred<void, LocalCommitRuntimeError>[];
  readonly nextResourceToken: number;
  readonly remembered: ReadonlyMap<string, RememberedCommit>;
  readonly tasks: readonly DeliveryTask[];
}

interface AdmissionAnalysis {
  readonly existingCompletions: readonly Deferred.Deferred<void, LocalCommitRuntimeError>[];
  readonly identity: ReturnType<typeof identityOf>;
  readonly newClaims: readonly ResourceClaim[];
  readonly rememberedCommit: RememberedCommit | undefined;
  readonly resources: ReadonlyMap<string, RememberedResource>;
}

const emptyLanes = (): DeliveryLanes => ({
  document: new Map(),
  projection: new Map(),
  notification: new Map(),
});

const initialState: LocalCommitState = {
  checkpoint: null,
  closed: false,
  lanes: emptyLanes(),
  lastResetReason: null,
  nextLaneToken: 1,
  nextResourceToken: 1,
  pendingDeliveries: 0,
  remembered: new Map(),
};

const runtimeError = (operation: string, cause: unknown): LocalCommitRuntimeError =>
  new LocalCommitRuntimeError({ operation, cause });

const validateDeliveryAddress = (scope: CoreAuthorizedDeliveryPacket["delivery_address"]): void => {
  if (!scope.library_id || scope.library_id.trim() !== scope.library_id) {
    throw new Error("Delivery address Library is invalid");
  }
  if (
    (scope.kind === "project" || scope.kind === "document") &&
    scope.project_id !== null &&
    scope.project_id !== undefined &&
    (!scope.project_id || scope.project_id.trim() !== scope.project_id)
  ) {
    throw new Error("Delivery address Project is invalid");
  }
  if (
    scope.kind === "document" &&
    (!scope.document_id || scope.document_id.trim() !== scope.document_id)
  ) {
    throw new Error("Delivery address Document is invalid");
  }
};

const deliveryAddressKey = (scope: CoreAuthorizedDeliveryPacket["delivery_address"]): string => {
  if (scope.kind === "library") return JSON.stringify(["library", scope.library_id]);
  if (scope.kind === "project") {
    return JSON.stringify(["project", scope.library_id, scope.project_id]);
  }
  return JSON.stringify([
    "document",
    scope.library_id,
    scope.project_id ?? null,
    scope.document_id,
  ]);
};

const scopedClaimKey = (
  scope: CoreAuthorizedDeliveryPacket["delivery_address"],
  claim: string,
): string => `${deliveryAddressKey(scope)}:${claim}`;

const sameValues = <Value>(actual: readonly Value[], expected: readonly Value[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const validateCoverage = (packet: CoreAuthorizedDeliveryPacket): void => {
  const atomIds = packet.atoms.map((atom) => atom.descriptor.atom_id);
  const documentOrders = packet.document_effects.map((effect) => effect.reference.effect_order);
  const inlineDocumentOrders = packet.document_effects
    .filter((effect) => Boolean(effect.inline_update))
    .map((effect) => effect.reference.effect_order);
  const projectionScopeKeys = packet.projection_effects.map((effect) => effect.scope.canonical_key);
  if (
    !sameValues(packet.coverage.atom_ids, atomIds) ||
    !sameValues(packet.coverage.document_effect_orders, documentOrders) ||
    !sameValues(packet.coverage.inline_document_effect_orders, inlineDocumentOrders) ||
    !sameValues(packet.coverage.projection_scope_keys, projectionScopeKeys)
  ) {
    throw new Error("Authorized delivery packet coverage is inconsistent");
  }
  for (const effect of packet.projection_effects) {
    if (
      !effect.scope.canonical_key ||
      effect.scope.schema_version < 1 ||
      effect.base_revision < 0 ||
      effect.result_revision !== effect.base_revision + 1 ||
      effect.covered_commit_seq !== packet.manifest.identity.commit_seq ||
      !/^[a-f0-9]{64}$/u.test(effect.effect_hash)
    ) {
      throw new Error("Authorized Projection effect is invalid");
    }
  }
};

const identityOf = (packet: CoreAuthorizedDeliveryPacket) => {
  const identity = packet.manifest.identity;
  if (!Number.isSafeInteger(identity.commit_seq) || identity.commit_seq < 1) {
    throw new Error("Commit manifest sequence is invalid");
  }
  if (!identity.store_epoch || identity.store_epoch.trim() !== identity.store_epoch) {
    throw new Error("Commit manifest Store epoch is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(identity.manifest_hash)) {
    throw new Error("Commit manifest hash is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(packet.packet_hash)) {
    throw new Error("Authorized delivery packet hash is invalid");
  }
  if (
    !packet.manifest.operation_id ||
    packet.manifest.operation_id.trim() !== packet.manifest.operation_id ||
    !packet.manifest.committed_at
  ) {
    throw new Error("Authorized delivery packet manifest header is invalid");
  }
  validateDeliveryAddress(packet.delivery_address);
  validateDeliveryAddress(packet.delivery_address);
  validateCoverage(packet);
  return {
    key: `${identity.store_epoch}:${identity.commit_seq}`,
    storeEpoch: identity.store_epoch,
    manifestHash: identity.manifest_hash,
  };
};

const resourceClaims = (packet: CoreAuthorizedDeliveryPacket): readonly ResourceClaim[] => {
  const claims: ResourceClaim[] = [];
  for (const atom of packet.atoms) {
    const descriptor = atom.descriptor;
    claims.push({
      key: scopedClaimKey(packet.delivery_address, `notification:atom:${descriptor.atom_id}`),
      fingerprint: `${descriptor.kind}:${descriptor.payload_hash}`,
    });
    if (atom.payload.module === "owned_document") {
      claims.push({
        key: `document-control:atom:${descriptor.atom_id}:${atom.payload.event.document_id}`,
        fingerprint: `${descriptor.kind}:${descriptor.payload_hash}`,
      });
    }
  }
  for (const effect of packet.document_effects) {
    const reference = effect.reference;
    const coordinate = [
      reference.document_id,
      reference.generation,
      reference.base_head_seq,
      reference.result_head_seq,
      reference.effect_order,
    ].join(":");
    claims.push({
      key: `document:${coordinate}`,
      fingerprint: `${reference.update_id}:${reference.update_hash}:${reference.update_byte_length}`,
    });
    if (effect.inline_update) {
      claims.push({
        key: `document-inline:${coordinate}`,
        fingerprint: `${reference.update_hash}:${reference.update_byte_length}`,
      });
    }
  }
  for (const effect of packet.projection_effects) {
    claims.push({
      key: `projection:${effect.scope.canonical_key}:${effect.result_revision}`,
      fingerprint: effect.effect_hash,
    });
  }
  return claims;
};

const documentDeliveries = (
  packet: CoreAuthorizedDeliveryPacket,
  admittedByKey: ReadonlyMap<string, AdmittedClaim>,
): readonly DocumentDelivery[] => {
  const claimsByDocument = new Map<string, AdmittedClaim[]>();
  const add = (documentId: string, key: string): void => {
    const claim = admittedByKey.get(key);
    if (!claim) return;
    const claims = claimsByDocument.get(documentId) ?? [];
    claims.push(claim);
    claimsByDocument.set(documentId, claims);
  };
  for (const effect of packet.document_effects) {
    const reference = effect.reference;
    const coordinate = [
      reference.document_id,
      reference.generation,
      reference.base_head_seq,
      reference.result_head_seq,
      reference.effect_order,
    ].join(":");
    add(reference.document_id, `document:${coordinate}`);
    add(reference.document_id, `document-inline:${coordinate}`);
  }
  for (const atom of packet.atoms) {
    if (atom.payload.module !== "owned_document") continue;
    const documentId = atom.payload.event.document_id;
    add(documentId, `document-control:atom:${atom.descriptor.atom_id}:${documentId}`);
  }
  return [...claimsByDocument]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([documentId, claims]) => ({ documentId, claims }));
};

const trimRemembered = (
  remembered: ReadonlyMap<string, RememberedCommit>,
  maximum: number,
): ReadonlyMap<string, RememberedCommit> => {
  const next = new Map(remembered);
  while (next.size > maximum) {
    const removable = [...next].find(([, commit]) =>
      [...commit.resources.values()].every((resource) => resource.status === "completed"),
    );
    if (!removable) return next;
    next.delete(removable[0]);
  }
  return next;
};

const cloneLanes = (
  lanes: DeliveryLanes,
): Record<LocalCommitLaneKind, Map<string, DeliveryLane>> => ({
  document: new Map(lanes.document),
  projection: new Map(lanes.projection),
  notification: new Map(lanes.notification),
});

const analyzeAdmission = (
  state: LocalCommitState,
  packet: CoreAuthorizedDeliveryPacket,
  options: LocalCommitRuntimeOptions,
): AdmissionAnalysis => {
  const identity = identityOf(packet);
  if (identity.storeEpoch !== options.expectedStoreEpoch) {
    throw new Error(`Commit belongs to another Store epoch: ${identity.key}`);
  }
  if (packet.delivery_address.library_id !== options.expectedLibraryId) {
    throw new Error("Commit delivery belongs to another Library");
  }

  const rememberedCommit = state.remembered.get(identity.key);
  if (rememberedCommit && rememberedCommit.manifestHash !== identity.manifestHash) {
    throw new Error(`Commit manifest identity collision for ${identity.key}`);
  }
  const resources = new Map(rememberedCommit?.resources ?? []);
  const existingCompletions = new Set<Deferred.Deferred<void, LocalCommitRuntimeError>>();
  const newClaims = new Map<string, ResourceClaim>();
  for (const claim of resourceClaims(packet)) {
    const known = resources.get(claim.key);
    const pending = newClaims.get(claim.key);
    if (
      (known && known.fingerprint !== claim.fingerprint) ||
      (pending && pending.fingerprint !== claim.fingerprint)
    ) {
      throw new Error(`Commit resource identity collision for ${identity.key}:${claim.key}`);
    }
    if (known) {
      existingCompletions.add(known.completion);
      continue;
    }
    newClaims.set(claim.key, claim);
  }

  return {
    existingCompletions: [...existingCompletions],
    identity,
    newClaims: [...newClaims.values()],
    rememberedCommit,
    resources,
  };
};

const deliveryTasks = (
  packet: CoreAuthorizedDeliveryPacket,
  ingress: LocalCommitIngress,
  commitKey: string,
  admittedByKey: ReadonlyMap<string, AdmittedClaim>,
  options: LocalCommitRuntimeOptions,
): readonly DeliveryTask[] => {
  const tasks: DeliveryTask[] = [];
  for (const delivery of documentDeliveries(packet, admittedByKey)) {
    tasks.push({
      claims: delivery.claims,
      commitKey,
      kind: "document",
      laneKey: delivery.documentId,
      packet,
      work: options.onDocument(packet, delivery.documentId, ingress),
    });
  }
  for (const effect of packet.projection_effects) {
    const claim = admittedByKey.get(
      `projection:${effect.scope.canonical_key}:${effect.result_revision}`,
    );
    if (!claim) continue;
    tasks.push({
      claims: [claim],
      commitKey,
      kind: "projection",
      laneKey: effect.scope.canonical_key,
      packet,
      work: options.onProjection(packet, effect, ingress),
    });
  }
  for (const atom of packet.atoms) {
    const scopeKey = deliveryAddressKey(packet.delivery_address);
    const claim = admittedByKey.get(
      scopedClaimKey(packet.delivery_address, `notification:atom:${atom.descriptor.atom_id}`),
    );
    if (!claim) continue;
    tasks.push({
      claims: [claim],
      commitKey,
      kind: "notification",
      laneKey: JSON.stringify([scopeKey, commitKey]),
      packet,
      work: options.onNotification(packet, atom, ingress),
    });
  }
  return tasks;
};

const planAdmission = (
  state: LocalCommitState,
  packet: CoreAuthorizedDeliveryPacket,
  ingress: LocalCommitIngress,
  options: LocalCommitRuntimeOptions,
): Effect.Effect<PlannedAdmission, LocalCommitRuntimeError> =>
  Effect.gen(function* () {
    const analysis = yield* Effect.try({
      try: () => analyzeAdmission(state, packet, options),
      catch: (cause) => runtimeError("admit", cause),
    });
    const resources = new Map(analysis.resources);
    const admittedByKey = new Map<string, AdmittedClaim>();
    const completions = new Set(analysis.existingCompletions);
    let nextResourceToken = state.nextResourceToken;
    for (const claim of analysis.newClaims) {
      const completion = yield* Deferred.make<void, LocalCommitRuntimeError>();
      const admitted = { ...claim, completion, token: nextResourceToken };
      nextResourceToken += 1;
      resources.set(claim.key, {
        completion,
        fingerprint: claim.fingerprint,
        status: "in_flight",
        token: admitted.token,
      });
      admittedByKey.set(claim.key, admitted);
      completions.add(completion);
    }

    const remembered = new Map(state.remembered);
    remembered.delete(analysis.identity.key);
    remembered.set(analysis.identity.key, {
      manifestHash: analysis.identity.manifestHash,
      resources,
    });
    if (admittedByKey.size === 0) {
      return {
        admission: { kind: "duplicate", key: analysis.identity.key },
        completions: [...completions],
        nextResourceToken,
        remembered,
        tasks: [],
      };
    }

    const tasks = yield* Effect.try({
      try: () => deliveryTasks(packet, ingress, analysis.identity.key, admittedByKey, options),
      catch: (cause) => runtimeError("admit", cause),
    });

    return {
      admission: {
        kind: analysis.rememberedCommit ? "enriched" : "accepted",
        key: analysis.identity.key,
      },
      completions: [...completions],
      nextResourceToken,
      remembered,
      tasks,
    };
  });

/**
 * Owns process-local LocalCommit deduplication, causal lane workers, retries,
 * and durable waiters in one Main Scope. Admission only schedules shared work;
 * interruption of any individual caller never cancels that physical delivery.
 */
export const make = (
  options: LocalCommitRuntimeOptions,
): Effect.Effect<LocalCommitRuntime["Service"], never, Scope.Scope> =>
  Effect.gen(function* () {
    const maxRememberedCommits = Math.max(1, Math.floor(options.maxRememberedCommits ?? 100_000));
    const maxDeliveryAttempts = Math.max(1, Math.floor(options.maxDeliveryAttempts ?? 3));
    const maxPendingDeliveries = Math.max(1, Math.floor(options.maxPendingDeliveries ?? 10_000));
    const state = yield* Ref.make(initialState);
    const transitions = yield* Semaphore.make(1);
    const workers = yield* FiberSet.make<void, never>();

    const settle = (
      delivery: QueuedDelivery,
      failure: LocalCommitRuntimeError | null,
      beforeCompletion: Effect.Effect<void> = Effect.void,
    ): Effect.Effect<boolean> =>
      transitions.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (current.closed) return true;
            const laneMap = current.lanes[delivery.task.kind];
            const lane = laneMap.get(delivery.task.laneKey);
            if (!lane || lane.token !== delivery.laneToken) return true;

            const remembered = new Map(current.remembered);
            const commit = remembered.get(delivery.task.commitKey);
            const resources = new Map(commit?.resources ?? []);
            const completions: Deferred.Deferred<void, LocalCommitRuntimeError>[] = [];
            for (const claim of delivery.task.claims) {
              const resource = resources.get(claim.key);
              if (!resource || resource.token !== claim.token) continue;
              completions.push(resource.completion);
              if (failure) {
                resources.delete(claim.key);
              } else {
                resources.set(claim.key, { ...resource, status: "completed" });
              }
            }
            if (commit) {
              if (resources.size === 0) remembered.delete(delivery.task.commitKey);
              else remembered.set(delivery.task.commitKey, { ...commit, resources });
            }

            const lanes = cloneLanes(current.lanes);
            const pending = lane.pending - 1;
            if (pending === 0) lanes[delivery.task.kind].delete(delivery.task.laneKey);
            else lanes[delivery.task.kind].set(delivery.task.laneKey, { ...lane, pending });
            yield* Ref.set(state, {
              ...current,
              lanes,
              pendingDeliveries: current.pendingDeliveries - 1,
              remembered: trimRemembered(remembered, maxRememberedCommits),
            });
            yield* beforeCompletion;
            for (const completion of completions) {
              yield* Deferred.done(completion, failure ? Exit.fail(failure) : Exit.void);
            }
            return pending === 0;
          }),
        ),
      );

    const notifyFailure = (failure: LocalCommitDeliveryError): Effect.Effect<void> => {
      if (!options.onError) return Effect.void;
      return Effect.exit(options.onError(failure)).pipe(Effect.asVoid);
    };

    const execute = (delivery: QueuedDelivery, attempt = 1): Effect.Effect<boolean> =>
      Effect.exit(delivery.task.work).pipe(
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit)) return settle(delivery, null);
          if (Cause.hasInterruptsOnly(exit.cause)) return Effect.interrupt;
          if (attempt < maxDeliveryAttempts) return execute(delivery, attempt + 1);
          const cause = Cause.squash(exit.cause);
          const error = runtimeError(`deliver.${delivery.task.kind}`, cause);
          return settle(
            delivery,
            error,
            notifyFailure({
              lane: delivery.task.kind,
              laneKey: delivery.task.laneKey,
              packet: delivery.task.packet,
              error: cause,
            }),
          );
        }),
      );

    const runLane = (lane: DeliveryLane): Effect.Effect<void> => {
      const loop: Effect.Effect<void> = Queue.take(lane.queue).pipe(
        Effect.flatMap((delivery) =>
          execute(delivery).pipe(
            Effect.flatMap((empty) => {
              if (empty) return Queue.shutdown(lane.queue).pipe(Effect.asVoid);
              return Effect.suspend(() => loop);
            }),
          ),
        ),
      );
      return loop;
    };

    const admitInternal = (
      packet: CoreAuthorizedDeliveryPacket,
      ingress: LocalCommitIngress,
    ): Effect.Effect<PlannedAdmission, LocalCommitRuntimeError> =>
      transitions.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (current.closed) {
              return yield* runtimeError("admit", new Error("LocalCommit runtime is closed"));
            }
            const planned = yield* planAdmission(current, packet, ingress, options);
            if (current.pendingDeliveries + planned.tasks.length > maxPendingDeliveries) {
              return yield* runtimeError(
                "admit.capacity",
                new Error(`LocalCommit delivery capacity ${maxPendingDeliveries} is exhausted`),
              );
            }

            const lanes = cloneLanes(current.lanes);
            const created: DeliveryLane[] = [];
            const scheduled: { readonly delivery: QueuedDelivery; readonly lane: DeliveryLane }[] =
              [];
            let nextLaneToken = current.nextLaneToken;
            for (const task of planned.tasks) {
              let lane = lanes[task.kind].get(task.laneKey);
              if (!lane) {
                // Global admission already fences total pending deliveries; the per-lane queue
                // uses the same hard bound so a future admission regression still fails closed.
                const queue = yield* Queue.bounded<QueuedDelivery>(maxPendingDeliveries);
                lane = { pending: 0, queue, token: nextLaneToken };
                nextLaneToken += 1;
                created.push(lane);
              }
              lane = { ...lane, pending: lane.pending + 1 };
              lanes[task.kind].set(task.laneKey, lane);
              scheduled.push({ delivery: { laneToken: lane.token, task }, lane });
            }

            yield* Ref.set(state, {
              ...current,
              lanes,
              nextLaneToken,
              nextResourceToken: planned.nextResourceToken,
              pendingDeliveries: current.pendingDeliveries + planned.tasks.length,
              remembered: trimRemembered(planned.remembered, maxRememberedCommits),
            });
            for (const item of scheduled) {
              if (!(yield* Queue.offer(item.lane.queue, item.delivery))) {
                return yield* Effect.die(new Error("Open LocalCommit lane rejected delivery"));
              }
            }
            for (const lane of created) {
              yield* FiberSet.run(workers, runLane(lane), { startImmediately: true });
            }
            return planned;
          }),
        ),
      );

    const admit = (
      packet: CoreAuthorizedDeliveryPacket,
      ingress: LocalCommitIngress,
    ): Effect.Effect<LocalCommitAdmission, LocalCommitRuntimeError> =>
      admitInternal(packet, ingress).pipe(Effect.map((planned) => planned.admission));

    const admitAndWait = (
      packet: CoreAuthorizedDeliveryPacket,
      ingress: "tailer",
    ): Effect.Effect<LocalCommitAdmission, LocalCommitRuntimeError> =>
      Effect.gen(function* () {
        const planned = yield* admitInternal(packet, ingress);
        yield* Effect.forEach(planned.completions, Deferred.await, { concurrency: "unbounded" });
        return planned.admission;
      });

    const observeCheckpoint = (
      checkpoint: CoreStreamCheckpoint,
    ): Effect.Effect<void, LocalCommitRuntimeError> =>
      transitions.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* Ref.get(state);
          if (current.closed) {
            return yield* runtimeError("checkpoint", new Error("LocalCommit runtime is closed"));
          }
          if (checkpoint.store_epoch !== options.expectedStoreEpoch) {
            return yield* runtimeError(
              "checkpoint",
              new Error("Stream checkpoint belongs to another Store epoch"),
            );
          }
          if (
            current.checkpoint &&
            checkpoint.generation === current.checkpoint.generation &&
            checkpoint.scanned_through_seq < current.checkpoint.scanned_through_seq
          ) {
            return yield* runtimeError(
              "checkpoint",
              new Error("Stream checkpoint moved backwards"),
            );
          }
          yield* Ref.set(state, { ...current, checkpoint });
        }),
      );

    const resetStream = (reason: LocalCommitStreamResetReason): Effect.Effect<void> =>
      transitions.withPermits(1)(
        Ref.update(state, (current) =>
          current.closed ? current : { ...current, checkpoint: null, lastResetReason: reason },
        ),
      );

    yield* Effect.addFinalizer(() =>
      transitions.withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const current = yield* Ref.get(state);
            if (current.closed) return;
            const closure = runtimeError("close", new Error("LocalCommit runtime closed"));
            const completions = [...current.remembered.values()].flatMap((commit) =>
              [...commit.resources.values()]
                .filter((resource) => resource.status === "in_flight")
                .map((resource) => resource.completion),
            );
            const queues = (Object.keys(current.lanes) as LocalCommitLaneKind[]).flatMap((kind) =>
              [...current.lanes[kind].values()].map((lane) => lane.queue),
            );
            yield* Ref.set(state, {
              ...current,
              closed: true,
              lanes: emptyLanes(),
              pendingDeliveries: 0,
              remembered: new Map(),
            });
            for (const completion of completions) {
              yield* Deferred.done(completion, Exit.fail(closure));
            }
            yield* Effect.forEach(queues, Queue.shutdown, { discard: true });
          }),
        ),
      ),
    );

    return LocalCommitRuntime.of({
      admit,
      admitAndWait,
      diagnostics: Ref.get(state).pipe(
        Effect.map((current) => ({
          rememberedCommits: current.remembered.size,
          activeLanes: {
            document: current.lanes.document.size,
            projection: current.lanes.projection.size,
            notification: current.lanes.notification.size,
          },
          pendingDeliveries: current.pendingDeliveries,
          checkpoint: current.checkpoint,
          lastResetReason: current.lastResetReason,
        })),
      ),
      observeCheckpoint,
      resetStream,
    });
  });
