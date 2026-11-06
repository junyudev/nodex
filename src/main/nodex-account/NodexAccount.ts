import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberHandle from "effect/FiberHandle";
import * as FiberSet from "effect/FiberSet";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  NodexModelAccessPlatform,
  type NodexModelAccess,
} from "../platform/NodexModelAccessPlatform";
import type { NodexAccountIdentity } from "../../shared/nodex-account";
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
    readonly refreshModels: Effect.Effect<NodexAccountSnapshot>;
    readonly openTopUp: (amount: number) => Effect.Effect<NodexAccountSnapshot>;
    /** Private execution capability; never crosses IPC. */
    readonly managed: Effect.Effect<{
      readonly identity: NodexAccountIdentity;
      readonly access: NodexModelAccess;
    } | null>;
    readonly onModelsChanged: (effect: Effect.Effect<void>) => Effect.Effect<void>;
  }
>()("nodex/main/nodex-account/NodexAccount") {}

/** One Profile owns token refresh and generation fencing for all its windows. */
/** New catalog entries or a rotated key must reach the managed instances. */
const sameModelAccess = (left: NodexModelAccess, right: NodexModelAccess) =>
  Redacted.value(left.apiKey) === Redacted.value(right.apiKey) &&
  left.openaiBaseUrl === right.openaiBaseUrl &&
  left.anthropicBaseUrl === right.anthropicBaseUrl &&
  JSON.stringify(left.models) === JSON.stringify(right.models);

type CreditRead = "explicit" | "meter";

export interface NodexAccountOptions {
  readonly meterEnabled?: boolean;
  readonly meterEnabledChanges?: Stream.Stream<boolean>;
}

export const make = Effect.fn("NodexAccount.make")(function* (options: NodexAccountOptions = {}) {
  const platform = yield* NodexAccountPlatform;
  const scope = yield* Effect.scope;
  const meterEnabled = yield* Ref.make(options.meterEnabled ?? true);
  const models = yield* NodexModelAccessPlatform;
  const managed = yield* Ref.make<{
    readonly identity: NodexAccountIdentity;
    readonly access: NodexModelAccess;
  } | null>(null);
  const modelsChanged = yield* Ref.make<Effect.Effect<void>>(Effect.void);
  // Generation whose model access came from the service in this process; cached access only bridges offline starts.
  const exchangedGeneration = yield* Ref.make<number | null>(null);
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
  const checkoutTask = yield* FiberHandle.make<void>();
  const checkoutCreating = yield* Ref.make(false);
  const pendingCheckout = yield* Ref.make<{ generation: number; balance: number | null } | null>(
    null,
  );
  const statusLane = yield* Semaphore.make(1);
  const lastStatusAt = yield* Ref.make<number | null>(null);
  const lastCreditAt = yield* Ref.make<number | null>(null);
  const current = SubscriptionRef.get(snapshot);
  const publish = (patch: Partial<Omit<NodexAccountSnapshot, "revision">>) =>
    SubscriptionRef.updateAndGet(snapshot, (value) => ({
      ...value,
      ...patch,
      revision: value.revision + 1,
    }));
  const refreshStatus = (force = false) =>
    statusLane.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const previous = yield* Ref.get(lastStatusAt);
        if (!force && previous !== null && now - previous < 30_000) return;
        yield* Ref.set(lastStatusAt, now);
        const result = yield* models.status.pipe(Effect.result);
        const modelStatus = result._tag === "Success" ? result.success : null;
        if (JSON.stringify((yield* current).modelStatus) === JSON.stringify(modelStatus)) return;
        yield* publish({
          modelStatus,
          ...(modelStatus ? { creditsPerUsd: modelStatus.creditsPerUsd } : {}),
        });
      }),
    );
  const retireModels = Effect.gen(function* () {
    yield* Ref.set(managed, null);
    yield* Ref.set(pendingCheckout, null);
    yield* Ref.set(lastCreditAt, null);
    yield* yield* Ref.get(modelsChanged);
    yield* publish({
      credit: null,
      modelAccessError: null,
      checkoutPending: false,
      checkoutError: null,
    });
  });
  const syncModels = (captured: number, verified: boolean, creditRead: CreditRead) =>
    Effect.gen(function* () {
      if (!verified || (yield* Ref.get(generation)) !== captured) return;
      const saved = yield* Ref.get(credentials);
      if (!saved) return;
      const fresh = (yield* Ref.get(exchangedGeneration)) === captured;
      const result = yield* (
        fresh && saved.modelAccess
          ? Effect.succeed(saved.modelAccess)
          : models.exchange(saved.accessToken).pipe(
              Effect.tap(() => Ref.set(exchangedGeneration, captured)),
              Effect.catch((error) =>
                saved.modelAccess ? Effect.succeed(saved.modelAccess) : Effect.fail(error),
              ),
            )
      ).pipe(Effect.result);
      if (result._tag === "Failure") {
        yield* mutation.withPermit(
          Effect.gen(function* () {
            if ((yield* Ref.get(generation)) !== captured) return;
            yield* publish({
              modelAccessError:
                result.failure.code === "tier_unavailable" || result.failure.code === "browser-open"
                  ? "unavailable"
                  : result.failure.code,
            });
          }),
        );
        return;
      }
      const access = result.success;
      const balance =
        creditRead === "explicit" || (yield* Ref.get(meterEnabled))
          ? yield* models.balance(access).pipe(Effect.result)
          : null;
      yield* mutation.withPermit(
        Effect.gen(function* () {
          if ((yield* Ref.get(generation)) !== captured) return;
          const latest = yield* Ref.get(credentials);
          if (!latest) return;
          const next = { ...latest, modelAccess: access };
          const persistence = yield* platform.save(next).pipe(Effect.result);
          if (persistence._tag === "Failure") {
            yield* publish({ error: "secure-storage" });
            return;
          }
          yield* Ref.set(credentials, next);
          const previous = yield* Ref.get(managed);
          yield* Ref.set(managed, { identity: latest.identity, access });
          if (!previous || !sameModelAccess(previous.access, access))
            yield* yield* Ref.get(modelsChanged);
          if (balance) yield* Ref.set(lastCreditAt, yield* Clock.currentTimeMillis);
          const pending = yield* Ref.get(pendingCheckout);
          const credited =
            pending?.generation === captured &&
            balance?._tag === "Success" &&
            pending.balance !== null &&
            balance.success > pending.balance;
          if (credited) yield* Ref.set(pendingCheckout, null);
          yield* publish({
            ...(credited ? { checkoutPending: false } : {}),
            persistence: persistence.success,
            ...(balance
              ? {
                  credit:
                    balance._tag === "Success"
                      ? { balance: balance.success, unit: "USD" as const }
                      : null,
                }
              : {}),
            modelAccessError: null,
          });
        }).pipe(Effect.uninterruptible),
      );
    });
  const failure = (captured: number, error: NodexAccountPlatformError) =>
    mutation.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* Ref.get(generation)) !== captured) return;
        const invalid = error.code === "invalid-grant" || error.code === "identity-changed";
        if (invalid) {
          yield* Ref.update(generation, (value) => value + 1);
          yield* retireModels;
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
  const adopt = (
    captured: number,
    lease: NodexAccountCredentialLease,
    verified = true,
    creditRead: CreditRead = "explicit",
  ) =>
    mutation
      .withPermits(1)(
        Effect.gen(function* () {
          if ((yield* Ref.get(generation)) !== captured) return;
          const previous = yield* Ref.get(credentials);
          const next = {
            ...lease.credentials,
            ...(previous?.modelAccess ? { modelAccess: previous.modelAccess } : {}),
          };
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
      )
      .pipe(Effect.andThen(syncModels(captured, verified, creditRead)));
  const refreshAccount = (creditRead: CreditRead) =>
    refreshLane.withPermits(1)(
      Effect.gen(function* () {
        yield* refreshStatus(true);
        const captured = yield* Ref.get(generation);
        const previous = yield* Ref.get(credentials);
        if (!previous) return yield* current;
        yield* platform.refresh(previous).pipe(
          Effect.flatMap((next) => adopt(captured, next, next.verified, creditRead)),
          Effect.scoped,
          Effect.catch((error) => failure(captured, error)),
        );
        return yield* current;
      }),
    );

  const refresh = refreshAccount("explicit");
  const refreshCredit = (creditRead: CreditRead, force = false) =>
    Effect.gen(function* () {
      const saved = yield* Ref.get(credentials);
      if (!saved) return yield* current;
      const now = yield* Clock.currentTimeMillis;
      if (saved.expiresAt - now <= 60_000 || (yield* current).connection !== "available")
        return yield* refreshAccount(creditRead);
      yield* refreshLane.withPermit(
        Effect.gen(function* () {
          const last = yield* Ref.get(lastCreditAt);
          if (!force && last !== null && now - last < 5_000) return;
          yield* syncModels(yield* Ref.get(generation), true, creditRead);
        }),
      );
      return yield* current;
    });
  /** Opening an account/model surface or returning from the browser shares throttled reads. */
  const refreshModels = refreshStatus().pipe(Effect.andThen(refreshCredit("explicit")));
  yield* refreshStatus().pipe(Effect.forkScoped);
  yield* refreshStatus().pipe(
    Effect.repeat(Schedule.spaced("60 seconds")),
    Effect.delay("60 seconds"),
    Effect.forkScoped,
  );

  if (options.meterEnabledChanges)
    yield* options.meterEnabledChanges.pipe(
      Stream.runForEach((enabled) =>
        Effect.gen(function* () {
          const previous = yield* Ref.getAndSet(meterEnabled, enabled);
          if (enabled && !previous) yield* refreshCredit("meter", true).pipe(Effect.forkIn(scope));
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
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
    if (yield* Ref.get(credentials)) yield* refreshAccount("meter").pipe(Effect.forkScoped);
    yield* refreshCredit("meter").pipe(
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.delay("30 seconds"),
      Effect.forkScoped,
    );
  }

  return NodexAccount.of({
    read: current,
    managed: Ref.get(managed),
    onModelsChanged: (effect) => Ref.set(modelsChanged, effect),
    refreshModels,
    openTopUp: (amount) =>
      Effect.gen(function* () {
        if ((yield* current).status !== "signed-in") return yield* current;
        if (yield* Ref.getAndSet(checkoutCreating, true)) return yield* current;
        return yield* Effect.gen(function* () {
          const captured = yield* Ref.get(generation);
          yield* refreshModels;
          yield* refreshStatus(true);
          const saved = yield* Ref.get(credentials);
          if (!saved || (yield* Ref.get(generation)) !== captured) return yield* current;
          const supply = (yield* current).modelStatus?.topUp;
          if (!supply?.available) return yield* publish({ checkoutError: "unavailable" });
          if (
            !Number.isFinite(amount) ||
            !supply.tiers.some((tier) => tier.amount === amount && tier.available)
          )
            return yield* publish({ checkoutError: "tier_unavailable" });
          yield* publish({ checkoutError: null });
          const previousBalance = (yield* current).credit?.balance ?? null;
          const checkout = yield* models.checkout(saved.accessToken, amount).pipe(Effect.result);
          return yield* mutation.withPermit(
            Effect.gen(function* () {
              if ((yield* Ref.get(generation)) !== captured) return yield* current;
              if (checkout._tag === "Failure") {
                const code = checkout.failure.code;
                return yield* publish({
                  checkoutError: code === "email_unverified" ? "unavailable" : code,
                });
              }
              const opened = yield* models.openCheckout(checkout.success).pipe(Effect.result);
              if (opened._tag === "Failure")
                return yield* publish({ checkoutError: "browser-open" });
              yield* Ref.set(pendingCheckout, {
                generation: captured,
                balance: previousBalance,
              });
              yield* publish({ checkoutPending: true, checkoutError: null });
              yield* FiberHandle.run(
                checkoutTask,
                Effect.gen(function* () {
                  // A canceled Checkout cannot leave a permanent fast polling loop behind.
                  for (let attempt = 0; attempt < 30; attempt++) {
                    yield* Effect.sleep("10 seconds");
                    if (!(yield* Ref.get(pendingCheckout))) return;
                    yield* refreshModels;
                  }
                }).pipe(
                  Effect.timeout("5 minutes"),
                  Effect.catchTag("TimeoutError", () => Effect.void),
                  Effect.andThen(
                    Effect.gen(function* () {
                      if ((yield* Ref.get(generation)) !== captured) return;
                      yield* Ref.set(pendingCheckout, null);
                      yield* publish({ checkoutPending: false });
                    }),
                  ),
                ),
              );
              return yield* current;
            }),
          );
        }).pipe(Effect.ensuring(Ref.set(checkoutCreating, false)));
      }),
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
        yield* retireModels;
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
        yield* retireModels;
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
