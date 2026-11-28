import type { AppStartupFailureEvidence } from "../../shared/app-startup";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { toJson } from "effect/Inspectable";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { CurrentLogAnnotations, CurrentLogSpans } from "effect/References";
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
    readonly startupFailureEvidence: Effect.Effect<AppStartupFailureEvidence | null>;
  }
>()("nodex/main/app/MainObservability") {}

const toMessage = (message: unknown): string => {
  const inspected = toJson(message);
  if (!Array.isArray(inspected)) return String(inspected);
  const parts = inspected.length === 1 && Array.isArray(inspected[0]) ? inspected[0] : inspected;
  return parts.map(String).join(" ");
};

const backendEffectLogger = (backend: BackendLogger) =>
  Logger.make<unknown, void>(({ cause, date, fiber, logLevel, message }) => {
    const now = date.getTime();
    const fields = {
      // Keep Effect's values structured until the backend applies its log limits and redaction.
      annotations: fiber.getRef(CurrentLogAnnotations),
      cause: cause.reasons.length > 0 ? cause : undefined,
      fiberId: `#${fiber.id}`,
      spans: Object.fromEntries(
        fiber.getRef(CurrentLogSpans).map(([label, start]) => [label, now - start]),
      ),
    };
    const text = toMessage(message);
    if (logLevel === "Trace") return backend.trace(text, fields);
    if (logLevel === "Debug") return backend.debug(text, fields);
    if (logLevel === "Warn") return backend.warn(text, fields);
    if (logLevel === "Error" || logLevel === "Fatal") return backend.error(text, fields);
    return backend.info(text, fields);
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
        let startupFailureEvidence: AppStartupFailureEvidence | null = null;
        return MainObservability.of({
          startupFailureEvidence: Effect.sync(() => startupFailureEvidence),
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
              appBuildVersion: config.appBuildVersion,
            });
            // Backend logs also feed Sentry breadcrumbs, including with file logging off.
            backend.error("Main application failed", { incident });
            const storedPath = yield* incidents.write(incident).pipe(
              Effect.timeout("5 seconds"),
              Effect.catch(() =>
                Effect.sync(() => {
                  backend.warn("Could not save fatal incident", { incidentId: incident.id });
                  return null;
                }),
              ),
            );
            if (exit.phase === "startup")
              startupFailureEvidence = { incidentId: incident.id, recordPath: storedPath };
            if (storedPath)
              backend.error("Failure diagnostic saved", {
                incidentId: incident.id,
                recordPath: storedPath,
              });
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
