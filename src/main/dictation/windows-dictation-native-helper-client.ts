import { createHash } from "node:crypto";
import {
  normalizeAccelerator,
  validateGlobalDictationShortcutRejection,
  type CommandKeybindingRejection,
  type KeyboardLayoutSnapshot,
} from "../../shared/command-keybindings";
import type { GlobalDictationTarget } from "../../shared/global-dictation";
import {
  DictationNativeHelperRequestError,
  type DictationNativeHelperEvent,
  type DictationNativeHelperPort,
  type DictationNativePasteOptions,
  type DictationNativePastePort,
  type DictationNativePasteResult,
} from "./dictation-native-helper-port";

export interface WindowsDictationHotkeyBinding {
  readonly bindingId: string;
  readonly mode: "hold" | "toggle";
  readonly accelerator: string;
  readonly releaseKeyGroups: readonly (readonly number[])[];
}

const RELEASE_KEYS: Readonly<Record<string, readonly number[]>> = {
  cmdorctrl: [17],
  command: [91, 92],
  cmd: [91, 92],
  control: [17],
  ctrl: [17],
  alt: [18],
  option: [18],
  shift: [16],
};

/** Windows watches modifier release after Electron recognizes the complete shortcut. */
export function compileWindowsDictationHotkey(input: {
  readonly accelerator: string;
  readonly bindingId: string;
  readonly mode: "hold" | "toggle";
  readonly layout?: KeyboardLayoutSnapshot;
}):
  | { readonly type: "compiled"; readonly spec: WindowsDictationHotkeyBinding }
  | { readonly type: "rejected"; readonly reason: CommandKeybindingRejection } {
  const accelerator = normalizeAccelerator(input.accelerator);
  const parts = input.accelerator
    .split("+")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  if (parts.some((part) => part === "meta" || part === "commandorcontrol"))
    return {
      type: "rejected",
      reason: { kind: "unsupported-key", message: "This shortcut key is not supported." },
    };
  const reason = validateGlobalDictationShortcutRejection(accelerator, "windows");
  if (reason) return { type: "rejected", reason };
  const releaseKeyGroups = parts.flatMap((part) => {
    const group = RELEASE_KEYS[part];
    return group ? [group] : [];
  });
  if (!releaseKeyGroups.length)
    return {
      type: "rejected",
      reason: {
        kind: "unsupported-key",
        message: "This shortcut key is not supported for global dictation.",
      },
    };
  return {
    type: "compiled",
    spec: { bindingId: input.bindingId, mode: input.mode, accelerator, releaseKeyGroups },
  };
}

export interface WindowsDictationReleaseWatcher {
  readonly isActive: boolean;
  dispose(): void;
}

export interface WindowsDictationNativePorts {
  readonly clipboard: WindowsDictationClipboardPort;
  registerShortcut(accelerator: string, onPressed: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
  watchRelease(
    keyGroups: readonly (readonly number[])[],
    onReleased: () => void,
  ): WindowsDictationReleaseWatcher;
  sendPaste(signal?: AbortSignal): Promise<void>;
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

interface Registration {
  binding: WindowsDictationHotkeyBinding;
  generation: number;
  pressed: boolean;
  watcher: WindowsDictationReleaseWatcher | null;
}

export interface WindowsDictationClipboardFormat {
  readonly type: string;
  readonly bytes: Uint8Array;
  readonly bookmark?: { readonly title: string; readonly url: string };
}

export interface WindowsDictationClipboardSnapshot {
  readonly text: string;
  readonly items: readonly (readonly WindowsDictationClipboardFormat[])[];
}

/** Reads must materialize every lazy format before returning, so later writes cannot erase it. */
export interface WindowsDictationClipboardPort {
  read(): Promise<WindowsDictationClipboardSnapshot>;
  write(snapshot: WindowsDictationClipboardSnapshot): Promise<void>;
  writeText(text: string): Promise<void>;
}

export function fingerprintWindowsDictationClipboard(
  snapshot: WindowsDictationClipboardSnapshot,
): string {
  const hash = createHash("sha256").update(snapshot.text);
  for (const item of snapshot.items) {
    for (const format of [...item].sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0)))
      hash.update(format.type).update(format.bytes);
  }
  return hash.digest("hex");
}

/** Owns the native registrations and clipboard transaction within its enclosing desktop Scope. */
export class WindowsDictationNativeHelperClient
  implements DictationNativeHelperPort<WindowsDictationHotkeyBinding>, DictationNativePastePort
{
  readonly #ports: WindowsDictationNativePorts;
  readonly #listeners = new Set<(event: DictationNativeHelperEvent) => void>();
  #registrations = new Map<string, Registration>();
  #sequence = 0;
  #disposed = false;
  #escapeEnabled = false;
  #escapeGeneration = 0;

  constructor(ports: WindowsDictationNativePorts) {
    this.#ports = ports;
  }

  subscribe(listener: (event: DictationNativeHelperEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async capabilities(): Promise<{ inputMonitoring: boolean; accessibility: boolean }> {
    return { inputMonitoring: !this.#disposed, accessibility: !this.#disposed };
  }
  async requestAccessibility(): Promise<boolean> {
    return !this.#disposed;
  }
  async requestInputMonitoring(): Promise<boolean> {
    return !this.#disposed;
  }
  async captureBareModifier(_signal?: AbortSignal): Promise<string> {
    throw new DictationNativeHelperRequestError("unsupported-key");
  }
  async queryBuiltInMicrophoneName(): Promise<string | null> {
    return null;
  }

  async replaceBindings(input: {
    readonly generation: number;
    readonly bindings: readonly WindowsDictationHotkeyBinding[];
  }): Promise<void> {
    this.#assertAvailable();
    const next = new Map<string, Registration>();
    const added: string[] = [];
    try {
      for (const binding of input.bindings) {
        if (next.has(binding.accelerator))
          throw new DictationNativeHelperRequestError("hotkey-conflict");
        const previous = this.#registrations.get(binding.accelerator);
        if (previous) {
          next.set(binding.accelerator, previous);
          continue;
        }
        const registration: Registration = {
          binding,
          generation: input.generation,
          pressed: false,
          watcher: null,
        };
        if (!this.#ports.registerShortcut(binding.accelerator, () => this.#press(registration))) {
          throw new DictationNativeHelperRequestError("hotkey-conflict");
        }
        added.push(binding.accelerator);
        next.set(binding.accelerator, registration);
      }
    } catch (error) {
      for (const accelerator of added) this.#ports.unregisterShortcut(accelerator);
      throw error;
    }
    for (const [accelerator, registration] of this.#registrations) {
      this.#cancel(registration);
      registration.watcher?.dispose();
      registration.watcher = null;
      if (!next.has(accelerator)) this.#ports.unregisterShortcut(accelerator);
    }
    for (const binding of input.bindings) {
      const registration = next.get(binding.accelerator)!;
      registration.binding = binding;
      registration.generation = input.generation;
    }
    this.#registrations = next;
  }

  async setEscapeEnabled(enabled: boolean): Promise<void> {
    this.#assertAvailable();
    if (this.#escapeEnabled === enabled) return;
    const generation = ++this.#escapeGeneration;
    if (!enabled) {
      this.#escapeEnabled = false;
      this.#ports.unregisterShortcut("Escape");
      return;
    }
    if (
      !this.#ports.registerShortcut("Escape", () => {
        if (this.#escapeEnabled && !this.#disposed && generation === this.#escapeGeneration)
          this.#emit({ type: "escape", processGeneration: 1, sequence: ++this.#sequence });
      })
    )
      throw new DictationNativeHelperRequestError("hotkey-conflict");
    this.#escapeEnabled = true;
  }

  async captureClipboardFingerprint(): Promise<string> {
    this.#assertAvailable();
    return this.#fingerprint();
  }
  async copy(text: string): Promise<void> {
    this.#assertAvailable();
    await this.#ports.clipboard.writeText(text);
  }

  async safePaste(
    text: string,
    _target?: GlobalDictationTarget,
    options: DictationNativePasteOptions = {},
  ): Promise<DictationNativePasteResult> {
    this.#assertAvailable();
    options.signal?.throwIfAborted();
    const snapshot = await this.#ports.clipboard.read();
    options.signal?.throwIfAborted();
    if (
      options.clipboardFingerprint !== undefined &&
      fingerprintWindowsDictationClipboard(snapshot) !== options.clipboardFingerprint
    ) {
      return {
        clipboardRestoreMs: 0,
        failure: { text, copied: false, reason: "clipboard-changed" },
      };
    }
    await this.#ports.clipboard.writeText(text);
    const ownedSnapshot = await this.#ports.clipboard.read();
    const ownedFingerprint = fingerprintWindowsDictationClipboard(ownedSnapshot);
    // An asynchronous write/read can race another application. Never paste or restore its data.
    if (ownedSnapshot.text !== text)
      return {
        clipboardRestoreMs: 0,
        failure: { text, copied: false, reason: "clipboard-changed" },
      };
    let dispatched = false;
    let restoreStartedAt = this.#ports.now();
    try {
      const elapsed =
        options.recordingStoppedAtMs !== undefined && Number.isFinite(options.recordingStoppedAtMs)
          ? Math.max(0, this.#ports.now() - options.recordingStoppedAtMs)
          : 0;
      await this.#ports.sleep(Math.max(0, 150 - elapsed));
      options.signal?.throwIfAborted();
      if ((await this.#fingerprint()) !== ownedFingerprint)
        return {
          clipboardRestoreMs: 0,
          failure: { text, copied: false, reason: "clipboard-changed" },
        };
      options.signal?.throwIfAborted();
      dispatched = true;
      await this.#ports.sendPaste(options.signal);
      restoreStartedAt = this.#ports.now();
      await this.#ports.sleep(700);
    } catch (error) {
      if (!options.signal?.aborted)
        return {
          clipboardRestoreMs: 0,
          failure: {
            text,
            copied: (await this.#fingerprint()) === ownedFingerprint,
            reason: "paste",
          },
        };
      if (dispatched) await this.#ports.sleep(700);
      await this.#restoreOwnedClipboard(snapshot, text, ownedFingerprint);
      options.signal.throwIfAborted();
      throw error;
    }
    await this.#restoreOwnedClipboard(snapshot, text, ownedFingerprint);
    options.signal?.throwIfAborted();
    return { clipboardRestoreMs: Math.max(0, this.#ports.now() - restoreStartedAt) };
  }

  dispose(): void {
    if (this.#disposed) return;
    for (const [accelerator, registration] of this.#registrations) {
      this.#cancel(registration);
      registration.watcher?.dispose();
      this.#ports.unregisterShortcut(accelerator);
    }
    if (this.#escapeEnabled) this.#ports.unregisterShortcut("Escape");
    this.#escapeEnabled = false;
    this.#registrations.clear();
    this.#listeners.clear();
    this.#disposed = true;
  }

  #press(registration: Registration): void {
    if (
      this.#disposed ||
      this.#registrations.get(registration.binding.accelerator) !== registration ||
      registration.pressed
    )
      return;
    if (!registration.watcher?.isActive) {
      registration.watcher?.dispose();
      registration.watcher = this.#ports.watchRelease(registration.binding.releaseKeyGroups, () =>
        this.#release(registration),
      );
    }
    registration.pressed = true;
    this.#emitBinding("pressed", registration);
  }
  #release(registration: Registration): void {
    if (
      this.#disposed ||
      this.#registrations.get(registration.binding.accelerator) !== registration ||
      !registration.pressed
    )
      return;
    registration.pressed = false;
    this.#emitBinding("released", registration);
  }
  #cancel(registration: Registration): void {
    if (!registration.pressed) return;
    registration.pressed = false;
    this.#emitBinding("cancelled", registration);
  }
  #emitBinding(type: "pressed" | "released" | "cancelled", registration: Registration): void {
    this.#emit({
      type,
      bindingId: registration.binding.bindingId,
      mode: registration.binding.mode,
      configurationGeneration: registration.generation,
      processGeneration: 1,
      sequence: ++this.#sequence,
    });
  }
  #emit(event: DictationNativeHelperEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
  #assertAvailable(): void {
    if (this.#disposed) throw new DictationNativeHelperRequestError("disposed");
  }
  async #fingerprint(): Promise<string> {
    return fingerprintWindowsDictationClipboard(await this.#ports.clipboard.read());
  }
  async #restoreOwnedClipboard(
    snapshot: WindowsDictationClipboardSnapshot,
    text: string,
    fingerprint: string,
  ): Promise<void> {
    const clipboard = this.#ports.clipboard;
    const current = await clipboard.read();
    if (fingerprintWindowsDictationClipboard(current) !== fingerprint || current.text !== text)
      return;
    await clipboard.write(snapshot);
  }
}
