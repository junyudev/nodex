import { request as httpRequest, type IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { CORE_TRANSPORT_BUDGETS } from "@nodex/core-protocol";

import { decodeBoundedJson, encodeBoundedJson } from "./codec";
import { SseParser } from "./sse-parser";
import {
  DOCUMENT_HTTP_CONTENT_TYPE,
  decodeDocumentRealtimeSseEvent,
} from "../../shared/block-documents/http-contract";
import type { DocumentSyncRealtimeEvent } from "../../shared/block-documents/document-sync";
import { parseAuthorizedDeliveryPacket } from "../../shared/authorized-delivery-packet";
import type { ProjectionScope } from "../../shared/projection-stream";
import type {
  CoreEventEnvelope,
  CoreEventReplayRequired,
  CoreEventSubscription,
  CoreDocumentEventSubscription,
  CoreProjectionEventSubscription,
  CoreStreamCheckpoint,
  CoreRequestClass,
  CoreRequestOptions,
  DocumentLiveBarrier,
  DocumentLiveRepair,
  ProjectionLiveBarrier,
  ProjectionLiveRepair,
} from "./types";

const MAX_JSON_REQUEST_BYTES = CORE_TRANSPORT_BUDGETS.ordinary_json_request_bytes;
const MAX_JSON_RESPONSE_BYTES = CORE_TRANSPORT_BUDGETS.ordinary_json_response_bytes;
const MAX_DOCUMENT_JSON_REQUEST_BYTES = CORE_TRANSPORT_BUDGETS.document_json_request_bytes;
const MAX_DOCUMENT_RESPONSE_BYTES = CORE_TRANSPORT_BUDGETS.document_response_bytes;
const MAX_EVENT_FRAME_BYTES = CORE_TRANSPORT_BUDGETS.event_frame_bytes;
const TRANSPORT_LIVENESS_TIMEOUT_MS = 5_000;
const MAX_CONFIGURED_REQUEST_TIMEOUT_MS = 120_000;
const DOCUMENT_ROUTE_PREFIX = "/core/v1/modules/document/";
const FILE_BLOB_ROUTE_PREFIX = "/core/v1/files/blobs/";
const MANAGED_BLOB_PREPARE_ROUTE = "/core/v1/blobs/prepare";
const THREAD_BLOB_ROUTE = /^\/core\/v1\/threads\/[^/]+\/blobs\/[^/]+$/u;
const MODULE_ROUTE_PREFIX = "/core/v1/modules/";
const LOCAL_MUTATION_ROUTE = "/core/v1/local-mutations/resolve";
const DEFAULT_REQUEST_DEADLINES_MS: Readonly<Record<CoreRequestClass, number>> = {
  interactive: CORE_TRANSPORT_BUDGETS.interactive_request_deadline_ms,
  background: CORE_TRANSPORT_BUDGETS.background_request_deadline_ms,
  maintenance: CORE_TRANSPORT_BUDGETS.maintenance_request_deadline_ms,
};

export interface UdsHttpTransportOptions {
  readonly maximumJsonResponseBytes?: number;
  readonly requestTimeoutMs?: number;
}

interface RequestExecutionHeaders {
  readonly requestId: string;
  readonly class: CoreRequestClass;
  readonly deadlineMs: number;
}

const requestExecution = (
  requestPath: string,
  options: CoreRequestOptions,
): RequestExecutionHeaders | null => {
  const route = requestPath.split("?", 1)[0]!;
  if (
    !requestPath.startsWith(MODULE_ROUTE_PREFIX) &&
    !requestPath.startsWith(FILE_BLOB_ROUTE_PREFIX) &&
    route !== MANAGED_BLOB_PREPARE_ROUTE &&
    !THREAD_BLOB_ROUTE.test(route) &&
    requestPath !== LOCAL_MUTATION_ROUTE
  ) {
    return null;
  }
  const requestClass = options.class ?? "interactive";
  const deadlineMs = boundedPositiveInteger(
    options.deadlineMs ?? DEFAULT_REQUEST_DEADLINES_MS[requestClass],
    CORE_TRANSPORT_BUDGETS.request_deadline_max_ms,
    "Core request deadline",
  );
  if (deadlineMs < CORE_TRANSPORT_BUDGETS.request_deadline_min_ms) {
    throw new Error(
      `Core request deadline must be at least ${CORE_TRANSPORT_BUDGETS.request_deadline_min_ms}`,
    );
  }
  return {
    requestId: randomUUID(),
    class: requestClass,
    deadlineMs,
  };
};

export type DocumentFrameResponse<Response> =
  | { readonly kind: "binary"; readonly bytes: Uint8Array }
  | { readonly kind: "json"; readonly value: Response };

export interface BoundedBytesResponse {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly etag: string | undefined;
}

export class CoreHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CoreHttpError";
  }
}

export class CoreResponseTooLargeError extends Error {
  constructor(
    readonly maximumBytes: number,
    readonly observedAtLeastBytes: number,
  ) {
    super(`Core response exceeds ${maximumBytes} bytes`);
    this.name = "CoreResponseTooLargeError";
  }
}

export class CoreEventReplayError extends Error {
  constructor(readonly boundary: CoreEventReplayRequired) {
    super("Core event replay requires fresh reads");
    this.name = "CoreEventReplayError";
  }
}

export class CoreEventCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoreEventCompatibilityError";
  }
}

export type CoreTransportErrorKind =
  | "aborted"
  | "connection_lost"
  | "timeout"
  | "unreachable"
  | "unknown";

export type CoreTransportPhase = "connect" | "open" | "response";

export class CoreTransportError extends Error {
  constructor(
    readonly kind: CoreTransportErrorKind,
    readonly phase: CoreTransportPhase,
    readonly code: string | null,
    cause: unknown,
  ) {
    super(coreTransportMessage(kind, code), { cause });
    this.name = "CoreTransportError";
  }
}

export const isDefinitiveCoreGenerationLoss = (error: unknown): boolean =>
  error instanceof CoreTransportError &&
  (error.kind === "connection_lost" || error.kind === "unreachable");

const coreTransportMessage = (kind: CoreTransportErrorKind, code: string | null): string => {
  const suffix = code ? ` (${code})` : "";
  switch (kind) {
    case "aborted":
      return `Core request was aborted${suffix}`;
    case "connection_lost":
      return `Core connection was lost${suffix}`;
    case "timeout":
      return `Core request timed out${suffix}`;
    case "unreachable":
      return `Core is unreachable${suffix}`;
    case "unknown":
      return `Core transport failed${suffix}`;
  }
};

const transportCode = (error: unknown): string | null => {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
};

const normalizeTransportError = (error: unknown, phase: CoreTransportPhase): unknown => {
  if (
    error instanceof CoreTransportError ||
    error instanceof CoreHttpError ||
    error instanceof CoreResponseTooLargeError ||
    error instanceof CoreEventCompatibilityError ||
    error instanceof CoreEventReplayError
  ) {
    return error;
  }
  const code = transportCode(error);
  if (code === "ABORT_ERR" || (error instanceof Error && error.name === "AbortError")) {
    return new CoreTransportError("aborted", phase, code, error);
  }
  if (code === "ENOENT" || code === "ECONNREFUSED") {
    return new CoreTransportError("unreachable", phase, code, error);
  }
  if (code === "ECONNRESET" || code === "EPIPE") {
    return new CoreTransportError("connection_lost", phase, code, error);
  }
  if (code === "ETIMEDOUT") {
    return new CoreTransportError("timeout", phase, code, error);
  }
  return new CoreTransportError("unknown", phase, code, error);
};

interface CoreEventContract {
  readonly transportVersion: number;
  readonly eventVersion: number;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly coreGeneration: string;
}

interface DocumentLiveStreamOptions {
  readonly path: string;
  readonly onRepair: (repair: DocumentLiveRepair) => void;
}

interface ProjectionLiveStreamOptions {
  readonly path: string;
  readonly scopes: readonly ProjectionScope[];
  readonly onRepair: (repair: ProjectionLiveRepair) => void;
}

export class UdsHttpTransport {
  readonly #maximumJsonResponseBytes: number;
  readonly #transportLivenessTimeoutMs: number;
  #eventContract: CoreEventContract | null = null;

  constructor(
    readonly socketPath: string,
    readonly authCapability: string,
    options: UdsHttpTransportOptions = {},
  ) {
    this.#maximumJsonResponseBytes = boundedPositiveInteger(
      options.maximumJsonResponseBytes ?? MAX_JSON_RESPONSE_BYTES,
      MAX_JSON_RESPONSE_BYTES,
      "Core JSON response limit",
    );
    this.#transportLivenessTimeoutMs = boundedPositiveInteger(
      options.requestTimeoutMs ?? TRANSPORT_LIVENESS_TIMEOUT_MS,
      MAX_CONFIGURED_REQUEST_TIMEOUT_MS,
      "Core request timeout",
    );
  }

  configureEventContract(contract: CoreEventContract): void {
    if (
      !Number.isSafeInteger(contract.transportVersion) ||
      !Number.isSafeInteger(contract.eventVersion) ||
      !contract.libraryId ||
      !contract.storeEpoch ||
      !contract.coreGeneration
    ) {
      throw new CoreEventCompatibilityError("Core event contract is invalid");
    }
    if (this.#eventContract !== null) {
      throw new CoreEventCompatibilityError("Core event contract is already configured");
    }
    this.#eventContract = contract;
  }

  requestJson<Response>(
    method: "GET" | "POST",
    requestPath: string,
    body?: unknown,
    requestHeaders: Readonly<Record<string, string>> = {},
    options: CoreRequestOptions = {},
  ): Promise<Response> {
    const documentRoute = requestPath.startsWith(DOCUMENT_ROUTE_PREFIX);
    const maximumRequestBytes = documentRoute
      ? MAX_DOCUMENT_JSON_REQUEST_BYTES
      : MAX_JSON_REQUEST_BYTES;
    const maximumResponseBytes = documentRoute
      ? MAX_DOCUMENT_RESPONSE_BYTES
      : this.#maximumJsonResponseBytes;
    const encodedBody =
      body === undefined ? undefined : encodeBoundedJson(body, maximumRequestBytes, "Core request");
    const execution = requestExecution(requestPath, options);
    const transportTimeoutMs = execution
      ? execution.deadlineMs + this.#transportLivenessTimeoutMs
      : this.#transportLivenessTimeoutMs;

    return new Promise<Response>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", cancelCoreRequest);
        action();
      };
      const cancelCoreRequest = (): void => {
        if (!execution) return;
        void this.#cancelRequest(execution.requestId, requestHeaders);
      };
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          path: requestPath,
          method,
          agent: false,
          signal: options.signal,
          headers: {
            ...requestHeaders,
            ...(execution
              ? {
                  "x-nodex-request-id": execution.requestId,
                  "x-nodex-request-class": execution.class,
                  "x-nodex-request-deadline-ms": String(execution.deadlineMs),
                }
              : {}),
            accept: "application/json",
            authorization: `Bearer ${this.authCapability}`,
            ...(encodedBody
              ? {
                  "content-length": encodedBody.byteLength,
                  "content-type": "application/json",
                }
              : {}),
          },
        },
        (response) => {
          collectResponse(response, maximumResponseBytes)
            .then((bytes) => {
              const value = decodeBoundedJson<Response>(
                bytes,
                maximumResponseBytes,
                "Core response",
              );
              const status = response.statusCode ?? 0;
              if (status >= 200 && status < 300) {
                settle(() => resolve(value));
                return;
              }
              settle(() => reject(new CoreHttpError(status, errorMessage(value))));
            })
            .catch((error: unknown) =>
              settle(() => reject(normalizeTransportError(error, "response"))),
            );
        },
      );
      if (options.signal?.aborted) {
        cancelCoreRequest();
      } else {
        options.signal?.addEventListener("abort", cancelCoreRequest, { once: true });
      }
      request.setTimeout(transportTimeoutMs, () => {
        cancelCoreRequest();
        request.destroy(new CoreTransportError("timeout", "response", "ETIMEDOUT", null));
      });
      request.on("error", (error) =>
        settle(() => reject(normalizeTransportError(error, "connect"))),
      );
      if (encodedBody) request.write(encodedBody);
      request.end();
    });
  }

  requestDocumentFrame<Response>(
    requestPath: string,
    body: Uint8Array,
    requestHeaders: Readonly<Record<string, string>>,
    maximumResponseBytes: number,
    options: CoreRequestOptions = {},
  ): Promise<DocumentFrameResponse<Response>> {
    const execution = requestExecution(requestPath, options);
    if (!execution) {
      return Promise.reject(new Error("Document requests require Core execution metadata"));
    }
    const transportTimeoutMs = execution.deadlineMs + this.#transportLivenessTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", cancelCoreRequest);
        action();
      };
      const cancelCoreRequest = (): void => {
        if (!execution) return;
        void this.#cancelRequest(execution.requestId, requestHeaders);
      };
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          path: requestPath,
          method: "POST",
          agent: false,
          signal: options.signal,
          headers: {
            ...requestHeaders,
            "x-nodex-request-id": execution.requestId,
            "x-nodex-request-class": execution.class,
            "x-nodex-request-deadline-ms": String(execution.deadlineMs),
            accept: `${DOCUMENT_HTTP_CONTENT_TYPE}, application/json`,
            authorization: `Bearer ${this.authCapability}`,
            "content-length": body.byteLength,
            "content-type": DOCUMENT_HTTP_CONTENT_TYPE,
          },
        },
        (response) => {
          collectResponse(response, maximumResponseBytes)
            .then((bytes) => {
              const status = response.statusCode ?? 0;
              if (status < 200 || status >= 300) {
                const value = decodeBoundedJson<unknown>(
                  bytes,
                  maximumResponseBytes,
                  "Core Document error response",
                );
                settle(() => reject(new CoreHttpError(status, errorMessage(value))));
                return;
              }
              const contentType = response.headers["content-type"]?.split(";", 1)[0];
              if (contentType === DOCUMENT_HTTP_CONTENT_TYPE) {
                settle(() => resolve({ kind: "binary", bytes }));
                return;
              }
              if (contentType !== "application/json") {
                settle(() =>
                  reject(new Error("Core Document response has an invalid Content-Type")),
                );
                return;
              }
              const value = decodeBoundedJson<Response>(
                bytes,
                maximumResponseBytes,
                "Core Document response",
              );
              settle(() => resolve({ kind: "json", value }));
            })
            .catch((error: unknown) =>
              settle(() => reject(normalizeTransportError(error, "response"))),
            );
        },
      );
      if (options.signal?.aborted) {
        cancelCoreRequest();
      } else {
        options.signal?.addEventListener("abort", cancelCoreRequest, { once: true });
      }
      request.setTimeout(transportTimeoutMs, () => {
        cancelCoreRequest();
        request.destroy(new CoreTransportError("timeout", "response", "ETIMEDOUT", null));
      });
      request.on("error", (error) =>
        settle(() => reject(normalizeTransportError(error, "connect"))),
      );
      request.write(body);
      request.end();
    });
  }

  requestBoundedBytes(
    method: "GET" | "POST",
    requestPath: string,
    body: Uint8Array | undefined,
    requestHeaders: Readonly<Record<string, string>>,
    maximumResponseBytes: number,
    options: CoreRequestOptions = {},
  ): Promise<BoundedBytesResponse> {
    const execution = requestExecution(requestPath, options);
    if (!execution) {
      return Promise.reject(new Error("Blob requests require Core execution metadata"));
    }
    const transportTimeoutMs = execution.deadlineMs + this.#transportLivenessTimeoutMs;
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", cancelCoreRequest);
        action();
      };
      const cancelCoreRequest = (): void => {
        void this.#cancelRequest(execution.requestId, requestHeaders);
      };
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          path: requestPath,
          method,
          agent: false,
          signal: options.signal,
          headers: {
            ...requestHeaders,
            "x-nodex-request-id": execution.requestId,
            "x-nodex-request-class": execution.class,
            "x-nodex-request-deadline-ms": String(execution.deadlineMs),
            accept: "application/octet-stream, application/json",
            authorization: `Bearer ${this.authCapability}`,
            ...(body
              ? {
                  "content-length": body.byteLength,
                  "content-type": "application/octet-stream",
                }
              : {}),
          },
        },
        (response) => {
          collectResponse(response, maximumResponseBytes)
            .then((bytes) => {
              const status = response.statusCode ?? 0;
              if (status < 200 || status >= 300) {
                const value = decodeBoundedJson<unknown>(
                  bytes,
                  Math.min(maximumResponseBytes, MAX_JSON_RESPONSE_BYTES),
                  "Core File Blob error response",
                );
                settle(() => reject(new CoreHttpError(status, errorMessage(value))));
                return;
              }
              settle(() =>
                resolve({
                  bytes,
                  contentType: response.headers["content-type"]?.split(";", 1)[0],
                  etag: response.headers.etag,
                }),
              );
            })
            .catch((error: unknown) =>
              settle(() => reject(normalizeTransportError(error, "response"))),
            );
        },
      );
      if (options.signal?.aborted) {
        cancelCoreRequest();
      } else {
        options.signal?.addEventListener("abort", cancelCoreRequest, { once: true });
      }
      request.setTimeout(transportTimeoutMs, () => {
        cancelCoreRequest();
        request.destroy(new CoreTransportError("timeout", "response", "ETIMEDOUT", null));
      });
      request.on("error", (error) =>
        settle(() => reject(normalizeTransportError(error, "connect"))),
      );
      if (body) request.write(body);
      request.end();
    });
  }

  #cancelRequest(
    requestId: string,
    requestHeaders: Readonly<Record<string, string>>,
  ): Promise<unknown> {
    return this.requestJson(
      "POST",
      "/core/v1/requests/cancel",
      { request_id: requestId },
      requestHeaders,
    ).catch(() => undefined);
  }

  openEventStream(
    after: number,
    onEvent: (event: CoreEventEnvelope) => void,
    requestHeaders: Readonly<Record<string, string>> = {},
    onDocumentRealtime?: (event: DocumentSyncRealtimeEvent) => void,
    onCoreResyncRequired?: (event: CoreEventReplayRequired) => void,
    onCheckpoint?: (checkpoint: CoreStreamCheckpoint) => void,
    signal?: AbortSignal,
    documentLive?: DocumentLiveStreamOptions,
    projectionLive?: ProjectionLiveStreamOptions,
  ): Promise<CoreEventSubscription> {
    if (!Number.isSafeInteger(after) || after < 0) {
      return Promise.reject(new Error("Event sequence must be a non-negative integer"));
    }
    if (this.#eventContract === null) {
      return Promise.reject(
        new CoreEventCompatibilityError("Core event stream opened before handshake"),
      );
    }
    const eventContract = this.#eventContract;

    return new Promise<CoreEventSubscription>((resolve, reject) => {
      let opened = false;
      let closed = false;
      let documentBarrier: DocumentLiveBarrier | null = null;
      let projectionBarrier: ProjectionLiveBarrier | null = null;
      let resolveDone: (() => void) | undefined;
      let rejectDone: ((error: unknown) => void) | undefined;
      const done = new Promise<void>((doneResolve, doneReject) => {
        resolveDone = doneResolve;
        rejectDone = doneReject;
      });
      const request = httpRequest(
        {
          socketPath: this.socketPath,
          path: documentLive?.path ?? projectionLive?.path ?? `/core/v1/events?after=${after}`,
          method: "GET",
          agent: false,
          signal,
          headers: {
            ...requestHeaders,
            accept: "text/event-stream",
            authorization: `Bearer ${this.authCapability}`,
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            collectResponse(response, this.#maximumJsonResponseBytes)
              .then((bytes) => {
                const value = decodeBoundedJson<unknown>(
                  bytes,
                  this.#maximumJsonResponseBytes,
                  "Core event error response",
                );
                reject(new CoreHttpError(status, errorMessage(value)));
              })
              .catch((error: unknown) => reject(normalizeTransportError(error, "response")));
            return;
          }

          const parser = new SseParser(MAX_EVENT_FRAME_BYTES);
          const openSubscription = (): void => {
            if (opened || closed) return;
            if (documentLive && !documentBarrier) return;
            if (projectionLive && !projectionBarrier) return;
            opened = true;
            request.setTimeout(0);
            resolve({
              done,
              ...(documentBarrier
                ? { barrier: documentBarrier }
                : projectionBarrier
                  ? { barrier: projectionBarrier }
                  : {}),
              close: () => {
                if (closed) return;
                closed = true;
                response.destroy();
                request.destroy();
                resolveDone?.();
              },
            });
          };
          const fail = (error: unknown): void => {
            if (closed) return;
            closed = true;
            response.destroy();
            const normalized = normalizeTransportError(error, "response");
            if (opened) {
              rejectDone?.(normalized);
              return;
            }
            reject(normalized);
          };
          const processFrame = (frame: { readonly event: string; readonly data: string }): void => {
            if (frame.event === "document-live-opened") {
              if (!documentLive || documentBarrier) {
                throw new CoreEventCompatibilityError(
                  "Core emitted an unexpected Document live barrier",
                );
              }
              documentBarrier = parseDocumentLiveBarrier(frame.data, eventContract);
              openSubscription();
              return;
            }
            if (frame.event === "projection-live-opened") {
              if (!projectionLive || projectionBarrier) {
                throw new CoreEventCompatibilityError(
                  "Core emitted an unexpected Projection live barrier",
                );
              }
              projectionBarrier = parseProjectionLiveBarrier(
                frame.data,
                eventContract,
                projectionLive.scopes,
              );
              openSubscription();
              return;
            }
            if ((documentLive && !documentBarrier) || (projectionLive && !projectionBarrier)) {
              throw new CoreEventCompatibilityError(
                "Core live stream emitted data before its barrier",
              );
            }
            if (frame.event === "document-live-repair") {
              if (!documentLive) {
                throw new CoreEventCompatibilityError(
                  "Core emitted a Document repair on the global stream",
                );
              }
              documentLive.onRepair(parseDocumentLiveRepair(frame.data, eventContract));
              return;
            }
            if (frame.event === "projection-live-repair") {
              if (!projectionLive) {
                throw new CoreEventCompatibilityError(
                  "Core emitted a Projection repair on another stream",
                );
              }
              projectionLive.onRepair(parseProjectionLiveRepair(frame.data, eventContract));
              return;
            }
            if (frame.event === "module") {
              onEvent(parseEventEnvelope(frame.data, eventContract));
              return;
            }
            if (frame.event === "document-realtime") {
              onDocumentRealtime?.(decodeDocumentRealtimeSseEvent(frame.data));
              return;
            }
            if (frame.event === "stream-checkpoint") {
              onCheckpoint?.(parseStreamCheckpoint(frame.data, eventContract));
              return;
            }
            if (frame.event !== "core-resync-required") return;

            const boundary = parseCoreResync(frame.data);
            if (onCoreResyncRequired) {
              onCoreResyncRequired(boundary);
              return;
            }
            throw new CoreEventReplayError(boundary);
          };
          response.on("data", (chunk: Buffer) => {
            try {
              for (const frame of parser.push(chunk)) processFrame(frame);
            } catch (error) {
              fail(error);
            }
          });
          response.on("end", () => {
            try {
              for (const frame of parser.finish()) processFrame(frame);
              if (documentLive && !documentBarrier) {
                fail(
                  new CoreEventCompatibilityError(
                    "Core Document live stream ended before its barrier",
                  ),
                );
                return;
              }
              if (projectionLive && !projectionBarrier) {
                fail(
                  new CoreEventCompatibilityError(
                    "Core Projection live stream ended before its barrier",
                  ),
                );
                return;
              }
              if (!closed) resolveDone?.();
              closed = true;
            } catch (error) {
              fail(error);
            }
          });
          response.on("aborted", () => {
            fail(new Error("Core event stream ended before completion"));
          });
          response.on("error", fail);
          openSubscription();
        },
      );
      request.on("error", (error) => {
        if (!opened) {
          reject(normalizeTransportError(error, "open"));
          return;
        }
        if (!closed) rejectDone?.(normalizeTransportError(error, "response"));
      });
      request.setTimeout(this.#transportLivenessTimeoutMs, () => {
        request.destroy(new CoreTransportError("timeout", "open", "ETIMEDOUT", null));
      });
      request.end();
    });
  }

  openDocumentLiveStream(
    requestHeaders: Readonly<Record<string, string>>,
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: DocumentLiveRepair) => void,
    onDocumentRealtime: (event: DocumentSyncRealtimeEvent) => void,
    signal?: AbortSignal,
  ): Promise<CoreDocumentEventSubscription> {
    return this.openEventStream(
      0,
      onEvent,
      requestHeaders,
      onDocumentRealtime,
      undefined,
      undefined,
      signal,
      {
        path: "/core/v1/modules/document/live",
        onRepair,
      },
    ) as Promise<CoreDocumentEventSubscription>;
  }

  openProjectionLiveStream(
    scopes: readonly ProjectionScope[],
    requestHeaders: Readonly<Record<string, string>>,
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: ProjectionLiveRepair) => void,
    signal?: AbortSignal,
  ): Promise<CoreProjectionEventSubscription> {
    const requested = scopes.map((scope) =>
      scope.kind === "library"
        ? { kind: "library" as const }
        : { kind: "project" as const, project_id: scope.projectId },
    );
    const path = `/core/v1/projections/live?scopes=${encodeURIComponent(JSON.stringify(requested))}`;
    return this.openEventStream(
      0,
      onEvent,
      requestHeaders,
      undefined,
      undefined,
      undefined,
      signal,
      undefined,
      { path, scopes, onRepair },
    ) as Promise<CoreProjectionEventSubscription>;
  }
}

const boundedPositiveInteger = (value: number, maximum: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error(`${label} must be a positive integer no greater than ${maximum}`);
  }
  return value;
};

const collectResponse = (response: IncomingMessage, maximumBytes: number): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const declaredLength = parseContentLength(response);
    if (declaredLength !== undefined && declaredLength > maximumBytes) {
      reject(new CoreResponseTooLargeError(maximumBytes, declaredLength));
      response.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let byteLength = 0;
    let settled = false;
    response.on("data", (chunk: Buffer) => {
      if (settled) return;
      byteLength += chunk.byteLength;
      if (byteLength <= maximumBytes) {
        chunks.push(chunk);
        return;
      }
      settled = true;
      reject(new CoreResponseTooLargeError(maximumBytes, byteLength));
      response.destroy();
    });
    response.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, byteLength));
    });
    response.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });

const parseContentLength = (response: IncomingMessage): number | undefined => {
  const raw = response.headers["content-length"];
  if (typeof raw !== "string" || !/^\d+$/.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
};

const errorMessage = (value: unknown): string => {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return "Core request failed";
};

const parseEventEnvelope = (json: string, contract: CoreEventContract): CoreEventEnvelope => {
  const value = decodeBoundedJson<unknown>(
    Buffer.from(json, "utf8"),
    MAX_EVENT_FRAME_BYTES,
    "Core event",
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value, ["packet", "transport_version"]) ||
    !("transport_version" in value) ||
    value.transport_version !== contract.transportVersion ||
    !("packet" in value)
  ) {
    throw new CoreEventCompatibilityError("Core event transport version is invalid");
  }
  assertAuthorizedDeliveryPacket(value.packet, contract);
  return value as CoreEventEnvelope;
};

const assertAuthorizedDeliveryPacket = (packet: unknown, contract: CoreEventContract): void => {
  try {
    parseAuthorizedDeliveryPacket(packet, {
      eventVersion: contract.eventVersion,
      libraryId: contract.libraryId,
      storeEpoch: contract.storeEpoch,
    });
  } catch {
    throw new CoreEventCompatibilityError("Authorized delivery packet is invalid");
  }
};

const parseStreamCheckpoint = (json: string, contract: CoreEventContract): CoreStreamCheckpoint => {
  const value = decodeBoundedJson<unknown>(
    Buffer.from(json, "utf8"),
    MAX_EVENT_FRAME_BYTES,
    "Core stream checkpoint",
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value, [
      "generation",
      "oldest_available_seq",
      "resync_token",
      "scanned_through_seq",
      "store_epoch",
    ]) ||
    !("store_epoch" in value) ||
    value.store_epoch !== contract.storeEpoch ||
    !("generation" in value) ||
    !isIdentity(value.generation) ||
    !("scanned_through_seq" in value) ||
    !isNonNegativeSafeInteger(value.scanned_through_seq) ||
    !("oldest_available_seq" in value) ||
    !isNonNegativeSafeInteger(value.oldest_available_seq) ||
    value.oldest_available_seq > value.scanned_through_seq ||
    !("resync_token" in value) ||
    (value.resync_token !== null && !isIdentity(value.resync_token))
  ) {
    throw new CoreEventCompatibilityError("Core stream checkpoint is invalid");
  }
  return value as CoreStreamCheckpoint;
};

const hasExactKeys = (value: Readonly<object>, expected: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length) return false;
  const canonicalExpected = [...expected].sort();
  return actual.every((key, index) => key === canonicalExpected[index]);
};

const isIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim();

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isDeliveryAuthorizationScope = (value: unknown, expectedLibraryId: string): boolean => {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  if (value.kind === "library") {
    return (
      hasExactKeys(value, ["kind", "library_id"]) &&
      "library_id" in value &&
      value.library_id === expectedLibraryId
    );
  }
  if (value.kind === "project") {
    return (
      hasExactKeys(value, ["kind", "library_id", "project_id"]) &&
      "library_id" in value &&
      value.library_id === expectedLibraryId &&
      "project_id" in value &&
      isIdentity(value.project_id)
    );
  }
  if (value.kind === "document") {
    return (
      hasExactKeys(value, ["document_id", "kind", "library_id", "project_id"]) &&
      "library_id" in value &&
      value.library_id === expectedLibraryId &&
      "document_id" in value &&
      isIdentity(value.document_id) &&
      "project_id" in value &&
      (value.project_id === null || isIdentity(value.project_id))
    );
  }
  return false;
};

const parseProjectionLiveBarrier = (
  json: string,
  contract: CoreEventContract,
  requestedScopes: readonly ProjectionScope[],
): ProjectionLiveBarrier => {
  const value = decodeBoundedJson<unknown>(
    Buffer.from(json, "utf8"),
    MAX_EVENT_FRAME_BYTES,
    "Core Projection live barrier",
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value, ["commit_head", "core_generation", "recipient_leases", "store_epoch"]) ||
    !("store_epoch" in value) ||
    value.store_epoch !== contract.storeEpoch ||
    !("core_generation" in value) ||
    value.core_generation !== contract.coreGeneration ||
    !("commit_head" in value) ||
    !isNonNegativeSafeInteger(value.commit_head) ||
    !("recipient_leases" in value) ||
    !Array.isArray(value.recipient_leases) ||
    value.recipient_leases.length < 1 ||
    value.recipient_leases.length > 200 ||
    !value.recipient_leases.every(
      (lease) =>
        typeof lease === "object" &&
        lease !== null &&
        hasExactKeys(lease, ["authorization_scope", "delivery_address", "lease_id"]) &&
        "lease_id" in lease &&
        typeof lease.lease_id === "string" &&
        /^[a-f0-9]{64}$/u.test(lease.lease_id) &&
        "authorization_scope" in lease &&
        isDeliveryAuthorizationScope(lease.authorization_scope, contract.libraryId) &&
        lease.authorization_scope.kind !== "document" &&
        "delivery_address" in lease &&
        isDeliveryAuthorizationScope(lease.delivery_address, contract.libraryId) &&
        JSON.stringify(lease.delivery_address) === JSON.stringify(lease.authorization_scope),
    ) ||
    new Set(value.recipient_leases.map((lease) => JSON.stringify(lease.delivery_address))).size !==
      value.recipient_leases.length
  ) {
    throw new CoreEventCompatibilityError("Core Projection live barrier is invalid");
  }
  const deliveredScopeKeys = value.recipient_leases
    .map((lease) =>
      lease.delivery_address.kind === "library"
        ? "library"
        : `project:${lease.delivery_address.project_id}`,
    )
    .sort();
  const requestedScopeKeys = requestedScopes
    .map((scope) => (scope.kind === "library" ? "library" : `project:${scope.projectId}`))
    .sort();
  if (
    deliveredScopeKeys.length !== requestedScopeKeys.length ||
    deliveredScopeKeys.some((key, index) => key !== requestedScopeKeys[index])
  ) {
    throw new CoreEventCompatibilityError(
      "Core Projection live barrier diverges from its requested scopes",
    );
  }
  return value as ProjectionLiveBarrier;
};

const parseProjectionLiveRepair = (
  json: string,
  contract: CoreEventContract,
): ProjectionLiveRepair => {
  const value = decodeBoundedJson<unknown>(
    Buffer.from(json, "utf8"),
    MAX_EVENT_FRAME_BYTES,
    "Core Projection live repair",
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value, ["commit_head", "reason", "store_epoch"]) ||
    !("store_epoch" in value) ||
    !isIdentity(value.store_epoch) ||
    !("commit_head" in value) ||
    !isNonNegativeSafeInteger(value.commit_head) ||
    !("reason" in value) ||
    !["receiver_lagged", "payload_unavailable", "identity_changed"].includes(
      String(value.reason),
    ) ||
    (value.reason !== "identity_changed" && value.store_epoch !== contract.storeEpoch)
  ) {
    throw new CoreEventCompatibilityError("Core Projection live repair is invalid");
  }
  return value as ProjectionLiveRepair;
};

const parseDocumentLiveBarrier = (
  json: string,
  contract: CoreEventContract,
): DocumentLiveBarrier => {
  const value = decodeBoundedJson<unknown>(
    Buffer.from(json, "utf8"),
    MAX_EVENT_FRAME_BYTES,
    "Core Document live barrier",
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value, [
      "commit_head",
      "core_generation",
      "document_generation",
      "document_id",
      "engine",
      "head_seq",
      "store_epoch",
    ]) ||
    !("store_epoch" in value) ||
    !isIdentity(value.store_epoch) ||
    !("core_generation" in value) ||
    !isIdentity(value.core_generation) ||
    !("document_id" in value) ||
    !isIdentity(value.document_id) ||
    !("document_generation" in value) ||
    !isNonNegativeSafeInteger(value.document_generation) ||
    Number(value.document_generation) < 1 ||
    !("head_seq" in value) ||
    !isNonNegativeSafeInteger(value.head_seq) ||
    !("commit_head" in value) ||
    !isNonNegativeSafeInteger(value.commit_head) ||
    !("engine" in value) ||
    (value.engine !== "yjs" && value.engine !== "canvas_scene")
  ) {
    throw new CoreEventCompatibilityError("Core Document live barrier is invalid");
  }
  if (
    value.store_epoch !== contract.storeEpoch ||
    value.core_generation !== contract.coreGeneration
  ) {
    throw new CoreEventCompatibilityError(
      "Core Document live barrier crossed the connected identity",
    );
  }
  return value as DocumentLiveBarrier;
};

const parseDocumentLiveRepair = (json: string, contract: CoreEventContract): DocumentLiveRepair => {
  const value = decodeBoundedJson<unknown>(
    Buffer.from(json, "utf8"),
    MAX_EVENT_FRAME_BYTES,
    "Core Document live repair",
  );
  const reasons = new Set<DocumentLiveRepair["reason"]>([
    "receiver_lagged",
    "payload_unavailable",
    "identity_changed",
    "access_revoked",
    "event_gap",
  ]);
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value, [
      "commit_head",
      "document_generation",
      "document_id",
      "head_seq",
      "reason",
      "store_epoch",
    ]) ||
    !("store_epoch" in value) ||
    !isIdentity(value.store_epoch) ||
    !("document_id" in value) ||
    !isIdentity(value.document_id) ||
    !("document_generation" in value) ||
    !isNonNegativeSafeInteger(value.document_generation) ||
    Number(value.document_generation) < 1 ||
    !("head_seq" in value) ||
    !isNonNegativeSafeInteger(value.head_seq) ||
    !("commit_head" in value) ||
    !isNonNegativeSafeInteger(value.commit_head) ||
    !("reason" in value) ||
    typeof value.reason !== "string" ||
    !reasons.has(value.reason as DocumentLiveRepair["reason"])
  ) {
    throw new CoreEventCompatibilityError("Core Document live repair is invalid");
  }
  if (value.store_epoch !== contract.storeEpoch && value.reason !== "identity_changed") {
    throw new CoreEventCompatibilityError(
      "Core Document live repair crossed the connected Store epoch",
    );
  }
  return value as DocumentLiveRepair;
};

const parseCoreResync = (json: string): CoreEventReplayRequired => {
  const value = decodeBoundedJson<unknown>(
    Buffer.from(json, "utf8"),
    MAX_EVENT_FRAME_BYTES,
    "Core resync event",
  );
  if (
    typeof value !== "object" ||
    value === null ||
    !hasExactKeys(value, [
      "commit_head",
      "generation",
      "oldest_available",
      "requested_after",
      "resync_token",
    ]) ||
    !("requested_after" in value) ||
    !isNonNegativeSafeInteger(value.requested_after) ||
    !("oldest_available" in value) ||
    !isNonNegativeSafeInteger(value.oldest_available) ||
    !("commit_head" in value) ||
    !isNonNegativeSafeInteger(value.commit_head) ||
    !("generation" in value) ||
    !isIdentity(value.generation) ||
    !("resync_token" in value) ||
    !isIdentity(value.resync_token)
  ) {
    throw new Error("Core resync event is invalid");
  }
  return value as CoreEventReplayRequired;
};
