import { BrowserWindow, screen, systemPreferences } from "electron";
import type { Display, Point, Rectangle } from "electron";
import {
  DEFAULT_MINI_ANCHOR,
  EMPTY_MINI_COVERAGE,
  MINI_PRESENTATION_CHANNEL,
  MINI_PREVIEWS_CHANNEL,
  MINI_ROUTE,
  NO_MINI_PREVIEWS,
  type MiniContentLayout,
  type MiniPreviews,
  type MiniCoverage,
  type MiniVisibility,
} from "../../shared/mini";
import type {
  RemoteHostedPipAnchorAlignment,
  RemoteHostedPipHostLayout,
} from "../../shared/remote-hosted-pip";
import { safeSendToWindow } from "../ipc-safe-send";
import { getLogger } from "../logging/logger";
import type { NativeMiniPanelBridge } from "../platform/electron/native-clipboard";
import type {
  MiniPlacement,
  MiniPlacementSettings,
} from "../settings/application-settings-persistence";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";
import {
  miniBounds,
  miniPreviewHostLayout,
  MINI_WINDOW_SIZE,
  nearestMiniAnchor,
} from "./mini-geometry";
import {
  initialMiniPresentation,
  transitionMiniPresentation,
  type MiniPresentationAction,
} from "./mini-presentation";

const logger = getLogger({ component: "mini" });

export class MiniWindowController {
  #window: BrowserWindow | null = null;
  #rendererReady = false;
  #contentLayout: MiniContentLayout | null = null;
  #lastPreviewHost: { alignment: RemoteHostedPipAnchorAlignment; geometry: string } | null = null;
  #previewChats = NO_MINI_PREVIEWS.chats;
  #disposed = false;
  #recreate: ReturnType<typeof setTimeout> | null = null;
  #state;
  #shownGeneration: number | null = null;
  #focusLifetime = 0;
  #displayId: number | null;
  #lastPlacement: MiniPlacementSettings;
  /** While a drag is in progress, the timer moving the panel after the pointer. */
  #drag: ReturnType<typeof setInterval> | null = null;
  #snapAnimation: ReturnType<typeof setInterval> | null = null;
  #blurHolds = new Map<symbol, number>();

  constructor(
    private readonly options: {
      readonly windows: WindowRuntimeService;
      readonly preloadPath: string;
      readonly rendererUrl: string;
      readonly native: NativeMiniPanelBridge | null;
      readonly miniFocusProbe: boolean;
      readonly visibility: MiniVisibility;
      readonly placement: MiniPlacementSettings;
      readonly onHostLayout: (
        webContentsId: number,
        layout: RemoteHostedPipHostLayout | null,
      ) => void;
      readonly savePlacement: (placement: MiniPlacement) => void;
    },
  ) {
    this.#state = initialMiniPresentation(options.visibility);
    this.#lastPlacement = options.placement;
    this.#displayId = options.placement.lastDisplayId;
  }

  start(): void {
    screen.on("display-added", this.#reposition);
    screen.on("display-removed", this.#reposition);
    screen.on("display-metrics-changed", this.#reposition);
    this.syncWorkbenchFocus();
  }

  syncWorkbenchFocus(): void {
    const workbenchFocused = this.options.windows.all().some((window) => window.isFocused());
    this.apply({ kind: "presence", update: { workbenchFocused } });
  }

  #ensureWindow(): void {
    if (this.#disposed || this.#window || this.#recreate) return;
    // When active, the renderer supplies the coverage that decides if Mini should rest.
    if (this.#state.visibility === "on-demand" && this.#state.event.kind === "hidden") return;
    const url = new URL(this.options.rendererUrl);
    url.searchParams.set("initialRoute", MINI_ROUTE);
    const mac = this.options.native !== null;
    const window = new BrowserWindow({
      ...MINI_WINDOW_SIZE,
      show: false,
      focusable: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      autoHideMenuBar: true,
      ...(mac ? { type: "panel", hiddenInMissionControl: true, acceptFirstMouse: true } : {}),
      webPreferences: {
        preload: this.options.preloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    this.#window = window;
    this.options.windows.registerAuxiliary(window, "mini");
    if (mac) {
      if (!this.options.native?.configureMiniPanel(window.getNativeWindowHandle())) {
        logger.warn("Mini could not prevent activation; clicks on it may bring Nodex forward");
      }
      window.excludedFromShownWindowsMenu = true;
      window.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    } else {
      window.removeMenu();
    }
    window.setAlwaysOnTop(true, "floating");
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    window.webContents.on("did-start-navigation", (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      const wasReady = this.#rendererReady;
      this.#rendererReady = false;
      this.reportLayout(null);
      if (wasReady) this.apply({ kind: "renderer-lost" });
    });
    window.on("move", () => this.#syncPreviewHost());
    window.on("blur", () => {
      if (this.#window !== window || this.#shownGeneration !== this.generation) return;
      this.syncWorkbenchFocus();
      this.apply({ kind: "blur", dialogOpen: this.#isHoldingBlur() });
    });
    window.webContents.once("render-process-gone", () => {
      if (!window.isDestroyed()) window.destroy();
    });
    window.once("closed", () => {
      if (this.#window !== window) return;
      this.#window = null;
      this.#rendererReady = false;
      this.#contentLayout = null;
      this.#lastPreviewHost = null;
      this.#blurHolds.clear();
      this.#shownGeneration = null;
      this.#cancelMove();
      if (!this.#disposed && this.#state.visibility !== "on-demand") {
        this.#recreate = setTimeout(() => {
          this.#recreate = null;
          this.#ensureWindow();
        }, 1000);
      }
      this.apply({ kind: "renderer-lost" });
    });
    void window.loadURL(url.toString()).catch((error: unknown) => {
      if (window.isDestroyed()) return;
      logger.warn("Could not load Mini", { error: String(error) });
      window.destroy();
    });
  }

  ready(): void {
    this.syncWorkbenchFocus();
    this.#rendererReady = true;
    if (this.#shownGeneration === this.generation) {
      this.#sendPresentation();
      this.#syncPreviewHost();
    } else {
      this.#present(this.#state.event.kind !== "hidden");
    }
    this.#sendPreviews();
  }

  reportLayout(layout: MiniContentLayout | null): void {
    this.#contentLayout = layout;
    this.#syncPreviewHost();
  }

  setPreviewChats(chats: MiniPreviews["chats"]): void {
    const entries = Object.entries(chats);
    if (
      entries.length === Object.keys(this.#previewChats).length &&
      entries.every(([id, visibility]) => this.#previewChats[id] === visibility)
    )
      return;
    this.#previewChats = chats;
    this.#sendPreviews();
  }

  /** A transfer can succeed directly when the shortcut already has an otherwise hidden Mini open. */
  setPreviewsDocked(docked: boolean): boolean {
    if (this.#state.previewsDocked === docked) return false;
    const extendPresence =
      docked &&
      this.#state.visibility === "on-demand" &&
      this.#state.event.kind === "focused" &&
      this.#window?.isVisible() === true;
    this.apply({
      kind: "presence",
      update: { previewsDocked: docked, ...(docked ? { previewDockRequested: false } : {}) },
    });
    this.#sendPreviews();
    return extendPresence;
  }

  #sendPreviews(): void {
    if (!this.#rendererReady) return;
    const previews: MiniPreviews = {
      chats: this.#previewChats,
      docked: this.#state.previewsDocked,
    };
    safeSendToWindow(this.#window, MINI_PREVIEWS_CHANNEL, [previews]);
  }

  #prefersReducedMotion(): boolean {
    try {
      return systemPreferences.getAnimationSettings().prefersReducedMotion;
    } catch {
      return false;
    }
  }

  #syncPreviewHost(): void {
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    const contentLayout = this.#contentLayout;
    if (
      !this.#rendererReady ||
      !contentLayout ||
      this.#state.event.kind === "hidden" ||
      !window.isVisible()
    ) {
      if (this.#lastPreviewHost) this.options.onHostLayout(window.webContents.id, null);
      this.#lastPreviewHost = null;
      return;
    }
    const layout = miniPreviewHostLayout(
      contentLayout,
      this.#state.anchor,
      this.#lastPreviewHost?.alignment,
      this.#prefersReducedMotion(),
    );
    const [anchor] = layout.anchors;
    const geometry = JSON.stringify([window.getContentBounds(), anchor, layout.anchorRect]);
    if (this.#lastPreviewHost?.geometry === geometry) return;
    this.options.onHostLayout(window.webContents.id, layout);
    this.#lastPreviewHost = { alignment: anchor.alignment, geometry };
  }

  get generation(): number {
    return this.#state.event.generation;
  }

  restingCoverage(): MiniCoverage {
    if (
      this.#state.event.kind !== "resting" ||
      this.#shownGeneration !== this.generation ||
      !this.#rendererReady ||
      !this.#window?.isVisible()
    )
      return EMPTY_MINI_COVERAGE;
    return this.#state.coverage;
  }

  apply(action: MiniPresentationAction): void {
    const previous = this.#state.event;
    this.#state = transitionMiniPresentation(this.#state, action);
    this.#ensureWindow();
    if (this.#state.event === previous) return;
    const next = this.#state.event.kind;
    if (next !== previous.kind && (next === "focused" || previous.kind === "focused")) {
      this.#focusLifetime += 1;
    }
    if (next === previous.kind) {
      if (this.#shownGeneration === previous.generation) this.#sendPresentation();
      this.#syncPreviewHost();
      return;
    }
    this.#present(previous.kind === "hidden");
  }

  pointer(overContent: boolean): void {
    const window = this.#window;
    if (!window || this.#state.event.kind === "hidden") return;
    if (overContent) window.setIgnoreMouseEvents(false);
    else window.setIgnoreMouseEvents(true, { forward: true });
  }

  #isHoldingBlur(): boolean {
    return [...this.#blurHolds.values()].includes(this.#focusLifetime);
  }

  /** Deliberate focus transfers preserve the current keyboard ownership until they settle. */
  #holdBlur(): () => void {
    const token = Symbol();
    this.#blurHolds.set(token, this.#focusLifetime);
    return () => {
      this.#blurHolds.delete(token);
    };
  }

  beginOpen(): (opened: boolean) => void {
    const focusLifetime = this.#focusLifetime;
    const release = this.#holdBlur();
    return (opened) => {
      release();
      if (focusLifetime !== this.#focusLifetime || this.#isHoldingBlur()) return;
      this.syncWorkbenchFocus();
      this.apply({
        kind: "open-settled",
        opened,
        hasKeyboard: this.#window?.isFocused() ?? false,
      });
    };
  }

  async withDialog<A>(senderId: number, open: () => Promise<A>): Promise<A> {
    const window = this.#window;
    if (!window || window.webContents.id !== senderId) return open();
    const focusLifetime = this.#focusLifetime;
    const release = this.#holdBlur();
    try {
      return await open();
    } finally {
      release();
      if (
        this.#window === window &&
        this.#state.event.kind === "focused" &&
        this.#focusLifetime === focusLifetime &&
        !this.#isHoldingBlur() &&
        !window.isFocused()
      ) {
        this.#makeKey(window);
      }
    }
  }

  #display(window: BrowserWindow): Display {
    const displays = screen.getAllDisplays();
    return (
      displays.find(({ id }) => id === this.#displayId) ??
      (window.isVisible()
        ? screen.getDisplayMatching(window.getBounds())
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint()))
    );
  }

  #place(window: BrowserWindow): void {
    const display = this.#display(window);
    this.#displayId = display.id;
    const { lastDisplayId, anchors } = this.#lastPlacement;
    const anchor =
      anchors[display.id] ??
      (lastDisplayId === null ? undefined : anchors[lastDisplayId]) ??
      DEFAULT_MINI_ANCHOR;
    window.setBounds(miniBounds(display.workArea, anchor));
    this.apply({ kind: "anchor", anchor });
  }

  #reposition = (): void => {
    const window = this.#window;
    if (!window || !window.isVisible()) return;
    this.#cancelMove();
    this.#place(window);
  };

  /**
   * The renderer saw the pointer leave a threshold while held on Mini: the panel follows the
   * pointer, holding it where it was grabbed, until the button comes up.
   */
  beginDrag(grabbed: Point): void {
    const window = this.#window;
    if (!window || !window.isVisible() || this.#state.event.kind === "hidden") return;
    this.#cancelMove();
    const bounds = window.getBounds();
    const offset = { x: grabbed.x - bounds.x, y: grabbed.y - bounds.y };
    this.#drag = setInterval(() => {
      if (this.#window !== window || window.isDestroyed()) return this.#cancelMove();
      // The renderer reports the release; a button already up ends a drag it could not report.
      if (this.options.native && !this.options.native.isPrimaryMouseDown()) return this.endDrag();
      const cursor = screen.getCursorScreenPoint();
      window.setPosition(cursor.x - offset.x, cursor.y - offset.y);
    }, 16);
  }

  /** The button came up: Mini settles at the placement nearest where it was dropped. */
  endDrag(): void {
    const window = this.#window;
    if (!this.#drag || !window || window.isDestroyed()) return this.#cancelMove();
    this.#cancelMove();
    const dropped = window.getBounds();
    const display = screen.getDisplayMatching(dropped);
    const current = this.#lastPlacement.anchors[display.id] ?? this.#state.anchor;
    const anchor = nearestMiniAnchor(display.workArea, dropped, current);
    this.#displayId = display.id;
    this.#lastPlacement = {
      lastDisplayId: display.id,
      anchors: { ...this.#lastPlacement.anchors, [display.id]: anchor },
    };
    this.#animateSnap(window, dropped, miniBounds(display.workArea, anchor));
    this.apply({ kind: "anchor", anchor });
    this.options.savePlacement({ displayId: display.id, anchor });
  }

  #animateSnap(window: BrowserWindow, from: Rectangle, to: Rectangle): void {
    if (from.x === to.x && from.y === to.y && from.width === to.width && from.height === to.height)
      return;
    if (this.#prefersReducedMotion()) {
      window.setBounds(to);
      return;
    }
    if (this.options.native) {
      window.setBounds(to, true);
      return;
    }
    // Electron's animate flag is macOS-only.
    const start = performance.now();
    this.#snapAnimation = setInterval(() => {
      const progress = Math.min(1, (performance.now() - start) / 150);
      const easeOut = 1 - (1 - progress) ** 3;
      window.setBounds({
        ...to,
        x: Math.round(from.x + (to.x - from.x) * easeOut),
        y: Math.round(from.y + (to.y - from.y) * easeOut),
      });
      if (progress === 1) this.#cancelSnapAnimation();
    }, 16);
  }

  #cancelSnapAnimation(): void {
    if (this.#snapAnimation) clearInterval(this.#snapAnimation);
    this.#snapAnimation = null;
  }

  #cancelMove(): void {
    if (this.#drag) clearInterval(this.#drag);
    this.#drag = null;
    this.#cancelSnapAnimation();
  }

  #makeKey(window: BrowserWindow): void {
    if (this.options.native) {
      if (!this.options.native.makeMiniPanelKey(window.getNativeWindowHandle())) {
        throw new Error("Mini could not take the keyboard");
      }
    } else {
      window.show();
      window.focus();
    }
  }

  #orderOut(window: BrowserWindow): void {
    if (!window.isVisible()) return;
    // Keep Electron's visibility state in sync with the independent AppKit key window.
    this.options.native?.orderMiniPanelOut(window.getNativeWindowHandle());
    window.hide();
  }

  #sendPresentation(): void {
    const event = this.#state.event;
    this.#shownGeneration = event.generation;
    if (this.#rendererReady) safeSendToWindow(this.#window, MINI_PRESENTATION_CHANNEL, [event]);
  }

  #present(revealing: boolean): void {
    const window = this.#window;
    if (!window) return;
    const { kind } = this.#state.event;
    if (kind === "hidden") {
      this.#cancelMove();
      this.#orderOut(window);
    } else {
      if (!this.#rendererReady) return;
      if (revealing || !window.isVisible()) {
        this.#place(window);
        this.pointer(false);
      }
      // Ordering out a key window returns the keyboard to the previously active app.
      if (kind === "resting") this.#orderOut(window);
      window.setFocusable(kind === "focused");
      // Electron changes Windows taskbar admission with focusability.
      if (!this.options.native) window.setSkipTaskbar(true);
      if (!window.isVisible()) window.showInactive();
      if (kind === "focused") {
        try {
          this.#makeKey(window);
        } catch (error) {
          logger.warn("Could not focus Mini", { error: String(error) });
          this.apply({ kind: "blur", dialogOpen: false });
          return;
        }
      }
    }
    if (this.options.miniFocusProbe) {
      logger.info("Mini presentation focus", {
        presentation: kind,
        generation: this.generation,
        keyWindow: window.isFocused(),
        visible: window.isVisible(),
      });
    }
    this.#sendPresentation();
    this.#syncPreviewHost();
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#recreate) clearTimeout(this.#recreate);
    this.#cancelMove();
    screen.off("display-added", this.#reposition);
    screen.off("display-removed", this.#reposition);
    screen.off("display-metrics-changed", this.#reposition);
    this.#window?.destroy();
  }
}
