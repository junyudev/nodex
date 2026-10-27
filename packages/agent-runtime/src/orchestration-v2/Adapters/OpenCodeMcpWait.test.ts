import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import { OpenCodeSettings } from "@t3tools/provider-opencode/settings";
import { makeOpenCodeAdapterV2 } from "../../../vendor/provider-opencode/src/server/adapter.ts";

it.effect(
  "registers the private application MCP call budget without changing an external server",
  () =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.McpProviderSessions;
      const threadId = ThreadId.make("thread:mcp-budget");
      const instanceId = ProviderInstanceId.make("opencode-mcp-budget");
      yield* sessions.set({
        environmentId: EnvironmentId.make("environment:mcp-budget"),
        threadId,
        providerSessionId: "mcp-budget",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer private-thread-credential",
        browserToolsAvailable: false,
      });
      const registrations: unknown[] = [];
      for (const external of [false, true]) {
        const adapter = yield* makeOpenCodeAdapterV2({
          instanceId,
          settings: Schema.decodeSync(OpenCodeSettings)({}),
          environment: {},
        }).pipe(
          Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
            connectToOpenCodeServer: () =>
              Effect.succeed({ url: "http://test.invalid", external, exitCode: null }),
            createOpenCodeSdkClient: () => ({
              mcp: {
                add: async (input: unknown) => {
                  registrations.push(input);
                  return { data: true };
                },
              },
              event: {
                subscribe: async (_input: unknown, options: { signal: AbortSignal }) => ({
                  stream: {
                    [Symbol.asyncIterator]() {
                      return {
                        next: () =>
                          new Promise<IteratorResult<never>>((resolve) =>
                            options.signal.addEventListener(
                              "abort",
                              () => resolve({ done: true, value: undefined }),
                              { once: true },
                            ),
                          ),
                      };
                    },
                  },
                }),
              },
            }),
          } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
          Effect.provideService(ProviderHost.ProviderHost, {
            paths: { cwd: "/workspace" },
          } as unknown as ProviderHost.ProviderHost["Service"]),
        );
        yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make(`session:${external}`),
          modelSelection: { instanceId, model: "anthropic/claude-sonnet", options: [] },
          runtimePolicy: ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          }),
        });
      }
      assert.deepEqual(registrations, [
        {
          name: "nodex_app",
          config: {
            type: "remote",
            url: "http://127.0.0.1:3773/mcp",
            headers: { Authorization: "Bearer private-thread-credential" },
            oauth: false,
            timeout: 3_670_000,
          },
        },
      ]);
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, Sessions.layer)), Effect.scoped),
);
