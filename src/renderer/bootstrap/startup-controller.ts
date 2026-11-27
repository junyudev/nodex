import type { AppInitializationStep, RendererInitializationPhase } from "../../shared/app-startup";
import { subscribeAppLocale } from "../lib/app-locale";
import { startupOperations } from "./startup-operations";
import { fallbackStartupFormat, startupShellText, type StartupFormat } from "./startup-messages";

/** Matches the shell's crossfade in the parser-time stylesheet. */
const REVEAL_MS = 150;
/** A view whose first content never settles still opens rather than leaving the logo up. */
const REVEAL_DEADLINE_MS = 3_000;

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
  const applicationRoot = document.getElementById("root");
  // The application lays out beneath the shell before its first view is ready to show.
  applicationRoot?.setAttribute("aria-busy", "true");
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
  // Copy waits for the display language, so a window never flashes another language first.
  let format: StartupFormat | null = null;

  const renderLocalizedStep = (): void => {
    if (disposed || !format) return;
    const text = startupShellText(latestStep, format);
    elements.shell.dataset.startupPhase = latestStep.phase;
    elements.accessibilityStatus.textContent = text.status;

    if (text.phase === "failed") {
      elements.failureTitle.textContent = text.title;
      elements.failureDetail.textContent = text.detail;
      elements.restart.textContent = text.restart;
      elements.failure.hidden = false;
      elements.accessibilityStatus.parentElement?.setAttribute("role", "alert");
      return;
    }

    elements.visibleStatus.textContent = text.visibleStatus ?? "";
    elements.visibleStatus.hidden = text.visibleStatus === null;
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
  // The formatter loads after the language, outside the shell's eager script.
  void localeReady
    .then(() => import("./startup-copy"))
    .then(
      ({ formatStartupMessage }) => formatStartupMessage,
      () => fallbackStartupFormat,
    )
    .then((loaded) => {
      format = loaded;
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
  let revealed = false;
  /** Shows the application in the frame after its first view committed, then retires the shell. */
  const reveal = (): void => {
    if (revealed) return;
    revealed = true;
    applicationRoot?.removeAttribute("aria-busy");
    const instant =
      document.visibilityState === "hidden" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
    if (instant) {
      elements.shell.remove();
      return;
    }
    elements.shell.dataset.startupRevealing = "";
    setTimeout(() => elements.shell.remove(), REVEAL_MS);
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
    .then(async (bootstrap) => {
      if (bootstrap.kind !== "window-session") throw new Error("Expected a Window Session");
      await localeReady;
      if (disposed) return;
      const { bindRendererSpace } = await import("../lib/renderer-space");
      bindRendererSpace(bootstrap.space);
      renderStep({ phase: "done" });
      const [application, closeFlush, transport, sentry] = await measure("modules", () =>
        Promise.all([
          Promise.all([
            import("./renderer-markdown").then(({ initializeRendererMarkdown }) =>
              initializeRendererMarkdown(),
            ),
            import("./renderer-search-kernel").then(({ initializeRendererSearchKernel }) =>
              initializeRendererSearchKernel(),
            ),
          ]).then(() => import("../application-renderer")),
          import("../lib/app-close-flush"),
          import("../lib/electron-renderer-transport"),
          import("../lib/sentry-renderer"),
        ]),
      );
      if (disposed) return;
      transport.initializeElectronRendererLocalCommitIngress(api);
      await measure("diagnostics", () =>
        sentry.initializeRendererSentry({ settings: bootstrap.diagnostics }),
      );
      // Install the full close coordinator before retiring the bootstrap ack.
      const releaseCloseFlushHandoff = closeFlush.registerAppCloseFlushHandler(() => undefined);
      retireStartupCloseFlush();
      const mounting = measure("mount", () =>
        application.mountApplicationRenderer({
          runtimeCapabilities: bootstrap.runtimeCapabilities,
          windowSessionBootstrap: { session: bootstrap.windowSession },
        }),
      );
      // A failed mount keeps the shell, which then presents the failure.
      void Promise.race([
        mounting,
        new Promise<void>((resolve) => setTimeout(resolve, REVEAL_DEADLINE_MS)),
      ]).then(reveal, () => undefined);
      try {
        await mounting;
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
