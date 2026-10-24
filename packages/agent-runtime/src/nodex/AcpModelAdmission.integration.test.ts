import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schedule from "effect/Schedule";
import { fileURLToPath } from "node:url";
import * as Application from "./Application.ts";
import { AgentRuntime } from "./Service.ts";
import type { AgentRuntimeMethod, AgentRuntimeOperations } from "./Interface.ts";

it.live.each(["none", "config"] as const)(
  "settles an unavailable %s model without sending a prompt or choosing a substitute",
  (api) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-acp-model-admission-" });
      const log = `${home}/requests.jsonl`;
      yield* fs.writeFileString(log, "");
      const instanceId = "model-agent";
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
        const methods = () =>
          fs.readFileString(log).pipe(
            Effect.map((text) =>
              text
                .trim()
                .split("\n")
                .filter(Boolean)
                .map((line) => (JSON.parse(line) as { method: string }).method),
            ),
          );
        yield* call("project.upsert", { id: "project", title: "Models", workspaceRoot: home });
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
        );
        expect(connected.phase).toBe("succeeded");
        const available = (yield* call("providers.read", {})).find(
          (provider) => provider.instanceId === instanceId,
        )!;
        expect(available.models.some((model) => model.slug === "rejected")).toBe(api !== "none");
        yield* fs.writeFileString(log, "");
        yield* call("command.dispatch", {
          type: "thread.create",
          commandId: "create",
          threadId: "thread",
          projectId: "project",
          title: "Model refusal",
          modelSelection: { instanceId, model: "rejected" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: home,
          createdBy: "user",
          creationSource: "web",
        });
        yield* call("command.dispatch", {
          type: "message.dispatch",
          commandId: "send",
          threadId: "thread",
          messageId: "message",
          text: "Must not reach the Agent",
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
          Effect.timeout("15 seconds"),
        );
        expect(outcome?.status).toBe("failed");
        const wire = yield* methods();
        expect(wire).not.toContain("session/prompt");
        expect(wire.filter((method) => method === "session/new").length).toBeGreaterThan(0);
        expect(wire.filter((method) => method === "session/new").length).toBeLessThanOrEqual(5);
        const snapshot = yield* call("thread.snapshot", { threadId: "thread" });
        expect(
          snapshot.projection.visibleTurnItems.some((item) => item.item.type === "error"),
        ).toBe(true);
        expect(snapshot.projection.runs).toHaveLength(1);
        expect(snapshot.projection.runs[0]?.modelSelection.model).toBe("rejected");
        yield* call("command.dispatch", {
          type: "message.dispatch",
          commandId: "recover",
          threadId: "thread",
          messageId: "recovery",
          text: "Use the selected valid model",
          attachments: [],
          modelSelection: { instanceId, model: api === "none" ? "default" : "model-a" },
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: "start_immediately" },
        });
        expect(
          (yield* call("run.outcome", { threadId: "thread", messageId: "recovery" }).pipe(
            Effect.repeat({
              until: (value) => value?.status === "completed",
              schedule: Schedule.spaced("20 millis"),
            }),
            Effect.timeout("10 seconds"),
          ))?.status,
        ).toBe("completed");
        expect((yield* methods()).filter((method) => method === "session/prompt")).toHaveLength(1);
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
                    customModels: ["rejected"],
                  },
                  environment: [
                    { name: "NODEX_ACP_MODEL_API", value: api, sensitive: false },
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
