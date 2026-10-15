import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AutomationApplication,
  type AutomationDefinitionClaim,
} from "../automation-application/AutomationApplication";
import { AutomationExecution } from "../automation-application/AutomationExecution";
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { getLogger } from "../logging/logger";
import {
  SCHEDULED_AUTOMATION_INTERVAL_MS,
  SCHEDULED_AUTOMATION_LEASE_DURATION_MS,
  SCHEDULED_AUTOMATION_MAX_PER_TICK,
  CodexScheduledAutomationRetryError,
  emptyHeartbeatState,
  heartbeatRunContext,
  updateHeartbeatEnabled,
  updateHeartbeatThreadState,
  type CodexScheduledAutomationHeartbeatThreadStateInput,
  type ScheduledAutomationHeartbeatState,
} from "./ScheduledAutomationPolicy";

export interface ScheduledAutomationRuntimeOptions {
  readonly intervalMs?: number;
  readonly maxPerTick?: number;
}

export class ScheduledAutomationRuntime extends Context.Service<
  ScheduledAutomationRuntime,
  {
    readonly activate: Effect.Effect<void>;
    readonly setHeartbeatAutomationsEnabled: (enabled: boolean) => Effect.Effect<void>;
    readonly setHeartbeatThreadRendererState: (
      input: CodexScheduledAutomationHeartbeatThreadStateInput,
    ) => Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/ScheduledAutomationRuntime") {}

const positiveInteger = (value: number, fallback: number): number =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback;

export const live = (
  options: ScheduledAutomationRuntimeOptions = {},
): Layer.Layer<
  ScheduledAutomationRuntime,
  never,
  AutomationApplication | AutomationExecution | CodexApplicationEventHub | CoreAuthority
> =>
  Layer.effect(
    ScheduledAutomationRuntime,
    Effect.gen(function* () {
      const automation = yield* AutomationApplication;
      const execution = yield* AutomationExecution;
      const authority = yield* CoreAuthority;
      const events = yield* CodexApplicationEventHub;
      const activation = yield* Deferred.make<void>();
      const heartbeatState =
        yield* Ref.make<ScheduledAutomationHeartbeatState>(emptyHeartbeatState());
      const lock = yield* Semaphore.make(1);
      const logger = getLogger({ component: "scheduled-automation-runtime" });
      const intervalMs = positiveInteger(
        options.intervalMs ?? SCHEDULED_AUTOMATION_INTERVAL_MS,
        SCHEDULED_AUTOMATION_INTERVAL_MS,
      );
      const maxPerTick = positiveInteger(
        options.maxPerTick ?? SCHEDULED_AUTOMATION_MAX_PER_TICK,
        SCHEDULED_AUTOMATION_MAX_PER_TICK,
      );
      const authorityReady = SubscriptionRef.get(authority.state).pipe(
        Effect.map((state) => state.kind === "ready"),
      );
      const whenActivated = (effect: Effect.Effect<void>): Effect.Effect<void> =>
        Deferred.isDone(activation).pipe(Effect.flatMap((ready) => (ready ? effect : Effect.void)));
      const operationCause = (error: { readonly cause: unknown }): unknown => error.cause;

      const initialize = yield* Effect.cached(
        automation.runs.settleInterrupted.pipe(
          Effect.tap((settled) =>
            Effect.sync(() => {
              if (settled.archivedPendingCount > 0 || settled.pendingReviewCount > 0) {
                events.publish({
                  kind: "codex",
                  value: {
                    type: "automationRunsUpdated",
                    event: {
                      automationId: null,
                      runId: null,
                      reason: "settle",
                    },
                  },
                });
              }
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn("Failed to settle interrupted scheduled automation runs", {
                error: operationCause(error),
              });
            }),
          ),
        ),
      );

      const failClaim = (
        leaseId: string,
        retryDelayMs: number | null,
        reasonCode: string,
      ): Effect.Effect<void> =>
        automation.definitions.failLease(leaseId, retryDelayMs, reasonCode).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn("Scheduled automation lease settlement failed", {
                leaseId,
                error: operationCause(error),
              });
            }),
          ),
        );

      const runClaim = (
        claim: AutomationDefinitionClaim,
        tickNow: number,
        state: ScheduledAutomationHeartbeatState,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!(yield* authorityReady)) {
            return yield* failClaim(claim.leaseId, intervalMs, "core_authority_unavailable");
          }
          const claimedRun = execution
            .executeClaimed(claim.definition, {
              now: tickNow,
              reason: "scheduled",
              leaseId: claim.leaseId,
              dispatchId: claim.dispatchId,
              definitionRevision: claim.definitionRevision,
              ...(claim.definition.kind === "heartbeat"
                ? {
                    heartbeat: heartbeatRunContext({
                      automation: claim.definition,
                      state,
                      now: tickNow,
                    }),
                  }
                : {}),
            })
            .pipe(Effect.andThen(automation.definitions.completeLease(claim.leaseId)));
          const result = yield* Effect.exit(claimedRun);
          if (Exit.isSuccess(result)) return;
          const cause = Option.getOrNull(Cause.findErrorOption(result.cause))?.cause;
          const retry = cause instanceof CodexScheduledAutomationRetryError ? cause : null;
          yield* failClaim(
            claim.leaseId,
            retry?.retryDelayMs ?? null,
            retry?.reasonCode ?? "execution_failed",
          );
          yield* Effect.sync(() => {
            if (retry?.reasonCode === "heartbeat_disabled") {
              logger.debug("Scheduled heartbeat deferred while disabled", {
                automationId: claim.definition.id,
              });
              return;
            }
            logger.warn("Scheduled automation run failed", {
              automationId: claim.definition.id,
              error: cause ?? result.cause,
            });
          });
        }).pipe(
          Effect.onInterrupt(() => failClaim(claim.leaseId, intervalMs, "scheduler_stopped")),
        );

      const tick: Effect.Effect<void> = lock
        .withPermitsIfAvailable(1)(
          Effect.gen(function* () {
            if (!(yield* authorityReady)) return;
            const tickNow = yield* Clock.currentTimeMillis;
            yield* initialize;
            if (!(yield* authorityReady)) return;
            const due = yield* automation.definitions.planDue;
            if (!due.dueNow || due.workToken === null) return;
            const claims = yield* automation.definitions.claimDue(
              due.workToken,
              maxPerTick,
              SCHEDULED_AUTOMATION_LEASE_DURATION_MS,
            );
            if (!(yield* authorityReady)) {
              yield* Effect.forEach(
                claims,
                (claim) => failClaim(claim.leaseId, intervalMs, "core_authority_unavailable"),
                { concurrency: "unbounded", discard: true },
              );
              return;
            }
            const state = yield* Ref.get(heartbeatState);
            yield* Effect.forEach(claims, (claim) => runClaim(claim, tickNow, state), {
              concurrency: "unbounded",
              discard: true,
            });
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                logger.debug("Scheduled automation scheduler tick failed", {
                  error: operationCause(error),
                });
              }),
            ),
          ),
        )
        .pipe(Effect.asVoid);

      yield* Deferred.await(activation).pipe(
        Effect.andThen(Effect.forever(tick.pipe(Effect.andThen(Effect.sleep(intervalMs))))),
        Effect.forkScoped,
      );
      const initialAuthority = yield* SubscriptionRef.get(authority.state);
      let authorityWasReady = initialAuthority.kind === "ready";
      yield* SubscriptionRef.changes(authority.state).pipe(
        Stream.runForEach((state) => {
          const recovered = !authorityWasReady && state.kind === "ready";
          authorityWasReady = state.kind === "ready";
          return recovered ? whenActivated(tick) : Effect.void;
        }),
        Effect.forkScoped,
      );

      return ScheduledAutomationRuntime.of({
        activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
        setHeartbeatAutomationsEnabled: (enabled) =>
          Ref.update(heartbeatState, (state) => updateHeartbeatEnabled(state, enabled)).pipe(
            Effect.andThen(enabled ? whenActivated(tick) : Effect.void),
          ),
        setHeartbeatThreadRendererState: (input) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Ref.update(heartbeatState, (state) => updateHeartbeatThreadState(state, input, now)),
            ),
          ),
      });
    }),
  );
