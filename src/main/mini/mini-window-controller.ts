import { BrowserWindow, screen, systemPreferences } from "electron";
import type { Display } from "electron";
import {
  EMPTY_MINI_COVERAGE,
  MINI_PRESENTATION_CHANNEL,
  MINI_PREVIEWS_CHANNEL,
  MINI_ROUTE,
  NO_MINI_PREVIEWS,
  miniDockWidth,
  type MiniPoint,
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
  clampMiniDock,
  miniAnchorForDock,
  miniDockAtAnchor,
  miniPreviewHostLayout,
  miniRelativeDock,
  miniWindowBounds,
  snapMiniDock,
} from "./mini-geometry";
import {
  initialMiniPresentation,
  transitionMiniPresentation,
  type MiniPresentationAction,
} from "./mini-presentation";

const logger = getLogger({ component: "mini" });
const dragFrameMs = 16;
// Give the renderer's pointerup time to carry Option before falling back to a free drop.
const releaseGraceMs = 64;

interface MiniDragState {
  readonly timer: ReturnType<typeof setInterval>;
  readonly offset: MiniPoint;
  release: { readonly point: MiniPoint; readonly time: number } | null;
}

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
  #screenDock: MiniPoint | null = null;
  #dockWidth = miniDockWidth(false);
  #drag: MiniDragState | null = null;
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
  }

  #ensureWindow(): void {
    if (this.#disposed || this.#window || this.#recreate) return;
    // When active, the renderer supplies the coverage that decides if Mini should rest.
    if (this.#state.visibility === "on-demand" && this.#state.event.kind === "hidden") return;
    const url = new URL(this.options.rendererUrl);
    url.searchParams.set("initialRoute", MINI_ROUTE);
    const mac = this.options.native !== null;
    const display = this.#display();
    const window = new BrowserWindow({
      ...miniWindowBounds(display, this.#restoredDock(display)),
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
      this.#cancelDrag();
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
    this.#rendererReady = true;
    if (this.#shownGeneration === this.generation) {
      this.#sendPresentation();
      this.#syncPreviewHost();
    } else {
      this.#present(this.#state.event.kind !== "hidden");
    }
    this.#sendPreviews();
  }

  reportLayout(layout: MiniContentLayout | null, dockWidth = this.#dockWidth): void {
    const window = this.#window;
    if (layout && window && !window.isDestroyed()) {
      const { width, height } = window.getContentBounds();
      if (
        [layout.content, layout.base].some(
          (rect) => rect.x + rect.width > width || rect.y + rect.height > height,
        )
      )
        return;
    }
    this.#contentLayout = layout;
    if (dockWidth !== this.#dockWidth) {
      this.#dockWidth = dockWidth;
      if (window?.isVisible() && this.#screenDock) {
        this.#moveDock(window, this.#display(), this.#screenDock);
      }
    }
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
      this.#state.geometry.anchor,
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

  apply(action: Exclude<MiniPresentationAction, { kind: "geometry" }>): void {
    const previous = this.#state.event.kind;
    this.#state = transitionMiniPresentation(this.#state, action);
    this.#ensureWindow();
    const next = this.#state.event.kind;
    if (next === previous) return;
    if (next === "focused" || previous === "focused") this.#focusLifetime += 1;
    this.#present(previous === "hidden");
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

  #display(): Display {
    return (
      screen.getAllDisplays().find(({ id }) => id === this.#displayId) ??
      screen.getDisplayNearestPoint(
        this.#screenDock ? roundPoint(this.#screenDock) : screen.getCursorScreenPoint(),
      )
    );
  }

  #restoredDock({ id, workArea }: Display): MiniPoint {
    const { lastDisplayId, docks } = this.#lastPlacement;
    const saved = docks[id] ?? (lastDisplayId === null ? undefined : docks[lastDisplayId]);
    return saved
      ? clampMiniDock(
          workArea,
          { x: workArea.x + saved.x, y: workArea.y + saved.y },
          this.#dockWidth,
        )
      : miniDockAtAnchor(workArea, this.#dockWidth);
  }

  #place(window: BrowserWindow): void {
    const display = this.#display();
    this.#position(window, display, this.#restoredDock(display));
  }

  #position(window: BrowserWindow, display: Display, dock: MiniPoint): void {
    this.#displayId = display.id;
    this.#screenDock = dock;
    const bounds = miniWindowBounds(display, dock);
    const current = window.getBounds();
    if (
      bounds.x !== current.x ||
      bounds.y !== current.y ||
      bounds.width !== current.width ||
      bounds.height !== current.height
    )
      window.setBounds(bounds);
    this.#state = transitionMiniPresentation(this.#state, {
      kind: "geometry",
      geometry: {
        anchor: miniAnchorForDock(display.workArea, dock),
        dock: miniRelativeDock(dock, window.getContentBounds()),
      },
    });
  }

  #moveDock(window: BrowserWindow, display: Display, dock: MiniPoint): void {
    const previous = this.#state.event;
    this.#position(window, display, clampMiniDock(display.workArea, dock, this.#dockWidth));
    if (this.#state.event !== previous) this.#sendPresentation();
    this.#syncPreviewHost();
  }

  #reposition = (): void => {
    const window = this.#window;
    if (!window || !window.isVisible()) return;
    if (this.#drag) {
      this.#followDrag(window, this.#drag.release?.point ?? screen.getCursorScreenPoint());
      return;
    }
    const display = this.#display();
    this.#moveDock(window, display, this.#restoredDock(display));
  };

  /** Keep the point that was grabbed under the pointer as the dock moves. */
  beginDrag(grabbed: MiniPoint): void {
    const window = this.#window;
    if (!window || !window.isVisible() || this.#state.event.kind === "hidden" || !this.#screenDock)
      return;
    this.#cancelDrag();
    const offset = miniRelativeDock(grabbed, this.#screenDock);
    const timer = setInterval(() => {
      const drag = this.#drag;
      if (!drag || this.#window !== window || window.isDestroyed()) return this.#cancelDrag();
      if (drag.release) {
        if (performance.now() - drag.release.time >= releaseGraceMs) this.endDrag();
        return;
      }
      const point = screen.getCursorScreenPoint();
      this.#followDrag(window, point);
      // A release outside the surface may never reach the renderer.
      if (this.options.native && !this.options.native.isPrimaryMouseDown()) {
        drag.release = { point, time: performance.now() };
      }
    }, dragFrameMs);
    this.#drag = { offset, timer, release: null };
    this.#followDrag(window, screen.getCursorScreenPoint());
  }

  #followDrag(window: BrowserWindow, cursor: MiniPoint, snap = false): void {
    if (!this.#drag) return;
    const dock = miniRelativeDock(cursor, this.#drag.offset);
    const display = screen.getDisplayNearestPoint(roundPoint(dock));
    this.#moveDock(
      window,
      display,
      snap ? snapMiniDock(display.workArea, dock, this.#dockWidth) : dock,
    );
  }

  /** Store the final position in the current display's work-area coordinates. */
  endDrag(snap = false): void {
    const window = this.#window;
    const drag = this.#drag;
    if (!drag || !window || window.isDestroyed()) return this.#cancelDrag();
    this.#followDrag(window, drag.release?.point ?? screen.getCursorScreenPoint(), snap);
    this.#cancelDrag();
    if (!this.#screenDock) return;
    const { id, workArea } = this.#display();
    const dock = miniRelativeDock(this.#screenDock, workArea);
    this.#lastPlacement = {
      lastDisplayId: id,
      docks: { ...this.#lastPlacement.docks, [id]: dock },
    };
    this.options.savePlacement({ displayId: id, dock });
  }

  #cancelDrag(): void {
    if (this.#drag) clearInterval(this.#drag.timer);
    this.#drag = null;
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
      this.#cancelDrag();
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
    this.#cancelDrag();
    screen.off("display-added", this.#reposition);
    screen.off("display-removed", this.#reposition);
    screen.off("display-metrics-changed", this.#reposition);
    this.#window?.destroy();
  }
}

function roundPoint({ x, y }: MiniPoint): MiniPoint {
  return { x: Math.round(x), y: Math.round(y) };
}
