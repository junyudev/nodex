import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { appToolCatalog } from "../../shared/nodex-app-tools/catalog";
import {
  CodexAppServerCapabilities,
  createCodexAppServerCapabilitySnapshot,
} from "../codex-runtime/CodexAppServerCapabilities";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { CoreModules } from "../core-runtime/CoreModules";
import { DesktopToolRuntime } from "../host-runtime/DesktopToolRuntime";
import { CodexConversationProjection } from "./CodexConversationProjection";
import { CodexTurnCommands } from "./CodexTurnCommands";
import { ConversationCommands } from "./ConversationCommands";
import { ConversationEntityMap } from "./internal/ConversationEntityMap";
import { ExecutionHostRuntime } from "./ExecutionHostRuntime";
import { CodexThreadExecution, live } from "./CodexThreadExecution";

it.effect.each(["local", "remote-a"])(
  "refreshes app tools for the destination endpoint when switching runtime to %s",
  (hostId) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const requests: { method: string; params: Record<string, unknown>; scheduling: unknown }[] =
          [];
        const projected: unknown[] = [];
        const location = {
          hostId,
          cwd: "/managed/task",
          workspaceRoots: ["/managed/task"],
          managedWorktreePath: "/managed/task",
          projectId: "project-a",
          projectlessOutputDirectory: null,
          projectlessWorkspaceBrowserRoot: null,
        };
        const capability = createCodexAppServerCapabilitySnapshot({
          hostId,
          generation: 7,
          userAgent: "codex-app-server/0.153.4",
        });
        const context = yield* Layer.buildWithScope(
          live.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(CodexAppServerCapabilities, {
                  forHost: () => Effect.succeed(capability),
                  forThread: () => Effect.succeed(capability),
                  isCurrent: () => Effect.succeed(true),
                }),
                Layer.succeed(CodexGateway, {
                  localHostId: "local",
                  requestOnHost: (
                    targetHost: string,
                    method: string,
                    params: Record<string, unknown>,
                    scheduling: unknown,
                  ) =>
                    Effect.sync(() => {
                      assert.strictEqual(targetHost, hostId);
                      requests.push({ method, params, scheduling });
                      if (method === "thread/read")
                        return {
                          thread: {
                            id: "thread-a",
                            path: "/rollouts/task.jsonl",
                            status: { type: "notLoaded" },
                          },
                        };
                      assert.strictEqual(method, "thread/resume");
                      return {
                        thread: { id: "thread-a" },
                        cwd: location.cwd,
                        runtimeWorkspaceRoots: location.workspaceRoots,
                      };
                    }),
                } as unknown as CodexGateway["Service"]),
                Layer.succeed(CodexConversationProjection, {
                  relocateExecution: (input: unknown) => Effect.sync(() => projected.push(input)),
                } as unknown as CodexConversationProjection["Service"]),
                Layer.succeed(ConversationEntityMap, {
                  current: () => null,
                } as unknown as ConversationEntityMap["Service"]),
                Layer.succeed(DesktopToolRuntime, {
                  threadConfig: Effect.succeed({ "features.js_repl": false }),
                } as unknown as DesktopToolRuntime["Service"]),
                Layer.succeed(CoreModules, {} as CoreModules["Service"]),
                Layer.succeed(CodexTurnCommands, {} as CodexTurnCommands["Service"]),
                Layer.succeed(ConversationCommands, {} as ConversationCommands["Service"]),
                Layer.succeed(ExecutionHostRuntime, {} as ExecutionHostRuntime["Service"]),
              ),
            ),
          ),
          scope,
        );

        yield* Context.get(context, CodexThreadExecution).switchRuntime("thread-a", location, null);

        assert.deepEqual(
          requests.map((request) => request.method),
          ["thread/read", "thread/resume"],
        );
        const resume = requests[1]!;
        const config = resume.params.config as Record<string, unknown>;
        assert.strictEqual(config["features.js_repl"], false);
        assert.deepEqual(
          config["mcp_servers.nodex_app.enabled_tools"],
          hostId === "local" ? appToolCatalog.map((tool) => tool.name) : undefined,
        );
        assert.deepEqual(resume.scheduling, { expectedHostId: hostId, expectedGeneration: 7 });
        assert.strictEqual(projected.length, 1);
      }),
    ),
);
