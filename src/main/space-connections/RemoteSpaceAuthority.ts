import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { SpaceAvailability } from "../../shared/space-connection";
import { CoreClient, CoreModuleResponseError } from "../core-client/core-client";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import {
  CoreEventCompatibilityError,
  CoreHttpError,
  CoreTransportError,
  isDefinitiveCoreGenerationLoss,
} from "../core-client/local-http";
import { requiresCoreSessionRenewal } from "../core-client/core-response-error";
import { RemoteAccessWithdrawnError, RemoteCertificateError } from "../core-client/remote-http";
import {
  CoreAuthority,
  CoreSessionAccess,
  type CoreAuthorityState,
  type CoreSessionOperation,
  type CoreSessionOperationOptions,
} from "../core-runtime/CoreAuthority";
import {
  classifyCoreOperationFailure,
  coreRuntimeError,
  type CoreRuntimeError,
} from "../core-runtime/CoreRuntimeError";
import type { SpaceCredential } from "./SpaceConnectionStorage";

export const remoteFailureAvailability = (error: unknown): SpaceAvailability => {
  if (error instanceof RemoteAccessWithdrawnError) return "access-revoked";
  if (error instanceof RemoteCertificateError || error instanceof CoreEventCompatibilityError)
    return "unavailable";
  if (error instanceof CoreTransportError) {
    if (error.cause instanceof RemoteCertificateError) return "unavailable";
    return "reconnecting";
  }
  if (error instanceof CoreHttpError && error.status >= 500) return "reconnecting";
  return "unavailable";
};

const remoteFailure = (
  operation: string,
  cause: unknown,
  generation?: string,
): CoreRuntimeError => {
  if (remoteFailureAvailability(cause) === "reconnecting")
    return coreRuntimeError({
      operation,
      cause,
      generation,
      reason: "transport-loss",
      retryable: true,
    });
  return classifyCoreOperationFailure(operation, cause, generation);
};

/** A remote authority owns connections only. It has no process, shutdown, PID or relaunch capability. */
export const live = (input: {
  readonly credential: SpaceCredential;
  readonly buildId: string;
  readonly observe: (availability: SpaceAvailability, name?: string) => Effect.Effect<void>;
  readonly connect?: (signal: AbortSignal) => Promise<CoreGenerationClient>;
}): Layer.Layer<CoreAuthority | CoreSessionAccess, CoreRuntimeError> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const connect = Effect.tryPromise({
        try:
          input.connect ??
          ((signal) =>
            CoreClient.connectRemote({ ...input.credential, buildId: input.buildId, signal })),
        catch: (cause) => remoteFailure("remote.connect", cause),
      });
      const initial = yield* connect;
      const identity = {
        profileId: initial.handshake.generation.profile_id,
        libraryId: initial.handshake.library_id,
        storeEpoch: initial.handshake.store_epoch,
      };
      if (identity.libraryId !== input.credential.spaceId)
        return yield* coreRuntimeError({
          operation: "remote.identity",
          reason: "authority-drift",
          retryable: false,
        });
      const current = yield* Ref.make(initial);
      const state = yield* SubscriptionRef.make<CoreAuthorityState>({
        kind: "ready",
        generation: initial.handshake.generation.start_nonce,
      });
      const terminal = yield* Ref.make<CoreRuntimeError | null>(null);
      const lock = yield* Semaphore.make(1);
      const fail = Effect.fn("RemoteSpaceAuthority.fail")(function* (error: CoreRuntimeError) {
        // A failed operation (including stream admission) cannot withdraw saved credentials.
        if (
          (error.cause instanceof CoreHttpError ||
            error.cause instanceof CoreModuleResponseError) &&
          !(error.cause instanceof RemoteAccessWithdrawnError)
        )
          return false;
        const accepted = yield* Ref.modify(terminal, (previous) =>
          previous ? [false, previous] : [true, error],
        );
        if (!accepted) return true;
        yield* SubscriptionRef.set(state, { kind: "unavailable", error });
        yield* input.observe(remoteFailureAvailability(error.cause));
        return true;
      });
      const reconnect = Effect.fn("RemoteSpaceAuthority.reconnect")(function* (
        failed: CoreGenerationClient | null,
      ) {
        const stopped = yield* Ref.get(terminal);
        if (stopped) return yield* stopped;
        const previous = yield* Ref.get(current);
        if (failed && previous !== failed) return previous;
        yield* input.observe("reconnecting");
        yield* SubscriptionRef.set(state, {
          kind: "recovering",
          attempt: 1,
          previousGeneration: previous.handshake.generation.start_nonce,
        });
        const replacement = yield* connect.pipe(
          Effect.tapError((error) => (error.retryable ? Effect.void : fail(error))),
        );
        const stoppedAfterConnect = yield* Ref.get(terminal);
        if (stoppedAfterConnect) return yield* stoppedAfterConnect;
        if (
          replacement.handshake.library_id !== identity.libraryId ||
          replacement.handshake.store_epoch !== identity.storeEpoch ||
          replacement.handshake.generation.profile_id !== identity.profileId
        ) {
          const error = coreRuntimeError({
            operation: "remote.reconnect",
            reason: "authority-drift",
            retryable: false,
          });
          yield* fail(error);
          return yield* error;
        }
        yield* Ref.set(current, replacement);
        yield* SubscriptionRef.set(state, {
          kind: "ready",
          generation: replacement.handshake.generation.start_nonce,
        });
        yield* input.observe("ready", replacement.spaceName);
        return replacement;
      }, lock.withPermits(1));
      const use = Effect.fn("RemoteSpaceAuthority.use")(function* <A>(
        operation: string,
        run: CoreSessionOperation<A>,
        options: CoreSessionOperationOptions = {},
      ) {
        const stopped = yield* Ref.get(terminal);
        if (stopped) return yield* stopped;
        const selected = yield* Ref.get(current);
        const invoke = (client: CoreGenerationClient) =>
          Effect.tryPromise({
            try: (signal) =>
              run(options.projectId ? client.forProject(options.projectId) : client, signal),
            catch: (cause) =>
              remoteFailure(operation, cause, client.handshake.generation.start_nonce),
          }).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                if ((yield* Ref.get(current)) !== client || (yield* Ref.get(terminal))) return;
                if ((yield* SubscriptionRef.get(state)).kind !== "recovering") return;
                yield* SubscriptionRef.set(state, {
                  kind: "ready",
                  generation: client.handshake.generation.start_nonce,
                });
                yield* input.observe("ready", client.spaceName);
              }),
            ),
            Effect.tapError((error) =>
              remoteFailureAvailability(error.cause) === "access-revoked"
                ? fail(error)
                : Effect.void,
            ),
          );
        return yield* invoke(selected).pipe(
          Effect.catch((error) => {
            // Cancellation, timeouts and capacity refusals do not replace a session.
            // A restarted Core has no record of the old handshake, even when the device
            // remains active. Reauthenticate once; a revoked device fails that boundary.
            if (
              !isDefinitiveCoreGenerationLoss(error.cause) &&
              !requiresCoreSessionRenewal(error.cause)
            )
              return Effect.fail(error);
            return reconnect(selected).pipe(
              Effect.flatMap((replacement) =>
                options.replayAfterRecovery === false ? Effect.fail(error) : invoke(replacement),
              ),
            );
          }),
        );
      });
      yield* input.observe("ready", initial.spaceName);
      yield* Effect.addFinalizer(() =>
        Ref.set(
          terminal,
          coreRuntimeError({ operation: "remote.closed", reason: "closed", retryable: false }),
        ).pipe(Effect.andThen(SubscriptionRef.set(state, { kind: "stopped" }))),
      );
      return Context.make(
        CoreSessionAccess,
        CoreSessionAccess.of({
          use,
          handshake: Ref.get(current).pipe(Effect.map((client) => client.handshake)),
        }),
      ).pipe(
        Context.add(
          CoreAuthority,
          CoreAuthority.of({
            identity,
            initialLaunch: null,
            state,
            retry: reconnect(null).pipe(Effect.asVoid),
            requestRelaunch: Effect.void,
            failApplication: fail,
          }),
        ),
      );
    }),
  );
