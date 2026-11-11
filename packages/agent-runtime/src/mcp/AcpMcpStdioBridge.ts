// The bridge relays opaque JSON-RPC lines verbatim; schema-decoding foreign
// payloads here would reject traffic it must pass through untouched.
// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeReadline from "node:readline";

import { requestAcpMcp } from "@nodex/provider-acp/server/mcpHttp";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { discardResponseBody, responsePayloads } from "@nodex/runtime-shared/mcpResponsePayloads";

/**
 * Stdio-to-HTTP bridge for Nodex's MCP endpoint.
 *
 * ACP agents must support stdio MCP servers, while optional http/sse support
 * is unevenly implemented. `acp-mcp-bridge` runs as the stdio MCP server an
 * ACP agent spawns and forwards each JSON-RPC line to Nodex's authenticated
 * streamable-HTTP endpoint: single JSON responses and SSE streams are written
 * back as newline-delimited JSON-RPC, notification acknowledgements (202/204)
 * produce no output, and the `mcp-session-id` / negotiated protocol version
 * are replayed on subsequent requests.
 *
 * The Runtime entry fast-paths this command before loading the full CLI
 * graph. Keep its dependencies limited to the relay.
 */

export class AcpMcpBridgeError extends Error {
  readonly _tag = "AcpMcpBridgeError";
}

const bridgeError = (cause: unknown): AcpMcpBridgeError =>
  cause instanceof AcpMcpBridgeError
    ? cause
    : new AcpMcpBridgeError(cause instanceof Error ? cause.message : String(cause), { cause });

interface JsonRpcEnvelope {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly error?: unknown;
  readonly result?: unknown;
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface AcpMcpStdioBridgeOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: { write(chunk: string): unknown };
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

function asEnvelope(value: unknown): JsonRpcEnvelope | null {
  return typeof value === "object" && value !== null ? (value as JsonRpcEnvelope) : null;
}

function protocolVersionOf(entry: unknown): string | null {
  const result = asEnvelope(entry)?.result;
  const version =
    typeof result === "object" && result !== null
      ? (result as { readonly protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof version === "string" && version.length > 0 ? version : null;
}

export interface AcpMcpToolCallOptions {
  readonly endpoint: string;
  readonly authorization: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly fetchImplementation?: (url: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Call one MCP tool through a fresh authenticated HTTP session.
 *
 * This is the terminal fallback for ACP agents that accept `mcpServers` in
 * `session/new` but fail to expose those tools to their model. Compliant ACP
 * agents continue to use the stdio bridge above.
 */
export function callAcpMcpTool(
  options: AcpMcpToolCallOptions,
): Effect.Effect<unknown, AcpMcpBridgeError> {
  const fetchImplementation = options.fetchImplementation ?? requestAcpMcp;
  return Effect.gen(function* () {
    // The bridge is single-fibered at creation time; concurrent sends only
    // read these after the sequential handshake, so plain locals suffice.
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;

    const send = (message: unknown): Effect.Effect<ReadonlyArray<unknown>, AcpMcpBridgeError> =>
      Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              signal,
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: JSON.stringify(message),
            }),
          catch: bridgeError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          yield* discardResponseBody(response);
          return yield* Effect.fail(
            new AcpMcpBridgeError(`Nodex MCP endpoint responded with HTTP ${response.status}.`),
          );
        }
        const payloads = yield* Stream.runCollect(responsePayloads(response, bridgeError));
        for (const payload of payloads) {
          protocolVersion = protocolVersionOf(payload) ?? protocolVersion;
        }
        return payloads;
      }).pipe(Effect.scoped);

    const initializeId = "nodex-acp-cli-initialize";
    const initialized = yield* send({
      jsonrpc: "2.0",
      id: initializeId,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "nodex-acp-cli", version: "0.0.0" },
      },
    });
    const initializeResponse = initialized.find((entry) => asEnvelope(entry)?.id === initializeId);
    if (initializeResponse === undefined || asEnvelope(initializeResponse)?.error !== undefined) {
      return yield* Effect.fail(
        new AcpMcpBridgeError("Nodex MCP endpoint rejected initialization."),
      );
    }
    yield* send({ jsonrpc: "2.0", method: "notifications/initialized" });

    const callId = "nodex-acp-cli-tool-call";
    const responses = yield* send({
      jsonrpc: "2.0",
      id: callId,
      method: "tools/call",
      params: { name: options.tool, arguments: options.arguments },
    });
    const response = responses.find((entry) => asEnvelope(entry)?.id === callId);
    const envelope = asEnvelope(response);
    if (envelope === null || envelope.error !== undefined) {
      return yield* Effect.fail(
        new AcpMcpBridgeError(
          `Nodex MCP tool call failed${envelope?.error === undefined ? "." : `: ${JSON.stringify(envelope.error)}`}`,
        ),
      );
    }
    return envelope.result;
  });
}

export function runAcpMcpStdioBridge(options: AcpMcpStdioBridgeOptions): Effect.Effect<void> {
  const fetchImplementation = options.fetchImplementation ?? requestAcpMcp;
  return Effect.gen(function* () {
    // Dispatch happens synchronously on the single stream fiber, so plain
    // locals carry the shared session state; forwards mutate them in
    // completion order exactly like the wire does.
    let sessionId: string | null = null;
    let protocolVersion: string | null = null;

    const writeMessage = (message: unknown): Effect.Effect<void> =>
      Effect.sync(() => {
        options.output.write(`${JSON.stringify(message)}\n`);
      });

    const handleServerPayload = (payload: unknown): Effect.Effect<void> =>
      Effect.gen(function* () {
        for (const entry of Array.isArray(payload) ? payload : [payload]) {
          protocolVersion = protocolVersionOf(entry) ?? protocolVersion;
          yield* writeMessage(entry);
        }
      });

    const respondWithError = (
      requestId: unknown,
      message: string,
      code = -32603,
    ): Effect.Effect<void> =>
      writeMessage({
        jsonrpc: "2.0",
        id: requestId ?? null,
        error: { code, message },
      });

    const forward = (line: string, envelope: JsonRpcEnvelope): Effect.Effect<void> =>
      Effect.gen(function* () {
        const signal = yield* Effect.abortSignal;
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImplementation(options.endpoint, {
              method: "POST",
              signal,
              headers: {
                "content-type": "application/json",
                accept: "application/json, text/event-stream",
                authorization: options.authorization,
                ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
                ...(protocolVersion === null ? {} : { "mcp-protocol-version": protocolVersion }),
              },
              body: line,
            }),
          catch: bridgeError,
        });
        sessionId = response.headers.get("mcp-session-id") ?? sessionId;
        if (!response.ok) {
          if (envelope.id !== undefined) {
            yield* respondWithError(
              envelope.id,
              `Nodex MCP endpoint responded with HTTP ${response.status}.`,
            );
          }
          return yield* discardResponseBody(response);
        }
        yield* Stream.runForEach(responsePayloads(response, bridgeError), handleServerPayload);
      }).pipe(
        Effect.scoped,
        Effect.catch((error) =>
          envelope.id === undefined
            ? Effect.void
            : respondWithError(envelope.id, `Nodex MCP bridge request failed: ${error.message}`),
        ),
      );

    // Only session establishment is ordered; client responses to
    // server-initiated SSE requests must bypass the barrier or they would
    // deadlock the still-open HTTP exchange, and normal MCP calls stay
    // concurrent after initialization.
    let sessionBarrier: Effect.Effect<void> = Effect.void;

    const dispatch = (line: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (line.trim().length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          return yield* respondWithError(null, "Parse error", -32700);
        }
        const envelope = asEnvelope(parsed);
        if (envelope === null) return;
        const isResponse =
          envelope.id !== undefined && ("result" in envelope || "error" in envelope);
        const isSessionHandshake =
          envelope.method === "initialize" || envelope.method === "notifications/initialized";
        const task = isResponse
          ? forward(line, envelope)
          : sessionBarrier.pipe(Effect.andThen(forward(line, envelope)));
        const fiber = yield* Effect.forkChild(task, { startImmediately: true });
        if (isSessionHandshake) sessionBarrier = Fiber.await(fiber).pipe(Effect.asVoid);
      });

    const reader = NodeReadline.createInterface({ input: options.input });
    yield* Stream.runForEach(Stream.fromAsyncIterable(reader, bridgeError), dispatch).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.ensuring(Effect.sync(() => reader.close())),
    );
    // EOF retires the bridge. Child forwards are interrupted with this fiber.
  });
}

/**
 * Argv runner for `acp-mcp-bridge` and `acp-mcp-call`, shared by the
 * Runtime entry and the full CLI's command handlers. Kept free
 * of heavy imports: these commands run on the ACP first-message critical path.
 */
export async function runAcpMcpCliFastPath(
  command: "acp-mcp-bridge" | "acp-mcp-call",
  args: ReadonlyArray<string>,
): Promise<void> {
  const selectsServer = command === "acp-mcp-call" && args[0] === "--server";
  const server = selectsServer ? args[1] : "nodex_app";
  if (server !== "nodex_app" && server !== "node_repl") {
    process.stderr.write("acp-mcp-call --server requires nodex_app or node_repl.\n");
    process.exitCode = 2;
    return;
  }
  const endpointVariable =
    server === "node_repl" ? "NODEX_ACP_DESKTOP_MCP_ENDPOINT" : "NODEX_ACP_MCP_ENDPOINT";
  const endpoint = process.env[endpointVariable];
  const authorization = process.env.NODEX_ACP_MCP_AUTHORIZATION;
  if (endpoint === undefined || authorization === undefined) {
    process.stderr.write(
      `${command} requires ${endpointVariable} and NODEX_ACP_MCP_AUTHORIZATION.\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (command === "acp-mcp-bridge") {
    await Effect.runPromise(
      runAcpMcpStdioBridge({
        endpoint,
        authorization,
        input: process.stdin,
        output: process.stdout,
      }),
    );
    return;
  }
  const [tool, argumentsJson] = selectsServer ? args.slice(2) : args;
  if (tool === undefined || argumentsJson === undefined) {
    process.stderr.write("Usage: acp-mcp-call [--server <server>] <tool> <arguments-json>.\n");
    process.exitCode = 2;
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    process.stderr.write("acp-mcp-call arguments must be valid JSON.\n");
    process.exitCode = 2;
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    process.stderr.write("acp-mcp-call arguments must be a JSON object.\n");
    process.exitCode = 2;
    return;
  }
  const result = await Effect.runPromise(
    callAcpMcpTool({
      endpoint,
      authorization,
      tool,
      arguments: parsed as Record<string, unknown>,
    }),
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
