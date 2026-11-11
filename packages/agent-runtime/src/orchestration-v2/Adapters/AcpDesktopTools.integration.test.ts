// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@nodex/runtime-shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

import {
  desktopFixtureResult,
  startDesktopMcpFixture,
} from "../../mcp/AcpMcpStdioBridge.testkit.ts";
import * as Application from "../../nodex/Application.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "../../nodex/Interface.ts";
import { AgentRuntime } from "../../nodex/Service.ts";

const fixtureConfig = vi.hoisted(() => ({
  endpoint: "",
  authorization: undefined as string | undefined,
}));

// Extend the Runtime-provisioned credential at the provider config seam.
vi.mock("@nodex/provider-core/server/McpProviderSessions", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@nodex/provider-core/server/McpProviderSessions")>();
  return {
    ...original,
    layer: Layer.effect(
      original.McpProviderSessions,
      Effect.service(original.McpProviderSessions).pipe(
        Effect.map((sessions) =>
          original.McpProviderSessions.of({
            ...sessions,
            set: (config) => {
              fixtureConfig.authorization = config.authorizationHeader;
              return sessions.set({
                ...config,
                desktopTools: { endpoint: fixtureConfig.endpoint, pluginRoots: [], skills: [] },
              });
            },
          }),
        ),
      ),
    ).pipe(Layer.provide(original.layer)),
  };
});

const peer = fileURLToPath(
  new URL("../../../../../scripts/scenarios/runtime/scripted-acp-agent.ts", import.meta.url),
);
const entry = fileURLToPath(new URL("../../nodex/entry.ts", import.meta.url));

it.live.each(["complete", "cancel"] as const)(
  "runs the scripted ACP Desktop tool through the Runtime and can %s it",
  (outcome) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-desktop-tools-" });
      const path = yield* Path.Path;
      const observationPath = path.join(home, "scripted-acp-observations.json");
      const fixture = yield* Effect.acquireRelease(
        Effect.promise(() =>
          startDesktopMcpFixture({
            authorization: () => fixtureConfig.authorization,
            block: outcome === "cancel",
          }),
        ),
        (fixture) => Effect.promise(fixture.close),
      );
      fixtureConfig.endpoint = fixture.endpoint;
      const instanceId = "scripted-acp";
      const threadId = "desktop-thread";
      const messageId = "desktop-message";
      const desktopToolCall = {
        code: "console.log(42)",
        title: "Fixture computation",
        timeout_ms: 2_000,
      };
      const call = <M extends AgentRuntimeMethod>(
        method: M,
        input: AgentRuntimeOperations[M]["input"],
      ) =>
        AgentRuntime.use((runtime) => runtime.handle({ id: method, method, input })).pipe(
          Effect.map((output) => output as AgentRuntimeOperations[M]["output"]),
        );
      yield* Effect.gen(function* () {
        yield* call("project.upsert", {
          id: "project",
          title: "Desktop Tools",
          workspaceRoot: home,
        });
        yield* call("acp.connection.start", { instanceId, cwd: home, operationId: "connect" });
        const connected = yield* call("acp.operation.read", { operationId: "connect" }).pipe(
          Effect.repeat({
            until: (value) => value.phase !== "running",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("30 seconds"),
        );
        expect(connected.phase).toBe("succeeded");
        yield* call("command.dispatch", {
          command: {
            type: "thread.create",
            commandId: "create",
            threadId,
            projectId: "project",
            title: "ACP Desktop Tools",
            modelSelection: { instanceId, model: "default" },
            runtimeMode: "approval-required",
            interactionMode: "default",
            branch: null,
            worktreePath: home,
            createdBy: "user",
            creationSource: "web",
          },
        });
        yield* call("command.dispatch", {
          command: {
            type: "message.dispatch",
            commandId: "send",
            threadId,
            messageId,
            text: "Use the Desktop tool",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          },
        });
        expect(
          yield* Effect.promise(() => fixture.callStarted).pipe(Effect.timeout("30 seconds")),
        ).toEqual(desktopToolCall);
        expect(fixture.methods.slice(0, 4)).toEqual([
          "initialize",
          "notifications/initialized",
          "tools/list",
          "tools/call",
        ]);
        if (outcome === "cancel") {
          const snapshot = yield* call("thread.snapshot", { threadId });
          const run = snapshot.projection.runs.find((run) => run.userMessageId === messageId);
          expect(run?.status).toBe("running");
          yield* call("command.dispatch", {
            command: {
              type: "run.interrupt",
              commandId: "stop",
              threadId,
              runId: run!.id,
              holdQueue: true,
            },
          });
          yield* Effect.promise(() => fixture.callClosed).pipe(Effect.timeout("15 seconds"));
        }
        const expectedStatus = outcome === "cancel" ? "interrupted" : "completed";
        const result = yield* call("run.outcome", { threadId, messageId }).pipe(
          Effect.repeat({
            until: (value) => value?.status === expectedStatus || value?.status === "failed",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("30 seconds"),
        );
        expect(result?.status).toBe(expectedStatus);
        const observations: unknown = JSON.parse(yield* fs.readFileString(observationPath));
        expect(observations).toContainEqual({ method: "node_repl/tools/list", tools: ["js"] });
        if (outcome === "cancel") {
          expect(observations).toContainEqual(
            expect.objectContaining({ method: "session/cancel" }),
          );
        } else {
          const snapshot = yield* call("thread.snapshot", { threadId });
          const item = snapshot.projection.visibleTurnItems
            .map((row) => row.item)
            .find((item) => item.type === "dynamic_tool" && item.toolName === "node_repl.js");
          if (item === undefined)
            return yield* Effect.die("The Desktop tool item was not persisted");
          const fullItem = yield* call("thread.item.full", { threadId, itemId: item.id });
          expect(fullItem).toMatchObject({
            status: "completed",
            input: desktopToolCall,
            output: { content: [{ type: "text", text: desktopFixtureResult }] },
          });
        }
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              providers: {
                [instanceId]: {
                  driver: "acpRegistry",
                  config: {
                    source: "local",
                    discovery: "explicit",
                    commandPath: process.execPath,
                    commandArgs: [peer],
                  },
                  environment: [
                    {
                      name: "NODEX_SCRIPTED_ACP_OBSERVATION",
                      value: observationPath,
                      sensitive: false,
                    },
                    {
                      name: "NODEX_SCRIPTED_ACP_SCENARIO",
                      value: JSON.stringify({
                        desktopToolCall,
                        sessionConfig: {
                          id: "model",
                          category: "model",
                          currentValue: "default",
                          values: ["default"],
                        },
                      }),
                      sensitive: false,
                    },
                  ],
                },
              },
            },
            () => Effect.void,
          ).pipe(Layer.provide(Layer.succeed(HostProcess.Arguments, [process.execPath, entry]))),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
