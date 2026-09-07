import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { CoreHandshakeResponse } from "../core-client/types";
import { MainShutdown } from "../app/MainShutdown";
import {
  classifyCoreOperationFailure,
  coreRuntimeError,
  isRecoverableCoreTransportFailure,
  type CoreRuntimeError,
} from "./CoreRuntimeError";
import { CoreTransport, type CoreTransportSession } from "./CoreTransport";

export interface CoreAuthorityIdentity {
  readonly profileId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
}

export type CoreAuthorityState =
  | { readonly kind: "ready"; readonly generation: string }
  | { readonly kind: "recovering"; readonly attempt: number; readonly previousGeneration: string }
  | { readonly kind: "unavailable"; readonly error: CoreRuntimeError }
  | { readonly kind: "stopped" };

export interface CoreSessionOperationOptions {
  readonly projectId?: string | null;
  readonly replayAfterRecovery?: boolean;
}

export type CoreSessionOperation<A> = (
  client: CoreTransportSession["client"],
  signal: AbortSignal,
) => Promise<A>;

export class CoreSessionAccess extends Context.Service<
  CoreSessionAccess,
  {
    readonly use: <A>(
      operation: string,
      run: CoreSessionOperation<A>,
      options?: CoreSessionOperationOptions,
    ) => Effect.Effect<A, CoreRuntimeError>;
    readonly handshake: Effect.Effect<CoreHandshakeResponse, CoreRuntimeError>;
  }
>()("nodex/main/core-runtime/CoreSessionAccess") {}

export class CoreAuthority extends Context.Service<
  CoreAuthority,
  {
    readonly identity: CoreAuthorityIdentity;
    readonly initialLaunch: CoreTransportSession["launch"];
    readonly state: SubscriptionRef.SubscriptionRef<CoreAuthorityState>;
    readonly retry: Effect.Effect<void, CoreRuntimeError>;
    readonly requestRelaunch: Effect.Effect<void>;
    /** Permanently fences Core mutations after canonical application truth is lost. */
    readonly failApplication: (error: CoreRuntimeError) => Effect.Effect<boolean>;
  }
>()("nodex/main/core-runtime/CoreAuthority") {}

export interface CoreAuthorityOptions {
  readonly retryBase?: Duration.Input;
  readonly retryCap?: Duration.Input;
  readonly maximumRecoveryAttempts?: number;
  readonly jitter?: boolean;
}

interface AuthoritySession extends CoreTransportSession {
  readonly generation: string;
}

const identityOf = (session: CoreTransportSession): CoreAuthorityIdentity => ({
  profileId: session.client.handshake.generation.profile_id,
  libraryId: session.client.handshake.library_id,
  storeEpoch: session.client.handshake.store_epoch,
});

const generationOf = (session: CoreTransportSession): string =>
  session.client.handshake.generation.start_nonce;

const sameIdentity = (left: CoreAuthorityIdentity, right: CoreAuthorityIdentity): boolean =>
  left.profileId === right.profileId &&
  left.libraryId === right.libraryId &&
  left.storeEpoch === right.storeEpoch;

const asAuthoritySession = (session: CoreTransportSession): AuthoritySession => ({
  ...session,
  generation: generationOf(session),
});

const recoverySchedule = (options: CoreAuthorityOptions) => {
  const capped = Schedule.min([
    Schedule.exponential(options.retryBase ?? "250 millis"),
    Schedule.spaced(options.retryCap ?? "5 seconds"),
  ]).pipe(Schedule.upTo({ times: Math.max(0, (options.maximumRecoveryAttempts ?? 3) - 1) }));
  return options.jitter === false ? capped : capped.pipe(Schedule.jittered);
};

export const live = (
  options: CoreAuthorityOptions = {},
): Layer.Layer<CoreAuthority | CoreSessionAccess, CoreRuntimeError, CoreTransport | MainShutdown> =>
  Layer.effectContext(
    Effect.gen(function* () {
      const transport = yield* CoreTransport;
      const shutdown = yield* MainShutdown;
      const initial = asAuthoritySession(yield* transport.launch);
      const identity = identityOf(initial);
      const session = yield* Ref.make(initial);
      const state = yield* SubscriptionRef.make<CoreAuthorityState>({
        kind: "ready",
        generation: initial.generation,
      });
      const recoveryLock = yield* Semaphore.make(1);
      const recoveryAttempt = yield* Ref.make(0);
      const closed = yield* Ref.make(false);
      const fatalFailure = yield* Ref.make<CoreRuntimeError | null>(null);
      const activeRecovery = yield* Ref.make<
        Deferred.Deferred<AuthoritySession, CoreRuntimeError> | undefined
      >(undefined);
      const recoveryRuntime = yield* FiberSet.makeRuntime<never, void, never>();

      const requestRelaunch = shutdown
        .request({ _tag: "AuthorityDriftRelaunch" })
        .pipe(Effect.asVoid);

      const assertOpen = Effect.fn("CoreAuthority.assertOpen")(function* () {
        if (!(yield* Ref.get(closed))) return;
        const fatal = yield* Ref.get(fatalFailure);
        if (fatal) return yield* fatal;
        return yield* coreRuntimeError({
          operation: "authority",
          reason: "closed",
          retryable: false,
        });
      });

      const launchReplacement = Effect.fn("CoreAuthority.launchReplacement")(function* (
        previous: AuthoritySession,
      ) {
        const attempt = yield* Ref.updateAndGet(recoveryAttempt, (value) => value + 1);
        yield* SubscriptionRef.set(state, {
          kind: "recovering",
          attempt,
          previousGeneration: previous.generation,
        });
        const replacement = asAuthoritySession(yield* transport.launch);
        const replacementIdentity = identityOf(replacement);
        if (sameIdentity(identity, replacementIdentity)) return replacement;

        yield* requestRelaunch;
        return yield* coreRuntimeError({
          operation: "authority.recover",
          reason: "authority-drift",
          retryable: false,
          generation: replacement.generation,
        });
      });

      const runRecovery = Effect.fn("CoreAuthority.runRecovery")(function* (
        failed: AuthoritySession,
        force: boolean,
      ) {
        const gate = yield* recoveryLock.withPermit(
          Effect.gen(function* () {
            yield* assertOpen();
            const current = yield* Ref.get(session);
            if (!force && current !== failed) {
              const completed = yield* Deferred.make<AuthoritySession, CoreRuntimeError>();
              yield* Deferred.succeed(completed, current);
              return completed;
            }
            const currentState = yield* SubscriptionRef.get(state);
            if (!force && currentState.kind === "unavailable") {
              return yield* currentState.error;
            }
            const existing = yield* Ref.get(activeRecovery);
            if (existing !== undefined) return existing;

            const pending = yield* Deferred.make<AuthoritySession, CoreRuntimeError>();
            yield* Ref.set(activeRecovery, pending);
            const recovery = Ref.set(recoveryAttempt, 0).pipe(
              Effect.andThen(
                launchReplacement(current).pipe(
                  Effect.retry(
                    recoverySchedule(options).pipe(
                      Schedule.setInputType<CoreRuntimeError>(),
                      Schedule.while(({ input }) => input.retryable),
                    ),
                  ),
                  Effect.tapError((error) =>
                    SubscriptionRef.set(state, { kind: "unavailable", error }),
                  ),
                ),
              ),
              Effect.tap((replacement) =>
                Ref.set(session, replacement).pipe(
                  Effect.andThen(
                    SubscriptionRef.set(state, {
                      kind: "ready",
                      generation: replacement.generation,
                    }),
                  ),
                ),
              ),
              Deferred.into(pending),
              Effect.ensuring(
                Ref.update(activeRecovery, (active) => (active === pending ? undefined : active)),
              ),
              Effect.asVoid,
            );
            void recoveryRuntime(recovery);
            return pending;
          }),
        );
        return yield* Deferred.await(gate);
      });

      const use = Effect.fn("CoreAuthority.use")(function* <A>(
        operation: string,
        run: CoreSessionOperation<A>,
        operationOptions: CoreSessionOperationOptions = {},
      ) {
        yield* assertOpen();
        const selected = yield* Ref.get(session);
        const invoke = (target: AuthoritySession) =>
          Effect.tryPromise({
            try: (signal) => {
              const client = operationOptions.projectId
                ? target.client.forProject(operationOptions.projectId)
                : target.client;
              return run(client, signal);
            },
            catch: (cause) => classifyCoreOperationFailure(operation, cause, target.generation),
          });
        const first = yield* Effect.result(invoke(selected));
        if (Result.isSuccess(first)) return first.success;
        const failure = first.failure;
        if (!isRecoverableCoreTransportFailure(failure.cause)) return yield* failure;
        const replacement = yield* runRecovery(selected, false);
        if (operationOptions.replayAfterRecovery === false) return yield* failure;
        return yield* invoke(replacement);
      });

      const retry = runRecovery(initial, true).pipe(Effect.asVoid);
      const failApplication = Effect.fn("CoreAuthority.failApplication")(
        (error: CoreRuntimeError) =>
          Ref.modify(closed, (current) => [!current, true] as const).pipe(
            Effect.flatMap((claimed) => {
              if (!claimed) return Effect.succeed(false);
              return Ref.set(fatalFailure, error).pipe(
                Effect.andThen(SubscriptionRef.set(state, { kind: "unavailable", error })),
                Effect.andThen(
                  shutdown.request({ _tag: "RuntimeFatal", subsystem: "core", cause: error }),
                ),
                Effect.as(true),
              );
            }),
          ),
      );
      const handshake = Effect.gen(function* () {
        yield* assertOpen();
        return (yield* Ref.get(session)).client.handshake;
      });

      yield* Effect.addFinalizer(() =>
        Ref.set(closed, true).pipe(
          Effect.andThen(SubscriptionRef.set(state, { kind: "stopped" })),
          Effect.andThen(Ref.get(session)),
          Effect.flatMap((current) => current.release),
          Effect.orDie,
        ),
      );

      return Context.make(
        CoreAuthority,
        CoreAuthority.of({
          identity,
          initialLaunch: initial.launch,
          state,
          retry,
          requestRelaunch,
          failApplication,
        }),
      ).pipe(Context.add(CoreSessionAccess, CoreSessionAccess.of({ use, handshake })));
    }),
  );
