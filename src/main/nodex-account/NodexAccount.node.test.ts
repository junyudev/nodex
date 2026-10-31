import * as SubscriptionRef from "effect/SubscriptionRef";
import type { NodexAccountOptions } from "./NodexAccount";
// @effect-diagnostics strictEffectProvide:off
import {
  NodexModelAccessPlatform,
  NodexModelAccessError,
} from "../platform/NodexModelAccessPlatform";
import {
  modelAccessFixture,
  modelStatusFixture,
  unavailableModelAccessFixture,
} from "./model-access-fixture";
import { it } from "@effect/vitest";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";
import type { NodexAccountSnapshot } from "../../shared/nodex-account";
import {
  NodexAccountPlatform,
  NodexAccountPlatformError,
  type NodexAccountCredentials,
} from "../platform/NodexAccountPlatform";
import { make, type NodexAccount } from "./NodexAccount";

const alice: NodexAccountCredentials = {
  identity: {
    issuer: "https://login.example.com",
    subject: "alice",
    email: "alice@example.com",
    name: "Alice",
    imageUrl: null,
  },
  accessToken: Redacted.make("private-access"),
  refreshToken: Redacted.make("private-refresh"),
  expiresAt: 9_999_999_999_999,
};
const harness = (
  overrides: Partial<NodexAccountPlatform["Service"]> = {},
  modelOverrides: Partial<NodexModelAccessPlatform["Service"]> = {},
  options: NodexAccountOptions = {},
) =>
  Effect.gen(function* () {
    const login = yield* Deferred.make<NodexAccountCredentials, NodexAccountPlatformError>();
    const started = yield* Deferred.make<void>();
    let saves = 0;
    let loginCount = 0;
    let released = 0;
    let revocations = 0;
    const owner = yield* make(options).pipe(
      Effect.provideService(NodexModelAccessPlatform, {
        ...unavailableModelAccessFixture,
        ...modelOverrides,
      }),
      Effect.provideService(NodexAccountPlatform, {
        configured: true,
        configurationError: false,
        load: Effect.succeed(null),
        save: () =>
          Effect.sync(() => {
            saves++;
            return "secure" as const;
          }),
        clear: Effect.void,
        login: Effect.acquireRelease(
          Effect.sync(() => {
            loginCount++;
          }),
          () =>
            Effect.sync(() => {
              released++;
            }),
        ).pipe(
          Effect.andThen(Deferred.succeed(started, undefined)),
          Effect.andThen(Deferred.await(login)),
          Effect.map((credentials) => ({ credentials, retain: Effect.void })),
        ),
        refresh: (credentials) =>
          Effect.succeed({ credentials, retain: Effect.void, verified: true }),
        revoke: () =>
          Effect.sync(() => {
            revocations++;
          }),
        ...overrides,
      }),
    );
    return {
      owner,
      started: Deferred.await(started),
      finish: (value = alice) => Deferred.succeed(login, value),
      saves: () => saves,
      loginCount: () => loginCount,
      released: () => released,
      revocations: () => revocations,
    };
  });
const watch = (owner: NodexAccount["Service"], test: (snapshot: NodexAccountSnapshot) => boolean) =>
  owner.changes.pipe(
    Stream.filter(test),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
    Effect.forkScoped,
  );

it.effect("leaves an unconfigured local Profile usable without account I/O", () =>
  Effect.gen(function* () {
    const value = yield* harness({
      configured: false,
      load: Effect.die("No account disk access without configuration"),
    });
    expect((yield* value.owner.read).status).toBe("signed-out");
    expect((yield* value.owner.signIn).error).toBe("not-configured");
    expect(value.loginCount()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("shares one login, persists before publication and never projects tokens", () =>
  Effect.gen(function* () {
    const value = yield* harness();
    const signedIn = yield* watch(value.owner, (state) => state.status === "signed-in");
    const snapshots = yield* Effect.all([value.owner.signIn, value.owner.signIn], {
      concurrency: "unbounded",
    });
    yield* value.started;
    expect(snapshots.every((state) => state.status === "signing-in")).toBe(true);
    expect(value.loginCount()).toBe(1);
    yield* value.finish();
    const state = yield* Fiber.join(signedIn);
    expect(state.account?.subject).toBe("alice");
    expect(state.persistence).toBe("secure");
    expect(state.revision).toBeGreaterThan(snapshots[0]!.revision);
    expect(JSON.stringify(state)).not.toContain("private-");
    expect(value.saves()).toBe(1);
    expect(value.released()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("cancel releases the callback lifetime and ignores its late completion", () =>
  Effect.gen(function* () {
    const value = yield* harness();
    yield* value.owner.signIn;
    yield* value.started;
    const canceled = yield* value.owner.cancelSignIn;
    yield* value.finish();
    yield* Effect.yieldNow;
    expect((yield* value.owner.read).status).toBe("signed-out");
    expect(canceled.account).toBeNull();
    expect(value.released()).toBe(1);
    expect(value.saves()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("a refresh captured before sign-out cannot restore credentials or identity", () =>
  Effect.gen(function* () {
    const refreshStarted = yield* Deferred.make<void>();
    const refreshed = yield* Deferred.make<NodexAccountCredentials>();
    let releasedGrant = 0;
    let retainedGrant = 0;
    const value = yield* harness({
      refresh: () =>
        Deferred.succeed(refreshStarted, undefined).pipe(
          Effect.andThen(Deferred.await(refreshed)),
          Effect.flatMap((credentials) =>
            Effect.acquireRelease(Effect.succeed(credentials), () =>
              Effect.sync(() => {
                if (!retainedGrant) releasedGrant++;
              }),
            ),
          ),
          Effect.map((credentials) => ({
            credentials,
            verified: false,
            retain: Effect.sync(() => {
              retainedGrant++;
            }),
          })),
        ),
    });
    const signedIn = yield* watch(value.owner, (state) => state.status === "signed-in");
    yield* value.owner.signIn;
    yield* value.finish();
    yield* Fiber.join(signedIn);
    const pending = yield* value.owner.refresh.pipe(Effect.forkScoped);
    yield* Deferred.await(refreshStarted);
    yield* value.owner.signOut;
    yield* Deferred.succeed(refreshed, { ...alice, accessToken: Redacted.make("new-secret") });
    yield* Fiber.join(pending);
    expect((yield* value.owner.read).account).toBeNull();
    expect(value.saves()).toBe(1);
    expect(releasedGrant).toBe(1);
    expect(retainedGrant).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("does not start login while previous persisted credentials cannot be removed", () =>
  Effect.gen(function* () {
    const value = yield* harness({
      clear: Effect.fail(new NodexAccountPlatformError({ code: "secure-storage" })),
    });
    const state = yield* value.owner.signIn;
    expect(state.status).toBe("signed-out");
    expect(state.error).toBe("secure-storage");
    expect(value.loginCount()).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("reports persisted sign-out failure even when remote revocation also fails", () =>
  Effect.gen(function* () {
    let cannotClear = false;
    const revokeFinished = yield* Deferred.make<void>();
    const value = yield* harness({
      clear: Effect.suspend(() =>
        cannotClear
          ? Effect.fail(new NodexAccountPlatformError({ code: "secure-storage" }))
          : Effect.void,
      ),
      revoke: () =>
        Deferred.succeed(revokeFinished, undefined).pipe(
          Effect.andThen(Effect.fail(new NodexAccountPlatformError({ code: "revocation-failed" }))),
        ),
    });
    const signedIn = yield* watch(value.owner, (state) => state.status === "signed-in");
    yield* value.owner.signIn;
    yield* value.finish();
    yield* Fiber.join(signedIn);
    cannotClear = true;
    const state = yield* value.owner.signOut;
    expect(state.account).toBeNull();
    expect(state.error).toBe("secure-storage");
    yield* Deferred.await(revokeFinished);
    yield* Effect.yieldNow;
    expect((yield* value.owner.read).error).toBe("secure-storage");
    cannotClear = false;
    expect((yield* value.owner.signOut).error).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect("lets independent sign-out grants finish revocation across rapid account changes", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const secondStarted = yield* Deferred.make<void>();
    const finishFirst = yield* Deferred.make<void>();
    const finishSecond = yield* Deferred.make<void>();
    const firstCompleted = yield* Deferred.make<void>();
    const secondCompleted = yield* Deferred.make<void>();
    const interrupted: string[] = [];
    let loginCount = 0;
    const value = yield* harness({
      login: Effect.sync(() => ({
        credentials: {
          ...alice,
          identity: { ...alice.identity, subject: ++loginCount === 1 ? "alice" : "bob" },
        },
        retain: Effect.void,
      })),
      revoke: (credentials) => {
        const first = credentials.identity.subject === "alice";
        return Deferred.succeed(first ? firstStarted : secondStarted, undefined).pipe(
          Effect.andThen(Deferred.await(first ? finishFirst : finishSecond)),
          Effect.andThen(Deferred.succeed(first ? firstCompleted : secondCompleted, undefined)),
          Effect.andThen(
            first
              ? Effect.fail(new NodexAccountPlatformError({ code: "revocation-failed" }))
              : Effect.void,
          ),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted.push(credentials.identity.subject);
            }),
          ),
        );
      },
    });
    const firstSignedIn = yield* watch(value.owner, (state) => state.account?.subject === "alice");
    yield* value.owner.signIn;
    yield* Fiber.join(firstSignedIn);
    yield* value.owner.signOut;
    yield* Deferred.await(firstStarted);
    const secondSignedIn = yield* watch(value.owner, (state) => state.account?.subject === "bob");
    yield* value.owner.signIn;
    yield* Fiber.join(secondSignedIn);
    yield* value.owner.signOut;
    yield* Deferred.await(secondStarted);
    expect(interrupted).toEqual([]);
    yield* Deferred.succeed(finishFirst, undefined);
    yield* Deferred.await(firstCompleted);
    yield* Effect.yieldNow;
    expect((yield* value.owner.read).error).toBeNull();
    yield* Deferred.succeed(finishSecond, undefined);
    yield* Deferred.await(secondCompleted);
    expect(interrupted).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("keeps remembered identity on network loss but requires login after revocation", () =>
  Effect.gen(function* () {
    let invalid = false;
    const value = yield* harness({
      refresh: () =>
        Effect.fail(new NodexAccountPlatformError({ code: invalid ? "invalid-grant" : "network" })),
    });
    const signedIn = yield* watch(value.owner, (state) => state.status === "signed-in");
    yield* value.owner.signIn;
    yield* value.finish();
    yield* Fiber.join(signedIn);
    const unavailable = yield* value.owner.refresh;
    expect(unavailable.status).toBe("signed-in");
    expect(unavailable.account?.subject).toBe("alice");
    expect(unavailable.connection).toBe("unavailable");
    invalid = true;
    expect((yield* value.owner.refresh).status).toBe("reauthentication-required");
    expect((yield* value.owner.signOut).account).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect(
  "keeps the gateway key private, persists it, and retires execution before clearing storage",
  () =>
    Effect.gen(function* () {
      let persisted: NodexAccountCredentials | null = null;
      let opened = 0;
      const value = yield* harness(
        {
          save: (credentials) =>
            Effect.sync(() => {
              persisted = credentials;
              return "secure" as const;
            }),
        },
        {
          exchange: () => Effect.succeed(modelAccessFixture),
          openCheckout: () =>
            Effect.sync(() => {
              opened++;
            }),
        },
      );
      const ready = yield* watch(value.owner, (state) => state.credit?.balance === 12.5);
      yield* value.owner.signIn;
      yield* value.finish();
      const snapshot = yield* Fiber.join(ready);
      expect(snapshot.credit).toEqual({ balance: 12.5, unit: "USD" });
      expect(JSON.stringify(snapshot)).not.toContain("synthetic-gateway-key");
      expect((persisted as NodexAccountCredentials | null)?.modelAccess).toEqual(
        modelAccessFixture,
      );
      expect((yield* value.owner.managed)?.identity.subject).toBe("alice");
      yield* value.owner.openTopUp(2);
      expect(opened).toBe(1);
      let retired = false;
      yield* value.owner.onModelsChanged(
        Effect.gen(function* () {
          expect(yield* value.owner.managed).toBeNull();
          retired = true;
        }),
      );
      yield* value.owner.signOut;
      expect(retired).toBe(true);
      expect((yield* value.owner.read).credit).toBeNull();
      yield* value.owner.openTopUp(2);
      expect(opened).toBe(1);
    }).pipe(Effect.scoped),
);

it.effect("fences a late gateway exchange after sign-out", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const exchanged = yield* Deferred.make<typeof modelAccessFixture>();
    const value = yield* harness(
      {},
      {
        exchange: () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(exchanged))),
      },
    );
    yield* value.owner.signIn;
    yield* value.finish();
    yield* Deferred.await(started);
    yield* value.owner.signOut;
    yield* Deferred.succeed(exchanged, modelAccessFixture);
    expect(yield* value.owner.managed).toBeNull();
    expect((yield* value.owner.read).status).toBe("signed-out");
    expect(value.saves()).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("retires the managed account on identity verification failure", () =>
  Effect.gen(function* () {
    const value = yield* harness(
      { refresh: () => Effect.fail(new NodexAccountPlatformError({ code: "identity-changed" })) },
      { exchange: () => Effect.succeed(modelAccessFixture) },
    );
    const ready = yield* watch(
      value.owner,
      (state) => state.credit !== undefined && state.credit !== null,
    );
    yield* value.owner.signIn;
    yield* value.finish();
    yield* Fiber.join(ready);
    yield* value.owner.refresh;
    expect(yield* value.owner.managed).toBeNull();
    expect((yield* value.owner.read).status).toBe("reauthentication-required");
  }).pipe(Effect.scoped),
);

it.effect("keeps local login usable when the model exchange rejects an unverified email", () =>
  Effect.gen(function* () {
    const value = yield* harness(
      {},
      { exchange: () => Effect.fail(new NodexModelAccessError({ code: "email_unverified" })) },
    );
    const failed = yield* watch(
      value.owner,
      (state) => state.modelAccessError === "email_unverified",
    );
    yield* value.owner.signIn;
    yield* value.finish();
    expect((yield* Fiber.join(failed)).status).toBe("signed-in");
    expect(yield* value.owner.managed).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect("a balance response captured before sign-out cannot restore the key or credit", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const balance = yield* Deferred.make<number>();
    let delayed = false;
    const value = yield* harness(
      {},
      {
        exchange: () => Effect.succeed(modelAccessFixture),
        balance: () =>
          delayed
            ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(balance)))
            : Effect.succeed(12.5),
      },
    );
    const ready = yield* watch(value.owner, (state) => state.credit?.balance === 12.5);
    yield* value.owner.signIn;
    yield* value.finish();
    yield* Fiber.join(ready);
    delayed = true;
    const pending = yield* value.owner.refresh.pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    const saves = value.saves();
    yield* value.owner.signOut;
    yield* Deferred.succeed(balance, 99);
    yield* Fiber.join(pending);
    expect(value.saves()).toBe(saves);
    expect(yield* value.owner.managed).toBeNull();
    expect((yield* value.owner.read).credit).toBeNull();
  }).pipe(Effect.scoped),
);

it.effect(
  "refreshes supply on startup, coalesces opening surfaces, and fails closed on status loss",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      let available = true;
      const value = yield* harness(
        {},
        {
          status: Effect.suspend(() => {
            reads++;
            return available
              ? Effect.succeed(modelStatusFixture)
              : Effect.fail(new NodexModelAccessError({ code: "unavailable" }));
          }),
        },
      );
      yield* value.owner.refreshModels;
      expect((yield* value.owner.read).modelStatus).toEqual(modelStatusFixture);
      yield* Effect.all([value.owner.refreshModels, value.owner.refreshModels], {
        concurrency: "unbounded",
      });
      expect(reads).toBe(1);
      available = false;
      yield* value.owner.refresh;
      expect((yield* value.owner.read).modelStatus).toBeNull();
      expect((yield* value.owner.read).credit).toBeUndefined();
      yield* TestClock.adjust("60 seconds");
      expect(reads).toBe(3);
      yield* TestClock.adjust("60 seconds");
      expect(reads).toBe(4);
    }).pipe(Effect.scoped),
);

it.effect(
  "opens the chosen tier with the Clerk token and observes payment without a renderer or manual refresh",
  () =>
    Effect.gen(function* () {
      let balance = 12.5;
      let reads = 0;
      let checkouts = 0;
      const value = yield* harness(
        {},
        {
          exchange: () => Effect.succeed(modelAccessFixture),
          balance: () =>
            Effect.sync(() => {
              reads++;
              return balance;
            }),
          checkout: (token, amount) =>
            Effect.sync(() => {
              expect(Redacted.value(token)).toBe("private-access");
              expect(amount).toBe(2);
              checkouts++;
              return "https://checkout.stripe.com/c/pay/synthetic";
            }),
        },
      );
      const ready = yield* watch(value.owner, (state) => state.credit?.balance === 12.5);
      yield* value.owner.signIn;
      yield* value.finish();
      yield* Fiber.join(ready);
      expect((yield* value.owner.openTopUp(5)).checkoutError).toBe("tier_unavailable");
      expect((yield* value.owner.openTopUp(NaN)).checkoutError).toBe("tier_unavailable");
      expect(checkouts).toBe(0);
      expect((yield* value.owner.openTopUp(2)).checkoutPending).toBe(true);
      const before = reads;
      balance = 26.5;
      yield* TestClock.adjust("10 seconds");
      expect((yield* value.owner.read).credit?.balance).toBe(26.5);
      expect((yield* value.owner.read).checkoutPending).toBe(false);
      expect(reads).toBeGreaterThan(before);
      expect(checkouts).toBe(1);
      expect(JSON.stringify(yield* value.owner.read)).not.toContain("checkout.stripe.com");
    }).pipe(Effect.scoped),
);

it.effect("stops pending payment polling after five minutes and retires it on sign-out", () =>
  Effect.gen(function* () {
    const value = yield* harness({}, { exchange: () => Effect.succeed(modelAccessFixture) });
    const ready = yield* watch(value.owner, (state) => state.credit?.balance === 12.5);
    yield* value.owner.signIn;
    yield* value.finish();
    yield* Fiber.join(ready);
    yield* value.owner.openTopUp(2);
    yield* TestClock.adjust("5 minutes");
    expect((yield* value.owner.read).checkoutPending).toBe(false);
    yield* value.owner.openTopUp(2);
    yield* value.owner.signOut;
    yield* TestClock.adjust("10 seconds");
    expect(yield* value.owner.read).toMatchObject({
      status: "signed-out",
      checkoutPending: false,
      credit: null,
    });
  }).pipe(Effect.scoped),
);

it.effect("ignores late checkouts after sign-out and coalesces concurrent checkout commands", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<string>();
    let opened = 0;
    let requests = 0;
    const value = yield* harness(
      {},
      {
        exchange: () => Effect.succeed(modelAccessFixture),
        checkout: () =>
          Effect.sync(() => {
            requests++;
          }).pipe(
            Effect.andThen(Deferred.succeed(started, undefined)),
            Effect.andThen(Deferred.await(finished)),
          ),
        openCheckout: () =>
          Effect.sync(() => {
            opened++;
          }),
      },
    );
    const ready = yield* watch(value.owner, (state) => state.credit?.balance === 12.5);
    yield* value.owner.signIn;
    yield* value.finish();
    yield* Fiber.join(ready);
    const checkout = yield* value.owner.openTopUp(2).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* value.owner.openTopUp(2);
    expect(requests).toBe(1);
    yield* value.owner.signOut;
    yield* Deferred.succeed(finished, "https://checkout.stripe.com/c/pay/synthetic");
    yield* Fiber.join(checkout);
    expect(opened).toBe(0);
    expect((yield* value.owner.read).checkoutPending).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("reports paused supply and checkout errors without changing wallet credit", () =>
  Effect.gen(function* () {
    let available = false;
    let code: "tier_unavailable" | "unavailable" = "tier_unavailable";
    const value = yield* harness(
      {},
      {
        exchange: () => Effect.succeed(modelAccessFixture),
        status: Effect.sync(() => ({
          ...modelStatusFixture,
          topUp: { ...modelStatusFixture.topUp, available },
        })),
        checkout: () => Effect.suspend(() => Effect.fail(new NodexModelAccessError({ code }))),
      },
    );
    const ready = yield* watch(value.owner, (state) => state.credit?.balance === 12.5);
    yield* value.owner.signIn;
    yield* value.finish();
    yield* Fiber.join(ready);
    expect((yield* value.owner.openTopUp(2)).checkoutError).toBe("unavailable");
    available = true;
    expect((yield* value.owner.openTopUp(2)).checkoutError).toBe("tier_unavailable");
    code = "unavailable";
    expect((yield* value.owner.openTopUp(2)).checkoutError).toBe("unavailable");
    expect((yield* value.owner.read).credit?.balance).toBe(12.5);
  }).pipe(Effect.scoped),
);

it.effect("renews remembered model access once per launch and keeps it when offline", () =>
  Effect.gen(function* () {
    const stale = { ...modelAccessFixture, models: modelAccessFixture.models.slice(0, 3) };
    for (const online of [true, false]) {
      let exchanges = 0;
      const value = yield* harness(
        { load: Effect.succeed({ ...alice, modelAccess: stale }) },
        {
          exchange: () =>
            Effect.suspend(() => {
              exchanges++;
              return online
                ? Effect.succeed(modelAccessFixture)
                : Effect.fail(new NodexModelAccessError({ code: "unavailable" }));
            }),
        },
      );
      yield* value.owner.refresh;
      const expected = online ? modelAccessFixture.models : stale.models;
      expect((yield* value.owner.managed)?.access.models).toEqual(expected);
      yield* value.owner.refresh;
      expect(exchanges).toBe(online ? 1 : 2);
    }
  }).pipe(Effect.scoped),
);

it.effect(
  "hides periodic balance reads while keeping tokens, managed access and public supply fresh",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const meter = yield* SubscriptionRef.make(false);
        let balances = 0;
        let refreshes = 0;
        let statuses = 0;
        let exchanges = 0;
        const value = yield* harness(
          {
            load: Effect.succeed(alice),
            refresh: (credentials) =>
              Effect.sync(() => {
                refreshes++;
                return { credentials, retain: Effect.void, verified: true };
              }),
          },
          {
            status: Effect.sync(() => {
              statuses++;
              return modelStatusFixture;
            }),
            exchange: () =>
              Effect.sync(() => {
                exchanges++;
                return modelAccessFixture;
              }),
            balance: () =>
              Effect.sync(() => {
                balances++;
                return 12.5;
              }),
          },
          { meterEnabled: false, meterEnabledChanges: SubscriptionRef.changes(meter) },
        );
        const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, {
          discard: true,
        });
        yield* settle;
        expect(refreshes).toBe(1);
        expect(exchanges).toBe(1);
        expect(balances).toBe(0);
        expect((yield* value.owner.managed)?.access).toEqual(modelAccessFixture);
        expect((yield* value.owner.read).credit).toBeUndefined();
        const initialStatuses = statuses;
        yield* TestClock.adjust("60 seconds");
        yield* settle;
        expect(balances).toBe(0);
        expect(statuses).toBe(initialStatuses + 1);
        expect(value.saves()).toBeGreaterThan(1);
        yield* SubscriptionRef.set(meter, true);
        yield* settle;
        expect(balances).toBe(1);
        yield* SubscriptionRef.set(meter, true);
        yield* settle;
        expect(balances).toBe(1);
        yield* SubscriptionRef.set(meter, false);
        yield* settle;
        yield* TestClock.adjust("60 seconds");
        expect(balances).toBe(1);
        // An explicit Account surface still reads credit while its rail meter is hidden.
        yield* value.owner.refreshModels;
        expect(balances).toBe(2);
        yield* value.owner.openTopUp(2);
        yield* TestClock.adjust("10 seconds");
        expect(balances).toBe(3);
      }),
    ),
);

it.effect("renews expiring OAuth credentials even with the credit meter hidden", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let refreshes = 0;
      let balances = 0;
      const value = yield* harness(
        {
          load: Effect.succeed({ ...alice, expiresAt: 10_000 }),
          refresh: (credentials) =>
            Effect.sync(() => {
              refreshes++;
              return { credentials, retain: Effect.void, verified: true };
            }),
        },
        {
          balance: () =>
            Effect.sync(() => {
              balances++;
              return 12.5;
            }),
        },
        { meterEnabled: false },
      );
      yield* TestClock.adjust("60 seconds");
      expect(refreshes).toBeGreaterThanOrEqual(3);
      expect(balances).toBe(0);
      expect((yield* value.owner.read).status).toBe("signed-in");
    }),
  ),
);

it.effect("a hidden meter skips credit after an already-started model exchange completes", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const meter = yield* SubscriptionRef.make(true);
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let balances = 0;
      const value = yield* harness(
        { load: Effect.succeed(alice) },
        {
          exchange: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as(modelAccessFixture),
            ),
          balance: () =>
            Effect.sync(() => {
              balances++;
              return 12.5;
            }),
        },
        { meterEnabledChanges: SubscriptionRef.changes(meter) },
      );
      yield* Deferred.await(started);
      yield* SubscriptionRef.set(meter, false);
      yield* Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });
      yield* Deferred.succeed(release, undefined);
      yield* Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });
      expect(balances).toBe(0);
      expect((yield* value.owner.managed)?.access).toEqual(modelAccessFixture);
      yield* SubscriptionRef.set(meter, true);
      yield* Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, { discard: true });
      expect(balances).toBe(1);
    }),
  ),
);
