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
  type AutomationClaim,
import {
  InboxApplication,
  type InboxApplicationError,
import { CodexApplicationEventHub } from "../codex-application/CodexApplicationEventHub";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { getLogger } from "../logging/logger";
import { readActionableErrorMessage } from "../actionable-error-message";
import {
  CLOCK_AUTOMATION_INTERVAL_MS,
  CLOCK_AUTOMATION_LEASE_DURATION_MS,
  CLOCK_AUTOMATION_MAX_PER_TICK,
  AutomationRetryError,
  emptyHeartbeatState,
  heartbeatRunContext,
  updateHeartbeatEnabled,
  updateHeartbeatThreadState,
  type AutomationHeartbeatThreadStateInput,
  type ClockAutomationHeartbeatState,
} from "./ClockAutomationPolicy";

export interface ClockAutomationRuntimeOptions {
  readonly intervalMs?: number;
  readonly maxPerTick?: number;
}

export class ClockAutomationRuntime extends Context.Service<
  ClockAutomationRuntime,
  {
    readonly activate: Effect.Effect<void>;
    readonly setHeartbeatAutomationsEnabled: (enabled: boolean) => Effect.Effect<void>;
    readonly setHeartbeatThreadRendererState: (
      input: AutomationHeartbeatThreadStateInput,
    ) => Effect.Effect<void>;
  }
>()("nodex/main/host-runtime/ClockAutomationRuntime") {}

const positiveInteger = (value: number, fallback: number): number =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback;

export const live = (
  options: ClockAutomationRuntimeOptions = {},
): Layer.Layer<
  ClockAutomationRuntime,
  never,
  | AutomationApplication
  | AutomationExecution
  | InboxApplication
  | CodexApplicationEventHub
  | CoreAuthority
> =>
  Layer.effect(
    ClockAutomationRuntime,
    Effect.gen(function* () {
      const automation = yield* AutomationApplication;
      const execution = yield* AutomationExecution;
      const inbox = yield* InboxApplication;
      const authority = yield* CoreAuthority;
      const events = yield* CodexApplicationEventHub;
      const activation = yield* Deferred.make<void>();
      const heartbeatState = yield* Ref.make<ClockAutomationHeartbeatState>(emptyHeartbeatState());
      const lock = yield* Semaphore.make(1);
      const logger = getLogger({ component: "clock-automation-runtime" });
      const intervalMs = positiveInteger(
        options.intervalMs ?? CLOCK_AUTOMATION_INTERVAL_MS,
        CLOCK_AUTOMATION_INTERVAL_MS,
      );
      const maxPerTick = positiveInteger(
        options.maxPerTick ?? CLOCK_AUTOMATION_MAX_PER_TICK,
        CLOCK_AUTOMATION_MAX_PER_TICK,
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
              logger.warn("Failed to settle interrupted clock Automation runs", {
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
        automation.automations.failLease(leaseId, retryDelayMs, reasonCode).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              logger.warn("Clock Automation lease settlement failed", {
                leaseId,
                error: operationCause(error),
              });
            }),
          ),
        );

      const runClaim = (
        claim: AutomationClaim,
        tickNow: number,
        state: ClockAutomationHeartbeatState,
      ): Effect.Effect<void> =>
        Effect.gen(function* () {
          if (!(yield* authorityReady)) {
            return yield* failClaim(claim.leaseId, intervalMs, "core_authority_unavailable");
          }
          const claimedRun: Effect.Effect<
            void,
            InboxApplicationError | AutomationApplicationError | AutomationExecutionError
          > =
            claim.purpose === "hold"
              ? inbox.holdAutomationDecision(claim)
              : execution
                  .executeClaimed(claim.definition, {
                    now: tickNow,
                    reason: "scheduled",
                    leaseId: claim.leaseId,
                    dispatchId: claim.dispatchId,
                    admission: claim.admission,
                    automationRevision: claim.automationRevision,
                    deadlineMs: claim.expiresAt,
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
                  .pipe(Effect.andThen(automation.automations.completeLease(claim.leaseId)));
          const result = yield* Effect.exit(claimedRun);
          if (Exit.isSuccess(result)) return;
          const failure = Option.getOrNull(Cause.findErrorOption(result.cause));
          const cause = failure?.cause;
          const retry = cause instanceof AutomationRetryError ? cause : null;
          const failureReason = readActionableErrorMessage(failure, {
            fallback: claim.purpose === "hold" ? "hold_failed" : "execution_failed",
            maximumLength: 2_000,
          });
          let reasonCode =
            retry?.reasonCode ??
            (claim.purpose === "hold" || claim.admission ? failureReason : "execution_failed");
          // Core bounds this field by UTF-8 bytes, including model names in localized failures.
          while (Buffer.byteLength(reasonCode, "utf8") > 128) reasonCode = reasonCode.slice(0, -1);
          yield* failClaim(
            claim.leaseId,
            retry?.retryDelayMs ?? (claim.purpose === "hold" ? intervalMs : null),
            reasonCode,
          );
          yield* Effect.sync(() => {
            if (retry?.reasonCode === "heartbeat_disabled") {
              logger.debug("Clock heartbeat deferred while disabled", {
                automationId: claim.definition.id,
              });
              return;
            }
            logger.warn("Clock Automation run failed", {
              automationId: claim.definition.id,
              purpose: claim.purpose,
              reason: failureReason,
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
            const due = yield* automation.automations.planDue;
            if (!due.dueNow || due.workToken === null) return;
            const claims = yield* automation.automations.claimDue(
              due.workToken,
              maxPerTick,
              CLOCK_AUTOMATION_LEASE_DURATION_MS,
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
                logger.debug("Clock Automation scheduler tick failed", {
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
      yield* events.events.pipe(
        Stream.filter(
          (event) => event.kind === "codex" && event.value.type === "automationChanged",
        ),
        Stream.runForEach(() => whenActivated(tick)),
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

      return ClockAutomationRuntime.of({
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
