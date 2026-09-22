import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from "electron";
import { APP_RENDERER_URL } from "../../shared/app-renderer-policy";
import {
  GLOBAL_DICTATION_COMMAND_CHANNEL,
  type GlobalDictationRendererCommand,
} from "../../shared/global-dictation";
import { resolveBundledElectronPreload } from "../electron-preload-path";

const WIDTH = 720;
const HEIGHT = 84;
const RECOVERY_HEIGHT = 180;
const BOTTOM_MARGIN = 16;

export const withGlobalDictationRoute = (rendererUrl: string): string => {
  const url = new URL(rendererUrl);
  url.searchParams.set("initialRoute", "/global-dictation");
  return url.toString();
};

export const resolveGlobalDictationBounds = (
  workArea: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  },
  recoveryVisible = false,
) => ({
  x: Math.round(workArea.x + (workArea.width - WIDTH) / 2),
  y: Math.max(
    workArea.y,
    workArea.y + workArea.height - (recoveryVisible ? RECOVERY_HEIGHT : HEIGHT) - BOTTOM_MARGIN,
  ),
  width: WIDTH,
  height: recoveryVisible ? RECOVERY_HEIGHT : HEIGHT,
});

type GlobalDictationNativeWindow = Pick<
  BrowserWindow,
  "setAlwaysOnTop" | "setIgnoreMouseEvents" | "setVisibleOnAllWorkspaces"
>;

/** Invalidates renderer-ready presentation work as soon as a newer visibility decision wins. */
export class GlobalDictationPresentationGate {
  #generation = 0;

  begin(): number {
    return ++this.#generation;
  }

  invalidate(): void {
    this.#generation += 1;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#generation;
  }
}

export type GlobalDictationWindowTerminalReason = "intentional" | "unexpected";

/** Configures the overlay without converting the foreground app into a Dock-less UI element. */
export function configureGlobalDictationNativeWindow(window: GlobalDictationNativeWindow): void {
  window.setAlwaysOnTop(true, "floating");
  window.setVisibleOnAllWorkspaces(true, {
    skipTransformProcessType: true,
    visibleOnFullScreen: true,
  });
  window.setIgnoreMouseEvents(true, { forward: false });
}

export const createGlobalDictationWindowOptions = (
  preloadPath: string,
  platform: NodeJS.Platform = process.platform,
): BrowserWindowConstructorOptions => ({
  title: "Dictation",
  width: WIDTH,
  height: HEIGHT,
  frame: false,
  transparent: true,
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  focusable: false,
  show: false,
  skipTaskbar: true,
  hasShadow: false,
  acceptFirstMouse: true,
  ...(platform === "darwin" ? { type: "panel" as const } : {}),
  webPreferences: {
    preload: preloadPath,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    backgroundThrottling: false,
  },
});

/** Owns the auxiliary window without registering it as a restorable WindowSession. */
export class GlobalDictationWindowController {
  readonly #preloadPath: string;
  readonly #rendererUrl: string;
  readonly #presentationGate = new GlobalDictationPresentationGate();
  #window: BrowserWindow | null = null;
  #windowGeneration = 0;
  #recoveryVisible = false;
  #rendererReadyWebContentsId: number | null = null;
  #resolveRendererReady: ((ready: boolean) => void) | null = null;
  #rendererReady: Promise<boolean> = Promise.resolve(false);
  readonly #intentionalCloseWebContentsIds = new Set<number>();
  readonly #terminalListeners = new Set<
    (webContentsId: number, reason: GlobalDictationWindowTerminalReason) => void
  >();

  constructor(options?: { readonly preloadPath?: string; readonly rendererUrl?: string }) {
    this.#preloadPath =
      options?.preloadPath ?? resolveBundledElectronPreload(__dirname, "global-dictation.js");
    this.#rendererUrl =
      options?.rendererUrl ?? process.env.ELECTRON_RENDERER_URL ?? APP_RENDERER_URL;
  }

  subscribeTerminal(
    listener: (webContentsId: number, reason: GlobalDictationWindowTerminalReason) => void,
  ): () => void {
    this.#terminalListeners.add(listener);
    return () => this.#terminalListeners.delete(listener);
  }

  ensureWindow(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const window = new BrowserWindow(createGlobalDictationWindowOptions(this.#preloadPath));
    configureGlobalDictationNativeWindow(window);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const generation = ++this.#windowGeneration;
    const webContentsId = window.webContents.id;
    this.#rendererReadyWebContentsId = null;
    this.#rendererReady = new Promise<boolean>((resolve) => {
      this.#resolveRendererReady = resolve;
    });
    let terminalReported = false;
    const repositionVisible = (): void => {
      if (!window.isDestroyed() && window.isVisible()) this.reposition();
    };
    screen.on("display-added", repositionVisible);
    screen.on("display-removed", repositionVisible);
    screen.on("display-metrics-changed", repositionVisible);
    const reportTerminal = (): void => {
      if (terminalReported) return;
      terminalReported = true;
      screen.off("display-added", repositionVisible);
      screen.off("display-removed", repositionVisible);
      screen.off("display-metrics-changed", repositionVisible);
      if (this.#window === window && this.#windowGeneration === generation) {
        this.#window = null;
        this.#rendererReadyWebContentsId = null;
        this.#resolveRendererReady?.(false);
        this.#resolveRendererReady = null;
      }
      const reason = this.#intentionalCloseWebContentsIds.delete(webContentsId)
        ? "intentional"
        : "unexpected";
      for (const listener of this.#terminalListeners) listener(webContentsId, reason);
      if (!window.isDestroyed()) window.destroy();
    };
    window.on("closed", reportTerminal);
    window.webContents.on("render-process-gone", reportTerminal);
    window.webContents.on("did-fail-load", reportTerminal);
    window.on("unresponsive", reportTerminal);
    this.#window = window;
    this.reposition();
    void window.loadURL(withGlobalDictationRoute(this.#rendererUrl));
    return window;
  }

  ownsWebContents(webContentsId: number): boolean {
    return this.#window?.isDestroyed() === false && this.#window.webContents.id === webContentsId;
  }

  markRendererReady(webContentsId: number): boolean {
    if (!this.ownsWebContents(webContentsId)) return false;
    this.#rendererReadyWebContentsId = webContentsId;
    this.#resolveRendererReady?.(true);
    this.#resolveRendererReady = null;
    return true;
  }

  prewarm(): void {
    try {
      this.ensureWindow();
    } catch {
      // A later activation retries window creation; helper registration stays healthy.
    }
  }

  async showPasteFailure(
    command: Extract<GlobalDictationRendererCommand, { type: "paste-failed" }>,
  ): Promise<boolean> {
    this.#recoveryVisible = false;
    return await this.#showWithCommand(command, true, this.#presentationGate.begin());
  }

  showRecovery(): void {
    this.#recoveryVisible = true;
    this.reposition();
    this.setInteractive(true);
  }

  async showAndStart(
    command: Extract<GlobalDictationRendererCommand, { type: "start" }>,
  ): Promise<boolean> {
    this.#recoveryVisible = false;
    return await this.#showWithCommand(command, false, this.#presentationGate.begin());
  }

  hide(): void {
    this.#presentationGate.invalidate();
    if (!this.#window || this.#window.isDestroyed()) return;
    this.#window.setIgnoreMouseEvents(true, { forward: false });
    this.#window.hide();
  }

  close(): void {
    this.#presentationGate.invalidate();
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    this.#window = null;
    this.#rendererReadyWebContentsId = null;
    this.#resolveRendererReady?.(false);
    this.#resolveRendererReady = null;
    this.#intentionalCloseWebContentsIds.add(window.webContents.id);
    window.close();
  }

  send(command: GlobalDictationRendererCommand): boolean {
    const window = this.#window;
    if (!window) return false;
    if (
      window.isDestroyed() ||
      window.webContents.isLoading() ||
      window.webContents.isDestroyed()
    ) {
      return false;
    }
    try {
      window.webContents.send(GLOBAL_DICTATION_COMMAND_CHANNEL, command);
    } catch {
      return false;
    }
    return true;
  }

  setInteractive(enabled: boolean): void {
    if (!this.#window || this.#window.isDestroyed()) return;
    if (!this.#window.isVisible()) {
      this.#window.setIgnoreMouseEvents(true, { forward: false });
      return;
    }
    if (enabled) {
      this.#window.setIgnoreMouseEvents(false);
      return;
    }
    this.#window.setIgnoreMouseEvents(true, { forward: true });
  }

  async #showWithCommand(
    command: GlobalDictationRendererCommand,
    pointerInteractive: boolean,
    presentationGeneration: number,
  ): Promise<boolean> {
    try {
      const window = this.ensureWindow();
      const webContentsId = window.webContents.id;
      const ready =
        this.#rendererReadyWebContentsId === webContentsId ? true : await this.#rendererReady;
      if (
        !ready ||
        !this.#presentationGate.isCurrent(presentationGeneration) ||
        !this.ownsWebContents(webContentsId)
      ) {
        return false;
      }
      this.reposition();
      window.setAlwaysOnTop(true, "floating");
      if (!this.send(command)) return false;
      window.showInactive();
      this.setInteractive(pointerInteractive);
      return true;
    } catch {
      return false;
    }
  }

  reposition(): void {
    if (!this.#window || this.#window.isDestroyed()) return;
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    this.#window.setBounds(
      resolveGlobalDictationBounds(display.workArea, this.#recoveryVisible),
      false,
    );
  }

  dispose(): void {
    this.#presentationGate.invalidate();
    const window = this.#window;
    this.#window = null;
    this.#rendererReadyWebContentsId = null;
    this.#resolveRendererReady?.(false);
    this.#resolveRendererReady = null;
    if (window && !window.isDestroyed()) {
      this.#intentionalCloseWebContentsIds.add(window.webContents.id);
    }
    window?.destroy();
    this.#intentionalCloseWebContentsIds.clear();
    this.#terminalListeners.clear();
  }
}
