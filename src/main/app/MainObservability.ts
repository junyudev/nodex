import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { randomUUID } from "node:crypto";
import { getLogger, shutdownBackendLogger, type BackendLogger } from "../logging/logger";
import { captureMainException, shutdownMainSentry } from "../observability/sentry-main";
import { MainFatalIncidentStore } from "../platform/node/MainFatalIncidentStore";
import { MainCleanup } from "./MainCleanup";
import { MainConfig } from "./MainConfig";
import {
  fatalIncidentPresentation,
  makeMainFatalIncident,
  type MainFailurePresentation,
} from "./MainFatalIncident";
import type { MainExit } from "./MainExit";

export class MainObservability extends Context.Service<
  MainObservability,
  {
    readonly backend: BackendLogger;
    readonly captureDefect: (cause: unknown, operation: string) => Effect.Effect<void>;
    readonly reportExit: (exit: MainExit) => Effect.Effect<MainFailurePresentation | null>;
    readonly runId: string;
  }
>()("nodex/main/app/MainObservability") {}

const toMessage = (message: unknown): string => {
  if (Array.isArray(message)) return message.map(String).join(" ");
  return String(message);
};

const backendEffectLogger = (backend: BackendLogger) =>
  Logger.make<unknown, void>((options) => {
    const formatted = Logger.formatStructured.log(options);
    const fields = {
      annotations: formatted.annotations,
      cause: formatted.cause,
      fiberId: formatted.fiberId,
      spans: formatted.spans,
    };
    const message = toMessage(formatted.message);
    const level = String(options.logLevel).toLowerCase();
    if (level.includes("trace")) return backend.trace(message, fields);
    if (level.includes("debug")) return backend.debug(message, fields);
    if (level.includes("warn")) return backend.warn(message, fields);
    if (level.includes("error") || level.includes("fatal")) return backend.error(message, fields);
    return backend.info(message, fields);
  });

export const layer: Layer.Layer<
  MainObservability,
  never,
  MainConfig | MainCleanup | MainFatalIncidentStore
> = Layer.unwrap(
  Effect.sync(() => {
    const runId = randomUUID();
    const backend = getLogger({ subsystem: "main-kernel", runId });
    const service = Layer.effect(
      MainObservability,
      Effect.gen(function* () {
        const config = yield* MainConfig;
        const cleanup = yield* MainCleanup;
        const incidents = yield* MainFatalIncidentStore;
        yield* Effect.addFinalizer(() =>
          Effect.tryPromise(() =>
            Promise.all([shutdownBackendLogger(), shutdownMainSentry()]),
          ).pipe(Effect.asVoid, Effect.orDie),
        );
        return MainObservability.of({
          backend,
          runId,
          captureDefect: Effect.fn("MainObservability.captureDefect")(
            (cause: unknown, operation: string) =>
              Effect.sync(() => {
                backend.error("Unexpected Main runtime defect", { cause, operation });
                captureMainException(cause, { tags: { operation, runtime: "main-kernel" } });
              }),
          ),
          reportExit: Effect.fn("MainObservability.reportExit")(function* (exit: MainExit) {
            if (exit._tag === "Shutdown") {
              backend.info("Main application stopped", {
                cleanupFailures: exit.cleanup.failures.length,
                reason: exit.reason._tag,
              });
              return null;
            }
            const incident = makeMainFatalIncident(exit, yield* cleanup.snapshot, {
              id: runId,
              occurredAt: DateTime.formatIso(yield* DateTime.now),
              appVersion: config.appVersion,
            });
            // Backend logs also feed Sentry breadcrumbs, including with file logging off.
            backend.error("Main application failed", { incident });
            const storedPath = yield* incidents.write(incident).pipe(
              Effect.timeout("2 seconds"),
              Effect.catch(() =>
                Effect.sync(() => {
                  backend.warn("Could not save fatal incident", { incidentId: incident.id });
                  return null;
                }),
              ),
            );
            // Capture typed fatal exits as well as defects. Submit the same content-free
            // evidence kept locally rather than arbitrary nested exception payloads.
            captureMainException(new Error(incident.summary), {
              tags: { phase: exit.phase, runtime: "main-kernel" },
              extra: { incident },
            });
            return fatalIncidentPresentation(incident, storedPath);
          }),
        });
      }),
    );
    return Layer.merge(service, Logger.layer([backendEffectLogger(backend)]));
  }),
);
