import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentCommand, AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

it.live(
  "disabling an ACP instance rejects new admission while captured queued work drains",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-admission-" });
      const log = path.join(home, "prompts.jsonl");
      const release = path.join(home, "release");
      yield* fs.writeFileString(log, "");
      const instanceId = "queue-agent";
      const provider = {
        driver: "acpRegistry",
        enabled: true,
        config: {
          source: "local",
          discovery: "explicit",
          agentIdentity: "queue-peer",
          nativeStorageScope: home,
          commandPath: process.execPath,
          commandArgs: [fileURLToPath(new URL("./testing/acp-queued-peer.mjs", import.meta.url))],
          customModels: ["model-a"],
        },
        environment: [
          { name: "ACP_QUEUE_LOG", value: log, sensitive: false },
          { name: "ACP_QUEUE_RELEASE", value: release, sensitive: false },
          { name: "ACP_QUEUE_VERSION", value: "old", sensitive: false },
        ],
      };
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
        const dispatch = (command: AgentCommand) => call("command.dispatch", { command: command });
        const snapshot = () => call("thread.snapshot", { threadId: "queue-thread" });
        const waitSnapshot = (
          predicate: (snapshot: AgentRuntimeOperations["thread.snapshot"]["output"]) => boolean,
        ) =>
          snapshot().pipe(
            Effect.repeat({ until: predicate, schedule: Schedule.spaced("20 millis") }),
            Effect.timeout("10 seconds"),
            Effect.catch(
              Effect.fnUntraced(function* () {
                const value = yield* snapshot();
                return yield* Effect.fail(
                  new Error(
                    JSON.stringify({
                      runs: value.projection.runs.map((run) => ({
                        id: run.id,
                        status: run.status,
                      })),
                      sessions: value.projection.providerSessions.map((session) => ({
                        status: session.status,
                        lastError: session.lastError,
                      })),
                      items: value.projection.turnItems.filter((item) => item.type === "error"),
                    }),
                  ),
                );
              }),
            ),
          );
        const prompts = () =>
          fs.readFileString(log).pipe(
            Effect.map((text) =>
              text
                .trim()
                .split("\n")
                .filter(Boolean)
                .map(
                  (line) =>
                    JSON.parse(line) as { prompt?: boolean; ordinal: number; version: string },
                )
                .filter((row) => row.prompt === true)
                .map(({ ordinal, version }) => ({ ordinal, version })),
            ),
          );
        yield* call("project.upsert", { id: "queue-project", title: "Queue", workspaceRoot: home });
        const operation = yield* call("acp.connection.start", {
          operationId: "connect",
          instanceId,
          cwd: home,
        });
        const connection = yield* call("acp.operation.read", {
          operationId: operation.operationId,
        }).pipe(
          Effect.repeat({
            until: (value) => value.phase !== "running",
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(connection.phase).toBe("succeeded");
        yield* dispatch({
          type: "thread.create",
          commandId: "create",
          threadId: "queue-thread",
          projectId: "queue-project",
          title: "Queue",
          modelSelection: { instanceId, model: "model-a" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: home,
          createdBy: "user",
          creationSource: "web",
        });
        const message = (id: string, queued: boolean): AgentCommand => ({
          type: "message.dispatch",
          commandId: `send-${id}`,
          threadId: "queue-thread",
          messageId: id,
          text: id,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: queued ? { type: "queue_after_active" } : { type: "start_immediately" },
        });
        yield* dispatch(message("first", false));
        const active = yield* waitSnapshot((value) =>
          value.projection.runs.some((run) => run.status === "running"),
        );
        yield* prompts().pipe(
          Effect.repeat({
            until: (rows) => rows.length === 1,
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        yield* dispatch(message("second", true));
        expect((yield* call("thread.queue", { threadId: "queue-thread" })).entries).toHaveLength(1);
        const beforeMutation = yield* fs.readFileString(log);
        expect(
          yield* call("acp.auth.start", {
            instanceId,
            ownerId: "setup-owner",
            methodId: "login",
          }).pipe(Effect.isFailure),
        ).toBe(true);
        expect(
          yield* call("acp.modelProviders.set", {
            instanceId,
            cwd: home,
            providerId: "model-service",
            apiType: "openai",
            baseUrl: "https://models.example.test/v1",
            headers: { Authorization: "Bearer fixture-token" },
          }).pipe(Effect.isFailure),
        ).toBe(true);
        expect(yield* fs.readFileString(log)).toBe(beforeMutation);
        const changed = {
          ...provider,
          enabled: false,
          environment: provider.environment.map((entry) =>
            entry.name === "ACP_QUEUE_VERSION" ? { ...entry, value: "new" } : entry,
          ),
        };
        const configured = yield* call("providers.configure", {
          providers: { [instanceId]: changed },
        });
        expect(configured.applied).toBe(false);
        expect(configured.deferredInstanceIds).toContain(instanceId);
        expect(yield* dispatch(message("new-direct", false)).pipe(Effect.isFailure)).toBe(true);
        expect(yield* dispatch(message("new-queued", true)).pipe(Effect.isFailure)).toBe(true);
        const parent = active.projection.runs.find((run) => run.status === "running")!;
        expect(
          yield* dispatch({
            type: "delegated_task.request",
            commandId: "new-delegation",
            parentThreadId: "queue-thread",
            parentRunId: parent.id,
            parentNodeId: parent.rootNodeId!,
            task: "Must not start",
            modelSelection: { instanceId, model: "model-a" },
            runtimeMode: "full-access",
            interactionMode: "default",
            createdBy: "agent",
            creationSource: "mcp",
          }).pipe(Effect.isFailure),
        ).toBe(true);
        yield* fs.writeFileString(release, "continue");
        for (const messageId of ["first", "second"]) {
          const outcome = yield* call("run.outcome", { threadId: "queue-thread", messageId }).pipe(
            Effect.repeat({
              until: (value) => value?.status === "completed",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds"),
          );
          expect(outcome?.status).toBe("completed");
        }
        expect((yield* call("thread.queue", { threadId: "queue-thread" })).entries).toHaveLength(0);
        for (const messageId of ["new-direct", "new-queued"]) {
          expect(yield* call("run.outcome", { threadId: "queue-thread", messageId })).toBeNull();
        }
        expect(yield* prompts()).toEqual([
          { ordinal: 1, version: "old" },
          { ordinal: 2, version: "old" },
        ]);
        const final = yield* call("providers.read", {}).pipe(
          Effect.repeat({
            until: (providers) =>
              providers.find((entry) => entry.instanceId === instanceId)?.enabled === false,
            schedule: Schedule.spaced("50 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        expect(final.find((entry) => entry.instanceId === instanceId)?.enabled).toBe(false);
      }).pipe(
        Effect.provide(
          Application.layer(
            { home, cwd: home, providers: { [instanceId]: provider } },
            () => Effect.void,
          ),
        ),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  30_000,
);
