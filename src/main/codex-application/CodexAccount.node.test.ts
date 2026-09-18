import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import {
  CodexExecutionHostAuthState,
  live as executionHostAuthStateLive,
} from "../codex-runtime/CodexExecutionHostAuthState";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { CodexAccount, live as accountLive } from "./CodexAccount";

it.effect("owns account, login, rate-limit, and notification state behind one interface", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const requests: string[] = [];
    const requestLocal = ((method: string) => {
      requests.push(method);
      const response: unknown = (() => {
        if (method === "account/read") {
          return {
            account: { type: "chatgpt", email: "agent@example.com", planType: "plus" },
            requiresOpenaiAuth: false,
          };
        }
        if (method === "account/rateLimits/read") {
          return {
            ordinaryUsageAllowed: false,
            rateLimits: { primary: { usedPercent: 25, resetsAt: 1_800_000_000 } },
            rateLimitsByLimitId: null,
            rateLimitResetCredits: { availableCount: 1, credits: null },
          };
        }
        if (method === "account/rateLimitResetCredit/consume") return { outcome: "reset" };
        if (method === "account/login/start") {
          return { type: "chatgpt", loginId: "login-1", authUrl: "https://example.com/login" };
        }
        if (method === "account/login/cancel") return { status: "canceled" };
        if (method === "account/logout") return {};
        throw new Error(`Unexpected request: ${method}`);
      })();
      return method === "account/read"
        ? Effect.yieldNow.pipe(Effect.as(response))
        : Effect.succeed(response);
    }) as CodexGateway["Service"]["requestLocal"];
    const unsupported = () => Effect.die(new Error("Unsupported test operation"));
    const gateway = CodexGateway.of({
      localHostId: "local",
      requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
      requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
      events: Stream.fromPubSub(events),
      requestLocal,
      requestOnHost: (_hostId, method, params) => requestLocal(method, params),
      requestForThread: (_threadId, method, params) => requestLocal(method, params),
      notifyLocal: unsupported,
      connection: () => unsupported(),
      connectionChanges: () => Stream.empty,
      awaitReady: () => Effect.void,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: unsupported,
    });
    const scope = yield* Scope.make();
    const authContext = yield* Layer.buildWithScope(executionHostAuthStateLive, scope);
    const authState = Context.get(authContext, CodexExecutionHostAuthState);
    const context = yield* Layer.buildWithScope(
      accountLive({ pollInterval: "1 hour" }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, gateway),
            Layer.succeed(CodexExecutionHostAuthState, authState),
          ),
        ),
      ),
      scope,
    );
    const account = Context.get(context, CodexAccount);
    yield* Effect.yieldNow;

    const first = yield* account.refresh;
    assert.deepEqual(first.account, {
      type: "chatgpt",
      email: "agent@example.com",
      planType: "plus",
    });
    assert.strictEqual(first.rateLimits?.primary?.usedPercent, 25);
    assert.strictEqual(first.rateLimitResetCredits?.availableCount, 1);
    assert.strictEqual((yield* account.readUsageLimits).ordinaryUsageAllowed, false);

    const readsBeforeConcurrentRefresh = requests.filter(
      (method) => method === "account/read",
    ).length;
    const concurrent = yield* Effect.all([account.refresh, account.refresh], {
      concurrency: "unbounded",
    });
    assert.strictEqual(concurrent[0], concurrent[1]);
    assert.strictEqual(
      requests.filter((method) => method === "account/read").length,
      readsBeforeConcurrentRefresh + 1,
    );

    const login = yield* account.startLogin({ type: "chatgpt" });
    assert.strictEqual(login.type, "chatgpt");
    assert.strictEqual(
      (yield* SubscriptionRef.get(account.snapshot)).pendingLogin?.loginId,
      "login-1",
    );

    yield* PubSub.publish(events, {
      kind: "notification",
      hostId: "local",
      generation: 1,
      value: {
        method: "account/login/completed",
        params: { loginId: "login-1", success: true, error: null },
      },
    } as CodexEndpointEvent);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if ((yield* SubscriptionRef.get(account.snapshot)).pendingLogin === null) break;
      yield* Effect.yieldNow;
    }
    assert.isNull((yield* SubscriptionRef.get(account.snapshot)).pendingLogin ?? null);

    const reset = yield* account.consumeRateLimitResetCredit({ idempotencyKey: "reset-1" });
    assert.strictEqual(reset.outcome, "reset");
    assert.isTrue(requests.includes("account/rateLimitResetCredit/consume"));

    const nextLogin = yield* account.startLogin({ type: "chatgpt" });
    if (nextLogin.type === "chatgpt") {
      assert.deepEqual(yield* account.cancelLogin(nextLogin.loginId), { status: "canceled" });
    }
    assert.isNull((yield* SubscriptionRef.get(account.snapshot)).pendingLogin ?? null);
    assert.isTrue(yield* account.logout);
    assert.isNull((yield* SubscriptionRef.get(account.snapshot)).account);

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps invalidated auth signed out when an older refresh completes", () =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const readStarted = yield* Deferred.make<void>();
    const releaseRead = yield* Deferred.make<void>();
    const requestLocal = ((method: string) => {
      if (method === "account/read") {
        return Effect.gen(function* () {
          yield* Deferred.succeed(readStarted, undefined);
          yield* Deferred.await(releaseRead);
          return {
            account: { type: "chatgpt", email: "stale@example.com", planType: "plus" },
            requiresOpenaiAuth: false,
          };
        });
      }
      if (method === "account/rateLimits/read") {
        return Effect.succeed({
          ordinaryUsageAllowed: null,
          rateLimits: null,
          rateLimitsByLimitId: null,
          rateLimitResetCredits: null,
        });
      }
      return Effect.die(new Error(`Unexpected request: ${method}`));
    }) as CodexGateway["Service"]["requestLocal"];
    const unsupported = () => Effect.die(new Error("Unsupported test operation"));
    const gateway = CodexGateway.of({
      localHostId: "local",
      requestRawOnHost: () => unsupported(),
      requestRawForThread: () => unsupported(),
      events: Stream.fromPubSub(events),
      requestLocal,
      requestOnHost: (_hostId, method, params) => requestLocal(method, params),
      requestForThread: (_threadId, method, params) => requestLocal(method, params),
      notifyLocal: unsupported,
      connection: () => unsupported(),
      connectionChanges: () => Stream.empty,
      awaitReady: () => Effect.void,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: unsupported,
    });
    const scope = yield* Scope.make();
    const authContext = yield* Layer.buildWithScope(executionHostAuthStateLive, scope);
    const authState = Context.get(authContext, CodexExecutionHostAuthState);
    const context = yield* Layer.buildWithScope(
      accountLive({ pollInterval: "1 hour" }).pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, gateway),
            Layer.succeed(CodexExecutionHostAuthState, authState),
          ),
        ),
      ),
      scope,
    );
    const account = Context.get(context, CodexAccount);
    const refreshFiber = yield* account.refresh.pipe(Effect.forkChild);
    yield* Deferred.await(readStarted);
    yield* authState.markLoginRequired("local");
    yield* Effect.yieldNow;
    yield* Deferred.succeed(releaseRead, undefined);
    const result = yield* Fiber.join(refreshFiber);

    assert.isNull(result.account);
    assert.isTrue(result.requiresOpenAiAuth);
    const current = yield* SubscriptionRef.get(account.snapshot);
    assert.isNull(current.account);
    assert.isTrue(current.requiresOpenAiAuth);
    yield* Scope.close(scope, Exit.void);
  }),
);
