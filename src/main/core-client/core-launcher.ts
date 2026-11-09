import { spawn } from "node:child_process";
import { accessSync, constants, lstatSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import type { components } from "@nodex/core-protocol";
import { NODEX_CORE_EXECUTABLE_ENV } from "../../shared/native-runtime-environment";
import { readCoreArtifactDigest } from "./core-artifact";
import { CoreClient } from "./core-client";
import { parseCoreRuntimeDescriptor } from "./runtime-descriptor";

const DEFAULT_STARTUP_TIMEOUT_MS = 300_000;
const DEFAULT_STARTUP_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const MAX_STARTUP_STDERR_CHARS = 16_384;
const MAX_SELECTION_STDOUT_CHARS = 128 * 1024;
const MAX_SELECTION_STDOUT_LINE_CHARS = 64 * 1024;
const MAX_STARTUP_EVENT_COUNT = 512;
const CANDIDATE_TERMINATION_GRACE_MS = 2_000;

/** Structured loader evidence; raw stderr and executable paths never enter incidents. */
export class CoreStartupError extends Error {
  readonly executable = process.platform === "win32" ? "nodex-core.exe" : "nodex-core";
  readonly reason: "spawn" | "exit" | "startup";
  readonly exitCode: number | null;
  readonly windowsStatus: string | null;
  readonly spawnCode: string | null;

  constructor(
    cause: unknown,
    exit: { readonly code: number | null; readonly error: Error | null },
  ) {
    super(cause instanceof Error ? cause.message : "Native Rust Core startup failed", { cause });
    this.name = "CoreStartupError";
    this.reason = exit.error ? "spawn" : exit.code !== null ? "exit" : "startup";
    this.exitCode = exit.code;
    this.windowsStatus =
      process.platform === "win32" && exit.code !== null
        ? `0x${(exit.code >>> 0).toString(16).padStart(8, "0").toUpperCase()}`
        : null;
    const code = exit.error && "code" in exit.error ? exit.error.code : null;
    this.spawnCode = typeof code === "string" && /^E[A-Z0-9_]{1,30}$/u.test(code) ? code : null;
  }
}

export interface ResolveCoreExecutableInput {
  readonly appResourcesPath?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly isPackaged: boolean;
  readonly repositoryRoot?: string;
}

export interface ConnectOrStartCoreInput extends ResolveCoreExecutableInput {
  readonly buildId: string;
  readonly connectionId?: string;
  readonly maximumJsonResponseBytes?: number;
  readonly nodexHome: string;
  /** Explicit Host deployment; Core skips restoring personal Remote access for this launch. */
  readonly operatorListener?: Pick<
    components["schemas"]["ListenRequest"],
    "address" | "cert" | "key"
  >;
  readonly onAuthorityProcessExit?: (event: CoreAuthorityProcessExit) => void;
  readonly onStartupEvent?: (event: CoreStartupEvent) => void;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly startupHardTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
}

export interface CoreAuthorityProcessExit {
  readonly code: number | null;
  readonly processId: number;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

export interface CoreLaunchResult {
  readonly client: CoreClient;
  readonly executablePath: string;
  readonly startedProcessId: number | null;
  readonly timings: CoreLaunchTimings;
}

export type CoreStartupEvent =
  | { readonly artifactHashMs: number; readonly kind: "candidate_checked" }
  | {
      readonly fromVersion: number;
      readonly kind: "migration_started";
      readonly toVersion: number;
    }
  | {
      readonly completed: number;
      readonly kind: "migration_progress";
      readonly total: number;
    }
  | { readonly kind: "migration_heartbeat" }
  | {
      readonly createdFresh: boolean;
      readonly kind: "store_ready";
      readonly migratedFromVersion: number | null;
      readonly storeOpenMs: number;
    };

export interface CoreLaunchTimings {
  readonly artifactValidationMs: number;
  readonly connectMs: number;
  readonly disposition: CoreSelectionResult["disposition"];
  readonly reason: CoreSelectionResult["reason"];
  readonly selectionMs: number;
  readonly totalMs: number;
}

interface ChildExitState {
  code: number | null;
  error: Error | null;
  exited: boolean;
  signal: NodeJS.Signals | null;
  stderr: string;
}

type CoreSelectionResult = components["schemas"]["CoreSelectionResult"];
type CoreStartupEventFrame = components["schemas"]["CoreStartupEventFrame"];

const CORE_SELECTION_REASONS = new Set<CoreSelectionResult["reason"]>([
  "started_no_incumbent",
  "reused_compatible",
  "replaced_contract",
  "replaced_artifact",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireOnlyKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
  label: string,
): void => {
  const keys = new Set(expected);
  if (Object.keys(value).every((key) => keys.has(key))) return;
  throw new Error(`${label} has unknown fields`);
};

const parseCoreSelectionResult = (value: unknown, nodexHome: string): CoreSelectionResult => {
  if (!isRecord(value)) {
    throw new Error("Native Rust Core selection result must be an object");
  }
  requireOnlyKeys(
    value,
    ["selection_version", "disposition", "reason", "descriptor"],
    "Native Rust Core selection result",
  );
  if (
    value.selection_version !== 1 ||
    (value.disposition !== "started" && value.disposition !== "reused") ||
    typeof value.reason !== "string" ||
    !CORE_SELECTION_REASONS.has(value.reason as CoreSelectionResult["reason"])
  ) {
    throw new Error("Native Rust Core returned an invalid selection result");
  }
  return {
    selection_version: 1,
    disposition: value.disposition,
    reason: value.reason as CoreSelectionResult["reason"],
    descriptor: parseCoreRuntimeDescriptor(
      value.descriptor,
      path.join(nodexHome, "run/core/core.sock"),
    ),
  };
};

const requireNonNegativeInteger = (value: unknown, label: string): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new Error(`Native Rust Core startup event has invalid ${label}`);
};

export function parseCoreStartupEventFrame(value: unknown): CoreStartupEvent | null {
  if (!isRecord(value) || !("startup_event_version" in value)) return null;
  if (value.startup_event_version !== 1 || !isRecord(value.event)) {
    throw new Error("Native Rust Core startup event version is unsupported");
  }
  const frame = value as unknown as CoreStartupEventFrame;
  const event = frame.event;
  if (event.kind === "candidate_checked") {
    return {
      artifactHashMs: requireNonNegativeInteger(event.artifact_hash_ms, "artifact_hash_ms"),
      kind: "candidate_checked",
    };
  }
  if (event.kind === "migration_started") {
    return {
      fromVersion: requireNonNegativeInteger(event.from_version, "from_version"),
      kind: "migration_started",
      toVersion: requireNonNegativeInteger(event.to_version, "to_version"),
    };
  }
  if (event.kind === "migration_progress") {
    const completed = requireNonNegativeInteger(event.completed, "completed");
    const total = requireNonNegativeInteger(event.total, "total");
    if (total < 1 || completed > total) {
      throw new Error("Native Rust Core startup event has invalid migration progress");
    }
    return { completed, kind: "migration_progress", total };
  }
  if (event.kind === "migration_heartbeat") {
    return { kind: "migration_heartbeat" };
  }
  if (event.kind === "store_ready") {
    if (typeof event.created_fresh !== "boolean") {
      throw new Error("Native Rust Core startup event has invalid created_fresh");
    }
    const migratedFromVersion =
      event.migrated_from_version === null
        ? null
        : requireNonNegativeInteger(event.migrated_from_version, "migrated_from_version");
    return {
      createdFresh: event.created_fresh,
      kind: "store_ready",
      migratedFromVersion,
      storeOpenMs: requireNonNegativeInteger(event.store_open_ms, "store_open_ms"),
    };
  }
  throw new Error("Native Rust Core startup event kind is unsupported");
}

const abortError = (signal: AbortSignal): Error => {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException("Native Rust Core startup was aborted", "AbortError");
};

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError(signal);
};

const delay = (durationMs: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timeout = setTimeout(finish, durationMs);
    const onAbort = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(signal ? abortError(signal) : new Error("Startup delay was aborted"));
    };
    function finish(): void {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const waitForChildExit = async (exit: ChildExitState, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!exit.exited && Date.now() < deadline) {
    await delay(DEFAULT_POLL_INTERVAL_MS);
  }
  return exit.exited;
};

/**
 * Classifies a failed signal to a candidate's process group. ESRCH means the group is gone.
 * macOS answers EPERM, not ESRCH, while the group's last members are exiting but not yet
 * reaped, so that group is still present and has nothing left to signal.
 */
const exitedProcessGroup = (error: unknown): "gone" | "exiting" => {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === "ESRCH") return "gone";
  if (code === "EPERM") return "exiting";
  throw error;
};

export const processGroupPresent = (
  groupId: number,
  kill: (pid: number, signal: 0) => unknown = process.kill,
): boolean => {
  try {
    kill(-groupId, 0);
    return true;
  } catch (error) {
    return exitedProcessGroup(error) === "exiting";
  }
};

const posixCandidateGroupExists = (child: ReturnType<typeof spawn>): boolean =>
  child.pid ? processGroupPresent(child.pid) : false;

const runWindowsTaskkill = async (pid: number, force: boolean): Promise<void> => {
  const taskkill = spawn("taskkill.exe", ["/pid", String(pid), "/t", ...(force ? ["/f"] : [])], {
    stdio: "ignore",
    windowsHide: true,
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    taskkill.once("error", reject);
    taskkill.once("close", resolve);
  });
  if (code === 0 || code === 128) return;
  throw new Error(`taskkill exited with code ${String(code)}`);
};

const signalPosixCandidateGroup = (
  child: ReturnType<typeof spawn>,
  signal: NodeJS.Signals,
): void => {
  const pid = child.pid;
  if (!pid) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    exitedProcessGroup(error);
  }
};

const terminateCandidate = async (
  child: ReturnType<typeof spawn>,
  exit: ChildExitState,
): Promise<void> => {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await runWindowsTaskkill(pid, false);
    if (await waitForChildExit(exit, CANDIDATE_TERMINATION_GRACE_MS)) return;
    await runWindowsTaskkill(pid, true);
    if (await waitForChildExit(exit, CANDIDATE_TERMINATION_GRACE_MS)) return;
    throw new Error("Timed out terminating the pre-ready native Rust Core candidate tree");
  }

  if (!posixCandidateGroupExists(child)) return;
  signalPosixCandidateGroup(child, "SIGTERM");
  const gracefulDeadline = Date.now() + CANDIDATE_TERMINATION_GRACE_MS;
  while (posixCandidateGroupExists(child) && Date.now() < gracefulDeadline) {
    await delay(DEFAULT_POLL_INTERVAL_MS);
  }
  if (!posixCandidateGroupExists(child)) return;
  signalPosixCandidateGroup(child, "SIGKILL");
  const forcedDeadline = Date.now() + CANDIDATE_TERMINATION_GRACE_MS;
  while (posixCandidateGroupExists(child) && Date.now() < forcedDeadline) {
    await delay(DEFAULT_POLL_INTERVAL_MS);
  }
  if (!posixCandidateGroupExists(child)) return;
  throw new Error("Timed out terminating the pre-ready native Rust Core candidate group");
};

const terminateAfterStartupFailure = async (
  child: ReturnType<typeof spawn>,
  exit: ChildExitState,
  startupError: unknown,
): Promise<never> => {
  try {
    await terminateCandidate(child, exit);
  } catch (terminationError) {
    // oxlint-disable-next-line eslint/preserve-caught-error -- AggregateError retains both failures; startup remains the primary cause.
    throw new AggregateError(
      [startupError, terminationError],
      "Native Rust Core startup failed and its candidate could not be terminated",
      { cause: startupError },
    );
  }
  throw startupError;
};

const requireAbsolutePath = (candidate: string, label: string): string => {
  if (path.isAbsolute(candidate)) return path.normalize(candidate);
  throw new Error(`${label} must be absolute`);
};

export function resolveCoreExecutable(input: ResolveCoreExecutableInput): string {
  const environment = input.environment ?? process.env;
  const override = environment[NODEX_CORE_EXECUTABLE_ENV]?.trim();
  if (override) return requireAbsolutePath(override, NODEX_CORE_EXECUTABLE_ENV);

  if (input.isPackaged) {
    if (!input.appResourcesPath) {
      throw new Error("Packaged Core startup requires an app resources path");
    }
    return path.join(
      requireAbsolutePath(input.appResourcesPath, "App resources path"),
      `bin/nodex-core${process.platform === "win32" ? ".exe" : ""}`,
    );
  }

  return path.join(
    requireAbsolutePath(input.repositoryRoot ?? process.cwd(), "Core repository root"),
    `target/debug/nodex-core${process.platform === "win32" ? ".exe" : ""}`,
  );
}

function validateCoreExecutable(executablePath: string): void {
  const stats = lstatSync(executablePath);
  if (stats.isSymbolicLink()) throw new Error("Core executable must not be a symlink");
  if (!stats.isFile()) throw new Error("Core executable must be a regular file");
  accessSync(executablePath, constants.X_OK);
}

const expectedCoreArtifactDigest = (
  input: ResolveCoreExecutableInput,
  executablePath: string,
): string => {
  const override = (input.environment ?? process.env)[NODEX_CORE_EXECUTABLE_ENV]?.trim();
  if (override || !input.isPackaged) return readCoreArtifactDigest(executablePath);
  if (!input.appResourcesPath) {
    throw new Error("Packaged Core startup requires an app resources path");
  }
  return readCoreArtifactDigest(
    executablePath,
    path.join(
      requireAbsolutePath(input.appResourcesPath, "App resources path"),
      "bin/rust-core-runtime.json",
    ),
  );
};

const appendBoundedStderr = (current: string, chunk: string): string =>
  `${current}${chunk}`.slice(-MAX_STARTUP_STDERR_CHARS);

const connect = (input: ConnectOrStartCoreInput): Promise<CoreClient> =>
  CoreClient.connect({
    nodexHome: input.nodexHome,
    clientKind: "electron_host",
    buildId: input.buildId,
    connectionId: input.connectionId,
    maximumJsonResponseBytes: input.maximumJsonResponseBytes,
    requestTimeoutMs: input.requestTimeoutMs,
    signal: input.signal,
  });

export async function connectOrStartCore(
  input: ConnectOrStartCoreInput,
): Promise<CoreLaunchResult> {
  const launchStartedAt = performance.now();
  requireAbsolutePath(input.nodexHome, "Nodex home");
  const executablePath = resolveCoreExecutable(input);
  const artifactValidationStartedAt = performance.now();
  let expectedArtifactDigest: string;
  try {
    validateCoreExecutable(executablePath);
    expectedArtifactDigest = expectedCoreArtifactDigest(input, executablePath);
  } catch (cause) {
    throw new CoreStartupError(cause, { code: null, error: cause instanceof Error ? cause : null });
  }
  const artifactValidationMs = performance.now() - artifactValidationStartedAt;
  throwIfAborted(input.signal);
  const child = spawn(
    executablePath,
    [
      "--home",
      input.nodexHome,
      "--selection-policy",
      "prefer-current-artifact",
      "--launcher",
      "electron-host",
      ...(input.operatorListener
        ? [
            "--listen",
            input.operatorListener.address,
            ...(input.operatorListener.cert ? ["--cert", input.operatorListener.cert] : []),
            ...(input.operatorListener.key ? ["--key", input.operatorListener.key] : []),
          ]
        : []),
    ],
    {
      detached: true,
      windowsHide: true,
      env: {
        ...process.env,
        ...input.environment,
        NODEX_INTERNAL_APP_PACKAGED: input.isPackaged ? "true" : "false",
        NODEX_INTERNAL_STARTUP_EVENTS_VERSION: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const exit: ChildExitState = {
    code: null,
    error: null,
    exited: false,
    signal: null,
    stderr: "",
  };
  let authorityProcessId: number | null = null;
  const stderr = child.stderr as
    | (NonNullable<typeof child.stderr> & {
        unref?: () => void;
      })
    | null;
  stderr?.setEncoding("utf8");
  stderr?.on("data", (chunk: string) => {
    exit.stderr = appendBoundedStderr(exit.stderr, chunk);
  });
  stderr?.unref?.();
  child.once("error", (error) => {
    exit.error = error;
  });
  child.once("close", (code, signal) => {
    exit.code = code;
    exit.exited = true;
    exit.signal = signal;
    if (authorityProcessId === null) return;
    try {
      input.onAuthorityProcessExit?.({
        code,
        processId: authorityProcessId,
        signal,
        stderr: exit.stderr.trim(),
      });
    } catch {
      // Process-exit observation must not affect authority recovery.
    }
  });
  const startupTimeoutMs = input.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
  const startupHardTimeoutMs = input.startupHardTimeoutMs ?? DEFAULT_STARTUP_HARD_TIMEOUT_MS;
  const pollIntervalMs = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const selectionStartedAt = performance.now();
  try {
    const selection = await readSelectionResult(
      child,
      exit,
      startupTimeoutMs,
      startupHardTimeoutMs,
      input.nodexHome,
      input.onStartupEvent,
      input.signal,
    );
    const selectionMs = performance.now() - selectionStartedAt;
    // Windows' bootstrap waits for the detached authority and relays its exit.
    authorityProcessId = selection.disposition === "started" ? selection.descriptor.pid : null;
    if (selection.descriptor.artifact.sha256 !== expectedArtifactDigest) {
      throw new Error("Selected Core artifact does not match the launched candidate");
    }
    const startedProcessId = selection.disposition === "started" ? selection.descriptor.pid : null;
    let lastConnectionError: unknown;
    const connectStartedAt = performance.now();
    const connectionDeadline = Date.now() + startupTimeoutMs;

    while (Date.now() < connectionDeadline) {
      throwIfAborted(input.signal);
      if (exit.error) {
        throw new Error("Could not start native Rust Core", { cause: exit.error });
      }
      if (exit.exited && authorityProcessId !== null) {
        const status = exit.code === null ? "without an exit code" : `with code ${exit.code}`;
        const diagnostic = exit.stderr.trim();
        const suffix = diagnostic ? `: ${diagnostic}` : "";
        throw new Error(`Native Rust Core exited during startup ${status}${suffix}`);
      }

      try {
        const client = await connect(input);
        if (
          client.handshake.generation.manifest_digest !== selection.descriptor.manifest_digest ||
          client.handshake.generation.artifact_sha256 !== selection.descriptor.artifact.sha256 ||
          client.handshake.generation.start_nonce !== selection.descriptor.start_nonce
        ) {
          throw new Error("Core generation changed after selector completion");
        }
        const stdout = child.stdout as
          | (NonNullable<typeof child.stdout> & {
              unref?: () => void;
            })
          | null;
        stdout?.unref?.();
        child.unref();
        return {
          client,
          executablePath,
          startedProcessId,
          timings: {
            artifactValidationMs,
            connectMs: performance.now() - connectStartedAt,
            disposition: selection.disposition,
            reason: selection.reason,
            selectionMs,
            totalMs: performance.now() - launchStartedAt,
          },
        };
      } catch (error) {
        lastConnectionError = error;
      }
      await delay(pollIntervalMs, input.signal);
    }

    const diagnostic = exit.stderr.trim();
    const suffix = diagnostic ? `: ${diagnostic}` : "";
    throw new Error(`Native Rust Core did not become ready before the startup deadline${suffix}`, {
      cause: lastConnectionError,
    });
  } catch (error) {
    return terminateAfterStartupFailure(
      child,
      exit,
      input.signal?.aborted ? error : new CoreStartupError(error, exit),
    );
  }
}

const readSelectionResult = (
  child: ReturnType<typeof spawn>,
  exit: ChildExitState,
  timeoutMs: number,
  hardTimeoutMs: number,
  nodexHome: string,
  onStartupEvent?: (event: CoreStartupEvent) => void,
  signal?: AbortSignal,
): Promise<CoreSelectionResult> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const stdout = child.stdout;
    if (!stdout) {
      reject(new Error("Native Rust Core selection stdout is unavailable"));
      return;
    }
    stdout.setEncoding("utf8");
    let buffered = "";
    let startupEventCount = 0;
    let totalCharacters = 0;
    let inactivityTimeout: ReturnType<typeof setTimeout> | undefined;
    const onTimeout = (): void => {
      cleanup();
      reject(new Error("Native Rust Core selection timed out due to inactivity"));
    };
    const onHardTimeout = (): void => {
      cleanup();
      reject(new Error("Native Rust Core selection exceeded its hard deadline"));
    };
    const hardTimeout = setTimeout(onHardTimeout, hardTimeoutMs);
    const armTimeout = (): void => {
      clearTimeout(inactivityTimeout);
      inactivityTimeout = setTimeout(onTimeout, timeoutMs);
    };
    const cleanup = (): void => {
      clearTimeout(inactivityTimeout);
      clearTimeout(hardTimeout);
      stdout.removeListener("data", onData);
      child.removeListener("close", onClose);
      child.removeListener("error", onError);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      cleanup();
      reject(signal ? abortError(signal) : new Error("Core startup was aborted"));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(new Error("Could not start native Rust Core", { cause: error }));
    };
    const onClose = (code: number | null): void => {
      cleanup();
      const diagnostic = exit.stderr.trim();
      reject(
        new Error(
          `Native Rust Core exited before selection with code ${String(code)}${diagnostic ? `: ${diagnostic}` : ""}`,
        ),
      );
    };
    const onData = (chunk: string): void => {
      buffered += chunk;
      if (buffered.length > MAX_SELECTION_STDOUT_LINE_CHARS && !buffered.includes("\n")) {
        cleanup();
        reject(new Error("Native Rust Core selection result is oversized"));
        return;
      }
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        totalCharacters += line.length + 1;
        if (
          line.length > MAX_SELECTION_STDOUT_LINE_CHARS ||
          totalCharacters > MAX_SELECTION_STDOUT_CHARS
        ) {
          cleanup();
          reject(new Error("Native Rust Core selection result is oversized"));
          return;
        }
        try {
          const value = JSON.parse(line) as unknown;
          const startupEvent = parseCoreStartupEventFrame(value);
          if (startupEvent) {
            startupEventCount += 1;
            if (startupEventCount > MAX_STARTUP_EVENT_COUNT) {
              throw new Error("Native Rust Core returned too many startup events");
            }
            try {
              onStartupEvent?.(startupEvent);
            } catch {
              // Startup events are advisory and must not affect authority selection.
            }
            armTimeout();
            continue;
          }
          const selection = parseCoreSelectionResult(value, nodexHome);
          cleanup();
          resolve(selection);
          return;
        } catch (error) {
          cleanup();
          reject(new Error("Native Rust Core selection result is invalid", { cause: error }));
          return;
        }
      }
    };
    armTimeout();
    stdout.on("data", onData);
    child.once("close", onClose);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
