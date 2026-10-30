import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as FileSystem from "effect/FileSystem";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

it.live(
  "rejects models outside the host allowlist and refuses a retired instance before admitting a Run",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-model-policy-" });
      const instanceId = "nodex_codex_fixture";
      yield* Effect.gen(function* () {
        const runtime = yield* AgentRuntime;
        let sequence = 0;
        const call = <M extends AgentRuntimeMethod>(
          method: M,
          input: AgentRuntimeOperations[M]["input"],
        ) =>
          runtime
            .handle({ id: String(++sequence), method, input })
            .pipe(Effect.map((value) => value as AgentRuntimeOperations[M]["output"]));
        yield* call("project.upsert", { id: "project", title: "Models", workspaceRoot: home });
        yield* call("command.dispatch", {
          command: {
            type: "thread.create",
            commandId: "create",
            threadId: "thread",
            projectId: "project",
            title: "Allowlist",
            modelSelection: { instanceId, model: "gpt-6.1-sol" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: home,
            createdBy: "user",
            creationSource: "web",
          },
        });
        const send = (commandId: string, model: string) =>
          call("command.dispatch", {
            command: {
              type: "message.dispatch",
              commandId,
              threadId: "thread",
              messageId: commandId,
              text: "Must not execute",
              modelSelection: { instanceId, model },
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
            },
          });
        expect(yield* send("outside", "unapproved").pipe(Effect.flip)).toMatchObject({
          _tag: "ThreadManagementProviderInstanceDisabledError",
        });
        expect((yield* call("thread.snapshot", { threadId: "thread" })).projection.runs).toEqual(
          [],
        );
        expect(
          yield* call("text.generate-structured", {
            modelSelection: { instanceId, model: "unapproved" },
            prompt: "Must not execute",
            cwd: home,
            outputSchema: {},
          }).pipe(Effect.flip),
        ).toMatchObject({ message: "This model is unavailable from Nodex." });
        yield* call("providers.configure", { providers: {} });
        expect(yield* send("retired", "gpt-6.1-sol").pipe(Effect.flip)).toMatchObject({
          _tag: "ThreadManagementProviderInstanceDisabledError",
        });
        expect((yield* call("thread.snapshot", { threadId: "thread" })).projection.runs).toEqual(
          [],
        );
      }).pipe(
        Effect.provide(
          Application.layer(
            {
              home,
              cwd: home,
              providers: {
                [instanceId]: {
                  driver: "codex",
                  source: "nodex",
                  enabled: true,
                  modelAllowlist: ["gpt-6.1-sol"],
                  config: {
                    binaryPath: `${home}/nonexistent-fixture`,
                    homePath: `${home}/codex`,
                    isolated: true,
                  },
                },
              },
            },
            () => Effect.void,
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("account retirement cancels active and queued work without dispatching the queue", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-model-retirement-" });
    const log = `${home}/prompts.jsonl`;
    yield* fs.writeFileString(log, "");
    const instanceId = "nodex_retirement_fixture";
    yield* Effect.gen(function* () {
      const runtime = yield* AgentRuntime;
      let sequence = 0;
      const call = <M extends AgentRuntimeMethod>(
        method: M,
        input: AgentRuntimeOperations[M]["input"],
      ) =>
        runtime
          .handle({ id: String(++sequence), method, input })
          .pipe(Effect.map((value) => value as AgentRuntimeOperations[M]["output"]));
      yield* call("project.upsert", { id: "project", title: "Retirement", workspaceRoot: home });
      const operation = yield* call("acp.connection.start", {
        instanceId,
        cwd: home,
        operationId: "connect",
      });
      const connected = yield* call("acp.operation.read", {
        operationId: operation.operationId,
      }).pipe(
        Effect.repeat({
          until: (value) => value.phase !== "running",
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeout("10 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.fail(new Error("Connection timed out"))),
      );
      expect(connected.phase).toBe("succeeded");
      yield* call("command.dispatch", {
        command: {
          type: "thread.create",
          commandId: "create",
          threadId: "thread",
          projectId: "project",
          title: "Retirement",
          modelSelection: { instanceId, model: "model-a" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: home,
          createdBy: "user",
          creationSource: "web",
        },
      });
      const send = (messageId: string, queued: boolean) =>
        call("command.dispatch", {
          command: {
            type: "message.dispatch",
            commandId: `send-${messageId}`,
            threadId: "thread",
            messageId,
            text: messageId,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: queued ? { type: "queue_after_active" } : { type: "start_immediately" },
          },
        });
      yield* send("active", false);
      yield* fs.readFileString(log).pipe(
        Effect.repeat({
          until: (text) => text.includes('"prompt":true'),
          schedule: Schedule.spaced("20 millis"),
        }),
        Effect.timeout("10 seconds"),
        Effect.catchTag("TimeoutError", () => Effect.fail(new Error("First prompt timed out"))),
      );
      yield* send("queued", true);
      expect((yield* call("thread.queue", { threadId: "thread" })).entries).toHaveLength(1);
      yield* call("providers.configure", { providers: {} });
      for (const messageId of ["active", "queued"]) {
        const outcome = yield* call("run.outcome", { threadId: "thread", messageId }).pipe(
          Effect.repeat({
            until: (value) =>
              value !== null && ["cancelled", "interrupted", "failed"].includes(value.status),
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
          Effect.catchTag("TimeoutError", () =>
            call("thread.snapshot", { threadId: "thread" }).pipe(
              Effect.flatMap((snapshot) =>
                Effect.fail(
                  new Error(
                    JSON.stringify({
                      messageId,
                      runs: snapshot.projection.runs.map((run) => ({
                        status: run.status,
                        id: run.id,
                      })),
                      sessions: snapshot.projection.providerSessions.map((session) => ({
                        status: session.status,
                        lastError: session.lastError,
                      })),
                    }),
                  ),
                ),
              ),
            ),
          ),
        );
        expect(outcome?.status).not.toBe("completed");
      }
      expect(
        (yield* fs.readFileString(log))
          .split("\n")
          .filter((line) => line.includes('"prompt":true')),
      ).toHaveLength(1);
      expect(
        (yield* call("providers.read", {})).some((provider) => provider.instanceId === instanceId),
      ).toBe(false);
    }).pipe(
      Effect.provide(
        Application.layer(
          {
            home,
            cwd: home,
            providers: {
              [instanceId]: {
                driver: "acpRegistry",
                source: "nodex",
                enabled: true,
                modelAllowlist: ["model-a"],
                config: {
                  source: "local",
                  discovery: "explicit",
                  agentIdentity: "retirement-peer",
                  nativeStorageScope: home,
                  commandPath: process.execPath,
                  commandArgs: [
                    fileURLToPath(new URL("./testing/acp-queued-peer.mjs", import.meta.url)),
                  ],
                  customModels: ["model-a"],
                },
                environment: [
                  { name: "ACP_QUEUE_LOG", value: log, sensitive: false },
                  { name: "ACP_QUEUE_RELEASE", value: `${home}/release`, sensitive: false },
                  { name: "ACP_QUEUE_VERSION", value: "managed", sensitive: false },
                ],
              },
            },
          },
          () => Effect.void,
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
