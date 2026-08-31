import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ProviderCredentials } from "../platform/electron/ProviderCredentials";
import {
  AgentProviderRuntime,
  CODEX_IDLE_CHECK_MAX_THREAD_PAGES,
  live as agentProviderRuntimeLive,
} from "./AgentProviderRuntime";

const unsupported = () => Effect.die(new Error("Unsupported test operation"));

const model = {
  id: "gpt-5.5",
  model: "gpt-5.5",
  displayName: "GPT-5.5",
  description: "",
  hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: "high", description: "" }],
  defaultReasoningEffort: "high",
  inputModalities: ["text"],
  serviceTiers: [{ id: "fast", name: "Fast", description: "Faster" }],
  defaultServiceTier: null,
  isDefault: true,
};

it.effect("owns provider discovery, profile resolution, and deferred credential restart", () =>
  Effect.gen(function* () {
    let active = true;
    let restarts = 0;
    let stored = false;
    const requestRawOnHost = ((_hostId: string, method: string, params: unknown) => {
      if (method === "interpreter/provider/list") {
        return Effect.succeed({
          data: [
            {
              id: "openai",
              name: "OpenAI",
              description: "",
              isCurrent: true,
              wireApi: "responses",
              configured: true,
              isDefault: true,
            },
          ],
        });
      }
      if (method === "interpreter/model/list") return Effect.succeed({ data: [model] });
      if (method === "interpreter/harness/list") {
        return Effect.succeed({
          data: [{ id: null, label: "Native", description: "", isRecommended: true }],
        });
      }
      throw new Error(`Unexpected raw request: ${method} ${JSON.stringify(params)}`);
    }) as CodexGateway["Service"]["requestRawOnHost"];
    const requestLocal = ((method: string, params: unknown) => {
      if (method === "thread/list") {
        return Effect.succeed({
          data: active
            ? [
                {
                  id: "thread-1",
                  status: { type: "active", activeFlags: [] },
                },
              ]
            : [],
          nextCursor: null,
        });
      }
      throw new Error(`Unexpected request: ${method} ${JSON.stringify(params)}`);
    }) as CodexGateway["Service"]["requestLocal"];
    const gateway = CodexGateway.of({
      localHostId: "local",
      requestRawOnHost,
      requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
      events: Stream.empty,
      requestLocal,
      requestOnHost: unsupported,
      requestForThread: unsupported,
      notifyLocal: unsupported,
      connection: unsupported,
      connectionChanges: () => Stream.empty,
      awaitReady: () => Effect.void,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: () => Effect.sync(() => void (restarts += 1)),
    });
    const credentials = ProviderCredentials.of({
      status: (providerId) =>
        Effect.succeed(providerId === "openai" || stored ? "runtimeManaged" : "missing"),
      set: () => Effect.sync(() => void (stored = true)),
      remove: () => Effect.sync(() => void (stored = false)),
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      agentProviderRuntimeLive.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, gateway),
            Layer.succeed(ProviderCredentials, credentials),
          ),
        ),
      ),
      scope,
    );
    const runtime = Context.get(context, AgentProviderRuntime);

    const catalog = yield* runtime.list();
    assert.strictEqual(catalog.providers[0]?.models[0]?.modelId, "gpt-5.5");
    assert.deepEqual(
      yield* runtime.resolveExecutionProfile({
        providerId: "openai",
        modelId: "gpt-5.5",
        harnessId: null,
        reasoningEffort: null,
        serviceTier: "fast",
      }),
      {
        providerId: "openai",
        modelId: "gpt-5.5",
        harnessId: null,
        reasoningEffort: "high",
        serviceTier: "fast",
      },
    );
    assert.deepEqual(yield* runtime.setCredential({ providerId: "openai", apiKey: "key" }), {
      providerId: "openai",
      status: "runtimeManaged",
      runtimeRestartPending: true,
    });
    assert.strictEqual(restarts, 0);
    active = false;
    yield* runtime.ensureRuntimeReady;
    assert.strictEqual(restarts, 1);

    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("keeps runtime restart pending when the bounded idle scan is incomplete", () =>
  Effect.gen(function* () {
    let idlePageCount = 0;
    let restarts = 0;
    const gateway = CodexGateway.of({
      localHostId: "local",
      requestRawOnHost: unsupported,
      requestRawForThread: unsupported,
      events: Stream.empty,
      requestLocal: ((method: string) => {
        if (method !== "thread/list") return unsupported();
        idlePageCount += 1;
        return Effect.succeed({
          data: [],
          nextCursor: `cursor-${idlePageCount}`,
        });
      }) as CodexGateway["Service"]["requestLocal"],
      requestOnHost: unsupported,
      requestForThread: unsupported,
      notifyLocal: unsupported,
      connection: unsupported,
      connectionChanges: () => Stream.empty,
      awaitReady: () => Effect.void,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: () => Effect.sync(() => void (restarts += 1)),
    });
    const credentials = ProviderCredentials.of({
      status: () => Effect.succeed("ready"),
      set: () => Effect.void,
      remove: () => Effect.void,
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      agentProviderRuntimeLive.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, gateway),
            Layer.succeed(ProviderCredentials, credentials),
          ),
        ),
      ),
      scope,
    );
    const runtime = Context.get(context, AgentProviderRuntime);

    const result = yield* runtime.setCredential({ providerId: "openai", apiKey: "key" });

    assert.strictEqual(result.runtimeRestartPending, true);
    assert.strictEqual(idlePageCount, CODEX_IDLE_CHECK_MAX_THREAD_PAGES);
    assert.strictEqual(restarts, 0);
    yield* Scope.close(scope, Exit.void);
  }),
);

it.effect("serializes credential publication with runtime reload consequences", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const events: string[] = [];
    const gateway = CodexGateway.of({
      localHostId: "local",
      requestRawOnHost: () => Effect.die(new Error("Unsupported raw host request")),
      requestRawForThread: () => Effect.die(new Error("Unsupported raw request")),
      events: Stream.empty,
      requestLocal: ((method: string) => {
        if (method === "thread/list") return Effect.succeed({ data: [], nextCursor: null });
        return unsupported();
      }) as CodexGateway["Service"]["requestLocal"],
      requestOnHost: unsupported,
      requestForThread: unsupported,
      notifyLocal: unsupported,
      connection: unsupported,
      connectionChanges: () => Stream.empty,
      awaitReady: () => Effect.void,
      reconcileHost: unsupported,
      removeHost: unsupported,
      restartHost: () => Effect.void,
    });
    const credentials = ProviderCredentials.of({
      status: () => Effect.succeed("ready"),
      set: () =>
        Effect.gen(function* () {
          events.push("set:start");
          yield* Deferred.succeed(firstStarted, undefined);
          yield* Deferred.await(releaseFirst);
          events.push("set:end");
        }),
      remove: () => Effect.sync(() => events.push("remove")),
    });
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      agentProviderRuntimeLive.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CodexGateway, gateway),
            Layer.succeed(ProviderCredentials, credentials),
          ),
        ),
      ),
      scope,
    );
    const runtime = Context.get(context, AgentProviderRuntime);
    const setting = yield* Effect.forkChild(
      runtime.setCredential({ providerId: "openrouter", apiKey: "key" }),
    );
    yield* Deferred.await(firstStarted);
    const deleting = yield* Effect.forkChild(
      runtime.deleteCredential({ providerId: "openrouter" }),
    );
    yield* Effect.yieldNow;
    assert.deepEqual(events, ["set:start"]);

    yield* Deferred.succeed(releaseFirst, undefined);
    yield* Fiber.join(setting);
    yield* Fiber.join(deleting);
    assert.deepEqual(events, ["set:start", "set:end", "remove"]);
    yield* Scope.close(scope, Exit.void);
  }),
);
