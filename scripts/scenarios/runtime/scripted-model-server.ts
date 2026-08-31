import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { zstdDecompressSync } from "node:zlib";
import { WebSocket, WebSocketServer, type RawData } from "ws";

const DEFAULT_MAXIMUM_REQUEST_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAXIMUM_RESPONSE_CONTEXTS = 1_024;
const DEFAULT_MAXIMUM_TRANSCRIPT_CHARACTERS = 24_000;

export type JsonObject = Record<string, unknown>;

export interface ScriptedModelProviderConfig {
  readonly base_url: string;
  readonly name: string;
  readonly request_max_retries: 0;
  readonly stream_max_retries: 0;
  readonly wire_api: "chat" | "messages" | "responses";
}

export interface ScriptedModelToolInvocation {
  readonly name: string;
  readonly namespace?: string;
}

export interface ScriptedModelHttpResponse {
  readonly chunks: readonly (string | Uint8Array)[];
  readonly delayMs?: number;
  readonly disconnectAfterChunks?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly keepOpen?: boolean;
  readonly status?: number;
  readonly websocketEvents?: readonly JsonObject[];
}

export interface ScriptedModelExchange {
  readonly expectedCalls?: number;
  readonly match?: (request: ScriptedModelRequest) => boolean;
  readonly maximumCalls?: number;
  readonly name: string;
  readonly respond:
    | ScriptedModelHttpResponse
    | ((
        request: ScriptedModelRequest,
        callIndex: number,
      ) => ScriptedModelHttpResponse | Promise<ScriptedModelHttpResponse>);
}

export interface ScriptedModelServerInput {
  readonly exchanges: readonly ScriptedModelExchange[];
  readonly maximumRequestBytes?: number;
  readonly maximumTranscriptCharacters?: number;
  readonly modelsResponse?: unknown;
}

export interface SseFrame {
  readonly data?: unknown;
  readonly event?: string;
}

interface ExchangeRuntime {
  readonly exchange: ScriptedModelExchange;
  readonly expectedCalls: number;
  readonly maximumCalls: number;
  calls: number;
}

interface RequestRecord {
  readonly exchangeName: string | null;
  readonly request: ScriptedModelRequest;
}

interface RequestWaiter {
  readonly match: (request: ScriptedModelRequest) => boolean;
  readonly reject: (error: Error) => void;
  readonly resolve: (request: ScriptedModelRequest) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const boundedText = (value: string, maximumCharacters: number): string =>
  value.length <= maximumCharacters
    ? value
    : `${value.slice(0, maximumCharacters)}\n...[truncated ${value.length - maximumCharacters} chars]`;

const normalizeHeader = (value: string | string[] | undefined): string | null => {
  if (Array.isArray(value)) return value.join(", ");
  return value ?? null;
};

const containsZstd = (value: string | null): boolean =>
  value?.split(",").some((entry) => entry.trim().toLowerCase() === "zstd") ?? false;

const decodeRequestBody = (body: Buffer, headers: IncomingHttpHeaders): Buffer => {
  const encoding = normalizeHeader(headers["content-encoding"]);
  return containsZstd(encoding) ? zstdDecompressSync(body) : body;
};

const readBody = async (request: IncomingMessage, maximumBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let retainedBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    retainedBytes += bytes.byteLength;
    if (retainedBytes > maximumBytes) {
      throw new Error(`Model request exceeded ${maximumBytes} encoded bytes`);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
};

const renderSseFrame = (frame: SseFrame): string => {
  const lines: string[] = [];
  if (frame.event) lines.push(`event: ${frame.event}`);
  if (frame.data !== undefined) {
    const serialized = typeof frame.data === "string" ? frame.data : JSON.stringify(frame.data);
    for (const line of serialized.split("\n")) lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
};

const delay = async (durationMs: number): Promise<void> => {
  if (durationMs <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
};

const rawWebSocketDataToBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
};

const appendLoopbackProxyBypass = (value: string | undefined): string => {
  const entries = new Set(
    (value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
  entries.add("127.0.0.1");
  entries.add("localhost");
  return [...entries].join(",");
};

/** A decoded model request with semantic helpers for stable scripted matching and assertions. */
export class ScriptedModelRequest {
  readonly body: JsonObject;
  readonly connectionId: string | null;
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly path: string;
  readonly signal: AbortSignal;
  readonly #inheritedTools: readonly unknown[];

  constructor(input: {
    readonly body: JsonObject;
    readonly connectionId?: string;
    readonly headers: IncomingHttpHeaders;
    readonly inheritedTools?: readonly unknown[];
    readonly method: string;
    readonly path: string;
    readonly signal?: AbortSignal;
  }) {
    this.body = input.body;
    this.connectionId = input.connectionId ?? null;
    this.headers = input.headers;
    this.#inheritedTools = input.inheritedTools ?? [];
    this.method = input.method;
    this.path = input.path;
    this.signal = input.signal ?? new AbortController().signal;
  }

  onAbort(listener: () => void): () => void {
    if (this.signal.aborted) {
      listener();
      return () => undefined;
    }
    this.signal.addEventListener("abort", listener, { once: true });
    return () => this.signal.removeEventListener("abort", listener);
  }

  header(name: string): string | null {
    return normalizeHeader(this.headers[name.toLowerCase()]);
  }

  inputItems(): readonly unknown[] {
    return Array.isArray(this.body.input) ? this.body.input : [];
  }

  /** Distinguishes a model generation from Responses WebSocket transport prewarming. */
  isGenerationRequest(): boolean {
    return this.body.generate !== false;
  }

  hasInputText(text: string): boolean {
    return JSON.stringify(this.inputItems()).includes(text);
  }

  hasUserInputText(text: string): boolean {
    return this.inputItems().some((item) => {
      if (!isObject(item) || item.type !== "message" || item.role !== "user") return false;
      return JSON.stringify(item.content).includes(text);
    });
  }

  hasInstructionsText(text: string): boolean {
    return JSON.stringify(this.body.instructions ?? null).includes(text);
  }

  isSubagentRequest(): boolean {
    const metadata = isObject(this.body.client_metadata) ? this.body.client_metadata : null;
    return (
      this.header("x-openai-subagent") !== null ||
      (metadata !== null && typeof metadata["x-openai-subagent"] === "string")
    );
  }

  hasFunctionCallOutput(callId: string): boolean {
    return this.functionCallOutput(callId) !== null;
  }

  hasToolCallOutput(callId: string): boolean {
    return this.toolCallOutput(callId) !== null;
  }

  functionCallOutput(callId: string): JsonObject | null {
    const output = this.inputItems().find(
      (item) =>
        isObject(item) &&
        (item.type === "function_call_output" || item.type === "custom_tool_call_output") &&
        item.call_id === callId,
    );
    return isObject(output) ? output : null;
  }

  toolCallOutput(callId: string): JsonObject | null {
    const output = this.inputItems().find(
      (item) =>
        isObject(item) &&
        (item.type === "function_call_output" ||
          item.type === "custom_tool_call_output" ||
          item.type === "mcp_tool_call_output") &&
        item.call_id === callId,
    );
    return isObject(output) ? output : null;
  }

  toolSearchOutput(callId: string): JsonObject | null {
    const output = this.inputItems().find(
      (item) => isObject(item) && item.type === "tool_search_output" && item.call_id === callId,
    );
    return isObject(output) ? output : null;
  }

  hasToolType(type: string): boolean {
    return this.effectiveTools().some(
      (candidate) => isObject(candidate) && candidate.type === type,
    );
  }

  /**
   * Tools visible to the model after applying Responses Lite's `previous_response_id` context.
   * The WebSocket transport may advertise the full catalog during prewarm and omit it from the
   * immediately following generation request.
   */
  effectiveTools(): readonly unknown[] {
    const directlyAdvertised = Array.isArray(this.body.tools) ? this.body.tools : [];
    const inputAdvertised = this.inputItems().flatMap((item) => {
      if (!isObject(item) || item.type !== "additional_tools") return [];
      return Array.isArray(item.tools) ? item.tools : [];
    });
    const discovered = this.inputItems().flatMap((item) => {
      if (!isObject(item) || item.type !== "tool_search_output") return [];
      return Array.isArray(item.tools) ? item.tools : [];
    });
    return [...directlyAdvertised, ...inputAdvertised, ...discovered, ...this.#inheritedTools];
  }

  tool(namespace: string, name: string): JsonObject | null {
    for (const candidate of this.effectiveTools()) {
      if (!isObject(candidate)) continue;
      if (candidate.type === "namespace" && candidate.name === namespace) {
        const children = Array.isArray(candidate.tools) ? candidate.tools : [];
        const child = children.find((entry) => isObject(entry) && entry.name === name);
        if (isObject(child)) return child;
      }
      const qualifiedName = namespace.endsWith("__")
        ? `${namespace}${name}`
        : `${namespace}__${name}`;
      if (candidate.name === qualifiedName) return candidate;
    }
    return null;
  }

  /** Returns the exact address the model must echo for a nested or flattened tool definition. */
  toolInvocation(namespace: string, name: string): ScriptedModelToolInvocation | null {
    const qualifiedName = namespace.endsWith("__")
      ? `${namespace}${name}`
      : `${namespace}__${name}`;
    for (const candidate of this.effectiveTools()) {
      if (!isObject(candidate)) continue;
      if (candidate.type === "namespace" && candidate.name === namespace) {
        const children = Array.isArray(candidate.tools) ? candidate.tools : [];
        if (children.some((entry) => isObject(entry) && entry.name === name)) {
          return { name, namespace };
        }
      }
      if (candidate.name === qualifiedName) return { name: qualifiedName };
    }
    return null;
  }

  namedTool(name: string): JsonObject | null {
    const tool = this.effectiveTools().find(
      (candidate) => isObject(candidate) && candidate.name === name,
    );
    return isObject(tool) ? tool : null;
  }

  diagnosticSummary(maximumCharacters = 2_000): string {
    const summary = {
      method: this.method,
      path: this.path,
      connectionId: this.connectionId,
      streamId: this.body.stream_id ?? null,
      previousResponseId: this.body.previous_response_id ?? null,
      generate: this.body.generate ?? true,
      clientMetadata: this.body.client_metadata ?? null,
      model: this.body.model ?? null,
      toolsInheritedFromPreviousResponse: this.#inheritedTools.length > 0,
      tools: this.effectiveTools().map((tool) =>
        isObject(tool)
          ? {
              name: tool.name ?? null,
              type: tool.type ?? null,
              tools: Array.isArray(tool.tools)
                ? tool.tools.map((child) =>
                    isObject(child)
                      ? { name: child.name ?? null, type: child.type ?? null }
                      : { type: typeof child },
                  )
                : undefined,
            }
          : { type: typeof tool },
      ),
      input: this.inputItems(),
      instructions:
        typeof this.body.instructions === "string"
          ? boundedText(this.body.instructions, 500)
          : (this.body.instructions ?? null),
    };
    return boundedText(JSON.stringify(summary), maximumCharacters);
  }
}

export const scriptedModelResponse = {
  http(input: {
    readonly body?: unknown;
    readonly delayMs?: number;
    readonly headers?: Readonly<Record<string, string>>;
    readonly status: number;
  }): ScriptedModelHttpResponse {
    return {
      chunks: [JSON.stringify(input.body ?? null)],
      delayMs: input.delayMs,
      headers: { "content-type": "application/json", ...input.headers },
      status: input.status,
    };
  },

  sse(
    frames: readonly SseFrame[],
    options: {
      readonly delayMs?: number;
      readonly disconnectAfterFrames?: boolean;
      readonly keepOpen?: boolean;
      readonly status?: number;
    } = {},
  ): ScriptedModelHttpResponse {
    return {
      chunks: frames.map(renderSseFrame),
      delayMs: options.delayMs,
      disconnectAfterChunks: options.disconnectAfterFrames,
      headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
      keepOpen: options.keepOpen,
      status: options.status ?? 200,
    };
  },
};

export const responses = {
  assistantMessage(id: string, text: string, phase?: "commentary" | "final_answer"): JsonObject {
    return {
      type: "response.output_item.done",
      item: {
        type: "message",
        role: "assistant",
        id,
        content: [{ type: "output_text", text }],
        ...(phase ? { phase } : {}),
      },
    };
  },

  completed(id: string, endTurn?: boolean): JsonObject {
    return {
      type: "response.completed",
      response: {
        id,
        ...(endTurn === undefined ? {} : { end_turn: endTurn }),
        usage: {
          input_tokens: 0,
          input_tokens_details: null,
          output_tokens: 0,
          output_tokens_details: null,
          total_tokens: 0,
        },
      },
    };
  },

  created(id: string): JsonObject {
    return { type: "response.created", response: { id } };
  },

  customToolCall(callId: string, name: string, input: string, namespace?: string): JsonObject {
    return {
      type: "response.output_item.done",
      item: {
        type: "custom_tool_call",
        call_id: callId,
        name,
        input,
        ...(namespace ? { namespace } : {}),
      },
    };
  },

  functionCall(callId: string, name: string, arguments_: unknown, namespace?: string): JsonObject {
    return {
      type: "response.output_item.done",
      item: {
        type: "function_call",
        call_id: callId,
        name,
        arguments: typeof arguments_ === "string" ? arguments_ : JSON.stringify(arguments_),
        ...(namespace ? { namespace } : {}),
      },
    };
  },

  toolSearchCall(callId: string, arguments_: unknown): JsonObject {
    return {
      type: "response.output_item.done",
      item: {
        type: "tool_search_call",
        call_id: callId,
        execution: "client",
        arguments: arguments_,
      },
    };
  },

  stream(
    events: readonly JsonObject[],
    options?: {
      readonly delayMs?: number;
      readonly disconnectAfterFrames?: boolean;
      readonly keepOpen?: boolean;
      readonly status?: number;
    },
  ): ScriptedModelHttpResponse {
    const httpResponse = scriptedModelResponse.sse(
      events.map((event) => ({ event: String(event.type), data: event })),
      options,
    );
    return { ...httpResponse, websocketEvents: events };
  },
};

const validateExchange = (exchange: ScriptedModelExchange): ExchangeRuntime => {
  const expectedCalls = exchange.expectedCalls ?? 1;
  const maximumCalls = exchange.maximumCalls ?? expectedCalls;
  if (!Number.isSafeInteger(expectedCalls) || expectedCalls < 0) {
    throw new Error(`Exchange '${exchange.name}' has invalid expectedCalls`);
  }
  if (
    maximumCalls !== Number.POSITIVE_INFINITY &&
    (!Number.isSafeInteger(maximumCalls) || maximumCalls < expectedCalls)
  ) {
    throw new Error(`Exchange '${exchange.name}' has invalid maximumCalls`);
  }
  return { exchange, expectedCalls, maximumCalls, calls: 0 };
};

/**
 * Scripted model HTTP/WebSocket peer for exercising the real Agent runtime. It is deliberately
 * dumb:
 * each request consumes one matching exchange and every unconsumed or unexpected exchange fails
 * verification with a bounded transcript. Responses WebSocket prewarm is transport setup rather
 * than model behavior, so `generate=false` requests are acknowledged automatically.
 */
export class ScriptedModelServer {
  readonly baseUrl: string;
  readonly #exchanges: readonly ExchangeRuntime[];
  readonly #maximumTranscriptCharacters: number;
  readonly #records: RequestRecord[] = [];
  readonly #requestWaiters = new Set<RequestWaiter>();
  readonly #responseTools = new Map<string, readonly unknown[]>();
  readonly #failures: string[] = [];
  readonly #server: ReturnType<typeof createServer>;
  readonly #sockets = new Set<Socket>();
  readonly #webSockets = new Set<WebSocket>();
  readonly #webSocketServer: WebSocketServer;
  #closed = false;
  #nextWebSocketConnectionId = 1;

  #rememberResponseTools(responseId: string, request: ScriptedModelRequest): void {
    if (this.#responseTools.size >= DEFAULT_MAXIMUM_RESPONSE_CONTEXTS) {
      const oldestResponseId = this.#responseTools.keys().next().value;
      if (typeof oldestResponseId === "string") this.#responseTools.delete(oldestResponseId);
    }
    this.#responseTools.set(responseId, request.effectiveTools());
  }

  #inheritedTools(body: JsonObject): readonly unknown[] {
    const previousResponseId = body.previous_response_id;
    if (typeof previousResponseId !== "string") return [];
    return this.#responseTools.get(previousResponseId) ?? [];
  }

  #rememberResponseEvents(
    response: ScriptedModelHttpResponse,
    request: ScriptedModelRequest,
  ): void {
    for (const event of response.websocketEvents ?? []) {
      if (
        event.type === "response.created" &&
        isObject(event.response) &&
        typeof event.response.id === "string"
      ) {
        this.#rememberResponseTools(event.response.id, request);
      }
    }
  }

  private constructor(input: {
    readonly baseUrl: string;
    readonly exchanges: readonly ExchangeRuntime[];
    readonly maximumTranscriptCharacters: number;
    readonly server: ReturnType<typeof createServer>;
    readonly webSocketServer: WebSocketServer;
  }) {
    this.baseUrl = input.baseUrl;
    this.#exchanges = input.exchanges;
    this.#maximumTranscriptCharacters = input.maximumTranscriptCharacters;
    this.#server = input.server;
    this.#webSocketServer = input.webSocketServer;
  }

  static async start(input: ScriptedModelServerInput): Promise<ScriptedModelServer> {
    const exchanges = input.exchanges.map(validateExchange);
    const maximumRequestBytes = input.maximumRequestBytes ?? DEFAULT_MAXIMUM_REQUEST_BYTES;
    const maximumTranscriptCharacters =
      input.maximumTranscriptCharacters ?? DEFAULT_MAXIMUM_TRANSCRIPT_CHARACTERS;
    if (!Number.isSafeInteger(maximumRequestBytes) || maximumRequestBytes <= 0) {
      throw new Error("Scripted model maximumRequestBytes must be a positive safe integer");
    }

    let runtime: ScriptedModelServer | null = null;
    const modelsResponse = input.modelsResponse ?? { models: [] };
    const server = createServer((request, response) => {
      void (async () => {
        const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        if (request.method === "GET" && path.endsWith("/models")) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(modelsResponse));
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(404, { "content-type": "application/json" });
          response.end('{"error":"not found"}');
          return;
        }
        if (!runtime) throw new Error("Scripted model server was not initialized");
        const abortController = new AbortController();
        const abort = (): void => abortController.abort();
        request.once("aborted", abort);
        response.once("close", () => {
          if (!response.writableEnded) abort();
        });
        const encodedBody = await readBody(request, maximumRequestBytes);
        const decodedBody = decodeRequestBody(encodedBody, request.headers);
        const parsed: unknown = JSON.parse(decodedBody.toString("utf8"));
        if (!isObject(parsed)) throw new Error("Model request body must be a JSON object");
        const modelRequest = new ScriptedModelRequest({
          body: parsed,
          headers: request.headers,
          inheritedTools: runtime.#inheritedTools(parsed),
          method: request.method,
          path,
          signal: abortController.signal,
        });
        const scripted = await runtime.#resolveResponse(modelRequest);
        if (!scripted) {
          const failure = runtime.#failures.at(-1) ?? "Unexpected model request";
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: failure }));
          return;
        }
        runtime.#rememberResponseEvents(scripted, modelRequest);
        if (modelRequest.signal.aborted) return;
        await delay(scripted.delayMs ?? 0);
        response.writeHead(scripted.status ?? 200, scripted.headers ?? {});
        for (const chunk of scripted.chunks) response.write(chunk);
        if (scripted.disconnectAfterChunks) {
          response.socket?.destroy();
          return;
        }
        if (scripted.keepOpen) return;
        response.end();
      })().catch((error: unknown) => {
        const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
        if (runtime) runtime.#failures.push(message);
        if (response.headersSent) {
          response.socket?.destroy();
          return;
        }
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: message }));
      });
    });
    const webSocketServer = new WebSocketServer({
      noServer: true,
      maxPayload: maximumRequestBytes,
      perMessageDeflate: true,
    });
    server.on("upgrade", (request, socket, head) => {
      const requestPath = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (!requestPath.endsWith("/responses")) {
        socket.destroy();
        return;
      }
      webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
        webSocketServer.emit("connection", webSocket, request);
      });
    });
    webSocketServer.on("connection", (webSocket, request) => {
      if (!runtime) {
        webSocket.close(1011, "Scripted model server was not initialized");
        return;
      }
      runtime.#acceptWebSocket(webSocket, request);
    });
    server.on("connection", (socket) => {
      if (runtime) runtime.#sockets.add(socket);
      socket.once("close", () => {
        if (runtime) runtime.#sockets.delete(socket);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Scripted model server did not bind a TCP port");
    }
    runtime = new ScriptedModelServer({
      baseUrl: `http://127.0.0.1:${address.port}`,
      exchanges,
      maximumTranscriptCharacters,
      server,
      webSocketServer,
    });
    return runtime;
  }

  providerConfig(
    providerId: string,
    wireApi: ScriptedModelProviderConfig["wire_api"] = "responses",
  ): ScriptedModelProviderConfig {
    const baseUrl = wireApi === "messages" ? this.baseUrl : `${this.baseUrl}/v1`;
    return {
      base_url: baseUrl,
      name: `${providerId} scripted test provider`,
      request_max_retries: 0,
      stream_max_retries: 0,
      wire_api: wireApi,
    };
  }

  /** Environment overrides that keep a loopback model peer outside inherited proxy routes. */
  loopbackEnvironment(
    environment: Readonly<Record<string, string | undefined>> = process.env,
  ): Readonly<Record<string, string>> {
    return {
      NO_PROXY: appendLoopbackProxyBypass(environment.NO_PROXY),
      no_proxy: appendLoopbackProxyBypass(environment.no_proxy),
    };
  }

  requests(): readonly ScriptedModelRequest[] {
    return this.#records.map((record) => record.request);
  }

  async waitForRequest(
    match: (request: ScriptedModelRequest) => boolean,
    timeoutMs = 5_000,
  ): Promise<ScriptedModelRequest> {
    const existing = this.requests().find(match);
    if (existing) return existing;
    if (this.#closed) throw new Error("Scripted model server is closed");
    return await new Promise<ScriptedModelRequest>((resolve, reject) => {
      const waiter: RequestWaiter = {
        match,
        reject,
        resolve,
        timeout: setTimeout(() => {
          this.#requestWaiters.delete(waiter);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for scripted model request`));
        }, timeoutMs),
      };
      this.#requestWaiters.add(waiter);
    });
  }

  transcript(): string {
    const lines = this.#records.map(
      (record, index) =>
        `${String(index + 1).padStart(2, "0")} ${record.request.method} ${record.request.path} -> ${record.exchangeName ?? "UNMATCHED"}\n   ${record.request.diagnosticSummary(1_200)}`,
    );
    return boundedText(lines.join("\n"), this.#maximumTranscriptCharacters);
  }

  verify(): void {
    const callFailures = this.#exchanges.flatMap((runtime) => {
      if (runtime.calls >= runtime.expectedCalls && runtime.calls <= runtime.maximumCalls)
        return [];
      const maximum =
        runtime.maximumCalls === Number.POSITIVE_INFINITY
          ? "unbounded"
          : String(runtime.maximumCalls);
      return [
        `Exchange '${runtime.exchange.name}' received ${runtime.calls} calls; expected ${runtime.expectedCalls}..${maximum}`,
      ];
    });
    const failures = [...this.#failures, ...callFailures];
    if (failures.length === 0) return;
    const transcript = this.transcript();
    throw new Error(
      `Scripted model verification failed:\n- ${failures.join("\n- ")}${transcript ? `\n\nTranscript:\n${transcript}` : ""}`,
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#requestWaiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Scripted model server closed while waiting for a request"));
    }
    this.#requestWaiters.clear();
    for (const webSocket of this.#webSockets) webSocket.terminate();
    this.#webSocketServer.close();
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  #selectExchange(request: ScriptedModelRequest): ExchangeRuntime | null {
    for (const runtime of this.#exchanges) {
      if (runtime.calls >= runtime.maximumCalls) continue;
      if (!runtime.exchange.match || runtime.exchange.match(request)) return runtime;
    }
    return null;
  }

  async #resolveResponse(request: ScriptedModelRequest): Promise<ScriptedModelHttpResponse | null> {
    const exchange = this.#selectExchange(request);
    this.#recordRequest(request, exchange?.exchange.name ?? null);
    if (!exchange) {
      this.#failures.push(`Unexpected model request: ${request.diagnosticSummary()}`);
      return null;
    }
    const callIndex = exchange.calls;
    exchange.calls += 1;
    return await (typeof exchange.exchange.respond === "function"
      ? exchange.exchange.respond(request, callIndex)
      : exchange.exchange.respond);
  }

  #acceptWebSocket(webSocket: WebSocket, upgradeRequest: IncomingMessage): void {
    this.#webSockets.add(webSocket);
    webSocket.once("close", () => this.#webSockets.delete(webSocket));
    const connectionId = `ws-${this.#nextWebSocketConnectionId}`;
    this.#nextWebSocketConnectionId += 1;
    const laneQueues = new Map<string, Promise<void>>();
    const sendForStream = (event: JsonObject, streamId: string | null): void => {
      webSocket.send(JSON.stringify(streamId ? { ...event, stream_id: streamId } : event));
    };
    const failConnection = (error: unknown): void => {
      const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.#failures.push(message);
      if (webSocket.readyState === WebSocket.OPEN) {
        webSocket.close(1011, "Scripted model WebSocket failure");
      }
    };
    webSocket.on("message", (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawWebSocketDataToBuffer(data).toString("utf8"));
      } catch (error) {
        failConnection(error);
        return;
      }
      if (!isObject(parsed)) {
        failConnection(new Error("WebSocket model request must be a JSON object"));
        return;
      }
      const streamId = typeof parsed.stream_id === "string" ? parsed.stream_id : null;
      const laneKey = streamId ?? "\0default";
      const previous = laneQueues.get(laneKey) ?? Promise.resolve();
      const current = previous.then(async () => {
        const request = new ScriptedModelRequest({
          body: parsed,
          connectionId,
          headers: upgradeRequest.headers,
          inheritedTools: this.#inheritedTools(parsed),
          method: "WEBSOCKET",
          path: new URL(upgradeRequest.url ?? "/", "http://127.0.0.1").pathname,
        });
        if (request.body.generate === false) {
          const responseId = `scripted-prewarm-${this.#records.length + 1}`;
          this.#recordRequest(request, "automatic websocket prewarm");
          this.#rememberResponseTools(responseId, request);
          sendForStream(responses.created(responseId), streamId);
          sendForStream(responses.completed(responseId), streamId);
          return;
        }
        const scripted = await this.#resolveResponse(request);
        if (!scripted) {
          webSocket.close(1011, "Unexpected scripted model request");
          return;
        }
        if (!scripted.websocketEvents) {
          throw new Error(
            "A Responses WebSocket request matched a response without websocketEvents; use responses.stream(...) for this exchange",
          );
        }
        this.#rememberResponseEvents(scripted, request);
        await delay(scripted.delayMs ?? 0);
        for (const event of scripted.websocketEvents) {
          if (webSocket.readyState !== WebSocket.OPEN) return;
          sendForStream(event, streamId);
        }
        if (scripted.disconnectAfterChunks) webSocket.terminate();
      });
      const settled = current.catch(failConnection).finally(() => {
        if (laneQueues.get(laneKey) === settled) laneQueues.delete(laneKey);
      });
      laneQueues.set(laneKey, settled);
    });
  }

  #recordRequest(request: ScriptedModelRequest, exchangeName: string | null): void {
    this.#records.push({ exchangeName, request });
    for (const waiter of this.#requestWaiters) {
      let matches = false;
      try {
        matches = waiter.match(request);
      } catch (error) {
        clearTimeout(waiter.timeout);
        this.#requestWaiters.delete(waiter);
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (!matches) continue;
      clearTimeout(waiter.timeout);
      this.#requestWaiters.delete(waiter);
      waiter.resolve(request);
    }
  }
}

export const withScriptedModelServer = async <Value>(
  input: ScriptedModelServerInput,
  use: (server: ScriptedModelServer) => Promise<Value>,
): Promise<Value> => {
  const server = await ScriptedModelServer.start(input);
  let value: Value | undefined;
  let operationFailure: unknown;
  try {
    value = await use(server);
  } catch (error) {
    const transcript = server.transcript();
    operationFailure = new Error(
      `${error instanceof Error ? error.message : String(error)}${transcript ? `\n\nScripted model transcript:\n${transcript}` : ""}`,
      { cause: error },
    );
  }

  let verificationFailure: unknown;
  try {
    server.verify();
  } catch (error) {
    verificationFailure = error;
  }

  let closeFailure: unknown;
  try {
    await server.close();
  } catch (error) {
    closeFailure = error;
  }

  const failures = [operationFailure, verificationFailure, closeFailure].filter(
    (failure) => failure !== undefined,
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    const summary = failures
      .map((failure) => (failure instanceof Error ? failure.message : String(failure)))
      .join("\n\n");
    throw new AggregateError(failures, `Scripted model scenario failed:\n${summary}`);
  }
  return value as Value;
};
