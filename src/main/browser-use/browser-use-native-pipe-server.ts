import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import fs from "node:fs/promises";
import net, { type Socket } from "node:net";
import path from "node:path";
import { readActionableErrorMessage } from "../actionable-error-message";
import {
  makeBrowserUseRpcError,
  makeBrowserUseRpcResult,
  parseBrowserUseRpcRequest,
  type BrowserUseRpcRequest,
} from "./browser-use-json-rpc";
import {
  BrowserUseNativePipeFrameDecoder,
  encodeBrowserUseNativePipeFrame,
} from "./native-pipe-framing";
import type {
  BrowserUsePeerAuthorizationResult,
  BrowserUseSocketPeerAuthorizer,
} from "./browser-use-peer-authorizer";

const BROWSER_USE_PIPE_PREFIX = "codex-browser-use";

export interface BrowserUseNativePipeRequestContext {
  connectionId: string;
  notification: boolean;
}

export type BrowserUseNativePipeRequestHandler = (
  request: BrowserUseRpcRequest,
  context: BrowserUseNativePipeRequestContext,
) => Promise<unknown> | unknown;

export interface BrowserUseNativePipeRequestEvent {
  connectionId: string;
  label: string;
  notification: boolean;
}

export interface BrowserUseNativePipeRequestCompletedEvent extends BrowserUseNativePipeRequestEvent {
  durationMs: number;
  outcome: "error" | "success";
}

export interface BrowserUseNativePipeServerEvents {
  onAuthorizationError?: (error: unknown) => void;
  onInvalidMessage?: (error: unknown) => void;
  onListening?: (pipePath: string) => void;
  onRejectedSocket?: (result: BrowserUsePeerAuthorizationResult) => void;
  onRequestCompleted?: (event: BrowserUseNativePipeRequestCompletedEvent) => void;
  onRequestStarted?: (event: BrowserUseNativePipeRequestEvent) => void;
  onSocketError?: (error: Error) => void;
}

interface BrowserUseNativePipeServerOptions {
  events?: BrowserUseNativePipeServerEvents;
  handler: BrowserUseNativePipeRequestHandler;
  nativePipeDirectory?: string;
  pipePath?: string;
  platform?: NodeJS.Platform;
  socketPeerAuthorizer: BrowserUseSocketPeerAuthorizer;
}

interface BrowserUseNativePipeConnection {
  decoder: BrowserUseNativePipeFrameDecoder;
  id: string;
  socket: Socket;
}

function boundedErrorMessage(error: unknown): string {
  return readActionableErrorMessage(error, {
    fallback: "Browser Use request failed",
    maximumLength: 2_048,
  });
}

function requestLabel(request: BrowserUseRpcRequest): string {
  if (request.method !== "executeCdp") return request.method;
  if (
    typeof request.params !== "object" ||
    request.params === null ||
    !("method" in request.params) ||
    typeof request.params.method !== "string"
  ) {
    return request.method;
  }
  return `${request.method}:${request.params.method}`;
}

export function resolveBrowserUseNativePipeDirectory(
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform === "win32") return String.raw`\\.\pipe\${BROWSER_USE_PIPE_PREFIX}`;
  return path.join("/tmp", BROWSER_USE_PIPE_PREFIX);
}

async function ensureUnixPipeDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await fs.lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Browser Use native-pipe directory is not a regular directory");
  }
  const currentUserId = process.getuid?.();
  if (currentUserId !== undefined && stats.uid !== currentUserId) {
    throw new Error("Browser Use native-pipe directory is not owned by the current user");
  }
  await fs.chmod(directory, 0o700);
}

async function removeOwnedUnixPipe(pipePath: string): Promise<void> {
  try {
    const stats = await fs.lstat(pipePath);
    if (!stats.isSocket()) return;
    await fs.unlink(pipePath);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

export interface BrowserUseNativePipeServer {
  readonly broadcast: (method: string, params?: unknown) => void;
  readonly pipePath: string;
}

export class BrowserUseNativePipeServerError extends Schema.TaggedError<BrowserUseNativePipeServerError>()(
  "BrowserUseNativePipeServerError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const serverError = (operation: string, cause: unknown): BrowserUseNativePipeServerError =>
  new BrowserUseNativePipeServerError({ operation, cause });

function makeServerState(options: BrowserUseNativePipeServerOptions): {
  readonly port: BrowserUseNativePipeServer;
  readonly release: () => Promise<void>;
  readonly start: () => Promise<void>;
} {
  const connections = new Map<Socket, BrowserUseNativePipeConnection>();
  const events = options.events ?? {};
  const platform = options.platform ?? process.platform;
  const pipePath =
    options.pipePath ??
    (platform === "win32"
      ? `${options.nativePipeDirectory ?? resolveBrowserUseNativePipeDirectory(platform)}-${randomUUID()}`
      : path.join(
          options.nativePipeDirectory ?? resolveBrowserUseNativePipeDirectory(platform),
          `${randomUUID()}.sock`,
        ));
  let accepting = true;
  let ownsPipePath = false;
  let server: ReturnType<typeof net.createServer> | null = null;

  const dispatch = async (
    connection: BrowserUseNativePipeConnection,
    request: BrowserUseRpcRequest,
  ): Promise<void> => {
    if (!accepting) return;
    const notification = request.id === undefined;
    const requestEvent: BrowserUseNativePipeRequestEvent = {
      connectionId: connection.id,
      label: requestLabel(request),
      notification,
    };
    const startedAt = performance.now();
    events.onRequestStarted?.(requestEvent);
    try {
      const result = await options.handler(request, {
        connectionId: connection.id,
        notification,
      });
      events.onRequestCompleted?.({
        ...requestEvent,
        durationMs: performance.now() - startedAt,
        outcome: "success",
      });
      if (!accepting || notification || connection.socket.destroyed) return;
      connection.socket.write(
        encodeBrowserUseNativePipeFrame(
          JSON.stringify(makeBrowserUseRpcResult(request.id!, result)),
        ),
      );
    } catch (error) {
      events.onRequestCompleted?.({
        ...requestEvent,
        durationMs: performance.now() - startedAt,
        outcome: "error",
      });
      if (!accepting || notification || connection.socket.destroyed) return;
      connection.socket.write(
        encodeBrowserUseNativePipeFrame(
          JSON.stringify(makeBrowserUseRpcError(request.id!, 1, boundedErrorMessage(error))),
        ),
      );
    }
  };

  const handleSocketData = (connection: BrowserUseNativePipeConnection, chunk: Buffer): void => {
    if (!accepting) return;
    let messages: string[];
    try {
      messages = connection.decoder.push(chunk);
    } catch (error) {
      events.onInvalidMessage?.(error);
      connection.socket.destroy();
      return;
    }
    for (const message of messages) {
      let request: BrowserUseRpcRequest;
      try {
        request = parseBrowserUseRpcRequest(message);
      } catch (error) {
        events.onInvalidMessage?.(error);
        connection.socket.destroy();
        return;
      }
      void dispatch(connection, request);
    }
  };

  const handleConnection = (socket: Socket): void => {
    if (!accepting) {
      socket.destroy();
      return;
    }
    let authorization: BrowserUsePeerAuthorizationResult;
    try {
      authorization = options.socketPeerAuthorizer(socket);
    } catch (error) {
      events.onAuthorizationError?.(error);
      socket.destroy();
      return;
    }
    if (!authorization.authorized) {
      events.onRejectedSocket?.(authorization);
      socket.destroy();
      return;
    }

    const connection: BrowserUseNativePipeConnection = {
      decoder: new BrowserUseNativePipeFrameDecoder(),
      id: randomUUID(),
      socket,
    };
    connections.set(socket, connection);
    socket.setNoDelay(true);
    socket.on("data", (chunk) => {
      handleSocketData(connection, chunk);
    });
    socket.on("error", (error) => {
      events.onSocketError?.(error);
    });
    socket.on("close", () => {
      connection.decoder.reset();
      connections.delete(socket);
    });
  };

  const start = async (): Promise<void> => {
    if (server) return;
    if (platform !== "win32") {
      await ensureUnixPipeDirectory(path.dirname(pipePath));
      await removeOwnedUnixPipe(pipePath);
    }
    const acquired = net.createServer(handleConnection);
    server = acquired;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        acquired.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        acquired.off("error", onError);
        resolve();
      };
      acquired.once("error", onError);
      acquired.once("listening", onListening);
      acquired.listen(pipePath);
    });
    ownsPipePath = platform !== "win32";
    if (platform !== "win32") await fs.chmod(pipePath, 0o600);
    events.onListening?.(pipePath);
  };

  const release = async (): Promise<void> => {
    accepting = false;
    for (const connection of connections.values()) {
      connection.decoder.reset();
      connection.socket.destroy();
    }
    connections.clear();

    const acquired = server;
    server = null;
    if (acquired?.listening) {
      await new Promise<void>((resolve) => acquired.close(() => resolve()));
    }
    const shouldRemovePipe = ownsPipePath && platform !== "win32";
    ownsPipePath = false;
    if (shouldRemovePipe) await removeOwnedUnixPipe(pipePath);
  };

  return {
    port: {
      broadcast: (method, params) => {
        if (!accepting) return;
        const frame = encodeBrowserUseNativePipeFrame(
          JSON.stringify({
            jsonrpc: "2.0",
            method,
            ...(params === undefined ? {} : { params }),
          }),
        );
        for (const connection of connections.values()) {
          if (!connection.socket.destroyed) connection.socket.write(frame);
        }
      },
      pipePath,
    },
    release,
    start,
  };
}

/** Owns the net server, accepted sockets and Unix socket path in one session Scope. */
export const makeBrowserUseNativePipeServer = (
  options: BrowserUseNativePipeServerOptions,
): Effect.Effect<BrowserUseNativePipeServer, BrowserUseNativePipeServerError, Scope.Scope> =>
  Effect.gen(function* () {
    const state = makeServerState(options);
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise({
        try: state.release,
        catch: (cause) => serverError("release", cause),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not release Browser Use native pipe").pipe(
            Effect.annotateLogs({ error: String(error.cause) }),
          ),
        ),
      ),
    );
    yield* Effect.tryPromise({
      try: state.start,
      catch: (cause) => serverError("start", cause),
    }).pipe(
      Effect.tapError(() =>
        Effect.tryPromise({
          try: state.release,
          catch: (cause) => serverError("rollback", cause),
        }).pipe(Effect.ignore),
      ),
    );
    return state.port;
  });
