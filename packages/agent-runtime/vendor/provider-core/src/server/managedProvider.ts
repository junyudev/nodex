import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@nodex/runtime-contracts";
import { resolveServerBackgroundActivitySettings } from "@nodex/runtime-shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderHost from "./ProviderHost.ts";
import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";
import type { ManagedServerProvider } from "./snapshot.ts";

/** The first retry after a check that ended without an answer; each later retry doubles it. */
const UNSETTLED_CHECK_RETRY_INITIAL_MS = 15_000;

/** A transient readiness failure can recover even when local authentication is known. */
export const isUnsettledProviderFailure = (snapshot: ServerProvider): boolean =>
  snapshot.enabled &&
  snapshot.status === "error" &&
  (snapshot.issue !== undefined || snapshot.auth.status === "unknown");

/** A snapshot that can publish before the same scoped check finishes its optional reads. */
export interface PreparedProviderSnapshot {
  readonly snapshot: ServerProvider;
  readonly complete: Effect.Effect<ServerProvider>;
}

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
  readonly modelReads: Deferred.Deferred<void> | undefined;
}

function withUsageLimits(
  snapshot: ServerProvider,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  if (snapshot.usageLimits === usageLimits) {
    return snapshot;
  }
  const { usageLimits: _previous, ...rest } = snapshot;
  return usageLimits ? { ...rest, usageLimits } : rest;
}

/** A check can retain ready state while its scheduler confirms a transient failure. */
export const DeferringFailedCheck = Context.Reference<boolean>("@nodex/provider-core/DeferringFailedCheck", {
  defaultValue: () => false,
});

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly resolveMaintenance: ManagedServerProvider["resolveMaintenance"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  /** Some drivers inspect local readiness while constructing the initial snapshot. */
  readonly initialSnapshotIsChecked?: true;
  readonly checkProvider: Effect.Effect<
    ServerProvider | PreparedProviderSnapshot,
    ServerSettingsError,
    Scope.Scope
  >;
  /** Enrichment publishes the provider's authoritative limits, including account resets. */
  readonly enrichmentOwnsUsageLimits?: true;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
  readonly refreshOnInterval?: boolean;
  readonly deferFailedPeriodicChecks?: boolean;
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean;
}): Effect.fn.Return<
  ManagedServerProvider,
  ServerSettingsError,
  Scope.Scope | ProviderHost.ProviderHost
> {
  const host = yield* ProviderHost.ProviderHost;
  const refreshSemaphore = yield* Semaphore.make(1);
  const recheckPendingRef = yield* Ref.make(false);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  // Wakes the refresh loop to reconsider its schedule: the interval changed, or a check finished.
  const scheduleChanges = yield* Queue.sliding<void>(1);
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot:
      initialSnapshot.enabled && !input.initialSnapshotIsChecked
        ? { ...initialSnapshot, checkPending: true, installed: false, status: "warning" }
        : initialSnapshot,
    enrichmentGeneration: 0,
    modelReads: undefined,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
    usageReadFrom?: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation) {
        return [null, state] as const;
      }
      // Enrichment derives from the snapshot it was handed; a runtime usage
      // update that landed since must not be reverted by it.
      const usageLimits =
        input.enrichmentOwnsUsageLimits
          ? nextSnapshot.usageLimits
          : usageReadFrom && state.snapshot.usageLimits === usageReadFrom.usageLimits
            ? resolveUsageLimitsAfterProbe({
                published: state.snapshot.usageLimits,
                probed: nextSnapshot.usageLimits,
              })
            : state.snapshot.usageLimits;
      const workspaceId = state.snapshot.auth.workspaceId;
      const merged = withUsageLimits(
        usageLimits !== nextSnapshot.usageLimits && workspaceId && !nextSnapshot.auth.workspaceId
          ? { ...nextSnapshot, auth: { ...nextSnapshot.auth, workspaceId } }
          : nextSnapshot,
        usageLimits,
      );
      if (Equal.equals(state.snapshot, merged)) {
        return [null, state] as const;
      }
      return [merged, { ...state, snapshot: merged }] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
    completion?: {
      readonly read: Effect.Effect<ServerProvider>;
      readonly done: Deferred.Deferred<void>;
    },
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    // Enrichment resolves binaries and package-manager state, which a disabled
    // provider has no use for.
    if ((!input.enrichSnapshot && !completion) || !snapshot.enabled) return;

    const settleModelReads = completion ? Deferred.succeed(completion.done, undefined) : Effect.void;
    const getSnapshot = Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    const fiber = yield* Effect.gen(function* () {
      if (completion) {
        const completed = yield* completion.read;
        yield* publishEnrichedSnapshot(generation, completed, snapshot);
        yield* settleModelReads;
      }
      if (input.enrichSnapshot) {
        yield* input.enrichSnapshot({
          settings,
          snapshot: yield* getSnapshot,
          getSnapshot,
          publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
        });
      }
    }).pipe(
      Effect.ensuring(settleModelReads),
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(scope),
    );

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean; readonly deferFailure?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    if (
      !forceRefresh &&
      input.checkProviderOnSettingsChange?.(previousSettings, nextSettings) === false
    ) {
      const state = yield* Ref.get(snapshotStateRef);
      const nextGeneration = state.enrichmentGeneration + 1;
      yield* Ref.set(snapshotStateRef, {
        snapshot: state.snapshot,
        enrichmentGeneration: nextGeneration,
        modelReads: undefined,
      });
      yield* Ref.set(settingsRef, nextSettings);
      yield* restartSnapshotEnrichment(nextSettings, state.snapshot, nextGeneration);
      return state.snapshot;
    }

    const checkScope = yield* Scope.fork(scope);
    const modelReadsDone = yield* Deferred.make<void>();
    return yield* Effect.gen(function* () {
      const checked = yield* input.checkProvider.pipe(
        Effect.provideService(Scope.Scope, checkScope),
        Effect.provideService(DeferringFailedCheck, options?.deferFailure === true),
      );
      const [probedSnapshot, complete] =
        "complete" in checked ? [checked.snapshot, checked.complete] : [checked, undefined];
      if (
        options?.deferFailure &&
        !complete &&
        probedSnapshot.status === "error" &&
        probedSnapshot.auth.status !== "unauthenticated"
      ) {
        const { snapshot } = yield* Ref.get(snapshotStateRef);
        if (snapshot.enabled && snapshot.status === "ready") {
          yield* Ref.set(recheckPendingRef, true);
          yield* Queue.offer(scheduleChanges, undefined);
          yield* Scope.close(checkScope, Exit.void);
          return snapshot;
        }
      }
      yield* Ref.set(recheckPendingRef, false);
      const modelReads = complete && probedSnapshot.enabled ? modelReadsDone : undefined;
      const { snapshot: nextSnapshot, generation: nextGeneration } = yield* Ref.modify(
        snapshotStateRef,
        (state) => {
          const generation = state.enrichmentGeneration + 1;
          // A failed read keeps the last good limits only for the same account,
          // and they keep the workspace they were read for.
          const previous = state.snapshot.auth;
          const differs = (a: string | undefined, b: string | undefined) =>
            a !== undefined && b !== undefined && a !== b;
          // Limits read without a workspace cannot be attributed to a new one.
          const switchedAccount =
            differs(probedSnapshot.auth.email?.toLowerCase(), previous.email?.toLowerCase()) ||
            (probedSnapshot.auth.workspaceId !== undefined &&
              probedSnapshot.auth.workspaceId !== previous.workspaceId);
          const usageLimits = switchedAccount
            ? probedSnapshot.usageLimits
            : complete && probedSnapshot.usageLimits === undefined
              ? state.snapshot.usageLimits
              : resolveUsageLimitsAfterProbe({
                  published: state.snapshot.usageLimits,
                  probed: probedSnapshot.usageLimits,
                });
          const workspaceId =
            usageLimits === probedSnapshot.usageLimits ? undefined : state.snapshot.auth.workspaceId;
          const snapshot = withUsageLimits(
            workspaceId && !probedSnapshot.auth.workspaceId
              ? { ...probedSnapshot, auth: { ...probedSnapshot.auth, workspaceId } }
              : probedSnapshot,
            usageLimits,
          );
          return [
            { snapshot, generation },
            { snapshot, enrichmentGeneration: generation, modelReads },
          ] as const;
        },
      );
      yield* Ref.set(settingsRef, nextSettings);
      yield* PubSub.publish(changesPubSub, nextSnapshot);
      yield* Queue.offer(scheduleChanges, undefined);
      if (!modelReads) yield* Scope.close(checkScope, Exit.void);
      yield* restartSnapshotEnrichment(
        nextSettings,
        nextSnapshot,
        nextGeneration,
        complete && modelReads
          ? {
              read: complete.pipe(Effect.onExit((exit) => Scope.close(checkScope, exit))),
              done: modelReads,
            }
          : undefined,
      );
      return nextSnapshot;
    }).pipe(
      Effect.onExit((exit) =>
        Exit.isFailure(exit)
          ? Scope.close(checkScope, exit).pipe(
              Effect.ensuring(Deferred.succeed(modelReadsDone, undefined)),
            )
          : Effect.void,
      ),
    );
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean; readonly deferFailure?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  /**
   * Runtime usage updates arrive between probes. They patch only
   * `usageLimits` on whatever snapshot is published and leave the enrichment
   * generation alone, so an in-flight enrichment still lands.
   */
  const applyUsageLimits: ManagedServerProvider["applyUsageLimits"] = (update) =>
    Effect.gen(function* () {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
        const usageLimits = applyUsageLimitsUpdate({
          previous: state.snapshot.usageLimits,
          update,
          checkedAt: update.checkedAt,
        });
        // `applyUsageLimitsUpdate` hands back the same object when nothing
        // moved, which is the common case for Codex's per-tick notification.
        if (usageLimits === state.snapshot.usageLimits) {
          return [null, state] as const;
        }
        const snapshot = withUsageLimits(state.snapshot, usageLimits);
        return [snapshot, { ...state, snapshot }] as const;
      });
      if (snapshotToPublish !== null) {
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
      }
    });

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  const hasProviderStatusDemand = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      host.shouldRunBackgroundWork({ type: "provider-status" }),
      host.shouldRunBackgroundWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : host.settings.get.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* host.settings.subscribe;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(scheduleChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  // A check that ended without an answer (an unreachable service, a timeout) says nothing about
  // the provider's configuration, so it is retried on a short backoff until a check settles, even
  // without background demand. Settled providers follow the health interval and its demand rule;
  // a zero interval disables both.
  const recoveryAttemptsRef = yield* Ref.make(0);
  yield* Effect.forever(
    Effect.gen(function* () {
      const refreshInterval = yield* getRefreshInterval;
      const intervalMs = Duration.toMillis(Duration.fromInputUnsafe(refreshInterval));
      const { snapshot } = yield* Ref.get(snapshotStateRef);
      const recovering = intervalMs > 0 && isUnsettledProviderFailure(snapshot);
      const attempts = recovering
        ? yield* Ref.get(recoveryAttemptsRef)
        : yield* Ref.set(recoveryAttemptsRef, 0).pipe(Effect.as(0));
      const rechecking = yield* Ref.get(recheckPendingRef);
      const delayMs =
        intervalMs <= 0
          ? 60_000
          : recovering
            ? Math.min(UNSETTLED_CHECK_RETRY_INITIAL_MS * 2 ** attempts, intervalMs)
            : rechecking ? Math.min(30_000, intervalMs) : intervalMs;
      // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - races the interval against a settings-change signal, not a timeout
      const intervalElapsed = yield* Effect.raceFirst(
        Effect.sleep(Duration.millis(delayMs)).pipe(Effect.as(true)),
        Queue.take(scheduleChanges).pipe(Effect.as(false)),
      );
      if (!intervalElapsed) return;
      if (recovering) {
        yield* Ref.update(recoveryAttemptsRef, (count) => count + 1);
        yield* refreshSnapshot();
        return;
      }
      if (input.refreshOnInterval !== false && intervalMs > 0 && (rechecking || (yield* hasProviderStatusDemand))) {
        yield* applySnapshot(yield* input.getSettings, { forceRefresh: true, deferFailure: input.deferFailedPeriodicChecks === true && !rechecking });
      }
    }).pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.forkScoped);

  const initialCheck = yield* Deferred.make<void>();
  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.ensuring(Deferred.succeed(initialCheck, undefined)),
    Effect.forkScoped,
  );

  const awaitChecked = Effect.gen(function* () {
    yield* Deferred.await(initialCheck);
    while (true) {
      const { snapshot, modelReads } = yield* Ref.get(snapshotStateRef);
      if (snapshot.models.length > 0 || !modelReads) return;
      yield* Deferred.await(modelReads);
      // A refresh may have replaced this check while we were waiting.
      if ((yield* Ref.get(snapshotStateRef)).modelReads === modelReads) return;
    }
  });

  return {
    resolveMaintenance: input.resolveMaintenance,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    awaitChecked,
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    applyUsageLimits,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ManagedServerProvider;
});
