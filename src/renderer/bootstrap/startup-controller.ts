import type { AppInitializationStep } from "../../shared/app-startup";
import { FAIL_CLOSED_RUNTIME_CAPABILITIES } from "../../shared/runtime-capabilities";
import { getStartupStatus } from "../lib/app-startup";
import { startupOperations } from "./startup-operations";

const OPENING_COPY_DELAY_MS = 1_800;
const PHASE_ORDER: Record<AppInitializationStep["phase"], number> = {
  opening: 0,
  migrating: 1,
  opening_workspace: 2,
  done: 3,
  failed: 4,
};

interface StartupElements {
  readonly accessibilityStatus: HTMLElement;
  readonly failure: HTMLElement;
  readonly restart: HTMLButtonElement;
  readonly shell: HTMLElement;
  readonly visibleStatus: HTMLElement;
}

function requireStartupElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element) return element;
  throw new Error(`Startup shell is missing ${selector}`);
}

function readStartupElements(): StartupElements {
  return {
    accessibilityStatus: requireStartupElement("[data-startup-a11y-status]"),
    failure: requireStartupElement("[data-startup-failure]"),
    restart: requireStartupElement<HTMLButtonElement>("[data-startup-restart]"),
    shell: requireStartupElement(".nodex-startup-shell"),
    visibleStatus: requireStartupElement("[data-startup-visible-status]"),
  };
}

export interface StartupController {
  readonly dispose: () => void;
}

/** Owns the framework-free phase between parser-time paint and full application mount. */
export function startStartupController(): StartupController {
  const api = window.api;
  if (!api?.awaitInitialization) {
    throw new Error("Nodex bootstrap requires the Electron preload bridge");
  }

  const elements = readStartupElements();
  const startedAt = performance.now();
  let currentPhase: AppInitializationStep["phase"] = "opening";
  let latestMigrationCompleted = -1;
  let disposed = false;
  let openingDelayElapsed = false;

  const renderStep = (step: AppInitializationStep): void => {
    if (disposed || PHASE_ORDER[step.phase] < PHASE_ORDER[currentPhase]) return;
    if (
      step.phase === "migrating" &&
      step.completed !== undefined &&
      step.completed < latestMigrationCompleted
    ) {
      return;
    }
    if (step.phase === "migrating" && step.completed !== undefined) {
      latestMigrationCompleted = step.completed;
    }
    currentPhase = step.phase;
    elements.shell.dataset.startupPhase = step.phase;

    if (step.phase === "failed") {
      elements.failure.hidden = false;
      elements.accessibilityStatus.textContent = "Nodex could not finish opening.";
      elements.accessibilityStatus.parentElement?.setAttribute("role", "alert");
      return;
    }

    const status = getStartupStatus(step);
    elements.accessibilityStatus.textContent = status;
    elements.visibleStatus.textContent = status;
    elements.visibleStatus.hidden =
      step.phase === "opening" && !openingDelayElapsed ? true : step.phase === "done";
  };

  const openingTimer = window.setTimeout(() => {
    openingDelayElapsed = true;
    if (currentPhase === "opening") renderStep({ phase: "opening" });
  }, OPENING_COPY_DELAY_MS);

  const onVisibilityChange = (): void => {
    document.documentElement.classList.toggle(
      "nodex-startup-document-hidden",
      document.visibilityState === "hidden",
    );
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  onVisibilityChange();

  const unsubscribeInitialization = api.onInitializationStep?.(renderStep) ?? (() => undefined);
  const unsubscribeCloseFlush = api.on("app:flush-before-close", (...args: unknown[]) => {
    const webContentsId = typeof args[0] === "number" ? args[0] : -1;
    void startupOperations.acknowledgeCloseFlush(api, webContentsId);
  });
  const onRestart = (): void => {
    void api.restartApplication?.();
  };
  elements.restart.addEventListener("click", onRestart);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(openingTimer);
    unsubscribeInitialization();
    unsubscribeCloseFlush();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.documentElement.classList.remove("nodex-startup-document-hidden");
    elements.restart.removeEventListener("click", onRestart);
  };

  void api
    .awaitInitialization()
    .then(async () => {
      if (disposed) return;
      renderStep({ phase: "done" });
      const [windowSession, runtimeCapabilities] = await Promise.all([
        startupOperations.readWindowSession(api),
        startupOperations
          .readRuntimeCapabilities(api)
          .catch(() => FAIL_CLOSED_RUNTIME_CAPABILITIES),
      ]);
      const [application, closeFlush, transport, sentry, telemetry] = await Promise.all([
        import("../application-renderer"),
        import("../lib/app-close-flush"),
        import("../lib/electron-renderer-transport"),
        import("../lib/sentry-renderer"),
        import("../lib/statsig-telemetry"),
      ]);
      if (disposed) return;
      transport.initializeElectronRendererLocalCommitIngress(api);
      await sentry.initializeRendererSentry();
      void telemetry.initializeRendererTelemetry();
      // Install the full close coordinator before retiring the bootstrap ack.
      const releaseCloseFlushHandoff = closeFlush.registerAppCloseFlushHandler(() => undefined);
      await application.mountApplicationRenderer({
        runtimeCapabilities,
        windowSessionBootstrap: windowSession,
      });
      releaseCloseFlushHandoff();
      api.reportInitializationReady?.({
        durationMs: performance.now() - startedAt,
        outcome: "ready",
      });
      dispose();
    })
    .catch(() => {
      if (disposed) return;
      renderStep({ phase: "failed" });
      api.reportInitializationReady?.({
        durationMs: performance.now() - startedAt,
        outcome: "failed",
      });
    });

  return { dispose };
}
