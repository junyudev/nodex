// @effect-diagnostics strictEffectProvide:off
import { it } from "@effect/vitest";
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
const harness = (overrides: Partial<NodexAccountPlatform["Service"]> = {}) =>
  Effect.gen(function* () {
    const login = yield* Deferred.make<NodexAccountCredentials, NodexAccountPlatformError>();
    const started = yield* Deferred.make<void>();
    let saves = 0;
    let loginCount = 0;
    let released = 0;
    let revocations = 0;
    const owner = yield* make.pipe(
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
