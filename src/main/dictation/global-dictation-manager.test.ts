import type { BrowserWindow } from "electron";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compileMacNativeHotkey,
  createCommandKeymapState,
  createKeyboardLayoutSnapshot,
  type MacNativeHotkeySpec,
} from "../../shared/command-keybindings";
import type { GlobalDictationPasteFailure } from "../../shared/global-dictation";
import { GlobalDictationManager } from "./global-dictation-manager";
import type { GlobalDictationWindowTerminalReason } from "./global-dictation-window-controller";
import {
  MacDictationHelperRequestError,
  type MacDictationHelperEvent,
} from "./mac-dictation-native-helper-client";

const fixtures: GlobalDictationManager[] = [];

const macKeymap = () =>
  createCommandKeymapState(
    { globalDictationHold: ["Fn"], globalDictationToggle: ["Command+Shift+D"] },
    "macOS",
  );

const createFixture = (
  focusedWindow: BrowserWindow | null = null,
  options: {
    readonly ownershipAvailable?: boolean;
    readonly platform?: NodeJS.Platform;
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
    captureBareModifier: vi.fn(async (_signal?: AbortSignal): Promise<string> => "Fn"),
    queryBuiltInMicrophoneName: vi.fn(async () => null),
    capabilities: vi.fn(async () => ({ inputMonitoring: true, accessibility: true })),
    requestInputMonitoring: vi.fn(async () => true),
    requestAccessibility: vi.fn(async () => true),
    setEscapeEnabled: vi.fn(async (_enabled: boolean) => undefined),
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
    showPasteFailure: vi.fn(async (command: unknown) => {
      commands.push(command);
      return true;
    }),
    setInteractive: vi.fn(),
    showRecovery: vi.fn(),
    subscribeTerminal: vi.fn(
      (listener: (webContentsId: number, reason: GlobalDictationWindowTerminalReason) => void) => {
        terminalListener = listener;
        return () => {
          terminalListener = null;
        };
      },
    ),
  };
  const paste = vi.fn(
    async (
      _text: string,
      _target: unknown,
      _options?: { signal?: AbortSignal },
    ): Promise<{ clipboardRestoreMs: number; failure?: GlobalDictationPasteFailure }> => ({
      clipboardRestoreMs: 710,
    }),
  );
  const captureClipboardFingerprint = vi.fn(async () => "clipboard-at-stop");
  const copy = vi.fn(async (_text: string) => undefined);
  const openAccessibilitySettings = vi.fn(async () => undefined);
  const openRecording = vi.fn(async (_recordingId: string) => undefined);
  const onRecoveryNeeded = vi.fn();
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
    compileHotkey: compileMacNativeHotkey,
    isBareHotkey: (binding) => binding.keyCode === null,
    windowController,
    pasteService: { paste, copy, captureClipboardFingerprint },
    openAccessibilitySettings,
    openRecording,
    acquireOwnership,
    getFocusedAppWindow: () => focusedWindow,
    getAppWindowByWebContentsId: (id) =>
      focusedWindow?.webContents.id === id ? focusedWindow : null,
    onRecoveryNeeded,
    platform: options.platform ?? "darwin",
  });
  fixtures.push(manager);
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
    copy,
    captureClipboardFingerprint,
    openAccessibilitySettings,
    openRecording,
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
): Extract<MacDictationHelperEvent, { readonly bindingId: string }> => ({
  type,
  bindingId,
  mode,
  configurationGeneration: 1,
  processGeneration: 1,
  sequence,
  target,
});

const doubleTap = (
  fixture: ReturnType<typeof createFixture>,
  target = { pid: 7, bundleIdentifier: "example.app" },
): void => {
  for (const [index, type] of (["pressed", "released", "pressed", "released"] as const).entries()) {
    fixture.emit(hotkeyEvent(type, "global-dictation-toggle", "toggle", index + 1, target));
  }
};

describe("GlobalDictationManager", () => {
  afterEach(() => {
    for (const manager of fixtures.splice(0)) manager.dispose();
    vi.useRealTimers();
  });

  it("prewarms the helper without showing it, and closes it when the final shortcut is removed", async () => {
    const fixture = createFixture();
    await activate(fixture);
    expect(fixture.windowController.prewarm).toHaveBeenCalled();
    expect(fixture.windowController.hide).toHaveBeenCalled();
    expect(fixture.windowController.showAndStart).not.toHaveBeenCalled();
    await fixture.manager.syncCommandKeymap(createCommandKeymapState({}, "macOS"));
    expect(fixture.windowController.close).toHaveBeenCalled();
  });

  it("requests native permissions only when the user configures a changed nonempty shortcut", async () => {
    const fixture = createFixture();
    await activate(fixture);
    await fixture.manager.recover();
    await fixture.manager.syncCommandKeymap(macKeymap());
    expect(fixture.helper.requestInputMonitoring).not.toHaveBeenCalled();
    expect(fixture.helper.requestAccessibility).not.toHaveBeenCalled();

    await fixture.manager.syncCommandKeymap(
      createCommandKeymapState({ globalDictationHold: ["Alt+Y"] }, "macOS"),
    );
    expect(fixture.helper.requestInputMonitoring).toHaveBeenCalledOnce();
    expect(fixture.helper.requestAccessibility).toHaveBeenCalledOnce();
    expect(fixture.helper.requestInputMonitoring.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.helper.requestAccessibility.mock.invocationCallOrder[0]!,
    );

    await fixture.manager.syncCommandKeymap(createCommandKeymapState({}, "macOS"));
    expect(fixture.helper.requestInputMonitoring).toHaveBeenCalledOnce();
    expect(fixture.helper.requestAccessibility).toHaveBeenCalledOnce();
  });

  it("suspends global shortcuts during local capture and restores them before returning", async () => {
    const fixture = createFixture();
    await activate(fixture);
    let finish!: (value: string) => void;
    const capture = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = fixture.manager.captureBareModifierHotkey(controller.signal, capture, true);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith({
      generation: 2,
      bindings: [],
    });
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
    expect(fixture.windowController.showAndStart).not.toHaveBeenCalled();
    expect(fixture.ownership.dispose).not.toHaveBeenCalled();
    finish("Ctrl+Alt");
    await expect(pending).resolves.toBe("Ctrl+Alt");
    expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith({
      generation: 3,
      bindings: expect.arrayContaining([
        expect.objectContaining({ bindingId: "global-dictation-hold" }),
      ]),
    });
    expect(fixture.helper.requestInputMonitoring).not.toHaveBeenCalled();
  });

  it("restores shortcuts after local capture aborts", async () => {
    const fixture = createFixture();
    await activate(fixture);
    const controller = new AbortController();
    const capture = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
            once: true,
          });
        }),
    );
    const pending = fixture.manager.captureBareModifierHotkey(controller.signal, capture, true);
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith({
      generation: 3,
      bindings: expect.arrayContaining([
        expect.objectContaining({ bindingId: "global-dictation-hold" }),
      ]),
    });
  });

  it.each([
    { platform: "win32" as const, allowsBareModifiers: true },
    { platform: "win32" as const, allowsBareModifiers: false },
    { platform: "darwin" as const, allowsBareModifiers: false },
  ])(
    "keeps $platform bindings suspended for capture without native bare polling ($allowsBareModifiers)",
    async ({ platform, allowsBareModifiers }) => {
      const fixture = createFixture(null, { platform });
      await activate(fixture);
      const controller = new AbortController();
      const localCapture = vi.fn(async () => "Fn");
      const pending = fixture.manager.captureBareModifierHotkey(
        controller.signal,
        localCapture,
        allowsBareModifiers,
      );
      await vi.waitFor(() =>
        expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith({
          generation: 2,
          bindings: [],
        }),
      );
      expect(localCapture).not.toHaveBeenCalled();
      fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
      expect(fixture.windowController.showAndStart).not.toHaveBeenCalled();
      expect(fixture.helper.replaceBindings).toHaveBeenCalledTimes(2);
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith({
        generation: 3,
        bindings: expect.arrayContaining([
          expect.objectContaining({ bindingId: "global-dictation-hold" }),
        ]),
      });
    },
  );

  it("keeps a recording active when an unrelated command shortcut changes", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
    const active = fixture.manager.getSnapshot();
    fixture.helper.replaceBindings.mockClear();
    await fixture.manager.syncCommandKeymap(
      createCommandKeymapState(
        {
          globalDictationHold: ["Fn"],
          globalDictationToggle: ["Command+Shift+D"],
          newThread: ["Command+Alt+N"],
        },
        "macOS",
      ),
    );
    expect(fixture.helper.replaceBindings).not.toHaveBeenCalled();
    expect(fixture.manager.getSnapshot()).toEqual(active);
    expect(fixture.helper.requestInputMonitoring).not.toHaveBeenCalled();
  });

  it("rewarms an unexpected renderer loss but respects an intentional close", async () => {
    const fixture = createFixture();
    await activate(fixture);
    fixture.windowController.prewarm.mockClear();
    fixture.emitWindowTerminal(99);
    expect(fixture.windowController.prewarm).toHaveBeenCalledOnce();
    fixture.windowController.prewarm.mockClear();
    fixture.emitWindowTerminal(99, "intentional");
    expect(fixture.windowController.prewarm).not.toHaveBeenCalled();
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
    doubleTap(fixture);

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
    expect(fixture.paste).toHaveBeenCalledWith(
      "hello",
      {
        pid: 7,
        bundleIdentifier: "example.app",
      },
      expect.objectContaining({
        clipboardFingerprint: "clipboard-at-stop",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("accepts only the correlated focused-composer acknowledgement", async () => {
    const sent: unknown[] = [];
    const focusedWindow = {
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), {
        id: 41,
        isDestroyed: () => false,
        send: (_channel: string, command: unknown) => sent.push(command),
      }),
    } as unknown as BrowserWindow;
    const fixture = createFixture(focusedWindow);
    await activate(fixture);
    doubleTap(fixture, { pid: process.pid, bundleIdentifier: "app.jyu.nodex" });
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
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const focusedWindow = {
      isDestroyed: () => false,
      webContents: Object.assign(new EventEmitter(), {
        id: 41,
        isDestroyed: () => false,
        send: (_channel: string, command: unknown) => sent.push(command),
      }),
    } as unknown as BrowserWindow;
    const fixture = createFixture(focusedWindow);
    await activate(fixture);
    fixture.emit(
      hotkeyEvent("pressed", "global-dictation-hold", "hold", 1, {
        pid: process.pid,
        bundleIdentifier: "app.jyu.nodex",
      }),
    );
    await vi.advanceTimersByTimeAsync(250);
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

  it("retains paste failure for manual copy and scopes recovery actions to its owner", async () => {
    const fixture = createFixture();
    const failure = { text: "retained text ", copied: false, reason: "accessibility" as const };
    fixture.paste.mockResolvedValueOnce({ clipboardRestoreMs: 0, failure });
    await activate(fixture);
    doubleTap(fixture);
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "overlay-starting") throw new Error("Expected overlay session");
    fixture.manager.handleRendererEvent(99, {
      type: "completed",
      sessionId: snapshot.sessionId,
      transcript: "retained text",
    });
    await vi.waitFor(() =>
      expect(fixture.windowController.showPasteFailure).toHaveBeenCalledWith({
        type: "paste-failed",
        sessionId: snapshot.sessionId,
        failure,
        error: { kind: "accessibility-denied", operation: "paste", retryable: true },
      }),
    );
    expect(
      fixture.manager.handleRendererEvent(55, {
        type: "copy-transcript",
        sessionId: snapshot.sessionId,
      }),
    ).toBe(false);
    expect(
      fixture.manager.handleRendererEvent(55, {
        type: "open-accessibility-settings",
        sessionId: snapshot.sessionId,
      }),
    ).toBe(false);
    expect(fixture.copy).not.toHaveBeenCalled();
    expect(fixture.openAccessibilitySettings).not.toHaveBeenCalled();
    fixture.manager.handleRendererEvent(99, {
      type: "open-accessibility-settings",
      sessionId: snapshot.sessionId,
    });
    expect(fixture.openAccessibilitySettings).toHaveBeenCalledOnce();
    fixture.manager.handleRendererEvent(99, {
      type: "copy-transcript",
      sessionId: snapshot.sessionId,
    });
    await vi.waitFor(() =>
      expect(fixture.windowController.showPasteFailure).toHaveBeenLastCalledWith(
        expect.objectContaining({ failure: { ...failure, copied: true } }),
      ),
    );
    expect(fixture.copy).toHaveBeenCalledWith("retained text ");
    fixture.manager.handleRendererEvent(99, { type: "dismiss", sessionId: snapshot.sessionId });
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    expect(fixture.windowController.hide).toHaveBeenCalled();
  });

  it("requires two short toggle taps within 400ms and ignores a repeated press", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    await activate(fixture);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 1));
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 2));
    fixture.emit(hotkeyEvent("released", "global-dictation-toggle", "toggle", 3));
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    await vi.advanceTimersByTimeAsync(401);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 4));
    fixture.emit(hotkeyEvent("released", "global-dictation-toggle", "toggle", 5));
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    await vi.advanceTimersByTimeAsync(400);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 6));
    fixture.emit(hotkeyEvent("released", "global-dictation-toggle", "toggle", 7));
    expect(fixture.manager.getSnapshot().kind).toBe("overlay-starting");
  });

  it("does not count a 250ms toggle press as a tap", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    await activate(fixture);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 1));
    await vi.advanceTimersByTimeAsync(250);
    fixture.emit(hotkeyEvent("released", "global-dictation-toggle", "toggle", 2));
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 3));
    fixture.emit(hotkeyEvent("released", "global-dictation-toggle", "toggle", 4));
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
  });

  it("uses one shared binding for a delayed hold or double tap", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    await fixture.manager.initialize(
      createCommandKeymapState(
        { globalDictationHold: ["Fn"], globalDictationToggle: ["Fn"] },
        "macOS",
      ),
    );
    await fixture.manager.setEnabled(true);
    expect(fixture.helper.replaceBindings).toHaveBeenLastCalledWith({
      generation: 1,
      bindings: [expect.objectContaining({ mode: "hold" })],
    });
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
    const activatedAt = Date.now();
    await vi.advanceTimersByTimeAsync(249);
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    await vi.advanceTimersByTimeAsync(1);
    expect(fixture.windowController.showAndStart).toHaveBeenCalledWith(
      expect.objectContaining({ gesture: "hold", activationStartedAtMs: activatedAt }),
    );
    fixture.emit({ type: "escape", processGeneration: 1, sequence: 100 });
    fixture.emit(hotkeyEvent("released", "global-dictation-hold", "hold", 2));
    for (const [index, type] of (["pressed", "released", "pressed", "released"] as const).entries())
      fixture.emit(hotkeyEvent(type, "global-dictation-hold", "hold", index + 3));
    expect(fixture.windowController.showAndStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ gesture: "toggle" }),
    );
  });

  it("cancels pending activation on Escape and on modifier chord cancellation", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    await fixture.manager.initialize(
      createCommandKeymapState(
        { globalDictationHold: ["Fn"], globalDictationToggle: ["Fn"] },
        "macOS",
      ),
    );
    await fixture.manager.setEnabled(true);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
    expect(fixture.helper.setEscapeEnabled).toHaveBeenLastCalledWith(true);
    fixture.emit({ type: "escape", processGeneration: 1, sequence: 100 });
    await vi.advanceTimersByTimeAsync(250);
    expect(fixture.windowController.showAndStart).not.toHaveBeenCalled();
    fixture.emit(hotkeyEvent("released", "global-dictation-hold", "hold", 2));
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 3));
    fixture.emit({
      ...hotkeyEvent("pressed", "global-dictation-hold", "hold", 4),
      type: "cancelled",
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(fixture.windowController.showAndStart).not.toHaveBeenCalled();
    expect(fixture.helper.setEscapeEnabled).toHaveBeenLastCalledWith(false);
  });

  it("ignores hold release during toggle recording and toggle presses during hold recording", async () => {
    const fixture = createFixture();
    await activate(fixture);
    doubleTap(fixture);
    await Promise.resolve();
    fixture.commands.length = 0;
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 5));
    fixture.emit(hotkeyEvent("released", "global-dictation-hold", "hold", 6));
    expect(fixture.commands).toEqual([]);
    fixture.emit({ type: "escape", processGeneration: 1, sequence: 100 });
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 7));
    await Promise.resolve();
    fixture.commands.length = 0;
    doubleTap(fixture);
    expect(fixture.commands).toEqual([]);
  });

  it("cancels a hold released while the overlay is still starting", async () => {
    const fixture = createFixture();
    let show!: (value: boolean) => void;
    fixture.windowController.showAndStart.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          show = resolve;
        }),
    );
    await activate(fixture);
    fixture.emit(hotkeyEvent("pressed", "global-dictation-hold", "hold", 1));
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "overlay-starting") throw new Error("Expected pending overlay");
    fixture.emit(hotkeyEvent("released", "global-dictation-hold", "hold", 2));
    show(true);
    await Promise.resolve();
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    expect(fixture.commands).toContainEqual({ type: "cancel", sessionId: snapshot.sessionId });
    expect(fixture.commands).not.toContainEqual({ type: "stop", sessionId: snapshot.sessionId });
  });

  it("fences the clipboard once at stop and records the renderer stop time", async () => {
    vi.useFakeTimers();
    const fixture = createFixture();
    await activate(fixture);
    doubleTap(fixture);
    await Promise.resolve();
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "overlay-starting") throw new Error("Expected overlay");
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 5));
    fixture.emit(hotkeyEvent("released", "global-dictation-toggle", "toggle", 6));
    fixture.emit(hotkeyEvent("pressed", "global-dictation-toggle", "toggle", 7));
    const stoppedAt = Date.now();
    fixture.manager.handleRendererEvent(99, {
      type: "recording-stopped",
      sessionId: snapshot.sessionId,
    });
    expect(fixture.captureClipboardFingerprint).toHaveBeenCalledOnce();
    expect(
      fixture.commands.filter((command) => (command as { type: string }).type === "stop"),
    ).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(500);
    fixture.manager.handleRendererEvent(99, {
      type: "completed",
      sessionId: snapshot.sessionId,
      transcript: "hello",
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.paste).toHaveBeenCalledWith(
      "hello",
      expect.anything(),
      expect.objectContaining({
        clipboardFingerprint: "clipboard-at-stop",
        recordingStoppedAtMs: stoppedAt,
      }),
    );
  });

  it("cancels a pending paste before a new session and ignores its late failure", async () => {
    const fixture = createFixture();
    let settle!: (value: {
      clipboardRestoreMs: number;
      failure?: GlobalDictationPasteFailure;
    }) => void;
    fixture.paste.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    await activate(fixture);
    doubleTap(fixture);
    const first = fixture.manager.getSnapshot();
    if (first.kind !== "overlay-starting") throw new Error("Expected overlay");
    fixture.manager.handleRendererEvent(99, {
      type: "completed",
      sessionId: first.sessionId,
      transcript: "old",
    });
    await vi.waitFor(() => expect(fixture.paste).toHaveBeenCalledOnce());
    const signal = fixture.paste.mock.calls[0]?.[2]?.signal;
    doubleTap(fixture);
    const next = fixture.manager.getSnapshot();
    expect(next.kind).toBe("overlay-starting");
    expect(signal?.aborted).toBe(true);
    settle({ clipboardRestoreMs: 0, failure: { text: "old ", copied: false, reason: "paste" } });
    await Promise.resolve();
    expect(fixture.manager.getSnapshot()).toEqual(next);
    expect(fixture.windowController.showPasteFailure).not.toHaveBeenCalled();
  });

  it("hides successful empty completions without attempting paste", async () => {
    const fixture = createFixture();
    await activate(fixture);
    doubleTap(fixture);
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "overlay-starting") throw new Error("Expected overlay");
    fixture.manager.handleRendererEvent(99, {
      type: "completed",
      sessionId: snapshot.sessionId,
      transcript: "  ",
    });
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    expect(fixture.paste).not.toHaveBeenCalled();
  });

  it("expands transcription recovery but closes acquisition failures", async () => {
    const fixture = createFixture();
    await activate(fixture);
    doubleTap(fixture);
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "overlay-starting") throw new Error("Expected overlay");
    fixture.manager.handleRendererEvent(99, {
      type: "failed",
      sessionId: snapshot.sessionId,
      error: { kind: "transcription-network", operation: "transcribe", retryable: true },
    });
    expect(fixture.windowController.showRecovery).toHaveBeenCalledOnce();
    expect(fixture.manager.getSnapshot().kind).toBe("retryable-error");
    fixture.manager.handleRendererEvent(99, {
      type: "failed",
      sessionId: snapshot.sessionId,
      error: { kind: "microphone-permission-denied", operation: "permission", retryable: false },
    });
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
  });

  it("cancels a Composer route when its document navigates and detaches lifecycle observers", async () => {
    const contents = Object.assign(new EventEmitter(), {
      id: 41,
      isDestroyed: () => false,
      send: vi.fn(),
    });
    const window = { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow;
    const fixture = createFixture(window);
    await activate(fixture);
    doubleTap(fixture, { pid: process.pid, bundleIdentifier: "nodex" });
    expect(fixture.manager.getSnapshot().kind).toBe("routing-in-app");
    contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    expect(fixture.manager.getSnapshot().kind).toBe("routing-in-app");
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(fixture.manager.getSnapshot().kind).toBe("idle");
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
    expect(contents.listenerCount("destroyed")).toBe(0);
    expect(contents.listenerCount("render-process-gone")).toBe(0);
  });
  it("authorizes saved recording and recovered text actions only for the current failed overlay", async () => {
    const fixture = createFixture();
    await activate(fixture);
    doubleTap(fixture);
    const snapshot = fixture.manager.getSnapshot();
    if (snapshot.kind !== "overlay-starting") throw new Error("Expected overlay");
    const view = {
      type: "view-recording" as const,
      sessionId: snapshot.sessionId,
      recordingId: "recording-id",
    };
    const copy = {
      type: "copy-recovered-text" as const,
      sessionId: snapshot.sessionId,
      text: "recovered",
    };
    expect(fixture.manager.handleRendererEvent(99, view)).toBe(false);
    fixture.manager.handleRendererEvent(99, {
      type: "failed",
      sessionId: snapshot.sessionId,
      error: { kind: "transcription-network", operation: "transcribe", retryable: true },
    });
    expect(fixture.manager.handleRendererEvent(55, view)).toBe(false);
    expect(fixture.manager.handleRendererEvent(99, { ...copy, sessionId: "stale" })).toBe(false);
    expect(fixture.manager.handleRendererEvent(99, view)).toBe(true);
    expect(fixture.manager.handleRendererEvent(99, copy)).toBe(true);
    expect(fixture.openRecording).toHaveBeenCalledExactlyOnceWith("recording-id");
    expect(fixture.copy).toHaveBeenCalledExactlyOnceWith("recovered");
    expect(fixture.paste).not.toHaveBeenCalled();
  });
  it("routes native input without requiring a captured foreground process identity", async () => {
    const fixture = createFixture();
    await activate(fixture);
    const event = hotkeyEvent("pressed", "global-dictation-hold", "hold", 1);
    fixture.emit({ ...event, target: undefined });
    expect(fixture.manager.getSnapshot().kind).toBe("overlay-starting");
  });
});
