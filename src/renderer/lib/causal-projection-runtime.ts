import type {
  ProjectionCoordinate,
  ProjectionDelivery,
  ProjectionEffect,
} from "../../shared/projection-stream";
import { BoundedBurstScheduler, type BoundedBurstTiming } from "./bounded-burst-scheduler";

export type ProjectionRepairReason =
  | "subscription_checkpoint_gap"
  | "effect_gap"
  | "patch_unavailable"
  | "effect_requires_read"
  | "stream_reset"
  | "integrity_failure";

export interface ProjectionRepairRequest {
  readonly storeEpoch: string;
  readonly scopeKey: string;
  readonly minimumRevision: number;
  readonly minimumCommitSeq: number;
  readonly reason: ProjectionRepairReason;
}

export interface CausalProjectionRuntimeInput {
  readonly scopeKey: string;
  readonly schemaVersion: number;
  getCoordinate(): ProjectionCoordinate | null;
  apply(effect: ProjectionEffect): void;
  readAtLeast(request: ProjectionRepairRequest): Promise<void>;
  onIntegrityFailure?(error: Error): void;
  readonly repairBurst?: BoundedBurstTiming;
}

interface BufferedEffect {
  readonly delivery: ProjectionDelivery;
}

const maxRepair = (
  left: ProjectionRepairRequest | null,
  right: ProjectionRepairRequest,
): ProjectionRepairRequest => {
  if (!left || left.storeEpoch !== right.storeEpoch) return right;
  return {
    ...right,
    minimumRevision: Math.max(left.minimumRevision, right.minimumRevision),
    minimumCommitSeq: Math.max(left.minimumCommitSeq, right.minimumCommitSeq),
  };
};

export const INTERACTIVE_PROJECTION_REPAIR_BURST = Object.freeze({
  quietMs: 300,
  maxMs: 5_000,
}) satisfies BoundedBurstTiming;

const MAX_BUFFERED_PROJECTION_EFFECTS = 128;
const REPAIR_RETRY_INITIAL_MS = 100;
const REPAIR_RETRY_MAX_MS = 5_000;

const bufferKey = (delivery: ProjectionDelivery): string =>
  JSON.stringify([delivery.storeEpoch, delivery.effect.baseRevision]);

const repairCanWaitForBurst = (reason: ProjectionRepairReason): boolean =>
  reason === "patch_unavailable" || reason === "effect_requires_read";

/**
 * Orders one exact projection scope by its Core-owned revision. Patches make
 * local commits visible synchronously; canonical reads only close gaps and
 * can never authorize an older snapshot to replace a newer coordinate.
 */
export class CausalProjectionRuntime {
  readonly #input: CausalProjectionRuntimeInput;
  readonly #buffer = new Map<string, BufferedEffect>();
  readonly #repairScheduler: BoundedBurstScheduler;
  #repairing = false;
  #requiredRepair: ProjectionRepairRequest | null = null;
  #repairUrgent = false;
  #disposed = false;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #repairRetryAttempt = 0;

  constructor(input: CausalProjectionRuntimeInput) {
    this.#input = input;
    const repairBurst = input.repairBurst ?? INTERACTIVE_PROJECTION_REPAIR_BURST;
    this.#repairScheduler = new BoundedBurstScheduler({
      ...repairBurst,
      onReady: () => this.#beginRepair(),
    });
  }

  accept(delivery: ProjectionDelivery): void {
    if (this.#disposed) return;
    const effect = delivery.effect;
    if (
      effect.scope.canonical_key !== this.#input.scopeKey ||
      effect.scope.schema_version !== this.#input.schemaVersion
    ) {
      return;
    }
    this.#acceptEffect(delivery);
  }

  /** A subscription can advance its required floor again while admission is pending. */
  observeSubscriptionCheckpoint(input: {
    readonly storeEpoch: string;
    readonly scannedThroughCommitSeq: number;
  }): void {
    if (this.#disposed) return;
    const current = this.#input.getCoordinate();
    if (
      current?.storeEpoch === input.storeEpoch &&
      current.coveredCommitSeq >= input.scannedThroughCommitSeq
    ) {
      return;
    }
    this.#requestRepair({
      storeEpoch: input.storeEpoch,
      scopeKey: this.#input.scopeKey,
      minimumRevision: current?.storeEpoch === input.storeEpoch ? current.revision : 0,
      minimumCommitSeq: input.scannedThroughCommitSeq,
      reason: "subscription_checkpoint_gap",
    });
  }

  reset(input: { readonly storeEpoch: string; readonly commitSeq: number }): void {
    if (this.#disposed) return;
    this.#buffer.clear();
    this.#requestRepair({
      storeEpoch: input.storeEpoch,
      scopeKey: this.#input.scopeKey,
      minimumRevision: 0,
      minimumCommitSeq: input.commitSeq,
      reason: "stream_reset",
    });
  }

  diagnostics(): {
    readonly bufferedEffects: number;
    readonly repairing: boolean;
    readonly repairScheduled: boolean;
    readonly requiredRepair: ProjectionRepairRequest | null;
  } {
    return {
      bufferedEffects: this.#buffer.size,
      repairing: this.#repairing,
      repairScheduled: this.#repairScheduler.scheduled,
      requiredRepair: this.#requiredRepair,
    };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#buffer.clear();
    this.#requiredRepair = null;
    this.#repairUrgent = false;
    this.#repairRetryAttempt = 0;
    this.#repairScheduler.dispose();
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #acceptEffect(delivery: ProjectionDelivery): void {
    const effect = delivery.effect;
    const current = this.#input.getCoordinate();
    if (
      !current ||
      current.storeEpoch !== delivery.storeEpoch ||
      current.scopeKey !== effect.scope.canonical_key ||
      current.schemaVersion !== effect.scope.schema_version
    ) {
      this.#bufferEffect(delivery);
      this.#requestRepairFor(delivery, "effect_gap");
      return;
    }
    if (current.revision > effect.resultRevision) return;
    if (current.revision === effect.resultRevision) {
      if (current.effectHash === effect.effectHash) return;
      this.#failIntegrity(
        `Projection revision ${effect.resultRevision} has conflicting effect hashes`,
        delivery,
      );
      return;
    }
    if (current.revision < effect.baseRevision) {
      const predecessor = this.#buffer.get(
        JSON.stringify([delivery.storeEpoch, effect.baseRevision - 1]),
      );
      this.#bufferEffect(delivery);
      this.#requestRepairFor(
        delivery,
        predecessor?.delivery.effect.resultRevision === effect.baseRevision
          ? "patch_unavailable"
          : "effect_gap",
      );
      return;
    }
    if (current.revision !== effect.baseRevision) {
      this.#failIntegrity("Projection effect does not continue its current revision", delivery);
      return;
    }
    if (!effect.patch) {
      this.#bufferEffect(delivery);
      this.#requestRepairFor(delivery, "patch_unavailable");
      return;
    }
    try {
      this.#input.apply(effect);
    } catch (error) {
      this.#failIntegrity(
        error instanceof Error ? error.message : "Projection patch reducer failed",
        delivery,
      );
      return;
    }
    const applied = this.#input.getCoordinate();
    if (
      !applied ||
      applied.storeEpoch !== delivery.storeEpoch ||
      applied.revision !== effect.resultRevision ||
      applied.effectHash !== effect.effectHash
    ) {
      this.#failIntegrity("Projection reducer did not adopt the exact effect coordinate", delivery);
      return;
    }
    if (effect.requiresReadAtLeast) {
      this.#requestRepairFor(delivery, "effect_requires_read");
    }
    this.#drainBuffered();
  }

  #bufferEffect(delivery: ProjectionDelivery): void {
    const effect = delivery.effect;
    const key = bufferKey(delivery);
    const existing = this.#buffer.get(key);
    if (existing?.delivery.effect.effectHash === effect.effectHash) return;
    if (existing) {
      this.#failIntegrity(
        `Projection base revision ${effect.baseRevision} has multiple successors`,
        delivery,
      );
      return;
    }
    if (this.#buffer.size >= MAX_BUFFERED_PROJECTION_EFFECTS) {
      // Every buffered edge is recoverable from the already-required canonical
      // read. Compacting here prevents a stalled renderer/Core boundary from
      // retaining an unbounded stream tail.
      this.#buffer.clear();
    }
    this.#buffer.set(key, { delivery });
  }

  #drainBuffered(): void {
    while (true) {
      const current = this.#input.getCoordinate();
      if (!current) return;
      const key = JSON.stringify([current.storeEpoch, current.revision]);
      const buffered = this.#buffer.get(key);
      if (!buffered) return;
      this.#buffer.delete(key);
      const before = current.revision;
      this.#acceptEffect(buffered.delivery);
      if (this.#input.getCoordinate()?.revision === before) return;
    }
  }

  #requestRepairFor(delivery: ProjectionDelivery, reason: ProjectionRepairReason): void {
    this.#requestRepair({
      storeEpoch: delivery.storeEpoch,
      scopeKey: delivery.effect.scope.canonical_key,
      minimumRevision: delivery.effect.resultRevision,
      minimumCommitSeq: delivery.effect.coveredCommitSeq,
      reason,
    });
  }

  #requestRepair(request: ProjectionRepairRequest): void {
    if (this.#disposed) return;
    const incomingUrgent = !repairCanWaitForBurst(request.reason);
    this.#requiredRepair = maxRepair(this.#requiredRepair, request);
    this.#repairUrgent ||= incomingUrgent;
    if (this.#repairing) return;
    if (this.#retryTimer !== null) {
      // A routine effect cannot turn an unavailable canonical reader into one
      // retry per notification. A new integrity/reset boundary may preempt the
      // backoff because stale authority has already been fenced.
      if (!incomingUrgent) return;
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#repairScheduler.request(this.#repairUrgent ? "immediate" : "deferred");
  }

  #beginRepair(): void {
    if (this.#disposed || this.#repairing || !this.#requiredRepair) return;
    this.#repairing = true;
    void this.#drainOneRepair();
  }

  async #drainOneRepair(): Promise<void> {
    const request = this.#requiredRepair;
    if (!request) {
      this.#repairing = false;
      return;
    }
    this.#requiredRepair = null;
    this.#repairUrgent = false;
    let retry = false;
    try {
      await this.#input.readAtLeast(request);
      const current = this.#input.getCoordinate();
      if (
        !current ||
        current.storeEpoch !== request.storeEpoch ||
        current.scopeKey !== request.scopeKey ||
        current.revision < request.minimumRevision ||
        current.coveredCommitSeq < request.minimumCommitSeq
      ) {
        this.#requiredRepair = maxRepair(this.#requiredRepair, request);
        this.#repairUrgent = true;
        retry = true;
      } else {
        this.#repairRetryAttempt = 0;
        this.#dropCoveredBuffer(current);
        this.#drainBuffered();
      }
    } catch {
      this.#requiredRepair = maxRepair(this.#requiredRepair, request);
      this.#repairUrgent = true;
      retry = true;
    } finally {
      this.#repairing = false;
    }

    if (this.#disposed || !this.#requiredRepair) return;
    if (retry) {
      // Exponential backoff keeps a missing Core/read boundary from becoming
      // persistent IPC pressure while retaining a finite convergence retry.
      const retryDelayMs = Math.min(
        REPAIR_RETRY_INITIAL_MS * 2 ** this.#repairRetryAttempt,
        REPAIR_RETRY_MAX_MS,
      );
      this.#repairRetryAttempt += 1;
      this.#retryTimer = setTimeout(() => {
        this.#retryTimer = null;
        if (this.#disposed || !this.#requiredRepair) return;
        this.#repairScheduler.request("immediate");
      }, retryDelayMs);
      return;
    }
    this.#repairScheduler.request(this.#repairUrgent ? "immediate" : "deferred");
  }

  #dropCoveredBuffer(current: ProjectionCoordinate): void {
    for (const [key, buffered] of this.#buffer) {
      const effect = buffered.delivery.effect;
      if (buffered.delivery.storeEpoch !== current.storeEpoch) {
        this.#buffer.delete(key);
        continue;
      }
      if (effect.resultRevision > current.revision) continue;
      if (effect.resultRevision === current.revision && current.effectHash !== effect.effectHash) {
        this.#failIntegrity(
          `Canonical projection revision ${current.revision} conflicts with a buffered effect`,
          buffered.delivery,
        );
        return;
      }
      this.#buffer.delete(key);
    }
  }

  #failIntegrity(message: string, delivery: ProjectionDelivery): void {
    this.#buffer.clear();
    const error = new Error(message);
    this.#input.onIntegrityFailure?.(error);
    this.#requestRepairFor(delivery, "integrity_failure");
  }
}
