import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { CodexHostMessage, CodexThreadFollowerActionInput } from "../../shared/types";
import {
  type RendererClientDeliveryResult,
  type RendererClientBroadcastOptions,
  type RendererClientRequestOptions,
  type RendererClientRuntimeError,
} from "./renderer-client-runtime-contracts";

export interface CodexOwnerFollowerRendererClientRuntime {
  broadcast(
    channel: string,
    args: readonly unknown[],
    options?: RendererClientBroadcastOptions,
  ): number;
  requireThreadOwner(
    targetClientId: string,
    conversationId: string,
    options?: RendererClientRequestOptions,
  ): Effect.Effect<void, RendererClientRuntimeError>;
  request<TResult = unknown>(
    targetClientId: string,
    method: string,
    params: unknown,
    options?: RendererClientRequestOptions,
  ): Effect.Effect<TResult, RendererClientRuntimeError>;
  sendToClient(clientId: string, channel: string, args: readonly unknown[]): boolean;
  sendToClients(
    clientIds: readonly string[],
    channel: string,
    args: readonly unknown[],
    options?: { excludeClientId?: string | null },
  ): RendererClientDeliveryResult;
}

export class CodexOwnerFollowerError extends Schema.TaggedError<CodexOwnerFollowerError>()(
  "CodexOwnerFollowerError",
  {
    message: Schema.String,
    operation: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

const ownerFollowerError = (
  operation: string,
  message: string,
  cause?: unknown,
): CodexOwnerFollowerError =>
  new CodexOwnerFollowerError({
    operation,
    message,
    ...(cause === undefined ? {} : { cause }),
  });

export interface CodexRendererOwnerHostMessage {
  targetClientId: string;
  message: unknown;
}

export function isRendererOwnerUnavailableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("no-client-found") ||
    message.includes("No renderer owner") ||
    message.includes(" is unavailable") ||
    message.includes(" was destroyed") ||
    message.includes(" was disposed") ||
    message.includes("not owner")
  );
}

export function broadcastCodexHostMessageToRendererClients(
  router: CodexOwnerFollowerRendererClientRuntime | null | undefined,
  broadcastToWindows: (channel: string, args: readonly unknown[]) => number,
  message: CodexHostMessage,
  targetClientIds?: readonly string[] | null,
): number {
  if (message.type === "threadStreamStateChanged" && targetClientIds !== undefined) {
    if (!router || targetClientIds === null) return 0;
    return sendRendererThreadStreamRelay(router, targetClientIds, message.sourceClientId, message)
      .sentClientIds.length;
  }

  if (!router) {
    return broadcastToWindows("codex:host-message", [message]);
  }

  return router.broadcast("codex:host-message", [message], {
    sourceClientId:
      message.type === "threadStreamStateChanged" ? (message.sourceClientId ?? null) : null,
    includeSource: !(message.type === "threadStreamStateChanged" && message.sourceClientId),
  });
}

type CodexThreadStreamControlMessage = Extract<
  CodexHostMessage,
  {
    type: "threadStreamFollowersChanged" | "threadStreamTransportReset";
  }
>;

export function sendRendererThreadStreamControlRelay(
  router: CodexOwnerFollowerRendererClientRuntime | null | undefined,
  targetClientIds: readonly string[],
  message: CodexThreadStreamControlMessage,
): RendererClientDeliveryResult {
  if (!router) {
    return {
      sentClientIds: [],
      unavailableClientIds: [...targetClientIds],
      failedClientIds: [],
    };
  }

  return router.sendToClients(targetClientIds, "codex:host-message", [message]);
}

export function sendRendererOwnerHostMessage(
  router: CodexOwnerFollowerRendererClientRuntime | null | undefined,
  event: CodexRendererOwnerHostMessage,
): boolean {
  if (!router) return false;

  return router.sendToClient(event.targetClientId, "codex:host-message", [event.message]);
}

export function sendRendererThreadStreamRelay(
  router: CodexOwnerFollowerRendererClientRuntime | null | undefined,
  targetClientIds: readonly string[],
  sourceClientId: string | null | undefined,
  message: CodexHostMessage,
): RendererClientDeliveryResult {
  if (!router || message.type !== "threadStreamStateChanged") {
    return {
      sentClientIds: [],
      unavailableClientIds: [...targetClientIds],
      failedClientIds: [],
    };
  }

  return router.sendToClients(targetClientIds, "codex:host-message", [message], {
    excludeClientId: sourceClientId ?? null,
  });
}

export const runThreadFollowerActionThroughOwner = Effect.fn(
  "CodexOwnerFollower.runThreadFollowerActionThroughOwner",
)(function* (
  registry: { readonly getOwnerClientId: (conversationId: string) => string | null },
  router: CodexOwnerFollowerRendererClientRuntime | null | undefined,
  sourceClientId: string | null,
  input: CodexThreadFollowerActionInput,
) {
  if (!sourceClientId) {
    return yield* ownerFollowerError("authorize-source", "Renderer client is not registered");
  }

  const ownerClientId = registry.getOwnerClientId(input.conversationId);
  if (!ownerClientId)
    return yield* ownerFollowerError(
      "resolve-owner",
      `no-client-found: no renderer owner for conversation ${input.conversationId}`,
    );
  if (ownerClientId === sourceClientId) {
    return yield* ownerFollowerError(
      "resolve-owner",
      `Renderer client ${sourceClientId} is already owner for ${input.conversationId}`,
    );
  }
  if (!router) {
    return yield* ownerFollowerError("resolve-runtime", "Renderer client runtime is unavailable");
  }

  return yield* router.requireThreadOwner(ownerClientId, input.conversationId).pipe(
    Effect.andThen(router.request(ownerClientId, "thread-owner-action", input.action, {})),
    Effect.mapError((error) =>
      isRendererOwnerUnavailableError(error)
        ? ownerFollowerError(
            "owner-request",
            `no-client-found: renderer owner for ${input.conversationId} is unavailable`,
            error,
          )
        : error,
    ),
  );
});
