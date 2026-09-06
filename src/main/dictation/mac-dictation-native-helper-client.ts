import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MacNativeHotkeySpec } from "../../shared/command-keybindings";

const MAXIMUM_LINE_BYTES = 64 * 1024;
const MAXIMUM_STDERR_BYTES = 8 * 1024;
const REQUEST_TIMEOUT_MS = 12_000;
const READY_TIMEOUT_MS = 3_000;
const MAC_DICTATION_HELPER_PROTOCOL_VERSION = 3;

export interface MacDictationForegroundTarget {
  readonly pid: number;
  readonly bundleIdentifier: string;
}

export type MacDictationHelperEvent =
  | {
      readonly type: "pressed" | "released";
      readonly bindingId: string;
      readonly mode: "hold" | "toggle";
      readonly configurationGeneration: number;
      readonly processGeneration: number;
      readonly sequence: number;
      readonly target?: MacDictationForegroundTarget;
    }
  | {
      readonly type: "crashed";
      readonly processGeneration: number;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly diagnostic: string | null;
    };

export interface MacDictationCapabilities {
  readonly inputMonitoring: boolean;
  readonly accessibility: boolean;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

/** Stable helper failure taxonomy lets callers separate invalid configuration from transport loss. */
export class MacDictationHelperRequestError extends Error {
  constructor(
    readonly code: string,
    message = `Dictation helper request failed: ${code}`,
  ) {
    super(message);
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
  readonly #listeners = new Set<(event: MacDictationHelperEvent) => void>();
  readonly #pending = new Map<string, PendingRequest>();
  #child: ChildProcessWithoutNullStreams | null = null;
  #ready: Promise<void> | null = null;
  #resolveReady: (() => void) | null = null;
  #rejectReady: ((error: Error) => void) | null = null;
  #readyTimer: ReturnType<typeof setTimeout> | null = null;
  #processGeneration = 0;
  #disposed = false;

  constructor(executablePath: string, options: { readonly validateArchitecture?: boolean } = {}) {
    this.#executablePath = executablePath;
    this.#validateArchitecture = options.validateArchitecture ?? true;
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
    const value = (await this.#request("replaceBindings", {
      generation: input.generation,
      bindings: input.bindings,
    })) as Record<string, unknown>;
    if (value.applied !== true || value.generation !== input.generation) {
      throw new MacDictationHelperRequestError("invalid-response");
    }
  }

  async captureFn(): Promise<"Fn"> {
    const value = (await this.#request("captureFn", {})) as { readonly accelerator?: unknown };
    if (value.accelerator !== "Fn") {
      throw new MacDictationHelperRequestError("invalid-response");
    }
    return value.accelerator;
  }

  async safePaste(
    text: string,
    target: MacDictationForegroundTarget,
  ): Promise<{ readonly clipboardRestoreMs: number }> {
    const result = (await this.#request("safePaste", { text, target })) as {
      pasted?: unknown;
      clipboardRestoreMs?: unknown;
    };
    if (
      result.pasted !== true ||
      typeof result.clipboardRestoreMs !== "number" ||
      !Number.isFinite(result.clipboardRestoreMs) ||
      result.clipboardRestoreMs < 0 ||
      result.clipboardRestoreMs > 60_000
    ) {
      throw new MacDictationHelperRequestError("invalid-response");
    }
    return { clipboardRestoreMs: result.clipboardRestoreMs };
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
    const child = this.#child;
    this.#child = null;
    child?.kill();
    this.#resetReady(new Error("Dictation helper was disposed"));
    this.#rejectPending(new Error("Dictation helper was disposed"));
    this.#listeners.clear();
  }

  async #request(type: string, payload: Record<string, unknown>): Promise<unknown> {
    await this.#ensureStarted();
    const child = this.#child;
    if (!child) throw new Error("Dictation helper is unavailable");
    const id = randomUUID();
    return await new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error(`Dictation helper ${type} request timed out`));
      }, REQUEST_TIMEOUT_MS);
      this.#pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      child.stdin.write(`${JSON.stringify({ id, type, ...payload })}\n`, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.#pending.delete(id);
        rejectRequest(error);
      });
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
      this.#pending.delete(message.id);
      if (message.ok === true) pending.resolve(message.value);
      else pending.reject(new MacDictationHelperRequestError(String(message.error ?? "unknown")));
      return;
    }
    if (
      (message.type === "pressed" || message.type === "released") &&
      typeof message.bindingId === "string" &&
      (message.mode === "hold" || message.mode === "toggle") &&
      typeof message.configurationGeneration === "number" &&
      typeof message.sequence === "number"
    ) {
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
        sequence: message.sequence,
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
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #emit(event: MacDictationHelperEvent): void {
    for (const listener of this.#listeners) listener(event);
  }
}
