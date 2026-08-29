import { app, BrowserWindow, dialog } from "electron";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { configureInstanceScopePaths } from "./instance-scope";
import { resolveBootstrapNodexHome } from "./bootstrap-config";
import { BootstrapRuntimeEventQueue } from "./bootstrap-events";
import { writeBootstrapLog } from "./bootstrap-log";
import { resolveLogSinkLevels } from "./logging/log-level";
import { getDiagnosticsSettings } from "./local-store/config";
import { captureMainException, initializeMainSentry } from "./observability/sentry-main";
import { electronMainSentryAdapter } from "./observability/sentry-electron-main-adapter";
import {
  runMacApplicationsInstallerGate,
  type MacApplicationsInstallerEnvironment,
} from "./macos-applications-installer";
import * as MainApp from "./app/MainApp";
import * as MainApplicationLive from "./app/MainApplicationLive";
import * as MainEntry from "./app/MainEntry";
import * as MainFoundationLive from "./app/MainFoundationLive";
import { MainApplicationError, type MainExit } from "./app/MainExit";
import { MainObservability } from "./app/MainObservability";
import { ScopedCallbackRuntime } from "./app/ScopedCallbackRuntime";
import { assertRustDataAuthorityEnvironment } from "./data-authority";
import { registerNodexPrivilegedSchemes } from "./privileged-schemes";
import {
  ISOLATED_RUN_ID_ENV,
  markIsolatedRunClaimReady,
  publishIsolatedRunClaim,
  resolveIsolatedRunBootstrapAccess,
  type IsolatedRunBootstrapAccess,
} from "./core-client/isolated-run-ownership";

process.env.NODEX_INTERNAL_APP_PACKAGED = app.isPackaged ? "true" : "false";

const nodexHome = resolveBootstrapNodexHome({ isPackaged: app.isPackaged });
process.env.NODEX_HOME = nodexHome;
const inheritedIsolatedRunId = process.env[ISOLATED_RUN_ID_ENV];
delete process.env[ISOLATED_RUN_ID_ENV];
configureInstanceScopePaths(app, nodexHome);
const runtimeQueue = new BootstrapRuntimeEventQueue();
let primaryIsolatedRunId: string | null = null;

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off")
    return false;
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on")
    return true;
  return fallback;
}

function logBootstrap(
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {},
): void {
  const defaultSinkEnabled = !app.isPackaged;
  const sinkLevels = resolveLogSinkLevels(process.env);
  writeBootstrapLog(nodexHome, level, message, fields, {
    consoleEnabled: parseBooleanEnv(process.env.NODEX_LOG_CONSOLE, defaultSinkEnabled),
    fileEnabled: parseBooleanEnv(process.env.NODEX_LOG_FILE, defaultSinkEnabled),
    consoleLevel: sinkLevels.console,
    fileLevel: sinkLevels.file,
  });
}

function initializeBootstrapDiagnostics(): Promise<boolean> {
  try {
    return initializeMainSentry({
      appVersion: app.getVersion(),
      arch: process.arch,
      isPackaged: app.isPackaged,
      platform: process.platform,
      settings: getDiagnosticsSettings(),
      adapter: electronMainSentryAdapter,
    }).catch((error: unknown) => {
      logBootstrap("warn", "Sentry diagnostics failed to initialize", { error });
      return false;
    });
  } catch (error) {
    logBootstrap("warn", "Sentry diagnostics failed to initialize", { error });
    return Promise.resolve(false);
  }
}

const mainSentryInitialization = initializeBootstrapDiagnostics();
// Sentry registers its IPC scheme and proxies later registrations during its
// synchronous init phase. Register Nodex schemes afterward so Chromium receives
// one combined privilege set instead of losing secure-context privileges.
registerNodexPrivilegedSchemes();

function formatStartupError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

function createMacApplicationsInstallerEnvironment(): MacApplicationsInstallerEnvironment {
  let moveConflictCancelled = false;
  return {
    platform: process.platform,
    isPackaged: app.isPackaged,
    launchKind: primaryIsolatedRunId ? "supervised" : "ordinary",
    isInApplicationsFolder: () => {
      if (typeof app.isInApplicationsFolder !== "function") return true;
      return app.isInApplicationsFolder();
    },
    showInstallPrompt: async () => {
      const response = await dialog.showMessageBox({
        type: "question",
        buttons: ["Move to Applications", "Continue Anyway", "Quit"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        message: "Move Nodex to Applications?",
        detail:
          "Nodex is running from outside the Applications folder. Moving it to Applications improves launch, update, and permission behavior on macOS.",
      });

      if (response.response === 0) return "move";
      if (response.response === 1) return "continue";
      return "quit";
    },
    showMoveFailedPrompt: async (error) => {
      if (moveConflictCancelled) {
        moveConflictCancelled = false;
        return "quit";
      }
      const response = await dialog.showMessageBox({
        type: "warning",
        buttons: ["Continue Anyway", "Quit"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
        message: "Nodex could not move itself to Applications.",
        detail:
          error instanceof Error
            ? error.message
            : "You can continue from the current location or quit and move Nodex manually.",
      });

      return response.response === 0 ? "continue" : "quit";
    },
    confirmMoveConflict: (conflictType) => {
      if (conflictType === "existsAndRunning") {
        moveConflictCancelled = true;
        dialog.showMessageBoxSync({
          type: "warning",
          buttons: ["OK"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
          message: "Quit the installed copy of Nodex first.",
          detail: "Nodex cannot replace the copy in Applications while that copy is running.",
        });
        return false;
      }
      const response = dialog.showMessageBoxSync({
        type: "warning",
        buttons: ["Cancel Move", "Replace Existing App"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: "Replace the existing Nodex app in Applications?",
        detail: "A copy of Nodex already exists in the Applications folder.",
      });

      moveConflictCancelled = response !== 1;
      return response === 1;
    },
    moveToApplicationsFolder: (options) => app.moveToApplicationsFolder(options),
    log: logBootstrap,
  };
}

async function handleApplicationFailure(exit: Extract<MainExit, { readonly _tag: "Failure" }>) {
  const error = Cause.squash(exit.cause);
  const isRuntimeFailure = exit.phase === "runtime";
  const message = isRuntimeFailure
    ? "Nodex encountered an unrecoverable error"
    : "Nodex failed to start";
  logBootstrap("error", message, { error, phase: exit.phase });

  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.destroy();
  }

  if (exit.phase === "closing") {
    app.quit();
    return;
  }

  await dialog.showMessageBox({
    type: "error",
    buttons: ["Quit"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message,
    detail: formatStartupError(error),
  });

  app.quit();
}

function launchMainApplication(): void {
  const startupEvents = runtimeQueue.takePendingEvents();
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const foundation = MainFoundationLive.make({
    assistantStreamingDebug: process.env.NODEX_ASSISTANT_STREAMING_DEBUG === "1",
    appVersion: app.getVersion(),
    arch: process.arch,
    argv: [...process.argv],
    composerAppshotHelperPath: process.env.NODEX_COMPOSER_APPSHOT_HELPER?.trim() || null,
    documentsPath: app.getPath("documents"),
    environment,
    environmentPath: process.env.PATH ?? null,
    homeDirectory: app.getPath("home"),
    initialProjectsDirectory: process.env.NODEX_INITIAL_PROJECTS_DIR ?? null,
    isDefaultApp: process.defaultApp === true,
    isPackaged: app.isPackaged,
    nodexHome,
    platform: process.platform,
    profileId: nodexHome,
    projectRootPath: app.getAppPath(),
    rendererUrl: process.env.ELECTRON_RENDERER_URL ?? null,
    resourcesPath: process.resourcesPath,
    runtimeBinaryPath: process.execPath,
  });
  const application = Effect.gen(function* () {
    const callbacks = yield* ScopedCallbackRuntime;
    const observability = yield* MainObservability;
    const exit = yield* MainApp.program({
      initialEvents: startupEvents,
      applicationLayer: MainApplicationLive.productionLive,
      runStartupGate: Effect.tryPromise({
        try: async () => {
          await mainSentryInitialization;
          assertRustDataAuthorityEnvironment(process.env);
          return await runMacApplicationsInstallerGate(createMacApplicationsInstallerEnvironment());
        },
        catch: (cause) =>
          new MainApplicationError({ phase: "pre-ready", operation: "startup-gate", cause }),
      }),
      onApplicationReady: (application) =>
        Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              runtimeQueue.attachController({
                handleOpenUrl: (url) =>
                  callbacks.runPromise(application.handleBootstrapEvent({ type: "open-url", url })),
                handleSecondInstance: (argv) =>
                  callbacks.runPromise(
                    application.handleBootstrapEvent({ type: "second-instance", argv }),
                  ),
              }),
            catch: (cause) =>
              new MainApplicationError({
                phase: "startup",
                operation: "bootstrap-handoff",
                cause,
              }),
          }),
          (release) => Effect.sync(release),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (!primaryIsolatedRunId) return;
              markIsolatedRunClaimReady({ nodexHome, runId: primaryIsolatedRunId });
            }),
          ),
          Effect.asVoid,
        ),
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.succeed({
          _tag: "Failure",
          phase: "startup",
          cause: cause as Cause.Cause<MainApplicationError>,
        } satisfies MainExit),
      ),
    );
    yield* observability.reportExit(exit);
    if (exit._tag === "Failure") {
      yield* Effect.tryPromise(() => handleApplicationFailure(exit)).pipe(Effect.orDie);
    }
  }).pipe(
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- this is the unique process entry that owns the foundation Layer.
    Effect.provide(foundation),
  );
  MainEntry.runMain(application);
}

function registerPrimaryInstance(): void {
  app.on("second-instance", (_event, argv) => {
    void runtimeQueue.enqueueSecondInstance(argv);
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    void runtimeQueue.enqueueOpenUrl(url);
  });

  process.on("uncaughtException", (error) => {
    logBootstrap("error", "Uncaught exception before runtime startup", { error });
    captureMainException(error, {
      tags: { phase: "bootstrap", kind: "uncaughtException" },
    });
  });

  process.on("unhandledRejection", (reason) => {
    logBootstrap("error", "Unhandled rejection before runtime startup", { reason });
    captureMainException(reason, {
      tags: { phase: "bootstrap", kind: "unhandledRejection" },
    });
  });
}

function bootstrapApplication(): boolean {
  let isolatedRunAccess: IsolatedRunBootstrapAccess;
  try {
    isolatedRunAccess = resolveIsolatedRunBootstrapAccess({
      nodexHome,
      inheritedRunId: inheritedIsolatedRunId,
    });
  } catch (error) {
    logBootstrap("error", "Isolated run ownership validation failed", { error });
    app.quit();
    return false;
  }

  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    logBootstrap("info", "Another Nodex instance already owns this profile");
    app.quit();
    return false;
  }

  if (isolatedRunAccess.kind === "supervised") {
    try {
      publishIsolatedRunClaim({
        nodexHome,
        runId: isolatedRunAccess.runId,
        hostPid: process.pid,
      });
      primaryIsolatedRunId = isolatedRunAccess.runId;
    } catch (error) {
      logBootstrap("error", "Isolated run primary-host claim failed", { error });
      app.quit();
      return false;
    }
  }

  registerPrimaryInstance();
  return true;
}

if (bootstrapApplication()) launchMainApplication();
