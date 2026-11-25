import { describe } from "vite-plus/test";
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
import * as TestClock from "effect/testing/TestClock";
import { assert, it } from "@effect/vitest";
import {
  CodexExecutionHostAuthState,
  live as executionHostAuthStateLive,
  live as authStateLive,
} from "../codex-runtime/CodexExecutionHostAuthState";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexEndpointEvent } from "../codex-runtime/CodexEventHub";
import { CodexAccount, live as accountLive } from "./CodexAccount";
import { CodexWorkspaceRouting } from "../codex-runtime/CodexWorkspaceRouting";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { ElectronNet } from "../platform/electron/ElectronNet";
import { ChatGptDesktop, live } from "./ChatGptDesktop";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import type { ExternalAgentConfigMigrationItem } from "@nodex/codex-app-server-protocol/v2/ExternalAgentConfigMigrationItem";
import { make } from "./AgentImportRuntime";
import {
  CodexExternalAgentImportRuntime,
  make as makeCodexExternalAgentImportRuntime,
} from "./CodexExternalAgentImportRuntime";
import {
  buildCodexAttestationSignals,
  encodeCodexAttestationToken,
  makeCodexAttestation,
  supportsCodexAttestationRequests,
} from "./CodexAttestation";

describe("CodexAccount", () => {
  it.effect("owns account, login, rate-limit, and notification state behind one interface", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const requests: string[] = [];
      const requestLocal = ((method: string) => {
        requests.push(method);
        const response: unknown = (() => {
          if (method === "account/read") {
            return {
              account: {
                workspaceName: null,
                type: "chatgpt",
                email: "agent@example.com",
                planType: "plus",
              },
              requiresOpenaiAuth: false,
            };
          }
          if (method === "account/rateLimits/read") {
            return {
              ordinaryUsageAllowed: false,
              rateLimits: {
                primary: { usedPercent: 25, resetsAt: 1_800_000_000 },
                credits: { hasCredits: true, unlimited: false, balance: "1240.5" },
              },
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
        promoteQueuedCatalogPage: Effect.succeed(false),
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
      const installStarted = yield* Deferred.make<void>();
      const installed = yield* Deferred.make<void>();
      const context = yield* Layer.buildWithScope(
        accountLive({
          pollInterval: "1 hour",
          prepareSignIn: Deferred.succeed(installStarted, undefined).pipe(
            Effect.andThen(Deferred.await(installed)),
          ),
        }).pipe(
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
      assert.deepEqual(first.rateLimits?.credits, {
        hasCredits: true,
        unlimited: false,
        balance: "1240.5",
      });
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

      const signIn = yield* account.startLogin({ type: "chatgpt" }).pipe(Effect.forkChild);
      yield* Deferred.await(installStarted);
      assert.notInclude(requests, "account/login/start");
      yield* Deferred.succeed(installed, undefined);
      const login = yield* Fiber.join(signIn);
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
              account: {
                workspaceName: null,
                type: "chatgpt",
                email: "stale@example.com",
                planType: "plus",
              },
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
        promoteQueuedCatalogPage: Effect.succeed(false),
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

  it.effect(
    "observes cold native account state and refreshes only after explicit endpoint acquisition",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* SubscriptionRef.make<
            import("../codex-runtime/CodexEventHub").CodexEndpointConnection
          >({ kind: "stopped", hostId: "local" });
          const requests: string[] = [];
          const gateway = {
            localHostId: "local",
            events: Stream.empty,
            connectionChanges: () => SubscriptionRef.changes(connection),
            awaitReady: () => Effect.void,
            requestLocal: (method: string) =>
              Effect.sync(() => {
                requests.push(method);
                if (method !== "account/read") throw new Error(`Unexpected request: ${method}`);
                return { account: { type: "apiKey" }, requiresOpenaiAuth: false };
              }),
          } as unknown as CodexGateway["Service"];
          const context = yield* Layer.buildWithScope(
            accountLive({ pollInterval: "1 hour" }).pipe(
              Layer.provide(
                Layer.merge(Layer.succeed(CodexGateway, gateway), executionHostAuthStateLive),
              ),
            ),
            yield* Scope.Scope,
          );
          const account = Context.get(context, CodexAccount);
          yield* Effect.yieldNow;
          assert.deepEqual(requests, []);
          assert.isNull((yield* SubscriptionRef.get(account.snapshot)).account);
          yield* SubscriptionRef.set(connection, { kind: "ready", hostId: "local", generation: 1 });
          for (let attempt = 0; attempt < 20 && requests.length === 0; attempt++)
            yield* Effect.yieldNow;
          assert.deepEqual(requests, ["account/read"]);
          assert.deepEqual((yield* SubscriptionRef.get(account.snapshot)).account, {
            type: "apiKey",
          });
          yield* SubscriptionRef.set(connection, { kind: "stopped", hostId: "local" });
          yield* Effect.yieldNow;
          assert.deepEqual(requests, ["account/read"]);
        }),
      ),
  );

  it.effect("retries an account read that failed until the account is known", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* SubscriptionRef.make<
          import("../codex-runtime/CodexEventHub").CodexEndpointConnection
        >({ kind: "stopped", hostId: "local" });
        const requests: string[] = [];
        const gateway = {
          localHostId: "local",
          events: Stream.empty,
          connectionChanges: () => SubscriptionRef.changes(connection),
          awaitReady: () => Effect.void,
          requestLocal: (method: string) =>
            Effect.suspend((): Effect.Effect<unknown, Error> => {
              requests.push(method);
              if (method === "account/rateLimits/read") return Effect.succeed({ rateLimits: null });
              // The first read happens while the account service cannot be reached.
              return requests.filter((request) => request === "account/read").length === 1
                ? Effect.fail(new Error("workspace routing discovery failed"))
                : Effect.succeed({
                    account: {
                      workspaceName: null,
                      type: "chatgpt",
                      email: "agent@example.com",
                      planType: "pro",
                    },
                    requiresOpenaiAuth: false,
                  });
            }),
        } as unknown as CodexGateway["Service"];
        const context = yield* Layer.buildWithScope(
          accountLive({ pollInterval: "60 seconds" }).pipe(
            Layer.provide(
              Layer.merge(Layer.succeed(CodexGateway, gateway), executionHostAuthStateLive),
            ),
          ),
          yield* Scope.Scope,
        );
        const account = Context.get(context, CodexAccount);
        const settle = Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, {
          discard: true,
        });
        yield* SubscriptionRef.set(connection, { kind: "ready", hostId: "local", generation: 1 });
        yield* settle;
        assert.deepEqual(requests, ["account/read"]);
        assert.isNull((yield* SubscriptionRef.get(account.snapshot)).account);

        yield* TestClock.adjust("60 seconds");
        yield* settle;
        assert.deepEqual((yield* SubscriptionRef.get(account.snapshot)).account, {
          type: "chatgpt",
          email: "agent@example.com",
          planType: "pro",
        });
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "keeps the last usage reading through a failed read and folds sparse updates into it",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const events = yield* PubSub.unbounded<CodexEndpointEvent>();
          const state = { email: "agent@example.com", rateLimitsFail: false };
          const gateway = {
            localHostId: "local",
            events: Stream.fromPubSub(events),
            connectionChanges: () => Stream.empty,
            awaitReady: () => Effect.void,
            requestLocal: (method: string) =>
              Effect.suspend((): Effect.Effect<unknown, Error> => {
                if (method === "account/read")
                  return Effect.succeed({
                    account: {
                      workspaceName: null,
                      type: "chatgpt",
                      email: state.email,
                      planType: "pro",
                    },
                    requiresOpenaiAuth: false,
                  });
                if (method !== "account/rateLimits/read")
                  return Effect.fail(new Error(`Unexpected request: ${method}`));
                if (state.rateLimitsFail)
                  return Effect.fail(new Error("usage service unavailable"));
                return Effect.succeed({
                  ordinaryUsageAllowed: true,
                  rateLimits: {
                    limitId: "codex",
                    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1_800_000_000 },
                    secondary: {
                      usedPercent: 40,
                      windowDurationMins: 10_080,
                      resetsAt: 1_800_500_000,
                    },
                  },
                  rateLimitsByLimitId: null,
                  rateLimitResetCredits: null,
                });
              }),
          } as unknown as CodexGateway["Service"];
          const context = yield* Layer.buildWithScope(
            accountLive({ pollInterval: "60 seconds" }).pipe(
              Layer.provide(
                Layer.merge(Layer.succeed(CodexGateway, gateway), executionHostAuthStateLive),
              ),
            ),
            yield* Scope.Scope,
          );
          const account = Context.get(context, CodexAccount);
          const snapshot = SubscriptionRef.get(account.snapshot);
          const settle = Effect.gen(function* () {
            for (let attempt = 0; attempt < 20; attempt += 1) yield* Effect.yieldNow;
          });
          yield* TestClock.setTime(1_000_000);

          const first = yield* account.refresh;
          assert.strictEqual(first.rateLimits?.primary?.usedPercent, 25);
          assert.strictEqual(first.rateLimitsUpdatedAt, 1_000_000);
          assert.isFalse(first.rateLimitsReadFailed);

          // A failed poll keeps the reading and says it could not refresh it.
          state.rateLimitsFail = true;
          yield* TestClock.adjust("60 seconds");
          yield* settle;
          const failed = yield* snapshot;
          assert.strictEqual(failed.rateLimits?.secondary?.usedPercent, 40);
          assert.strictEqual(failed.rateLimitsUpdatedAt, 1_000_000);
          assert.isTrue(failed.rateLimitsReadFailed);

          // A sparse update changes only what it names, and counts as a fresh reading.
          const notify = (rateLimits: unknown) =>
            PubSub.publish(events, {
              kind: "notification",
              hostId: "local",
              generation: 1,
              value: { method: "account/rateLimits/updated", params: { rateLimits } },
            } as CodexEndpointEvent);
          yield* notify({
            limitId: "codex",
            primary: { usedPercent: 50, windowDurationMins: 300 },
          });
          yield* settle;
          const merged = yield* snapshot;
          assert.strictEqual(merged.rateLimits?.primary?.usedPercent, 50);
          assert.strictEqual(merged.rateLimits?.secondary?.usedPercent, 40);
          assert.strictEqual(merged.rateLimitsUpdatedAt, 1_060_000);
          assert.isFalse(merged.rateLimitsReadFailed);

          // Another metered limit's update never replaces this account's windows.
          yield* notify({
            limitId: "other",
            primary: { usedPercent: 99, windowDurationMins: 300 },
          });
          yield* settle;
          assert.strictEqual((yield* snapshot).rateLimits?.primary?.usedPercent, 50);

          // A different account never inherits the previous account's reading.
          state.email = "other@example.com";
          const switched = yield* account.refresh;
          assert.isNull(switched.rateLimits);
          assert.isNull(switched.rateLimitsUpdatedAt);
          assert.isTrue(switched.rateLimitsReadFailed);
        }),
      ),
  );

  it.effect(
    "pauses hidden Codex usage polling while preserving recovery and push notifications",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const meter = yield* SubscriptionRef.make(false);
          const events = yield* PubSub.unbounded<CodexEndpointEvent>();
          const requests: string[] = [];
          let unavailable = true;
          const gateway = {
            localHostId: "local",
            events: Stream.fromPubSub(events),
            connectionChanges: () => Stream.empty,
            awaitReady: () => Effect.void,
            requestLocal: (method: string) =>
              Effect.suspend((): Effect.Effect<unknown, Error> => {
                requests.push(method);
                if (method === "account/rateLimits/read")
                  return Effect.succeed({ rateLimits: { primary: { usedPercent: 25 } } });
                if (unavailable) return Effect.fail(new Error("Offline"));
                return Effect.succeed({
                  account: {
                    workspaceName: null,
                    type: "chatgpt",
                    email: "agent@example.com",
                    planType: "pro",
                  },
                  requiresOpenaiAuth: false,
                });
              }),
          } as unknown as CodexGateway["Service"];
          const context = yield* Layer.buildWithScope(
            accountLive({
              pollInterval: "60 seconds",
              meterEnabled: false,
              meterEnabledChanges: SubscriptionRef.changes(meter),
            }).pipe(
              Layer.provide(
                Layer.merge(Layer.succeed(CodexGateway, gateway), executionHostAuthStateLive),
              ),
            ),
            yield* Scope.Scope,
          );
          const account = Context.get(context, CodexAccount);
          const settle = Effect.forEach(Array.from({ length: 30 }), () => Effect.yieldNow, {
            discard: true,
          });
          yield* settle;
          yield* account.refresh.pipe(Effect.ignore);
          assert.strictEqual((yield* SubscriptionRef.get(account.snapshot)).status, "unavailable");
          unavailable = false;
          yield* TestClock.adjust("60 seconds");
          yield* settle;
          assert.strictEqual((yield* SubscriptionRef.get(account.snapshot)).status, "ready");
          assert.deepEqual(requests, ["account/read", "account/read"]);
          yield* TestClock.adjust("120 seconds");
          assert.deepEqual(requests, ["account/read", "account/read"]);
          yield* PubSub.publish(events, {
            kind: "notification",
            hostId: "local",
            value: {
              method: "account/rateLimits/updated",
              params: { rateLimits: { primary: { usedPercent: 42 } } },
            },
          } as CodexEndpointEvent);
          yield* settle;
          assert.strictEqual(
            (yield* SubscriptionRef.get(account.snapshot)).rateLimits?.primary?.usedPercent,
            42,
          );
          yield* PubSub.publish(events, {
            kind: "notification",
            hostId: "local",
            value: { method: "account/updated", params: { authMode: "chatgpt" } },
          } as CodexEndpointEvent);
          yield* settle;
          assert.deepEqual(requests, ["account/read", "account/read", "account/read"]);
          yield* SubscriptionRef.set(meter, true);
          yield* settle;
          assert.deepEqual(requests.slice(3), ["account/rateLimits/read"]);
          yield* SubscriptionRef.set(meter, true);
          yield* settle;
          assert.strictEqual(requests.length, 4);
          yield* SubscriptionRef.set(meter, false);
          yield* settle;
          yield* TestClock.adjust("120 seconds");
          assert.strictEqual(requests.length, 4);
          yield* SubscriptionRef.set(meter, true);
          yield* settle;
          assert.deepEqual(requests.slice(3), [
            "account/rateLimits/read",
            "account/rateLimits/read",
          ]);
        }),
      ).pipe(Effect.provide(TestClock.layer())),
  );
});

describe("ChatGptDesktop", () => {
  const token = (accountId: string) =>
    `x.${Buffer.from(JSON.stringify({ exp: 9999999999, "https://api.openai.com/auth": { chatgpt_account_id: accountId, user_id: "user-a" } })).toString("base64url")}.x`;
  const input = {
    baseUrl: "https://chatgpt.com/backend-api",
    path: "/dictation/custom_dictionary",
    method: "GET",
    action: "load dictionary",
    expectedAccount: { accountId: "account-a", userId: "user-a" },
  };
  const make = Effect.fn("ChatGptDesktopTest.make")(function* (
    fetch: ElectronNet["Service"]["fetch"],
    readAccount: (refresh: boolean) => string = () => "account-a",
    requirements: unknown = null,
  ) {
    const events = yield* PubSub.unbounded<CodexEndpointEvent>();
    const capability = createCodexAppServerCapabilitySnapshot({
      hostId: "local",
      generation: 1,
      userAgent: "codex-cli 0.155.0",
    });
    const gateway = CodexGateway.of({
      localHostId: "local",
      events: Stream.fromPubSub(events),
      requestLocal: (_method: string, params: { refreshToken?: boolean }) =>
        Effect.succeed({
          authMethod: "chatgpt",
          authToken: token(readAccount(params.refreshToken === true)),
          requiresOpenaiAuth: true,
        }),
      requestRawOnHost: (_host: string, method: string) =>
        Effect.succeed(
          method === "account/read"
            ? {
                account: { type: "chatgpt", planType: "pro" },
                workspaceRouting: {
                  chatgptAccountId: readAccount(false),
                  backendOrigin: "https://workspace.example",
                  accountRoutingOverride: "us",
                },
              }
            : { requirements },
        ),
    } as unknown as CodexGateway["Service"]);
    const context = yield* Layer.build(
      live.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            authStateLive,
            Layer.succeed(CodexGateway, gateway),
            Layer.succeed(CodexWorkspaceRouting, {
              discover: () => Effect.die("unexpected companion"),
            }),
            Layer.succeed(CodexAppServerCapabilities, {
              forHost: () => Effect.succeed(capability),
              forThread: () => Effect.succeed(capability),
              isCurrent: () => Effect.succeed(true),
            }),
            Layer.succeed(ElectronNet, {
              appVersion: "1.0.0",
              fetch,
              readBase64: () => Effect.die("unused"),
            }),
          ),
        ),
      ),
    );
    return {
      desktop: Context.get(context, ChatGptDesktop),
      authState: Context.get(context, CodexExecutionHostAuthState),
      events,
    };
  });

  it.effect("routes account-bound requests and never retries a refusal", () =>
    Effect.gen(function* () {
      let count = 0;
      const { desktop } = yield* make((url, init) =>
        Effect.sync(() => {
          count += 1;
          assert.strictEqual(
            url,
            "https://workspace.example/backend-api/dictation/custom_dictionary",
          );
          assert.strictEqual(init.redirect, "error");
          assert.strictEqual(
            new Headers(init.headers).get("X-OpenAI-Account-Routing-Override"),
            "us",
          );
          return new Response(null, { status: 403 });
        }),
      );
      assert.strictEqual((yield* desktop.request(input)).status, 403);
      assert.strictEqual(count, 1);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            desktop.request({
              ...input,
              expectedAccount: { accountId: "account-b", userId: "user-a" },
            }),
          ),
        ),
      );
      assert.strictEqual(count, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels the first response before the one allowed token refresh", () =>
    Effect.gen(function* () {
      let count = 0;
      let canceled = false;
      const { desktop } = yield* make(
        () =>
          Effect.sync(() => {
            count += 1;
            return count === 1
              ? new Response(
                  new ReadableStream({
                    cancel: () => {
                      canceled = true;
                    },
                  }),
                  { status: 401 },
                )
              : new Response(null, { status: 200 });
          }),
        (refresh) => {
          if (refresh) assert.isTrue(canceled);
          return "account-a";
        },
      );
      assert.strictEqual((yield* desktop.request(input)).status, 200);
      assert.strictEqual(count, 2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects same-user workspace drift during refresh without sending a second request",
    () =>
      Effect.gen(function* () {
        let count = 0;
        let account = "account-a";
        const { desktop } = yield* make(
          () =>
            Effect.sync(() => {
              count += 1;
              return new Response(null, { status: 401 });
            }),
          (refresh) => {
            if (refresh) account = "account-b";
            return account;
          },
        );
        assert.isTrue(Exit.isFailure(yield* Effect.exit(desktop.request(input))));
        assert.strictEqual(count, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("aborts an outstanding response body when its account changes", () =>
    Effect.gen(function* () {
      let account = "account-a";
      const { desktop, events } = yield* make(
        () => Effect.succeed(new Response(new ReadableStream())),
        () => account,
      );
      const response = yield* desktop.request(input);
      const body = response.text().then(
        () => false,
        () => true,
      );
      account = "account-b";
      yield* PubSub.publish(events, {
        kind: "notification",
        hostId: "local",
        generation: 1,
        value: {
          protocol: "generated",
          method: "account/updated",
          params: { authMode: "chatgpt", planType: "pro" },
        },
      });
      assert.isTrue(yield* Effect.promise(() => body));
    }).pipe(Effect.scoped),
  );

  it.effect("fences response bodies and new requests before account mutation notifications", () =>
    Effect.gen(function* () {
      let count = 0;
      const { desktop, authState } = yield* make(() =>
        Effect.sync(() => {
          count += 1;
          return new Response(new ReadableStream());
        }),
      );
      const response = yield* desktop.request(input);
      const body = response.text().then(
        () => false,
        () => true,
      );
      const started = yield* Deferred.make<void>();
      const done = yield* Deferred.make<void>();
      const mutation = yield* authState
        .withAccountMutation(
          "local",
          "account/sessions/switch",
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(done))),
        )
        .pipe(Effect.forkScoped);
      yield* Deferred.await(started);
      assert.isTrue(yield* Effect.promise(() => body));
      const request = yield* desktop.request(input).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      assert.strictEqual(count, 1);
      yield* Deferred.succeed(done, undefined);
      yield* Fiber.join(mutation);
      yield* Fiber.join(request);
      assert.strictEqual(count, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("prepares desktop stream headers and routing without an HTTP request", () =>
    Effect.gen(function* () {
      let calls = 0;
      const { desktop, authState } = yield* make(() => {
        calls += 1;
        return Effect.die("Streaming preparation must not fetch");
      });
      const prepared = yield* desktop.prepareRequest({
        ...input,
        path: "/dictation/stream?dictation_surface=composer",
        headers: { "Accept-Language": "zh-CN", "ChatGPT-Account-Id": "incorrect" },
      });
      assert.strictEqual(
        prepared.url,
        "https://workspace.example/backend-api/dictation/stream?dictation_surface=composer",
      );
      assert.strictEqual(prepared.headers.get("Authorization"), `Bearer ${token("account-a")}`);
      assert.strictEqual(prepared.headers.get("ChatGPT-Account-Id"), "account-a");
      assert.strictEqual(prepared.headers.get("originator"), "Codex Desktop");
      assert.isTrue(
        prepared.headers.get("User-Agent")?.startsWith("Codex Desktop/1.0.0 (") ?? false,
      );
      assert.strictEqual(prepared.headers.get("Accept-Language"), "zh-CN");
      assert.strictEqual(prepared.headers.get("X-OpenAI-Account-Routing-Override"), "us");
      assert.strictEqual(calls, 0);
      assert.isFalse(prepared.signal.aborted);
      yield* authState.withAccountMutation("local", "account/sessions/switch", Effect.void);
      assert.isTrue(prepared.signal.aborted);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "applies destination permissions to the workspace route before HTTP or stream preparation",
    () =>
      Effect.gen(function* () {
        let calls = 0;
        const { desktop } = yield* make(
          () => {
            calls += 1;
            return Effect.succeed(new Response(null));
          },
          () => "account-a",
          {
            application: {
              network: {
                enabled: true,
                domains: { "chatgpt.com": "allow", "workspace.example": "deny" },
              },
            },
          },
        );
        const deniedStream = yield* Effect.flip(
          desktop.prepareRequest({
            ...input,
            path: "/dictation/stream?dictation_surface=composer",
          }),
        );
        assert.strictEqual(deniedStream._tag, "ChatGptBackendAuthError");
        const deniedHttp = yield* Effect.flip(desktop.request(input));
        assert.strictEqual(deniedHttp._tag, "ChatGptBackendAuthError");
        assert.strictEqual(calls, 0);
        const allowed = yield* make(
          () => {
            calls += 1;
            return Effect.succeed(new Response(null));
          },
          () => "account-a",
          {
            application: {
              network: {
                enabled: true,
                domains: { "chatgpt.com": "deny", "workspace.example": "allow" },
              },
            },
          },
        );
        assert.strictEqual((yield* allowed.desktop.request(input)).status, 200);
        assert.strictEqual(calls, 1);
      }).pipe(Effect.scoped),
  );
});

describe("AgentImportRuntime", () => {
  const temporaryRoot = Effect.acquireRelease(
    Effect.sync(() => mkdtempSync(path.join(tmpdir(), "nodex-agent-setup-import-"))),
    (root) => Effect.sync(() => rmSync(root, { force: true, recursive: true })),
  );

  const write = (file: string, contents: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, contents);
  };

  const prepareSource = (root: string) => {
    const sourceHome = path.join(root, "source", ".codex");
    const codexHome = path.join(root, "target", ".codex");
    const rollout = JSON.stringify({
      type: "session_meta",
      payload: { id: "019c0000-0000-7000-8000-000000000003", cwd: path.join(root, "missing") },
    });
    const sessionPath = path.join(sourceHome, "sessions", "rollout.jsonl");
    const archivePath = path.join(sourceHome, "archived_sessions", "rollout.jsonl");
    write(sessionPath, rollout);
    write(archivePath, rollout);
    mkdirSync(codexHome, { recursive: true });
    return { sourceHome, codexHome, sessionPath, archivePath, rollout };
  };

  const makeHarness = (
    codexHome: string,
    sourceHome: string,
    migrations: readonly ExternalAgentConfigMigrationItem[] = [],
  ) => {
    const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
    const externalImports: Array<readonly ExternalAgentConfigMigrationItem[]> = [];
    const unsupported = () => Effect.die(new Error("Unexpected setup import gateway operation"));
    const gateway = CodexGateway.of({
      events: Stream.empty,
      localHostId: "local",
      promoteQueuedCatalogPage: unsupported(),
      requestLocal: ((method: string, params: unknown) =>
        Effect.sync(() => {
          requests.push({ method, params });
          if (method === "externalAgentConfig/detect") return { items: migrations };
          if (method === "config/batchWrite") return {};
          throw new Error(`Unexpected setup import request: ${method}`);
        })) as CodexGateway["Service"]["requestLocal"],
      requestOnHost: unsupported,
      requestRawOnHost: unsupported,
      requestForThread: unsupported,
      requestRawForThread: unsupported,
      notifyLocal: unsupported,
      connection: unsupported,
      connectionChanges: () =>
        Stream.die(new Error("Unexpected setup import gateway subscription")),
      awaitReady: unsupported,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: unsupported,
    });
    return {
      requests,
      externalImports,
      runtime: make({
        codexHome,
        sourceHomes: { codex: sourceHome, "claude-code": sourceHome },
      }).pipe(
        Effect.provideService(CodexGateway, gateway),
        Effect.provideService(
          CodexExternalAgentImportRuntime,
          CodexExternalAgentImportRuntime.of({
            run: (items) =>
              Effect.sync(() => {
                externalImports.push(items);
                return {
                  importId: "external-setup",
                  itemTypeResults: items.map(({ itemType, cwd }) => ({
                    itemType,
                    failures: [],
                    successes: [{ itemType, cwd, source: null, target: null, title: null }],
                  })),
                };
              }),
          }),
        ),
      ),
    };
  };

  it.effect(
    "copies selected setup without importing or changing conversations from that home",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRoot;
          const source = prepareSource(root);
          write(path.join(source.sourceHome, "AGENTS.md"), "Use the shared project conventions.\n");
          write(path.join(source.sourceHome, "skills", "review", "SKILL.md"), "Review a change.\n");
          const harness = makeHarness(source.codexHome, source.sourceHome);
          const runtime = yield* harness.runtime;
          const scan = yield* runtime.scan("codex", source.sourceHome);
          assert.deepEqual(
            scan.items.map(({ kind }) => kind),
            ["instructions", "skills"],
          );

          const result = yield* runtime.apply({
            scanId: scan.scanId,
            itemIds: scan.items.map(({ id }) => id),
          });
          assert.deepEqual(
            result.outcomes.map(({ successCount }) => successCount),
            [1, 1],
          );
          assert.strictEqual(
            readFileSync(path.join(source.codexHome, "AGENTS.md"), "utf8"),
            "Use the shared project conventions.\n",
          );
          assert.strictEqual(
            readFileSync(
              path.join(path.dirname(source.codexHome), ".agents", "skills", "review", "SKILL.md"),
              "utf8",
            ),
            "Review a change.\n",
          );
          assert.strictEqual(readFileSync(source.sessionPath, "utf8"), source.rollout);
          assert.strictEqual(readFileSync(source.archivePath, "utf8"), source.rollout);
          assert.isFalse(existsSync(path.join(source.codexHome, "sessions")));
          assert.deepEqual(harness.requests, []);
          assert.deepEqual(harness.externalImports, []);
          const retry = yield* Effect.flip(
            runtime.apply({ scanId: scan.scanId, itemIds: scan.items.map(({ id }) => id) }),
          );
          assert.strictEqual(retry.reason, "expired-scan");
          assert.deepEqual((yield* runtime.scan("codex", source.sourceHome)).items, []);
        }),
      ),
  );

  it.effect(
    "leaves active-home configuration and history unchanged when there is nothing to copy",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* temporaryRoot;
          const source = prepareSource(root);
          const config = "model = 'native-model'\n";
          write(path.join(source.sourceHome, "config.toml"), config);
          const harness = makeHarness(source.sourceHome, source.sourceHome);
          const runtime = yield* harness.runtime;
          assert.deepEqual((yield* runtime.scan("codex")).items, []);
          assert.strictEqual(
            readFileSync(path.join(source.sourceHome, "config.toml"), "utf8"),
            config,
          );
          assert.strictEqual(readFileSync(source.sessionPath, "utf8"), source.rollout);
          assert.deepEqual(harness.requests, []);
        }),
      ),
  );

  it.effect("submits only Claude setup categories even when detection includes conversations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* temporaryRoot;
        const source = prepareSource(root);
        const instructions: ExternalAgentConfigMigrationItem = {
          itemType: "AGENTS_MD",
          description: "Instructions",
          cwd: null,
          details: null,
        };
        const sessions: ExternalAgentConfigMigrationItem = {
          itemType: "SESSIONS",
          description: "Conversations",
          cwd: null,
          details: null,
        };
        const harness = makeHarness(source.codexHome, source.sourceHome, [sessions, instructions]);
        const runtime = yield* harness.runtime;
        const scan = yield* runtime.scan("claude-code");
        assert.deepEqual(
          scan.items.map(({ kind }) => kind),
          ["instructions"],
        );
        const rejected = yield* Effect.flip(
          runtime.apply({ scanId: scan.scanId, itemIds: ["sessions"] }),
        );
        assert.strictEqual(rejected.reason, "apply-failed");
        assert.deepEqual(harness.externalImports, []);
        const result = yield* runtime.apply({
          scanId: scan.scanId,
          itemIds: scan.items.map(({ id }) => id),
        });
        assert.deepEqual(harness.externalImports, [[instructions]]);
        assert.strictEqual(result.outcomes[0]?.successCount, 1);
        assert.deepEqual(
          harness.requests.map(({ method }) => method),
          ["externalAgentConfig/detect"],
        );
      }),
    ),
  );
});

describe("CodexExternalAgentImportRuntime", () => {
  const make = makeCodexExternalAgentImportRuntime;
  const notification = (
    method: "externalAgentConfig/import/progress" | "externalAgentConfig/import/completed",
    importId: string,
    hostId = "local",
  ): CodexEndpointEvent => ({
    kind: "notification",
    generation: 1,
    hostId,
    value: { protocol: "generated", method, params: { importId, itemTypeResults: [] } },
  });

  const makeGateway = (
    events: Stream.Stream<CodexEndpointEvent>,
    request: () => Effect.Effect<{ readonly importId: string }>,
  ): CodexGateway["Service"] =>
    CodexGateway.of({
      localHostId: "local",
      events,
      requestLocal: ((_method: string, _params: unknown) =>
        request()) as CodexGateway["Service"]["requestLocal"],
    } as CodexGateway["Service"]);

  it.effect("buffers completion that arrives before the import response", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const runtime = yield* make().pipe(
        Effect.provideService(
          CodexGateway,
          makeGateway(Stream.fromPubSub(events), () =>
            PubSub.publish(
              events,
              notification("externalAgentConfig/import/completed", "remote", "ssh"),
            ).pipe(
              Effect.andThen(
                PubSub.publish(
                  events,
                  notification("externalAgentConfig/import/progress", "import-1"),
                ),
              ),
              Effect.andThen(
                PubSub.publish(
                  events,
                  notification("externalAgentConfig/import/completed", "import-1"),
                ),
              ),
              Effect.as({ importId: "import-1" }),
            ),
          ),
        ),
      );

      const completed = yield* runtime.run([]);
      assert.strictEqual(completed.importId, "import-1");
    }),
  );

  it.effect("serializes import admission so pre-response notifications cannot cross-talk", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const firstRequested = yield* Deferred.make<void>();
      const secondRequested = yield* Deferred.make<void>();
      let requestCount = 0;
      const runtime = yield* make().pipe(
        Effect.provideService(
          CodexGateway,
          makeGateway(Stream.fromPubSub(events), () => {
            requestCount += 1;
            return Deferred.succeed(
              requestCount === 1 ? firstRequested : secondRequested,
              undefined,
            ).pipe(Effect.as({ importId: `import-${requestCount}` }));
          }),
        ),
      );
      const first = yield* Effect.forkChild(runtime.run([]));
      yield* Deferred.await(firstRequested);
      const second = yield* Effect.forkChild(runtime.run([]));
      yield* Effect.yieldNow;
      assert.strictEqual(requestCount, 1);

      yield* PubSub.publish(
        events,
        notification("externalAgentConfig/import/completed", "import-1"),
      );
      yield* Fiber.join(first);
      yield* Deferred.await(secondRequested);
      assert.strictEqual(requestCount, 2);
      yield* PubSub.publish(
        events,
        notification("externalAgentConfig/import/completed", "import-2"),
      );
      yield* Fiber.join(second);
    }),
  );

  it.effect("uses the Effect clock for the sole completion deadline", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const runtime = yield* make({ timeout: "2 seconds" }).pipe(
        Effect.provideService(
          CodexGateway,
          makeGateway(Stream.fromPubSub(events), () =>
            Effect.succeed({ importId: "import-timeout" }),
          ),
        ),
      );
      const timedOut = yield* Effect.forkChild(runtime.run([]).pipe(Effect.flip));
      yield* TestClock.adjust("1999 millis");
      yield* TestClock.adjust("1 millis");
      const error = yield* Fiber.join(timedOut);
      assert.strictEqual(error.reason, "timeout");
      assert.strictEqual(error.message, "Timed out waiting for Claude Code import to finish");
    }),
  );

  it.effect("interrupts an active import when the Main Scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const events = yield* PubSub.unbounded<CodexEndpointEvent>();
      const requested = yield* Deferred.make<void>();
      const runtime = yield* make().pipe(
        Effect.provideService(
          CodexGateway,
          makeGateway(Stream.fromPubSub(events), () =>
            Deferred.succeed(requested, undefined).pipe(Effect.as({ importId: "import-closing" })),
          ),
        ),
        Effect.provideService(Scope.Scope, scope),
      );
      const closed = yield* Effect.forkChild(runtime.run([]).pipe(Effect.flip));
      yield* Deferred.await(requested);
      yield* Scope.close(scope, Exit.void);
      assert.strictEqual((yield* Fiber.join(closed)).reason, "runtime-closed");
    }),
  );
});

describe("CodexAttestation", () => {
  const signals = buildCodexAttestationSignals({
    appSessionId: "session-123",
    displayHeight: 900,
    displayWidth: 1600,
    locale: "en-US",
    preferredLanguages: ["en-US", "zh-CN"],
    screenScale: 2,
    timezone: "America/Los_Angeles",
  });

  it("matches desktop attestation capability support", () => {
    assert.isTrue(supportsCodexAttestationRequests("darwin"));
    assert.isTrue(supportsCodexAttestationRequests("win32"));
    assert.isFalse(supportsCodexAttestationRequests("linux"));
  });

  it("bounds attestation signals before serialization", () => {
    const bounded = buildCodexAttestationSignals({
      appSessionId: "s".repeat(200),
      displayHeight: 900.2,
      displayWidth: 1599.7,
      locale: "",
      preferredLanguages: Array.from({ length: 20 }, (_, index) => `${index}-${"x".repeat(100)}`),
      screenScale: 1.5,
      timezone: "z".repeat(100),
    });
    assert.strictEqual(bounded.schemaVersion, 1);
    assert.strictEqual(bounded.locale, "unknown");
    assert.strictEqual(bounded.preferredLanguages.length, 16);
    assert.strictEqual(bounded.preferredLanguages[0]?.length, 64);
    assert.strictEqual(bounded.timezone.length, 64);
    assert.strictEqual(bounded.screenSizeSum, 2500);
    assert.strictEqual(bounded.screenScale, 1.5);
    assert.strictEqual(bounded.appSessionId.length, 128);
  });

  it("encodes the wire token with deterministic CBOR field order", () => {
    assert.strictEqual(
      encodeCodexAttestationToken({
        bundleIdentifier: "app.jyu.nodex",
        errorCode: 2,
        signals,
        latencyMs: 1.5,
      }),
      "v1.pGplcnJvcl9jb2RlAmlidW5kbGVfaWRtYXBwLmp5dS5ub2RleGFmWECnAAEBgmVlbi1VU2V6aC1DTgJlZW4tVVMDc0FtZXJpY2EvTG9zX0FuZ2VsZXMEGQnEBQIGa3Nlc3Npb24tMTIzYXT7P_gAAAAAAAA",
    );
  });

  it("always encodes DeviceCheck latency as float64", () => {
    const token = encodeCodexAttestationToken({
      bundleIdentifier: "app.jyu.nodex",
      errorCode: 3,
      latencyMs: 11,
    });
    const payload = Buffer.from(token.slice(3), "base64url");
    const latencyKey = payload.indexOf(Buffer.from("t"));
    assert.isTrue(latencyKey >= 0);
    assert.strictEqual(payload[latencyKey + 1], 0xfb);
  });

  it.effect("returns the native DeviceCheck token on Apple silicon", () =>
    Effect.gen(function* () {
      const attestation = makeCodexAttestation({
        platform: "darwin",
        architecture: "arm64",
        bundleIdentifier: "app.jyu.nodex",
        getSignals: () => signals,
        generateDeviceCheckToken: () =>
          Promise.resolve({ supported: true, tokenBase64: "device-token", latencyMs: 7.25 }),
      });
      const response = yield* attestation.generate;
      assert.isTrue(response.token.startsWith("v1."));
      const payload = Buffer.from(response.token.slice(3), "base64url");
      assert.isTrue(payload.includes(Buffer.from("device-token")));
      assert.isTrue(payload.includes(Buffer.from("app.jyu.nodex")));
    }),
  );

  it.effect("returns protocol error tokens for unsupported desktop combinations", () =>
    Effect.gen(function* () {
      const linux = makeCodexAttestation({
        platform: "linux",
        architecture: "x64",
        bundleIdentifier: "app.jyu.nodex",
        getSignals: () => {
          throw new Error("unsupported platforms do not collect signals");
        },
      });
      const intelMac = makeCodexAttestation({
        platform: "darwin",
        architecture: "x64",
        bundleIdentifier: "app.jyu.nodex",
        getSignals: () => signals,
      });
      const linuxToken = (yield* linux.generate).token;
      const intelToken = (yield* intelMac.generate).token;
      assert.isTrue(
        Buffer.from(linuxToken.slice(3), "base64url").includes(Buffer.from("error_code")),
      );
      assert.isFalse(
        Buffer.from(linuxToken.slice(3), "base64url").includes(Buffer.from("session-123")),
      );
      assert.isTrue(
        Buffer.from(intelToken.slice(3), "base64url").includes(Buffer.from("session-123")),
      );
    }),
  );
});
