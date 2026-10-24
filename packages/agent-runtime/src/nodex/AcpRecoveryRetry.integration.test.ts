import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

it.live.each([
  { protocol: "v1", failure: "missing", attempts: 1 },
  { protocol: "v2", failure: "missing", attempts: 1 },
  { protocol: "v1", failure: "temporary", attempts: 5 },
])(
  "settles $protocol $failure native recovery after $attempts attempts without replacing its identity",
  ({ protocol, failure, attempts }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-recovery-retry-" });
      const log = `${home}/requests.jsonl`;
      yield* fs.writeFileString(log, "");
      const instanceId = "recovery-agent";
      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        let serial = 0;
        const call = <M extends AgentRuntimeMethod>(
          method: M,
          input: AgentRuntimeOperations[M]["input"],
        ) =>
          runtime
            .handle({ id: String(++serial), method, input })
            .pipe(Effect.map((value) => value as AgentRuntimeOperations[M]["output"]));
        yield* call("project.upsert", { id: "project", title: "Recovery", workspaceRoot: home });
        yield* call("acp.connection.start", { instanceId, cwd: home, operationId: "connect" });
        const connected = yield* call("acp.operation.read", { operationId: "connect" }).pipe(
          Effect.repeat({
            until: (value) => value.phase !== "running",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(connected.phase).toBe("succeeded");
        yield* fs.writeFileString(log, "");
        yield* call("command.dispatch", {
          type: "thread.create",
          commandId: "import",
          threadId: "thread",
          projectId: "project",
          title: "Captured native session",
          modelSelection: { instanceId, model: "model-a" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: home,
          createdBy: "user",
          creationSource: "web",
          importedNativeThread: {
            ref: { driver: "acpRegistry", nativeId: "original-native-session", strength: "strong" },
            metadata: { itemIdentityVersion: 2 },
          },
        });
        yield* call("command.dispatch", {
          type: "message.dispatch",
          commandId: "continue",
          threadId: "thread",
          messageId: "message",
          text: "Continue the original conversation",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        const outcome = yield* call("run.outcome", {
          threadId: "thread",
          messageId: "message",
        }).pipe(
          Effect.repeat({
            until: (value) => value?.status === "failed",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("20 seconds"),
        );
        expect(outcome?.status).toBe("failed");
        const wire = (yield* fs.readFileString(log))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { method: string; params?: { sessionId?: string } });
        expect(wire.filter((request) => request.method === "initialize")).toHaveLength(attempts);
        const restores = wire.filter(
          (request) => request.method === (protocol === "v1" ? "session/load" : "session/resume"),
        );
        expect(restores).toHaveLength(attempts);
        expect(
          restores.every((request) => request.params?.sessionId === "original-native-session"),
        ).toBe(true);
        expect(
          wire.some(
            (request) => request.method === "session/new" || request.method === "session/prompt",
          ),
        ).toBe(false);
        const snapshot = yield* call("thread.snapshot", { threadId: "thread" });
        expect(snapshot.projection.runs).toHaveLength(1);
        expect(snapshot.projection.providerThreads).toHaveLength(1);
        expect(snapshot.projection.providerThreads[0]?.nativeThreadRef).toMatchObject({
          nativeId: "original-native-session",
          strength: "strong",
        });
        expect(snapshot.projection.contextTransfers).toHaveLength(0);
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              providers: {
                [instanceId]: {
                  driver: "acpRegistry",
                  enabled: true,
                  config: {
                    source: "local",
                    discovery: "explicit",
                    commandPath: process.execPath,
                    commandArgs: [
                      fileURLToPath(new URL("../../scripts/acp-model-agent.ts", import.meta.url)),
                    ],
                  },
                  environment: [
                    { name: "NODEX_ACP_MODEL_PROTOCOL", value: protocol, sensitive: false },
                    { name: "NODEX_ACP_FAIL_LOAD", value: failure, sensitive: false },
                    { name: "NODEX_ACP_MODEL_REQUEST_LOG", value: log, sensitive: false },
                  ],
                },
              },
            },
            () => Effect.void,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);
