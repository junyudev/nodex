/* @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- Verifies the Node filesystem and raw incident wire format. */
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { assert, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import type { DiagnosticsSettings } from "../../shared/types";
import { initializeMainSentry, resetMainSentryForTests } from "../observability/sentry-main";
import {
  MainFatalIncidentStore,
  MainFatalIncidentStoreError,
  layerForHome,
} from "../platform/node/MainFatalIncidentStore";
import { MainObservability, layer } from "./MainObservability";
import { MainApplicationError } from "./MainExit";
import { layer as cleanupLayer } from "./MainCleanup";
import { testLayer as configLayer } from "./MainConfig";

afterEach(() => {
  resetMainSentryForTests();
  vi.unstubAllEnvs();
});
const settings = (enabled: boolean): DiagnosticsSettings => ({
  enabled,
  dsn: "https://example.invalid/1",
  environment: "test",
  release: "nodex@test",
  tracesSampleRate: 0,
  replayEnabled: false,
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  envOverrides: {
    enabled: false,
    dsn: false,
    environment: false,
    release: false,
    tracesSampleRate: false,
    replayEnabled: false,
    replaysSessionSampleRate: false,
    replaysOnErrorSampleRate: false,
  },
});

it.live(
  "records fatal typed failures and defects with logs disabled, while respecting telemetry consent",
  () =>
    Effect.gen(function* () {
      vi.stubEnv("NODEX_LOG_FILE", "0");
      vi.stubEnv("NODEX_LOG_CONSOLE", "0");
      vi.stubEnv("NODEX_SENTRY_FORCE_TEST", "1");
      for (const { enabled, defect, storageFailure } of [
        { enabled: false, defect: false, storageFailure: false },
        { enabled: true, defect: false, storageFailure: false },
        { enabled: true, defect: true, storageFailure: true },
      ]) {
        const home = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(path.join(tmpdir(), "nodex-fatal-report-"))),
          (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
        );
        const captured: { error: unknown; hint: unknown }[] = [];
        const breadcrumbs: Record<string, unknown>[] = [];
        yield* Effect.promise(() =>
          initializeMainSentry({
            appVersion: "0.4.0",
            arch: "arm64",
            isPackaged: false,
            platform: "darwin",
            settings: settings(enabled),
            adapter: {
              init: () => undefined,
              setTag: () => undefined,
              addBreadcrumb: (breadcrumb) => {
                breadcrumbs.push(breadcrumb);
              },
              captureException: (error, hint) => {
                captured.push({ error, hint });
                return "capture";
              },
              captureMessage: () => undefined,
              close: () => Promise.resolve(true),
            },
          }),
        );
        const store = storageFailure
          ? Layer.succeed(
              MainFatalIncidentStore,
              MainFatalIncidentStore.of({
                write: () =>
                  Effect.fail(
                    new MainFatalIncidentStoreError({
                      cause: new Error("private storage details"),
                    }),
                  ),
              }),
            )
          : layerForHome(home);
        const scope = yield* Scope.make();
        const context = yield* Layer.buildWithScope(
          layer.pipe(
            Layer.provide(Layer.mergeAll(configLayer({ nodexHome: home }), cleanupLayer, store)),
          ),
          scope,
        );
        const observability = Context.get(context, MainObservability);
        const failure = new MainApplicationError({
          phase: "runtime",
          operation: "core",
          cause: new Error("private prompt or credential"),
        });
        const presentation = yield* observability.reportExit({
          _tag: "Failure",
          phase: "runtime",
          cause: defect ? Cause.die(failure) : Cause.fail(failure),
        });
        assert.isNotNull(presentation);
        assert.include(presentation!.detail, observability.runId);
        assert.notInclude(presentation!.detail, "private prompt");
        assert.strictEqual(captured.length, enabled ? 1 : 0);
        assert.notInclude(JSON.stringify(captured), "private prompt");
        assert.notInclude(JSON.stringify(breadcrumbs), "private prompt");
        if (enabled) {
          assert.isTrue(breadcrumbs.some((entry) => entry.message === "Main application failed"));
        }
        if (storageFailure) {
          assert.include(presentation!.detail, "could not be saved");
        } else {
          const directory = path.join(home, "diagnostics/fatal");
          const files = yield* Effect.promise(() => readdir(directory));
          assert.strictEqual(files.length, 1);
          const record = JSON.parse(
            yield* Effect.promise(() => readFile(path.join(directory, files[0]!), "utf8")),
          );
          assert.strictEqual(record.id, presentation!.incidentId);
          assert.strictEqual(record.causes[0].kind, defect ? "defect" : "failure");
          assert.strictEqual(record.causes[0].operation, "core");
        }
        yield* Scope.close(scope, Exit.void);
      }
    }),
);

it.live("normal shutdown does not create a fatal incident", () =>
  Effect.gen(function* () {
    const reports: unknown[] = [];
    const context = yield* Layer.build(
      layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            configLayer(),
            cleanupLayer,
            Layer.succeed(
              MainFatalIncidentStore,
              MainFatalIncidentStore.of({
                write: (value) =>
                  Effect.sync(() => {
                    reports.push(value);
                    return "/incident.json";
                  }),
              }),
            ),
          ),
        ),
      ),
    );
    const result = yield* Context.get(context, MainObservability).reportExit({
      _tag: "Shutdown",
      reason: { _tag: "UserQuit" },
      cleanup: { failures: [] },
    });
    assert.isNull(result);
    assert.deepEqual(reports, []);
  }),
);
