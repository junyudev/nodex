import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  Agent,
  createServer,
  IncomingMessage,
  type ClientRequest,
  type OutgoingHttpHeaders,
  type RequestOptions,
  type Server,
  type ServerResponse,
} from "node:http";
import { Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  CORE_CLIENT_REQUIREMENTS,
  CORE_TRANSPORT_BUDGETS,
  type components,
} from "@nodex/core-protocol";

import type {
  CoreEventEnvelope,
  CoreEventReplayRequired,
  CoreRequestOptions,
  CoreStreamCheckpoint,
} from "./types";
import { CoreCodecError } from "./codec";
import { CoreModuleResponseError } from "./core-client";
import {
  classifyCoreOperationFailure,
  isRecoverableCoreTransportFailure,
} from "../core-runtime/CoreRuntimeError";
import { createCoreLocalCommitFixture } from "./testing/local-commit-fixture";
import {
  CoreEventCompatibilityError,
  CoreEventReplayError,
  CoreHttpError,
  CoreRateLimitError,
  CoreResponseTooLargeError,
  CoreTransportError,
  LocalHttpTransport,
  isDefinitiveCoreGenerationLoss,
} from "./local-http";

const testEndpoint = (directory: string) =>
  process.platform === "win32"
    ? `\\\\.\\pipe\\nodex-core-${randomBytes(16).toString("hex")}`
    : path.join(directory, "core.sock");

const servers: Server[] = [];
const directories: string[] = [];

const replayBoundary: CoreEventReplayRequired = {
  requested_after: 4,
  oldest_available: 7,
  commit_head: 12,
  generation: "generation:test",
  resync_token: "resync:test",
};

const configureEventContract = (transport: LocalHttpTransport): LocalHttpTransport => {
  transport.configureEventContract({
    transportVersion: 8,
    eventVersion: CORE_CLIENT_REQUIREMENTS.event_version,
    libraryId: "library-1",
    storeEpoch: "epoch-1",
    coreGeneration: "generation-1",
  });
  return transport;
};

const serveReplayBoundary = async (): Promise<string> => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-test-"));
  directories.push(directory);
  const socketPath = testEndpoint(directory);
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "close",
    });
    response.end(`event: core-resync-required\ndata: ${JSON.stringify(replayBoundary)}\n\n`);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
};

const serveCommittedEvent = async (event: unknown): Promise<string> => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-test-"));
  directories.push(directory);
  const socketPath = testEndpoint(directory);
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "close",
    });
    response.end(`event: module\ndata: ${JSON.stringify(event)}\n\n`);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
};

const serveSseFrames = async (frames: string): Promise<string> => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-test-"));
  directories.push(directory);
  const socketPath = testEndpoint(directory);
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/event-stream",
      connection: "close",
    });
    response.end(frames);
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
};

const serveLiveEventStream = async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-test-"));
  directories.push(directory);
  const socketPath = testEndpoint(directory);
  let activeResponse: ServerResponse | undefined;
  const server = createServer((_request, response) => {
    activeResponse = response;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, disconnect: () => activeResponse?.destroy() };
};

const servePendingResponse = async (): Promise<string> => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-test-"));
  directories.push(directory);
  const socketPath = testEndpoint(directory);
  const server = createServer(() => {
    // Keep the request pending so the caller owns cancellation.
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
};

const serveManagedRequest = async (): Promise<{
  readonly socketPath: string;
  readonly requestHeaders: Promise<import("node:http").IncomingHttpHeaders>;
  readonly cancelledRequestId: Promise<string>;
}> => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-test-"));
  directories.push(directory);
  const socketPath = testEndpoint(directory);
  let resolveHeaders!: (headers: import("node:http").IncomingHttpHeaders) => void;
  let resolveCancellation!: (requestId: string) => void;
  const requestHeaders = new Promise<import("node:http").IncomingHttpHeaders>((resolve) => {
    resolveHeaders = resolve;
  });
  const cancelledRequestId = new Promise<string>((resolve) => {
    resolveCancellation = resolve;
  });
  const server = createServer((request, response) => {
    if (request.url !== "/core/v1/requests/cancel") {
      resolveHeaders(request.headers);
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        readonly request_id: string;
      };
      resolveCancellation(body.request_id);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"cancelled":true}');
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return { socketPath, requestHeaders, cancelledRequestId };
};

const serveResponse = async (
  serialized: string,
  mode: "content-length" | "chunked" = "content-length",
  declaredLength?: number,
  http: { readonly status?: number; readonly contentType?: string } = {},
): Promise<string> => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-test-"));
  directories.push(directory);
  const socketPath = testEndpoint(directory);
  const server = createServer((_request, response) => {
    if (mode === "content-length") {
      response.writeHead(http.status ?? 200, {
        "content-length": declaredLength ?? Buffer.byteLength(serialized),
        "content-type": http.contentType ?? "application/json",
        connection: "close",
      });
      response.end(serialized);
      return;
    }
    response.writeHead(http.status ?? 200, {
      "content-type": http.contentType ?? "application/json",
      "transfer-encoding": "chunked",
      connection: "close",
    });
    const midpoint = Math.floor(serialized.length / 2);
    response.write(serialized.slice(0, midpoint));
    response.end(serialized.slice(midpoint));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  return socketPath;
};

const committedEvent = (): CoreEventEnvelope => ({
  transport_version: 8,
  packet: createCoreLocalCommitFixture({
    commitSeq: 1,
    operationId: "operation-1",
    committedAt: "2026-07-22T00:00:00.000Z",
    payload: {
      module: "project_workspace",
      library_id: "library-1",
      event: {
        kind: "workspace_changed",
        project_catalog_change: null,
        project_ids: [],
        session_ids: [],
        thread_ids: [],
        session_summary_scopes: [],
        session_detail_ids: [],
      },
    },
    canonicalHash: "0".repeat(64),
  }),
});

const serveLargeCommittedEvent = async (): Promise<string> =>
  await serveCommittedEvent({
    transport_version: 8,
    packet: createCoreLocalCommitFixture({
      commitSeq: 1,
      committedAt: "2026-07-22T00:00:00.000Z",
      payload: {
        module: "project_workspace",
        library_id: "library-1",
        event: {
          kind: "workspace_changed",
          project_catalog_change: null,
          project_ids: Array.from(
            { length: 1_400 },
            (_, index) => `project-${index.toString().padStart(4, "0")}-${"p".repeat(480)}`,
          ),
          session_ids: [],
          thread_ids: [],
          session_summary_scopes: [],
          session_detail_ids: [],
        },
      },
      canonicalHash: "0".repeat(64),
    }),
  });

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const requestError: components["schemas"]["CoreError"] = {
  code: "invalid_input",
  message: "sources[0]: expected a path string",
  retryable: false,
  recovery: { kind: "none" },
};

const binaryRequestBody = Uint8Array.of(0x00, 0x80, 0xff);

const requestByBoundary = (transport: LocalHttpTransport, boundary: string): Promise<unknown> => {
  if (boundary === "document") {
    return transport.requestDocumentFrame(
      "/core/v1/modules/document/read",
      new Uint8Array(),
      {},
      16_384,
    );
  }
  if (boundary === "blob") {
    return transport.requestBoundedBytes(
      "POST",
      "/core/v1/files/blobs/prepare",
      binaryRequestBody,
      {},
      16_384,
    );
  }
  if (boundary === "agent run") {
    return transport.requestJson("POST", "/core/v1/agent-runs/record", { run_id: "run-1" });
  }
  if (boundary === "events") {
    return configureEventContract(transport).openEventStream(0, () => undefined);
  }
  return transport.requestJson("POST", "/core/v1/modules/workspace/apply", {});
};

describe("Core HTTP request failures", () => {
  test.each(["json", "document", "blob", "events"])(
    "preserves validation errors at the %s boundary",
    async (boundary) => {
      const transport = new LocalHttpTransport(
        await serveResponse(
          JSON.stringify({ status: "error", payload: requestError }),
          "content-length",
          undefined,
          { status: 422 },
        ),
        "test-capability",
      );
      const error = await requestByBoundary(transport, boundary).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CoreHttpError);
      expect(error).toMatchObject({
        status: 422,
        message: requestError.message,
        coreError: requestError,
      });
      expect(classifyCoreOperationFailure("workspace.apply", error, "generation-1")).toMatchObject({
        reason: "request",
        retryable: false,
        message: requestError.message,
        operation: "workspace.apply",
        generation: "generation-1",
        cause: error,
      });
    },
  );

  test.each(["json", "document", "blob", "events"])(
    "classifies non-JSON HTTP rejections by status at the %s boundary",
    async (boundary) => {
      const message = "Failed to deserialize the JSON body into the target type";
      const transport = new LocalHttpTransport(
        await serveResponse(message, "content-length", undefined, {
          status: 422,
          contentType: "text/plain",
        }),
        "test-capability",
      );
      const error = await requestByBoundary(transport, boundary).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CoreHttpError);
      expect(error).toMatchObject({ status: 422, message });
      expect(classifyCoreOperationFailure("workspace.apply", error)).toMatchObject({
        reason: "request",
        retryable: false,
      });
    },
  );

  test.each([400, 413, 415, 422, 500, 503])(
    "retains HTTP %s when its error body is empty or malformed",
    async (status) => {
      const transport = new LocalHttpTransport(
        await serveResponse(status === 500 ? "{" : "", "content-length", undefined, { status }),
        "test-capability",
      );
      const error = await transport
        .requestJson("GET", "/core/v1/health")
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(CoreHttpError);
      expect(error).toMatchObject({ status });
      const classified = classifyCoreOperationFailure("health", error);
      expect(classified.reason).toBe(
        status === 503 ? "transport-loss" : status === 500 ? "operation" : "request",
      );
      expect(classified.retryable).toBe(status === 503);
    },
  );

  test("preserves transport-bound recovery details in the shared envelope", async () => {
    const failure = {
      reason: "request_too_large",
      effect: "not_applied",
      actual: 65,
      limit: 64,
    } as const;
    const coreError = { ...requestError, recovery: { kind: "recovery_package", failure } } as const;
    const transport = new LocalHttpTransport(
      await serveResponse(
        JSON.stringify({ status: "error", payload: coreError }),
        "content-length",
        undefined,
        { status: 413 },
      ),
      "test-capability",
    );
    await expect(transport.requestJson("POST", "/core/v1/handshake", {})).rejects.toMatchObject({
      status: 413,
      coreError,
      failure,
    });
  });

  test("treats semantic invalid input as the same request failure", () => {
    const error = new CoreModuleResponseError(requestError);
    expect(classifyCoreOperationFailure("workspace.apply", error)).toMatchObject({
      reason: "request",
      retryable: false,
      message: requestError.message,
      cause: error,
    });
  });

  test("never recovers a generation for structured validation evidence", () => {
    const error = new CoreHttpError(503, requestError.message, undefined, requestError);
    expect(isRecoverableCoreTransportFailure(error)).toBe(false);
    expect(classifyCoreOperationFailure("workspace.apply", error)).toMatchObject({
      reason: "request",
      retryable: false,
    });
  });

  test("keeps malformed successful responses as protocol failures", async () => {
    const transport = new LocalHttpTransport(
      await serveResponse("Failed to decode"),
      "test-capability",
    );
    const error = await transport
      .requestJson("GET", "/core/v1/health")
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(CoreCodecError);
    expect(classifyCoreOperationFailure("health", error)).toMatchObject({
      reason: "protocol",
      retryable: false,
    });
  });
});

type ControlledRequestOptions = RequestOptions & { headers: OutgoingHttpHeaders };

const controlledLocalCore = (agent?: Agent) => {
  const socketPath = testEndpoint(`core-admission-${randomBytes(8).toString("hex")}`);
  const sent: Array<{
    options: ControlledRequestOptions;
    body: readonly Uint8Array[];
    respond: (status?: number, value?: unknown, retryAfter?: string) => void;
  }> = [];
  const request = (
    options: ControlledRequestOptions,
    receive: (response: IncomingMessage) => void,
  ) => {
    const outgoing = new EventEmitter();
    const body: Uint8Array[] = [];
    const destroy = (error: Error) => {
      outgoing.emit("error", error);
    };
    return Object.assign(outgoing, {
      write: (bytes: Uint8Array) => body.push(bytes),
      destroy,
      end: () =>
        sent.push({
          options,
          body,
          respond: (status = 200, value = null, retryAfter?: string) => {
            const response = new IncomingMessage(new Socket());
            response.statusCode = status;
            response.headers["content-type"] = "application/json";
            if (retryAfter !== undefined) response.headers["retry-after"] = retryAfter;
            receive(response);
            response.push(Buffer.from(JSON.stringify(value)));
            response.push(null);
          },
        }),
    });
  };
  return {
    sent,
    transport: (endpoint = socketPath) =>
      new LocalHttpTransport(endpoint, "test-capability", {
        connection: {
          request: request as unknown as typeof import("node:http").request,
          options: { socketPath: endpoint, agent },
          credential: () => "test-capability",
          ...(agent ? { maximumQueuedRequests: 1 } : {}),
        },
      }),
  };
};

const admissionRefusal = {
  status: "error",
  payload: {
    code: "overloaded",
    message: "Core interactive request admission is full",
    retryable: true,
    recovery: { kind: "retry_admission", milliseconds: 100 },
  },
} as const;

const queuedDeadline = {
  status: "error",
  payload: {
    code: "deadline_exceeded",
    message: "Core request deadline was exceeded",
    retryable: true,
    recovery: { kind: "none" },
  },
} as const;

const queueRequest = (transport: LocalHttpTransport, id: string, options?: CoreRequestOptions) =>
  transport.requestJson("POST", `/core/v1/modules/library/read?test=${id}`, {}, {}, options);

describe("Local Core request admission", () => {
  afterEach(() => vi.useRealTimers());

  test("shares each class's in-flight budget across transports and admits waiters in FIFO order", async () => {
    vi.useFakeTimers();
    const core = controlledLocalCore();
    const first = core.transport();
    const second = core.transport();
    const classes = [
      { name: "interactive", limit: 64 },
      { name: "background", limit: 16 },
      { name: "maintenance", limit: 4 },
    ] as const;
    const pending = classes.flatMap(({ name, limit }) =>
      Array.from({ length: limit + 2 }, (_, index) =>
        queueRequest(index % 2 === 0 ? first : second, `${name}-${index}`, { class: name }),
      ),
    );
    pending.push(first.requestJson("GET", "/core/v1/health"));
    const sentFor = (name: string) =>
      core.sent.filter(({ options }) => options.headers?.["x-nodex-request-class"] === name);
    await vi.advanceTimersByTimeAsync(0);

    const completed = new Set<(typeof core.sent)[number]>();
    const respond = (request: (typeof core.sent)[number]): void => {
      completed.add(request);
      request.respond();
    };
    expect(core.sent.at(-1)?.options).toMatchObject({ path: "/core/v1/health" });
    expect(core.sent.at(-1)?.options.headers).not.toHaveProperty("x-nodex-request-class");
    for (const { name, limit } of classes) {
      const sent = sentFor(name);
      expect(sent).toHaveLength(limit);
      respond(sent[0]!);
      await vi.advanceTimersByTimeAsync(0);
      expect(sentFor(name).at(-1)?.options.path).toContain(`test=${name}-${limit}`);
      expect(sentFor(name)).toHaveLength(limit + 1);
      respond(sent[1]!);
      await vi.advanceTimersByTimeAsync(0);
      expect(sentFor(name).at(-1)?.options.path).toContain(`test=${name}-${limit + 1}`);
      expect(sentFor(name)).toHaveLength(limit + 2);
    }

    for (const sent of core.sent) {
      if (!completed.has(sent)) sent.respond();
    }
    await Promise.all(pending);
  });

  test("removes cancelled and expired waiters without freeing an occupied slot", async () => {
    vi.useFakeTimers();
    const core = controlledLocalCore();
    const transport = core.transport();
    const running = Array.from({ length: 4 }, (_, index) =>
      queueRequest(transport, String(index), { class: "maintenance" }),
    );
    const controller = new AbortController();
    const cancelled = queueRequest(transport, "cancelled", {
      class: "maintenance",
      signal: controller.signal,
    });
    const cancellation = expect(cancelled).rejects.toMatchObject({
      name: "CoreTransportError",
      kind: "aborted",
      phase: "connect",
      code: "ABORT_ERR",
    });
    const expiring = {
      class: "maintenance",
      deadlineMs: CORE_TRANSPORT_BUDGETS.request_deadline_min_ms + 50,
    } as const;
    const expired = queueRequest(transport, "expired", expiring);
    const expiredDocument = transport.requestDocumentFrame(
      "/core/v1/modules/document/read",
      new Uint8Array(),
      {},
      16_384,
      expiring,
    );
    const expiredBlob = expect(
      transport.requestBoundedBytes(
        "GET",
        "/core/v1/files/blobs/file-1",
        undefined,
        {},
        16_384,
        expiring,
      ),
    ).rejects.toMatchObject({
      name: "CoreHttpError",
      status: 504,
      coreError: queuedDeadline.payload,
    });
    const expiredRecord = expect(
      transport.requestJson("POST", "/core/v1/agent-runs/record", {}, {}, expiring),
    ).rejects.toMatchObject({
      name: "CoreHttpError",
      status: 504,
      coreError: queuedDeadline.payload,
    });
    const next = queueRequest(transport, "next", { class: "maintenance", deadlineMs: 1_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(core.sent).toHaveLength(4);

    controller.abort();
    await cancellation;
    await vi.advanceTimersByTimeAsync(51);
    await expect(expired).resolves.toEqual(queuedDeadline);
    await expect(expiredDocument).resolves.toEqual({ kind: "json", value: queuedDeadline });
    await Promise.all([expiredBlob, expiredRecord]);
    expect(core.sent).toHaveLength(4);

    core.sent[0]!.respond();
    await vi.advanceTimersByTimeAsync(0);
    expect(core.sent).toHaveLength(5);
    expect(core.sent[4]?.options).toMatchObject({
      path: "/core/v1/modules/library/read?test=next",
      headers: { "x-nodex-request-deadline-ms": "949" },
    });
    for (const sent of core.sent.slice(1)) sent.respond();
    await Promise.all([...running, next]);
  });

  test.each([
    { boundary: "json", retryAfter: "2", milliseconds: 100 },
    { boundary: "document", retryAfter: undefined, milliseconds: 100 },
    { boundary: "blob", retryAfter: "2", milliseconds: 750 },
    { boundary: "agent run", retryAfter: "1", milliseconds: 100 },
  ])(
    "replays a Core admission refusal at the $boundary boundary with a new id and the same body",
    async ({ boundary, retryAfter, milliseconds }) => {
      vi.useFakeTimers();
      const core = controlledLocalCore();
      const pending = requestByBoundary(core.transport(), boundary);
      await vi.advanceTimersByTimeAsync(0);
      const initial = core.sent[0]!;
      initial.respond(
        429,
        {
          ...admissionRefusal,
          payload: {
            ...admissionRefusal.payload,
            recovery: { kind: "retry_admission", milliseconds },
          },
        },
        retryAfter,
      );
      await vi.advanceTimersByTimeAsync(milliseconds - 1);
      expect(core.sent).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(core.sent).toHaveLength(2);
      const replay = core.sent[1]!;
      expect(replay.body).toEqual(initial.body);
      if (boundary === "blob") {
        expect(replay.options.method).toBe("POST");
        expect(replay.body).toEqual([binaryRequestBody]);
      }
      expect(replay.options).toMatchObject({
        path: initial.options.path,
        method: initial.options.method,
        headers: {
          "x-nodex-request-class": "background",
          "x-nodex-request-deadline-ms": String(
            CORE_TRANSPORT_BUDGETS.background_request_deadline_ms - milliseconds,
          ),
        },
      });
      expect(replay.options.headers?.["x-nodex-request-id"]).not.toBe(
        initial.options.headers?.["x-nodex-request-id"],
      );
      replay.respond();
      await pending;
    },
  );

  test("surfaces the last admission refusal when the deadline rules out the next attempt", async () => {
    vi.useFakeTimers();
    const core = controlledLocalCore();
    const pending = queueRequest(core.transport(), "refused", {
      deadlineMs: CORE_TRANSPORT_BUDGETS.request_deadline_min_ms + 150,
    });
    const result = pending.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    core.sent[0]!.respond(429, admissionRefusal, "1");
    await vi.advanceTimersByTimeAsync(admissionRefusal.payload.recovery.milliseconds);
    expect(core.sent).toHaveLength(2);
    const latest = { ...admissionRefusal.payload, message: "Core interactive admission is full" };
    core.sent[1]!.respond(429, { status: "error", payload: latest }, "1");

    const error = await result;
    expect(error).toBeInstanceOf(CoreRateLimitError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 100, coreError: latest });
    await vi.advanceTimersByTimeAsync(500);
    expect(core.sent).toHaveLength(2);
  });

  test("keeps the slot through exponential retries and releases it when backoff is cancelled", async () => {
    vi.useFakeTimers();
    const jitter = vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const core = controlledLocalCore();
      const transport = core.transport();
      const controller = new AbortController();
      const pending = queueRequest(transport, "refused", {
        class: "maintenance",
        signal: controller.signal,
      });
      const cancellation = expect(pending).rejects.toMatchObject({ kind: "aborted" });
      const queued = Array.from({ length: 4 }, (_, index) =>
        queueRequest(transport, String(index), { class: "maintenance" }),
      );
      await vi.advanceTimersByTimeAsync(0);
      const refusal = {
        ...admissionRefusal,
        payload: {
          ...admissionRefusal.payload,
          recovery: { kind: "retry_admission", milliseconds: 0 },
        },
      };
      core.sent[0]!.respond(429, refusal, "0");
      await vi.advanceTimersByTimeAsync(24);
      expect(core.sent).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1);
      expect(core.sent).toHaveLength(5);
      expect(core.sent[4]?.options.path).toContain("test=refused");
      core.sent[4]!.respond(429, refusal, "0");
      await vi.advanceTimersByTimeAsync(49);
      expect(core.sent).toHaveLength(5);

      controller.abort();
      await cancellation;
      expect(core.sent).toHaveLength(6);
      expect(core.sent[5]?.options.path).toContain("test=3");
      for (const sent of [...core.sent.slice(1, 4), core.sent[5]!]) sent.respond();
      await Promise.all(queued);
    } finally {
      jitter.mockRestore();
    }
  });

  test.each([
    { code: "overloaded", recovery: { kind: "none" } },
    { code: "resource_exhausted", recovery: admissionRefusal.payload.recovery },
  ])("only replays explicit Core admission refusals", async ({ code, recovery }) => {
    vi.useFakeTimers();
    const core = controlledLocalCore();
    const pending = queueRequest(core.transport(), "overloaded");
    const refusal = expect(pending).rejects.toMatchObject({
      name: "CoreRateLimitError",
      coreError: { code, recovery },
    });
    await vi.advanceTimersByTimeAsync(0);
    core.sent[0]!.respond(
      429,
      { ...admissionRefusal, payload: { ...admissionRefusal.payload, code, recovery } },
      "1",
    );
    await refusal;
    await vi.advanceTimersByTimeAsync(500);
    expect(core.sent).toHaveLength(1);
  });

  test("does not replay the HTTP agent's client-side queue refusal", async () => {
    vi.useFakeTimers();
    const agent = new Agent({ maxSockets: 1 });
    Object.assign(agent.requests, { test: [{} as ClientRequest] });
    const core = controlledLocalCore(agent);
    try {
      await expect(queueRequest(core.transport(), "client-queue")).rejects.toMatchObject({
        name: "CoreRateLimitError",
        status: 429,
        message: "Core client request queue is full",
      });
      expect(core.sent).toHaveLength(0);
    } finally {
      Reflect.deleteProperty(agent.requests, "test");
      agent.destroy();
    }
  });
});

describe("Local Core event replay boundaries", () => {
  test("classifies a missing Core socket as definitive generation loss", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-missing-"));
    directories.push(directory);
    const transport = new LocalHttpTransport(testEndpoint(directory), "test-capability");

    const error = await transport
      .requestJson("GET", "/core/v1/health")
      .catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      code: "ENOENT",
      kind: "unreachable",
      name: "CoreTransportError",
      phase: "connect",
    });
    expect(isDefinitiveCoreGenerationLoss(error)).toBe(true);
  });

  test("keeps response timeouts distinct from generation loss", async () => {
    const transport = new LocalHttpTransport(await servePendingResponse(), "test-capability", {
      requestTimeoutMs: 10,
    });

    const error = await transport
      .requestJson("GET", "/core/v1/health")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CoreTransportError);
    expect(error).toMatchObject({ kind: "timeout", phase: "response" });
    expect(isDefinitiveCoreGenerationLoss(error)).toBe(false);
  });

  test("lets a quiet phone poll outlive the ordinary transport liveness window", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-phone-poll-"));
    directories.push(directory);
    const socketPath = testEndpoint(directory);
    const server = createServer((_request, response) => {
      setTimeout(() => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end("null");
      }, 30);
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
    const transport = new LocalHttpTransport(socketPath, "test-capability", {
      requestTimeoutMs: 5,
    });
    await expect(
      transport.requestJson("POST", "/core/v1/host/phone/poll", { token: "lease" }),
    ).resolves.toBeNull();
  });

  test("sends execution metadata and propagates aborts to Core cancellation", async () => {
    const managed = await serveManagedRequest();
    const transport = new LocalHttpTransport(managed.socketPath, "test-capability");
    const controller = new AbortController();
    const pending = transport.requestJson(
      "POST",
      "/core/v1/modules/library/read",
      { read: { kind: "metadata" } },
      {
        "x-nodex-connection-id": "connection-1",
        "x-nodex-connection-binding": "binding-1",
      },
      { class: "interactive", deadlineMs: 12_345, signal: controller.signal },
    );
    const headers = await managed.requestHeaders;

    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "ABORT_ERR", kind: "aborted" });
    expect(headers["x-nodex-request-class"]).toBe("interactive");
    expect(Number(headers["x-nodex-request-deadline-ms"])).toBeGreaterThanOrEqual(
      CORE_TRANSPORT_BUDGETS.request_deadline_min_ms,
    );
    expect(Number(headers["x-nodex-request-deadline-ms"])).toBeLessThanOrEqual(12_345);
    expect(await managed.cancelledRequestId).toBe(headers["x-nodex-request-id"]);
  });

  test("bounds caller-specific response and timeout budgets", () => {
    expect(
      () =>
        new LocalHttpTransport("/tmp/core.sock", "capability", {
          maximumJsonResponseBytes: CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes + 1,
        }),
    ).toThrow("Core JSON response limit must be a positive integer");
    expect(
      () =>
        new LocalHttpTransport("/tmp/core.sock", "capability", {
          requestTimeoutMs: 120_001,
        }),
    ).toThrow("Core request timeout must be a positive integer");
    expect(
      () =>
        new LocalHttpTransport("/tmp/core.sock", "capability", {
          maximumJsonResponseBytes: CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes,
          requestTimeoutMs: 60_000,
        }),
    ).not.toThrow();
  });

  test("reads an ordinary JSON response larger than the legacy 512 KiB limit", async () => {
    const value = "x".repeat(600 * 1024);
    const transport = new LocalHttpTransport(
      await serveResponse(JSON.stringify({ value })),
      "test-capability",
    );

    await expect(
      transport.requestJson<{ readonly value: string }>("GET", "/core/v1/health"),
    ).resolves.toEqual({ value });
  });

  test("rejects an oversized declared ordinary JSON response before reading it", async () => {
    const maximum = CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes;
    const transport = new LocalHttpTransport(
      await serveResponse("{}", "content-length", maximum + 1),
      "test-capability",
    );

    await expect(transport.requestJson("GET", "/core/v1/health")).rejects.toEqual(
      new CoreResponseTooLargeError(maximum, maximum + 1),
    );
  });

  test("rejects an oversized chunked ordinary JSON response while streaming it", async () => {
    const maximum = CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes;
    const serialized = JSON.stringify({ value: "x".repeat(maximum) });
    const transport = new LocalHttpTransport(
      await serveResponse(serialized, "chunked"),
      "test-capability",
    );

    await expect(transport.requestJson("GET", "/core/v1/health")).rejects.toMatchObject({
      name: "CoreResponseTooLargeError",
      maximumBytes: maximum,
    });
  });

  test("delivers an explicit resync boundary to a registered consumer", async () => {
    const transport = configureEventContract(
      new LocalHttpTransport(await serveReplayBoundary(), "test-capability"),
    );
    let observed: CoreEventReplayRequired | undefined;

    const subscription = await transport.openEventStream(
      4,
      () => undefined,
      {},
      undefined,
      (boundary) => {
        observed = boundary;
      },
    );

    await expect(subscription.done).resolves.toBeUndefined();
    expect(observed).toEqual(replayBoundary);
  });

  test("fails closed when a resync boundary has no consumer", async () => {
    const transport = configureEventContract(
      new LocalHttpTransport(await serveReplayBoundary(), "test-capability"),
    );
    const subscription = await transport.openEventStream(4, () => undefined);

    await expect(subscription.done).rejects.toEqual(new CoreEventReplayError(replayBoundary));
  });

  test("delivers the checkpoint when the retained replay window is empty", async () => {
    const checkpoint: CoreStreamCheckpoint = {
      store_epoch: "epoch-1",
      generation: "generation-1",
      scanned_through_seq: 42,
      oldest_available_seq: 43,
      resync_token: null,
    };
    const transport = configureEventContract(
      new LocalHttpTransport(
        await serveSseFrames(`event: stream-checkpoint\ndata: ${JSON.stringify(checkpoint)}\n\n`),
        "test-capability",
      ),
    );
    const observed: CoreStreamCheckpoint[] = [];
    const subscription = await transport.openEventStream(
      42,
      () => undefined,
      {},
      undefined,
      undefined,
      (value) => observed.push(value),
    );

    await expect(subscription.done).resolves.toBeUndefined();
    expect(observed).toEqual([checkpoint]);
  });

  test("rejects a replay checkpoint whose retention boundary is beyond the next sequence", async () => {
    const checkpoint: CoreStreamCheckpoint = {
      store_epoch: "epoch-1",
      generation: "generation-1",
      scanned_through_seq: 42,
      oldest_available_seq: 44,
      resync_token: null,
    };
    const transport = configureEventContract(
      new LocalHttpTransport(
        await serveSseFrames(`event: stream-checkpoint\ndata: ${JSON.stringify(checkpoint)}\n\n`),
        "test-capability",
      ),
    );
    const observed: CoreStreamCheckpoint[] = [];
    const subscription = await transport.openEventStream(
      42,
      () => undefined,
      {},
      undefined,
      undefined,
      (value) => observed.push(value),
    );

    await expect(subscription.done).rejects.toEqual(
      new CoreEventCompatibilityError("Core stream checkpoint is invalid"),
    );
    expect(observed).toEqual([]);
  });

  test("accepts a legal committed event larger than the old 512 KiB budget", async () => {
    const transport = configureEventContract(
      new LocalHttpTransport(await serveLargeCommittedEvent(), "test-capability"),
    );
    let sequence: number | undefined;
    const subscription = await transport.openEventStream(0, (envelope) => {
      sequence = envelope.packet.manifest.identity.commit_seq;
    });

    await expect(subscription.done).resolves.toBeUndefined();
    expect(sequence).toBe(1);
  });

  test("rejects a legacy transport envelope before delivering it", async () => {
    const event = { ...committedEvent(), transport_version: 2 };
    const transport = configureEventContract(
      new LocalHttpTransport(await serveCommittedEvent(event), "test-capability"),
    );
    let deliveries = 0;
    const subscription = await transport.openEventStream(0, () => {
      deliveries += 1;
    });

    await expect(subscription.done).rejects.toEqual(
      new CoreEventCompatibilityError("Core event transport version is invalid"),
    );
    expect(deliveries).toBe(0);
  });

  test("rejects a packet without DeliveryAtoms before delivery", async () => {
    const event = structuredClone(committedEvent()) as unknown as {
      transport_version: number;
      packet: Record<string, unknown>;
    };
    delete event.packet.atoms;
    const transport = configureEventContract(
      new LocalHttpTransport(await serveCommittedEvent(event), "test-capability"),
    );
    let deliveries = 0;
    const subscription = await transport.openEventStream(0, () => {
      deliveries += 1;
    });

    await expect(subscription.done).rejects.toEqual(
      new CoreEventCompatibilityError("Authorized delivery packet is invalid"),
    );
    expect(deliveries).toBe(0);
  });

  test("rejects a packet without an exact delivery address", async () => {
    const event = structuredClone(committedEvent()) as unknown as {
      transport_version: number;
      packet: Record<string, unknown>;
    };
    delete event.packet.delivery_address;
    const transport = configureEventContract(
      new LocalHttpTransport(await serveCommittedEvent(event), "test-capability"),
    );
    let deliveries = 0;
    const subscription = await transport.openEventStream(0, () => {
      deliveries += 1;
    });

    await expect(subscription.done).rejects.toEqual(
      new CoreEventCompatibilityError("Authorized delivery packet is invalid"),
    );
    expect(deliveries).toBe(0);
  });

  test("accepts canonical compound DeliveryAtom requirements", async () => {
    const event: CoreEventEnvelope = {
      transport_version: 8,
      packet: createCoreLocalCommitFixture({
        commitSeq: 2,
        requiredResources: [
          { kind: "library", library_id: "library-1" },
          { kind: "page", page_id: "block-a" },
          { kind: "page", page_id: "block-b" },
          { kind: "document", document_id: "document-a" },
          { kind: "document", document_id: "document-b" },
          { kind: "database", database_id: "database-a" },
          { kind: "database", database_id: "database-b" },
        ],
        payload: {
          module: "library",
          library_id: "library-1",
          event: {
            kind: "library_changed",
            database_ids: [],
            file_revisions: {},
            page_file_manifest_invalidations: {},
            page_file_body_usage_revisions: {},
            page_file_content_invalidations: {},
            page_ids: [],
            parent_keys: [],
            view_ids: [],
          },
        },
      }),
    };
    const transport = configureEventContract(
      new LocalHttpTransport(await serveCommittedEvent(event), "test-capability"),
    );
    let deliveries = 0;
    const subscription = await transport.openEventStream(0, () => {
      deliveries += 1;
    });

    await expect(subscription.done).resolves.toBeUndefined();
    expect(deliveries).toBe(1);
  });

  test("opens the scoped Projection broker only after its exact barrier", async () => {
    const barrier = {
      store_epoch: "epoch-1",
      core_generation: "generation-1",
      commit_head: 4,
      recipient_leases: [
        {
          lease_id: "a".repeat(64),
          delivery_address: {
            kind: "project",
            library_id: "library-1",
            project_id: "project-1",
          },
        },
      ],
    };
    const frames =
      `event: projection-live-opened\ndata: ${JSON.stringify(barrier)}\n\n` +
      `event: module\ndata: ${JSON.stringify(committedEvent())}\n\n`;
    const transport = configureEventContract(
      new LocalHttpTransport(await serveSseFrames(frames), "test-capability"),
    );
    const delivered: CoreEventEnvelope[] = [];
    const subscription = await transport.openProjectionLiveStream(
      [{ kind: "project", libraryId: "library-1", projectId: "project-1" }],
      {},
      (event) => delivered.push(event),
      () => undefined,
    );

    expect(subscription.barrier).toEqual(barrier);
    await expect(subscription.done).resolves.toBeUndefined();
    expect(delivered).toHaveLength(1);
  });

  test("rejects a Projection barrier for a different delivery address", async () => {
    const barrier = {
      store_epoch: "epoch-1",
      core_generation: "generation-1",
      commit_head: 4,
      recipient_leases: [
        {
          lease_id: "a".repeat(64),
          delivery_address: {
            kind: "project",
            library_id: "library-1",
            project_id: "project-other",
          },
        },
      ],
    };
    const transport = configureEventContract(
      new LocalHttpTransport(
        await serveSseFrames(`event: projection-live-opened\ndata: ${JSON.stringify(barrier)}\n\n`),
        "test-capability",
      ),
    );

    await expect(
      transport.openProjectionLiveStream(
        [{ kind: "project", libraryId: "library-1", projectId: "project-1" }],
        {},
        () => undefined,
        () => undefined,
      ),
    ).rejects.toEqual(
      new CoreEventCompatibilityError(
        "Core Projection live barrier diverges from its requested scopes",
      ),
    );
  });

  test("rejects noncanonical DeliveryAtom requirements", async () => {
    const event: CoreEventEnvelope = {
      transport_version: 8,
      packet: createCoreLocalCommitFixture({
        commitSeq: 2,
        requiredResources: [
          { kind: "library", library_id: "library-1" },
          { kind: "page", page_id: "block-b" },
          { kind: "page", page_id: "block-a" },
        ],
        payload: {
          module: "library",
          library_id: "library-1",
          event: {
            kind: "library_changed",
            database_ids: [],
            file_revisions: {},
            page_file_manifest_invalidations: {},
            page_file_body_usage_revisions: {},
            page_file_content_invalidations: {},
            page_ids: [],
            parent_keys: [],
            view_ids: [],
          },
        },
      }),
    };
    const transport = configureEventContract(
      new LocalHttpTransport(await serveCommittedEvent(event), "test-capability"),
    );
    let deliveries = 0;
    const subscription = await transport.openEventStream(0, () => {
      deliveries += 1;
    });

    await expect(subscription.done).rejects.toEqual(
      new CoreEventCompatibilityError("Authorized delivery packet is invalid"),
    );
    expect(deliveries).toBe(0);
  });

  test("classifies premature live response closure as recoverable connection loss", async () => {
    const server = await serveLiveEventStream();
    const transport = configureEventContract(
      new LocalHttpTransport(server.socketPath, "capability"),
    );
    const subscription = await transport.openEventStream(0, () => undefined);
    const failure = subscription.done.catch((error: unknown) => error);
    server.disconnect();

    const error = await failure;
    expect(error).toBeInstanceOf(CoreTransportError);
    expect(error).toMatchObject({ kind: "connection_lost", phase: "response", code: "ECONNRESET" });
    expect(isDefinitiveCoreGenerationLoss(error)).toBe(true);
    expect(classifyCoreOperationFailure("events.read", error)).toMatchObject({
      reason: "transport-loss",
      retryable: true,
    });
  });

  test("keeps explicit stream cancellation distinct from remote connection loss", async () => {
    const server = await serveLiveEventStream();
    const transport = configureEventContract(
      new LocalHttpTransport(server.socketPath, "capability"),
    );
    const controller = new AbortController();
    const subscription = await transport.openEventStream(
      0,
      () => undefined,
      {},
      undefined,
      undefined,
      undefined,
      controller.signal,
    );
    const failure = subscription.done.catch((error: unknown) => error);
    controller.abort(new Error("subscription owner closed"));

    const error = await failure;
    expect(error).toMatchObject({ kind: "aborted", code: "ABORT_ERR" });
    expect(isDefinitiveCoreGenerationLoss(error)).toBe(false);
  });

  test("closing a live subscription completes normally", async () => {
    const server = await serveLiveEventStream();
    const transport = configureEventContract(
      new LocalHttpTransport(server.socketPath, "capability"),
    );
    const subscription = await transport.openEventStream(0, () => undefined);
    subscription.close();
    await expect(subscription.done).resolves.toBeUndefined();
  });

  test("aborts an event stream that has not received response headers", async () => {
    const transport = configureEventContract(
      new LocalHttpTransport(await servePendingResponse(), "test-capability"),
    );
    const controller = new AbortController();
    const opening = transport.openEventStream(
      0,
      () => undefined,
      {},
      undefined,
      undefined,
      undefined,
      controller.signal,
    );

    controller.abort(new Error("subscription closed"));

    await expect(opening).rejects.toMatchObject({ code: "ABORT_ERR" });
  });
});
