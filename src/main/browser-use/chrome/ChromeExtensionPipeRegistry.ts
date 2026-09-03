import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import type {
  BrowserUsePeerAuthorizationResult,
  BrowserUseSocketPeerAuthorizer,
} from "../browser-use-peer-authorizer";
import {
  BrowserUseNativePipeFrameDecoder,
  encodeBrowserUseNativePipeFrame,
} from "../native-pipe-framing";
import { resolveBrowserUseNativePipeDirectory } from "../browser-use-native-pipe-server";
import {
  getChromeBrowserFamily,
  type ChromeBrowserAuthority,
  type ChromeBrowserFamily,
} from "./ChromeBrowserFamilyRegistry";

const DEFAULT_REQUEST_TIMEOUT_MS = 1_000;
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 5_000;
const WATCH_DEBOUNCE_MS = 25;
const MAX_CANDIDATE_SOCKETS = 64;
const MAX_CONCURRENT_PROBES = 8;
const PROBE_SESSION_ID = "nodex-chrome-provider-probe";

interface JsonRpcResponse {
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
  readonly id: number;
  readonly jsonrpc: "2.0";
  readonly result?: unknown;
}

interface ChromeExtensionBackendInfo {
  readonly family: ChromeBrowserFamily;
  readonly extensionId: string;
  readonly extensionInstanceId: string;
}

interface RegisteredChromeExtension extends ChromeExtensionBackendInfo {
  readonly socketPath: string;
}

export interface ChromeExtensionInstanceSnapshot extends ChromeExtensionBackendInfo {}

export interface ChromeExtensionPipeRegistrySnapshot {
  readonly instances: readonly ChromeExtensionInstanceSnapshot[];
  readonly providerReady: boolean;
  readonly revision: number;
}

export interface ChromeExtensionFocusInput {
  readonly extensionInstanceId: string;
  readonly sessionId: string;
  readonly tabId: string;
}

export interface ChromeExtensionPipeRegistryOptions {
  readonly authority: ChromeBrowserAuthority;
  /** Restricts discovery to exact socket basenames, primarily for isolated runtime probes. */
  readonly candidateSocketNames?: readonly string[];
  readonly directory?: string;
  readonly expectedPeerIdentity: ChromeNativeHostPeerIdentity;
  readonly healthCheckIntervalMs?: number;
  readonly onDiagnostic?: (diagnostic: { readonly code: string; readonly detail?: string }) => void;
  readonly onSnapshot?: (snapshot: ChromeExtensionPipeRegistrySnapshot) => void;
  readonly requestTimeoutMs?: number;
  readonly socketPeerAuthorizer: BrowserUseSocketPeerAuthorizer;
}

export interface ChromeNativeHostPeerIdentity {
  readonly signingIdentifier: string;
  readonly teamId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoundedIdentifier(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024) return null;
  return value.includes("\0") ? null : value;
}

function parseBackendInfo(
  value: unknown,
  authority: ChromeBrowserAuthority,
): ChromeExtensionBackendInfo | null {
  if (!isObject(value) || value.type !== "extension" || !isObject(value.metadata)) return null;
  const familyName = parseBoundedIdentifier(value.family);
  if (!familyName) return null;
  const family = getChromeBrowserFamily(authority, familyName);
  if (!family) return null;
  const extensionInstanceId = parseBoundedIdentifier(value.metadata.extensionInstanceId);
  const extensionId = parseBoundedIdentifier(value.metadata.extensionId);
  if (!extensionInstanceId || !extensionId) return null;
  if (!family.extensionIds.includes(extensionId)) return null;
  return {
    extensionId,
    extensionInstanceId,
    family: family.family,
  };
}

function authorizeExpectedPeer(
  socket: net.Socket,
  authorizer: BrowserUseSocketPeerAuthorizer,
  expected: ChromeNativeHostPeerIdentity,
): BrowserUsePeerAuthorizationResult {
  const result = authorizer(socket);
  if (result.teamId !== expected.teamId) {
    throw new Error("Chrome extension pipe peer signing team does not match the native host");
  }
  if (result.signingIdentifier !== expected.signingIdentifier) {
    throw new Error("Chrome extension pipe peer signing identifier does not match the native host");
  }
  // The bundled addon's generic allowlist names Codex app processes. For this reverse connection,
  // its Security.framework-derived identity is instead bound to the exact attested native host.
  return { ...result, authorized: true };
}

function safeErrorCode(error: unknown): string {
  if (!isObject(error)) return "unknown";
  if (typeof error.code === "string" && error.code.length <= 64) return error.code;
  if (typeof error.name === "string" && error.name.length <= 64) return error.name;
  return "error";
}

export function isSafeChromeExtensionSocketDirectoryMetadata(
  metadata: { readonly mode: number; readonly uid: number },
  currentUserId: number | undefined,
): boolean {
  if (currentUserId !== undefined && metadata.uid !== currentUserId) return false;
  const sharedWritable = (metadata.mode & 0o022) !== 0;
  return !sharedWritable || (metadata.mode & 0o1000) !== 0;
}

async function validateSocketPath(directory: string, socketPath: string): Promise<void> {
  const resolvedDirectory = path.resolve(directory);
  const resolvedSocket = path.resolve(socketPath);
  if (path.dirname(resolvedSocket) !== resolvedDirectory) {
    throw new Error("Chrome extension socket escaped the controlled directory");
  }

  const [directoryStats, socketStats] = await Promise.all([
    fs.lstat(resolvedDirectory),
    fs.lstat(resolvedSocket),
  ]);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error("Chrome extension socket directory is invalid");
  }
  if (!socketStats.isSocket() || socketStats.isSymbolicLink()) {
    throw new Error("Chrome extension endpoint is not a Unix socket");
  }
  const currentUserId = process.getuid?.();
  if (!isSafeChromeExtensionSocketDirectoryMetadata(directoryStats, currentUserId)) {
    throw new Error("Chrome extension socket directory has unsafe ownership or permissions");
  }
  if (currentUserId !== undefined && socketStats.uid !== currentUserId) {
    throw new Error("Chrome extension endpoint is owned by another user");
  }
  if ((socketStats.mode & 0o022) !== 0) {
    throw new Error("Chrome extension endpoint has unsafe write permissions");
  }
}

function isJsonRpcResponse(value: unknown, id: number): value is JsonRpcResponse {
  return isObject(value) && value.jsonrpc === "2.0" && value.id === id;
}

let nextRequestId = 1;

async function requestSocket(
  socketPath: string,
  method: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  socketPeerAuthorizer: BrowserUseSocketPeerAuthorizer,
  expectedPeerIdentity: ChromeNativeHostPeerIdentity,
): Promise<unknown> {
  const requestId = nextRequestId;
  nextRequestId = nextRequestId >= Number.MAX_SAFE_INTEGER ? 1 : nextRequestId + 1;
  const socket = net.createConnection(socketPath);
  const decoder = new BrowserUseNativePipeFrameDecoder();

  try {
    return await new Promise<unknown>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: { readonly error?: unknown; readonly result?: unknown }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        socket.removeAllListeners();
        if (outcome.error !== undefined) reject(outcome.error);
        else resolve(outcome.result);
      };
      const timeout = setTimeout(
        () => finish({ error: new Error("Chrome extension pipe request timed out") }),
        timeoutMs,
      );
      timeout.unref();

      socket.once("connect", () => {
        try {
          authorizeExpectedPeer(socket, socketPeerAuthorizer, expectedPeerIdentity);
          socket.write(
            encodeBrowserUseNativePipeFrame(
              JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
            ),
          );
        } catch (error) {
          finish({ error });
        }
      });
      socket.on("data", (chunk) => {
        try {
          const matchingResponses = decoder
            .push(chunk)
            .map((message) => JSON.parse(message) as unknown)
            .filter((message) => isJsonRpcResponse(message, requestId));
          if (matchingResponses.length === 0) return;
          if (matchingResponses.length !== 1) {
            finish({ error: new Error("Chrome extension pipe returned a duplicate response id") });
            return;
          }
          const response = matchingResponses[0];
          if (!response) return;
          if (response.error !== undefined) {
            const message =
              isObject(response.error) && typeof response.error.message === "string"
                ? response.error.message.slice(0, 512)
                : "Chrome extension pipe request failed";
            finish({ error: new Error(message) });
            return;
          }
          finish({ result: response.result });
        } catch (error) {
          finish({ error });
        }
      });
      socket.once("error", (error) => finish({ error }));
      socket.once("close", () =>
        finish({ error: new Error("Chrome extension pipe closed before responding") }),
      );
    });
  } finally {
    socket.destroy();
  }
}

async function mapConcurrent<A, B>(
  values: readonly A[],
  concurrency: number,
  transform: (value: A) => Promise<B>,
): Promise<B[]> {
  const results = new Array<B>(values.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= values.length) return;
        const value = values[index];
        if (value === undefined) return;
        results[index] = await transform(value);
      }
    }),
  );
  return results;
}

function publicSnapshot(
  instances: readonly RegisteredChromeExtension[],
  revision: number,
): ChromeExtensionPipeRegistrySnapshot {
  return {
    instances: instances.map(({ extensionId, extensionInstanceId, family }) => ({
      extensionId,
      extensionInstanceId,
      family,
    })),
    providerReady: instances.length > 0,
    revision,
  };
}

function sameInstances(
  left: readonly RegisteredChromeExtension[],
  right: readonly RegisteredChromeExtension[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((entry, index) => {
    const candidate = right[index];
    return (
      candidate !== undefined &&
      entry.extensionId === candidate.extensionId &&
      entry.extensionInstanceId === candidate.extensionInstanceId &&
      entry.family === candidate.family &&
      entry.socketPath === candidate.socketPath
    );
  });
}

/** Bounded registry for verified Chrome extension native-pipe backends. */
export class ChromeExtensionPipeRegistry {
  private readonly authority: ChromeBrowserAuthority;
  private readonly candidateSocketNames: ReadonlySet<string> | null;
  private readonly directory: string;
  private readonly expectedPeerIdentity: ChromeNativeHostPeerIdentity;
  private readonly healthCheckIntervalMs: number;
  private readonly onDiagnostic: NonNullable<ChromeExtensionPipeRegistryOptions["onDiagnostic"]>;
  private readonly onSnapshot: NonNullable<ChromeExtensionPipeRegistryOptions["onSnapshot"]>;
  private readonly requestTimeoutMs: number;
  private readonly socketPeerAuthorizer: BrowserUseSocketPeerAuthorizer;
  private directoryWatcher: FSWatcher | null = null;
  private healthCheckTimer: NodeJS.Timeout | null = null;
  private instances: readonly RegisteredChromeExtension[] = [];
  private readonly listeners = new Set<(snapshot: ChromeExtensionPipeRegistrySnapshot) => void>();
  private parentWatcher: FSWatcher | null = null;
  private refreshPromise: Promise<ChromeExtensionPipeRegistrySnapshot> | null = null;
  private revision = 0;
  private started = false;
  private watchDebounceTimer: NodeJS.Timeout | null = null;

  constructor(options: ChromeExtensionPipeRegistryOptions) {
    this.authority = options.authority;
    if (
      (options.candidateSocketNames?.length ?? 0) > MAX_CANDIDATE_SOCKETS ||
      options.candidateSocketNames?.some(
        (name) => !name || name.length > 255 || name.includes("\0") || path.basename(name) !== name,
      )
    ) {
      throw new Error("Chrome extension candidate socket name is invalid");
    }
    this.candidateSocketNames = options.candidateSocketNames
      ? new Set(options.candidateSocketNames.slice(0, MAX_CANDIDATE_SOCKETS))
      : null;
    this.directory = path.resolve(
      options.directory ?? resolveBrowserUseNativePipeDirectory(process.platform),
    );
    this.expectedPeerIdentity = options.expectedPeerIdentity;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS;
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.onSnapshot = options.onSnapshot ?? (() => undefined);
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.socketPeerAuthorizer = options.socketPeerAuthorizer;
  }

  snapshot(): ChromeExtensionPipeRegistrySnapshot {
    return publicSnapshot(this.instances, this.revision);
  }

  async start(): Promise<ChromeExtensionPipeRegistrySnapshot> {
    if (this.started) return this.snapshot();
    this.started = true;
    this.armParentWatcher();
    this.armDirectoryWatcher();
    const snapshot = await this.refresh();
    this.armDirectoryWatcher();
    this.updateHealthCheck(snapshot.providerReady);
    return snapshot;
  }

  stop(): void {
    this.started = false;
    this.parentWatcher?.close();
    this.parentWatcher = null;
    this.directoryWatcher?.close();
    this.directoryWatcher = null;
    if (this.healthCheckTimer !== null) clearInterval(this.healthCheckTimer);
    this.healthCheckTimer = null;
    if (this.watchDebounceTimer !== null) clearTimeout(this.watchDebounceTimer);
    this.watchDebounceTimer = null;
    this.instances = [];
  }

  subscribe(listener: (snapshot: ChromeExtensionPipeRegistrySnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  refresh(): Promise<ChromeExtensionPipeRegistrySnapshot> {
    this.refreshPromise ??= this.refreshUnlocked().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async focusPresentation(input: ChromeExtensionFocusInput): Promise<void> {
    const extensionInstanceId = parseBoundedIdentifier(input.extensionInstanceId);
    const sessionId = parseBoundedIdentifier(input.sessionId);
    const numericTabId = Number(input.tabId);
    if (!extensionInstanceId || !sessionId) {
      throw new Error("Chrome presentation identity is invalid");
    }
    if (!Number.isSafeInteger(numericTabId) || numericTabId < 0) {
      throw new Error("Chrome presentation tab id is invalid");
    }

    let instance = this.instances.find(
      (candidate) => candidate.extensionInstanceId === extensionInstanceId,
    );
    if (!instance) {
      await this.refresh();
      instance = this.instances.find(
        (candidate) => candidate.extensionInstanceId === extensionInstanceId,
      );
    }
    if (!instance) throw new Error("Chrome extension instance is unavailable");

    const deadline = Date.now() + this.requestTimeoutMs;
    const remainingTimeout = (): number => {
      const remaining = deadline - Date.now();
      if (remaining > 0) return remaining;
      throw new Error("Chrome extension focus deadline expired");
    };
    await validateSocketPath(this.directory, instance.socketPath);
    const currentInfo = parseBackendInfo(
      await requestSocket(
        instance.socketPath,
        "getInfo",
        { session_id: sessionId, turn_id: "pip-focus" },
        remainingTimeout(),
        this.socketPeerAuthorizer,
        this.expectedPeerIdentity,
      ),
      this.authority,
    );
    if (
      !currentInfo ||
      currentInfo.extensionInstanceId !== instance.extensionInstanceId ||
      currentInfo.extensionId !== instance.extensionId ||
      currentInfo.family !== instance.family
    ) {
      throw new Error("Chrome extension instance changed before focus");
    }
    await requestSocket(
      instance.socketPath,
      "focusTab",
      { session_id: sessionId, tabId: numericTabId },
      remainingTimeout(),
      this.socketPeerAuthorizer,
      this.expectedPeerIdentity,
    );
  }

  private armDirectoryWatcher(): void {
    if (!this.started || this.directoryWatcher !== null) return;
    try {
      this.directoryWatcher = watch(this.directory, { persistent: false }, () => {
        this.scheduleWatchedRefresh();
      });
      this.directoryWatcher.once("error", (error) => {
        this.onDiagnostic({ code: "directory-watch-failed", detail: safeErrorCode(error) });
        this.directoryWatcher?.close();
        this.directoryWatcher = null;
      });
    } catch (error) {
      if (!isObject(error) || error.code !== "ENOENT") {
        this.onDiagnostic({ code: "directory-watch-failed", detail: safeErrorCode(error) });
      }
    }
  }

  private armParentWatcher(): void {
    if (!this.started || this.parentWatcher !== null) return;
    try {
      const expectedName = path.basename(this.directory);
      this.parentWatcher = watch(
        path.dirname(this.directory),
        { persistent: false },
        (_event, fileName) => {
          if (fileName !== null && fileName.toString() !== expectedName) return;
          this.directoryWatcher?.close();
          this.directoryWatcher = null;
          this.scheduleWatchedRefresh();
        },
      );
      this.parentWatcher.once("error", (error) => {
        this.onDiagnostic({ code: "parent-watch-failed", detail: safeErrorCode(error) });
        this.parentWatcher?.close();
        this.parentWatcher = null;
      });
    } catch (error) {
      this.onDiagnostic({ code: "parent-watch-failed", detail: safeErrorCode(error) });
    }
  }

  private scheduleWatchedRefresh(): void {
    if (!this.started || this.watchDebounceTimer !== null) return;
    this.watchDebounceTimer = setTimeout(() => {
      this.watchDebounceTimer = null;
      this.armDirectoryWatcher();
      void this.refresh().catch((error) => {
        this.onDiagnostic({ code: "watch-refresh-failed", detail: safeErrorCode(error) });
      });
    }, WATCH_DEBOUNCE_MS);
    this.watchDebounceTimer.unref();
  }

  private updateHealthCheck(active: boolean): void {
    if (!this.started || !active) {
      if (this.healthCheckTimer !== null) clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
      return;
    }
    if (this.healthCheckTimer !== null) return;
    this.healthCheckTimer = setInterval(() => {
      void this.refresh().catch((error) => {
        this.onDiagnostic({ code: "health-check-failed", detail: safeErrorCode(error) });
      });
    }, this.healthCheckIntervalMs);
    this.healthCheckTimer.unref();
  }

  private async refreshUnlocked(): Promise<ChromeExtensionPipeRegistrySnapshot> {
    let names: string[];
    try {
      const directoryStats = await fs.lstat(this.directory);
      const currentUserId = process.getuid?.();
      if (
        !directoryStats.isDirectory() ||
        directoryStats.isSymbolicLink() ||
        !isSafeChromeExtensionSocketDirectoryMetadata(directoryStats, currentUserId)
      ) {
        throw new Error("Chrome extension socket directory failed ownership checks");
      }
      names = (await fs.readdir(this.directory))
        .filter((name) => this.candidateSocketNames?.has(name) ?? true)
        .sort()
        .slice(0, MAX_CANDIDATE_SOCKETS);
    } catch (error) {
      if (isObject(error) && error.code === "ENOENT") return this.replaceInstances([]);
      this.onDiagnostic({ code: "directory-invalid", detail: safeErrorCode(error) });
      return this.replaceInstances([]);
    }

    const candidates = names.map((name) => path.join(this.directory, name));
    const inspected = await mapConcurrent(candidates, MAX_CONCURRENT_PROBES, async (socketPath) => {
      try {
        await validateSocketPath(this.directory, socketPath);
        const info = parseBackendInfo(
          await requestSocket(
            socketPath,
            "getInfo",
            { session_id: PROBE_SESSION_ID, turn_id: PROBE_SESSION_ID },
            this.requestTimeoutMs,
            this.socketPeerAuthorizer,
            this.expectedPeerIdentity,
          ),
          this.authority,
        );
        return info ? ({ ...info, socketPath } satisfies RegisteredChromeExtension) : null;
      } catch {
        return null;
      }
    });

    const instanceCounts = new Map<string, number>();
    for (const instance of inspected) {
      if (!instance) continue;
      instanceCounts.set(
        instance.extensionInstanceId,
        (instanceCounts.get(instance.extensionInstanceId) ?? 0) + 1,
      );
    }
    const instances = inspected
      .filter((instance): instance is RegisteredChromeExtension => {
        if (!instance) return false;
        if (instanceCounts.get(instance.extensionInstanceId) === 1) return true;
        this.onDiagnostic({ code: "duplicate-extension-instance" });
        return false;
      })
      .sort((left, right) => left.extensionInstanceId.localeCompare(right.extensionInstanceId));
    return this.replaceInstances(instances);
  }

  private replaceInstances(
    instances: readonly RegisteredChromeExtension[],
  ): ChromeExtensionPipeRegistrySnapshot {
    if (sameInstances(this.instances, instances)) return this.snapshot();
    this.instances = instances;
    this.revision += 1;
    const snapshot = this.snapshot();
    this.updateHealthCheck(snapshot.providerReady);
    this.onSnapshot(snapshot);
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }
}
