import { EventEmitter } from "node:events";
import { screen } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GlobalDictationWindowController } from "./global-dictation-window-controller";

vi.mock("electron", async (importOriginal) => {
  const original = await importOriginal<typeof import("electron")>();
  const { EventEmitter } = await import("node:events");
  let nextId = 0;
  class Window extends EventEmitter {
    destroyed = false;
    visible = false;
    webContents = Object.assign(new EventEmitter(), {
      id: ++nextId,
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => this.destroyed,
      isLoading: () => false,
      send: vi.fn(),
    });
    setAlwaysOnTop = vi.fn();
    setIgnoreMouseEvents = vi.fn();
    setVisibleOnAllWorkspaces = vi.fn();
    setBounds = vi.fn();
    loadURL = vi.fn(async () => undefined);
    isDestroyed = () => this.destroyed;
    isVisible = () => this.visible;
    showInactive = vi.fn(() => {
      this.visible = true;
    });
    hide = vi.fn(() => {
      this.visible = false;
    });
    destroy = (): void => {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    };
    close = this.destroy;
  }
  return {
    ...original,
    BrowserWindow: Window,
    screen: Object.assign(new EventEmitter(), {
      getCursorScreenPoint: () => ({ x: 100, y: 100 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 20, width: 1920, height: 1080 } }),
    }),
  };
});

const controllers: GlobalDictationWindowController[] = [];
const createController = (): GlobalDictationWindowController => {
  const controller = new GlobalDictationWindowController({
    preloadPath: "/isolated/global-dictation.js",
    rendererUrl: "app://-/index.html",
  });
  controllers.push(controller);
  return controller;
};
const start = {
  type: "start" as const,
  sessionId: "session",
  requestId: "request",
  deadlineAtMs: Number.MAX_SAFE_INTEGER,
  gesture: "hold" as const,
};

describe("GlobalDictationWindowController native lifecycle", () => {
  afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose();
  });

  it("keeps a cancelled startup hidden even when the renderer becomes ready later", async () => {
    const controller = createController();
    const window = controller.ensureWindow();
    const showing = controller.showAndStart(start);
    controller.hide();
    controller.markRendererReady(window.webContents.id);
    expect(await showing).toBe(false);
    expect(window.showInactive).not.toHaveBeenCalled();
    expect(window.webContents.send).not.toHaveBeenCalled();
  });

  it("expands recovery and follows visible display changes without retaining screen listeners", async () => {
    const controller = createController();
    const window = controller.ensureWindow();
    const displays = screen as unknown as EventEmitter;
    controller.markRendererReady(window.webContents.id);
    expect(await controller.showAndStart(start)).toBe(true);
    controller.showRecovery();
    expect(window.setBounds).toHaveBeenLastCalledWith(
      { x: 600, y: 904, width: 720, height: 180 },
      false,
    );
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    vi.mocked(window.setBounds).mockClear();
    displays.emit("display-metrics-changed");
    expect(window.setBounds).toHaveBeenCalledOnce();
    controller.hide();
    vi.mocked(window.setBounds).mockClear();
    displays.emit("display-removed");
    expect(window.setBounds).not.toHaveBeenCalled();
    controller.close();
    for (const event of ["display-added", "display-removed", "display-metrics-changed"]) {
      expect(displays.listenerCount(event)).toBe(0);
    }
  });

  it("presents paste recovery without taking focus and resets the expanded recording surface", async () => {
    const controller = createController();
    const window = controller.ensureWindow();
    controller.markRendererReady(window.webContents.id);
    await controller.showAndStart(start);
    controller.showRecovery();
    controller.hide();
    const failure = {
      type: "paste-failed" as const,
      sessionId: "session",
      error: {
        kind: "accessibility-denied" as const,
        operation: "paste" as const,
        retryable: true,
      },
      failure: { text: "hello ", copied: true, reason: "accessibility" as const },
    };
    expect(await controller.showPasteFailure(failure)).toBe(true);
    expect(window.setBounds).toHaveBeenLastCalledWith(
      { x: 600, y: 1000, width: 720, height: 84 },
      false,
    );
    expect(window.webContents.send).toHaveBeenLastCalledWith("global-dictation:command", failure);
    expect(window.showInactive).toHaveBeenCalledTimes(2);
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  });

  it("releases pending presentation and screen observers when the renderer crashes", async () => {
    const controller = createController();
    const window = controller.ensureWindow();
    const terminal = vi.fn();
    controller.subscribeTerminal(terminal);
    const showing = controller.showAndStart(start);
    (window.webContents as unknown as EventEmitter).emit("render-process-gone");
    expect(await showing).toBe(false);
    expect(terminal).toHaveBeenCalledExactlyOnceWith(window.webContents.id, "unexpected");
    expect(controller.ownsWebContents(window.webContents.id)).toBe(false);
    expect((screen as unknown as EventEmitter).listenerCount("display-added")).toBe(0);
  });
});
