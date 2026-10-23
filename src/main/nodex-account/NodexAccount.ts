import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { NodexAccountSnapshot } from "../../shared/nodex-account";
import {
  NodexAccountPlatform,
  NodexAccountPlatformError,
  type NodexAccountCredentialLease,
  type NodexAccountCredentials,
} from "../platform/NodexAccountPlatform";

export class NodexAccount extends Context.Service<
  NodexAccount,
  {
    readonly read: Effect.Effect<NodexAccountSnapshot>;
    readonly signIn: Effect.Effect<NodexAccountSnapshot>;
    readonly cancelSignIn: Effect.Effect<NodexAccountSnapshot>;
    readonly signOut: Effect.Effect<NodexAccountSnapshot>;
    readonly refresh: Effect.Effect<NodexAccountSnapshot>;
    readonly changes: Stream.Stream<NodexAccountSnapshot>;
  }
>()("nodex/main/nodex-account/NodexAccount") {}

/** One Profile owns token refresh and generation fencing for all its windows. */
export const make = Effect.gen(function* () {
  const platform = yield* NodexAccountPlatform;
  const snapshot = yield* SubscriptionRef.make<NodexAccountSnapshot>({
    revision: 0,
    configured: platform.configured,
    status: "signed-out",
    account: null,
    connection: "unavailable",
    persistence: null,
    error: platform.configurationError ? "configuration" : null,
  });
  const generation = yield* Ref.make(0);
  const credentials = yield* Ref.make<NodexAccountCredentials | null>(null);
  const mutation = yield* Semaphore.make(1);
  const refreshLane = yield* Semaphore.make(1);
  const loginTask = yield* FiberHandle.make<void>();
  const revokeTasks = yield* FiberSet.make<void>();
  const current = SubscriptionRef.get(snapshot);
  const publish = (patch: Partial<Omit<NodexAccountSnapshot, "revision">>) =>
    SubscriptionRef.updateAndGet(snapshot, (value) => ({
      ...value,
      ...patch,
      revision: value.revision + 1,
    }));
  const failure = (captured: number, error: NodexAccountPlatformError) =>
    mutation.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(generation)) !== captured) return;
        const invalid = error.code === "invalid-grant" || error.code === "identity-changed";
        if (invalid) {
          yield* Ref.set(credentials, null);
          yield* platform.clear.pipe(Effect.ignore);
        }
        const state = yield* current;
        yield* publish({
          status: invalid
            ? "reauthentication-required"
            : state.status === "signing-in"
              ? "signed-out"
              : state.status,
          connection: "unavailable",
          error: error.code,
        });
      }),
    );
  const adopt = (captured: number, lease: NodexAccountCredentialLease, verified = true) =>
    mutation.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(generation)) !== captured) return;
        const next = lease.credentials;
        const persistence = yield* platform.save(next);
        yield* Ref.set(credentials, next);
        yield* lease.retain;
        yield* publish({
          status: "signed-in",
          account: next.identity,
          connection: verified ? "available" : "unavailable",
          persistence,
          error: verified ? null : "network",
        });
      }).pipe(Effect.uninterruptible),
    );
  const refresh = refreshLane.withPermits(1)(
    Effect.gen(function* () {
      const captured = yield* Ref.get(generation);
      const previous = yield* Ref.get(credentials);
      if (!previous) return yield* current;
      yield* platform.refresh(previous).pipe(
        Effect.flatMap((next) => adopt(captured, next, next.verified)),
        Effect.scoped,
        Effect.catch((error) => failure(captured, error)),
      );
      return yield* current;
    }),
  );

  if (platform.configured) {
    yield* platform.load.pipe(
      Effect.flatMap((saved) =>
        saved
          ? Ref.set(credentials, saved).pipe(
              Effect.andThen(
                publish({ status: "signed-in", account: saved.identity, persistence: "secure" }),
              ),
            )
          : Effect.void,
      ),
      Effect.catch((error) => publish({ error: error.code })),
    );
    if (yield* Ref.get(credentials)) yield* refresh.pipe(Effect.forkScoped);
    yield* Effect.gen(function* () {
      const saved = yield* Ref.get(credentials);
      if (!saved) return;
      const now = yield* Clock.currentTimeMillis;
      if (saved.expiresAt - now > 60_000 && (yield* current).connection === "available") return;
      yield* refresh;
    }).pipe(Effect.repeat(Schedule.spaced("30 seconds")), Effect.forkScoped);
  }

  return NodexAccount.of({
    read: current,
    changes: SubscriptionRef.changes(snapshot),
    refresh,
    signIn: mutation.withPermits(1)(
      Effect.gen(function* () {
        const state = yield* current;
        if (!platform.configured)
          return yield* publish({
            error: platform.configurationError ? "configuration" : "not-configured",
          });
        if (state.status === "signing-in" || state.status === "signed-in") return state;
        const cleared = yield* platform.clear.pipe(Effect.result);
        if (cleared._tag === "Failure") return yield* publish({ error: "secure-storage" });
        const captured = yield* Ref.updateAndGet(generation, (value) => value + 1);
        yield* Ref.set(credentials, null);
        yield* publish({ status: "signing-in", account: null, persistence: null, error: null });
        yield* FiberHandle.run(
          loginTask,
          platform.login.pipe(
            Effect.flatMap((next) => adopt(captured, next)),
            Effect.scoped,
            Effect.catch((error) => failure(captured, error)),
            Effect.asVoid,
            Effect.interruptible,
          ),
        );
        return yield* current;
      }).pipe(Effect.uninterruptible),
    ),
    cancelSignIn: mutation.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* current).status !== "signing-in") return yield* current;
        yield* Ref.update(generation, (value) => value + 1);
        yield* FiberHandle.clear(loginTask);
        return yield* publish({
          status: "signed-out",
          account: null,
          persistence: null,
          error: null,
        });
      }),
    ),
    signOut: mutation.withPermits(1)(
      Effect.gen(function* () {
        const previous = yield* Ref.get(credentials);
        const captured = yield* Ref.updateAndGet(generation, (value) => value + 1);
        yield* Ref.set(credentials, null);
        yield* FiberHandle.clear(loginTask);
        const cleared = yield* platform.clear.pipe(Effect.result);
        yield* publish({
          status: "signed-out",
          account: null,
          connection: "unavailable",
          persistence: null,
          error: cleared._tag === "Failure" ? "secure-storage" : null,
        });
        if (previous)
          yield* FiberSet.run(
            revokeTasks,
            platform.revoke(previous).pipe(
              Effect.catch(() =>
                cleared._tag === "Failure"
                  ? Effect.void
                  : failure(captured, new NodexAccountPlatformError({ code: "revocation-failed" })),
              ),
              Effect.asVoid,
            ),
          );
        return yield* current;
      }).pipe(Effect.uninterruptible),
    ),
  });
});

export const live = Layer.effect(NodexAccount, make);
