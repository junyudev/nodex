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
  super: [91, 92],
  control: [17],
  ctrl: [17],
  alt: [18],
  option: [18],
  shift: [16],
};

// Win32 virtual-key codes for the finite ordinary keys admitted by global shortcuts.
const ORDINARY_RELEASE_KEYS: Readonly<Record<string, number>> = {
  backspace: 0x08,
  tab: 0x09,
  enter: 0x0d,
  escape: 0x1b,
  space: 0x20,
  pageup: 0x21,
  pagedown: 0x22,
  end: 0x23,
  home: 0x24,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  delete: 0x2e,
  ";": 0xba,
  "=": 0xbb,
  ",": 0xbc,
  "-": 0xbd,
  ".": 0xbe,
  "/": 0xbf,
  "`": 0xc0,
  "[": 0xdb,
  "\\": 0xdc,
  "]": 0xdd,
  "'": 0xde,
};

const ordinaryReleaseKey = (key: string): number | null => {
  if (/^[A-Z0-9]$/.test(key)) return key.charCodeAt(0);
  const functionKey = /^F([1-9]|1\d|20)$/.exec(key);
  if (functionKey) return 0x6f + Number(functionKey[1]);
  return ORDINARY_RELEASE_KEYS[key.toLowerCase()] ?? null;
};

/** Windows ends the chord on ordinary-key or required-modifier release. */
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
  const reason = validateGlobalDictationShortcutRejection(input.accelerator, "windows");
  if (reason) return { type: "rejected", reason };
  const releaseKeyGroups = parts.flatMap((part) => {
    const group = RELEASE_KEYS[part];
    return group ? [group] : [];
  });
  const ordinaryKey = accelerator.split("+").find((part) => !RELEASE_KEYS[part.toLowerCase()]);
  const ordinaryKeyCode = ordinaryKey ? ordinaryReleaseKey(ordinaryKey) : null;
  if (!releaseKeyGroups.length || ordinaryKeyCode === null)
    return {
      type: "rejected",
      reason: {
        kind: "unsupported-key",
        message: "This shortcut key is not supported for global dictation.",
      },
    };
  return {
    type: "compiled",
    spec: {
      bindingId: input.bindingId,
      mode: input.mode,
      accelerator,
      releaseKeyGroups: [...releaseKeyGroups, [ordinaryKeyCode]],
    },
  };
}

export interface WindowsDictationReleaseWatcher {
  readonly isActive: boolean;
  dispose(): Promise<void>;
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
  accepting: boolean;
  rearming: Promise<PromiseSettledResult<void>> | null;
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

class WindowsDictationReleaseError extends AggregateError {
  constructor(errors: Iterable<unknown>) {
    super(errors, "Windows dictation release failed");
    this.name = "WindowsDictationReleaseError";
  }
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
  #bindingUpdate: Promise<PromiseSettledResult<void>> = Promise.resolve<PromiseSettledResult<void>>(
    {
      status: "fulfilled",
      value: undefined,
    },
  );
  #disposal: Promise<void> | null = null;

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
    const update = this.#bindingUpdate.then((previous) => {
      // A failed native release cannot authorize another generation of shortcuts.
      if (previous.status === "rejected" && previous.reason instanceof WindowsDictationReleaseError)
        throw previous.reason;
      if (this.#disposed) return;
      return this.#replaceBindings(input);
    });
    this.#bindingUpdate = update.then<PromiseSettledResult<void>, PromiseSettledResult<void>>(
      () => ({ status: "fulfilled", value: undefined }),
      (reason) => ({ status: "rejected", reason }),
    );
    return update;
  }

  async #replaceBindings(input: {
    readonly generation: number;
    readonly bindings: readonly WindowsDictationHotkeyBinding[];
  }): Promise<void> {
    const previous = this.#registrations;
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
          accepting: false,
          rearming: null,
        };
        if (!this.#ports.registerShortcut(binding.accelerator, () => this.#press(registration))) {
          throw new DictationNativeHelperRequestError("hotkey-conflict");
        }
        added.push(binding.accelerator);
        next.set(binding.accelerator, registration);
      }
    } catch (error) {
      const failures: unknown[] = [error];
      for (const accelerator of added) {
        try {
          this.#ports.unregisterShortcut(accelerator);
        } catch (cleanup) {
          // Keep a failed rollback's inert native shortcut owned for the next disposal.
          this.#registrations.set(accelerator, next.get(accelerator)!);
          failures.push(cleanup);
        }
      }
      if (failures.length > 1)
        throw new AggregateError(failures, "Dictation shortcut rollback failed", { cause: error });
      throw error;
    }
    // Transfer physical registration ownership before any callback or asynchronous release.
    // Both reused and new shortcuts remain fenced until the previous watchers have exited.
    for (const registration of previous.values()) registration.accepting = false;
    this.#registrations = next;
    const failures: unknown[] = [];
    for (const [accelerator, registration] of previous) {
      try {
        this.#cancel(registration);
      } catch (error) {
        failures.push(error);
      }
      if (next.has(accelerator)) continue;
      try {
        this.#ports.unregisterShortcut(accelerator);
      } catch (error) {
        next.set(accelerator, registration);
        failures.push(error);
      }
    }
    const releases = await Promise.allSettled([this.#releaseRegistrations([...previous.values()])]);
    failures.push(
      ...releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    );
    if (failures.length) throw new WindowsDictationReleaseError(failures);
    if (this.#disposed) return;
    for (const binding of input.bindings) {
      const registration = next.get(binding.accelerator)!;
      registration.binding = binding;
      registration.generation = input.generation;
      registration.accepting = true;
    }
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

  dispose(): Promise<void> {
    if (this.#disposal) return this.#disposal;
    this.#disposed = true;
    const registrations = [...this.#registrations.values()];
    const bindingUpdate = this.#bindingUpdate;
    const failures: unknown[] = [];
    const revoke = (operation: () => void) => {
      try {
        operation();
      } catch (error) {
        failures.push(error);
      }
    };
    // Install the idempotent owner before cancelled-event subscribers can reenter disposal.
    this.#disposal = Promise.resolve().then(async () => {
      const update = await bindingUpdate;
      const releases = await Promise.allSettled([
        this.#releaseRegistrations([
          ...new Set([...registrations, ...this.#registrations.values()]),
        ]),
      ]);
      this.#registrations.clear();
      failures.push(
        ...releases.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      );
      if (update.status === "rejected" && update.reason instanceof WindowsDictationReleaseError)
        failures.push(update.reason);
      if (failures.length) throw new WindowsDictationReleaseError(failures);
    });
    for (const [accelerator, registration] of this.#registrations) {
      registration.accepting = false;
      revoke(() => this.#cancel(registration));
      revoke(() => this.#ports.unregisterShortcut(accelerator));
    }
    if (this.#escapeEnabled) revoke(() => this.#ports.unregisterShortcut("Escape"));
    this.#escapeEnabled = false;
    this.#listeners.clear();
    return this.#disposal;
  }

  async #releaseRegistrations(registrations: readonly Registration[]): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const registration of registrations) {
      if (registration.watcher) pending.push(registration.watcher.dispose());
      if (registration.rearming)
        pending.push(
          registration.rearming.then((result) => {
            if (result.status === "rejected") throw result.reason;
          }),
        );
    }
    const results = await Promise.allSettled(pending);
    const failures = [
      ...new Set(
        results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ),
    ];
    if (failures.length) throw new WindowsDictationReleaseError(failures);
    for (const registration of registrations) {
      registration.watcher = null;
      registration.rearming = null;
    }
  }

  #press(registration: Registration): void {
    if (
      this.#disposed ||
      !registration.accepting ||
      this.#registrations.get(registration.binding.accelerator) !== registration ||
      registration.pressed ||
      registration.rearming
    )
      return;
    if (registration.watcher && !registration.watcher.isActive) {
      registration.rearming = this.#rearm(registration, registration.generation);
      return;
    }
    this.#beginPress(registration);
  }

  async #rearm(
    registration: Registration,
    generation: number,
  ): Promise<PromiseSettledResult<void>> {
    try {
      await registration.watcher!.dispose();
      if (
        this.#disposed ||
        !registration.accepting ||
        registration.generation !== generation ||
        this.#registrations.get(registration.binding.accelerator) !== registration
      )
        return { status: "fulfilled", value: undefined };
      registration.watcher = null;
      this.#beginPress(registration);
      registration.rearming = null;
      return { status: "fulfilled", value: undefined };
    } catch (reason) {
      try {
        this.#emit({
          type: "crashed",
          processGeneration: 1,
          exitCode: null,
          signal: null,
          diagnostic: reason instanceof Error ? reason.message : String(reason),
        });
      } catch (notificationFailure) {
        return { status: "rejected", reason: new AggregateError([reason, notificationFailure]) };
      }
      return { status: "rejected", reason };
    }
  }

  #beginPress(registration: Registration): void {
    if (!registration.watcher) {
      const generation = registration.generation;
      const watcher = this.#ports.watchRelease(registration.binding.releaseKeyGroups, () => {
        if (registration.watcher === watcher && registration.generation === generation)
          this.#release(registration);
      });
      registration.watcher = watcher;
    }
    registration.pressed = true;
    this.#emitBinding("pressed", registration);
  }
  #release(registration: Registration): void {
    if (
      this.#disposed ||
      !registration.accepting ||
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
