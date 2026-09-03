import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import {
  BrowserWindow,
  screen,
  systemPreferences,
  type BrowserWindowConstructorOptions,
  type Rectangle,
} from "electron";
import { APP_RENDERER_URL } from "../../shared/app-renderer-policy";
import {
  AVATAR_OVERLAY_COMMAND_CHANNEL,
  AVATAR_OVERLAY_ROUTE,
  type AvatarOverlayNativeLayoutState,
  type AvatarOverlayPlacement,
  type AvatarOverlayRendererCommand,
  type AvatarOverlayRendererEvent,
} from "../../shared/avatar-overlay";
import type {
  RemoteHostedPipHostLayout,
  RemoteHostedPipPoint,
  RemoteHostedPipViewportRect,
} from "../../shared/remote-hosted-pip";
import { resolveBundledElectronPreload } from "../electron-preload-path";
import type { WindowRuntimeService } from "../window-runtime/WindowRuntime";
import { WindowRuntime } from "../window-runtime/WindowRuntime";
import {
  buildAvatarOverlayHostLayout,
  clampAvatarOverlayAnchor,
  resolveAvatarOverlayAnchor,
  resolveAvatarOverlayLayout,
  resolveAvatarOverlayPlacement,
  resolveAvatarOverlayWindowBounds,
  shouldAnimateAvatarLayout,
} from "./avatar-overlay-layout";

interface AvatarInputShapeWindow extends BrowserWindow {
  setInputShape?: (
    regions: readonly {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    }[],
  ) => boolean;
}

const avatarInputShapeSupported = (): boolean =>
  (
    BrowserWindow as typeof BrowserWindow & { isInputShapeSupported?: () => boolean }
  ).isInputShapeSupported?.() === true;

const DEFAULT_NATIVE_LAYOUT_STATE: AvatarOverlayNativeLayoutState = {
  currentHostID: null,
  stackDisplayHeight: 0,
};

interface AvatarOverlayWindowFactory {
  readonly create: (options: BrowserWindowConstructorOptions) => BrowserWindow;
}

export interface AvatarOverlayRuntimeOptions {
  readonly preloadPath: string;
  readonly rendererUrl: string;
  readonly platform: NodeJS.Platform;
  readonly prefersReducedMotion?: () => boolean;
  readonly windows: WindowRuntimeService;
  readonly onHostLayout: (window: BrowserWindow, layout: RemoteHostedPipHostLayout | null) => void;
  readonly windowFactory?: AvatarOverlayWindowFactory;
}

export interface AvatarOverlayRuntimeService {
  readonly applyNativeLayoutState: (state: AvatarOverlayNativeLayoutState) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
  readonly handleRendererEvent: (
    webContentsId: number,
    event: AvatarOverlayRendererEvent,
  ) => Effect.Effect<boolean>;
  readonly hide: Effect.Effect<void>;
  readonly ownsWebContents: (webContentsId: number) => boolean;
  readonly setComputerUseCursor: (point: RemoteHostedPipPoint | null) => Effect.Effect<void>;
  readonly toggle: Effect.Effect<void>;
  readonly wake: Effect.Effect<void>;
}

export class AvatarOverlayRuntime extends Context.Service<
  AvatarOverlayRuntime,
  AvatarOverlayRuntimeService
>()("nodex/main/avatar/AvatarOverlayRuntime") {}

export function withAvatarOverlayRoute(rendererUrl: string): string {
  const url = new URL(rendererUrl);
  url.searchParams.set("initialRoute", AVATAR_OVERLAY_ROUTE);
  return url.toString();
}

export function createAvatarOverlayWindowOptions(
  preloadPath: string,
  platform: NodeJS.Platform,
): BrowserWindowConstructorOptions {
  return {
    acceptFirstMouse: true,
    focusable: false,
    frame: false,
    fullscreenable: false,
    hasShadow: false,
    height: 320,
    maximizable: false,
    minimizable: false,
    resizable: false,
    show: false,
    skipTaskbar: true,
    title: "Nodex Avatar",
    transparent: true,
    ...(platform === "darwin" ? { type: "panel" as const } : {}),
    webPreferences: {
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
    },
    width: 356,
  };
}

function finitePoint(point: RemoteHostedPipPoint | null): RemoteHostedPipPoint | null {
  if (point === null) return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  return { x: point.x, y: point.y };
}

function validRegions(
  regions: readonly RemoteHostedPipViewportRect[],
): RemoteHostedPipViewportRect[] {
  return regions
    .filter(
      (rect) =>
        Number.isFinite(rect.x) &&
        Number.isFinite(rect.y) &&
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height) &&
        rect.width > 0 &&
        rect.height > 0,
    )
    .slice(0, 64)
    .map((rect) => ({
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.ceil(rect.width),
      height: Math.ceil(rect.height),
    }));
}

/** Owns the non-restorable overlay window and all of its native/window listeners. */
class AvatarOverlayController {
  readonly #options: AvatarOverlayRuntimeOptions;
  #window: BrowserWindow | null = null;
  #unregisterAuxiliary: (() => void) | null = null;
  #rendererReady = false;
  #visibleIntent = false;
  #anchor: Rectangle | null = null;
  #placement: AvatarOverlayPlacement = "bottom-end";
  #nativeLayoutState = DEFAULT_NATIVE_LAYOUT_STATE;
  #computerUseCursor: RemoteHostedPipPoint | null = null;
  #pointerInteractive = false;
  #inputRegions: readonly RemoteHostedPipViewportRect[] = [];
  #dragOffset: RemoteHostedPipPoint | null = null;
  #hasPublishedHost = false;
  #lastHostAlignment: string | null = null;

  constructor(options: AvatarOverlayRuntimeOptions) {
    this.#options = options;
  }

  ownsWebContents(webContentsId: number): boolean {
    return this.#window?.isDestroyed() === false && this.#window.webContents.id === webContentsId;
  }

  wake(): void {
    this.#visibleIntent = true;
    const window = this.#ensureWindow();
    this.#applyLayout(window);
    this.#showIfReady(window);
  }

  toggle(): void {
    if (this.#visibleIntent && this.#window?.isVisible()) {
      this.hide();
      return;
    }
    this.wake();
  }

  hide(): void {
    this.#visibleIntent = false;
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    window.setIgnoreMouseEvents(true, { forward: false });
    window.hide();
    this.#unpublishHost(window);
  }

  close(): void {
    this.#visibleIntent = false;
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    this.#unpublishHost(window);
    window.close();
  }

  applyNativeLayoutState(state: AvatarOverlayNativeLayoutState): void {
    this.#nativeLayoutState = {
      currentHostID: state.currentHostID,
      stackDisplayHeight: Math.max(0, Math.round(state.stackDisplayHeight)),
    };
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    this.#send(window, { state: this.#nativeLayoutState, type: "native-layout-state-changed" });
    this.#applyLayout(window);
  }

  setComputerUseCursor(point: RemoteHostedPipPoint | null): void {
    this.#computerUseCursor = finitePoint(point);
    const window = this.#window;
    if (!window || window.isDestroyed()) return;
    this.#sendCursor(window);
    if (this.#computerUseCursor === null || this.#dragOffset !== null) return;
    this.#sendSyntheticCursor(window, this.#computerUseCursor);
  }

  handleRendererEvent(webContentsId: number, event: AvatarOverlayRendererEvent): boolean {
    const window = this.#window;
    if (!window || window.isDestroyed() || window.webContents.id !== webContentsId) return false;
    switch (event.type) {
      case "ready":
        this.#rendererReady = true;
        this.#applyLayout(window);
        this.#send(window, {
          state: this.#nativeLayoutState,
          type: "native-layout-state-changed",
        });
        this.#sendCursor(window);
        this.#showIfReady(window);
        return true;
      case "close":
        this.close();
        return true;
      case "hide":
        this.hide();
        return true;
      case "element-size-changed":
        this.#resizeMascot(event.mascot.width, event.mascot.height);
        this.#applyLayout(window);
        return true;
      case "pointer-regions-changed":
        this.#inputRegions = validRegions(event.regions);
        this.#applyPointerPolicy(window);
        return true;
      case "pointer-interaction-changed":
        this.#pointerInteractive = event.isInteractive;
        this.#applyPointerPolicy(window);
        return true;
      case "drag-start":
        this.#dragOffset = {
          x: event.pointerScreenX - this.#currentAnchor().x,
          y: event.pointerScreenY - this.#currentAnchor().y,
        };
        return true;
      case "drag-move":
        this.#moveDrag(window, event.pointerScreenX, event.pointerScreenY);
        return true;
      case "drag-end":
        this.#moveDrag(window, event.pointerScreenX, event.pointerScreenY);
        this.#dragOffset = null;
        this.#applyPointerPolicy(window);
        return true;
    }
  }

  dispose(): void {
    this.#visibleIntent = false;
    const window = this.#window;
    this.#window = null;
    if (window && !window.isDestroyed()) this.#unpublishHost(window);
    this.#unregisterAuxiliary?.();
    this.#unregisterAuxiliary = null;
    window?.destroy();
  }

  #ensureWindow(): BrowserWindow {
    if (this.#window && !this.#window.isDestroyed()) return this.#window;
    const factory = this.#options.windowFactory ?? {
      create: (options) => new BrowserWindow(options),
    };
    const window = factory.create(
      createAvatarOverlayWindowOptions(this.#options.preloadPath, this.#options.platform),
    );
    this.#window = window;
    this.#rendererReady = false;
    this.#pointerInteractive = false;
    this.#inputRegions = [];
    this.#dragOffset = null;
    this.#hasPublishedHost = false;
    this.#lastHostAlignment = null;
    this.#unregisterAuxiliary = this.#options.windows.registerAuxiliary(window, "avatar-overlay");

    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.setAlwaysOnTop(true, "floating");
    window.setMenuBarVisibility(false);
    window.setVisibleOnAllWorkspaces(true, {
      skipTransformProcessType: true,
      visibleOnFullScreen: true,
    });
    window.setIgnoreMouseEvents(true, { forward: false });

    const release = (): void => {
      if (this.#window !== window) return;
      this.#unpublishHost(window);
      this.#window = null;
      this.#rendererReady = false;
      this.#unregisterAuxiliary?.();
      this.#unregisterAuxiliary = null;
    };
    const releaseCrashedWindow = (): void => {
      release();
      if (!window.isDestroyed()) window.destroy();
    };
    window.once("closed", release);
    window.webContents.once("render-process-gone", releaseCrashedWindow);
    window.webContents.once("did-fail-load", releaseCrashedWindow);
    window.on("move", () => this.#publishHost(window));
    window.on("show", () => {
      this.#applyPointerPolicy(window);
      this.#publishHost(window);
    });
    window.on("hide", () => this.#unpublishHost(window));

    this.#applyLayout(window);
    void window.loadURL(withAvatarOverlayRoute(this.#options.rendererUrl)).catch(() => {
      if (!window.isDestroyed()) window.destroy();
    });
    return window;
  }

  #currentAnchor(): Rectangle {
    if (this.#anchor) return this.#anchor;
    const owner = this.#options.windows.getLastFocused();
    const display = owner
      ? screen.getDisplayMatching(owner.getBounds())
      : screen.getPrimaryDisplay();
    this.#anchor = resolveAvatarOverlayAnchor(display);
    return this.#anchor;
  }

  #prefersReducedMotion(): boolean {
    try {
      return (
        this.#options.prefersReducedMotion?.() ??
        systemPreferences.getAnimationSettings().prefersReducedMotion
      );
    } catch {
      return false;
    }
  }

  #resizeMascot(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    if (width < 80 || width > 224 || height < 80 || height > 260) return;
    const current = this.#anchor;
    if (!current) {
      this.#anchor = { x: 0, y: 0, width: Math.ceil(width), height: Math.ceil(height) };
      return;
    }
    this.#anchor = { ...current, width: Math.ceil(width), height: Math.ceil(height) };
  }

  #applyLayout(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    const currentAnchor = this.#currentAnchor();
    const display = screen.getDisplayNearestPoint({
      x: currentAnchor.x + currentAnchor.width / 2,
      y: currentAnchor.y + currentAnchor.height / 2,
    });
    const anchor = clampAvatarOverlayAnchor(currentAnchor, display);
    const bounds = resolveAvatarOverlayWindowBounds(display, anchor);
    this.#anchor = anchor;
    this.#placement = resolveAvatarOverlayPlacement(anchor, display);
    if (JSON.stringify(window.getContentBounds()) !== JSON.stringify(bounds)) {
      window.setContentBounds(
        bounds,
        shouldAnimateAvatarLayout(this.#hasPublishedHost, this.#prefersReducedMotion()),
      );
    }
    const layout = resolveAvatarOverlayLayout({
      anchor,
      placement: this.#placement,
      stackDisplayHeight:
        this.#nativeLayoutState.currentHostID === "avatar-overlay"
          ? this.#nativeLayoutState.stackDisplayHeight
          : 0,
      windowBounds: bounds,
    });
    this.#send(window, { isVisible: this.#visibleIntent, layout, type: "layout-changed" });
    this.#publishHost(window, layout);
    this.#sendCursor(window);
  }

  #publishHost(
    window: BrowserWindow,
    resolvedLayout?: ReturnType<typeof resolveAvatarOverlayLayout>,
  ): void {
    if (
      !this.#visibleIntent ||
      !this.#rendererReady ||
      window.isDestroyed() ||
      !window.isVisible()
    ) {
      this.#unpublishHost(window);
      return;
    }
    const bounds = window.getContentBounds();
    const anchor = this.#currentAnchor();
    const layout =
      resolvedLayout ??
      resolveAvatarOverlayLayout({
        anchor,
        placement: this.#placement,
        stackDisplayHeight:
          this.#nativeLayoutState.currentHostID === "avatar-overlay"
            ? this.#nativeLayoutState.stackDisplayHeight
            : 0,
        windowBounds: bounds,
      });
    const hostLayout = buildAvatarOverlayHostLayout(
      layout,
      shouldAnimateAvatarLayout(
        this.#hasPublishedHost && this.#lastHostAlignment !== layout.placement,
        this.#prefersReducedMotion(),
      ),
    );
    this.#options.onHostLayout(window, hostLayout);
    this.#lastHostAlignment = layout.placement;
    this.#hasPublishedHost = true;
  }

  #unpublishHost(window: BrowserWindow): void {
    if (!this.#hasPublishedHost) return;
    this.#hasPublishedHost = false;
    this.#lastHostAlignment = null;
    this.#options.onHostLayout(window, null);
  }

  #send(window: BrowserWindow, command: AvatarOverlayRendererCommand): void {
    if (!this.#rendererReady || window.webContents.isDestroyed() || window.webContents.isLoading())
      return;
    window.webContents.send(AVATAR_OVERLAY_COMMAND_CHANNEL, command);
  }

  #sendCursor(window: BrowserWindow): void {
    const bounds = window.getContentBounds();
    this.#send(window, {
      point:
        this.#computerUseCursor === null
          ? null
          : {
              x: this.#computerUseCursor.x - bounds.x,
              y: this.#computerUseCursor.y - bounds.y,
            },
      type: "computer-use-cursor-changed",
    });
  }

  #sendSyntheticCursor(window: BrowserWindow, point: RemoteHostedPipPoint): void {
    const bounds = window.getContentBounds();
    window.webContents.sendInputEvent({
      movementX: 0,
      movementY: 0,
      type: "mouseMove",
      x: point.x - bounds.x,
      y: point.y - bounds.y,
    });
  }

  #applyPointerPolicy(window: BrowserWindow): void {
    if (window.isDestroyed()) return;
    if (!window.isVisible()) {
      window.setIgnoreMouseEvents(true, { forward: false });
      return;
    }
    const inputShapeWindow = window as AvatarInputShapeWindow;
    if (
      avatarInputShapeSupported() &&
      inputShapeWindow.setInputShape &&
      this.#inputRegions.length > 0
    ) {
      window.setIgnoreMouseEvents(false);
      inputShapeWindow.setInputShape(
        this.#inputRegions.map((rect) => ({
          height: rect.height,
          width: rect.width,
          x: rect.x,
          y: rect.y,
        })),
      );
      return;
    }
    if (this.#pointerInteractive) {
      window.setIgnoreMouseEvents(false);
      return;
    }
    window.setIgnoreMouseEvents(true, { forward: true });
  }

  #moveDrag(window: BrowserWindow, screenX: number, screenY: number): void {
    if (!this.#dragOffset || !Number.isFinite(screenX) || !Number.isFinite(screenY)) return;
    const anchor = this.#currentAnchor();
    const candidate = {
      ...anchor,
      x: screenX - this.#dragOffset.x,
      y: screenY - this.#dragOffset.y,
    };
    const display = screen.getDisplayNearestPoint({ x: screenX, y: screenY });
    this.#anchor = clampAvatarOverlayAnchor(candidate, display);
    this.#applyLayout(window);
  }

  #showIfReady(window: BrowserWindow): void {
    if (!this.#visibleIntent || !this.#rendererReady || window.isDestroyed()) return;
    window.showInactive();
    this.#applyPointerPolicy(window);
    this.#publishHost(window);
  }
}

export function makeAvatarOverlayRuntime(
  options: AvatarOverlayRuntimeOptions,
): Effect.Effect<AvatarOverlayRuntimeService, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => new AvatarOverlayController(options)),
    (controller) => Effect.sync(() => controller.dispose()),
  ).pipe(
    Effect.map((controller) =>
      AvatarOverlayRuntime.of({
        applyNativeLayoutState: (state) =>
          Effect.sync(() => controller.applyNativeLayoutState(state)),
        close: Effect.sync(() => controller.close()),
        handleRendererEvent: (webContentsId, event) =>
          Effect.sync(() => controller.handleRendererEvent(webContentsId, event)),
        hide: Effect.sync(() => controller.hide()),
        ownsWebContents: (webContentsId) => controller.ownsWebContents(webContentsId),
        setComputerUseCursor: (point) => Effect.sync(() => controller.setComputerUseCursor(point)),
        toggle: Effect.sync(() => controller.toggle()),
        wake: Effect.sync(() => controller.wake()),
      }),
    ),
  );
}

export function live(
  options: Omit<AvatarOverlayRuntimeOptions, "preloadPath" | "rendererUrl" | "windows"> & {
    readonly preloadPath?: string;
    readonly rendererUrl?: string;
  },
): Layer.Layer<AvatarOverlayRuntime, never, WindowRuntime> {
  return Layer.effect(
    AvatarOverlayRuntime,
    Effect.gen(function* () {
      const windows = yield* WindowRuntime;
      return yield* makeAvatarOverlayRuntime({
        ...options,
        preloadPath:
          options.preloadPath ?? resolveBundledElectronPreload(__dirname, "avatar-overlay.js"),
        rendererUrl: options.rendererUrl ?? process.env.ELECTRON_RENDERER_URL ?? APP_RENDERER_URL,
        windows,
      });
    }),
  );
}
