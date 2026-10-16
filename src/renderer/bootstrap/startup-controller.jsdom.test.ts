import { act } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createStartupShellMarkup } from "../../../config/startup-shell-html";
import type { AppInitializationStep, RendererInitializationReport } from "../../shared/app-startup";
import { startStartupController } from "./startup-controller";

const mocks = vi.hoisted(() => ({
  initializeElectronRendererLocalCommitIngress: vi.fn(),
  initializeRendererSentry: vi.fn<() => Promise<void>>(),
  initializeRendererTelemetry: vi.fn<() => Promise<void>>(),
  mountApplicationRenderer: vi.fn<() => Promise<void>>(),
  registerAppCloseFlushHandler: vi.fn<(handler: () => void) => () => void>(),
}));

vi.mock("../application-renderer", () => ({
  mountApplicationRenderer: mocks.mountApplicationRenderer,
}));

vi.mock("../lib/app-close-flush", () => ({
  registerAppCloseFlushHandler: mocks.registerAppCloseFlushHandler,
}));

vi.mock("../lib/app-close-flush-deps", () => ({
  notifyAppCloseFlushComplete: (webContentsId: number) =>
    window.api?.invoke("app:flush-before-close:done", webContentsId),
  readAppCloseBridge: () => window.api ?? null,
}));

vi.mock("../lib/electron-renderer-transport", () => ({
  initializeElectronRendererLocalCommitIngress: mocks.initializeElectronRendererLocalCommitIngress,
}));

vi.mock("../lib/sentry-renderer", () => ({
  initializeRendererSentry: mocks.initializeRendererSentry,
}));

vi.mock("../lib/statsig-telemetry", () => ({
  initializeRendererTelemetry: mocks.initializeRendererTelemetry,
}));

interface BridgeHarness {
  readonly invoke: ReturnType<typeof vi.fn>;
  readonly reportInitializationReady: ReturnType<
    typeof vi.fn<(report: RendererInitializationReport) => void>
  >;
  readonly rejectInitialization: (cause: unknown) => void;
  readonly resolveInitialization: () => void;
  readonly restartApplication: ReturnType<typeof vi.fn>;
  readonly sendStep: (step: AppInitializationStep) => void;
  readonly sendCloseFlush: (webContentsId: number) => void;
}

function installBridge(): BridgeHarness {
  const closeFlushListeners = new Set<(...args: unknown[]) => void>();
  let initializationListener: ((step: AppInitializationStep) => void) | null = null;
  let resolveInitialization = (): void => undefined;
  let rejectInitialization = (_cause: unknown): void => undefined;
  const initialization = new Promise<void>((resolve, reject) => {
    resolveInitialization = resolve;
    rejectInitialization = reject;
  });
  const invoke = vi.fn(() => Promise.resolve());
  const reportInitializationReady = vi.fn<(report: RendererInitializationReport) => void>();
  const restartApplication = vi.fn(() => Promise.resolve());
  Object.defineProperty(window, "api", {
    configurable: true,
    value: {
      awaitInitialization: () => initialization,
      invoke,
      on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
        if (channel === "app:flush-before-close") closeFlushListeners.add(listener);
        return () => closeFlushListeners.delete(listener);
      }),
      onInitializationStep: (listener: (step: AppInitializationStep) => void) => {
        initializationListener = listener;
        return () => {
          initializationListener = null;
        };
      },
      reportInitializationReady,
      restartApplication,
    },
  });
  return {
    invoke,
    reportInitializationReady,
    rejectInitialization,
    resolveInitialization,
    restartApplication,
    sendStep: (step) => initializationListener?.(step),
    sendCloseFlush: (webContentsId) => {
      for (const listener of closeFlushListeners) listener(webContentsId);
    },
  };
}

describe("startup controller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.initializeElectronRendererLocalCommitIngress.mockReset();
    mocks.initializeRendererSentry.mockReset().mockResolvedValue(undefined);
    mocks.initializeRendererTelemetry.mockReset().mockResolvedValue(undefined);
    mocks.mountApplicationRenderer.mockReset().mockResolvedValue(undefined);
    mocks.registerAppCloseFlushHandler.mockReset().mockReturnValue(() => undefined);
    document.body.innerHTML = `<div id="root">${createStartupShellMarkup()}</div>`;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    Reflect.deleteProperty(window, "api");
  });

  test("keeps fast opening quiet and immediately presents real migration state", () => {
    const bridge = installBridge();
    const controller = startStartupController();
    const visibleStatus = document.querySelector<HTMLElement>("[data-startup-visible-status]");

    expect(visibleStatus?.hidden).toBe(true);
    bridge.sendStep({ phase: "migrating", fromVersion: 2, toVersion: 3 });
    expect(visibleStatus?.hidden).toBe(false);
    expect(visibleStatus?.textContent).toBe("Updating local data…");
    bridge.sendStep({
      phase: "migrating",
      fromVersion: 2,
      toVersion: 3,
      completed: 4,
      total: 5,
    });
    expect(visibleStatus?.textContent).toBe("Updating local data… 80%");
    bridge.sendStep({
      phase: "migrating",
      fromVersion: 2,
      toVersion: 3,
      completed: 3,
      total: 5,
    });
    expect(visibleStatus?.textContent).toBe("Updating local data… 80%");
    bridge.sendStep({ phase: "opening" });
    expect(visibleStatus?.textContent).toBe("Updating local data… 80%");

    controller.dispose();
  });

  test("reveals generic copy only after the quiet-start delay", async () => {
    installBridge();
    const controller = startStartupController();
    const visibleStatus = document.querySelector<HTMLElement>("[data-startup-visible-status]");

    expect(visibleStatus?.hidden).toBe(true);
    await act(async () => vi.advanceTimersByTime(1_800));
    expect(visibleStatus?.hidden).toBe(false);
    expect(visibleStatus?.textContent).toBe("Opening Nodex…");

    controller.dispose();
  });

  test("retains the logo and exposes restart when initialization fails", async () => {
    const bridge = installBridge();
    const controller = startStartupController();

    await act(async () => {
      bridge.rejectInitialization(new Error("startup failed"));
      await Promise.resolve();
    });
    const shell = document.querySelector<HTMLElement>(".nodex-startup-shell");
    const restart = document.querySelector<HTMLButtonElement>("[data-startup-restart]");
    expect(shell?.dataset.startupPhase).toBe("failed");
    expect(document.querySelector(".nodex-startup-logo-base")).not.toBeNull();
    expect(restart?.hidden).toBe(false);
    expect(bridge.reportInitializationReady).toHaveBeenCalledWith({
      durationMs: expect.any(Number),
      outcome: "failed",
      timingsMs: { native: expect.any(Number) },
    });
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(mocks.mountApplicationRenderer).not.toHaveBeenCalled();
    await act(async () => {
      restart?.click();
      await Promise.resolve();
    });
    expect(bridge.restartApplication).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test("does not mount the application before native initialization completes", async () => {
    const bridge = installBridge();
    startStartupController();

    await act(async () => Promise.resolve());
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(mocks.mountApplicationRenderer).not.toHaveBeenCalled();
    expect(bridge.reportInitializationReady).not.toHaveBeenCalled();

    await act(async () => {
      bridge.resolveInitialization();
      await vi.waitFor(() => {
        expect(bridge.reportInitializationReady).toHaveBeenCalledWith({
          durationMs: expect.any(Number),
          outcome: "ready",
          timingsMs: {
            native: expect.any(Number),
            bootstrap: expect.any(Number),
            modules: expect.any(Number),
            diagnostics: expect.any(Number),
            mount: expect.any(Number),
          },
        });
      });
    });
    expect(mocks.mountApplicationRenderer).toHaveBeenCalledOnce();
  });

  test("reports the failed startup phase without mounting or inventing later timings", async () => {
    const bridge = installBridge();
    mocks.initializeRendererSentry.mockRejectedValueOnce(new Error("diagnostics failed"));
    const controller = startStartupController();

    await act(async () => {
      bridge.resolveInitialization();
      await vi.waitFor(() => {
        expect(bridge.reportInitializationReady).toHaveBeenCalledWith({
          durationMs: expect.any(Number),
          outcome: "failed",
          timingsMs: {
            native: expect.any(Number),
            bootstrap: expect.any(Number),
            modules: expect.any(Number),
            diagnostics: expect.any(Number),
          },
        });
      });
    });
    expect(mocks.mountApplicationRenderer).not.toHaveBeenCalled();
    expect(document.querySelector<HTMLElement>(".nodex-startup-shell")?.dataset.startupPhase).toBe(
      "failed",
    );
    expect(document.querySelector<HTMLButtonElement>("[data-startup-restart]")?.hidden).toBe(false);
    controller.dispose();
  });

  test("finishes startup when optional browser profiling throws", async () => {
    const bridge = installBridge();
    const previousMeasure = Object.getOwnPropertyDescriptor(performance, "measure");
    const measure = vi.fn(() => {
      throw new Error("Browser profiling is unavailable");
    });
    Object.defineProperty(performance, "measure", { configurable: true, value: measure });
    const controller = startStartupController();
    try {
      await act(async () => {
        bridge.resolveInitialization();
        await vi.waitFor(() => {
          expect(bridge.reportInitializationReady).toHaveBeenCalledOnce();
        });
      });
      expect(measure).toHaveBeenCalled();
      expect(mocks.mountApplicationRenderer).toHaveBeenCalledOnce();
      expect(bridge.reportInitializationReady.mock.calls[0]?.[0]).toMatchObject({
        outcome: "ready",
        timingsMs: { mount: expect.any(Number) },
      });
    } finally {
      controller.dispose();
      if (previousMeasure) Object.defineProperty(performance, "measure", previousMeasure);
      else Reflect.deleteProperty(performance, "measure");
    }
  });

  test("hands close acknowledgment to the full coordinator before a pending mount", async () => {
    const closeFlush =
      await vi.importActual<typeof import("../lib/app-close-flush")>("../lib/app-close-flush");
    const bridge = installBridge();
    let finishMount = (): void => undefined;
    let finishFlush = (): void => undefined;
    const mounting = new Promise<void>((resolve) => {
      finishMount = resolve;
    });
    const flushing = new Promise<void>((resolve) => {
      finishFlush = resolve;
    });
    let releaseFlush = (): void => undefined;
    mocks.mountApplicationRenderer.mockReturnValue(mounting);
    mocks.registerAppCloseFlushHandler.mockImplementation((handler) => {
      releaseFlush = closeFlush.registerAppCloseFlushHandler(() => flushing);
      return closeFlush.registerAppCloseFlushHandler(handler);
    });
    const controller = startStartupController();
    try {
      await act(async () => bridge.sendCloseFlush(41));
      expect(bridge.invoke).toHaveBeenCalledWith("app:flush-before-close:done", 41);
      await act(async () => {
        bridge.resolveInitialization();
        await vi.waitFor(() => expect(mocks.mountApplicationRenderer).toHaveBeenCalledOnce());
      });
      bridge.invoke.mockClear();
      await act(async () => bridge.sendCloseFlush(42));
      expect(bridge.invoke).not.toHaveBeenCalledWith("app:flush-before-close:done", 42);
      expect(bridge.reportInitializationReady).not.toHaveBeenCalled();

      await act(async () => finishFlush());
      expect(bridge.invoke).toHaveBeenCalledExactlyOnceWith("app:flush-before-close:done", 42);
      await act(async () => finishMount());
      expect(bridge.reportInitializationReady).toHaveBeenCalledOnce();
    } finally {
      releaseFlush();
      controller.dispose();
    }
  });

  test("releases the handoff registration when mounting fails", async () => {
    const bridge = installBridge();
    const releaseHandoff = vi.fn();
    mocks.registerAppCloseFlushHandler.mockReturnValue(releaseHandoff);
    mocks.mountApplicationRenderer.mockRejectedValue(new Error("mount failed"));
    const controller = startStartupController();
    await act(async () => {
      bridge.resolveInitialization();
      await vi.waitFor(() => expect(bridge.reportInitializationReady).toHaveBeenCalledOnce());
    });
    expect(bridge.reportInitializationReady.mock.calls[0]?.[0]).toMatchObject({
      outcome: "failed",
    });
    expect(releaseHandoff).toHaveBeenCalledOnce();
    controller.dispose();
    controller.dispose();
    expect(releaseHandoff).toHaveBeenCalledOnce();
  });
});
