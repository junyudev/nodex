import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { performance } from "node:perf_hooks";
import {
  APP_INITIALIZATION_STEP_CHANNEL,
  type AppInitializationStep,
} from "../../shared/app-startup";
import type { CoreAuthorityProcessExit, CoreStartupEvent } from "../core-client/core-launcher";
import { safeBroadcastToWindows } from "../ipc-safe-send";
import { getLogger } from "../logging/logger";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";
import { MainShutdown } from "../app/MainShutdown";

export class ApplicationInitializationRuntime extends Context.Service<
  ApplicationInitializationRuntime,
  {
    readonly awaitDone: Effect.Effect<void>;
    readonly current: Effect.Effect<AppInitializationStep>;
    readonly markDone: Effect.Effect<void>;
    readonly markFailed: Effect.Effect<void>;
    readonly observeAuthorityExit: (event: CoreAuthorityProcessExit) => Effect.Effect<void>;
    readonly observeCoreStartup: (event: CoreStartupEvent) => Effect.Effect<void>;
    readonly reportRenderer: (
      webContentsId: number,
      report: { readonly durationMs: number; readonly outcome: "ready" | "failed" },
    ) => Effect.Effect<boolean>;
    readonly rendererLoaded: Stream.Stream<number>;
    readonly state: SubscriptionRef.SubscriptionRef<AppInitializationStep>;
  }
>()("nodex/main/host-runtime/ApplicationInitializationRuntime") {}

export const live = (
  windows: WindowRuntimeService,
): Layer.Layer<ApplicationInitializationRuntime, never, MainShutdown> =>
  Layer.effect(
    ApplicationInitializationRuntime,
    Effect.gen(function* () {
      const shutdown = yield* MainShutdown;
      const state = yield* SubscriptionRef.make<AppInitializationStep>({ phase: "opening" });
      const done = yield* Deferred.make<void>();
      const rendererLoaded = yield* PubSub.sliding<number>(MAIN_OBSERVATION_EVENT_CAPACITY);
      yield* Effect.addFinalizer(() => PubSub.shutdown(rendererLoaded));
      const logger = getLogger({ component: "application-initialization-runtime" });
      let changedAt = performance.now();
      const setStep = (step: AppInitializationStep): Effect.Effect<void> =>
        SubscriptionRef.modify(state, (current) => {
          if (current.phase === "done") return [false, current];
          if (current.phase === "migrating" && step.phase === "opening") return [false, current];
          if (
            current.phase === step.phase &&
            (step.phase !== "migrating" ||
              (current.phase === "migrating" &&
                current.fromVersion === step.fromVersion &&
                current.toVersion === step.toVersion &&
                current.completed === step.completed &&
                current.total === step.total))
          ) {
            return [false, current];
          }
          return [true, step];
        }).pipe(
          Effect.tap((changed) =>
            changed
              ? Effect.sync(() => {
                  const now = performance.now();
                  logger.info("App initialization phase changed", {
                    phase: step.phase,
                    previousPhaseDurationMs: Math.round(now - changedAt),
                  });
                  changedAt = now;
                  safeBroadcastToWindows(windows.all(), APP_INITIALIZATION_STEP_CHANNEL, [step]);
                })
              : Effect.void,
          ),
          Effect.asVoid,
        );

      return ApplicationInitializationRuntime.of({
        awaitDone: Deferred.await(done),
        current: SubscriptionRef.get(state),
        markDone: setStep({ phase: "done" }).pipe(
          Effect.andThen(Deferred.succeed(done, undefined)),
          Effect.asVoid,
        ),
        markFailed: setStep({ phase: "failed" }),
        observeAuthorityExit: (event) =>
          shutdown.isRequested.pipe(
            Effect.tap((shutdownRequested) =>
              Effect.sync(() => {
                const details = {
                  code: event.code,
                  processId: event.processId,
                  signal: event.signal,
                  stderr: event.stderr || undefined,
                };
                if (shutdownRequested) {
                  logger.info("Native Core authority process stopped", details);
                  return;
                }
                logger.error("Native Core authority process exited", details);
              }),
            ),
            Effect.asVoid,
          ),
        observeCoreStartup: (event) => {
          if (event.kind === "migration_started") {
            return Effect.sync(() => {
              logger.info("Native Core Store migration started", {
                fromVersion: event.fromVersion,
                toVersion: event.toVersion,
              });
            }).pipe(
              Effect.andThen(
                setStep({
                  phase: "migrating",
                  fromVersion: event.fromVersion,
                  toVersion: event.toVersion,
                }),
              ),
            );
          }
          if (event.kind === "candidate_checked") {
            return Effect.sync(() =>
              logger.info("Native Core candidate checked", {
                artifactHashMs: event.artifactHashMs,
              }),
            );
          }
          if (event.kind === "migration_progress") {
            return SubscriptionRef.get(state).pipe(
              Effect.flatMap((current) =>
                current.phase === "migrating"
                  ? setStep({ ...current, completed: event.completed, total: event.total })
                  : Effect.void,
              ),
            );
          }
          if (event.kind === "migration_heartbeat") return Effect.void;
          return Effect.sync(() => {
            logger.info("Native Core Store ready", {
              createdFresh: event.createdFresh,
              migratedFromVersion: event.migratedFromVersion,
              storeOpenMs: event.storeOpenMs,
            });
          }).pipe(Effect.andThen(setStep({ phase: "opening_workspace" })));
        },
        reportRenderer: (webContentsId, report) => {
          if (!windows.markRendererInitialized(webContentsId)) return Effect.succeed(false);
          return Effect.sync(() => {
            logger.info("Renderer initialization finished", {
              durationMs: Math.round(report.durationMs),
              outcome: report.outcome,
              webContentsId,
            });
          }).pipe(Effect.andThen(PubSub.publish(rendererLoaded, webContentsId)), Effect.as(true));
        },
        rendererLoaded: Stream.fromPubSub(rendererLoaded),
        state,
      });
    }),
  );
