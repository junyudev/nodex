import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { EventEmitter } from "node:events";
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Display,
  WebContents,
} from "electron";
import { it } from "@effect/vitest";
import { describe, expect, test, vi } from "vite-plus/test";
import type { WindowSessionRecord } from "../../shared/window-session";
import { resolveElectronWindowBackdrop } from "../electron-window-backdrop";
import type { WindowRuntimeService } from "./WindowRuntime";
import {
  ApplicationWindowShellRuntime,
  live,
  resolveApplicationWindowShellAppearance,
} from "./ApplicationWindowShellRuntime";

let nextWindowId = 1;

class FakeBrowserWindow extends EventEmitter {
  readonly id = nextWindowId++;
  private destroyed = false;
  readonly #webContents = Object.assign(new EventEmitter(), {
    id: this.id + 100,
    setWindowOpenHandler: () => undefined,
    isDestroyed: () => this.destroyed,
    getZoomFactor: () => this.zoomFactor,
  }) as unknown as WebContents;
  showCount = 0;
  zoomFactor = 1;
  windowButtonPosition: { x: number; y: number } | null = null;
  constructor(private readonly loadFailure: Error | null = null) {
    super();
  }

  get webContents(): WebContents {
    if (this.destroyed) throw new TypeError("Object has been destroyed");
    return this.#webContents;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit("closed");
  }

  focus(): void {}
  isDestroyed(): boolean {
    return this.destroyed;
  }
  loadURL(): Promise<void> {
    return this.loadFailure ? Promise.reject(this.loadFailure) : Promise.resolve();
  }
  maximize(): void {}
  setFullScreen(): void {}
  setWindowButtonPosition(position: { x: number; y: number }): void {
    this.windowButtonPosition = position;
  }
  setTitleBarOverlay(): void {}
  show(): void {
    this.showCount += 1;
  }
  showInactive(): void {
    this.showCount += 1;
  }
}

const session = (id: string, lastFocusedAt: number): WindowSessionRecord =>
  ({
    bounds: { height: 800, mode: "normal", width: 1_200, x: 40, y: 40 },
    id,
    lastFocusedAt,
  }) as unknown as WindowSessionRecord;

describe("ApplicationWindowShellRuntime", () => {
  test("constructs focused macOS shells as first-click native material windows", () => {
    const backdrop = resolveElectronWindowBackdrop({
      bounds: { width: 1_400, height: 900 },
      isFocused: true,
      platform: "darwin",
      prefersDarkColors: false,
      prefersReducedTransparency: false,
      scaleFactor: 2,
    });

    const appearance = resolveApplicationWindowShellAppearance("darwin", backdrop);
    expect(appearance).toMatchObject({
      acceptFirstMouse: true,
      backgroundColor: "#00000000",
      vibrancy: "menu",
    });
    expect(appearance).not.toHaveProperty("transparent");
  });

  test("keeps Reduce transparency opaque without changing window identity", () => {
    const backdrop = resolveElectronWindowBackdrop({
      bounds: { width: 1_400, height: 900 },
      isFocused: true,
      platform: "darwin",
      prefersDarkColors: true,
      prefersReducedTransparency: true,
      scaleFactor: 2,
    });

    expect(resolveApplicationWindowShellAppearance("darwin", backdrop)).toMatchObject({
      acceptFirstMouse: true,
      backgroundColor: "#000000",
      vibrancy: undefined,
    });
  });

  it.effect("opens restored renderer gates primary-first with concurrency one", () => {
    const sessions = [session("primary", 3), session("secondary", 2), session("tertiary", 1)];
    const windows = {
      attach: (_window: BrowserWindow, sessionId: string) =>
        sessions.find((candidate) => candidate.id === sessionId)!,
      markFocused: () => undefined,
      selectStartupSessions: () => sessions,
    } as unknown as WindowRuntimeService;

    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          live({
            createWindow: (_options: BrowserWindowConstructorOptions) =>
              new FakeBrowserWindow() as unknown as BrowserWindow,
            displays: {
              getAllDisplays: () => [
                {
                  bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
                  scaleFactor: 2,
                } as Display,
              ],
              getDisplayMatching: () => ({ scaleFactor: 2 }) as Display,
              getPrimaryDisplay: () => ({ scaleFactor: 2 }) as Display,
            },
            iconPath: "",
            platform: "darwin",
            preloadPath: "/tmp/nodex-preload.js",
            rendererUrl: "app://-/index.html",
            theme: { prefersReducedTransparency: false, shouldUseDarkColors: false },
            windows,
          }),
        );
        const shell = Context.get(context, ApplicationWindowShellRuntime);
        const opened = shell.openInitial("all");
        expect(opened).toHaveLength(3);
        const primary = opened[0] as unknown as FakeBrowserWindow;
        primary.zoomFactor = 1.5;
        primary.webContents.emit("did-finish-load");
        expect(primary.windowButtonPosition).toEqual({ x: 16, y: 26 });
        primary.zoomFactor = 1;
        primary.webContents.emit("did-finish-load");
        expect(primary.windowButtonPosition).toEqual({ x: 16, y: 15 });

        for (const lease of shell.claimPendingActivation()) {
          shell.completeActivation(lease.window.webContents.id);
        }
        yield* shell.awaitActivation(opened[0]!.webContents.id);

        const secondary = yield* shell
          .awaitActivation(opened[1]!.webContents.id)
          .pipe(Effect.forkScoped);
        expect(secondary.pollUnsafe()).toBeUndefined();

        shell.reportRenderer(opened[0]!.webContents.id);
        yield* Fiber.join(secondary);
        const tertiary = yield* shell
          .awaitActivation(opened[2]!.webContents.id)
          .pipe(Effect.forkScoped);
        expect(tertiary.pollUnsafe()).toBeUndefined();

        shell.reportRenderer(opened[1]!.webContents.id);
        yield* Fiber.join(tertiary);
        shell.reportRenderer(opened[2]!.webContents.id);

        const dynamicSession = session("dynamic", 4);
        sessions.push(dynamicSession);
        const dynamic = shell.create(dynamicSession);
        const [dynamicLease] = shell.claimPendingActivation();
        expect(dynamicLease?.window).toBe(dynamic);
        shell.completeActivation(dynamic.webContents.id);
        yield* shell.awaitActivation(dynamic.webContents.id);
      }),
    );
  });

  it.effect("clears pending watchdogs after Electron destroys the window object", () => {
    const sessions = [session("primary", 1)];
    const windows = {
      attach: (_window: BrowserWindow, sessionId: string) =>
        sessions.find((candidate) => candidate.id === sessionId)!,
      markFocused: () => undefined,
      selectStartupSessions: () => sessions,
    } as unknown as WindowRuntimeService;

    return Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          live({
            createWindow: (_options: BrowserWindowConstructorOptions) =>
              new FakeBrowserWindow() as unknown as BrowserWindow,
            displays: {
              getAllDisplays: () => [
                {
                  bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
                  scaleFactor: 2,
                } as Display,
              ],
              getDisplayMatching: () => ({ scaleFactor: 2 }) as Display,
              getPrimaryDisplay: () => ({ scaleFactor: 2 }) as Display,
            },
            iconPath: "",
            platform: "darwin",
            preloadPath: "/tmp/nodex-preload.js",
            rendererUrl: "app://-/index.html",
            theme: { prefersReducedTransparency: false, shouldUseDarkColors: false },
            windows,
          }),
        );
        const shell = Context.get(context, ApplicationWindowShellRuntime);
        const [opened] = shell.openInitial("all");
        if (!opened) throw new Error("Expected the initial window");

        expect(() => opened.destroy()).not.toThrow();
        yield* TestClock.adjust("2 seconds");
        expect(shell.claimPendingActivation()).toEqual([]);
      }),
    );
  });

  it.effect(
    "fails activation and requests native recovery when the renderer document fails",
    () => {
      const sessions = [session("primary", 1)];
      const loadFailure = new Error("renderer unavailable");
      const onRendererDocumentLoadFailure = vi.fn();
      const windows = {
        attach: (_window: BrowserWindow, sessionId: string) =>
          sessions.find((candidate) => candidate.id === sessionId)!,
        markFocused: () => undefined,
        selectStartupSessions: () => sessions,
      } as unknown as WindowRuntimeService;

      return Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            live({
              createWindow: (_options: BrowserWindowConstructorOptions) =>
                new FakeBrowserWindow(loadFailure) as unknown as BrowserWindow,
              displays: {
                getAllDisplays: () => [
                  {
                    bounds: { height: 1_080, width: 1_920, x: 0, y: 0 },
                    scaleFactor: 2,
                  } as Display,
                ],
                getDisplayMatching: () => ({ scaleFactor: 2 }) as Display,
                getPrimaryDisplay: () => ({ scaleFactor: 2 }) as Display,
              },
              iconPath: "",
              onRendererDocumentLoadFailure,
              platform: "darwin",
              preloadPath: "/tmp/nodex-preload.js",
              rendererUrl: "app://-/index.html",
              theme: { prefersReducedTransparency: false, shouldUseDarkColors: false },
              windows,
            }),
          );
          const shell = Context.get(context, ApplicationWindowShellRuntime);
          const [opened] = shell.openInitial("all");
          if (!opened) throw new Error("Expected the initial window");

          yield* Effect.yieldNow;
          const activation = yield* Effect.exit(shell.awaitActivation(opened.webContents.id));
          yield* TestClock.adjust("2 seconds");

          expect(Exit.isFailure(activation)).toBe(true);
          expect((opened as unknown as FakeBrowserWindow).showCount).toBe(0);
          expect(shell.claimPendingActivation()).toEqual([]);
          expect(onRendererDocumentLoadFailure).toHaveBeenCalledOnce();
          expect(onRendererDocumentLoadFailure).toHaveBeenCalledWith({
            cause: loadFailure,
          });
        }),
      );
    },
  );
});
