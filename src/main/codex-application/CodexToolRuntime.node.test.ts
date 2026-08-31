import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { assert, it } from "@effect/vitest";
import type { CodexAccountSnapshot } from "../../shared/types";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CodexAccount } from "./CodexAccount";
import { CodexToolRuntime, live as codexToolRuntimeLive } from "./CodexToolRuntime";
import { emptyAccountSnapshot } from "./CodexAccountState";

it.effect("gates app discovery and coalesces concurrent status reads", () =>
  Effect.gen(function* () {
    const statusResponse = yield* Deferred.make<unknown>();
    let statusRequests = 0;
    const statusParams: unknown[] = [];
    const requestLocal = ((method: string, params: unknown) => {
      if (method === "app/list") {
        const cursor = (params as { cursor?: string | null }).cursor;
        return Effect.succeed({
          data:
            cursor === null
              ? [
                  {
                    id: "app-a",
                    name: "App A",
                    description: null,
                    logoUrl: "https://example.com/app.png",
                    logoUrlDark: null,
                    iconAssets: null,
                    iconDarkAssets: null,
                    distributionChannel: null,
                    branding: null,
                    appMetadata: null,
                    labels: null,
                    installUrl: null,
                    isAccessible: true,
                    isEnabled: true,
                    pluginDisplayNames: [],
                  },
                ]
              : [],
          nextCursor: cursor === null ? "next" : null,
        });
      }
      if (method === "mcpServerStatus/list") {
        statusRequests += 1;
        statusParams.push(params);
        return Deferred.await(statusResponse);
      }
      if (method === "mcpServer/resource/read") {
        return Effect.succeed({ contents: [], originCallId: null });
      }
      if (method === "mcpServer/tool/call") return Effect.succeed({ content: [] });
      throw new Error(`Unexpected request: ${method}`);
    }) as CodexGateway["Service"]["requestLocal"];
    const unsupported = () => Effect.die(new Error("Unsupported test operation"));
    const gateway = CodexGateway.of({
      localHostId: "local",
      requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
      requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
      events: Stream.empty,
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
    const accountSnapshot = yield* SubscriptionRef.make<CodexAccountSnapshot>({
      ...emptyAccountSnapshot(),
      account: { type: "chatgpt" as const, email: "agent@example.com", planType: "plus" },
    });
    const account = CodexAccount.of({
      snapshot: accountSnapshot,
      refresh: unsupported(),
      consumeRateLimitResetCredit: unsupported,
      startLogin: unsupported,
      cancelLogin: unsupported,
      logout: unsupported(),
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      codexToolRuntimeLive({ supportsChatGptApps: true }).pipe(
        Layer.provide(
          Layer.merge(Layer.succeed(CodexGateway, gateway), Layer.succeed(CodexAccount, account)),
        ),
      ),
      scope,
    );
    const runtime = Context.get(context, CodexToolRuntime);

    assert.deepEqual(
      (yield* runtime.listApps).map((app) => app.id),
      ["app-a"],
    );
    assert.deepEqual(yield* runtime.readResource({ server: "docs", uri: "docs://effect" }), {
      contents: [],
      originCallId: null,
    });
    assert.deepEqual(
      yield* runtime.callTool({
        threadId: "thread-1",
        server: "docs",
        tool: "search",
        arguments: { query: "Effect" },
      }),
      { content: [] },
    );
    const first = yield* runtime.listServerStatuses().pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    const second = yield* runtime.listServerStatuses().pipe(Effect.forkScoped);
    yield* Effect.yieldNow;
    assert.strictEqual(statusRequests, 1);
    yield* Deferred.succeed(statusResponse, { data: [], nextCursor: null });
    assert.deepEqual(yield* Fiber.join(first), { data: [], nextCursor: null });
    assert.deepEqual(yield* Fiber.join(second), { data: [], nextCursor: null });
    assert.deepEqual(yield* runtime.listServerStatuses("thread-1"), {
      data: [],
      nextCursor: null,
    });
    assert.strictEqual(statusRequests, 2);
    assert.deepEqual(statusParams, [
      { cursor: null, detail: "full", limit: 100 },
      { cursor: null, detail: "full", limit: 100, threadId: "thread-1" },
    ]);

    yield* Scope.close(scope, Exit.void);
  }),
);
