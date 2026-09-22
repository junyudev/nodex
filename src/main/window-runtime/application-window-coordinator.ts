import type { BrowserWindow } from "electron";
import { Effect } from "effect";
import type { InitialProjectPresentation } from "../../shared/initial-project-welcome";
import type {
  WindowSessionBounds,
  WindowSessionNewWindowRequest,
  WindowSessionRecord,
  WindowSessionSaveLayoutInput,
} from "../../shared/window-session";
import { REQUEST_NEW_WINDOW_HOST_CHANNEL } from "../../shared/window-navigation";
import { safeSendToWindow } from "../ipc-safe-send";
import type { AcquiredWindowSession } from "../window-session-state";
import { captureWindowSessionBounds, type WindowRuntimeService } from "./WindowRuntime";
import type { ShutdownWindow, WindowCleanupReport } from "./WindowShutdown";

export interface ApplicationWindowCoordinatorOptions {
  readonly closeAll: (windows: readonly ShutdownWindow[]) => Effect.Effect<WindowCleanupReport>;
  readonly create: (session: WindowSessionRecord) => BrowserWindow;
  readonly focusedWindow: () => BrowserWindow | null;
  readonly reportFailure: (input: {
    readonly cause: unknown;
    readonly operation: "acquire" | "rollback";
    readonly windowSessionId?: string;
  }) => void;
  readonly syncTitle: (window: BrowserWindow) => void;
  readonly windows: WindowRuntimeService;
}

export interface ApplicationWindowCoordinator {
  readonly beginApplicationQuit: () => void;
  readonly bootstrap: (webContentsId: number) => { readonly session: WindowSessionRecord };
  readonly focusLast: () => void;
  readonly openDictationRecording: (recordingId: string) => boolean;
  readonly flushDictationRecording: (webContentsId: number) => void;
  readonly openForRequest: (
    sourceWebContentsId: number,
    request: WindowSessionNewWindowRequest,
  ) => void;
  readonly prepareQuit: Effect.Effect<WindowCleanupReport>;
  readonly requestNew: () => void;
  readonly resolveSessionId: (webContentsId: number) => string | null;
  readonly saveLayout: (
    webContentsId: number,
    input: WindowSessionSaveLayoutInput,
  ) => { readonly session: WindowSessionRecord };
  readonly seedInitialProjectPresentation: (presentation: InitialProjectPresentation) => void;
  readonly sendReminderOpen: (payload: {
    readonly projectId: string;
    readonly pageId: string;
    readonly occurrenceStart: string;
  }) => void;
  readonly stop: () => void;
  readonly updateBounds: (webContentsId: number, bounds: WindowSessionBounds) => void;
}

export const createApplicationWindowCoordinator = (
  options: ApplicationWindowCoordinatorOptions,
): ApplicationWindowCoordinator => {
  let accepting = true;
  let pendingRecording: { readonly webContentsId: number; readonly recordingId: string } | null =
    null;

  const show = (window: BrowserWindow): BrowserWindow => {
    window.show();
    window.focus();
    return window;
  };
  const openNew = (sourceWebContentsId?: number): BrowserWindow | null => {
    if (!accepting) return null;
    let acquired: AcquiredWindowSession | null = null;
    try {
      acquired = options.windows.acquireSessionForNewWindow(sourceWebContentsId);
      return show(options.create(acquired.session));
    } catch (cause) {
      if (acquired?.kind === "reopened") {
        try {
          options.windows.rollbackReopenSession(acquired.previousRecord);
        } catch (rollbackCause) {
          options.reportFailure({
            cause: rollbackCause,
            operation: "rollback",
            windowSessionId: acquired.session.id,
          });
        }
      }
      options.reportFailure({
        cause,
        operation: "acquire",
        windowSessionId: acquired?.session.id,
      });
      return null;
    }
  };
  const focusLast = (): void => {
    if (!accepting) return;
    const existing = options.windows.getLastFocused();
    if (!existing) {
      openNew();
      return;
    }
    if (existing.isMinimized()) existing.restore();
    show(existing);
  };
  const requestNew = (): void => {
    if (!accepting) return;
    if (options.windows.hasClosedSessionAvailable()) {
      openNew();
      return;
    }
    const source = options.focusedWindow() ?? options.windows.getLastFocused();
    if (!source || source.isDestroyed()) {
      openNew();
      return;
    }
    const sourceWebContentsId = source.webContents.id;
    if (
      options.windows.isRendererInitialized(sourceWebContentsId) &&
      safeSendToWindow(source, REQUEST_NEW_WINDOW_HOST_CHANNEL)
    ) {
      return;
    }
    openNew(sourceWebContentsId);
  };
  const saveLayout = (
    webContentsId: number,
    input: WindowSessionSaveLayoutInput,
  ): { readonly session: WindowSessionRecord } => {
    const window = options.windows.get(webContentsId);
    const session = options.windows.saveLayout(
      webContentsId,
      input,
      window && !window.isDestroyed() ? captureWindowSessionBounds(window) : undefined,
    );
    if (window) options.syncTitle(window);
    return { session };
  };
  const flushDictationRecording = (webContentsId: number): void => {
    if (!accepting || pendingRecording?.webContentsId !== webContentsId) return;
    if (!options.windows.isRendererInitialized(webContentsId)) return;
    const window = options.windows.get(webContentsId);
    if (
      safeSendToWindow(window, "dictation:open-recording", [
        { recordingId: pendingRecording.recordingId },
      ])
    ) {
      pendingRecording = null;
    }
  };

  return {
    beginApplicationQuit: () => {
      accepting = false;
      options.windows.beginApplicationQuit();
    },
    bootstrap: (webContentsId) => {
      const session = options.windows.bootstrap(webContentsId);
      const window = options.windows.get(webContentsId);
      if (window) options.syncTitle(window);
      return { session };
    },
    focusLast,
    openDictationRecording: (recordingId) => {
      if (!accepting) return false;
      const existing = options.windows.getLastFocused();
      const window = existing ?? openNew();
      if (!window || window.isDestroyed()) return false;
      if (existing) {
        if (window.isMinimized()) window.restore();
        show(window);
      }
      pendingRecording = { webContentsId: window.webContents.id, recordingId };
      flushDictationRecording(window.webContents.id);
      return true;
    },
    flushDictationRecording,
    openForRequest: (sourceWebContentsId, request) => {
      if (!accepting) return;
      if (request.activeProjectSessionId === undefined) {
        openNew(sourceWebContentsId);
        return;
      }
      show(options.create(options.windows.cloneSessionForWindow(sourceWebContentsId, request)));
    },
    prepareQuit: Effect.suspend(() => {
      accepting = false;
      options.windows.beginApplicationQuit();
      return options.closeAll(options.windows.all());
    }),
    requestNew,
    resolveSessionId: options.windows.resolveSessionId,
    saveLayout,
    seedInitialProjectPresentation: options.windows.seedInitialProjectPresentation,
    sendReminderOpen: (payload) => {
      focusLast();
      safeSendToWindow(options.windows.getLastFocused(), "reminder:open", [payload]);
    },
    stop: () => {
      accepting = false;
      pendingRecording = null;
    },
    updateBounds: options.windows.updateBounds,
  };
};
