import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { WebContents } from "electron";
import type { DeliveryAddress, RecipientAdmissionResult } from "../../shared/recipient-delivery";
import { projectionScopeDeliveryAddress } from "../../shared/recipient-delivery";
import type { CoreEventEnvelope } from "../core-client";
import { DesktopDocumentSessionRuntime } from "../core-client";
import { safeSendToWebContents } from "../ipc-safe-send";
import { getLogger } from "../logging/logger";
import { CoreApplicationProjectionRuntime } from "./CoreApplicationProjectionRuntime";
import { CoreAuthority, CoreSessionAccess } from "./CoreAuthority";
import { CoreEventDelivery } from "./CoreEventHub";
import { coreRuntimeError, type CoreRuntimeError } from "./CoreRuntimeError";
import { make as makeLocalCommitRuntime } from "./LocalCommitRuntime";
import {
  make as makeProjectionAudienceRuntime,
  ProjectionAudienceRuntimeError,
  type ProjectionAudienceSubscription,
} from "./ProjectionAudienceRuntime";
import {
  make as makeProjectionLiveRuntime,
  ProjectionLiveRuntimeError,
} from "./ProjectionLiveRuntime";

export class ProjectionDeliveryRuntime extends Context.Service<
  ProjectionDeliveryRuntime,
  {
    readonly admitRecipientResult: (
      senderId: number,
      result: RecipientAdmissionResult,
    ) => Effect.Effect<boolean>;
    readonly releaseSender: (senderId: number) => Effect.Effect<void>;
    readonly resetStream: (
      reason: "event_gap" | "reconnect" | "store_epoch_changed",
    ) => Effect.Effect<void>;
    readonly subscribe: (
      sender: WebContents,
      address: DeliveryAddress,
    ) => Effect.Effect<ProjectionAudienceSubscription, ProjectionAudienceRuntimeError>;
  }
>()("nodex/main/core-runtime/ProjectionDeliveryRuntime") {}

/**
 * Owns causal tail delivery, scoped Projection subscriptions, renderer audience
 * leases, and application projection as one process-scoped delivery Module.
 */
export const live: Layer.Layer<
  CoreEventDelivery | ProjectionDeliveryRuntime,
  CoreRuntimeError,
  | CoreApplicationProjectionRuntime
  | CoreAuthority
  | CoreSessionAccess
  | DesktopDocumentSessionRuntime
> = Layer.effectContext(
  Effect.gen(function* () {
    const applicationProjection = yield* CoreApplicationProjectionRuntime;
    const authority = yield* CoreAuthority;
    const access = yield* CoreSessionAccess;
    const documentSessions = yield* DesktopDocumentSessionRuntime;
    const handshake = yield* access.handshake;
    const logger = getLogger({ component: "projection-delivery-runtime" });
    const coreIdentity = authority.identity;
    const audience = yield* makeProjectionAudienceRuntime({
      libraryId: coreIdentity.libraryId,
      send: (sender, channel, envelope) => safeSendToWebContents(sender, channel, [envelope]),
    });

    const localCommits = yield* makeLocalCommitRuntime({
      expectedLibraryId: coreIdentity.libraryId,
      expectedStoreEpoch: coreIdentity.storeEpoch,
      onDocument: (packet, documentId) =>
        documentSessions.publishDocumentEffects(packet, documentId),
      onProjection: () => Effect.void,
      onNotification: (packet, atom) =>
        applicationProjection.publish(
          {
            transport_version: handshake.selected_transport_version,
            packet,
          },
          atom,
          coreIdentity.libraryId,
        ),
      onError: (failure) =>
        Effect.sync(() =>
          logger.error("LocalCommit delivery lane failed", {
            lane: failure.lane,
            laneKey: failure.laneKey,
            commitSeq: failure.packet.manifest.identity.commit_seq,
            storeEpoch: failure.packet.manifest.identity.store_epoch,
            error: failure.error instanceof Error ? failure.error.message : String(failure.error),
          }),
        ).pipe(
          Effect.andThen(
            failure.lane !== "projection"
              ? Effect.void
              : audience.reset(
                  {
                    storeEpoch: failure.packet.manifest.identity.store_epoch,
                    commitSeq: failure.packet.manifest.identity.commit_seq,
                  },
                  "integrity_failure",
                  [failure.packet.delivery_address],
                ),
          ),
        ),
    });

    const projectionLive = yield* makeProjectionLiveRuntime({
      open: (scopes, onEvent, onRepair) =>
        access
          .use("projection.events.open", (client, signal) =>
            client.openProjectionEventStream(scopes, onEvent, onRepair, signal),
          )
          .pipe(
            Effect.mapError(
              (cause) => new ProjectionLiveRuntimeError({ operation: "stream.open", cause }),
            ),
            Effect.map((subscription) => ({
              barrier: subscription.barrier,
              close: Effect.sync(() => subscription.close()),
              done: Effect.tryPromise({
                try: () => subscription.done,
                catch: (cause) =>
                  new ProjectionLiveRuntimeError({ operation: "stream.done", cause }),
              }),
            })),
          ),
      onPacket: (envelope) =>
        localCommits.admit(envelope.packet, "projection_live").pipe(
          Effect.mapError(
            (cause) => new ProjectionLiveRuntimeError({ operation: "stream.deliver", cause }),
          ),
          Effect.andThen(audience.publish(envelope.packet)),
          Effect.asVoid,
        ),
      onBarrier: (barrier, scopes, resetScopes) =>
        audience
          .installLeases(
            barrier.recipient_leases,
            {
              storeEpoch: barrier.store_epoch,
              commitSeq: barrier.commit_head,
            },
            (barrier.store_epoch !== coreIdentity.storeEpoch ? scopes : resetScopes).map(
              projectionScopeDeliveryAddress,
            ),
            barrier.store_epoch !== coreIdentity.storeEpoch
              ? "store_epoch_replacement"
              : "stream_gap",
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProjectionLiveRuntimeError({
                  operation: "stream.install-barrier",
                  cause,
                }),
            ),
          ),
      onRepair: (repair) =>
        audience.reset(
          {
            storeEpoch: repair.store_epoch,
            commitSeq: repair.commit_head,
          },
          repair.reason === "identity_changed" ? "store_epoch_replacement" : "stream_gap",
        ),
    });
    yield* Effect.forkScoped(
      audience.scopes.pipe(
        Stream.runForEach((scopes) => projectionLive.setScopes(scopes)),
        Effect.catch((error) =>
          Effect.logWarning("Could not update Projection live scopes").pipe(
            Effect.annotateLogs({
              operation: error.operation,
              error: error.cause instanceof Error ? error.cause.message : String(error.cause),
            }),
          ),
        ),
      ),
    );

    const resetStream = localCommits.resetStream;
    const runtime = ProjectionDeliveryRuntime.of({
      admitRecipientResult: audience.admit,
      releaseSender: audience.releaseSender,
      resetStream,
      subscribe: audience.subscribe,
    });
    const delivery = CoreEventDelivery.of({
      event: (envelope: CoreEventEnvelope) =>
        localCommits.admitAndWait(envelope.packet, "tailer").pipe(
          Effect.mapError((cause) =>
            coreRuntimeError({
              operation: "events.deliver",
              reason: "delivery",
              retryable: false,
              cause,
            }),
          ),
          Effect.asVoid,
        ),
      checkpoint: (checkpoint) =>
        localCommits.observeCheckpoint(checkpoint).pipe(
          Effect.mapError((cause) =>
            coreRuntimeError({
              operation: "events.checkpoint",
              reason: "delivery",
              retryable: false,
              cause,
            }),
          ),
        ),
      resync: (boundary) =>
        resetStream("event_gap").pipe(
          Effect.andThen(
            applicationProjection.publishResync({
              commitSeq: boundary.commit_head,
              libraryId: coreIdentity.libraryId,
              storeEpoch: coreIdentity.storeEpoch,
            }),
          ),
        ),
    });

    return Context.make(ProjectionDeliveryRuntime, runtime).pipe(
      Context.add(CoreEventDelivery, delivery),
    );
  }),
);
