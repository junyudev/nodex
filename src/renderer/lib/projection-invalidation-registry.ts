import type {
  ProjectionCursor,
  ProjectionDelivery,
  ProjectionImpact,
  ProjectionScope,
  ProjectionStreamMessage,
} from "../../shared/projection-stream";
import { projectionCursorCovers, projectionScopeKey } from "../../shared/projection-stream";
import type { CausalProjectionRuntime } from "./causal-projection-runtime";
import { BoundedBurstScheduler, type BoundedBurstTiming } from "./bounded-burst-scheduler";

export interface ProjectionResourceDependencies {
  readonly pageIds?: readonly string[];
  readonly databaseIds?: readonly string[];
  readonly dataSourceIds?: readonly string[];
  readonly viewIds?: readonly string[];
  readonly documentIds?: readonly string[];
  readonly canvasIds?: readonly string[];
  readonly fileIds?: readonly string[];
  readonly aggregate?: boolean;
}

export type ProjectionDependencies = ProjectionResourceDependencies;

export type ProjectionInvalidationCause = ProjectionStreamMessage;
export type ProjectionFenceCause = Extract<
  ProjectionStreamMessage,
  { readonly kind: "checkpoint" | "reset" }
>;

export interface ProjectionRegistration {
  readonly scope: ProjectionScope;
  readonly consumerKey: string;
  readonly causalRuntime?: CausalProjectionRuntime;
  /** Consumers may observe resets without matching content effects. */
  readonly projectionEffects?: "match" | "ignore";
  getDependencies(): ProjectionDependencies;
  getCursor(): ProjectionCursor | null;
  /** Clears authority synchronously when a checkpoint/reset exposes a gap. */
  fence?(cause: ProjectionFenceCause): void;
  invalidate(cause: ProjectionInvalidationCause): void | Promise<void>;
}

type SubscribeProjection = (
  scope: ProjectionScope,
  listener: (message: ProjectionStreamMessage) => void,
) => () => void;

interface ConsumerState {
  readonly registrations: Map<symbol, ProjectionRegistration>;
  scheduler: BoundedBurstScheduler | null;
  running: boolean;
  pending: ProjectionInvalidationCause | null;
  required: ProjectionInvalidationCause | null;
  initialCheckpointObserved: boolean;
}

interface ScopeState {
  readonly scope: ProjectionScope;
  readonly consumers: Map<string, ConsumerState>;
  unsubscribeProjection: (() => void) | null;
  latestCursor: ProjectionCursor | null;
}

export class ProjectionInvalidationRegistry {
  readonly #subscribeProjection: SubscribeProjection;
  readonly #scopes = new Map<string, ScopeState>();
  readonly #effectRepairBurst: BoundedBurstTiming;

  constructor(input: {
    readonly subscribeProjection: SubscribeProjection;
    readonly effectRepairBurst?: BoundedBurstTiming;
  }) {
    this.#subscribeProjection = input.subscribeProjection;
    this.#effectRepairBurst = input.effectRepairBurst ?? {
      quietMs: 0,
      maxMs: 0,
    };
  }

  register(registration: ProjectionRegistration): () => void {
    const scopeKey = projectionScopeKey(registration.scope);
    const scope = this.#scopes.get(scopeKey) ?? {
      scope: registration.scope,
      consumers: new Map<string, ConsumerState>(),
      unsubscribeProjection: null,
      latestCursor: null,
    };
    this.#scopes.set(scopeKey, scope);
    const existingConsumer = scope.consumers.get(registration.consumerKey);
    const consumer = existingConsumer ?? this.#createConsumer();
    scope.consumers.set(registration.consumerKey, consumer);
    const token = Symbol(registration.consumerKey);
    consumer.registrations.set(token, registration);

    if (!scope.unsubscribeProjection) {
      scope.unsubscribeProjection = this.#subscribeProjection(scope.scope, (message) => {
        this.#handle(scope, message);
      });
    }
    if (!existingConsumer && scope.latestCursor) {
      this.#handleConsumer(consumer, {
        version: 2,
        kind: "checkpoint",
        scope: scope.scope,
        stream: scope.latestCursor,
      });
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      consumer.registrations.delete(token);
      if (consumer.registrations.size === 0) {
        consumer.scheduler?.dispose();
        scope.consumers.delete(registration.consumerKey);
      }
      if (scope.consumers.size > 0) return;
      scope.unsubscribeProjection?.();
      scope.unsubscribeProjection = null;
      this.#scopes.delete(scopeKey);
    };
  }

  dispose(): void {
    for (const scope of this.#scopes.values()) {
      scope.unsubscribeProjection?.();
      for (const consumer of scope.consumers.values()) {
        consumer.scheduler?.dispose();
      }
    }
    this.#scopes.clear();
  }

  #createConsumer(): ConsumerState {
    const consumer: ConsumerState = {
      registrations: new Map<symbol, ProjectionRegistration>(),
      scheduler: null,
      running: false,
      pending: null,
      required: null,
      initialCheckpointObserved: false,
    };
    consumer.scheduler = new BoundedBurstScheduler({
      ...this.#effectRepairBurst,
      onReady: () => this.#startDrain(consumer),
    });
    return consumer;
  }

  #handle(scope: ScopeState, message: ProjectionInvalidationCause): void {
    if (projectionScopeKey(message.scope) !== projectionScopeKey(scope.scope)) return;
    scope.latestCursor = laterCursor(scope.latestCursor, message.stream);
    for (const consumer of scope.consumers.values()) {
      this.#handleConsumer(consumer, message);
    }
  }

  #handleConsumer(consumer: ConsumerState, message: ProjectionInvalidationCause): void {
    const registrations = [...consumer.registrations.values()];
    if (registrations.length === 0) return;
    const runtimes = new Set(
      registrations
        .map((registration) => registration.causalRuntime)
        .filter((runtime): runtime is CausalProjectionRuntime => Boolean(runtime)),
    );
    for (const runtime of runtimes) {
      if (message.kind === "effect") runtime.accept(message.delivery);
      if (message.kind === "checkpoint") {
        runtime.observeInitialCheckpoint({
          storeEpoch: message.stream.storeEpoch,
          scannedThroughCommitSeq: message.stream.commitSeq,
        });
      }
      if (message.kind === "reset") {
        runtime.reset({
          storeEpoch: message.stream.storeEpoch,
          commitSeq: message.stream.commitSeq,
        });
      }
    }

    const registration = registrations[0];
    if (!registration) return;
    if (message.kind === "checkpoint") {
      if (consumer.initialCheckpointObserved) return;
      consumer.initialCheckpointObserved = true;
    }
    if (!this.#shouldInvalidate(registration, message)) return;
    if (message.kind === "checkpoint" || message.kind === "reset") {
      registration.fence?.(message);
    }
    this.#schedule(consumer, message);
  }

  #shouldInvalidate(
    registration: ProjectionRegistration,
    message: ProjectionInvalidationCause,
  ): boolean {
    if (registration.projectionEffects === "ignore" && message.kind === "effect") return false;
    if (message.kind === "reset") return true;
    const cursor = registration.getCursor();
    if (cursor && cursor.storeEpoch !== message.stream.storeEpoch) return true;
    if (projectionCursorCovers(cursor, message.stream)) return false;
    if (message.kind === "checkpoint") return true;
    return projectionEffectMatches(registration.getDependencies(), message.delivery);
  }

  #schedule(consumer: ConsumerState, message: ProjectionInvalidationCause): void {
    if (consumer.required) {
      consumer.pending = laterCause(consumer.pending, consumer.required);
      consumer.required = null;
    }
    consumer.pending = laterCause(consumer.pending, message);
    if (consumer.running) return;
    consumer.scheduler?.request(consumer.pending.kind === "effect" ? "deferred" : "immediate");
  }

  #startDrain(consumer: ConsumerState): void {
    if (consumer.running || !consumer.pending) return;
    consumer.running = true;
    void this.#drainOne(consumer).finally(() => {
      consumer.running = false;
      const pending = consumer.pending;
      if (pending) this.#schedule(consumer, pending);
    });
  }

  async #drainOne(consumer: ConsumerState): Promise<void> {
    let failureRetryBudget = 1;
    const cause = consumer.pending;
    if (!cause) return;
    consumer.pending = null;
    while (true) {
      const registration = consumer.registrations.values().next().value as
        | ProjectionRegistration
        | undefined;
      if (!registration) return;
      if (
        cause.kind !== "reset" &&
        projectionCursorCovers(registration.getCursor(), cause.stream)
      ) {
        return;
      }
      try {
        await registration.invalidate(cause);
      } catch {
        if (failureRetryBudget > 0) {
          failureRetryBudget -= 1;
          continue;
        }
        consumer.required = laterCause(consumer.required, cause);
        return;
      }
      return;
    }
  }
}

const intersects = (left: readonly string[] | undefined, right: readonly string[]): boolean => {
  if (!left?.length || right.length === 0) return false;
  const values = new Set(left);
  return right.some((value) => values.has(value));
};

export const impactMatches = (
  dependencies: ProjectionResourceDependencies,
  impact: ProjectionImpact,
): boolean => {
  if (impact.kind === "none") return false;
  if (impact.kind === "all" || dependencies.aggregate === true) return true;
  return (
    intersects(dependencies.pageIds, impact.page_ids) ||
    intersects(dependencies.databaseIds, impact.database_ids) ||
    intersects(dependencies.dataSourceIds, impact.data_source_ids) ||
    intersects(dependencies.viewIds, impact.view_ids) ||
    intersects(
      dependencies.documentIds,
      impact.document_heads.map((head) => head.document_id),
    )
  );
};

export const projectionEffectMatches = (
  dependencies: ProjectionDependencies,
  delivery: ProjectionDelivery,
): boolean => {
  if (delivery.impact.kind === "none") return false;
  if (dependencies.aggregate === true) return true;
  const scope = delivery.effect.scope.scope;
  switch (scope.kind) {
    case "structural_history":
      return false;
    case "library":
    case "project":
      return true;
    case "page":
      return (
        intersects(dependencies.pageIds, [scope.page_id]) ||
        intersects(
          dependencies.documentIds,
          delivery.impact.kind === "resources"
            ? delivery.impact.document_heads
                .filter((head) => head.page_id === scope.page_id)
                .map((head) => head.document_id)
            : [],
        )
      );
    case "database_view":
      return intersects(dependencies.viewIds, [scope.view_id]);
    case "page_detail_database":
      return intersects(dependencies.databaseIds, [scope.database_id]);
    case "page_detail_data_source":
      return intersects(dependencies.dataSourceIds, [scope.data_source_id]);
  }
};

const messagePriority = (message: ProjectionInvalidationCause): number => {
  if (message.kind === "reset") return 4;
  if (message.kind === "effect") return 2;
  return 1;
};

const laterCursor = (
  current: ProjectionCursor | null,
  incoming: ProjectionCursor,
): ProjectionCursor => {
  if (!current || current.storeEpoch !== incoming.storeEpoch) return incoming;
  return incoming.commitSeq >= current.commitSeq ? incoming : current;
};

const laterCause = (
  current: ProjectionInvalidationCause | null,
  incoming: ProjectionInvalidationCause,
): ProjectionInvalidationCause => {
  if (!current) return incoming;
  if (current.stream.storeEpoch !== incoming.stream.storeEpoch) return incoming;
  if (incoming.stream.commitSeq > current.stream.commitSeq) return incoming;
  if (incoming.stream.commitSeq < current.stream.commitSeq) return current;
  return messagePriority(incoming) >= messagePriority(current) ? incoming : current;
};
