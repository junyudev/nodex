import { readFileSync } from "node:fs";
import markdownWasmPath from "../shared/generated/nodex-markdown-wasm/nodex_markdown_bg.wasm?asset";
import { initMarkdownSync } from "../shared/nodex-markdown";
import { app, BrowserWindow, dialog } from "electron";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { configureInstanceScopePaths } from "./instance-scope";
import { resolveBootstrapConfig } from "./bootstrap-config";
import { BootstrapRuntimeEventQueue } from "./bootstrap-events";
import { configureBackendLogger, getLogger, shutdownBackendLogger } from "./logging/logger";
import { getDiagnosticsSettings } from "./settings/application-settings-persistence";
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
import type { MainFailurePresentation } from "./app/MainFatalIncident";
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

initMarkdownSync(readFileSync(markdownWasmPath));

process.env.NODEX_INTERNAL_APP_PACKAGED = app.isPackaged ? "true" : "false";
const inheritedIsolatedRunId = process.env[ISOLATED_RUN_ID_ENV];
delete process.env[ISOLATED_RUN_ID_ENV];

const bootstrapConfig = resolveBootstrapConfig({ isPackaged: app.isPackaged });
const { nodexHome } = bootstrapConfig;
process.env.NODEX_HOME = nodexHome;
const backendLoggerConfiguration = {
  cwd: process.cwd(),
  environment: bootstrapConfig.environment,
  nodexHome,
};
// A rejected second launch must not append to or prune the primary's log files.
configureBackendLogger({
  ...backendLoggerConfiguration,
  environment: { ...bootstrapConfig.environment, NODEX_LOG_FILE: "false" },
});
configureInstanceScopePaths(app, nodexHome);
const runtimeQueue = new BootstrapRuntimeEventQueue();
const bootstrapLogger = getLogger({ scope: "bootstrap" });
let primaryIsolatedRunId: string | null = null;

function logBootstrap(
  level: "info" | "warn" | "error",
  message: string,
  fields: Record<string, unknown> = {},
): void {
  bootstrapLogger[level](message, fields);
}

function initializeBootstrapDiagnostics(): Promise<boolean> {
  try {
    return initializeMainSentry({
      appVersion: app.getVersion(),
      arch: process.arch,
      isPackaged: app.isPackaged,
      platform: process.platform,
      settings: getDiagnosticsSettings({
        environment: bootstrapConfig.environment,
        settingsPath: bootstrapConfig.profileSettingsPath,
      }),
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

async function handleApplicationFailure(
  exit: Extract<MainExit, { readonly _tag: "Failure" }>,
  presentation: MainFailurePresentation,
) {
  const isRuntimeFailure = exit.phase === "runtime";
  const message = isRuntimeFailure
    ? "Nodex encountered an unrecoverable error"
    : "Nodex failed to start";
  logBootstrap("error", message, { incidentId: presentation.incidentId, phase: exit.phase });

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
    detail: presentation.detail,
  });

  app.quit();
}

function launchMainApplication(): void {
  const startupEvents = runtimeQueue.takePendingEvents();
  const foundation = MainFoundationLive.make({
    assistantStreamingDebug: bootstrapConfig.environment.NODEX_ASSISTANT_STREAMING_DEBUG === "1",
    appVersion: app.getVersion(),
    arch: process.arch,
    argv: [...process.argv],
    composerAppshotHelperPath:
      bootstrapConfig.environment.NODEX_COMPOSER_APPSHOT_HELPER?.trim() || null,
    documentsPath: app.getPath("documents"),
    environment: bootstrapConfig.environment,
    environmentPath: bootstrapConfig.environment.PATH ?? null,
    homeDirectory: app.getPath("home"),
    initialProjectsDirectory: bootstrapConfig.environment.NODEX_INITIAL_PROJECTS_DIR ?? null,
    isDefaultApp: process.defaultApp === true,
    isPackaged: app.isPackaged,
    nodexHome,
    platform: process.platform,
    profileSettingsPath: bootstrapConfig.profileSettingsPath,
    projectRootPath: app.getAppPath(),
    rendererUrl: bootstrapConfig.environment.ELECTRON_RENDERER_URL ?? null,
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
          assertRustDataAuthorityEnvironment(bootstrapConfig.environment);
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
    const presentation = yield* observability.reportExit(exit);
    if (exit._tag === "Failure" && presentation) {
      yield* Effect.tryPromise(() => handleApplicationFailure(exit, presentation)).pipe(
        Effect.orDie,
      );
    }
  }).pipe(
    // this is the unique process entry that owns the foundation Layer.
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
    logBootstrap("error", "Uncaught Main process exception", { error });
    captureMainException(error, {
      tags: { runtime: "electron-main", kind: "uncaughtException" },
    });
  });

  process.on("unhandledRejection", (reason) => {
    logBootstrap("error", "Unhandled Main process rejection", { reason });
    captureMainException(reason, {
      tags: { runtime: "electron-main", kind: "unhandledRejection" },
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
    return false;
  }

  const hasSingleInstanceLock = app.requestSingleInstanceLock();
  if (!hasSingleInstanceLock) {
    logBootstrap("info", "Another Nodex instance already owns this profile");
    return false;
  }
  configureBackendLogger(backendLoggerConfiguration);

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
      return false;
    }
  }

  registerPrimaryInstance();
  return true;
}

if (bootstrapApplication()) launchMainApplication();
else void shutdownBackendLogger().finally(() => app.quit());
