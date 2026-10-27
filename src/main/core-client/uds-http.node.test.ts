import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vite-plus/test";
import {
  CORE_CLIENT_REQUIREMENTS,
  CORE_TRANSPORT_BUDGETS,
  type components,
} from "@nodex/core-protocol";

import type { CoreEventEnvelope, CoreEventReplayRequired, CoreStreamCheckpoint } from "./types";
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
  CoreResponseTooLargeError,
  CoreTransportError,
  UdsHttpTransport,
  isDefinitiveCoreGenerationLoss,
} from "./uds-http";

const servers: Server[] = [];
const directories: string[] = [];

const replayBoundary: CoreEventReplayRequired = {
  requested_after: 4,
  oldest_available: 7,
  commit_head: 12,
  generation: "generation:test",
  resync_token: "resync:test",
};

const configureEventContract = (transport: UdsHttpTransport): UdsHttpTransport => {
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
  const socketPath = path.join(directory, "core.sock");
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
  const socketPath = path.join(directory, "core.sock");
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
  const socketPath = path.join(directory, "core.sock");
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

const servePendingResponse = async (): Promise<string> => {
  const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-test-"));
  directories.push(directory);
  const socketPath = path.join(directory, "core.sock");
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
  const socketPath = path.join(directory, "core.sock");
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
  const socketPath = path.join(directory, "core.sock");
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

const requestByBoundary = (transport: UdsHttpTransport, boundary: string): Promise<unknown> => {
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
      "GET",
      "/core/v1/files/blobs/file-1",
      undefined,
      {},
      16_384,
    );
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
      const transport = new UdsHttpTransport(
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
      const transport = new UdsHttpTransport(
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
      const transport = new UdsHttpTransport(
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
    const transport = new UdsHttpTransport(
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
    const transport = new UdsHttpTransport(
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

describe("UDS Core event replay boundaries", () => {
  test("classifies a missing Core socket as definitive generation loss", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "nodex-core-uds-missing-"));
    directories.push(directory);
    const transport = new UdsHttpTransport(path.join(directory, "core.sock"), "test-capability");

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
    const transport = new UdsHttpTransport(await servePendingResponse(), "test-capability", {
      requestTimeoutMs: 10,
    });

    const error = await transport
      .requestJson("GET", "/core/v1/health")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CoreTransportError);
    expect(error).toMatchObject({ kind: "timeout", phase: "response" });
    expect(isDefinitiveCoreGenerationLoss(error)).toBe(false);
  });

  test("sends execution metadata and propagates aborts to Core cancellation", async () => {
    const managed = await serveManagedRequest();
    const transport = new UdsHttpTransport(managed.socketPath, "test-capability");
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
    expect(headers["x-nodex-request-deadline-ms"]).toBe("12345");
    expect(await managed.cancelledRequestId).toBe(headers["x-nodex-request-id"]);
  });

  test("bounds caller-specific response and timeout budgets", () => {
    expect(
      () =>
        new UdsHttpTransport("/tmp/core.sock", "capability", {
          maximumJsonResponseBytes: CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes + 1,
        }),
    ).toThrow("Core JSON response limit must be a positive integer");
    expect(
      () =>
        new UdsHttpTransport("/tmp/core.sock", "capability", {
          requestTimeoutMs: 120_001,
        }),
    ).toThrow("Core request timeout must be a positive integer");
    expect(
      () =>
        new UdsHttpTransport("/tmp/core.sock", "capability", {
          maximumJsonResponseBytes: CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes,
          requestTimeoutMs: 60_000,
        }),
    ).not.toThrow();
  });

  test("reads an ordinary JSON response larger than the legacy 512 KiB limit", async () => {
    const value = "x".repeat(600 * 1024);
    const transport = new UdsHttpTransport(
      await serveResponse(JSON.stringify({ value })),
      "test-capability",
    );

    await expect(
      transport.requestJson<{ readonly value: string }>("GET", "/core/v1/health"),
    ).resolves.toEqual({ value });
  });

  test("rejects an oversized declared ordinary JSON response before reading it", async () => {
    const maximum = CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes;
    const transport = new UdsHttpTransport(
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
    const transport = new UdsHttpTransport(
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
      new UdsHttpTransport(await serveReplayBoundary(), "test-capability"),
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
      new UdsHttpTransport(await serveReplayBoundary(), "test-capability"),
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
      new UdsHttpTransport(
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
      new UdsHttpTransport(
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
      new UdsHttpTransport(await serveLargeCommittedEvent(), "test-capability"),
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
      new UdsHttpTransport(await serveCommittedEvent(event), "test-capability"),
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
      new UdsHttpTransport(await serveCommittedEvent(event), "test-capability"),
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
      new UdsHttpTransport(await serveCommittedEvent(event), "test-capability"),
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
      new UdsHttpTransport(await serveCommittedEvent(event), "test-capability"),
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
      new UdsHttpTransport(await serveSseFrames(frames), "test-capability"),
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
      new UdsHttpTransport(
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
      new UdsHttpTransport(await serveCommittedEvent(event), "test-capability"),
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

  test("aborts an event stream that has not received response headers", async () => {
    const transport = configureEventContract(
      new UdsHttpTransport(await servePendingResponse(), "test-capability"),
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
