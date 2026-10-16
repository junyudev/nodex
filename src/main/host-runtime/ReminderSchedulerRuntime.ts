import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AutomationApplication,
  type AutomationReminderClaim,
} from "../automation-application/AutomationApplication";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { getLogger } from "../logging/logger";
import type { ReminderNotificationPayload } from "../reminder-notification";
import { ElectronDesktop } from "../platform/electron/ElectronDesktop";
import {
  REMINDER_LEASE_DURATION_MS,
  REMINDER_RETRY_DELAY_MS,
  REMINDER_SCHEDULER_INTERVAL_MS,
  REMINDER_SCHEDULER_MAX_PER_TICK,
  reminderNotification,
} from "./ReminderSchedulerPolicy";
import { SchedulerOperationError } from "./SchedulerOperation";

export interface ReminderSchedulerRuntimeOptions {
  readonly intervalMs?: number;
  readonly maxPerTick?: number;
  readonly leaseDurationMs?: number;
  readonly retryDelayMs?: number;
}

export interface ReminderSchedulerActivation {
  readonly openReminder: (payload: ReminderNotificationPayload) => void;
}

export class ReminderSchedulerRuntime extends Context.Service<
  ReminderSchedulerRuntime,
  {
    readonly activate: (options: ReminderSchedulerActivation) => Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/ReminderSchedulerRuntime") {}

const positiveInteger = (value: number, fallback: number): number =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback;

export const live = (
  options: ReminderSchedulerRuntimeOptions,
): Layer.Layer<
  ReminderSchedulerRuntime,
  never,
  AutomationApplication | CoreAuthority | ElectronDesktop
> =>
  Layer.effect(
    ReminderSchedulerRuntime,
    Effect.gen(function* () {
      const automation = yield* AutomationApplication;
      const authority = yield* CoreAuthority;
      const desktop = yield* ElectronDesktop;
      const activation = yield* Deferred.make<ReminderSchedulerActivation>();
      const lock = yield* Semaphore.make(1);
      const logger = getLogger({ component: "reminder-scheduler-runtime" });
      const intervalMs = positiveInteger(
        options.intervalMs ?? REMINDER_SCHEDULER_INTERVAL_MS,
        REMINDER_SCHEDULER_INTERVAL_MS,
      );
      const maxPerTick = positiveInteger(
        options.maxPerTick ?? REMINDER_SCHEDULER_MAX_PER_TICK,
        REMINDER_SCHEDULER_MAX_PER_TICK,
      );
      const leaseDurationMs = positiveInteger(
        options.leaseDurationMs ?? REMINDER_LEASE_DURATION_MS,
        REMINDER_LEASE_DURATION_MS,
      );
      const retryDelayMs = Math.max(0, Math.trunc(options.retryDelayMs ?? REMINDER_RETRY_DELAY_MS));
      const authorityReady = SubscriptionRef.get(authority.state).pipe(
        Effect.map((state) => state.kind === "ready"),
      );
      const whenActivated = (effect: Effect.Effect<void>): Effect.Effect<void> =>
        Deferred.isDone(activation).pipe(Effect.flatMap((ready) => (ready ? effect : Effect.void)));
      const operationCause = (error: { readonly cause: unknown }): unknown => error.cause;

      const failLease = (
        leaseId: string,
        reasonCode: "core_authority_unavailable" | "scheduler_stopped" | "notification_failed",
      ): Effect.Effect<void> =>
        automation.reminders.failLease(leaseId, retryDelayMs, reasonCode).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn("Reminder lease settlement failed", {
                leaseId,
                reasonCode,
                error: operationCause(error),
              });
            }),
          ),
        );

      const deliver = (
        currentActivation: ReminderSchedulerActivation,
        claim: AutomationReminderClaim,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!(yield* authorityReady)) {
            return yield* failLease(claim.leaseId, "core_authority_unavailable");
          }
          const delivery = Effect.gen(function* () {
            const payload = yield* Effect.try({
              try: () => reminderNotification(claim),
              catch: (cause) =>
                new SchedulerOperationError({
                  operation: "project-reminder-notification",
                  cause,
                }),
            });
            const presented = yield* desktop.showNotification({
              title: payload.title,
              body: payload.body,
              actions: ["Snooze 10m", "Snooze 1h"],
              onClick: Effect.sync(() => currentActivation.openReminder(payload)),
              onAction: (index) =>
                automation.reminders
                  .snooze({
                    projectId: payload.projectId,
                    pageId: payload.pageId,
                    occurrenceStart: payload.occurrenceStart,
                    snoozeMinutes: index === 0 ? 10 : 60,
                  })
                  .pipe(
                    Effect.catch((error) =>
                      Effect.sync(() => {
                        logger.warn("Failed to snooze reminder", {
                          projectId: payload.projectId,
                          pageId: payload.pageId,
                          error: operationCause(error),
                        });
                      }),
                    ),
                  ),
            });
            if (!presented) return yield* failLease(claim.leaseId, "notification_failed");
            yield* automation.reminders.completeLease(claim.leaseId);
          });
          const result = yield* Effect.exit(delivery);
          if (Exit.isSuccess(result)) return;
          yield* failLease(claim.leaseId, "notification_failed");
          yield* Effect.sync(() => {
            logger.warn("Reminder delivery failed", {
              leaseId: claim.leaseId,
              projectId: claim.projectId,
              pageId: claim.pageId,
              error: result.cause,
            });
          });
        }).pipe(Effect.onInterrupt(() => failLease(claim.leaseId, "scheduler_stopped")));

      const tick = (currentActivation: ReminderSchedulerActivation): Effect.Effect<void> =>
        lock
          .withPermitsIfAvailable(1)(
            Effect.gen(function* () {
              if (!(yield* authorityReady)) return;
              const due = yield* automation.reminders.planDue;
              if (!due.dueNow || due.workToken === null) return;
              const claims = yield* automation.reminders.claimDue(
                due.workToken,
                maxPerTick,
                leaseDurationMs,
              );
              if (!(yield* authorityReady)) {
                yield* Effect.forEach(
                  claims,
                  (claim) => failLease(claim.leaseId, "core_authority_unavailable"),
                  { concurrency: "unbounded", discard: true },
                );
                return;
              }
              yield* Effect.forEach(claims, (claim) => deliver(currentActivation, claim), {
                concurrency: "unbounded",
                discard: true,
              });
            }).pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  logger.debug("Reminder scheduler tick failed", {
                    error: operationCause(error),
                  });
                }),
              ),
            ),
          )
          .pipe(Effect.asVoid);

      yield* Deferred.await(activation).pipe(
        Effect.flatMap((currentActivation) =>
          Effect.forever(tick(currentActivation).pipe(Effect.andThen(Effect.sleep(intervalMs)))),
        ),
        Effect.forkScoped,
      );
      yield* desktop.onPowerEvent(
        "resume",
        whenActivated(Deferred.await(activation).pipe(Effect.flatMap(tick))),
      );
      const initialAuthority = yield* SubscriptionRef.get(authority.state);
      let authorityWasReady = initialAuthority.kind === "ready";
      yield* SubscriptionRef.changes(authority.state).pipe(
        Stream.runForEach((state) => {
          const recovered = !authorityWasReady && state.kind === "ready";
          authorityWasReady = state.kind === "ready";
          if (!recovered) return Effect.void;
          return whenActivated(Deferred.await(activation).pipe(Effect.flatMap(tick)));
        }),
        Effect.forkScoped,
      );

      return ReminderSchedulerRuntime.of({
        activate: (next) => Deferred.succeed(activation, next).pipe(Effect.asVoid),
      });
    }),
  );
