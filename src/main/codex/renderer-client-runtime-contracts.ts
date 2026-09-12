import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";
import type { CodexRendererClientResponseMessage } from "../../shared/types";
import type { SafeSendWebContentsLike } from "../ipc-safe-send";
import type { BackendLogger } from "../logging/logger";

export const DEFAULT_RENDERER_CLIENT_REQUEST_TIMEOUT_MS = 5_000;
export const DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS = 256;
export const DEFAULT_RENDERER_CLIENT_MAX_PENDING_REQUESTS_PER_TARGET = 64;
export const RENDERER_CLIENT_REQUEST_CHANNEL = "codex:renderer-client:request";

export interface RendererClientWebContents extends SafeSendWebContentsLike {
  id: number;
  isLoading?: () => boolean;
  once?: (event: "destroyed", listener: () => void) => unknown;
  off?: (event: "destroyed", listener: () => void) => unknown;
}

export interface RendererClientRegistration {
  readonly clientId: string;
  readonly webContentsId: number;
  readonly release: Effect.Effect<void>;
}

export interface RendererClientRequestOptions {
  readonly timeoutMs?: number;
}

export interface RendererClientBroadcastOptions {
  readonly sourceClientId?: string | null;
  readonly includeSource?: boolean;
}

export interface RendererClientDisposedEvent {
  readonly kind: "disposed";
  readonly clientId: string;
  readonly webContentsId: number;
  readonly reason: string;
}

export interface RendererClientConnectedEvent {
  readonly kind: "connected";
  readonly clientId: string;
  readonly webContentsId: number;
}

export type RendererClientEvent = RendererClientConnectedEvent | RendererClientDisposedEvent;

export interface RendererClientDeliveryResult {
  readonly sentClientIds: readonly string[];
  readonly unavailableClientIds: readonly string[];
  readonly failedClientIds: readonly string[];
}

export interface RendererClientRuntimeOptions {
  readonly clientIdFactory?: () => string;
  readonly requestIdFactory?: () => string;
  readonly defaultRequestTimeoutMs?: number;
  readonly maxPendingRequests?: number;
  readonly maxPendingRequestsPerTarget?: number;
  readonly logger?: Pick<BackendLogger, "debug" | "warn">;
  readonly send?: (target: RendererClientWebContents, channel: string, payload: unknown) => boolean;
}

export const RendererClientFailureReason = Schema.Literals([
  "unavailable",
  "timeout",
  "pressure",
  "request-failed",
  "not-owner",
  "closing",
]);

export class RendererClientRuntimeError extends Schema.TaggedError<RendererClientRuntimeError>()(
  "RendererClientRuntimeError",
  {
    message: Schema.String,
    operation: Schema.String,
    reason: RendererClientFailureReason,
    clientId: Schema.optionalKey(Schema.String),
    requestId: Schema.optionalKey(Schema.String),
    method: Schema.optionalKey(Schema.String),
    timeoutMs: Schema.optionalKey(Schema.Number),
  },
) {}

/**
 * Main-owned renderer coordination. Electron registration and legacy Boolean
 * admission stay synchronous at their external seam; admitted delivery,
 * acknowledgments, requests, and release are fibers owned by the Main Scope.
 */
export interface RendererClientRuntimeService {
  readonly register: (webContents: RendererClientWebContents) => RendererClientRegistration;
  readonly ensureClient: (webContents: RendererClientWebContents) => RendererClientRegistration;
  readonly getClientIdForWebContentsId: (webContentsId: number) => string | null;
  readonly getWebContentsIdForClientId: (clientId: string) => number | null;
  readonly getClientCount: () => number;
  readonly getClientIds: () => readonly string[];
  readonly getPendingRequestCount: () => number;
  readonly sendToClient: (clientId: string, channel: string, payload: unknown) => boolean;
  readonly sendCriticalToClient: (clientId: string, channel: string, payload: unknown) => boolean;
  readonly sendToClients: (
    clientIds: readonly string[],
    channel: string,
    payload: unknown,
    options?: { readonly excludeClientId?: string | null },
  ) => RendererClientDeliveryResult;
  readonly broadcast: (
    channel: string,
    payload: unknown,
    options?: RendererClientBroadcastOptions,
  ) => number;
  readonly request: <A = unknown>(
    targetClientId: string,
    method: string,
    params: unknown,
    options?: RendererClientRequestOptions,
  ) => Effect.Effect<A, RendererClientRuntimeError>;
  readonly handleResponse: (
    webContents: RendererClientWebContents,
    response: CodexRendererClientResponseMessage,
  ) => Effect.Effect<boolean>;
  readonly handleDeliveryAcknowledgment: (
    webContents: RendererClientWebContents,
    transferId: string,
    sequence: number,
  ) => Effect.Effect<void>;
  readonly disposeClient: (clientId: string, reason?: string) => Effect.Effect<void>;
  readonly events: Stream.Stream<RendererClientEvent>;
}
