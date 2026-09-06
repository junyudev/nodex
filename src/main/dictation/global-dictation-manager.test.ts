import type { BrowserWindow } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  createCommandKeymapState,
  createKeyboardLayoutSnapshot,
  type MacNativeHotkeySpec,
} from "../../shared/command-keybindings";
import { ClipboardSafePasteError } from "./clipboard-safe-paste-service";
import { GlobalDictationManager } from "./global-dictation-manager";
import type { GlobalDictationWindowTerminalReason } from "./global-dictation-window-controller";
import {
  MacDictationHelperRequestError,
  type MacDictationHelperEvent,
} from "./mac-dictation-native-helper-client";

const macKeymap = () =>
  createCommandKeymapState(
    { globalDictationHold: ["Fn"], globalDictationToggle: ["Command+Shift+D"] },
    "macOS",
  );

const createFixture = (
  focusedWindow: BrowserWindow | null = null,
  options: {
    readonly keepVisiblePreference?: boolean | null;
    readonly ownershipAvailable?: boolean;
  } = {},
) => {
  let helperListener: ((event: MacDictationHelperEvent) => void) | null = null;
  let terminalListener:
    | ((webContentsId: number, reason: GlobalDictationWindowTerminalReason) => void)
    | null = null;
  const helper = {
    subscribe: vi.fn((listener: (event: MacDictationHelperEvent) => void) => {
      helperListener = listener;
      return () => {
        helperListener = null;
      };
    }),
    replaceBindings: vi.fn(
      async (_request: {
        readonly generation: number;
        readonly bindings: readonly MacNativeHotkeySpec[];
      }): Promise<void> => undefined,
    ),
    captureFn: vi.fn(async () => "Fn" as const),
    queryBuiltInMicrophoneName: vi.fn(async () => null),
    capabilities: vi.fn(async () => ({ inputMonitoring: true, accessibility: true })),
    requestInputMonitoring: vi.fn(async () => true),
    requestAccessibility: vi.fn(async () => true),
  };
  const commands: unknown[] = [];
  const overlayWindow = { webContents: { id: 99 } } as BrowserWindow;
  const windowController = {
    ensureWindow: vi.fn(() => overlayWindow),
    ownsWebContents: (id: number) => id === 99,
    close: vi.fn(),
    hide: vi.fn(),
    markRendererReady: vi.fn((id: number) => id === 99),
    prewarm: vi.fn(),
    send: vi.fn((command: unknown) => {
      commands.push(command);
      return true;
    }),
    showAndStart: vi.fn(async (command: unknown) => {
      commands.push(command);
      return true;
    }),
    showIdle: vi.fn(async (command: unknown) => {
      commands.push(command);
      return true;
    }),
    setInteractive: vi.fn(),
    subscribeTerminal: vi.fn(
      (listener: (webContentsId: number, reason: GlobalDictationWindowTerminalReason) => void) => {
        terminalListener = listener;
        return () => {
          terminalListener = null;
        };
      },
    ),
  };
  const paste = vi.fn(async () => ({ clipboardRestoreMs: 710 }));
  const readSettings = vi.fn(async () => ({
    microphoneInputDeviceId: null,
    keepGlobalBarVisible: false,
    playStartSound: true,
    playStopSound: true,
    globalShortcutNudgeDismissed: false,
    dictionary: [],
  }));
  const onRecoveryNeeded = vi.fn();
  const writeKeepVisiblePreference = vi.fn(async (_value: boolean) => undefined);
  let ownershipLost: (() => void) | null = null;
  const ownership = {
    dispose: vi.fn(),
    isOwner: vi.fn(() => true),
  };
  const acquireOwnership = vi.fn((onLost: () => void) => {
    ownershipLost = onLost;
    return options.ownershipAvailable === false ? null : ownership;
  });
  const manager = new GlobalDictationManager({
    helper,
    windowController,
    pasteService: { paste },
    readSettings,
    readKeepVisiblePreference: async () =>
      options.keepVisiblePreference === undefined ? false : options.keepVisiblePreference,
    writeKeepVisiblePreference,
    acquireOwnership,
    getFocusedAppWindow: () => focusedWindow,
    getAppWindowByWebContentsId: (id) =>
      focusedWindow?.webContents.id === id ? focusedWindow : null,
    onRecoveryNeeded,
    platform: "darwin",
  });
  return {
    commands,
    emit: (event: MacDictationHelperEvent) => helperListener?.(event),
    emitWindowTerminal: (
      webContentsId: number,
      reason: GlobalDictationWindowTerminalReason = "unexpected",
    ) => terminalListener?.(webContentsId, reason),
    helper,
    manager,
    onRecoveryNeeded,
    emitOwnershipLost: () => ownershipLost?.(),
    ownership,
    paste,
    writeKeepVisiblePreference,
    windowController,
  };
};

const activate = async (fixture: ReturnType<typeof createFixture>): Promise<void> => {
  await fixture.manager.initialize(macKeymap());
  await fixture.manager.setEnabled(true);
};

const hotkeyEvent = (
  type: "pressed" | "released",
  bindingId: "global-dictation-hold" | "global-dictation-toggle",
  mode: "hold" | "toggle",
  sequence: number,
  target = { pid: 7, bundleIdentifier: "example.app" },
): MacDictationHelperEvent => ({
  type,
  bindingId,
  mode,
  configurationGeneration: 1,
  processGeneration: 1,
  sequence,
  target,
});

describe("GlobalDictationManager", () => {
  it("shows and hides the persistent idle reminder as the setting changes", async () => {
    const fixture = createFixture();
    await activate(fixture);

    fixture.manager.syncSettings({
      microphoneInputDeviceId: null,
      keepGlobalBarVisible: true,
      playStartSound: true,
      playStopSound: true,
      globalShortcutNudgeDismissed: false,
      dictionary: [],
    });

    expect(fixture.windowController.showIdle).toHaveBeenCalledWith({
      type: "idle",
      configuredHotkey: "Fn",
      configuredToggleHotkey: "Command+Shift+D",
    });

    fixture.manager.syncSettings({
      microphoneInputDeviceId: null,
      keepGlobalBarVisible: false,
      playStartSound: true,
      playStopSound: true,
      globalShortcutNudgeDismissed: false,
      dictionary: [],
    });
    expect(fixture.windowController.prewarm).toHaveBeenCalled();
    expect(fixture.windowController.hide).toHaveBeenCalled();
  });

  it("derives first-run visibility from configured shortcuts", async () => {
    const fixture = createFixture(null, { keepVisiblePreference: null });
    await activate(fixture);

    expect(fixture.windowController.showIdle).toHaveBeenCalledWith({
      type: "idle",
      configuredHotkey: "Fn",
      configuredToggleHotkey: "Command+Shift+D",
    });
  });

  it("turns the idle reminder on for the first shortcut and off with the last", async () => {
    const fixture = createFixture();
    const emptyKeymap = createCommandKeymapState({}, "macOS");
    await fixture.manager.initialize(emptyKeymap);
    await fixture.manager.setEnabled(true);

    await fixture.manager.syncCommandKeymap(macKeymap());
    expect(fixture.writeKeepVisiblePreference).toHaveBeenLastCalledWith(true);
    expect(fixture.windowController.showIdle).toHaveBeenCalled();

    await fixture.manager.syncCommandKeymap(emptyKeymap);
    expect(fixture.writeKeepVisiblePreference).toHaveBeenLastCalledWith(false);
    expect(fixture.windowController.close).toHaveBeenCalled();
  });

  it("recovers the persistent idle reminder after its renderer terminates", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.manager.syncSettings({
      microphoneInputDeviceId: null,
      keepGlobalBarVisible: true,
      playStartSound: true,
      playStopSound: true,
      globalShortcutNudgeDismissed: false,
      dictionary: [],
    });
    fixture.windowController.showIdle.mockClear();

    fixture.emitWindowTerminal(99);

    expect(fixture.windowController.showIdle).toHaveBeenCalledWith({
      type: "idle",
      configuredHotkey: "Fn",
      configuredToggleHotkey: "Command+Shift+D",
    });
  });

  it("does not reopen a helper that the user intentionally closed", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.manager.syncSettings({
      microphoneInputDeviceId: null,
      keepGlobalBarVisible: true,
      playStartSound: true,
      playStopSound: true,
      globalShortcutNudgeDismissed: false,
      dictionary: [],
    });
    fixture.windowController.showIdle.mockClear();

    fixture.emitWindowTerminal(99, "intentional");

    expect(fixture.windowController.showIdle).not.toHaveBeenCalled();
  });

  it("rejects native activation when another Profile owns global dictation", async () => {
    const fixture = createFixture(null, { ownershipAvailable: false });
    await fixture.manager.initialize(macKeymap());

    await expect(fixture.manager.setEnabled(true)).rejects.toThrow(
      "Global dictation is already active in another Nodex instance.",
    );
    expect(fixture.helper.replaceBindings).not.toHaveBeenCalled();
  });

  it("tears down native bindings if machine-wide ownership is lost", async () => {
    const fixture = createFixture();
    await activate(fixture);

    fixture.emitOwnershipLost();

    await vi.waitFor(() =>
      expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith({
        generation: 2,
        bindings: [],
      }),
    );
    expect(fixture.manager.isAvailable()).toBe(false);
    expect(fixture.windowController.close).toHaveBeenCalled();
  });

  it("accepts close only from the owned helper renderer", async () => {
    const fixture = createFixture();
    await activate(fixture);

    expect(fixture.manager.handleRendererEvent(55, { type: "close", sessionId: null })).toBe(false);
    expect(fixture.manager.handleRendererEvent(99, { type: "close", sessionId: null })).toBe(true);
    expect(fixture.windowController.close).toHaveBeenCalled();
  });

  it("does not let an idle close message cancel a newly active session", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 1));

    expect(fixture.manager.handleRendererEvent(99, { type: "close", sessionId: null })).toBe(false);
    expect(fixture.manager.getSnapshot().kind).toBe("overlay-starting");
  });

  it("atomically applies the complete native binding set and routes an overlay hold session", async () => {
    const fixture = createFixture();
    await activate(fixture);
    expect(fixture.helper.replaceBindings).toHaveBeenCalledWith({
      generation: 1,
      bindings: expect.arrayContaining([
        expect.objectContaining({ bindingId: "global-dictation-hold", keyCode: null }),
        expect.objectContaining({ bindingId: "global-dictation-toggle", keyCode: 2 }),
      ]),
    });

    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "overlay-starting") throw new Error("Expected overlay session");
    fixture.manager.handleRendererEvent(99, { type: "ready" });
    const start = fixture.commands.find(
      (command): command is { sessionId: string; requestId: string; type: "start" } =>
        (command as { type?: unknown }).type === "start",
    );
    if (!start) throw new Error("Expected overlay start");
    fixture.manager.handleRendererEvent(99, {
      type: "accepted",
      sessionId: snapshot.sessionId,
      requestId: start.requestId,
      targetId: "global-overlay",
    });
    fixture.emit(hotkeyEvent("released", "global-dictation-hold", "hold", 2));
    expect(fixture.commands).toContainEqual({ type: "stop", sessionId: snapshot.sessionId });

    fixture.manager.handleRendererEvent(99, {
      type: "completed",
      sessionId: snapshot.sessionId,
      transcript: "hello",
    });
    await vi.waitFor(() => expect(fixture.manager.getSnapshot().kind).toBe("idle"));
    expect(fixture.commands).toContainEqual({
      type: "paste-completed",
      sessionId: snapshot.sessionId,
      clipboardRestoreMs: 710,
    });
    expect(fixture.paste).toHaveBeenCalledWith("hello", {
      pid: 7,
      bundleIdentifier: "example.app",
    });
  });

  it("accepts only the correlated focused-composer acknowledgement", async () => {
    const sent: unknown[] = [];
    const focusedWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 41,
        isDestroyed: () => false,
        send: (_channel: string, command: unknown) => sent.push(command),
      },
    } as unknown as BrowserWindow;
    const fixture = createFixture(focusedWindow);
    await activate(fixture);
    fixture.emit(
      hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 1, {
        pid: process.pid,
        bundleIdentifier: "app.jyu.nodex",
      }),
    );
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "routing-in-app") throw new Error("Expected in-app route");
    const start = sent[0] as { requestId: string };
    expect(
      fixture.manager.handleRendererEvent(41, {
        type: "accepted",
        sessionId: snapshot.sessionId,
        requestId: "00000000-0000-4000-8000-000000000000",
        targetId: "stale",
      }),
    ).toBe(false);
    expect(
      fixture.manager.handleRendererEvent(41, {
        type: "accepted",
        sessionId: snapshot.sessionId,
        requestId: start.requestId,
        targetId: "composer:active",
      }),
    ).toBe(true);
    fixture.manager.handleRendererEvent(41, {
      type: "completed",
      sessionId: snapshot.sessionId,
      transcript: "inserted by composer",
    });
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    expect(fixture.paste).not.toHaveBeenCalled();
  });

  it("falls back immediately when the focused renderer declines admission", async () => {
    const sent: unknown[] = [];
    const focusedWindow = {
      isDestroyed: () => false,
      webContents: {
        id: 41,
        isDestroyed: () => false,
        send: (_channel: string, command: unknown) => sent.push(command),
      },
    } as unknown as BrowserWindow;
    const fixture = createFixture(focusedWindow);
    await activate(fixture);
    fixture.emit(
      hotkeyEvent("pressed", "global-dictation-hold", "hold", 1, {
        pid: process.pid,
        bundleIdentifier: "app.jyu.nodex",
      }),
    );
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "routing-in-app") throw new Error("Expected in-app route");
    const requestId = (sent[0] as { requestId: string }).requestId;
    expect(
      fixture.manager.handleRendererEvent(41, {
        type: "declined",
        sessionId: snapshot.sessionId,
        requestId,
        reason: "hidden",
      }),
    ).toBe(true);
    expect(fixture.manager.getSnapshot().kind).toBe("overlay-starting");
    expect(fixture.windowController.showAndStart).toHaveBeenCalled();
  });

  it("keeps the prior native set active when a replacement is rejected", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.helper.replaceBindings.mockRejectedValueOnce(
      new MacDictationHelperRequestError("hotkey-conflict"),
    );

    await expect(
      fixture.manager.syncCommandKeymap(
        createCommandKeymapState({ globalDictationHold: ["Alt+Y"] }, "macOS"),
      ),
    ).resolves.toMatchObject({ kind: "conflict" });
    expect(fixture.manager.isAvailable()).toBe(true);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
    expect(fixture.manager.getSnapshot().kind).toBe("overlay-starting");
  });

  it("returns a typed degraded result when transport fails and wakes recovery", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.helper.replaceBindings.mockRejectedValueOnce(new Error("broken pipe"));

    await expect(
      fixture.manager.syncCommandKeymap(
        createCommandKeymapState({ globalDictationHold: ["Alt+Y"] }, "macOS"),
      ),
    ).resolves.toEqual({
      kind: "runtime-degraded",
      message: "Global dictation is recovering. Try the shortcut again in a moment.",
    });
    expect(fixture.manager.isAvailable()).toBe(false);
    expect(fixture.onRecoveryNeeded).toHaveBeenCalledOnce();
  });

  it("serializes keymap and layout replacements into unique native generations", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.helper.replaceBindings.mockClear();
    const releases: Array<() => void> = [];
    fixture.helper.replaceBindings.mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );

    const keymapUpdate = fixture.manager.syncCommandKeymap(
      createCommandKeymapState({ globalDictationHold: ["Alt+Y"] }, "macOS"),
    );
    await vi.waitFor(() => expect(fixture.helper.replaceBindings).toHaveBeenCalledTimes(1));
    const layoutUpdate = fixture.manager.updateKeyboardLayout(
      createKeyboardLayoutSnapshot(1, { KeyY: "y" }),
    );
    expect(fixture.helper.replaceBindings).toHaveBeenCalledTimes(1);

    releases[0]?.();
    await keymapUpdate;
    await vi.waitFor(() => expect(fixture.helper.replaceBindings).toHaveBeenCalledTimes(2));
    releases[1]?.();
    await layoutUpdate;

    expect(
      fixture.helper.replaceBindings.mock.calls.map(([request]) => request.generation),
    ).toEqual([2, 3]);
  });

  it("accepts a fresh renderer layout even when its local generation is lower", async () => {
    const fixture = createFixture();
    await activate(fixture);

    await expect(
      fixture.manager.updateKeyboardLayout(createKeyboardLayoutSnapshot(20, { KeyY: "f" })),
    ).resolves.toBe(true);
    await expect(
      fixture.manager.updateKeyboardLayout(createKeyboardLayoutSnapshot(1, { KeyY: "y" })),
    ).resolves.toBe(true);
    expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 3 }),
    );
  });

  it("keeps a durable rollback as the recovery target when its immediate apply loses transport", async () => {
    const fixture = createFixture();
    await activate(fixture);
    await fixture.manager.syncCommandKeymap(
      createCommandKeymapState({ globalDictationHold: ["Alt+Y"] }, "macOS"),
    );
    fixture.helper.replaceBindings.mockRejectedValueOnce(new Error("broken pipe"));

    await expect(fixture.manager.restoreCommandKeymap(macKeymap())).rejects.toThrow("broken pipe");
    fixture.helper.replaceBindings.mockResolvedValueOnce(undefined);
    await fixture.manager.recover();

    expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith({
      generation: 3,
      bindings: expect.arrayContaining([
        expect.objectContaining({ bindingId: "global-dictation-hold", keyCode: null }),
        expect.objectContaining({ bindingId: "global-dictation-toggle", keyCode: 2 }),
      ]),
    });
  });

  it("cancels an active hold session before adopting a new binding generation", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
    const active = fixture.manager.getSnapshot();
    if (active.kind !== "overlay-starting") throw new Error("Expected active overlay");

    await fixture.manager.syncCommandKeymap(
      createCommandKeymapState({ globalDictationHold: ["Alt+Y"] }, "macOS"),
    );

    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    expect(fixture.commands).toContainEqual({ type: "cancel", sessionId: active.sessionId });
  });

  it("does not enqueue duplicate wakes while a supervised recovery attempt is failing", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.emit({
      type: "crashed",
      processGeneration: 1,
      exitCode: 9,
      signal: null,
      diagnostic: "event tap terminated",
    });
    fixture.helper.replaceBindings.mockRejectedValueOnce(new Error("still unavailable"));

    await expect(fixture.manager.recover()).rejects.toThrow("still unavailable");
    expect(fixture.onRecoveryNeeded).toHaveBeenCalledOnce();
  });

  it("recovers the desired complete set after a helper crash", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
    const active = fixture.manager.getSnapshot();
    if (active.kind !== "overlay-starting") throw new Error("Expected active overlay");
    fixture.emit({
      type: "crashed",
      processGeneration: 1,
      exitCode: 9,
      signal: null,
      diagnostic: "event tap terminated",
    });
    expect(fixture.manager.isAvailable()).toBe(false);
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    expect(fixture.commands).toContainEqual({ type: "cancel", sessionId: active.sessionId });
    expect(fixture.onRecoveryNeeded).toHaveBeenCalledOnce();

    await fixture.manager.recover();

    expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith(
      expect.objectContaining({ generation: 2, bindings: expect.any(Array) }),
    );
    expect(fixture.manager.isAvailable()).toBe(true);
  });

  it("keeps a failed Accessibility paste retryable without losing the transcript", async () => {
    const fixture = createFixture();
    fixture.paste.mockRejectedValueOnce(new ClipboardSafePasteError("accessibility-denied"));
    await activate(fixture);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 1));
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "overlay-starting") throw new Error("Expected overlay session");
    fixture.manager.handleRendererEvent(99, { type: "ready" });
    const start = fixture.commands.find(
      (command): command is { requestId: string; type: "start" } =>
        (command as { type?: unknown }).type === "start",
    );
    if (!start) throw new Error("Expected start command");
    fixture.manager.handleRendererEvent(99, {
      type: "accepted",
      sessionId: snapshot.sessionId,
      requestId: start.requestId,
      targetId: "global-overlay",
    });
    fixture.manager.handleRendererEvent(99, {
      type: "completed",
      sessionId: snapshot.sessionId,
      transcript: "retained text",
    });
    await vi.waitFor(() =>
      expect(fixture.manager.getSnapshot()).toMatchObject({
        kind: "retryable-error",
        error: { kind: "accessibility-denied" },
      }),
    );
    fixture.manager.handleRendererEvent(99, {
      type: "completed",
      sessionId: snapshot.sessionId,
      transcript: "retained text",
    });
    await vi.waitFor(() => expect(fixture.manager.getSnapshot().kind).toBe("idle"));
    expect(fixture.paste).toHaveBeenLastCalledWith("retained text", {
      pid: 7,
      bundleIdentifier: "example.app",
    });
  });
});
