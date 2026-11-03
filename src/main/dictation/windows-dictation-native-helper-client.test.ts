import { deferredRelease } from "./dictation-release.test-fixtures";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT,
  validateGlobalDictationShortcutRejection,
} from "../../shared/command-keybindings";
import type { DictationNativeHelperEvent } from "./dictation-native-helper-port";
import {
  compileWindowsDictationHotkey,
  WindowsDictationNativeHelperClient,
  type WindowsDictationClipboardSnapshot,
  type WindowsDictationNativePorts,
} from "./windows-dictation-native-helper-client";

const snapshot = (text: string, custom = "opaque"): WindowsDictationClipboardSnapshot => ({
  text,
  items: [
    [
      { type: "text/plain", bytes: Buffer.from(text) },
      { type: 'electron application/osclipboard;format="custom"', bytes: Buffer.from(custom) },
      { type: "image/png", bytes: Uint8Array.of(1, 2, 3) },
    ],
  ],
});

function binding(accelerator = "Ctrl+Shift+K", bindingId = "hold") {
  const result = compileWindowsDictationHotkey({ accelerator, bindingId, mode: "hold" });
  if (result.type !== "compiled") throw new Error(result.reason.message);
  return result.spec;
}

function harness() {
  let current = snapshot("original");
  let now = 1_000;
  const events: DictationNativeHelperEvent[] = [];
  const shortcuts = new Map<string, () => void>();
  const watchers: {
    active: boolean;
    groups: readonly (readonly number[])[];
    release: () => void;
    stop: () => void;
    disposal: Promise<void> | null;
    disposalStarted: ReturnType<typeof deferredRelease>;
  }[] = [];
  const ports: WindowsDictationNativePorts = {
    clipboard: {
      read: vi.fn(async () => current),
      write: vi.fn(async (value) => {
        current = value;
      }),
      writeText: vi.fn(async (text) => {
        current = { text, items: [[{ type: "text/plain", bytes: Buffer.from(text) }]] };
      }),
    },
    registerShortcut: vi.fn((key, callback) => {
      if (shortcuts.has(key)) return false;
      shortcuts.set(key, callback);
      return true;
    }),
    unregisterShortcut: vi.fn((key) => {
      shortcuts.delete(key);
    }),
    watchRelease: vi.fn((groups, onReleased) => {
      const watcher = {
        active: true,
        groups,
        disposal: null as Promise<void> | null,
        disposalStarted: deferredRelease(),
        release: () => {
          if (watcher.active) onReleased();
        },
        stop: () => {
          if (!watcher.active) return;
          watcher.active = false;
          onReleased();
        },
      };
      watchers.push(watcher);
      return {
        get isActive() {
          return watcher.active;
        },
        dispose: () => {
          watcher.active = false;
          watcher.disposalStarted.resolve();
          return watcher.disposal ?? Promise.resolve();
        },
      };
    }),
    sendPaste: vi.fn(async () => {}),
    now: () => now,
    sleep: vi.fn(async (milliseconds) => {
      now += milliseconds;
    }),
  };
  const client = new WindowsDictationNativeHelperClient(ports);
  client.subscribe((event) => events.push(event));
  return {
    client,
    ports,
    events,
    shortcuts,
    watchers,
    releaseKeys: (downKeys: readonly number[]) => {
      const down = new Set(downKeys);
      for (const watcher of watchers) {
        if (!watcher.groups.every((group) => group.some((key) => down.has(key)))) {
          watcher.release();
        }
      }
    },
    current: () => current,
    change: (value: WindowsDictationClipboardSnapshot) => {
      current = value;
    },
  };
}

const releaseCauses = (error: unknown): unknown[] =>
  error instanceof AggregateError ? error.errors.flatMap(releaseCauses) : [error];

describe("Windows global dictation", () => {
  it.each([
    ["CmdOrCtrl+K", [[17], [75]]],
    ["Command+Shift+K", [[91, 92], [16], [75]]],
    ["Ctrl+Alt+K", [[17], [18], [75]]],
    ["Super+Shift+K", [[91, 92], [16], [75]]],
    ["Ctrl+Space", [[17], [32]]],
    ["Ctrl+0", [[17], [48]]],
    ["Ctrl+F1", [[17], [112]]],
    ["Ctrl+F20", [[17], [131]]],
    ["Alt+PageDown", [[18], [34]]],
    ["Alt+ArrowLeft", [[18], [37]]],
    ["Ctrl+;", [[17], [186]]],
    ["Ctrl+=", [[17], [187]]],
    ["Ctrl+[", [[17], [219]]],
    ["Ctrl+\\", [[17], [220]]],
    ["Ctrl+'", [[17], [222]]],
  ])("watches the complete chord of %s", (accelerator, groups) => {
    expect(binding(accelerator).releaseKeyGroups).toEqual(groups);
  });

  it("provides release observation for every admitted ordinary key", () => {
    for (const key of Object.values(DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT.entries)) {
      const accelerator = `Ctrl+${key}`;
      expect(validateGlobalDictationShortcutRejection(accelerator, "windows")).toBeNull();
      const compiled = binding(accelerator);
      const ordinaryGroup = compiled.releaseKeyGroups.at(-1);
      expect(ordinaryGroup).toHaveLength(1);
      expect(ordinaryGroup?.[0]).toBeGreaterThan(0);
      expect(ordinaryGroup?.[0]).toBeLessThanOrEqual(255);
    }
  });

  it.each(["Fn", "LeftOption", "Ctrl", "Shift+K", "K", "Meta+K", "Super+K"])(
    "rejects %s",
    (accelerator) => {
      expect(
        compileWindowsDictationHotkey({ accelerator, bindingId: "hold", mode: "hold" }).type,
      ).toBe("rejected");
    },
  );

  it("emits one press/release pair per hold, cancels replacement and fences old callbacks", async () => {
    const h = harness();
    await h.client.replaceBindings({ generation: 4, bindings: [binding()] });
    const press = h.shortcuts.get("Ctrl+Shift+K")!;
    press();
    press();
    h.watchers[0]!.release();
    h.watchers[0]!.release();
    press();
    await h.client.replaceBindings({ generation: 5, bindings: [binding("Alt+J", "new")] });
    press();
    h.watchers[0]!.release();
    h.shortcuts.get("Alt+J")!();
    await h.client.dispose();
    expect(h.events.map((e) => e.type)).toEqual([
      "pressed",
      "released",
      "pressed",
      "cancelled",
      "pressed",
      "cancelled",
    ]);
    expect(
      h.events.map((e) => ("configurationGeneration" in e ? e.configurationGeneration : null)),
    ).toEqual([4, 4, 4, 4, 5, 5]);
    expect(h.events.map((e) => ("sequence" in e ? e.sequence : null))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(h.events.every((e) => !("target" in e))).toBe(true);
    expect(h.shortcuts.size).toBe(0);
  });

  it("rearms on Space release while Ctrl remains held and also stops on Ctrl release", async () => {
    const h = harness();
    await h.client.replaceBindings({ generation: 1, bindings: [binding("Ctrl+Space")] });
    const press = h.shortcuts.get("Ctrl+Space")!;
    press();
    h.releaseKeys([17, 32]);
    press();
    expect(h.events.map((event) => event.type)).toEqual(["pressed"]);
    h.releaseKeys([17]);
    press();
    h.releaseKeys([32]);
    h.releaseKeys([]);
    expect(h.events.map((event) => event.type)).toEqual([
      "pressed",
      "released",
      "pressed",
      "released",
    ]);
    expect(h.ports.watchRelease).toHaveBeenCalledExactlyOnceWith(
      [[17], [32]],
      expect.any(Function),
    );
    await h.client.dispose();
  });

  it("retains working registrations when a replacement conflicts", async () => {
    const h = harness();
    await h.client.replaceBindings({ generation: 1, bindings: [binding()] });
    h.shortcuts.set("Alt+J", () => {});
    await expect(
      h.client.replaceBindings({ generation: 2, bindings: [binding("Alt+Q"), binding("Alt+J")] }),
    ).rejects.toMatchObject({ code: "hotkey-conflict" });
    expect(h.shortcuts.has("Alt+Q")).toBe(false);
    h.shortcuts.get("Ctrl+Shift+K")!();
    expect(h.events[0]).toMatchObject({ type: "pressed", configurationGeneration: 1 });
    await h.client.replaceBindings({
      generation: 3,
      bindings: [binding("Ctrl+Shift+K", "accepted")],
    });
    h.shortcuts.get("Ctrl+Shift+K")!();
    expect(h.events.at(-1)).toMatchObject({ bindingId: "accepted", configurationGeneration: 3 });
    await h.client.dispose();
  });

  it("fences Escape callbacks across registrations and disposal", async () => {
    const h = harness();
    await h.client.setEscapeEnabled(true);
    const stale = h.shortcuts.get("Escape")!;
    await h.client.setEscapeEnabled(false);
    await h.client.setEscapeEnabled(true);
    const current = h.shortcuts.get("Escape")!;
    stale();
    current();
    await h.client.dispose();
    current();
    expect(h.events).toEqual([{ type: "escape", processGeneration: 1, sequence: 1 }]);
  });

  it("keeps a reused accelerator fenced until its previous watcher exits", async () => {
    const h = harness();
    await h.client.replaceBindings({ generation: 1, bindings: [binding()] });
    const press = h.shortcuts.get("Ctrl+Shift+K")!;
    press();
    const watcher = h.watchers[0]!;
    const released = deferredRelease();
    watcher.disposal = released.promise;
    const replacement = h.client.replaceBindings({
      generation: 2,
      bindings: [binding("Ctrl+Shift+K", "new")],
    });
    try {
      await watcher.disposalStarted.promise;
      press();
      watcher.release();
      expect(h.watchers).toHaveLength(1);
      expect(h.events.map((event) => event.type)).toEqual(["pressed", "cancelled"]);
      released.resolve();
      await replacement;
      press();
      expect(h.watchers).toHaveLength(2);
      expect(h.events.at(-1)).toMatchObject({
        type: "pressed",
        bindingId: "new",
        configurationGeneration: 2,
      });
    } finally {
      released.resolve();
      await replacement;
      await h.client.dispose();
    }
  });

  it("joins a failing in-flight replacement before idempotent disposal can settle", async () => {
    const h = harness();
    await h.client.replaceBindings({ generation: 1, bindings: [binding()] });
    h.shortcuts.get("Ctrl+Shift+K")!();
    const watcher = h.watchers[0]!;
    const released = deferredRelease();
    const failure = new Error("release handle failed");
    watcher.disposal = released.promise;
    const replacement = h.client.replaceBindings({
      generation: 2,
      bindings: [binding("Alt+J", "new")],
    });
    const replacementResult = replacement.then(
      () => undefined,
      (error: unknown) => error,
    );
    await watcher.disposalStarted.promise;
    const stale = h.shortcuts.get("Alt+J")!;
    const disposal = h.client.dispose();
    expect(h.client.dispose()).toBe(disposal);
    const disposalResult = disposal.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      expect(h.shortcuts.size).toBe(0);
      stale();
      watcher.release();
      expect(h.watchers).toHaveLength(1);
      expect(await h.client.capabilities()).toEqual({
        inputMonitoring: false,
        accessibility: false,
      });
    } finally {
      released.reject(failure);
    }
    const failures = await Promise.all([replacementResult, disposalResult]);
    for (const error of failures) expect(releaseCauses(error)).toContain(failure);
    expect(h.events.map((event) => event.type)).toEqual(["pressed", "cancelled"]);
  });

  it("reaps an inactive watcher before a current registration can press again", async () => {
    const h = harness();
    await h.client.replaceBindings({ generation: 1, bindings: [binding()] });
    const press = h.shortcuts.get("Ctrl+Shift+K")!;
    press();
    const watcher = h.watchers[0]!;
    const released = deferredRelease();
    watcher.disposal = released.promise;
    watcher.stop();
    expect(watcher.active).toBe(false);
    const resumed = deferredRelease();
    const unsubscribe = h.client.subscribe((event) => {
      if (event.type === "pressed") resumed.resolve();
    });
    press();
    try {
      await watcher.disposalStarted.promise;
      expect(h.watchers).toHaveLength(1);
      expect(h.events.map((event) => event.type)).toEqual(["pressed", "released"]);
      released.resolve();
      await resumed.promise;
      expect(h.watchers).toHaveLength(2);
      expect(h.events.at(-1)).toMatchObject({ type: "pressed", configurationGeneration: 1 });
    } finally {
      released.resolve();
      unsubscribe();
      await h.client.dispose();
    }
  });

  it("does not revive an inactive registration when replacement wins its pending rearm", async () => {
    const h = harness();
    await h.client.replaceBindings({ generation: 1, bindings: [binding()] });
    const oldPress = h.shortcuts.get("Ctrl+Shift+K")!;
    oldPress();
    const watcher = h.watchers[0]!;
    const released = deferredRelease();
    watcher.disposal = released.promise;
    watcher.stop();
    oldPress();
    await watcher.disposalStarted.promise;
    const replacement = h.client.replaceBindings({
      generation: 2,
      bindings: [binding("Alt+J", "new")],
    });
    try {
      released.resolve();
      await replacement;
      oldPress();
      watcher.release();
      expect(h.watchers).toHaveLength(1);
      h.shortcuts.get("Alt+J")!();
      expect(h.watchers).toHaveLength(2);
      expect(h.events.map((event) => event.type)).toEqual(["pressed", "released", "pressed"]);
      expect(h.events.at(-1)).toMatchObject({ bindingId: "new", configurationGeneration: 2 });
    } finally {
      released.resolve();
      await replacement;
      await h.client.dispose();
    }
  });

  it("retains a callback-owned rearm failure for replacement and disposal", async () => {
    const h = harness();
    await h.client.replaceBindings({ generation: 1, bindings: [binding()] });
    const press = h.shortcuts.get("Ctrl+Shift+K")!;
    press();
    const watcher = h.watchers[0]!;
    const released = deferredRelease();
    const failure = new Error("inactive watcher did not exit");
    watcher.disposal = released.promise;
    watcher.stop();
    const crashed = deferredRelease();
    const unsubscribe = h.client.subscribe((event) => {
      if (event.type === "crashed") crashed.resolve();
    });
    press();
    await watcher.disposalStarted.promise;
    released.reject(failure);
    await crashed.promise;
    unsubscribe();
    expect(h.events.at(-1)).toMatchObject({ type: "crashed", diagnostic: failure.message });
    const replacementFailure = await h.client
      .replaceBindings({
        generation: 2,
        bindings: [binding("Alt+J", "new")],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(releaseCauses(replacementFailure)).toContain(failure);
    // Recovery uses this same helper; an unknown native exit cannot admit another generation.
    const recoveryFailure = await h.client
      .replaceBindings({
        generation: 3,
        bindings: [binding("Alt+J", "recovered")],
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(releaseCauses(recoveryFailure)).toContain(failure);
    h.shortcuts.get("Alt+J")!();
    expect(h.watchers).toHaveLength(1);
    const disposal = h.client.dispose();
    expect(h.client.dispose()).toBe(disposal);
    const disposalFailure = await disposal.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(releaseCauses(disposalFailure)).toContain(failure);
  });

  it("restores every original format after the foreground paste grace period", async () => {
    const h = harness();
    const original = h.current();
    const clipboardFingerprint = await h.client.captureClipboardFingerprint();
    expect(
      await h.client.safePaste("spoken", undefined, {
        clipboardFingerprint,
        recordingStoppedAtMs: 950,
      }),
    ).toEqual({ clipboardRestoreMs: 700 });
    expect(h.ports.sleep).toHaveBeenNthCalledWith(1, 100);
    expect(h.ports.sleep).toHaveBeenNthCalledWith(2, 700);
    expect(h.ports.sendPaste).toHaveBeenCalledOnce();
    expect(h.current()).toEqual(original);
  });

  it("detects a changed opaque format even when plain text is unchanged", async () => {
    const h = harness();
    const clipboardFingerprint = await h.client.captureClipboardFingerprint();
    h.change(snapshot("original", "changed"));
    expect(await h.client.safePaste("spoken", undefined, { clipboardFingerprint })).toEqual({
      clipboardRestoreMs: 0,
      failure: { text: "spoken", copied: false, reason: "clipboard-changed" },
    });
    expect(h.ports.clipboard.writeText).not.toHaveBeenCalled();
    expect(h.ports.sendPaste).not.toHaveBeenCalled();
  });

  it.each([150, 700])("preserves clipboard mutations during the %dms wait", async (at) => {
    const h = harness();
    const changed = snapshot("another app");
    vi.mocked(h.ports.sleep).mockImplementation(async (milliseconds) => {
      if (milliseconds === at) h.change(changed);
    });
    const result = await h.client.safePaste("spoken");
    expect(h.current()).toEqual(changed);
    expect(h.ports.clipboard.write).not.toHaveBeenCalled();
    expect(h.ports.sendPaste).toHaveBeenCalledTimes(at === 150 ? 0 : 1);
    expect(result.failure?.reason).toBe(at === 150 ? "clipboard-changed" : undefined);
  });

  it("does not claim a clipboard overwritten while the asynchronous write settles", async () => {
    const h = harness();
    vi.mocked(h.ports.clipboard.writeText).mockImplementation(async () => {
      h.change(snapshot("another app"));
    });
    expect((await h.client.safePaste("spoken")).failure?.reason).toBe("clipboard-changed");
    expect(h.ports.sendPaste).not.toHaveBeenCalled();
    expect(h.ports.clipboard.write).not.toHaveBeenCalled();
  });

  it("keeps text copied after a non-abort paste failure", async () => {
    const h = harness();
    vi.mocked(h.ports.sendPaste).mockRejectedValue(new Error("SendKeys failed"));
    expect((await h.client.safePaste("spoken")).failure).toEqual({
      text: "spoken",
      copied: true,
      reason: "paste",
    });
    expect(h.current().text).toBe("spoken");
    expect(h.ports.clipboard.write).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "acknowledges cancellation after cleanup (dispatched=%s)",
    async (dispatched) => {
      const h = harness();
      const original = h.current();
      const controller = new AbortController();
      if (dispatched)
        vi.mocked(h.ports.sendPaste).mockImplementation(async () => {
          controller.abort();
          controller.signal.throwIfAborted();
        });
      else
        vi.mocked(h.ports.sleep).mockImplementation(async () => {
          controller.abort();
        });
      await expect(
        h.client.safePaste("spoken", undefined, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(h.current()).toEqual(original);
      expect(h.ports.sleep).toHaveBeenCalledTimes(dispatched ? 2 : 1);
      if (dispatched) expect(h.ports.sleep).toHaveBeenLastCalledWith(700);
      expect(h.ports.sendPaste).toHaveBeenCalledTimes(dispatched ? 1 : 0);
    },
  );

  it("does not overwrite the clipboard when aborted during its asynchronous snapshot", async () => {
    const h = harness();
    const controller = new AbortController();
    vi.mocked(h.ports.clipboard.read).mockImplementation(async () => {
      controller.abort();
      return h.current();
    });
    await expect(
      h.client.safePaste("spoken", undefined, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(h.ports.clipboard.writeText).not.toHaveBeenCalled();
  });
});
