import { EventEmitter } from "node:events";
import os from "node:os";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import type {
  ClientRequest,
  InitializeParams,
  InitializeResponse,
  ServerNotification,
  ServerRequest,
} from "@nodex/codex-app-server-protocol";
import type { CodexConnectionState } from "../../shared/types";
import { getLogger } from "../logging/logger";

const DEFAULT_CONNECT_TIMEOUT_MS = 20_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const PATH_DELIMITER = process.platform === "win32" ? ";" : ":";

const DEFAULT_EXTRA_BINARY_SEARCH_PATHS =
  process.platform === "darwin"
    ? [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        `${os.homedir()}/.bun/bin`,
        `${os.homedir()}/.npm-global/bin`,
        `${os.homedir()}/.local/bin`,
      ]
    : [`${os.homedir()}/.bun/bin`, `${os.homedir()}/.local/bin`];
const logger = getLogger({ subsystem: "codex", component: "app-server-client" });

type JsonRpcId = number | string;

interface JsonRpcRequest {
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: JsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface PendingRequest {
  method: string;
  startedAt: number;
  timeout: NodeJS.Timeout;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

export interface CodexServerRequest {
  id: JsonRpcId;
  method: ServerRequest["method"];
  params: ServerRequest["params"];
}

export interface CodexServerNotification {
  method: ServerNotification["method"];
  params: ServerNotification["params"];
}

export interface CodexAppServerClientOptions {
  binaryPath?: string;
  args?: string[];
  env?: NodeJS.ProcessEnv;
  additionalSearchPaths?: string[];
  missingBinaryMessage?: string;
  initializeTimeoutMs?: number;
  requestTimeoutMs?: number;
  clientInfo?: {
    name: string;
    title: string;
    version: string;
  };
}

export class CodexRpcError extends Error {
  code: number;
  data?: unknown;
  retryable: boolean;

  constructor(message: string, code: number, data?: unknown) {
    super(message);
    this.name = "CodexRpcError";
    this.code = code;
    this.data = data;
    this.retryable = code === -32001;
  }
}

function splitPathEntries(pathValue: string | undefined): string[] {
  if (!pathValue) return [];
  return pathValue
    .split(PATH_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function dedupePathEntries(entries: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const entry of entries) {
    if (!entry || seen.has(entry)) continue;
    seen.add(entry);
    deduped.push(entry);
  }

  return deduped;
}

function resolvePathEnvKey(env: NodeJS.ProcessEnv): string {
  const explicit = Object.keys(env).find((key) => key.toLowerCase() === "path");
  return explicit ?? "PATH";
}

function createSpawnEnv(baseEnv: NodeJS.ProcessEnv, additionalSearchPaths: string[]): NodeJS.ProcessEnv {
  const pathKey = resolvePathEnvKey(baseEnv);
  const currentPathEntries = splitPathEntries(baseEnv[pathKey]);
  const mergedPathEntries = dedupePathEntries([
    ...currentPathEntries,
    ...DEFAULT_EXTRA_BINARY_SEARCH_PATHS,
    ...additionalSearchPaths,
  ]);

  return {
    ...baseEnv,
    [pathKey]: mergedPathEntries.join(PATH_DELIMITER),
  };
}

function truncatePreview(value: string, maxLength = 160): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function summarizeRpcParams(method: string, params: unknown): Record<string, unknown> | undefined {
  if (typeof params !== "object" || params === null) return undefined;
  const candidate = params as Record<string, unknown>;

  if (method === "thread/start") {
    return {
      cwd: typeof candidate.cwd === "string" ? candidate.cwd : null,
      model: typeof candidate.model === "string" ? candidate.model : null,
    };
  }

  if (method === "turn/start" || method === "turn/steer") {
    const input = Array.isArray(candidate.input) ? candidate.input : [];
    const firstText = input.find((item) => {
      return typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "text";
    }) as Record<string, unknown> | undefined;
    const prompt = typeof firstText?.text === "string" ? firstText.text : "";

    return {
      threadId: typeof candidate.threadId === "string" ? candidate.threadId : null,
      cwd: typeof candidate.cwd === "string" ? candidate.cwd : null,
      model: typeof candidate.model === "string" ? candidate.model : null,
      effort: typeof candidate.effort === "string" ? candidate.effort : null,
      promptLength: prompt.length,
      promptPreview: prompt ? truncatePreview(prompt) : null,
    };
  }

  if (method === "thread/read" || method === "thread/resume" || method === "thread/archive" || method === "thread/unarchive") {
    return {
      threadId: typeof candidate.threadId === "string" ? candidate.threadId : null,
      includeTurns: typeof candidate.includeTurns === "boolean" ? candidate.includeTurns : undefined,
    };
  }

  if (method === "turn/interrupt") {
    return {
      threadId: typeof candidate.threadId === "string" ? candidate.threadId : null,
      turnId: typeof candidate.turnId === "string" ? candidate.turnId : null,
    };
  }

  if (method.startsWith("account/")) {
    return {
      refreshToken: typeof candidate.refreshToken === "boolean" ? candidate.refreshToken : undefined,
      loginId: typeof candidate.loginId === "string" ? candidate.loginId : undefined,
    };
  }

  return {
    keys: Object.keys(candidate).slice(0, 12),
  };
}

type ClientRequestMethod = ClientRequest["method"];
type ClientRequestParams<TMethod extends ClientRequestMethod> = Extract<ClientRequest, { method: TMethod }>["params"];

export class CodexAppServerClient extends EventEmitter {
  private readonly binaryPath: string;
  private readonly args: string[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly additionalSearchPaths: string[];
  private readonly missingBinaryMessage: string;
  private readonly initializeTimeoutMs: number;
  private readonly requestTimeoutMs: number;
  private readonly clientInfo: { name: string; title: string; version: string };

  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private requestIdCounter = 1;
  private pendingRequests = new Map<string, PendingRequest>();
  private readyDeferred!: Deferred<void>;
  private initialized = false;
  private isStopping = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private connectionState: CodexConnectionState = {
    status: "disconnected",
    retries: 0,
  };
  private serverRequestHandler: ((request: CodexServerRequest) => Promise<unknown>) | null = null;

  constructor(options?: CodexAppServerClientOptions) {
    super();
    this.binaryPath = options?.binaryPath ?? "codex";
    this.args = options?.args ?? ["app-server", "--listen", "stdio://"];
    this.env = { ...(options?.env ?? process.env) };
    this.additionalSearchPaths = options?.additionalSearchPaths ?? [];
    this.missingBinaryMessage = options?.missingBinaryMessage ?? "Configured Codex runtime is missing or unavailable.";
    this.initializeTimeoutMs = options?.initializeTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.clientInfo = options?.clientInfo ?? {
      name: "nodex",
      title: "Nodex",
      version: "0.0.0",
    };
    this.resetReadyDeferred();
  }

  getState(): CodexConnectionState {
    return this.connectionState;
  }

  setServerRequestHandler(handler: (request: CodexServerRequest) => Promise<unknown>): void {
    this.serverRequestHandler = handler;
  }

  async start(): Promise<void> {
    if (this.child) {
      logger.debug("Codex app-server client start reused existing child");
      await this.waitUntilReady();
      return;
    }

    this.isStopping = false;
    logger.info("Starting Codex app-server client", {
      binaryPath: this.binaryPath,
      args: this.args,
      additionalSearchPaths: this.additionalSearchPaths,
    });
    await this.spawnAndInitialize();
  }

  async stop(): Promise<void> {
    this.isStopping = true;
    this.clearReconnectTimer();
    logger.info("Stopping Codex app-server client", {
      hadChild: Boolean(this.child),
      pendingRequests: this.pendingRequests.size,
    });

    const current = this.child;
    if (current) {
      current.removeAllListeners();
      current.stdout.removeAllListeners();
      current.stderr.removeAllListeners();
      current.kill();
    }

    this.child = null;
    this.initialized = false;
    this.rejectAllPending(new Error("Codex app-server client stopped"));
    this.resetReadyDeferred();
    this.setConnectionState({ status: "disconnected", retries: this.reconnectAttempts });
  }

  async waitUntilReady(): Promise<void> {
    if (this.initialized && this.connectionState.status === "connected") return;
    await this.readyDeferred.promise;
  }

  async request<TMethod extends ClientRequestMethod, TResult>(
    method: TMethod,
    ...args: ClientRequestParams<TMethod> extends undefined ? [] | [params: ClientRequestParams<TMethod>] : [params: ClientRequestParams<TMethod>]
  ): Promise<TResult>;
  async request<TResult>(method: string, params?: unknown): Promise<TResult>;
  async request(
    method: string,
    ...args: [params?: unknown]
  ): Promise<unknown> {
    if (!this.child) {
      await this.start();
    }
    await this.waitUntilReady();
    return this.requestRaw(method, args[0]);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    if (!this.child) {
      await this.start();
    }
    await this.waitUntilReady();
    this.writeMessage({ method, params } satisfies JsonRpcNotification);
  }

  private setMissingBinaryState(): void {
    this.setConnectionState({
      status: "missingBinary",
      retries: this.reconnectAttempts,
      message: this.missingBinaryMessage,
    });
  }

  private async spawnAndInitialize(): Promise<void> {
    this.clearReconnectTimer();
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    this.resetReadyDeferred();
    this.initialized = false;
    const spawnEnv = createSpawnEnv(this.env, this.additionalSearchPaths);
    const startedAt = Date.now();

    const probe = spawnSync(this.binaryPath, ["--version"], {
      stdio: "ignore",
      env: spawnEnv,
    });
    if (probe.error && (probe.error as NodeJS.ErrnoException).code === "ENOENT") {
      const error = new Error(`Missing Codex binary: ${this.binaryPath}`);
      logger.error("Codex binary probe failed", {
        binaryPath: this.binaryPath,
        error,
      });
      this.setMissingBinaryState();
      this.readyDeferred.reject(error);
      throw error;
    }

    this.setConnectionState({ status: "starting", retries: this.reconnectAttempts });

    const child = spawn(this.binaryPath, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: spawnEnv,
    });

    this.child = child;
    logger.info("Spawned Codex app-server process", {
      pid: child.pid ?? null,
      binaryPath: this.binaryPath,
      args: this.args,
    });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.handleStdoutData(chunk);
    });

    child.stderr.on("data", (chunk: string) => {
      this.handleStderrData(chunk);
    });

    child.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        logger.error("Codex app-server spawn failed because binary was not found", {
          binaryPath: this.binaryPath,
          error,
        });
        this.setMissingBinaryState();
        this.readyDeferred.reject(new Error(`Missing Codex binary: ${this.binaryPath}`));
        return;
      }

      logger.error("Codex app-server child emitted process error", {
        error,
        binaryPath: this.binaryPath,
      });
      this.setConnectionState({
        status: "error",
        retries: this.reconnectAttempts,
        message,
      });
      this.readyDeferred.reject(error);
    });

    child.on("exit", (code, signal) => {
      this.handleChildExit(code, signal);
    });

    try {
      await this.initializeHandshake();
      this.reconnectAttempts = 0;
      logger.info("Codex app-server client connected", {
        pid: child.pid ?? null,
        durationMs: Date.now() - startedAt,
      });
      this.setConnectionState({
        status: "connected",
        retries: this.reconnectAttempts,
        lastConnectedAt: Date.now(),
      });
      this.readyDeferred.resolve();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        this.connectionState.status === "missingBinary" ||
        message.includes("Missing Codex binary")
      ) {
        this.readyDeferred.reject(error);
        throw error;
      }

      logger.error("Codex app-server initialization failed", {
        error,
        durationMs: Date.now() - startedAt,
      });
      this.setConnectionState({
        status: "error",
        retries: this.reconnectAttempts,
        message,
      });
      this.readyDeferred.reject(error);
      if (!this.isStopping) {
        void this.scheduleReconnect();
      }
      throw error;
    }
  }

  private async initializeHandshake(): Promise<void> {
    const initializeParams: InitializeParams = {
      clientInfo: this.clientInfo,
      capabilities: {
        experimentalApi: true,
      },
    };

    const initializePromise = this.requestRaw<"initialize", InitializeResponse>(
      "initialize",
      initializeParams,
      true,
    );

    const timeoutPromise = sleep(this.initializeTimeoutMs).then(() => {
      throw new Error(`Codex app-server initialize timed out after ${this.initializeTimeoutMs}ms`);
    });

    await Promise.race([initializePromise, timeoutPromise]);
    this.writeMessage({ method: "initialized" } satisfies JsonRpcNotification);
    this.initialized = true;
  }

  private async requestRaw<TMethod extends ClientRequestMethod, TResult>(
    method: TMethod,
    params: ClientRequestParams<TMethod> | undefined,
    skipInitialization?: boolean,
  ): Promise<TResult>;
  private async requestRaw<TResult>(method: string, params?: unknown, skipInitialization?: boolean): Promise<TResult>;
  private async requestRaw(
    method: string,
    params?: unknown,
    skipInitialization = false,
  ): Promise<unknown> {
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error("Codex app-server is not running");
    }

    if (!skipInitialization && !this.initialized) {
      throw new Error("Codex app-server is not initialized");
    }

    const id = this.requestIdCounter;
    this.requestIdCounter += 1;

    const message: JsonRpcRequest = { id, method, params };
    logger.info("Sending Codex RPC request", {
      rpcId: id,
      method,
      params: summarizeRpcParams(method, params),
    });

    const promise = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        logger.error("Codex RPC request timed out", {
          rpcId: id,
          method,
          timeoutMs: this.requestTimeoutMs,
        });
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(String(id), {
        method,
        startedAt: Date.now(),
        timeout,
        resolve,
        reject,
      });
    });

    this.writeMessage(message);
    return promise;
  }

  private writeMessage(message: JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    if (!this.child || this.child.stdin.destroyed) {
      throw new Error("Cannot write to Codex app-server; process is not available");
    }

    const payload = `${JSON.stringify(message)}\n`;
    this.child.stdin.write(payload);
  }

  private handleStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) break;

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) continue;

      this.handleStdoutLine(line);
    }
  }

  private handleStderrData(chunk: string): void {
    this.stderrBuffer += chunk;

    while (true) {
      const newlineIndex = this.stderrBuffer.indexOf("\n");
      if (newlineIndex < 0) break;

      const line = this.stderrBuffer.slice(0, newlineIndex).trim();
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      logger.warn("Codex app-server stderr", { line });
      this.emit("stderr", line);
    }
  }

  private handleStdoutLine(line: string): void {
    let parsed: unknown;

    try {
      parsed = JSON.parse(line);
    } catch {
      logger.error("Codex app-server emitted invalid JSON", { line: truncatePreview(line, 300) });
      this.emit("protocolError", `Invalid JSON from codex app-server: ${line}`);
      return;
    }

    if (typeof parsed !== "object" || parsed === null) {
      logger.error("Codex app-server emitted non-object JSON-RPC payload", {
        line: truncatePreview(line, 300),
      });
      this.emit("protocolError", `Unexpected non-object message from codex app-server: ${line}`);
      return;
    }

    const candidate = parsed as Record<string, unknown>;

    if ("method" in candidate && typeof candidate.method === "string") {
      if ("id" in candidate) {
        const request = candidate as unknown as CodexServerRequest;
        void this.handleServerRequest(request);
        return;
      }

      this.emit("notification", {
        method: candidate.method,
        params: candidate.params,
      } as CodexServerNotification);
      return;
    }

    if ("id" in candidate) {
      this.handleResponse(candidate as unknown as JsonRpcResponse);
      return;
    }

    this.emit("protocolError", `Unrecognized app-server message: ${line}`);
  }

  private handleResponse(response: JsonRpcResponse): void {
    const pending = this.pendingRequests.get(String(response.id));
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(String(response.id));
    const durationMs = Date.now() - pending.startedAt;

    if (response.error) {
      logger.error("Codex RPC request failed", {
        rpcId: response.id,
        method: pending.method,
        durationMs,
        errorCode: response.error.code,
        errorMessage: response.error.message,
      });
      pending.reject(
        new CodexRpcError(response.error.message, response.error.code, response.error.data),
      );
      return;
    }

    logger.info("Codex RPC request completed", {
      rpcId: response.id,
      method: pending.method,
      durationMs,
    });
    pending.resolve(response.result);
  }

  private async handleServerRequest(request: CodexServerRequest): Promise<void> {
    logger.info("Received Codex server request", {
      requestId: request.id,
      method: request.method,
      params: summarizeRpcParams(request.method, request.params),
    });
    this.emit("serverRequest", request);

    if (!this.serverRequestHandler) {
      this.writeMessage({
        id: request.id,
        error: {
          code: -32601,
          message: `No server request handler registered for '${request.method}'`,
        },
      } satisfies JsonRpcResponse);
      return;
    }

    try {
      const result = await this.serverRequestHandler(request);
      logger.info("Resolved Codex server request", {
        requestId: request.id,
        method: request.method,
      });
      this.writeMessage({
        id: request.id,
        result: result ?? {},
      } satisfies JsonRpcResponse);
    } catch (error) {
      logger.error("Failed Codex server request handler", {
        requestId: request.id,
        method: request.method,
        error,
      });
      this.writeMessage({
        id: request.id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : String(error),
        },
      } satisfies JsonRpcResponse);
    }
  }

  private handleChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.child = null;
    this.initialized = false;
    this.rejectAllPending(new Error(`Codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`));
    logger.warn("Codex app-server process exited", {
      code,
      signal,
      isStopping: this.isStopping,
      reconnectAttempts: this.reconnectAttempts,
    });

    if (this.isStopping) {
      this.setConnectionState({ status: "disconnected", retries: this.reconnectAttempts });
      return;
    }

    this.setConnectionState({
      status: "disconnected",
      retries: this.reconnectAttempts,
      message: `Codex app-server exited (code=${code ?? "null"})`,
    });

    void this.scheduleReconnect();
  }

  private async scheduleReconnect(): Promise<void> {
    if (this.isStopping) return;
    if (this.connectionState.status === "missingBinary") return;
    if (this.reconnectTimer) return;

    this.reconnectAttempts += 1;
    const expDelay = Math.min(MAX_RECONNECT_DELAY_MS, 500 * (2 ** (this.reconnectAttempts - 1)));
    const jitter = Math.floor(Math.random() * 250);
    const delayMs = expDelay + jitter;
    logger.warn("Scheduling Codex app-server reconnect", {
      reconnectAttempts: this.reconnectAttempts,
      delayMs,
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.spawnAndInitialize().catch(() => {
        // Errors already reflected in connection state; keep retrying.
      });
    }, delayMs);

    this.setConnectionState({
      status: "starting",
      retries: this.reconnectAttempts,
      message: `Reconnecting in ${delayMs}ms`,
    });
  }

  private clearReconnectTimer(): void {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private resetReadyDeferred(): void {
    this.readyDeferred = createDeferred<void>();
    void this.readyDeferred.promise.catch(() => {
      // Prevent unhandled-rejection warnings when startup fails before consumers await readiness.
    });
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private setConnectionState(next: CodexConnectionState): void {
    if (
      this.connectionState.status !== next.status
      || this.connectionState.retries !== next.retries
      || this.connectionState.message !== next.message
    ) {
      logger.info("Codex connection state changed", next);
    }
    this.connectionState = next;
    this.emit("connection", next);
  }
}
