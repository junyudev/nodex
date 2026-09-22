import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GlobalShortcut } from "electron";
import {
  compileMacNativeHotkey,
  normalizeAccelerator,
  type MacNativeHotkeySpec,
} from "../../shared/command-keybindings";
import type {
  GlobalDictationPasteFailure,
  GlobalDictationTarget,
} from "../../shared/global-dictation";
import {
  DictationNativeHelperRequestError,
  type DictationNativeHelperEvent,
  type DictationNativePasteOptions,
  type DictationNativePasteResult,
} from "./dictation-native-helper-port";

const MAXIMUM_LINE_BYTES = 64 * 1024;
const MAXIMUM_STDERR_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const READY_TIMEOUT_MS = 3_000;
export const MAC_DICTATION_HELPER_PROTOCOL_VERSION = 4;

export type MacDictationPasteOptions = DictationNativePasteOptions;
export type MacDictationPasteResult = DictationNativePasteResult;
export type MacDictationForegroundTarget = GlobalDictationTarget;
export type MacDictationHelperEvent = DictationNativeHelperEvent;
export type MacDictationGlobalShortcutPort = Pick<GlobalShortcut, "register" | "unregister">;

export interface MacDictationCapabilities {
  readonly inputMonitoring: boolean;
  readonly accessibility: boolean;
}

interface RegularShortcutRegistration {
  readonly accelerator: string;
  readonly port: MacDictationGlobalShortcutPort;
  binding: MacNativeHotkeySpec;
  generation: number;
  pressed: boolean;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly cleanup: () => void;
}

/** Stable helper failure taxonomy lets callers separate invalid configuration from transport loss. */
export class MacDictationHelperRequestError extends DictationNativeHelperRequestError {
  constructor(code: string, message = `Dictation helper request failed: ${code}`) {
    super(code);
    this.message = message;
    this.name = "MacDictationHelperRequestError";
  }
}

export const resolveMacDictationHelperExecutable = (input: {
  readonly isPackaged: boolean;
  readonly resourcesPath: string;
  readonly repositoryRoot?: string;
}): string =>
  input.isPackaged
    ? join(input.resourcesPath, "bin/nodex-dictation-helper")
    : resolve(
        input.repositoryRoot ?? process.cwd(),
        ".generated/dev-runtime/bin/nodex-dictation-helper",
      );

export class MacDictationNativeHelperClient {
  readonly #executablePath: string;
  readonly #validateArchitecture: boolean;
  readonly #globalShortcut: MacDictationGlobalShortcutPort | undefined;
  readonly #listeners = new Set<(event: MacDictationHelperEvent) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #ready: Promise<void> | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((error: Error) => void) | null = null;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #processGeneration = 0;
  #sequence = 0;
  #bindingUpdate: Promise<void> = Promise.resolve();
  #regularRegistrations = new Map<string, RegularShortcutRegistration>();
  #escapeRevision = 0;
  #escapeRegistration: { readonly port: MacDictationGlobalShortcutPort } | null = null;
  #disposed = false;

  constructor(
    executablePath: string,
    options: {
      readonly validateArchitecture?: boolean;
      readonly globalShortcut?: MacDictationGlobalShortcutPort;
    } = {},
  ) {
    this.#executablePath = executablePath;
    this.#validateArchitecture = options.validateArchitecture ?? true;
    this.#globalShortcut = options.globalShortcut;
  }

  subscribe(listener: (event: MacDictationHelperEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async capabilities(_prompt = false): Promise<MacDictationCapabilities> {
    const value = (await this.#request("capabilities", {})) as Record<string, unknown>;
    if (typeof value.inputMonitoring !== "boolean" || typeof value.accessibility !== "boolean") {
      throw new MacDictationHelperRequestError("invalid-response");
    }
    return { inputMonitoring: value.inputMonitoring, accessibility: value.accessibility };
  }

  async requestInputMonitoring(): Promise<boolean> {
    return await this.#requestGranted("requestInputMonitoring");
  }

  async requestAccessibility(): Promise<boolean> {
    return await this.#requestGranted("requestAccessibility");
  }

  async replaceBindings(input: {
    readonly generation: number;
    readonly bindings: readonly MacNativeHotkeySpec[];
  }): Promise<void> {
    const update = this.#bindingUpdate.then(() => this.#replaceBindings(input));
    this.#bindingUpdate = update.catch(() => {});
    return await update;
  }

  async #replaceBindings(input: {
    readonly generation: number;
    readonly bindings: readonly MacNativeHotkeySpec[];
  }): Promise<void> {
    if (this.#disposed) throw new Error("Dictation helper was disposed");
    const regular = input.bindings.filter((binding) => binding.keyCode !== null);
    const accelerators = new Set<string>();
    for (const binding of regular) {
      if (!binding.registrationAccelerator)
        throw new MacDictationHelperRequestError("invalid-hotkey");
      if (accelerators.has(binding.registrationAccelerator))
        throw new MacDictationHelperRequestError("hotkey-conflict");
      accelerators.add(binding.registrationAccelerator);
    }
    const port =
      regular.length > 0
        ? (this.#globalShortcut ?? (await import("electron")).globalShortcut)
        : null;
    if (this.#disposed) throw new Error("Dictation helper was disposed");
    const next = new Map<string, RegularShortcutRegistration>();
    const staged: RegularShortcutRegistration[] = [];
    try {
      for (const binding of regular) {
        const accelerator = binding.registrationAccelerator!;
        const existing = this.#regularRegistrations.get(accelerator);
        if (existing) {
          next.set(accelerator, existing);
          continue;
        }
        const registration: RegularShortcutRegistration = {
          accelerator,
          port: port!,
          binding,
          generation: input.generation,
          pressed: false,
        };
        if (!port!.register(accelerator, () => this.#onRegularShortcut(registration))) {
          throw new MacDictationHelperRequestError("hotkey-conflict");
        }
        staged.push(registration);
        next.set(accelerator, registration);
      }
      const value = (await this.#request("replaceBindings", {
        generation: input.generation,
        bindings: input.bindings,
      })) as Record<string, unknown>;
      if (value.applied !== true || value.generation !== input.generation) {
        throw new MacDictationHelperRequestError("invalid-response");
      }
      if (this.#disposed) throw new Error("Dictation helper was disposed");
    } catch (error) {
      for (const registration of staged) registration.port.unregister(registration.accelerator);
      throw error;
    }
    // Only commit callback ownership after every OS registration and native watcher succeeds.
    const previous = this.#regularRegistrations;
    this.#regularRegistrations = next;
    for (const binding of regular) {
      const registration = next.get(binding.registrationAccelerator!)!;
      registration.binding = binding;
      registration.generation = input.generation;
      if (registration.pressed) this.#armRegularRelease(registration);
    }
    for (const [accelerator, registration] of previous) {
      if (!next.has(accelerator)) registration.port.unregister(accelerator);
    }
  }

  #onRegularShortcut(registration: RegularShortcutRegistration): void {
    if (
      this.#disposed ||
      !this.#child ||
      registration.pressed ||
      this.#regularRegistrations.get(registration.accelerator) !== registration
    )
      return;
    registration.pressed = true;
    this.#emitRegularEvent(registration, "pressed");
    this.#armRegularRelease(registration);
  }

  #emitRegularEvent(
    registration: RegularShortcutRegistration,
    type: "pressed" | "released" | "cancelled",
  ): void {
    this.#emit({
      type,
      bindingId: registration.binding.bindingId,
      mode: registration.binding.mode,
      configurationGeneration: registration.generation,
      processGeneration: this.#processGeneration,
      sequence: ++this.#sequence,
    });
  }

  #armRegularRelease(registration: RegularShortcutRegistration): void {
    const generation = registration.generation;
    void this.#request("armRegularRelease", {
      bindingId: registration.binding.bindingId,
      generation,
    }).catch(() => {
      if (
        this.#disposed ||
        registration.generation !== generation ||
        !registration.pressed ||
        this.#regularRegistrations.get(registration.accelerator) !== registration
      )
        return;
      registration.pressed = false;
      this.#emitRegularEvent(registration, "cancelled");
    });
  }

  #unregisterRegularShortcuts(): void {
    const registrations = this.#regularRegistrations;
    this.#regularRegistrations = new Map();
    for (const registration of registrations.values())
      registration.port.unregister(registration.accelerator);
  }

  async captureBareModifier(signal?: AbortSignal): Promise<string> {
    const value = (await this.#request("captureBareModifier", {}, signal)) as {
      readonly accelerator?: unknown;
    };
    if (
      typeof value.accelerator !== "string" ||
      normalizeAccelerator(value.accelerator) !== value.accelerator
    ) {
      throw new MacDictationHelperRequestError("invalid-response");
    }
    const compiled = compileMacNativeHotkey({
      accelerator: value.accelerator,
      bindingId: "capture",
      mode: "hold",
    });
    if (compiled.type !== "compiled" || compiled.spec.keyCode !== null) {
      throw new MacDictationHelperRequestError("invalid-response");
    }
    return value.accelerator;
  }

  async setEscapeEnabled(enabled: boolean): Promise<void> {
    if (this.#disposed) throw new Error("Dictation helper was disposed");
    const revision = ++this.#escapeRevision;
    if (!enabled) {
      this.#unregisterEscape();
      return;
    }
    if (this.#escapeRegistration) return;
    // Escape consumes the OS shortcut independently of Swift/Input Monitoring. Load Electron
    // lazily because the native build script also imports this module under host Node.
    const port = this.#globalShortcut ?? (await import("electron")).globalShortcut;
    if (this.#disposed || revision !== this.#escapeRevision) return;
    const registration = { port };
    const registered = port.register("Escape", () => {
      if (this.#disposed || this.#escapeRegistration !== registration) return;
      this.#emit({
        type: "escape",
        processGeneration: this.#processGeneration,
        sequence: ++this.#sequence,
      });
    });
    if (!registered) throw new MacDictationHelperRequestError("hotkey-conflict");
    this.#escapeRegistration = registration;
  }

  #unregisterEscape(): void {
    const registration = this.#escapeRegistration;
    this.#escapeRegistration = null;
    registration?.port.unregister("Escape");
  }

  async captureClipboardFingerprint(): Promise<string> {
    const value = await this.#request("captureClipboardFingerprint", {});
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
      throw new MacDictationHelperRequestError("invalid-response");
    }
    return value;
  }

  async copy(text: string): Promise<void> {
    await this.#request("copy", { text });
  }

  async safePaste(
    text: string,
    target?: MacDictationForegroundTarget,
    options: MacDictationPasteOptions = {},
  ): Promise<MacDictationPasteResult> {
    const result = (await this.#request(
      "safePaste",
      {
        text,
        target,
        clipboardFingerprint: options.clipboardFingerprint,
        recordingStoppedAtMs: options.recordingStoppedAtMs,
      },
      options.signal,
    )) as {
      pasted?: unknown;
      clipboardRestoreMs?: unknown;
      failure?: GlobalDictationPasteFailure;
    };
    if (
      !result ||
      (result.pasted !== true && result.pasted !== false) ||
      typeof result.clipboardRestoreMs !== "number" ||
      !Number.isFinite(result.clipboardRestoreMs) ||
      result.clipboardRestoreMs < 0 ||
      result.clipboardRestoreMs > 60_000
    ) {
      throw new MacDictationHelperRequestError("invalid-response");
    }
    if (result.pasted === true && result.failure === undefined) {
      return { clipboardRestoreMs: result.clipboardRestoreMs };
    }
    const failure = result.failure;
    if (
      result.pasted !== false ||
      !failure ||
      typeof failure.text !== "string" ||
      typeof failure.copied !== "boolean" ||
      !["accessibility", "clipboard-changed", "paste"].includes(failure.reason)
    ) {
      throw new MacDictationHelperRequestError("invalid-response");
    }
    return { clipboardRestoreMs: result.clipboardRestoreMs, failure };
  }

  async queryBuiltInMicrophoneName(): Promise<string | null> {
    const value = await this.#request("queryBuiltInMic", {});
    if (value === null) return null;
    if (typeof value !== "string") throw new MacDictationHelperRequestError("invalid-response");
    return value;
  }

  async #requestGranted(type: string): Promise<boolean> {
    const value = (await this.#request(type, {})) as Record<string, unknown>;
    if (typeof value.granted !== "boolean") {
      throw new MacDictationHelperRequestError("invalid-response");
    }
    return value.granted;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    ++this.#escapeRevision;
    this.#unregisterEscape();
    this.#unregisterRegularShortcuts();
    const child = this.#child;
    this.#child = null;
    if (child) {
      // EOF lets native cancellation preserve the clipboard consumption grace on shutdown.
      const deadline = setTimeout(() => child.kill(), 6_000);
      deadline.unref();
      child.once("exit", () => clearTimeout(deadline));
      child.stdin.end();
    }
    this.#resetReady(new Error("Dictation helper was disposed"));
    this.#rejectPending(new Error("Dictation helper was disposed"));
    this.#listeners.clear();
  }

  async #request(
    type: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    await this.#ensureStarted();
    signal?.throwIfAborted();
    const child = this.#child;
    if (!child) throw new Error("Dictation helper is unavailable");
    const id = randomUUID();
    const line = `${JSON.stringify({ id, type, ...payload })}\n`;
    if (Buffer.byteLength(line, "utf8") > MAXIMUM_LINE_BYTES) {
      throw new MacDictationHelperRequestError("message-too-large");
    }
    return await new Promise((resolveRequest, rejectRequest) => {
      // Cancellation is acknowledged only after native restore/grace cleanup finishes.
      const abort = (): void => {
        child.stdin.write(
          `${JSON.stringify({ id: randomUUID(), type: type === "captureBareModifier" ? "cancelCapture" : "cancelPaste", requestId: id })}\n`,
        );
      };
      const cleanup = (): void => signal?.removeEventListener("abort", abort);
      const timeout = setTimeout(() => {
        cleanup();
        if (type === "safePaste" || type === "captureBareModifier") abort();
        this.#pending.delete(id);
        rejectRequest(new Error(`Dictation helper ${type} request timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout, cleanup });
      child.stdin.write(line, (error) => {
        if (!error) return;
        cleanup();
        clearTimeout(timeout);
        this.#pending.delete(id);
        rejectRequest(error);
      });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  async #ensureStarted(): Promise<void> {
    if (this.#disposed) throw new Error("Dictation helper was disposed");
    if (this.#child && this.#ready) return await this.#ready;
    const metadata = lstatSync(this.#executablePath);
    if (metadata.isSymbolicLink() || !metadata.isFile() || (metadata.mode & 0o111) === 0) {
      throw new Error("Dictation helper is not a regular executable");
    }
    if (this.#validateArchitecture && process.platform === "darwin") {
      const architectures = execFileSync("/usr/bin/lipo", ["-archs", this.#executablePath], {
        encoding: "utf8",
      })
        .trim()
        .split(/\s+/);
      const expected = process.arch === "arm64" ? "arm64" : "x86_64";
      if (!architectures.includes(expected)) {
        throw new Error(`Dictation helper does not contain the ${expected} architecture`);
      }
    }

    const child = spawn(this.#executablePath, [], { stdio: ["pipe", "pipe", "pipe"] });
    const processGeneration = this.#processGeneration + 1;
    this.#processGeneration = processGeneration;
    this.#child = child;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    this.#ready = new Promise((resolveReady, rejectReady) => {
      this.#resolveReady = resolveReady;
      this.#rejectReady = rejectReady;
    });
    this.#readyTimer = setTimeout(() => {
      this.#rejectReady?.(new Error("Dictation helper did not become ready"));
      child.kill();
    }, READY_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      if (Buffer.byteLength(stdoutBuffer, "utf8") > MAXIMUM_LINE_BYTES * 2) {
        child.kill();
        return;
      }
      let newline = stdoutBuffer.indexOf("\n");
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        this.#handleLine(child, processGeneration, line);
        newline = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrBuffer = `${stderrBuffer}${chunk}`.slice(-MAXIMUM_STDERR_BYTES);
    });
    child.once("error", (error) =>
      this.#handleExit(child, processGeneration, null, null, `${stderrBuffer}\n${error.message}`),
    );
    child.once("exit", (exitCode, signal) =>
      this.#handleExit(child, processGeneration, exitCode, signal, stderrBuffer),
    );
    return await this.#ready;
  }

  #handleLine(
    child: ChildProcessWithoutNullStreams,
    processGeneration: number,
    line: string,
  ): void {
    if (this.#child !== child || !line || Buffer.byteLength(line, "utf8") > MAXIMUM_LINE_BYTES) {
      return;
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    if (
      message.type === "ready" &&
      message.protocolVersion === MAC_DICTATION_HELPER_PROTOCOL_VERSION
    ) {
      this.#resolveReady?.();
      this.#resolveReady = null;
      this.#rejectReady = null;
      if (this.#readyTimer) clearTimeout(this.#readyTimer);
      this.#readyTimer = null;
      return;
    }
    if (message.type === "response" && typeof message.id === "string") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pending.cleanup();
      this.#pending.delete(message.id);
      if (message.ok === true) pending.resolve(message.value);
      else if (message.error === "aborted")
        pending.reject(new DOMException("Dictation helper request cancelled", "AbortError"));
      else pending.reject(new MacDictationHelperRequestError(String(message.error ?? "unknown")));
      return;
    }
    if (
      (message.type === "pressed" || message.type === "released" || message.type === "cancelled") &&
      typeof message.bindingId === "string" &&
      (message.mode === "hold" || message.mode === "toggle") &&
      typeof message.configurationGeneration === "number" &&
      typeof message.sequence === "number" &&
      Number.isSafeInteger(message.sequence) &&
      message.sequence > 0
    ) {
      const regular = [...this.#regularRegistrations.values()].find(
        (registration) => registration.binding.bindingId === message.bindingId,
      );
      if (regular) {
        if (
          message.type !== "released" ||
          message.configurationGeneration !== regular.generation ||
          !regular.pressed
        )
          return;
        regular.pressed = false;
        this.#emitRegularEvent(regular, "released");
        return;
      }
      const targetValue = message.target as Record<string, unknown> | undefined;
      const target =
        targetValue &&
        typeof targetValue.pid === "number" &&
        typeof targetValue.bundleIdentifier === "string"
          ? { pid: targetValue.pid, bundleIdentifier: targetValue.bundleIdentifier }
          : undefined;
      this.#emit({
        type: message.type,
        bindingId: message.bindingId,
        mode: message.mode,
        configurationGeneration: message.configurationGeneration,
        processGeneration,
        sequence: (this.#sequence = Math.max(this.#sequence + 1, message.sequence)),
        ...(target ? { target } : {}),
      });
    }
  }

  #handleExit(
    child: ChildProcessWithoutNullStreams,
    processGeneration: number,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    stderr: string,
  ): void {
    if (this.#child !== child) return;
    this.#child = null;
    this.#unregisterRegularShortcuts();
    this.#resetReady(new Error("Dictation helper exited before becoming ready"));
    this.#rejectPending(new Error("Dictation helper exited"));
    if (this.#disposed) return;
    this.#emit({
      type: "crashed",
      processGeneration,
      exitCode,
      signal,
      diagnostic: stderr.trim() || null,
    });
  }

  #resetReady(error: Error): void {
    if (this.#readyTimer) clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
    this.#rejectReady?.(error);
    this.#ready = null;
    this.#resolveReady = null;
    this.#rejectReady = null;
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.cleanup();
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #emit(event: MacDictationHelperEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
