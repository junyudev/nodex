import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { nativeTheme, screen, type BrowserWindow } from "electron";
import type { InitialProjectPresentation } from "../../shared/initial-project-welcome";
import type {
  WindowRestorePolicy,
  WindowSessionBounds,
  WindowSessionNewWindowRequest,
  WindowSessionRecord,
  WindowSessionSaveLayoutInput,
} from "../../shared/window-session";
import { getWorkbenchActiveSessionId } from "../../shared/workbench-layout";
import {
  WindowSessionState,
  type AcquiredWindowSession,
  type ReopenedWindowSession,
  type WindowSessionCloseDisposition,
} from "../window-session-state";
import { safeSendToWindow } from "../ipc-safe-send";
import { getLogger } from "../logging/logger";
import { resolveElectronWindowBackdrop } from "../electron-window-backdrop";
import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import type {
  WindowRuntimeAuxiliaryRole,
  WindowRuntimeLifecycleEvent,
  WindowRuntimePrimaryWindowSnapshot,
  WindowRuntimeSnapshot,
  WindowRuntimeWindowSnapshot,
} from "./window-runtime-lifecycle";

const WINDOW_CLOSE_FLUSH_TIMEOUT = "1500 millis";
const logger = getLogger({ component: "window-runtime" });

interface ManagedWindowClose {
  acknowledge: () => void;
  allowImmediate: boolean;
  blurHandler: () => void;
  closeHandler: (event: Electron.Event) => void;
  closedHandler: () => void;
  disposition: WindowSessionCloseDisposition;
  finalBounds: WindowSessionBounds | undefined;
  finish: () => void;
  focusHandler: () => void;
  moveHandler: () => void;
  resizeHandler: () => void;
  timeoutPending: boolean;
  window: BrowserWindow;
}

interface RegisteredWindowBase {
  focusSequence: number | null;
  readonly window: BrowserWindow;
}

interface RegisteredPrimaryWindow extends RegisteredWindowBase {
  activeSessionId: string | null;
  readonly kind: "primary";
  layoutRevision: number;
  readonly windowSessionId: string;
}

interface RegisteredAuxiliaryWindow extends RegisteredWindowBase {
  readonly cleanup: () => void;
  readonly kind: "auxiliary";
  readonly role: WindowRuntimeAuxiliaryRole;
}

type RegisteredWindow = RegisteredPrimaryWindow | RegisteredAuxiliaryWindow;
type WindowRuntimeLifecycleEventInput = WindowRuntimeLifecycleEvent extends infer Event
  ? Event extends WindowRuntimeLifecycleEvent
    ? Omit<Event, "revision">
    : never
  : never;

export function captureWindowSessionBounds(window: BrowserWindow): WindowSessionBounds {
  const bounds = window.getBounds();
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    mode: window.isFullScreen() ? "fullscreen" : window.isMaximized() ? "maximized" : "normal",
  };
}

function applyElectronWindowBackdrop(
  platform: NodeJS.Platform,
  window: BrowserWindow,
  opaqueSurfaceModes: Map<number, boolean>,
  force = false,
): void {
  if (platform !== "darwin" && platform !== "win32") return;
  if (window.isDestroyed()) return;
  const bounds = window.getBounds();
  const backdrop = resolveElectronWindowBackdrop({
    bounds,
    // A hidden canonical shell has not had a chance to focus yet; preserving
    // native material avoids an opaque first paint followed by a focus flash.
    isFocused: !window.isVisible() || window.isFocused(),
    platform,
    prefersDarkColors: nativeTheme.shouldUseDarkColors,
    prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
    scaleFactor: screen.getDisplayMatching(bounds).scaleFactor,
  });
  const { opaqueWindowSurfaceEnabled } = backdrop;
  if (!force && opaqueSurfaceModes.get(window.id) === opaqueWindowSurfaceEnabled) return;
  try {
    window.setBackgroundColor(backdrop.backgroundColor);
    if (platform === "darwin") {
      window.setVibrancy(backdrop.vibrancy as Parameters<BrowserWindow["setVibrancy"]>[0]);
    }
    if (platform === "win32") {
      window.setBackgroundMaterial(
        backdrop.backgroundMaterial as Parameters<BrowserWindow["setBackgroundMaterial"]>[0],
      );
    }
    opaqueSurfaceModes.set(window.id, opaqueWindowSurfaceEnabled);
    safeSendToWindow(window, "electron-window-opaque-surface-changed", [
      { opaqueWindowSurfaceEnabled },
    ]);
  } catch (error) {
    logger.warn("Failed to apply Electron window backdrop", {
      error: error instanceof Error ? error.message : String(error),
      windowId: window.id,
    });
  }
}

interface WindowAppearancePort {
  readonly apply: (window: BrowserWindow, force?: boolean) => void;
  readonly forget: (window: BrowserWindow) => void;
  readonly subscribeToTheme: (listener: () => void) => () => void;
}

const noWindowAppearance: WindowAppearancePort = {
  apply: () => undefined,
  forget: () => undefined,
  subscribeToTheme: () => () => undefined,
};

function createElectronWindowAppearance(platform: NodeJS.Platform): WindowAppearancePort {
  const opaqueSurfaceModes = new Map<number, boolean>();
  return {
    apply: (window, force) =>
      applyElectronWindowBackdrop(platform, window, opaqueSurfaceModes, force ?? false),
    forget: (window) => opaqueSurfaceModes.delete(window.id),
    subscribeToTheme: (listener) => {
      nativeTheme.on("updated", listener);
      return () => nativeTheme.off("updated", listener);
    },
  };
}

export interface WindowRuntimeService {
  readonly acknowledgeClose: (webContentsId: number) => void;
  readonly acquireSessionForNewWindow: (sourceWebContentsId?: number) => AcquiredWindowSession;
  /** Primary Window Session windows only; auxiliary windows are intentionally excluded. */
  readonly all: () => readonly BrowserWindow[];
  readonly attach: (window: BrowserWindow, sessionId: string) => WindowSessionRecord;
  readonly bootstrap: (webContentsId: number) => WindowSessionRecord;
  readonly beginApplicationQuit: () => void;
  readonly cloneSessionForWindow: (
    sourceWebContentsId: number,
    override?: WindowSessionNewWindowRequest,
  ) => WindowSessionRecord;
  readonly count: () => number;
  readonly events: Stream.Stream<WindowRuntimeLifecycleEvent>;
  /** Resolves only a primary Window Session window. */
  readonly get: (webContentsId: number) => BrowserWindow | null;
  readonly getLastFocused: () => BrowserWindow | null;
  /** Resolves a typed-registry entry at the final Electron/native-handle seam. */
  readonly getRegisteredWindow: (webContentsId: number) => BrowserWindow | null;
  readonly has: (webContentsId: number) => boolean;
  readonly hasClosedSessionAvailable: () => boolean;
  readonly isRendererInitialized: (webContentsId: number) => boolean;
  readonly markRendererInitialized: (webContentsId: number) => boolean;
  readonly markFocused: (webContentsId: number) => void;
  /** Registers lifecycle projection only; the auxiliary Module retains ordinary close ownership. */
  readonly registerAuxiliary: (
    window: BrowserWindow,
    role: WindowRuntimeAuxiliaryRole,
  ) => () => void;
  readonly release: (
    webContentsId: number,
    input: {
      readonly disposition: WindowSessionCloseDisposition;
      readonly bounds?: WindowSessionBounds;
    },
  ) => WindowSessionRecord | null;
  readonly resolveSessionId: (webContentsId: number) => string | null;
  readonly rollbackReopenSession: (
    previousRecord: ReopenedWindowSession["previousRecord"],
  ) => WindowSessionRecord | null;
  readonly saveLayout: (
    webContentsId: number,
    input: WindowSessionSaveLayoutInput,
    bounds?: WindowSessionBounds,
  ) => WindowSessionRecord;
  readonly seedInitialProjectPresentation: (
    presentation: InitialProjectPresentation,
  ) => WindowSessionRecord;
  readonly selectStartupSessions: (policy: WindowRestorePolicy) => readonly WindowSessionRecord[];
  readonly snapshot: () => WindowRuntimeSnapshot;
  readonly updateBounds: (webContentsId: number, bounds: WindowSessionBounds) => void;
}

/** Owns the live Electron windows and their durable Window Session assignments as one resource. */
export class WindowRuntime extends Context.Service<WindowRuntime, WindowRuntimeService>()(
  "nodex/main/window-runtime/WindowRuntime",
) {}

export const fromState = (
  sessions: WindowSessionState,
  appearance: WindowAppearancePort = noWindowAppearance,
): Layer.Layer<WindowRuntime> =>
  Layer.effect(
    WindowRuntime,
    Effect.gen(function* () {
      const closeTimeouts = yield* FiberMap.make<number, void>();
      const runCloseTimeout = yield* FiberMap.runtime(closeTimeouts)();
      const lifecycleEvents = yield* PubSub.sliding<WindowRuntimeLifecycleEvent>(
        MAIN_OBSERVATION_EVENT_CAPACITY,
      );
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          const registeredWindows = new Map<number, RegisteredWindow>();
          const managedCloses = new Map<number, ManagedWindowClose>();
          const initializedRenderers = new Set<number>();
          let acceptingLifecycleEvents = true;
          let currentFocusedWebContentsId: number | null = null;
          let focusSequence = 0;
          let lastFocusedPrimaryWebContentsId: number | null = null;
          let lifecycleRevision = 0;
          let applicationQuitRequested = false;

          const primaryEntries = (): RegisteredPrimaryWindow[] =>
            [...registeredWindows.values()].filter(
              (entry): entry is RegisteredPrimaryWindow => entry.kind === "primary",
            );

          const toPrimaryWindowSnapshot = (
            entry: RegisteredPrimaryWindow,
          ): WindowRuntimePrimaryWindowSnapshot => ({
            activeSessionId: entry.activeSessionId,
            focusSequence: entry.focusSequence,
            focused: currentFocusedWebContentsId === entry.window.webContents.id,
            kind: entry.kind,
            layoutRevision: entry.layoutRevision,
            webContentsId: entry.window.webContents.id,
            windowId: entry.window.id,
            windowSessionId: entry.windowSessionId,
          });

          const toWindowSnapshot = (entry: RegisteredWindow): WindowRuntimeWindowSnapshot => {
            const base = {
              focusSequence: entry.focusSequence,
              focused: currentFocusedWebContentsId === entry.window.webContents.id,
              webContentsId: entry.window.webContents.id,
              windowId: entry.window.id,
            } as const;
            if (entry.kind === "auxiliary") {
              return { ...base, kind: entry.kind, role: entry.role };
            }
            return toPrimaryWindowSnapshot(entry);
          };

          const snapshot = (): WindowRuntimeSnapshot => ({
            revision: lifecycleRevision,
            windows: [...registeredWindows.values()].map(toWindowSnapshot),
          });

          const publishLifecycle = (event: WindowRuntimeLifecycleEventInput): void => {
            if (!acceptingLifecycleEvents) return;
            lifecycleRevision += 1;
            PubSub.publishUnsafe(lifecycleEvents, {
              ...event,
              revision: lifecycleRevision,
            } as WindowRuntimeLifecycleEvent);
          };

          const recordFocus = (entry: RegisteredWindow, focused: boolean): void => {
            const webContentsId = entry.window.webContents.id;
            const wasFocused = currentFocusedWebContentsId === webContentsId;
            if (wasFocused === focused) return;

            if (focused) {
              currentFocusedWebContentsId = webContentsId;
              focusSequence += 1;
              entry.focusSequence = focusSequence;
              if (entry.kind === "primary") {
                lastFocusedPrimaryWebContentsId = webContentsId;
                sessions.markFocused(webContentsId);
              }
            } else if (currentFocusedWebContentsId === webContentsId) {
              currentFocusedWebContentsId = null;
            }
            publishLifecycle({ kind: "focus-changed", window: toWindowSnapshot(entry) });
          };

          const cleanupClose = (webContentsId: number): void => {
            const managed = managedCloses.get(webContentsId);
            if (!managed) return;
            managedCloses.delete(webContentsId);
            if (managed.timeoutPending) {
              managed.timeoutPending = false;
              runCloseTimeout(webContentsId, Effect.void);
            }
            managed.window.removeListener("close", managed.closeHandler);
            managed.window.removeListener("closed", managed.closedHandler);
            managed.window.removeListener("blur", managed.blurHandler);
            managed.window.removeListener("focus", managed.focusHandler);
            managed.window.removeListener("move", managed.moveHandler);
            managed.window.removeListener("resize", managed.resizeHandler);
          };

          const release: WindowRuntimeService["release"] = (webContentsId, input) => {
            const entry = registeredWindows.get(webContentsId);
            if (entry?.kind !== "primary") return null;
            try {
              return sessions.detachWindow(webContentsId, input);
            } finally {
              cleanupClose(webContentsId);
              initializedRenderers.delete(webContentsId);
              appearance.forget(entry.window);
              registeredWindows.delete(webContentsId);
              if (currentFocusedWebContentsId === webContentsId) {
                currentFocusedWebContentsId = null;
              }
              if (lastFocusedPrimaryWebContentsId === webContentsId) {
                lastFocusedPrimaryWebContentsId = null;
              }
              publishLifecycle({ kind: "released", window: toWindowSnapshot(entry) });
            }
          };

          const releaseAuxiliary = (entry: RegisteredAuxiliaryWindow): void => {
            const webContentsId = entry.window.webContents.id;
            if (registeredWindows.get(webContentsId) !== entry) return;
            registeredWindows.delete(webContentsId);
            if (currentFocusedWebContentsId === webContentsId) {
              currentFocusedWebContentsId = null;
            }
            entry.cleanup();
            publishLifecycle({ kind: "released", window: toWindowSnapshot(entry) });
          };

          const installCloseLifecycle = (
            window: BrowserWindow,
            entry: RegisteredPrimaryWindow,
          ): void => {
            const webContentsId = window.webContents.id;
            const managed = {} as ManagedWindowClose;
            managed.allowImmediate = false;
            managed.disposition = "unexpected";
            managed.finalBounds = undefined;
            managed.timeoutPending = false;
            managed.window = window;
            managed.finish = () => {
              if (window.isDestroyed()) return;
              managed.allowImmediate = true;
              managed.finalBounds = captureWindowSessionBounds(window);
              managed.disposition = applicationQuitRequested ? "app-quit" : "user-close";
              window.close();
            };
            managed.acknowledge = () => {
              if (managed.timeoutPending) {
                managed.timeoutPending = false;
                runCloseTimeout(webContentsId, Effect.void);
              }
              managed.finish();
            };
            managed.closeHandler = (event) => {
              if (managed.allowImmediate) {
                managed.allowImmediate = false;
                return;
              }
              event.preventDefault();
              if (managed.timeoutPending) return;
              managed.timeoutPending = true;
              runCloseTimeout(
                webContentsId,
                Effect.sleep(WINDOW_CLOSE_FLUSH_TIMEOUT).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      managed.timeoutPending = false;
                      managed.finish();
                    }),
                  ),
                ),
                { onlyIfMissing: true },
              );
              if (!safeSendToWindow(window, "app:flush-before-close", [webContentsId])) {
                managed.acknowledge();
              }
            };
            managed.closedHandler = () => {
              try {
                release(webContentsId, {
                  disposition: managed.disposition,
                  bounds: managed.finalBounds,
                });
              } catch (error) {
                logger.error("Could not finalize Window Session close", {
                  error: error instanceof Error ? error.message : String(error),
                  webContentsId,
                });
              }
            };
            managed.focusHandler = () => {
              recordFocus(entry, true);
              appearance.apply(window);
              safeSendToWindow(window, "electron-window:focus-changed", [{ isFocused: true }]);
            };
            managed.blurHandler = () => {
              recordFocus(entry, false);
              appearance.apply(window);
              safeSendToWindow(window, "electron-window:focus-changed", [{ isFocused: false }]);
            };
            const updateBounds = (): void => {
              if (window.isDestroyed()) return;
              sessions.updateBounds(webContentsId, captureWindowSessionBounds(window));
              appearance.apply(window);
            };
            managed.moveHandler = updateBounds;
            managed.resizeHandler = updateBounds;
            managedCloses.set(webContentsId, managed);
            window.on("close", managed.closeHandler);
            window.on("closed", managed.closedHandler);
            window.on("blur", managed.blurHandler);
            window.on("focus", managed.focusHandler);
            window.on("move", managed.moveHandler);
            window.on("resize", managed.resizeHandler);
          };

          const runtime = WindowRuntime.of({
            acknowledgeClose: (webContentsId) => managedCloses.get(webContentsId)?.acknowledge(),
            acquireSessionForNewWindow: (sourceWebContentsId) =>
              sessions.acquireSessionForNewWindow(sourceWebContentsId),
            all: () => primaryEntries().map(({ window }) => window),
            attach: (window, sessionId) => {
              const webContentsId = window.webContents.id;
              if (window.isDestroyed()) throw new Error("Cannot register a destroyed window");
              if (registeredWindows.has(webContentsId)) {
                throw new Error("The requesting window is already registered");
              }
              const session = sessions.attachWindow(webContentsId, sessionId);
              const entry: RegisteredPrimaryWindow = {
                activeSessionId: getWorkbenchActiveSessionId(session.layout),
                focusSequence: null,
                kind: "primary",
                layoutRevision: session.layoutRevision,
                window,
                windowSessionId: session.id,
              };
              registeredWindows.set(webContentsId, entry);
              lastFocusedPrimaryWebContentsId = webContentsId;
              if (window.isFocused()) {
                currentFocusedWebContentsId = webContentsId;
                focusSequence += 1;
                entry.focusSequence = focusSequence;
              }
              installCloseLifecycle(window, entry);
              appearance.apply(window, true);
              publishLifecycle({ kind: "registered", window: toWindowSnapshot(entry) });
              return session;
            },
            bootstrap: (webContentsId) => sessions.bootstrap(webContentsId),
            beginApplicationQuit: () => {
              applicationQuitRequested = true;
            },
            cloneSessionForWindow: (sourceWebContentsId, override) =>
              sessions.cloneSessionForWindow(sourceWebContentsId, override),
            count: () => primaryEntries().length,
            events: Stream.fromPubSub(lifecycleEvents),
            get: (webContentsId) => {
              const entry = registeredWindows.get(webContentsId);
              return entry?.kind === "primary" ? entry.window : null;
            },
            getLastFocused: () => {
              if (lastFocusedPrimaryWebContentsId !== null) {
                const remembered = registeredWindows.get(lastFocusedPrimaryWebContentsId);
                if (remembered?.kind === "primary" && !remembered.window.isDestroyed()) {
                  return remembered.window;
                }
              }
              return primaryEntries().find(({ window }) => !window.isDestroyed())?.window ?? null;
            },
            getRegisteredWindow: (webContentsId) =>
              registeredWindows.get(webContentsId)?.window ?? null,
            has: (webContentsId) => registeredWindows.get(webContentsId)?.kind === "primary",
            hasClosedSessionAvailable: () => sessions.hasClosedSessionAvailable(),
            isRendererInitialized: (webContentsId) => initializedRenderers.has(webContentsId),
            markRendererInitialized: (webContentsId) => {
              if (
                registeredWindows.get(webContentsId)?.kind !== "primary" ||
                initializedRenderers.has(webContentsId)
              ) {
                return false;
              }
              initializedRenderers.add(webContentsId);
              return true;
            },
            markFocused: (webContentsId) => {
              const entry = registeredWindows.get(webContentsId);
              if (entry?.kind !== "primary") return;
              lastFocusedPrimaryWebContentsId = webContentsId;
              recordFocus(entry, true);
            },
            registerAuxiliary: (window, role) => {
              const webContentsId = window.webContents.id;
              if (window.isDestroyed()) throw new Error("Cannot register a destroyed window");
              if (registeredWindows.has(webContentsId)) {
                throw new Error("The requesting window is already registered");
              }

              let entry: RegisteredAuxiliaryWindow;
              const focusHandler = () => recordFocus(entry, true);
              const blurHandler = () => recordFocus(entry, false);
              const closedHandler = () => releaseAuxiliary(entry);
              const cleanup = () => {
                window.removeListener("focus", focusHandler);
                window.removeListener("blur", blurHandler);
                window.removeListener("closed", closedHandler);
              };
              entry = {
                cleanup,
                focusSequence: null,
                kind: "auxiliary",
                role,
                window,
              };
              registeredWindows.set(webContentsId, entry);
              if (window.isFocused()) {
                currentFocusedWebContentsId = webContentsId;
                focusSequence += 1;
                entry.focusSequence = focusSequence;
              }
              window.on("focus", focusHandler);
              window.on("blur", blurHandler);
              window.on("closed", closedHandler);
              publishLifecycle({ kind: "registered", window: toWindowSnapshot(entry) });
              return () => releaseAuxiliary(entry);
            },
            release,
            resolveSessionId: (webContentsId) => sessions.getSessionIdForWindow(webContentsId),
            rollbackReopenSession: (previousRecord) =>
              sessions.rollbackReopenSession(previousRecord),
            saveLayout: (webContentsId, input, bounds) => {
              const entry = registeredWindows.get(webContentsId);
              if (entry?.kind !== "primary") {
                return sessions.saveLayout(webContentsId, input, bounds);
              }
              const previousActiveSessionId = entry.activeSessionId;
              const session = sessions.saveLayout(webContentsId, input, bounds);
              if (session.layoutRevision <= entry.layoutRevision) return session;

              entry.activeSessionId = getWorkbenchActiveSessionId(session.layout);
              entry.layoutRevision = session.layoutRevision;
              publishLifecycle({
                kind: "layout-changed",
                previousActiveSessionId,
                window: toPrimaryWindowSnapshot(entry),
              });
              return session;
            },
            seedInitialProjectPresentation: (presentation) =>
              sessions.seedInitialProjectPresentation(presentation),
            selectStartupSessions: (policy) => sessions.selectStartupSessions(policy),
            snapshot,
            updateBounds: (webContentsId, bounds) => sessions.updateBounds(webContentsId, bounds),
          });
          const refreshWindowBackdrops = (): void => {
            for (const entry of primaryEntries()) {
              appearance.apply(entry.window, true);
            }
          };
          const releaseThemeSubscription = appearance.subscribeToTheme(refreshWindowBackdrops);
          return {
            runtime,
            dispose: () => {
              acceptingLifecycleEvents = false;
              releaseThemeSubscription();
              for (const entry of [...registeredWindows.values()]) {
                const { window } = entry;
                const webContentsId = window.webContents.id;
                if (!window.isDestroyed()) window.destroy();
                if (!registeredWindows.has(webContentsId)) continue;
                if (entry.kind === "auxiliary") {
                  releaseAuxiliary(entry);
                } else {
                  try {
                    runtime.release(webContentsId, { disposition: "unexpected" });
                  } catch {
                    // Scope release must still forget every remaining native window.
                  }
                }
              }
            },
          };
        }),
        ({ dispose }) =>
          Effect.sync(dispose).pipe(Effect.andThen(PubSub.shutdown(lifecycleEvents))),
      ).pipe(Effect.map(({ runtime }) => runtime));
    }),
  );

export const live = (userDataPath: string, platform: NodeJS.Platform): Layer.Layer<WindowRuntime> =>
  Layer.unwrap(
    Effect.sync(() =>
      fromState(new WindowSessionState(userDataPath), createElectronWindowAppearance(platform)),
    ),
  );
