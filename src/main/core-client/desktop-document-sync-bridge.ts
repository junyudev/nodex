import { CoreEventCompatibilityError } from "./uds-http";
import { createHash } from "node:crypto";
import { documentSessionError } from "./document-session-error";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import { revocationsFromVisibilityDelta } from "../../shared/local-commit-delivery";
import type { ResourceRevocation } from "../../shared/resource-revocation-stream";

import type {
  AdditionalDocumentCommandRequest,
  AdditionalDocumentCommandResult,
} from "../../shared/additional-document-commands";
import type {
  CreateDocumentVersionCheckpoint,
  CreatedDocumentVersionSummary,
  DocumentVersionDetail,
  DocumentVersionSummary,
  GetDocumentVersion,
  ListDocumentVersions,
  PrepareDocumentVersionRestore,
} from "../../shared/block-documents/document-history";
import type { DocumentHistoryCommandResult } from "../../shared/block-documents/document-history-transport";
import type {
  DocumentMutationRequest,
  DocumentOperationCommandResult,
} from "../../shared/block-documents/document-operations";
import type {
  BlockTransferCommandResult,
  BlockTransferIntent,
  BlockTransferUndoCommandResult,
  BlockTransferUndoIntent,
} from "../../shared/block-transfer";
import { documentMutationFailure } from "../../shared/block-documents/document-operation-transport";
import type {
  CanvasSceneMutationCommandResult,
  CanvasSceneMutationError,
  CanvasSceneMutationRequest,
  CanvasSceneRealtimeEvent,
  CanvasSceneSubscribeRequest,
  CanvasSceneSubscriptionCommandResult,
  CanvasSceneSyncCommandResult,
  CanvasSceneSyncRequest,
} from "../../shared/block-documents/canvas-scene-sync";
import type {
  CanvasSceneCompactionCommandResult,
  CanvasSceneCompactionReadCommandResult,
  CanvasSceneCompactionReadRequest,
  CanvasSceneCompactionRequest,
} from "../../shared/block-documents/canvas-scene-maintenance";
import {
  requireLibraryAccessedDocumentDescriptor,
  requireProjectAccessedDocumentDescriptor,
  type LibraryAccessedDocumentDescriptor,
  type ProjectAccessedDocumentDescriptor,
} from "../../shared/block-documents/contracts";
import type {
  DocumentAwarenessPublishAck,
  DocumentAwarenessPublishRequest,
  DocumentSyncApplyAck,
  DocumentSyncApplyRequest,
  DocumentSyncCommandResult,
  DocumentSyncRequest,
  DocumentSyncRealtimeEvent,
  DocumentSyncResponse,
  DocumentSyncSubscribeRequest,
  DocumentSyncSubscriptionAck,
  DocumentSyncUnsubscribeAck,
} from "../../shared/block-documents/document-sync";
import {
  documentSyncUnauthorized,
  type DocumentSyncClientTarget,
} from "../document-sync-transport";
import { createCanvasPresenceHub, type CanvasPresenceHub } from "../canvas-presence-hub";
import { safeSendToWebContents } from "../ipc-safe-send";
import {
  canonicalizeCanvasPresencePublishRequest,
  type CanvasPresenceCommandErrorCode,
  type CanvasPresenceCommandResult,
  type CanvasPresencePublishRequest,
} from "../../shared/block-documents/document-presence";
import { decodeCanvasSceneSseEvent } from "../../shared/block-documents/canvas-scene-http-contract";
import {
  contentAccessContextKey,
  type ContentAccessContext,
} from "../../shared/content-access-context";
import {
  createCoreCanvasSceneCommands,
  mapCanvasLiveEnvelope,
  mapCoreCanvasSceneFailure,
} from "./core-canvas-scene-adapter";
import { createCoreBlockTransferAdapter } from "./block-transfer-adapter";
import { createCoreDocumentSyncAdapter, mapDocumentLiveEnvelope } from "./document-sync-adapter";
import { isRetryableCoreEventStreamError } from "./core-event-stream-retry";
import {
  resolveAuthorizedDocumentEffect,
  resolveInlineAuthorizedDocumentEffect,
} from "./document-effect-delivery";
import type {
  CoreAuthorizedDeliveryPacket,
  CoreDocumentEventSubscription,
  CoreEventEnvelope,
  DocumentLiveRepair,
} from "./types";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { CoreModules } from "../core-runtime/CoreModules";
import type { CoreRuntimeError } from "../core-runtime/CoreRuntimeError";
import { createOperationId } from "../core-runtime/operation-identity";
import {
  DocumentLiveRuntime,
  documentLiveRuntimeError,
  type DocumentLiveLease,
} from "../core-runtime/DocumentLiveRuntime";

const DOCUMENT_SYNC_EVENT_CHANNEL = "document-sync:event";

export type DesktopDocumentSyncScope = ContentAccessContext;

export class DesktopDocumentSessionError extends Schema.TaggedError<DesktopDocumentSessionError>()(
  "DesktopDocumentSessionError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

type SessionEffect<Value> = Effect.Effect<Value, DesktopDocumentSessionError>;

export interface DesktopDocumentSessionService {
  /** Publishes exact Document effects to already-authorized active sessions. */
  publishDocumentEffects(
    packet: CoreAuthorizedDeliveryPacket,
    documentId?: string,
  ): Effect.Effect<void>;
  /** Closes only sessions addressed by one Core-authored revocation. */
  publishResourceRevocation(
    packet: CoreAuthorizedDeliveryPacket,
    revocation: ResourceRevocation,
  ): Effect.Effect<void>;
  getOwnedDocumentDescriptor(
    projectId: string,
    ownerBlockId: string,
  ): SessionEffect<ProjectAccessedDocumentDescriptor>;
  prepareOwnedBlockDocument(
    projectId: string,
    ownerBlockId: string,
  ): Effect.Effect<DocumentSyncCommandResult<ProjectAccessedDocumentDescriptor>>;
  prepareLibraryOwnedBlockDocument(
    ownerBlockId: string,
  ): Effect.Effect<DocumentSyncCommandResult<LibraryAccessedDocumentDescriptor>>;
  subscribe(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentSyncSubscribeRequest,
  ): Effect.Effect<DocumentSyncCommandResult<DocumentSyncSubscriptionAck>>;
  unsubscribe(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentSyncSubscribeRequest,
  ): Effect.Effect<DocumentSyncCommandResult<DocumentSyncUnsubscribeAck>>;
  sync(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentSyncRequest,
  ): Effect.Effect<DocumentSyncCommandResult<DocumentSyncResponse>>;
  applyUpdate(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentSyncApplyRequest,
  ): Effect.Effect<DocumentSyncCommandResult<DocumentSyncApplyAck>>;
  publishAwareness(
    scope: DesktopDocumentSyncScope,
    target: DocumentSyncClientTarget,
    request: DocumentAwarenessPublishRequest,
  ): Effect.Effect<DocumentSyncCommandResult<DocumentAwarenessPublishAck>>;
  subscribeCanvasScene(
    target: DocumentSyncClientTarget,
    request: CanvasSceneSubscribeRequest,
  ): Effect.Effect<CanvasSceneSubscriptionCommandResult>;
  unsubscribeCanvasScene(
    target: DocumentSyncClientTarget,
    request: CanvasSceneSubscribeRequest,
  ): Effect.Effect<CanvasSceneSubscriptionCommandResult>;
  syncCanvasScene(
    target: DocumentSyncClientTarget,
    request: CanvasSceneSyncRequest,
  ): Effect.Effect<CanvasSceneSyncCommandResult>;
  applyCanvasSceneMutation(
    target: DocumentSyncClientTarget,
    request: CanvasSceneMutationRequest,
  ): Effect.Effect<CanvasSceneMutationCommandResult>;
  publishCanvasPresence(
    target: DocumentSyncClientTarget,
    request: CanvasPresencePublishRequest,
  ): Effect.Effect<CanvasPresenceCommandResult>;
  readCanvasSceneCompaction(
    target: DocumentSyncClientTarget,
    request: CanvasSceneCompactionReadRequest,
  ): Effect.Effect<CanvasSceneCompactionReadCommandResult>;
  compactCanvasScene(
    target: DocumentSyncClientTarget,
    request: CanvasSceneCompactionRequest,
  ): Effect.Effect<CanvasSceneCompactionCommandResult>;
  applyAdditionalDocumentCommand(
    request: AdditionalDocumentCommandRequest,
  ): SessionEffect<AdditionalDocumentCommandResult>;
  createCheckpoint(
    request: CreateDocumentVersionCheckpoint,
  ): SessionEffect<DocumentHistoryCommandResult<CreatedDocumentVersionSummary>>;
  listVersions(
    request: ListDocumentVersions,
  ): SessionEffect<DocumentHistoryCommandResult<readonly DocumentVersionSummary[]>>;
  getVersion(
    request: GetDocumentVersion,
  ): SessionEffect<DocumentHistoryCommandResult<DocumentVersionDetail>>;
  restoreVersion(
    request: PrepareDocumentVersionRestore,
  ): Effect.Effect<DocumentOperationCommandResult>;
  applyDocumentMutation(
    request: DocumentMutationRequest,
  ): Effect.Effect<DocumentOperationCommandResult>;
  transferBlocks(
    intent: BlockTransferIntent,
    editorHistoryOwnerId?: string,
  ): Effect.Effect<BlockTransferCommandResult>;
  undoBlockTransfer(
    intent: BlockTransferUndoIntent,
    editorHistoryOwnerId?: string,
  ): Effect.Effect<BlockTransferUndoCommandResult>;
}

export class DesktopDocumentSessionRuntime extends Context.Service<
  DesktopDocumentSessionRuntime,
  DesktopDocumentSessionService
>()("nodex/main/core-client/DesktopDocumentSessionRuntime") {}

export interface DesktopDocumentSessionRuntimeOptions {
  readonly canvasPresenceHub?: CanvasPresenceHub;
}

interface DesktopDocumentSessionRuntimeDependencies extends DesktopDocumentSessionRuntimeOptions {
  readonly coreAuthority: CoreAuthority["Service"];
  readonly coreSession: CoreSessionAccess["Service"];
  readonly coreModules: CoreModules["Service"];
  readonly documentLive: DocumentLiveRuntime["Service"];
}

type OrderedDocumentRealtimeEvent = Extract<
  DocumentSyncRealtimeEvent,
  { readonly kind: "document-update" | "resync-required" }
>;

type OrderedCanvasRealtimeEvent = Exclude<
  CanvasSceneRealtimeEvent,
  { readonly type: "canvas_scene_session" }
>;

type PendingNativeRealtimeEvent =
  | {
      readonly engine: "yjs";
      readonly event: OrderedDocumentRealtimeEvent;
    }
  | {
      readonly engine: "canvas_scene";
      readonly event: OrderedCanvasRealtimeEvent;
    };

const MAX_PENDING_REALTIME_EVENTS = 256;

interface NativeSubscription {
  failureCount?: number;
  lastFailure?: string;
  readonly engine: "yjs" | "canvas_scene";
  readonly bindingKey: string;
  readonly scope: DesktopDocumentSyncScope;
  readonly libraryId?: string;
  readonly documentId: string;
  readonly clientSessionId: string;
  readonly target: DocumentSyncClientTarget;
  readonly targetId: number;
  readonly close: () => void;
  readonly lease: DocumentLiveLease;
  readonly pendingRealtimeEvents: Map<string, PendingNativeRealtimeEvent>;
  storeEpoch?: string;
  generation?: number;
  headSeq?: number;
}

interface PendingNativeSubscription {
  readonly targetId: number;
  readonly settled: Deferred.Deferred<void>;
  close: (() => void) | null;
  cancelled: boolean;
}

type NativeSubscriptionReservation =
  | { readonly kind: "existing" }
  | { readonly kind: "conflict" }
  | { readonly kind: "target_destroyed" }
  | {
      readonly kind: "reserved";
      readonly pending: PendingNativeSubscription;
    };

const scopeKey = (scope: DesktopDocumentSyncScope): string => contentAccessContextKey(scope);

const authorizationScopeMatchesDocumentScope = (
  authorization: CoreAuthorizedDeliveryPacket["authorization_scope"],
  scope: DesktopDocumentSyncScope,
): boolean => {
  if (authorization.kind === "library") return scope.kind === "library";
  const projectId = authorization.project_id ?? null;
  if (projectId === null) return scope.kind === "library";
  return scope.kind === "project" && scope.projectId === projectId;
};

const packetRevokesDocumentScope = (
  packet: CoreAuthorizedDeliveryPacket,
  documentId: string,
  scope: DesktopDocumentSyncScope,
): boolean =>
  packet.visibility_deltas
    .flatMap(revocationsFromVisibilityDelta)
    .some(
      (revocation) =>
        revocation.resource_kind === "document" &&
        revocation.resource_id === documentId &&
        authorizationScopeMatchesDocumentScope(revocation.authorization_scope, scope),
    );

const subscriptionKey = (
  target: DocumentSyncClientTarget,
  scope: DesktopDocumentSyncScope,
  request: DocumentSyncSubscribeRequest,
): string =>
  JSON.stringify(["yjs", target.id, scopeKey(scope), request.clientSessionId, request.documentId]);

const canvasSceneSubscriptionKey = (
  target: DocumentSyncClientTarget,
  request: CanvasSceneSubscribeRequest,
): string =>
  JSON.stringify([
    "canvas_scene",
    target.id,
    contentAccessContextKey(request.accessContext),
    request.clientSessionId,
    request.documentId,
  ]);

const bindingKey = (request: Pick<DocumentSyncSubscribeRequest, "clientSessionId">): string =>
  request.clientSessionId;

const ownerCommandIdentity = (
  scope: DesktopDocumentSyncScope,
): { readonly clientSessionId: string; readonly operationId: string } => {
  return {
    clientSessionId: "electron:owned-document:prepare",
    // One IPC request is one retry episode. Core preparation is state-idempotent,
    // so a later request (including after a restart) may safely use a fresh window.
    operationId: createOperationId(`document.prepare-${scope.kind}-owner`),
  };
};

const documentFailure = <Value>(error: unknown): DocumentSyncCommandResult<Value> => ({
  ok: false,
  error: documentSessionError(error),
});

type CanvasCommandResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: CanvasSceneMutationError };

type CanvasCommandFailure = Extract<CanvasCommandResult<never>, { readonly ok: false }>;

const canvasSceneFailure = (
  code: CanvasSceneMutationError["code"],
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly mutationId?: string;
  } = {},
): CanvasCommandFailure => ({
  ok: false,
  error: {
    code,
    message,
    retryable: options.retryable ?? false,
    resetRequired: false,
    ...(options.mutationId ? { mutationId: options.mutationId } : {}),
  },
});

const canvasSceneUnauthorized = (mutationId?: string): CanvasCommandFailure =>
  canvasSceneFailure("access_scope_mismatch", "An exact Canvas scene subscription is required", {
    mutationId,
  });

const canvasPresenceFailure = (
  code: CanvasPresenceCommandErrorCode,
  message: string,
  options: {
    readonly retryable?: boolean;
    readonly resetRequired?: boolean;
  } = {},
): CanvasPresenceCommandResult => ({
  ok: false,
  error: {
    code,
    message,
    retryable: options.retryable ?? false,
    resetRequired: options.resetRequired ?? false,
  },
});

const hasCanvasSceneIdentity = (request: CanvasSceneSubscribeRequest): boolean => {
  if (
    typeof request.documentId !== "string" ||
    request.documentId.length === 0 ||
    request.documentId.length > 512 ||
    request.documentId.trim() !== request.documentId ||
    typeof request.clientSessionId !== "string" ||
    request.clientSessionId.length === 0 ||
    request.clientSessionId.length > 512 ||
    request.clientSessionId.trim() !== request.clientSessionId
  ) {
    return false;
  }
  try {
    contentAccessContextKey(request.accessContext);
    return true;
  } catch {
    return false;
  }
};

const makeDesktopDocumentSessionState = (
  input: DesktopDocumentSessionRuntimeDependencies,
  background: (effect: Effect.Effect<void>) => unknown,
) => {
  const subscriptions = new Map<string, NativeSubscription>();
  const deliveredCommitKeys = new Map<string, Set<string>>();
  const bindings = new Map<string, string>();
  const pendingSubscriptions = new Map<string, PendingNativeSubscription>();
  const targetListeners = new Map<
    number,
    {
      readonly target: DocumentSyncClientTarget;
      readonly onDestroyed: () => void;
    }
  >();
  const canvasPresenceHub = input.canvasPresenceHub ?? createCanvasPresenceHub();
  let accepting = true;

  const closeSubscription = (key: string): void => {
    const subscription = subscriptions.get(key);
    if (!subscription) return;
    if (subscription.engine === "canvas_scene") {
      canvasPresenceHub.unregister(key);
    }
    subscriptions.delete(key);
    deliveredCommitKeys.delete(key);
    subscription.pendingRealtimeEvents.clear();
    if (bindings.get(subscription.bindingKey) === key) {
      bindings.delete(subscription.bindingKey);
    }
    subscription.close();
    releaseTargetListenerIfIdle(subscription.targetId);
  };

  const rememberDeliveredCommit = (key: string, identity: string): void => {
    const delivered = deliveredCommitKeys.get(key) ?? new Set<string>();
    delivered.add(identity);
    deliveredCommitKeys.set(key, delivered);
    while (delivered.size > 2048) {
      const oldest = delivered.values().next().value;
      if (oldest === undefined) break;
      delivered.delete(oldest);
    }
  };

  const sendDocumentRealtimeEvent = (
    key: string,
    target: DocumentSyncClientTarget,
    event: OrderedDocumentRealtimeEvent,
  ): boolean => {
    const identity =
      event.commitSeq === undefined
        ? null
        : `${event.storeEpoch}:${event.commitSeq}:${event.effectSequence ?? 0}`;
    if (identity && deliveredCommitKeys.get(key)?.has(identity)) return true;
    const sent = safeSendToWebContents(target, DOCUMENT_SYNC_EVENT_CHANNEL, [event]);
    if (!sent) {
      closeSubscription(key);
      return false;
    }
    if (identity) rememberDeliveredCommit(key, identity);
    return true;
  };

  const sendCanvasRealtimeEvent = (
    key: string,
    target: DocumentSyncClientTarget,
    event: OrderedCanvasRealtimeEvent,
  ): boolean => {
    const identity =
      event.type === "canvas_scene_committed"
        ? `${event.storeEpoch}:${event.documentId}:${event.mutationId}`
        : `${event.storeEpoch}:${event.documentId}:${event.type}:${event.headSeq}`;
    if (deliveredCommitKeys.get(key)?.has(identity)) return true;
    const sent = safeSendToWebContents(target, DOCUMENT_SYNC_EVENT_CHANNEL, [event]);
    if (!sent) closeSubscription(key);
    if (sent) rememberDeliveredCommit(key, identity);
    return sent;
  };

  const documentRealtimeIdentity = (event: OrderedDocumentRealtimeEvent): string =>
    event.commitSeq === undefined
      ? `${event.storeEpoch}:${event.generation}:${event.headSeq}:${event.kind}`
      : `${event.storeEpoch}:${event.commitSeq}:${event.effectSequence ?? 0}`;

  const canvasRealtimeIdentity = (event: OrderedCanvasRealtimeEvent): string =>
    event.type === "canvas_scene_committed"
      ? `${event.storeEpoch}:${event.documentId}:${event.mutationId}`
      : `${event.storeEpoch}:${event.documentId}:${event.type}:${event.generation}:${event.headSeq}`;

  const queuePendingRealtimeEvent = (
    subscription: NativeSubscription,
    pending: PendingNativeRealtimeEvent,
  ): boolean => {
    const identity =
      pending.engine === "yjs"
        ? documentRealtimeIdentity(pending.event)
        : canvasRealtimeIdentity(pending.event);
    if (subscription.pendingRealtimeEvents.has(identity)) return true;
    if (subscription.pendingRealtimeEvents.size >= MAX_PENDING_REALTIME_EVENTS) {
      subscription.pendingRealtimeEvents.clear();
      return false;
    }
    subscription.pendingRealtimeEvents.set(identity, pending);
    return true;
  };

  const beginPendingSubscription = (
    ownerKey: string,
    targetId: number,
  ): Effect.Effect<PendingNativeSubscription> =>
    Effect.gen(function* () {
      const settled = yield* Deferred.make<void>();
      const pending: PendingNativeSubscription = {
        targetId,
        settled,
        close: null,
        cancelled: false,
      };
      pendingSubscriptions.set(ownerKey, pending);
      return pending;
    });

  const cancelPendingSubscription = (pending: PendingNativeSubscription): void => {
    pending.cancelled = true;
    pending.close?.();
  };

  const settlePendingSubscription = (
    ownerKey: string,
    pending: PendingNativeSubscription,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (pendingSubscriptions.get(ownerKey) === pending) {
        pendingSubscriptions.delete(ownerKey);
      }
    }).pipe(Effect.andThen(Deferred.succeed(pending.settled, undefined)), Effect.asVoid);

  const reserveNativeSubscription = (
    ownerKey: string,
    key: string,
    target: DocumentSyncClientTarget,
  ): Effect.Effect<NativeSubscriptionReservation> =>
    Effect.suspend(() => {
      if (!accepting || target.isDestroyed()) {
        return Effect.succeed({ kind: "target_destroyed" } as const);
      }
      const predecessor = pendingSubscriptions.get(ownerKey);
      if (predecessor) {
        return Deferred.await(predecessor.settled).pipe(
          Effect.andThen(reserveNativeSubscription(ownerKey, key, target)),
        );
      }
      if (subscriptions.has(key)) return Effect.succeed({ kind: "existing" } as const);
      if (bindings.has(ownerKey)) return Effect.succeed({ kind: "conflict" } as const);
      bindings.set(ownerKey, key);
      return beginPendingSubscription(ownerKey, target.id).pipe(
        Effect.map((pending) => ({ kind: "reserved" as const, pending })),
      );
    });

  const adoptSubscriptionBoundary = (
    key: string,
    boundary: {
      readonly storeEpoch: string;
      readonly generation: number;
      readonly headSeq: number;
    },
  ): void => {
    const subscription = subscriptions.get(key);
    if (!subscription) return;
    const previousGeneration = subscription.generation;
    const generationChanged =
      previousGeneration !== undefined && previousGeneration !== boundary.generation;
    const epochChanged =
      subscription.storeEpoch !== undefined && subscription.storeEpoch !== boundary.storeEpoch;
    if (generationChanged || epochChanged) {
      subscription.pendingRealtimeEvents.clear();
    }
    subscription.storeEpoch = boundary.storeEpoch;
    subscription.generation = boundary.generation;
    subscription.headSeq =
      previousGeneration === boundary.generation
        ? Math.max(subscription.headSeq ?? 0, boundary.headSeq)
        : boundary.headSeq;
    if (subscription.engine === "canvas_scene" && previousGeneration !== boundary.generation) {
      canvasPresenceHub.adoptBoundary(key, boundary.generation);
    }
  };

  const suspendSubscriptionBoundary = (key: string): void => {
    const subscription = subscriptions.get(key);
    if (!subscription) return;
    subscription.pendingRealtimeEvents.clear();
    subscription.storeEpoch = undefined;
    subscription.generation = undefined;
    subscription.headSeq = undefined;
  };

  type RealtimeDeliveryOptions = {
    readonly drain?: boolean;
    readonly revokeAfter?: boolean;
  };

  const drainDocumentRealtimeEvents = (key: string, target: DocumentSyncClientTarget): void => {
    while (true) {
      const subscription = subscriptions.get(key);
      if (
        !subscription ||
        subscription.target !== target ||
        subscription.engine !== "yjs" ||
        subscription.generation === undefined ||
        subscription.headSeq === undefined
      ) {
        return;
      }
      for (const [identity, pending] of subscription.pendingRealtimeEvents) {
        if (
          pending.engine === "yjs" &&
          pending.event.kind === "document-update" &&
          pending.event.storeEpoch === subscription.storeEpoch &&
          (pending.event.generation < subscription.generation ||
            (pending.event.generation === subscription.generation &&
              pending.event.headSeq <= subscription.headSeq))
        ) {
          subscription.pendingRealtimeEvents.delete(identity);
        }
      }
      const nextHeadSeq = subscription.headSeq + 1;
      const next = [...subscription.pendingRealtimeEvents.entries()].find(
        ([, pending]) =>
          pending.engine === "yjs" &&
          pending.event.kind === "document-update" &&
          pending.event.generation === subscription.generation &&
          pending.event.headSeq === nextHeadSeq,
      );
      if (!next) return;
      subscription.pendingRealtimeEvents.delete(next[0]);
      const pending = next[1];
      if (pending.engine !== "yjs") return;
      if (
        !deliverDocumentRealtimeEvent(key, target, pending.event, {
          drain: false,
        })
      ) {
        return;
      }
    }
  };

  const drainCanvasRealtimeEvents = (key: string, target: DocumentSyncClientTarget): void => {
    while (true) {
      const subscription = subscriptions.get(key);
      if (
        !subscription ||
        subscription.target !== target ||
        subscription.engine !== "canvas_scene" ||
        subscription.generation === undefined ||
        subscription.headSeq === undefined
      ) {
        return;
      }
      for (const [identity, pending] of subscription.pendingRealtimeEvents) {
        if (
          pending.engine === "canvas_scene" &&
          pending.event.storeEpoch === subscription.storeEpoch &&
          (pending.event.generation < subscription.generation ||
            (pending.event.generation === subscription.generation &&
              pending.event.headSeq <= subscription.headSeq))
        ) {
          subscription.pendingRealtimeEvents.delete(identity);
        }
      }
      const nextHeadSeq = subscription.headSeq + 1;
      const next = [...subscription.pendingRealtimeEvents.entries()].find(
        ([, pending]) =>
          pending.engine === "canvas_scene" &&
          pending.event.type === "canvas_scene_committed" &&
          pending.event.generation === subscription.generation &&
          pending.event.headSeq === nextHeadSeq,
      );
      if (!next) return;
      subscription.pendingRealtimeEvents.delete(next[0]);
      const pending = next[1];
      if (pending.engine !== "canvas_scene") return;
      if (
        !deliverCanvasRealtimeEvent(key, target, pending.event, {
          drain: false,
        })
      ) {
        return;
      }
    }
  };

  function deliverDocumentRealtimeEvent(
    key: string,
    target: DocumentSyncClientTarget,
    event: OrderedDocumentRealtimeEvent,
    options: RealtimeDeliveryOptions = {},
  ): boolean {
    const subscription = subscriptions.get(key);
    if (!subscription || subscription.target !== target || subscription.engine !== "yjs") {
      return sendDocumentRealtimeEvent(key, target, event);
    }
    const storeEpochChanged =
      subscription.storeEpoch !== undefined && subscription.storeEpoch !== event.storeEpoch;
    const identity = documentRealtimeIdentity(event);
    if (deliveredCommitKeys.get(key)?.has(identity)) return true;

    if (event.kind === "resync-required") {
      if (
        !storeEpochChanged &&
        subscription.generation !== undefined &&
        event.generation < subscription.generation
      ) {
        return true;
      }
      subscription.pendingRealtimeEvents.clear();
      const delivered = sendDocumentRealtimeEvent(key, target, event);
      if (!delivered) return false;
      suspendSubscriptionBoundary(key);
      if (options.revokeAfter && subscriptions.has(key)) closeSubscription(key);
      return true;
    }

    if (storeEpochChanged) {
      closeSubscription(key);
      return false;
    }

    if (subscription.generation === undefined) {
      if (queuePendingRealtimeEvent(subscription, { engine: "yjs", event })) {
        return true;
      }
      closeSubscription(key);
      return false;
    }
    if (event.generation < subscription.generation) return true;
    if (event.generation > subscription.generation) {
      subscription.pendingRealtimeEvents.clear();
      const delivered = sendDocumentRealtimeEvent(key, target, {
        kind: "resync-required",
        documentId: event.documentId,
        storeEpoch: event.storeEpoch,
        generation: event.generation,
        headSeq: event.headSeq,
        ...(event.commitSeq === undefined ? {} : { commitSeq: event.commitSeq }),
        ...(event.effectSequence === undefined ? {} : { effectSequence: event.effectSequence }),
        reason: "event-gap",
      });
      if (!delivered) return false;
      adoptSubscriptionBoundary(key, event);
      return true;
    }
    if (event.headSeq <= (subscription.headSeq ?? 0)) return true;
    if (event.headSeq > (subscription.headSeq ?? 0) + 1) {
      if (queuePendingRealtimeEvent(subscription, { engine: "yjs", event })) {
        return true;
      }
      const delivered = sendDocumentRealtimeEvent(key, target, {
        kind: "resync-required",
        documentId: event.documentId,
        storeEpoch: event.storeEpoch,
        generation: subscription.generation,
        headSeq: subscription.headSeq ?? 0,
        ...(event.commitSeq === undefined ? {} : { commitSeq: event.commitSeq }),
        ...(event.effectSequence === undefined ? {} : { effectSequence: event.effectSequence }),
        reason: "event-gap",
      });
      if (!delivered) return false;
      subscription.pendingRealtimeEvents.clear();
      return true;
    }
    const delivered = sendDocumentRealtimeEvent(key, target, event);
    if (!delivered) return false;
    adoptSubscriptionBoundary(key, event);
    if (options.drain !== false) drainDocumentRealtimeEvents(key, target);
    return true;
  }

  function deliverCanvasRealtimeEvent(
    key: string,
    target: DocumentSyncClientTarget,
    event: CanvasSceneRealtimeEvent,
    options: RealtimeDeliveryOptions = {},
  ): boolean {
    if (event.type === "canvas_scene_session")
      return safeSendToWebContents(target, DOCUMENT_SYNC_EVENT_CHANNEL, [event]);
    const subscription = subscriptions.get(key);
    if (!subscription || subscription.target !== target || subscription.engine !== "canvas_scene") {
      return sendCanvasRealtimeEvent(key, target, event);
    }
    const storeEpochChanged =
      subscription.storeEpoch !== undefined && subscription.storeEpoch !== event.storeEpoch;
    const identity = canvasRealtimeIdentity(event);
    if (deliveredCommitKeys.get(key)?.has(identity)) return true;
    if (event.type === "canvas_scene_resync_required") {
      if (
        !storeEpochChanged &&
        subscription.generation !== undefined &&
        event.generation < subscription.generation
      ) {
        return true;
      }
      subscription.pendingRealtimeEvents.clear();
      const delivered = sendCanvasRealtimeEvent(key, target, event);
      if (!delivered) return false;
      suspendSubscriptionBoundary(key);
      return true;
    }
    if (storeEpochChanged) {
      closeSubscription(key);
      return false;
    }
    if (subscription.generation === undefined) {
      if (
        queuePendingRealtimeEvent(subscription, {
          engine: "canvas_scene",
          event,
        })
      ) {
        return true;
      }
      closeSubscription(key);
      return false;
    }
    if (event.generation < subscription.generation) return true;
    if (event.generation > subscription.generation) {
      subscription.pendingRealtimeEvents.clear();
      const delivered = sendCanvasRealtimeEvent(key, target, {
        type: "canvas_scene_resync_required",
        libraryId: event.libraryId,
        accessContext: event.accessContext,
        documentId: event.documentId,
        storeEpoch: event.storeEpoch,
        generation: event.generation,
        headSeq: event.headSeq,
      });
      if (!delivered) return false;
      adoptSubscriptionBoundary(key, event);
      return true;
    }
    if (event.headSeq <= (subscription.headSeq ?? 0)) return true;
    if (event.headSeq > (subscription.headSeq ?? 0) + 1) {
      if (queuePendingRealtimeEvent(subscription, { engine: "canvas_scene", event })) {
        return true;
      }
      const delivered = sendCanvasRealtimeEvent(key, target, {
        type: "canvas_scene_resync_required",
        libraryId: event.libraryId,
        accessContext: event.accessContext,
        documentId: event.documentId,
        storeEpoch: event.storeEpoch,
        generation: subscription.generation,
        headSeq: subscription.headSeq ?? 0,
      });
      if (!delivered) return false;
      subscription.pendingRealtimeEvents.clear();
      return true;
    }
    const delivered = sendCanvasRealtimeEvent(key, target, event);
    if (!delivered) return false;
    adoptSubscriptionBoundary(key, event);
    if (options.drain !== false) drainCanvasRealtimeEvents(key, target);
    return true;
  }

  const addNativeSubscription = (
    key: string,
    subscription: NativeSubscription,
  ): { readonly ok: true; readonly value: { readonly subscribed: true } } => {
    subscriptions.set(key, subscription);
    return { ok: true, value: { subscribed: true } };
  };

  const releaseTargetListenerIfIdle = (targetId: number): void => {
    if ([...pendingSubscriptions.values()].some((pending) => pending.targetId === targetId)) return;
    if ([...subscriptions.values()].some((subscription) => subscription.targetId === targetId)) {
      return;
    }
    const listener = targetListeners.get(targetId);
    if (!listener) return;
    targetListeners.delete(targetId);
    listener.target.removeListener("destroyed", listener.onDestroyed);
  };

  const bindTargetLifecycle = (target: DocumentSyncClientTarget): void => {
    const existing = targetListeners.get(target.id);
    if (existing?.target === target) return;
    if (existing) {
      existing.target.removeListener("destroyed", existing.onDestroyed);
      targetListeners.delete(target.id);
    }
    const onDestroyed = (): void => {
      targetListeners.delete(target.id);
      for (const pending of pendingSubscriptions.values()) {
        if (pending.targetId === target.id) cancelPendingSubscription(pending);
      }
      for (const [key, subscription] of subscriptions) {
        if (subscription.targetId === target.id) closeSubscription(key);
      }
    };
    targetListeners.set(target.id, { target, onDestroyed });
    target.once("destroyed", onDestroyed);
  };

  const hasNativeSubscription = (
    target: DocumentSyncClientTarget,
    scope: DesktopDocumentSyncScope,
    request: DocumentSyncSubscribeRequest,
  ): boolean => {
    const subscription = subscriptions.get(subscriptionKey(target, scope, request));
    return subscription?.target === target;
  };

  const hasNativeCanvasSceneSubscription = (
    target: DocumentSyncClientTarget,
    request: CanvasSceneSubscribeRequest,
  ): boolean => {
    if (!hasCanvasSceneIdentity(request)) return false;
    const subscription = subscriptions.get(canvasSceneSubscriptionKey(target, request));
    return subscription?.target === target;
  };

  const sessionError = (operation: string, cause: unknown): DesktopDocumentSessionError =>
    new DesktopDocumentSessionError({ operation, cause });

  const runCanvasCommand = <Success extends { readonly ok: true }>(
    operation: string,
    accessContext: ContentAccessContext,
    run: (
      commands: ReturnType<typeof createCoreCanvasSceneCommands>,
    ) => Promise<Success | CanvasCommandFailure>,
    mutationId?: string,
    key?: string,
    replayAfterReconnect = false,
  ): Effect.Effect<Success | CanvasCommandFailure> => {
    const command = input.coreSession.use(
      operation,
      async (client, signal) =>
        await run(
          createCoreCanvasSceneCommands(
            client,
            {
              libraryId: input.coreAuthority.identity.libraryId,
              accessContext,
            },
            { signal },
          ),
        ),
      { projectId: projectIdFor(accessContext) },
    );
    return (
      key === undefined ? command : withDocumentLease(key, command, replayAfterReconnect)
    ).pipe(Effect.catch((error) => Effect.succeed(mapCoreCanvasSceneFailure(error, mutationId))));
  };

  const projectIdFor = (scope: DesktopDocumentSyncScope): string | undefined =>
    scope.kind === "project" ? scope.projectId : undefined;

  // A recovery response belongs to the attempt that admitted the command. Late responses
  // cannot retire a replacement lease, and the same command is replayed at most once here.
  const withDocumentLease = <Value>(
    key: string,
    command: Effect.Effect<Value, CoreRuntimeError>,
    replayAfterReconnect = false,
  ) =>
    Effect.gen(function* () {
      const subscription = subscriptions.get(key);
      if (!subscription)
        return yield* documentLiveRuntimeError(
          "command.subscription",
          new Error("Document subscription ended"),
        );
      const current = () => subscriptions.get(key) === subscription;
      const ended = () =>
        documentLiveRuntimeError("command.subscription", new Error("Document subscription ended"));
      const version = yield* subscription.lease.waitUntilConnected;
      if (!current()) return yield* ended();
      return yield* command.pipe(
        Effect.tapError((error) => {
          const failure = documentSessionError(error);
          if (!current() && failure.core?.recovery.kind === "reconnect_document_subscription")
            return Effect.void;
          const signature = JSON.stringify([
            error.operation,
            failure.code,
            failure.core?.recovery.kind,
          ]);
          subscription.failureCount = (subscription.failureCount ?? 0) + 1;
          if (subscription.lastFailure === signature) return Effect.void;
          subscription.lastFailure = signature;
          return Effect.logWarning("Document session command failed", {
            session: createHash("sha256").update(key).digest("hex").slice(0, 16),
            operation: error.operation,
            code: failure.core?.code ?? failure.code,
            recovery: failure.core?.recovery.kind ?? "none",
            retryable: failure.retryable,
            attempts: subscription.failureCount,
            connectionVersion: version,
          });
        }),
        Effect.catch((error) => {
          if (
            !current() ||
            documentSessionError(error).core?.recovery.kind !== "reconnect_document_subscription"
          )
            return Effect.fail(error);
          return subscription.lease.reconnectAfterSubscriptionLoss(version).pipe(
            Effect.andThen(
              Effect.gen(function* () {
                if (!current()) return yield* ended();
                return yield* replayAfterReconnect ? command : Effect.fail(error);
              }),
            ),
          );
        }),
      );
    });

  const reportDocumentRecovered = (key: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const subscription = subscriptions.get(key);
      if (!subscription?.failureCount) return Effect.void;
      const attempts = subscription.failureCount;
      subscription.failureCount = 0;
      subscription.lastFailure = undefined;
      return Effect.logInfo("Document session recovered", {
        session: createHash("sha256").update(key).digest("hex").slice(0, 16),
        attempts,
      });
    });

  const reportDocumentTermination = (key: string, error: unknown): Effect.Effect<void> => {
    const failure = documentSessionError(error);
    return Effect.logWarning("Document session stopped", {
      session: createHash("sha256").update(key).digest("hex").slice(0, 16),
      code: failure.core?.code ?? failure.code,
      recovery: failure.core?.recovery.kind ?? "none",
      retryable: failure.retryable,
    });
  };

  const openPhysicalDocumentSubscription = (
    scope: DesktopDocumentSyncScope,
    request: DocumentSyncSubscribeRequest,
    onEvent: (event: CoreEventEnvelope) => void,
    onRepair: (repair: DocumentLiveRepair) => void,
    onRealtime: (event: DocumentSyncRealtimeEvent) => void,
  ) =>
    input.coreSession
      .use(
        "document.live.open",
        async (client, signal): Promise<CoreDocumentEventSubscription> =>
          await client.openDocumentEventStream(
            {
              documentId: request.documentId,
              clientSessionId: request.clientSessionId,
              signal,
            },
            onEvent,
            onRepair,
            onRealtime,
          ),
        { projectId: projectIdFor(scope) },
      )
      .pipe(
        Effect.map((subscription) => ({
          barrier: subscription.barrier,
          done: Effect.tryPromise({
            try: () => subscription.done,
            catch: (cause) => documentLiveRuntimeError("stream.done", cause),
          }),
          close: Effect.sync(() => subscription.close()).pipe(Effect.ignoreCause),
        })),
        Effect.mapError((cause) => documentLiveRuntimeError("stream.open", cause)),
      );

  const closeLiveLease = (lease: DocumentLiveLease): (() => void) => {
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      void background(lease.close);
    };
  };

  const retryDocumentLive = (cause: unknown | null): boolean => {
    if (cause === null) return true;
    if (
      typeof cause === "object" &&
      cause !== null &&
      "_tag" in cause &&
      cause._tag === "CoreRuntimeError" &&
      "retryable" in cause
    ) {
      return cause.retryable === true;
    }
    return isRetryableCoreEventStreamError(cause);
  };

  const applyDocumentMutation = (
    request: DocumentMutationRequest,
  ): Effect.Effect<DocumentOperationCommandResult> =>
    input.coreSession
      .use(
        "document.mutate",
        (client) => createCoreDocumentSyncAdapter(client).applyDocumentMutation(request),
        { projectId: request.projectId },
      )
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            error: documentMutationFailure(
              "unknown",
              error.cause instanceof Error ? error.cause.message : error.message,
              { mutationId: request.mutationId, retryable: documentSessionError(error).retryable },
            ),
          }),
        ),
      );

  const compactCanvasScene = (
    target: DocumentSyncClientTarget,
    request: CanvasSceneCompactionRequest,
  ): Effect.Effect<CanvasSceneCompactionCommandResult> =>
    runCanvasCommand(
      "canvas.compact",
      request.accessContext,
      async (commands) => {
        if (
          !hasCanvasSceneIdentity(request) ||
          !hasNativeCanvasSceneSubscription(target, request) ||
          request.trigger !== "automatic_idle"
        ) {
          return canvasSceneUnauthorized(request.mutationId);
        }
        const eligibility = await commands.readCompaction(request);
        if (!eligibility.value.eligible) {
          return canvasSceneFailure(
            "future_base_head",
            "Canvas maintenance is below its internal threshold",
            { mutationId: request.mutationId, retryable: true },
          );
        }
        return await commands.compact(request, eligibility.value);
      },
      request.mutationId,
      canvasSceneSubscriptionKey(target, request),
    );

  const publishDocumentEffects = (
    packet: CoreAuthorizedDeliveryPacket,
    onlyDocumentId?: string,
  ): Effect.Effect<void> => {
    if (!accepting) return Effect.void;
    const identity = packet.manifest.identity;
    const effects = packet.atoms;
    const resourceDeliveries: Array<Effect.Effect<void>> = [];
    const invalidatedDocuments = new Set(
      effects
        .filter(
          (effect) =>
            effect.payload.module === "owned_document" &&
            effect.payload.event.kind === "document_invalidated",
        )
        .map((effect) =>
          effect.payload.module === "owned_document" ? effect.payload.event.document_id : null,
        )
        .filter((documentId): documentId is string => documentId !== null),
    );
    const resyncRequiredDocuments = new Set(
      effects
        .filter(
          (effect) =>
            effect.payload.module === "owned_document" &&
            effect.payload.event.kind === "document_resync_required",
        )
        .map((effect) =>
          effect.payload.module === "owned_document" ? effect.payload.event.document_id : null,
        )
        .filter((documentId): documentId is string => documentId !== null),
    );
    packet.document_effects.forEach((effect) => {
      const reference = effect.reference;
      if (onlyDocumentId && reference.document_id !== onlyDocumentId) return;
      if (
        invalidatedDocuments.has(reference.document_id) ||
        resyncRequiredDocuments.has(reference.document_id)
      )
        return;
      const scopes = new Map<
        string,
        {
          readonly scope: DesktopDocumentSyncScope;
          readonly recipients: Map<string, NativeSubscription>;
        }
      >();
      // Each active subscription was authorized by Core for this exact
      // Document. A root-stream packet may cover several subscription scopes,
      // so its packet scope is not the audience for each Document ref. Access
      // loss is carried separately by the scoped revocation lane below.
      for (const [key, subscription] of subscriptions) {
        if (
          subscription.engine === "yjs" &&
          subscription.documentId === reference.document_id &&
          !packetRevokesDocumentScope(packet, reference.document_id, subscription.scope)
        ) {
          const keyForScope = scopeKey(subscription.scope);
          const group = scopes.get(keyForScope) ?? {
            scope: subscription.scope,
            recipients: new Map(),
          };
          group.recipients.set(key, subscription);
          scopes.set(keyForScope, group);
        }
      }
      for (const [, { scope, recipients }] of scopes) {
        const deliverResolvedEvent = (event: OrderedDocumentRealtimeEvent): void => {
          for (const [key, subscription] of recipients) {
            if (subscriptions.get(key) !== subscription) continue;
            if (subscription.storeEpoch && subscription.storeEpoch !== identity.store_epoch) {
              closeSubscription(key);
              continue;
            }
            deliverDocumentRealtimeEvent(key, subscription.target, event, {
              revokeAfter: event.kind === "resync-required" && event.reason === "access-revoked",
            });
          }
        };
        const inline = resolveInlineAuthorizedDocumentEffect(effect, identity);
        if (inline) {
          deliverResolvedEvent(inline);
          continue;
        }
        resourceDeliveries.push(
          input.coreSession
            .use(
              "document.resolve-effect",
              (client) =>
                resolveAuthorizedDocumentEffect(
                  effect,
                  identity,
                  createCoreDocumentSyncAdapter(client).fetchUpdateResource,
                ),
              { projectId: projectIdFor(scope) },
            )
            .pipe(
              Effect.catch(() =>
                Effect.succeed({
                  kind: "resync-required" as const,
                  documentId: reference.document_id,
                  storeEpoch: identity.store_epoch,
                  generation: reference.generation,
                  headSeq: reference.base_head_seq,
                  commitSeq: identity.commit_seq,
                  effectSequence: reference.effect_order,
                  reason: "resource-integrity-failure" as const,
                }),
              ),
              Effect.tap((event) => Effect.sync(() => deliverResolvedEvent(event))),
              Effect.asVoid,
            ),
        );
      }
    });
    effects.forEach((effect) => {
      if (effect.payload.module !== "owned_document") return;
      const event = effect.payload.event;
      if (onlyDocumentId && event.document_id !== onlyDocumentId) return;
      for (const [key, subscription] of [...subscriptions]) {
        if (subscription.documentId !== event.document_id) continue;
        if (packetRevokesDocumentScope(packet, event.document_id, subscription.scope)) {
          continue;
        }
        if (subscription.storeEpoch && subscription.storeEpoch !== identity.store_epoch) {
          closeSubscription(key);
          continue;
        }
        if (subscription.engine === "yjs") {
          if (event.kind === "document_invalidated" || event.kind === "document_resync_required") {
            const compacted = event.kind === "document_resync_required";
            const delivered = deliverDocumentRealtimeEvent(
              key,
              subscription.target,
              {
                kind: "resync-required",
                documentId: event.document_id,
                storeEpoch: identity.store_epoch,
                generation: compacted ? event.generation : (subscription.generation ?? 1),
                headSeq: compacted ? event.head_seq : (subscription.headSeq ?? 0),
                commitSeq: identity.commit_seq,
                effectSequence: effect.descriptor.atom_order,
                reason: compacted
                  ? "history-compacted"
                  : event.reason === "access_changed"
                    ? "access-revoked"
                    : "identity-boundary-changed",
              },
              compacted ? {} : { revokeAfter: true },
            );
            void delivered;
          }
          continue;
        }
        if (subscription.engine !== "canvas_scene") {
          continue;
        }
        if (!subscription.libraryId) continue;
        if (event.kind === "canvas_generation_changed") {
          const delivered = deliverCanvasRealtimeEvent(key, subscription.target, {
            type: "canvas_scene_resync_required",
            libraryId: subscription.libraryId,
            accessContext: subscription.scope,
            documentId: event.document_id,
            storeEpoch: identity.store_epoch,
            generation: event.generation,
            headSeq: event.head_seq,
          });
          void delivered;
          continue;
        }
        if (
          event.kind !== "canvas_updated" ||
          typeof event.mutation !== "object" ||
          event.mutation === null ||
          !packet.manifest.operation_id
        ) {
          continue;
        }
        let realtimeEvent: CanvasSceneRealtimeEvent;
        try {
          realtimeEvent = decodeCanvasSceneSseEvent(
            JSON.stringify({
              type: "canvas_scene_committed",
              libraryId: subscription.libraryId,
              accessContext: subscription.scope,
              documentId: event.document_id,
              storeEpoch: identity.store_epoch,
              generation: event.generation,
              mutationId: packet.manifest.operation_id,
              baseHeadSeq: event.base_head_seq,
              headSeq: event.head_seq,
              sceneHash: event.scene_hash,
              ...(event.mutation as Readonly<Record<string, unknown>>),
            }),
          );
        } catch {
          continue;
        }
        const delivered = deliverCanvasRealtimeEvent(key, subscription.target, realtimeEvent);
        void delivered;
      }
    });
    return Effect.forEach(resourceDeliveries, (delivery) => delivery, {
      concurrency: "unbounded",
      discard: true,
    });
  };

  const publishResourceRevocation = (
    packet: CoreAuthorizedDeliveryPacket,
    revocation: ResourceRevocation,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      if (!accepting || revocation.resource_kind !== "document") return;
      if (revocation.authorization_scope.kind !== "document") return;
      const identity = packet.manifest.identity;
      for (const [key, subscription] of [...subscriptions]) {
        if (subscription.documentId !== revocation.resource_id) continue;
        if (
          !authorizationScopeMatchesDocumentScope(
            revocation.authorization_scope,
            subscription.scope,
          )
        )
          continue;
        if (subscription.engine !== "yjs") {
          closeSubscription(key);
          continue;
        }
        const delivered = deliverDocumentRealtimeEvent(
          key,
          subscription.target,
          {
            kind: "resync-required",
            documentId: revocation.resource_id,
            storeEpoch: identity.store_epoch,
            generation: subscription.generation ?? 1,
            headSeq: subscription.headSeq ?? 0,
            commitSeq: identity.commit_seq,
            effectSequence: packet.atoms.length,
            reason: "access-revoked",
          },
          { revokeAfter: true },
        );
        void delivered;
      }
    });

  const transferBlocks = (
    intent: BlockTransferIntent,
    editorHistoryOwnerId?: string,
  ): Effect.Effect<BlockTransferCommandResult> =>
    input.coreSession
      .use(
        "block-transfer.commit",
        (client) =>
          createCoreBlockTransferAdapter({
            client,
            libraryId: input.coreAuthority.identity.libraryId,
            projectId: intent.projectId,
            storeEpoch: input.coreAuthority.identity.storeEpoch,
            editorHistoryOwnerId,
          }).commit(intent),
        { projectId: intent.projectId },
      )
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            error: {
              code: "unknown" as const,
              message: documentSessionError(error).message,
              retryable: documentSessionError(error).retryable,
              reloadRequired: false,
              operationId: intent.operationId,
            },
          }),
        ),
      );

  const undoBlockTransfer = (
    intent: BlockTransferUndoIntent,
    editorHistoryOwnerId?: string,
  ): Effect.Effect<BlockTransferUndoCommandResult> =>
    input.coreSession
      .use(
        "block-transfer.undo",
        (client) =>
          createCoreBlockTransferAdapter({
            client,
            libraryId: input.coreAuthority.identity.libraryId,
            projectId: intent.projectId,
            storeEpoch: input.coreAuthority.identity.storeEpoch,
            editorHistoryOwnerId,
          }).undo(intent),
        { projectId: intent.projectId },
      )
      .pipe(
        Effect.catch((error) =>
          Effect.succeed({
            ok: false as const,
            error: {
              code: "unknown" as const,
              message: documentSessionError(error).message,
              retryable: documentSessionError(error).retryable,
              reloadRequired: false,
              operationId: intent.operationId,
            },
          }),
        ),
      );

  const service = {
    publishDocumentEffects,
    publishResourceRevocation,
    getOwnedDocumentDescriptor: (projectId, ownerBlockId) =>
      input.coreSession
        .use(
          "document.read-descriptor",
          (client) =>
            createCoreDocumentSyncAdapter(client).readDescriptor({
              ownerBlockId,
              clientSessionId: "electron:owned-document:descriptor",
            }),
          { projectId },
        )
        .pipe(
          Effect.map((descriptor) =>
            requireProjectAccessedDocumentDescriptor(descriptor, projectId),
          ),
          Effect.mapError((error) =>
            sessionError("document.read-descriptor", error.cause ?? error),
          ),
        ),
    prepareOwnedBlockDocument: (projectId, ownerBlockId) =>
      Effect.gen(function* () {
        const scope = { kind: "project", projectId } as const;
        const identity = ownerCommandIdentity(scope);
        const prepared = yield* input.coreSession.use(
          "document.prepare-owner",
          (client) =>
            createCoreDocumentSyncAdapter(client).prepareOwner({
              ownerBlockId,
              ...identity,
            }),
          { projectId },
        );
        if (!prepared.ok) return prepared;
        return {
          ok: true as const,
          value: requireProjectAccessedDocumentDescriptor(prepared.value, projectId),
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(documentFailure<ProjectAccessedDocumentDescriptor>(error)),
        ),
      ),
    prepareLibraryOwnedBlockDocument: (ownerBlockId) =>
      Effect.gen(function* () {
        const scope = { kind: "library" } as const;
        const identity = ownerCommandIdentity(scope);
        const prepared = yield* input.coreSession.use("document.prepare-library-owner", (client) =>
          createCoreDocumentSyncAdapter(client).prepareOwner({
            ownerBlockId,
            ...identity,
          }),
        );
        if (!prepared.ok) return prepared;
        return {
          ok: true as const,
          value: requireLibraryAccessedDocumentDescriptor(prepared.value),
        };
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(documentFailure<LibraryAccessedDocumentDescriptor>(error)),
        ),
      ),
    subscribe: (
      scope,
      target,
      request,
    ): Effect.Effect<DocumentSyncCommandResult<DocumentSyncSubscriptionAck>> =>
      Effect.gen(function* () {
        if (!accepting || target.isDestroyed()) {
          return documentSyncUnauthorized<DocumentSyncSubscriptionAck>();
        }
        const key = subscriptionKey(target, scope, request);
        const ownerKey = bindingKey(request);
        bindTargetLifecycle(target);
        const reservation = yield* reserveNativeSubscription(ownerKey, key, target);
        if (reservation.kind === "existing") {
          return { ok: true, value: { subscribed: true } };
        }
        if (reservation.kind === "target_destroyed") {
          return documentSyncUnauthorized<DocumentSyncSubscriptionAck>();
        }
        if (reservation.kind === "conflict") {
          return documentSyncUnauthorized<DocumentSyncSubscriptionAck>();
        }
        const { pending } = reservation;
        return yield* Effect.gen(function* () {
          let closeLease: (() => void) | null = null;
          return yield* Effect.gen(function* () {
            let admitted = false;
            let openingOverflowed = false;
            const openingEvents: DocumentSyncRealtimeEvent[] = [];
            const deliver = (event: DocumentSyncRealtimeEvent): void => {
              if (event.kind === "connection") {
                if (event.state === "disconnected") suspendSubscriptionBoundary(key);
                if (!safeSendToWebContents(target, DOCUMENT_SYNC_EVENT_CHANNEL, [event])) {
                  closeSubscription(key);
                }
                return;
              }
              if (event.kind !== "document-update" && event.kind !== "resync-required") {
                if (!safeSendToWebContents(target, DOCUMENT_SYNC_EVENT_CHANNEL, [event])) {
                  closeSubscription(key);
                }
                return;
              }
              deliverDocumentRealtimeEvent(key, target, event, {
                revokeAfter: event.kind === "resync-required" && event.reason === "access-revoked",
              });
            };
            const receive = (event: DocumentSyncRealtimeEvent): void => {
              if (!admitted) {
                if (openingEvents.length >= MAX_PENDING_REALTIME_EVENTS) {
                  openingOverflowed = true;
                  closeLease?.();
                  return;
                }
                openingEvents.push(event);
                return;
              }
              deliver(event);
            };
            const lease = yield* input.documentLive.subscribe({
              open: (onEvent, onRepair, onRealtime) =>
                openPhysicalDocumentSubscription(scope, request, onEvent, onRepair, onRealtime),
              onEvent: (envelope) =>
                input.coreSession
                  .use(
                    "document.live.resolve-event",
                    async (client) =>
                      await mapDocumentLiveEnvelope(
                        request,
                        envelope,
                        createCoreDocumentSyncAdapter(client).fetchUpdateResource,
                      ),
                    { projectId: projectIdFor(scope) },
                  )
                  .pipe(
                    Effect.tap((events) => Effect.sync(() => events.forEach(receive))),
                    Effect.asVoid,
                    Effect.mapError((cause) => documentLiveRuntimeError("delivery.event", cause)),
                    Effect.catch(() =>
                      Effect.sync(() => {
                        const identity = envelope.packet.manifest.identity;
                        receive({
                          kind: "resync-required",
                          documentId: request.documentId,
                          storeEpoch: identity.store_epoch,
                          generation: 1,
                          headSeq: 0,
                          commitSeq: identity.commit_seq,
                          reason: "resource-integrity-failure",
                        });
                      }),
                    ),
                  ),
              onRepair: (repair) =>
                Effect.sync(() => {
                  receive({
                    kind: "resync-required",
                    documentId: repair.document_id,
                    storeEpoch: repair.store_epoch,
                    generation: repair.document_generation,
                    headSeq: repair.head_seq,
                    commitSeq: repair.commit_head,
                    reason:
                      repair.reason === "identity_changed"
                        ? "identity-boundary-changed"
                        : repair.reason === "access_revoked"
                          ? "access-revoked"
                          : "event-gap",
                  });
                }),
              onRealtime: (event) => Effect.sync(() => receive(event)),
              onOpened: (barrier) => {
                if (
                  barrier.engine === "yjs" &&
                  barrier.document_id === request.documentId &&
                  barrier.store_epoch === input.coreAuthority.identity.storeEpoch
                )
                  return Effect.void;
                return Effect.fail(
                  documentLiveRuntimeError(
                    "document.subscribe.barrier",
                    new CoreEventCompatibilityError(
                      "Core Document live barrier does not match the Yjs session",
                    ),
                  ),
                );
              },
              onInterrupted: () => Effect.void,
              onConnectionStateChanged: (state) =>
                Effect.sync(() => {
                  receive({
                    kind: "connection",
                    documentId: request.documentId,
                    clientSessionId: request.clientSessionId,
                    state,
                  });
                }),
              shouldRetry: retryDocumentLive,
              maxInitialOpenAttempts: 3,
              retryDelay: 250,
              maxRetryDelay: 5_000,
            });
            closeLease = closeLiveLease(lease);
            pending.close = closeLease;
            if (pending.cancelled) closeLease();
            const barrier = yield* lease.ready;
            if (
              openingOverflowed ||
              barrier.engine !== "yjs" ||
              barrier.document_id !== request.documentId ||
              barrier.store_epoch !== input.coreAuthority.identity.storeEpoch
            ) {
              return yield* sessionError(
                "document.subscribe.barrier",
                new Error("Core Document live barrier does not match the Yjs session"),
              );
            }
            if (!accepting || target.isDestroyed()) {
              closeLease();
              if (bindings.get(ownerKey) === key) bindings.delete(ownerKey);
              return documentSyncUnauthorized<DocumentSyncSubscriptionAck>();
            }
            const subscribed = addNativeSubscription(key, {
              engine: "yjs",
              bindingKey: ownerKey,
              scope,
              documentId: request.documentId,
              clientSessionId: request.clientSessionId,
              target,
              targetId: target.id,
              close: closeLease,
              lease,
              pendingRealtimeEvents: new Map(),
            });
            admitted = true;
            openingEvents.forEach(deliver);
            background(
              lease.done.pipe(
                Effect.tapError((error) => reportDocumentTermination(key, error)),
                Effect.catch((error) =>
                  Effect.sync(() => {
                    if (subscriptions.get(key)?.lease !== lease) return;
                    receive({
                      kind: "terminated",
                      documentId: request.documentId,
                      clientSessionId: request.clientSessionId,
                      error: documentSessionError(error),
                    });
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (subscriptions.get(key)?.close === closeLease) {
                      closeSubscription(key);
                    }
                  }),
                ),
              ),
            );
            return subscribed;
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                closeLease?.();
                closeSubscription(key);
                if (bindings.get(ownerKey) === key) bindings.delete(ownerKey);
                return documentFailure<DocumentSyncSubscriptionAck>(error.cause);
              }),
            ),
          );
        }).pipe(
          Effect.ensuring(
            settlePendingSubscription(ownerKey, pending).pipe(
              Effect.tap(() => Effect.sync(() => releaseTargetListenerIfIdle(target.id))),
            ),
          ),
        );
      }),
    unsubscribe: (scope, target, request) =>
      Effect.sync(() => {
        const key = subscriptionKey(target, scope, request);
        if (subscriptions.get(key)?.target === target) closeSubscription(key);
        return { ok: true, value: { unsubscribed: true } };
      }),
    sync: (scope, target, request) =>
      Effect.gen(function* () {
        if (!hasNativeSubscription(target, scope, request)) {
          return documentSyncUnauthorized();
        }
        const key = subscriptionKey(target, scope, request);
        const subscription = subscriptions.get(key);
        suspendSubscriptionBoundary(key);
        const result = yield* withDocumentLease(
          key,
          input.coreModules.document.sync(request, projectIdFor(scope)),
          true,
        ).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed(documentFailure<DocumentSyncResponse>(error))),
        );
        if (!result.ok || subscriptions.get(key) !== subscription) return result;
        yield* reportDocumentRecovered(key);
        adoptSubscriptionBoundary(key, result.value);
        drainDocumentRealtimeEvents(key, target);
        return result;
      }),
    applyUpdate: (scope, target, request) =>
      Effect.gen(function* () {
        if (!hasNativeSubscription(target, scope, request)) {
          return documentSyncUnauthorized();
        }
        return yield* withDocumentLease(
          subscriptionKey(target, scope, request),
          input.coreModules.document.applyUpdate(request, projectIdFor(scope)),
        ).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed(documentFailure<DocumentSyncApplyAck>(error))),
        );
      }),
    publishAwareness: (scope, target, request) =>
      Effect.gen(function* () {
        if (!hasNativeSubscription(target, scope, request)) {
          return documentSyncUnauthorized();
        }
        return yield* withDocumentLease(
          subscriptionKey(target, scope, request),
          input.coreModules.document.publishAwareness(request, projectIdFor(scope)),
        ).pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) =>
            Effect.succeed(documentFailure<DocumentAwarenessPublishAck>(error)),
          ),
        );
      }),
    subscribeCanvasScene: (target, request): Effect.Effect<CanvasSceneSubscriptionCommandResult> =>
      Effect.gen(function* () {
        if (!accepting || target.isDestroyed() || !hasCanvasSceneIdentity(request)) {
          return canvasSceneUnauthorized();
        }
        const key = canvasSceneSubscriptionKey(target, request);
        const ownerKey = bindingKey(request);
        bindTargetLifecycle(target);
        const reservation = yield* reserveNativeSubscription(ownerKey, key, target);
        if (reservation.kind === "existing") {
          return { ok: true, value: { subscribed: true } };
        }
        if (reservation.kind === "target_destroyed") {
          return canvasSceneUnauthorized();
        }
        if (reservation.kind === "conflict") return canvasSceneUnauthorized();
        const { pending } = reservation;
        return yield* Effect.gen(function* () {
          let closeLease: (() => void) | null = null;
          return yield* Effect.gen(function* () {
            let admitted = false;
            let openingOverflowed = false;
            const openingEvents: CanvasSceneRealtimeEvent[] = [];
            const deliver = (event: CanvasSceneRealtimeEvent): void => {
              if (event.type === "canvas_scene_session") {
                if (event.state === "disconnected") suspendSubscriptionBoundary(key);
                if (!safeSendToWebContents(target, DOCUMENT_SYNC_EVENT_CHANNEL, [event]))
                  closeSubscription(key);
                return;
              }
              deliverCanvasRealtimeEvent(key, target, event);
            };
            const receive = (event: CanvasSceneRealtimeEvent): void => {
              if (!admitted) {
                if (openingEvents.length >= MAX_PENDING_REALTIME_EVENTS) {
                  openingOverflowed = true;
                  closeLease?.();
                  return;
                }
                openingEvents.push(event);
                return;
              }
              deliver(event);
            };
            const binding = {
              libraryId: input.coreAuthority.identity.libraryId,
              accessContext: request.accessContext,
            };
            const lease = yield* input.documentLive.subscribe({
              open: (onEvent, onRepair, onRealtime) =>
                openPhysicalDocumentSubscription(
                  request.accessContext,
                  request,
                  onEvent,
                  onRepair,
                  onRealtime,
                ),
              onEvent: (envelope) =>
                Effect.sync(() => {
                  const event = mapCanvasLiveEnvelope(binding, request, envelope);
                  if (event) receive(event);
                }),
              onRepair: (repair) =>
                Effect.sync(() => {
                  receive({
                    type: "canvas_scene_resync_required",
                    libraryId: binding.libraryId,
                    accessContext: binding.accessContext,
                    documentId: repair.document_id,
                    storeEpoch: repair.store_epoch,
                    generation: repair.document_generation,
                    headSeq: repair.head_seq,
                  });
                }),
              onRealtime: () => Effect.void,
              onOpened: (barrier, reconnected) => {
                if (
                  barrier.engine !== "canvas_scene" ||
                  barrier.document_id !== request.documentId ||
                  barrier.store_epoch !== input.coreAuthority.identity.storeEpoch
                ) {
                  return Effect.fail(
                    documentLiveRuntimeError(
                      "canvas.subscribe.barrier",
                      new CoreEventCompatibilityError(
                        "Core Document live barrier does not match the Canvas session",
                      ),
                    ),
                  );
                }
                return Effect.sync(() => {
                  if (!reconnected) return;
                  receive({
                    type: "canvas_scene_resync_required",
                    libraryId: binding.libraryId,
                    accessContext: binding.accessContext,
                    documentId: barrier.document_id,
                    storeEpoch: barrier.store_epoch,
                    generation: barrier.document_generation,
                    headSeq: barrier.head_seq,
                  });
                });
              },
              onInterrupted: () => Effect.void,
              onConnectionStateChanged: (state) =>
                Effect.sync(() =>
                  receive({
                    type: "canvas_scene_session",
                    ...binding,
                    documentId: request.documentId,
                    clientSessionId: request.clientSessionId,
                    state,
                  }),
                ),
              shouldRetry: retryDocumentLive,
              maxInitialOpenAttempts: 3,
              retryDelay: 250,
              maxRetryDelay: 5_000,
            });
            closeLease = closeLiveLease(lease);
            pending.close = closeLease;
            if (pending.cancelled) closeLease();
            const barrier = yield* lease.ready;
            if (
              openingOverflowed ||
              barrier.engine !== "canvas_scene" ||
              barrier.document_id !== request.documentId ||
              barrier.store_epoch !== input.coreAuthority.identity.storeEpoch
            ) {
              return yield* sessionError(
                "canvas.subscribe.barrier",
                new Error("Core Document live barrier does not match the Canvas session"),
              );
            }
            if (!accepting || target.isDestroyed()) {
              closeLease();
              if (bindings.get(ownerKey) === key) bindings.delete(ownerKey);
              return canvasSceneUnauthorized();
            }
            const subscribed = addNativeSubscription(key, {
              engine: "canvas_scene",
              bindingKey: ownerKey,
              scope: request.accessContext,
              libraryId: input.coreAuthority.identity.libraryId,
              documentId: request.documentId,
              clientSessionId: request.clientSessionId,
              target,
              targetId: target.id,
              close: closeLease,
              lease,
              pendingRealtimeEvents: new Map(),
            });
            admitted = true;
            openingEvents.forEach(deliver);
            canvasPresenceHub.register({
              key,
              libraryId: input.coreAuthority.identity.libraryId,
              accessContext: request.accessContext,
              documentId: request.documentId,
              clientSessionId: request.clientSessionId,
              targetId: target.id,
              send: (event) => {
                if (!safeSendToWebContents(target, DOCUMENT_SYNC_EVENT_CHANNEL, [event])) {
                  closeSubscription(key);
                }
              },
            });
            background(
              lease.done.pipe(
                Effect.tapError((error) => reportDocumentTermination(key, error)),
                Effect.catch((error) =>
                  Effect.sync(() => {
                    if (subscriptions.get(key)?.lease !== lease) return;
                    receive({
                      type: "canvas_scene_session",
                      ...binding,
                      documentId: request.documentId,
                      clientSessionId: request.clientSessionId,
                      state: "terminated",
                      error: mapCoreCanvasSceneFailure(error).error,
                    });
                  }),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    if (subscriptions.get(key)?.close === closeLease) {
                      closeSubscription(key);
                    }
                  }),
                ),
              ),
            );
            return subscribed;
          }).pipe(
            Effect.catch((error) =>
              Effect.sync(() => {
                closeLease?.();
                closeSubscription(key);
                if (bindings.get(ownerKey) === key) bindings.delete(ownerKey);
                return mapCoreCanvasSceneFailure(error.cause);
              }),
            ),
          );
        }).pipe(
          Effect.ensuring(
            settlePendingSubscription(ownerKey, pending).pipe(
              Effect.tap(() => Effect.sync(() => releaseTargetListenerIfIdle(target.id))),
            ),
          ),
        );
      }),
    unsubscribeCanvasScene: (target, request) =>
      Effect.sync(() => {
        if (!hasCanvasSceneIdentity(request)) return canvasSceneUnauthorized();
        const key = canvasSceneSubscriptionKey(target, request);
        if (subscriptions.get(key)?.target === target) closeSubscription(key);
        return { ok: true, value: { unsubscribed: true } };
      }),
    syncCanvasScene: (target, request) =>
      Effect.gen(function* () {
        if (!hasNativeCanvasSceneSubscription(target, request)) {
          return canvasSceneUnauthorized();
        }
        const key = canvasSceneSubscriptionKey(target, request);
        const subscription = subscriptions.get(key);
        suspendSubscriptionBoundary(key);
        const result = yield* runCanvasCommand(
          "canvas.sync",
          request.accessContext,
          (commands) => commands.sync(request),
          undefined,
          key,
          true,
        );
        if (result.ok && subscriptions.get(key) === subscription) {
          yield* reportDocumentRecovered(key);
          adoptSubscriptionBoundary(key, result.value);
          drainCanvasRealtimeEvents(key, target);
        }
        return result;
      }),
    applyCanvasSceneMutation: (target, request) =>
      runCanvasCommand(
        "canvas.apply-mutation",
        request.accessContext,
        async (commands) => {
          if (!hasNativeCanvasSceneSubscription(target, request)) {
            return canvasSceneUnauthorized(request.mutationId);
          }
          return await commands.applyMutation(request);
        },
        request.mutationId,
        canvasSceneSubscriptionKey(target, request),
      ),
    publishCanvasPresence: (target, request) =>
      Effect.sync(() => {
        let parsed: CanvasPresencePublishRequest;
        try {
          parsed = canonicalizeCanvasPresencePublishRequest(request);
        } catch (error) {
          return canvasPresenceFailure(
            "invalid_presence",
            error instanceof Error ? error.message : String(error),
          );
        }
        const subscriptionRequest: CanvasSceneSubscribeRequest = {
          accessContext: parsed.accessContext,
          documentId: parsed.publication.documentId,
          clientSessionId: parsed.clientSessionId,
        };
        const key = canvasSceneSubscriptionKey(target, subscriptionRequest);
        if (
          !hasNativeCanvasSceneSubscription(target, subscriptionRequest) ||
          subscriptions.get(key)?.generation === undefined
        ) {
          return canvasPresenceFailure(
            "unauthorized",
            "An exact active Canvas subscription is required for presence",
          );
        }
        try {
          return {
            ok: true,
            value: canvasPresenceHub.publish(key, parsed.publication),
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("generation boundary")) {
            return canvasPresenceFailure("generation_mismatch", message, {
              resetRequired: true,
            });
          }
          if (error instanceof TypeError) {
            return canvasPresenceFailure("invalid_presence", message);
          }
          return canvasPresenceFailure("unauthorized", message);
        }
      }),
    readCanvasSceneCompaction: (target, request) =>
      runCanvasCommand(
        "canvas.read-compaction",
        request.accessContext,
        async (commands) => {
          if (!hasNativeCanvasSceneSubscription(target, request)) {
            return canvasSceneUnauthorized();
          }
          return await commands.readCompaction(request);
        },
        undefined,
        canvasSceneSubscriptionKey(target, request),
      ),
    compactCanvasScene,
    applyAdditionalDocumentCommand: (request) =>
      input.coreSession
        .use(
          "document.apply-additional-command",
          (client) => createCoreDocumentSyncAdapter(client).applyAdditionalDocumentCommand(request),
          { projectId: request.projectId },
        )
        .pipe(
          Effect.mapError((error) =>
            sessionError("document.apply-additional-command", error.cause ?? error),
          ),
        ),
    createCheckpoint: (request) =>
      input.coreSession
        .use(
          "document.create-checkpoint",
          (client) => createCoreDocumentSyncAdapter(client).createCheckpoint(request),
          { projectId: request.projectId },
        )
        .pipe(
          Effect.mapError((error) =>
            sessionError("document.create-checkpoint", error.cause ?? error),
          ),
        ),
    listVersions: (request) =>
      input.coreSession
        .use(
          "document.list-versions",
          (client) => createCoreDocumentSyncAdapter(client).listVersions(request),
          { projectId: request.projectId },
        )
        .pipe(
          Effect.mapError((error) => sessionError("document.list-versions", error.cause ?? error)),
        ),
    getVersion: (request) =>
      input.coreSession
        .use(
          "document.get-version",
          (client) => createCoreDocumentSyncAdapter(client).getVersion(request),
          { projectId: request.projectId },
        )
        .pipe(
          Effect.mapError((error) => sessionError("document.get-version", error.cause ?? error)),
        ),
    applyDocumentMutation,
    transferBlocks,
    undoBlockTransfer,
    restoreVersion: applyDocumentMutation,
  } satisfies DesktopDocumentSessionService;
  const close = Effect.gen(function* () {
    accepting = false;
    const pending = [...pendingSubscriptions.entries()];
    for (const [, reservation] of pending) cancelPendingSubscription(reservation);
    for (const key of [...subscriptions.keys()]) closeSubscription(key);
    for (const listener of targetListeners.values()) {
      listener.target.removeListener("destroyed", listener.onDestroyed);
    }
    targetListeners.clear();
    bindings.clear();
    pendingSubscriptions.clear();
    deliveredCommitKeys.clear();
    yield* Effect.forEach(pending, ([, reservation]) =>
      Deferred.succeed(reservation.settled, undefined),
    );
  });

  return {
    close,
    service: DesktopDocumentSessionRuntime.of(service),
  };
};

export const makeDesktopDocumentSessionRuntime = (
  input: DesktopDocumentSessionRuntimeOptions = {},
): Effect.Effect<
  DesktopDocumentSessionService,
  never,
  Scope.Scope | CoreAuthority | CoreSessionAccess | CoreModules | DocumentLiveRuntime
> =>
  Effect.gen(function* () {
    const coreAuthority = yield* CoreAuthority;
    const coreSession = yield* CoreSessionAccess;
    const coreModules = yield* CoreModules;
    const documentLive = yield* DocumentLiveRuntime;
    const background = yield* FiberSet.makeRuntime<never, void, never>();
    const state = makeDesktopDocumentSessionState(
      { ...input, coreAuthority, coreSession, coreModules, documentLive },
      background,
    );
    yield* Effect.addFinalizer(() => state.close);
    return state.service;
  });

export const desktopDocumentSessionRuntimeLive = (
  options: DesktopDocumentSessionRuntimeOptions = {},
): Layer.Layer<
  DesktopDocumentSessionRuntime,
  never,
  CoreAuthority | CoreSessionAccess | CoreModules | DocumentLiveRuntime
> => Layer.effect(DesktopDocumentSessionRuntime, makeDesktopDocumentSessionRuntime(options));
