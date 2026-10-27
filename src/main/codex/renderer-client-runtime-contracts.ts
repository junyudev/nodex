import type { WebContentsDestructionSource } from "../platform/electron/WebContentsDestructionSubscriptions";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { SafeSendWebContentsLike } from "../ipc-safe-send";
import type { BackendLogger } from "../logging/logger";

export interface RendererClientWebContents
  extends SafeSendWebContentsLike, WebContentsDestructionSource {
  id: number;
  isLoading?: () => boolean;
}

export interface RendererClientRegistration {
  readonly clientId: string;
  readonly webContentsId: number;
  readonly release: Effect.Effect<void>;
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
  readonly logger?: Pick<BackendLogger, "debug" | "warn">;
  readonly send?: (target: RendererClientWebContents, channel: string, payload: unknown) => boolean;
}

/**
 * Main-owned renderer coordination. Electron registration and legacy Boolean
 * admission stay synchronous at their external seam; admitted delivery,
 * acknowledgments and release are fibers owned by the Main Scope.
 */
export interface RendererClientRuntimeService {
  readonly register: (webContents: RendererClientWebContents) => RendererClientRegistration;
  readonly ensureClient: (webContents: RendererClientWebContents) => RendererClientRegistration;
  readonly getClientIdForWebContentsId: (webContentsId: number) => string | null;
  readonly getWebContentsIdForClientId: (clientId: string) => number | null;
  readonly getClientCount: () => number;
  readonly getClientIds: () => readonly string[];
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
  readonly handleDeliveryAcknowledgment: (
    webContents: RendererClientWebContents,
    transferId: string,
    sequence: number,
  ) => Effect.Effect<void>;
  readonly disposeClient: (clientId: string, reason?: string) => Effect.Effect<void>;
  readonly events: Stream.Stream<RendererClientEvent>;
}
