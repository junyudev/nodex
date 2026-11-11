import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  RunAttemptId,
  type OrchestrationV2AppThread,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Queue from "effect/Queue";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sessions from "@nodex/provider-core/server/McpProviderSessions";
import * as ProviderHost from "@nodex/provider-core/server/ProviderHost";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import { ProviderAdapterV2RuntimePolicy } from "@nodex/provider-core/server/ProviderAdapter";
import * as OpenCodeRuntime from "@nodex/provider-opencode/server/OpenCodeRuntime";
import { OpenCodeSettings } from "@nodex/provider-opencode/settings";
import {
  makeOpenCodeAdapterV2,
  openCodePermissionRules,
} from "../../../vendor/provider-opencode/src/server/adapter.ts";

it.effect.each(["ready", "late", "external"] as const)(
  "reconciles OpenCode 1 Desktop Tools when readiness is %s",
  (readiness) =>
    Effect.gen(function* () {
      const sessions = yield* Sessions.McpProviderSessions;
      const threadId = ThreadId.make("thread:mcp-budget");
      const instanceId = ProviderInstanceId.make("opencode-mcp-budget");
      const skill = {
        name: "browser",
        description: "Use the browser",
        path: "/profile/browser/skills/browser/SKILL.md",
      };
      const config = {
        environmentId: EnvironmentId.make("environment:mcp-budget"),
        threadId,
        providerSessionId: "mcp-budget",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer private-thread-credential",
        browserToolsAvailable: false,
        desktopTools: {
          endpoint: "http://127.0.0.1:3773/mcp/node_repl",
          pluginRoots: ["/profile/browser"],
          skills: [skill],
        },
      };
      const registrations: unknown[] = [];
      const { desktopTools: _desktop, ...applicationOnly } = config;
      const external = readiness === "external";
      const late = readiness === "late";
      yield* sessions.set(late ? applicationOnly : config);
      const native = yield* Queue.unbounded<unknown>();
      const launchPaths: (ReadonlyArray<string> | undefined)[] = [];
      const prompts: string[] = [];
      const permissionUpdates: unknown[] = [];
      const modelSelection = { instanceId, model: "anthropic/claude-sonnet" };
      const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
      });
      const input = { code: "1 + 1", title: "Arithmetic", options: { names: ["a", "b"] } };
      const data = "aW1hZ2U=";
      const adapter = yield* makeOpenCodeAdapterV2({
        instanceId,
        settings: Schema.decodeSync(OpenCodeSettings)(
          external ? { serverUrl: "http://test.invalid" } : {},
        ),
        environment: {},
      }).pipe(
        Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, {
          connectToOpenCodeServer: ({
            desktopSkillPaths,
          }: {
            desktopSkillPaths?: ReadonlyArray<string>;
          }) => {
            launchPaths.push(desktopSkillPaths);
            return Effect.succeed({ url: "http://test.invalid", external, exitCode: null });
          },
          createOpenCodeSdkClient: () => ({
            mcp: {
              add: async (input: { name: string; config: { enabled?: boolean } }) => {
                registrations.push(input);
                return {
                  data: {
                    [input.name]: {
                      status: input.config.enabled === false ? "disabled" : "connected",
                    },
                  },
                };
              },
            },
            event: {
              subscribe: async () => ({
                stream: Stream.toAsyncIterable(Stream.fromQueue(native)),
              }),
            },
            session: {
              create: async ({ permission }: { permission: unknown }) => {
                permissionUpdates.push(permission);
                return {
                  data: {
                    id: "ses_desktop",
                    title: "Desktop fixture",
                    time: { created: 1, updated: 1 },
                  },
                };
              },
              update: async ({ permission }: { permission: unknown }) => {
                permissionUpdates.push(permission);
                return { data: {} };
              },
              promptAsync: async ({
                system,
                messageID,
                sessionID,
              }: {
                system: string;
                messageID: string;
                sessionID: string;
              }) => {
                prompts.push(system);
                setImmediate(() => {
                  Queue.offerUnsafe(native, {
                    type: "message.updated",
                    properties: {
                      sessionID,
                      info: { id: messageID, role: "user", sessionID, time: { created: 2 } },
                    },
                  });
                  if (system.includes("Here that is `node_repl_js`"))
                    Queue.offerUnsafe(native, {
                      type: "message.part.updated",
                      properties: {
                        part: {
                          id: "part_desktop",
                          sessionID,
                          messageID: "msg_assistant",
                          callID: "call_desktop",
                          type: "tool",
                          tool: "node_repl_js",
                          state: {
                            status: "completed",
                            input,
                            output: "two",
                            title: "Arithmetic",
                            metadata: {},
                            time: { start: 2, end: 3 },
                            attachments: [
                              { mime: "image/png", url: `data:image/png;base64,${data}` },
                            ],
                          },
                        },
                      },
                    });
                  Queue.offerUnsafe(native, { type: "session.idle", properties: { sessionID } });
                });
                return { data: {} };
              },
            },
          }),
        } as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"]),
        Effect.provideService(ProviderHost.ProviderHost, {
          paths: { cwd: "/workspace" },
        } as unknown as ProviderHost.ProviderHost["Service"]),
      );
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`session:${external}`),
        modelSelection,
        runtimePolicy,
      });
      assert.deepEqual(launchPaths, [external || late ? [] : ["/profile/browser/skills"]]);
      const thread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      const send = (ordinal: number) =>
        Effect.gen(function* () {
          const events = yield* runtime.events.pipe(
            Stream.takeUntil((entry) => entry.type === "turn.terminal"),
            Stream.runCollect,
            Effect.forkScoped,
          );
          yield* runtime.startTurn({
            threadId,
            modelSelection,
            runtimePolicy,
            runId: RunId.make(`run:mcp-budget:${ordinal}`),
            rootNodeId: NodeId.make(`node:mcp-budget:${ordinal}`),
            attemptId: RunAttemptId.make(`attempt:mcp-budget:${ordinal}`),
            runOrdinal: ordinal,
            providerTurnOrdinal: ordinal,
            providerThread: thread,
            appThread: { title: "Desktop fixture" } as OrchestrationV2AppThread,
            message: {
              messageId: MessageId.make(`message:mcp-budget:${ordinal}`),
              text: "Use the browser",
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              scheduledTaskId: undefined,
              senderThreadId: undefined,
            },
            hostInstructions: "Host guidance",
          });
          return yield* Fiber.join(events);
        });
      if (external || late) {
        assert.deepInclude((yield* send(1)).at(-1), { type: "turn.terminal", status: "completed" });
        assert.notInclude(prompts[0], "node_repl_js");
      }
      if (external) {
        assert.deepEqual(registrations, []);
        return;
      }
      if (late) yield* sessions.set(config);
      const first = yield* send(late ? 2 : 1);
      const item = first.find(
        (entry) => entry.type === "turn_item.updated" && entry.turnItem.status === "completed",
      );
      assert.deepInclude(item?.type === "turn_item.updated" ? item.turnItem : {}, {
        type: "dynamic_tool",
        toolName: "node_repl_js",
        input,
        output: [
          { type: "text", text: "two" },
          { type: "image", mimeType: "image/png", data },
        ],
      });
      assert.include(prompts.at(-1), "Host guidance");
      assert.include(prompts.at(-1), "Here that is `node_repl_js`");
      if (late) assert.include(prompts.at(-1), skill.path);
      else assert.notInclude(prompts.at(-1), "SKILL.md");
      yield* sessions.set({ ...config, authorizationHeader: "Bearer rotated" });
      assert.deepInclude((yield* send(late ? 3 : 2)).at(-1), {
        type: "turn.terminal",
        status: "completed",
      });
      yield* sessions.set(applicationOnly);
      assert.deepInclude((yield* send(late ? 4 : 3)).at(-1), {
        type: "turn.terminal",
        status: "completed",
      });
      assert.notInclude(prompts.at(-1), "node_repl_js");
      assert.deepInclude(permissionUpdates[late ? 1 : 0] as unknown[], {
        permission: "node_repl_*",
        pattern: "*",
        action: "allow",
      });
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
        ...["private-thread-credential", "rotated"].map((bearer) => ({
          name: "node_repl",
          config: {
            type: "remote",
            url: config.desktopTools.endpoint,
            headers: { Authorization: `Bearer ${bearer}` },
            oauth: false,
            timeout: 3_900_000,
          },
        })),
        {
          name: "node_repl",
          config: {
            type: "remote",
            url: config.desktopTools.endpoint,
            enabled: false,
            oauth: false,
          },
        },
      ]);
    }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, Sessions.layer)), Effect.scoped),
);

it("allows the OpenCode 1 Desktop namespace in both execution modes", () => {
  for (const runtimeMode of ["approval-required", "full-access"] as const) {
    const policy = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode,
      interactionMode: "default",
      cwd: "/workspace",
    });
    assert.deepInclude(openCodePermissionRules(policy, true), {
      permission: "node_repl_*",
      pattern: "*",
      action: "allow",
    });
    assert.isFalse(
      openCodePermissionRules(policy).some((rule) => rule.permission === "node_repl_*"),
    );
  }
});
