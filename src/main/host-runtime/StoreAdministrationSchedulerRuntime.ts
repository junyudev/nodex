import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
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

      const runBackup = (settings: BackupSchedulerSettings): Effect.Effect<void> =>
        backupLock
          .withPermitsIfAvailable(1)(
            Effect.gen(function* () {
              if (!(yield* authorityReady)) return;
              yield* administration.createBackup({ trigger: "auto" });
              if (!(yield* authorityReady)) return;
              yield* administration.pruneBackups(
                Math.max(0, Math.trunc(settings.retentionCount)),
                Math.max(0, Math.trunc(settings.retentionGiB)) * 1024 * 1024 * 1024,
              );
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  logger.error("Automatic backup run failed", {
                    error: operationCause(error),
                    intervalHours: settings.intervalHours,
                    retentionCount: settings.retentionCount,
                    retentionGiB: settings.retentionGiB,
                  });
                }),
              ),
            ),
          )
          .pipe(Effect.asVoid);

      const backupSchedule = (settings: BackupSchedulerSettings): Effect.Effect<void> =>
        Deferred.await(activation).pipe(
          Effect.andThen(
            settings.autoEnabled
              ? Effect.forever(
                  Effect.sleep(`${Math.max(1, Math.trunc(settings.intervalHours))} hours`).pipe(
                    Effect.andThen(runBackup(settings)),
                  ),
                )
              : Effect.void,
          ),
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

      for (const lane of ["revision", "operational", "document", "block"] as const) {
        const schedule = options.timing?.maintenance?.[lane] ?? STORE_MAINTENANCE_SCHEDULES[lane];
        yield* Deferred.await(activation).pipe(
          Effect.andThen(Effect.sleep(Math.max(0, schedule.initial))),
          Effect.andThen(
            Effect.forever(
              runMaintenance(lane, schedule).pipe(
                Effect.flatMap((delay) => Effect.sleep(Math.max(0, delay))),
              ),
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
