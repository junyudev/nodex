import type { AppInitializationStep, RendererInitializationPhase } from "../../shared/app-startup";
import { FAIL_CLOSED_RUNTIME_CAPABILITIES } from "../../shared/runtime-capabilities";
import { getStartupStatus, startupShellMessages } from "../lib/app-startup";
import { getIntl, subscribeAppLocale } from "../lib/i18n";
import { startupOperations } from "./startup-operations";

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
  readonly failureTitle: HTMLElement;
  readonly failureDetail: HTMLElement;
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
    failureTitle: requireStartupElement("[data-startup-failure] h1"),
    failureDetail: requireStartupElement("[data-startup-failure] p"),
    restart: requireStartupElement<HTMLButtonElement>("[data-startup-restart]"),
    shell: requireStartupElement(".nodex-startup-shell"),
    visibleStatus: requireStartupElement("[data-startup-visible-status]"),
  };
}

export interface StartupController {
  readonly dispose: () => void;
}

/** Owns the framework-free phase between parser-time paint and full application mount. */
export function startStartupController(localeReady: Promise<void>): StartupController {
  const api = window.api;
  if (!api?.awaitInitialization) {
    throw new Error("Nodex bootstrap requires the Electron preload bridge");
  }
  const awaitInitialization = api.awaitInitialization;

  const elements = readStartupElements();
  const startedAt = performance.now();
  const timingsMs: Partial<Record<RendererInitializationPhase, number>> = {};
  const measure = async <T>(
    phase: RendererInitializationPhase,
    run: () => Promise<T>,
  ): Promise<T> => {
    const start = performance.now();
    try {
      return await run();
    } finally {
      timingsMs[phase] = Math.round(performance.now() - start);
      try {
        performance.measure?.(`nodex:startup:${phase}`, { start, end: performance.now() });
      } catch {
        // Optional browser profiling must not change the startup outcome.
      }
    }
  };
  let latestStep: AppInitializationStep = { phase: "opening" };
  let latestMigrationCompleted = -1;
  let disposed = false;
  let localized = false;

  const renderLocalizedStep = (): void => {
    if (disposed || !localized) return;
    const intl = getIntl();
    elements.shell.dataset.startupPhase = latestStep.phase;

    if (latestStep.phase === "failed") {
      elements.failureTitle.textContent = intl.formatMessage(startupShellMessages.failureTitle);
      elements.failureDetail.textContent = intl.formatMessage(startupShellMessages.failureDetail);
      elements.restart.textContent = intl.formatMessage(startupShellMessages.restart);
      elements.failure.hidden = false;
      elements.accessibilityStatus.textContent = intl.formatMessage(
        startupShellMessages.failureStatus,
      );
      elements.accessibilityStatus.parentElement?.setAttribute("role", "alert");
      return;
    }

    const status = getStartupStatus(latestStep);
    elements.accessibilityStatus.textContent =
      status ?? intl.formatMessage(startupShellMessages.opening);
    elements.visibleStatus.textContent = status ?? "";
    elements.visibleStatus.hidden = status === null;
  };

  const renderStep = (step: AppInitializationStep): void => {
    if (disposed || PHASE_ORDER[step.phase] < PHASE_ORDER[latestStep.phase]) return;
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
    latestStep = step;
    renderLocalizedStep();
  };
  const unsubscribeLocale = subscribeAppLocale(renderLocalizedStep);
  void localeReady.then(() => {
    localized = true;
    renderLocalizedStep();
  });

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
  let startupCloseFlushActive = true;
  const retireStartupCloseFlush = (): void => {
    if (!startupCloseFlushActive) return;
    startupCloseFlushActive = false;
    unsubscribeCloseFlush();
  };
  const onRestart = (): void => {
    void api.restartApplication?.();
  };
  elements.restart.addEventListener("click", onRestart);

  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    unsubscribeLocale();
    unsubscribeInitialization();
    retireStartupCloseFlush();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    document.documentElement.classList.remove("nodex-startup-document-hidden");
    elements.restart.removeEventListener("click", onRestart);
  };

  void measure("native", awaitInitialization)
    .then(async () => {
      await localeReady;
      if (disposed) return;
      if (api.getSpaceContext) {
        const { bindRendererSpace } = await import("../lib/renderer-space");
        bindRendererSpace(await api.getSpaceContext());
      }
      renderStep({ phase: "done" });
      const [windowSession, runtimeCapabilities] = await measure("bootstrap", () =>
        Promise.all([
          startupOperations.readWindowSession(api),
          startupOperations
            .readRuntimeCapabilities(api)
            .catch(() => FAIL_CLOSED_RUNTIME_CAPABILITIES),
        ]),
      );
      const [application, closeFlush, transport, sentry] = await measure("modules", () =>
        Promise.all([
          import("./renderer-markdown").then(async ({ initializeRendererMarkdown }) => {
            await initializeRendererMarkdown();
            return import("../application-renderer");
          }),
          import("../lib/app-close-flush"),
          import("../lib/electron-renderer-transport"),
          import("../lib/sentry-renderer"),
        ]),
      );
      if (disposed) return;
      transport.initializeElectronRendererLocalCommitIngress(api);
      await measure("diagnostics", () => sentry.initializeRendererSentry());
      // Install the full close coordinator before retiring the bootstrap ack.
      const releaseCloseFlushHandoff = closeFlush.registerAppCloseFlushHandler(() => undefined);
      retireStartupCloseFlush();
      try {
        await measure("mount", () =>
          application.mountApplicationRenderer({
            runtimeCapabilities,
            windowSessionBootstrap: windowSession,
          }),
        );
      } finally {
        releaseCloseFlushHandoff();
      }
      if (disposed) return;
      api.reportInitializationReady?.({
        durationMs: performance.now() - startedAt,
        outcome: "ready",
        timingsMs,
      });
      dispose();
    })
    .catch(() => {
      if (disposed) return;
      renderStep({ phase: "failed" });
      api.reportInitializationReady?.({
        durationMs: performance.now() - startedAt,
        outcome: "failed",
        timingsMs,
      });
    });

  return { dispose };
}
