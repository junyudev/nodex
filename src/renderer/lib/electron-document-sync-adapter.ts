import type {
  DocumentAwarenessPublishAck,
  DocumentAwarenessPublishRequest,
  DocumentSyncApplyAck,
  DocumentSyncApplyRequest,
  DocumentSyncCommandError,
  DocumentSyncCommandResult,
  DocumentSyncErrorCode,
  DocumentSyncRealtimeEvent,
  DocumentSyncRequest,
  DocumentSyncResponse,
  DocumentSyncSubscribeRequest,
  DocumentSyncSubscriptionAck,
} from "../../shared/block-documents/document-sync";
import { parseCoreFailureEvidence } from "../../shared/core-failure-evidence";
import type { DocumentSyncAdapter } from "./nodex-y-provider";
import type { ElectronRendererBridge } from "./electron-renderer-transport";
import {
  createExactRemoteSubscriptionLifecycle,
  type ExactRemoteSubscriptionLifecycle,
} from "./exact-remote-subscription-lifecycle";
import {
  libraryDocumentUpdateCommand,
  projectDocumentUpdateCommand,
} from "./document-local-replica-commands";
import { rendererLocalCommitIngress } from "./local-commit-ingress";
import { invokeLocalCommitCommandResultThrough } from "./renderer-command";

interface SubscriptionEntry {
  readonly subscribers: Set<{
    readonly listener: (event: DocumentSyncRealtimeEvent) => void;
  }>;
  readonly lifecycle: ExactRemoteSubscriptionLifecycle<
    DocumentSyncCommandResult<DocumentSyncSubscriptionAck>
  >;
}

const ERROR_CODES = new Set<DocumentSyncErrorCode>([
  "transport_unavailable",
  "request_cancelled",
  "request_timeout",
  "service_busy",
  "unauthorized",
  "store_not_initialized",
  "store_epoch_mismatch",
  "document_not_found",
  "document_not_ready",
  "document_generation_mismatch",
  "unsupported_document_schema",
  "future_base_head",
  "invalid_document_update",
  "invalid_awareness_update",
  "document_update_missing_dependencies",
  "protected_owner_mutation",
  "update_id_collision",
  "block_relocated",
  "recovery_required",
  "document_state_corrupt",
  "invalid_response",
  "unknown",
]);

const transportError = (error: unknown): DocumentSyncCommandError => ({
  code: "transport_unavailable",
  message: error instanceof Error ? error.message : "Electron IPC is unavailable",
  retryable: true,
  resetRequired: false,
});

const invalidResponseError = (message: string): DocumentSyncCommandError => ({
  code: "invalid_response",
  message,
  retryable: false,
  resetRequired: false,
});

const unauthorizedError = (): DocumentSyncCommandError => ({
  code: "unauthorized",
  message: "The document provider has no active Electron subscription",
  retryable: false,
  resetRequired: false,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const copyBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) {
    return value.slice();
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (!ArrayBuffer.isView(value)) {
    return null;
  }
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
};

const normalizeError = (value: unknown): DocumentSyncCommandError | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.code !== "string" ||
    !ERROR_CODES.has(value.code as DocumentSyncErrorCode) ||
    typeof value.message !== "string" ||
    typeof value.retryable !== "boolean" ||
    typeof value.resetRequired !== "boolean"
  ) {
    return null;
  }
  if (
    value.relocationId !== undefined &&
    (typeof value.relocationId !== "string" || value.relocationId.length === 0)
  ) {
    return null;
  }
  if (
    value.recoveryArtifactId !== undefined &&
    (typeof value.recoveryArtifactId !== "string" || value.recoveryArtifactId.length === 0)
  ) {
    return null;
  }
  let core: DocumentSyncCommandError["core"];
  try {
    core = value.core === undefined ? undefined : parseCoreFailureEvidence(value.core);
  } catch {
    return null;
  }
  return {
    code: value.code as DocumentSyncErrorCode,
    ...(core === undefined ? {} : { core }),
    message: value.message,
    retryable: value.retryable,
    resetRequired: value.resetRequired,
    ...(typeof value.relocationId === "string" ? { relocationId: value.relocationId } : {}),
    ...(typeof value.recoveryArtifactId === "string"
      ? { recoveryArtifactId: value.recoveryArtifactId }
      : {}),
  };
};

const normalizeCommandResult = <T>(value: unknown): DocumentSyncCommandResult<T> => {
  if (!isRecord(value) || typeof value.ok !== "boolean") {
    return {
      ok: false,
      error: invalidResponseError("Electron document sync returned an invalid envelope"),
    };
  }
  if (value.ok) {
    if (!("value" in value)) {
      return {
        ok: false,
        error: invalidResponseError("Electron document sync omitted its result"),
      };
    }
    return { ok: true, value: value.value as T };
  }

  const error = normalizeError(value.error);
  if (error) {
    return { ok: false, error };
  }
  return {
    ok: false,
    error: invalidResponseError("Electron document sync returned an invalid error"),
  };
};

const normalizeSyncResult = (
  result: DocumentSyncCommandResult<DocumentSyncResponse>,
): DocumentSyncCommandResult<DocumentSyncResponse> => {
  if (!result.ok) {
    return result;
  }
  const value = result.value as unknown;
  if (!isRecord(value)) {
    return {
      ok: false,
      error: invalidResponseError("Invalid document sync result"),
    };
  }
  const stateVector = copyBytes(value.stateVector);
  const update = copyBytes(value.update);
  if (
    !stateVector ||
    !update ||
    typeof value.documentId !== "string" ||
    typeof value.storeEpoch !== "string" ||
    typeof value.generation !== "number" ||
    typeof value.headSeq !== "number"
  ) {
    return {
      ok: false,
      error: invalidResponseError("Invalid document sync result"),
    };
  }
  return {
    ok: true,
    value: {
      documentId: value.documentId,
      storeEpoch: value.storeEpoch,
      generation: value.generation,
      headSeq: value.headSeq,
      stateVector,
      update,
    },
  };
};

const normalizeApplyResult = (
  result: DocumentSyncCommandResult<DocumentSyncApplyAck>,
): DocumentSyncCommandResult<DocumentSyncApplyAck> => {
  if (!result.ok) {
    return result;
  }
  const value = result.value as unknown;
  if (!isRecord(value)) {
    return {
      ok: false,
      error: invalidResponseError("Invalid document update ACK"),
    };
  }
  const stateVector = copyBytes(value.stateVector);
  if (
    !stateVector ||
    typeof value.documentId !== "string" ||
    typeof value.storeEpoch !== "string" ||
    typeof value.generation !== "number" ||
    typeof value.updateId !== "string" ||
    typeof value.committedSeq !== "number" ||
    typeof value.headSeq !== "number" ||
    typeof value.duplicate !== "boolean"
  ) {
    return {
      ok: false,
      error: invalidResponseError("Invalid document update ACK"),
    };
  }
  const common = {
    documentId: value.documentId,
    storeEpoch: value.storeEpoch,
    generation: value.generation,
    updateId: value.updateId,
    committedSeq: value.committedSeq,
    headSeq: value.headSeq,
    stateVector,
    duplicate: value.duplicate,
  };
  if (value.status === "committed" && isRecord(value.commit)) {
    const commit = value.commit;
    if (
      typeof commit.store_epoch !== "string" ||
      typeof commit.commit_seq !== "number" ||
      typeof commit.manifest_hash !== "string"
    ) {
      return {
        ok: false,
        error: invalidResponseError("Invalid document update commit identity"),
      };
    }
    return {
      ok: true,
      value: {
        ...common,
        status: "committed",
        commit: {
          store_epoch: commit.store_epoch,
          commit_seq: commit.commit_seq,
          manifest_hash: commit.manifest_hash,
        },
        ...(isRecord(value.delivery)
          ? {
              delivery: value.delivery as Extract<
                DocumentSyncApplyAck,
                { readonly status: "committed" }
              >["delivery"],
            }
          : {}),
      },
    };
  }
  if (value.status === "no_op" && isRecord(value.observed)) {
    const observed = value.observed;
    if (typeof observed.store_epoch !== "string" || typeof observed.commit_head !== "number") {
      return {
        ok: false,
        error: invalidResponseError("Invalid document update observation"),
      };
    }
    return {
      ok: true,
      value: {
        ...common,
        status: "no_op",
        observed: {
          store_epoch: observed.store_epoch,
          commit_head: observed.commit_head,
        },
      },
    };
  }
  return {
    ok: false,
    error: invalidResponseError("Invalid document update ACK status"),
  };
};

const normalizeRealtimeEvent = (value: unknown): DocumentSyncRealtimeEvent | null => {
  if (!isRecord(value) || typeof value.kind !== "string" || typeof value.documentId !== "string") {
    return null;
  }
  if (value.kind === "terminated") {
    const error = normalizeError(value.error);
    if (!error || typeof value.clientSessionId !== "string") return null;
    return {
      kind: "terminated",
      documentId: value.documentId,
      clientSessionId: value.clientSessionId,
      error,
    };
  }
  if (value.kind === "connection") {
    if (
      typeof value.clientSessionId !== "string" ||
      (value.state !== "connected" && value.state !== "disconnected")
    ) {
      return null;
    }
    return {
      kind: "connection",
      documentId: value.documentId,
      clientSessionId: value.clientSessionId,
      state: value.state,
    };
  }
  if (value.kind === "store-reset") {
    if (typeof value.storeEpoch !== "string" || value.storeEpoch.length === 0) {
      return null;
    }
    return {
      kind: "store-reset",
      documentId: value.documentId,
      storeEpoch: value.storeEpoch,
    };
  }
  if (value.kind === "document-update") {
    const update = copyBytes(value.update);
    if (
      !update ||
      typeof value.storeEpoch !== "string" ||
      typeof value.generation !== "number" ||
      typeof value.headSeq !== "number" ||
      typeof value.updateId !== "string" ||
      typeof value.clientSessionId !== "string"
    ) {
      return null;
    }
    return {
      kind: "document-update",
      documentId: value.documentId,
      storeEpoch: value.storeEpoch,
      generation: value.generation,
      headSeq: value.headSeq,
      ...(typeof value.commitSeq === "number" ? { commitSeq: value.commitSeq } : {}),
      ...(typeof value.effectSequence === "number" ? { effectSequence: value.effectSequence } : {}),
      updateId: value.updateId,
      clientSessionId: value.clientSessionId,
      update,
    };
  }
  if (value.kind === "awareness") {
    const update = copyBytes(value.update);
    if (
      !update ||
      typeof value.storeEpoch !== "string" ||
      typeof value.generation !== "number" ||
      typeof value.clientSessionId !== "string"
    ) {
      return null;
    }
    return {
      kind: "awareness",
      documentId: value.documentId,
      storeEpoch: value.storeEpoch,
      generation: value.generation,
      clientSessionId: value.clientSessionId,
      update,
    };
  }
  if (value.kind !== "resync-required") {
    return null;
  }
  if (
    typeof value.storeEpoch !== "string" ||
    typeof value.generation !== "number" ||
    typeof value.headSeq !== "number" ||
    (value.reason !== "event-gap" &&
      value.reason !== "history-compacted" &&
      value.reason !== "transport-reconnected" &&
      value.reason !== "resource-integrity-failure" &&
      value.reason !== "identity-boundary-changed" &&
      value.reason !== "access-revoked")
  ) {
    return null;
  }
  return {
    kind: "resync-required",
    documentId: value.documentId,
    storeEpoch: value.storeEpoch,
    generation: value.generation,
    headSeq: value.headSeq,
    ...(typeof value.commitSeq === "number" ? { commitSeq: value.commitSeq } : {}),
    ...(typeof value.effectSequence === "number" ? { effectSequence: value.effectSequence } : {}),
    reason: value.reason,
  };
};

const subscriptionKey = (request: DocumentSyncSubscribeRequest): string =>
  JSON.stringify([request.clientSessionId, request.documentId]);

type ElectronDocumentAccessScope =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "library" };

const createScopedElectronDocumentSyncAdapter = (
  bridge: ElectronRendererBridge,
  accessScope: ElectronDocumentAccessScope,
): DocumentSyncAdapter => {
  if (
    accessScope.kind === "project" &&
    (!accessScope.projectId || accessScope.projectId !== accessScope.projectId.trim())
  ) {
    throw new TypeError("projectId must be an exact non-empty identity");
  }
  const subscriptions = new Map<string, SubscriptionEntry>();
  const scope = <Request extends { readonly documentId: string }>(
    request: Request,
  ): Request | (Request & { readonly projectId: string }) =>
    accessScope.kind === "library" ? request : { ...request, projectId: accessScope.projectId };
  const channel = (operation: string): string =>
    accessScope.kind === "library"
      ? `library-document-sync:${operation}`
      : `document-sync:${operation}`;

  const invokeCommand = async <T>(
    channel: string,
    request: unknown,
  ): Promise<DocumentSyncCommandResult<T>> => {
    try {
      return normalizeCommandResult<T>(await bridge.invoke(channel, request));
    } catch (error) {
      return { ok: false, error: transportError(error) };
    }
  };

  const ensureRemoteSubscription = (
    entry: SubscriptionEntry,
  ): Promise<DocumentSyncCommandResult<DocumentSyncSubscriptionAck>> => entry.lifecycle.ensure();

  const withRemoteSubscription = <T>(
    request: DocumentSyncSubscribeRequest,
    command: () => Promise<DocumentSyncCommandResult<T>>,
  ): Promise<DocumentSyncCommandResult<T>> => {
    const entry = subscriptions.get(subscriptionKey(request));
    if (!entry) return Promise.resolve({ ok: false, error: unauthorizedError() });
    return entry.lifecycle.run(async (subscription) => {
      if (!subscription.ok) return { ok: false, error: subscription.error };
      return command();
    });
  };

  return {
    sync: (request: DocumentSyncRequest) =>
      withRemoteSubscription(request, async () =>
        normalizeSyncResult(
          await invokeCommand<DocumentSyncResponse>(channel("sync"), scope(request)),
        ),
      ),
    applyUpdate: (request: DocumentSyncApplyRequest) =>
      withRemoteSubscription(request, async () => {
        try {
          const commandResult =
            accessScope.kind === "library"
              ? await invokeLocalCommitCommandResultThrough(
                  libraryDocumentUpdateCommand,
                  bridge,
                  request,
                )
              : await invokeLocalCommitCommandResultThrough(projectDocumentUpdateCommand, bridge, {
                  ...request,
                  projectId: accessScope.projectId,
                });
          return normalizeApplyResult(normalizeCommandResult<DocumentSyncApplyAck>(commandResult));
        } catch (error) {
          return { ok: false, error: transportError(error) };
        }
      }),
    publishAwareness: (request: DocumentAwarenessPublishRequest) =>
      withRemoteSubscription(request, () =>
        invokeCommand<DocumentAwarenessPublishAck>(channel("awareness:publish"), scope(request)),
      ),
    subscribe: (request, listener) => {
      const key = subscriptionKey(request);
      let entry = subscriptions.get(key);
      if (!entry) {
        const subscribers = new Set<{
          readonly listener: (event: DocumentSyncRealtimeEvent) => void;
        }>();
        const removeBridgeListener = bridge.on("document-sync:event", (...args: unknown[]) => {
          const event = normalizeRealtimeEvent(args[0]);
          if (!event || event.documentId !== request.documentId) {
            return;
          }
          if (
            (event.kind === "connection" || event.kind === "terminated") &&
            event.clientSessionId !== request.clientSessionId
          ) {
            return;
          }
          if (event.kind === "terminated") subscriptions.get(key)?.lifecycle.invalidate();
          subscribers.forEach((subscriber) => subscriber.listener(event));
        });
        const removeLocalListener = rendererLocalCommitIngress.subscribeDocument(
          request.documentId,
          (event) => {
            subscribers.forEach((subscriber) => subscriber.listener(event));
          },
        );
        const lifecycle = createExactRemoteSubscriptionLifecycle<
          DocumentSyncCommandResult<DocumentSyncSubscriptionAck>
        >({
          hasSubscribers: () => subscribers.size > 0,
          open: async () => {
            const result = await invokeCommand<DocumentSyncSubscriptionAck>(
              channel("subscribe"),
              scope(request),
            );
            if (!result.ok || result.value.subscribed === true) return result;
            return {
              ok: false,
              error: invalidResponseError("Electron did not confirm document subscription"),
            };
          },
          isOpenResult: (result) => result.ok,
          alreadyOpenResult: () => ({
            ok: true,
            value: { subscribed: true },
          }),
          inactiveResult: () => ({
            ok: false,
            error: unauthorizedError(),
          }),
          close: async () => {
            await invokeCommand(channel("unsubscribe"), scope(request));
          },
          finalize: () => {
            if (subscriptions.get(key)?.lifecycle === lifecycle) {
              subscriptions.delete(key);
            }
            removeBridgeListener();
            removeLocalListener();
          },
        });
        const createdEntry: SubscriptionEntry = {
          subscribers,
          lifecycle,
        };
        entry = createdEntry;
        subscriptions.set(key, entry);
      }
      const subscriber = { listener };
      entry.subscribers.add(subscriber);
      void ensureRemoteSubscription(entry);

      let active = true;
      return () => {
        if (!active) {
          return;
        }
        active = false;
        entry?.subscribers.delete(subscriber);
        if (!entry || entry.subscribers.size > 0) return;
        entry.lifecycle.releaseIfIdle();
      };
    },
  };
};

export function createElectronDocumentSyncAdapter(
  bridge: ElectronRendererBridge,
  projectId: string,
): DocumentSyncAdapter {
  return createScopedElectronDocumentSyncAdapter(bridge, {
    kind: "project",
    projectId,
  });
}

export function createElectronLibraryDocumentSyncAdapter(
  bridge: ElectronRendererBridge,
): DocumentSyncAdapter {
  return createScopedElectronDocumentSyncAdapter(bridge, { kind: "library" });
}
