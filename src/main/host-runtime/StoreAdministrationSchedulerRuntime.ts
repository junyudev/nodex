import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { CoreModuleResponseError } from "../core-client/core-client";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import {
  StoreAdministration,
  type StoreAdministrationError,
} from "../core-runtime/StoreAdministration";
import { getLogger } from "../logging/logger";
import { ApplicationSettings } from "../settings/ApplicationSettings";
import { SchedulerOperationError } from "./SchedulerOperation";
import {
  STORE_MAINTENANCE_SCHEDULES,
  maintenanceInput,
  type StoreMaintenanceLane,
} from "./StoreAdministrationSchedulerPolicy";

export interface BackupSchedulerSettings {
  readonly autoEnabled: boolean;
  readonly intervalHours: number;
  readonly retentionCount: number;
  readonly retentionGiB: number;
}

export interface StoreAdministrationSchedulerTiming {
  readonly maintenance?: Partial<
    Record<
      StoreMaintenanceLane,
      { readonly initial: number; readonly interval: number; readonly idleInterval?: number }
    >
  >;
}

export interface StoreAdministrationSchedulerRuntimeOptions {
  readonly timing?: StoreAdministrationSchedulerTiming;
}

export class StoreAdministrationSchedulerRuntime extends Context.Service<
  StoreAdministrationSchedulerRuntime,
  {
    readonly activate: Effect.Effect<void>;
    readonly configureBackup: (settings: BackupSchedulerSettings) => Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/StoreAdministrationSchedulerRuntime") {}

const STARTUP_SETTLE_MS = 60_000;
const DUE_RECHECK_MS = 15 * 60_000;

export const live = (
  options: StoreAdministrationSchedulerRuntimeOptions,
): Layer.Layer<
  StoreAdministrationSchedulerRuntime,
  never,
  ApplicationSettings | CoreAuthority | StoreAdministration
> =>
  Layer.effect(
    StoreAdministrationSchedulerRuntime,
    Effect.gen(function* () {
      const administration = yield* StoreAdministration;
      const applicationSettings = yield* ApplicationSettings;
      const authority = yield* CoreAuthority;
      const activation = yield* Deferred.make<void>();
      const backupLock = yield* Semaphore.make(1);
      const maintenanceLock = yield* Semaphore.make(1);
      const backupHandle = yield* FiberHandle.make<void, never>();
      const logger = getLogger({ component: "store-administration-scheduler-runtime" });
      const authorityReady = SubscriptionRef.get(authority.state).pipe(
        Effect.map((state) => state.kind === "ready"),
      );
      const operationCause = (error: SchedulerOperationError | StoreAdministrationError): unknown =>
        error.cause;
      const findCoreModuleResponseError = (
        cause: unknown,
        seen: ReadonlySet<unknown> = new Set(),
      ): CoreModuleResponseError | null => {
        if (cause instanceof CoreModuleResponseError) return cause;
        if (cause === null || typeof cause !== "object" || seen.has(cause)) return null;
        if (!("cause" in cause)) return null;
        return findCoreModuleResponseError(cause.cause, new Set([...seen, cause]));
      };
      const isStaleMaintenancePlan = (
        error: SchedulerOperationError | StoreAdministrationError,
      ): boolean => {
        const cause = findCoreModuleResponseError(operationCause(error));
        return (
          cause !== null &&
          (cause.coreError.code === "conflict" || cause.coreError.code === "revision_conflict") &&
          cause.coreError.retryable
        );
      };

      const waitForCore = SubscriptionRef.changes(authority.state).pipe(
        Stream.filter((state) => state.kind === "ready"),
        Stream.runHead,
        Effect.scoped,
        Effect.asVoid,
      );
      const runBackup = (settings: BackupSchedulerSettings) =>
        backupLock.withPermits(1)(
          Effect.gen(function* () {
            const backup = yield* administration.createBackup({ trigger: "auto" });
            yield* administration.pruneBackups(
              Math.max(0, Math.trunc(settings.retentionCount)),
              Math.max(0, Math.trunc(settings.retentionGiB)) * 1024 * 1024 * 1024,
            );
            return Date.parse(backup.createdAt);
          }),
        );

      const backupSchedule = Effect.fn("StoreAdministrationSchedulerRuntime.backupSchedule")(
        function* (settings: BackupSchedulerSettings) {
          yield* Deferred.await(activation);
          if (!settings.autoEnabled) return;
          const interval = Math.max(1, Math.trunc(settings.intervalHours)) * 60 * 60_000;
          let failures = 0;
          let settle = true;
          let lastCompletedAt = Number.NEGATIVE_INFINITY;
          while (true) {
            yield* waitForCore;
            const attempt = yield* Effect.gen(function* () {
              const backups = yield* administration.listBackups;
              const newest = backups.reduce(
                (latest, backup) => Math.max(latest, Date.parse(backup.createdAt)),
                lastCompletedAt,
              );
              const now = yield* Clock.currentTimeMillis;
              const remaining = newest + interval - now;
              if (remaining > 0) {
                settle = false;
                return { delay: remaining };
              }
              // A restarted Desktop catches up after Core is ready, giving startup a short rest.
              if (settle) {
                settle = false;
                return { delay: STARTUP_SETTLE_MS };
              }
              lastCompletedAt = yield* runBackup(settings);
              return {
                delay: Math.max(250, lastCompletedAt + interval - (yield* Clock.currentTimeMillis)),
              };
            }).pipe(Effect.result);
            if (attempt._tag === "Success") {
              failures = 0;
              // Timers pause while the computer sleeps; re-reading the wall clock keeps the due time.
              yield* Effect.sleep(Math.min(attempt.success.delay, DUE_RECHECK_MS));
              continue;
            }
            const delay = Math.min(interval, 5_000 * 2 ** Math.min(failures, 20));
            failures += 1;
            logger.error("Automatic backup run failed", {
              error: operationCause(attempt.failure),
              retryAfterMs: delay,
              intervalHours: settings.intervalHours,
              retentionCount: settings.retentionCount,
              retentionGiB: settings.retentionGiB,
            });
            yield* Effect.sleep(delay);
          }
        },
      );

      const runMaintenance = (
        lane: StoreMaintenanceLane,
        schedule: { readonly interval: number; readonly idleInterval?: number },
      ): Effect.Effect<number> =>
        maintenanceLock
          // Each lane has one scheduler fiber, so waiting here bounds the queue
          // at one item per lane. FIFO acquisition prevents a high-frequency
          // lane from repeatedly winning an immediate try-lock and starving a
          // sibling maintenance responsibility.
          .withPermits(1)(
          Effect.gen(function* () {
            const idleInterval = Math.max(250, schedule.idleInterval ?? schedule.interval);
            if (!(yield* authorityReady)) return idleInterval;
            const settings = yield* applicationSettings.snapshot().pipe(
              Effect.mapError(
                (cause) =>
                  new SchedulerOperationError({
                    operation: `read-${lane}-maintenance-settings`,
                    cause,
                  }),
              ),
            );
            const input = maintenanceInput(lane, settings.history.retentionCount);
            const plan = yield* administration.planMaintenance(input);
            if (plan.dueTasks.length === 0 || plan.workToken === null) {
              if (plan.nextWakeAt === null) return idleInterval;
              const now = yield* Clock.currentTimeMillis;
              return Math.max(250, Math.min(idleInterval, plan.nextWakeAt - now));
            }
            yield* administration.runMaintenance({
              ...input,
              tasks: plan.dueTasks,
              workToken: plan.workToken,
            });
            return Math.max(250, schedule.interval);
          }).pipe(
            Effect.catch((error) => {
              const activeInterval = Math.max(250, schedule.interval);
              if (isStaleMaintenancePlan(error)) {
                return Effect.sync(() => {
                  logger.debug("Store Administration maintenance plan changed before apply", {
                    lane,
                  });
                }).pipe(Effect.as(activeInterval));
              }
              const failureInterval = Math.max(
                activeInterval,
                Math.min(30_000, schedule.idleInterval ?? schedule.interval),
              );
              return Effect.sync(() => {
                logger.warn("Store Administration maintenance pass deferred", {
                  lane,
                  error: operationCause(error),
                });
              }).pipe(Effect.as(failureInterval));
            }),
          ),
        );

      // Erasure cannot wait for the Block lane's idle clock: a requested erasure wakes it.
      const blockWake = yield* Queue.sliding<void>(1);
      yield* administration.erasureRequests.pipe(
        Stream.runForEach(() => Queue.offer(blockWake, undefined)),
        Effect.forkScoped,
      );
      const pause = (lane: StoreMaintenanceLane, delay: number): Effect.Effect<void> => {
        const sleep = Effect.sleep(Math.max(0, delay));
        return lane === "block"
          ? Effect.raceFirst(sleep, Queue.take(blockWake).pipe(Effect.asVoid))
          : sleep;
      };

      for (const lane of ["revision", "operational", "document", "block"] as const) {
        const schedule = options.timing?.maintenance?.[lane] ?? STORE_MAINTENANCE_SCHEDULES[lane];
        yield* Deferred.await(activation).pipe(
          Effect.andThen(pause(lane, schedule.initial)),
          Effect.andThen(
            Effect.forever(
              runMaintenance(lane, schedule).pipe(Effect.flatMap((delay) => pause(lane, delay))),
            ),
          ),
          Effect.forkScoped,
        );
      }
      const initialSettings = yield* applicationSettings.snapshot().pipe(Effect.orDie);
      yield* FiberHandle.run(backupHandle, backupSchedule(initialSettings.backup), {
        startImmediately: true,
      });

      return StoreAdministrationSchedulerRuntime.of({
        activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
        configureBackup: (settings) =>
          FiberHandle.run(backupHandle, backupSchedule(settings), {
            startImmediately: true,
          }).pipe(Effect.asVoid),
      });
    }),
  );
