import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { CommandId, EventId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as Bridge from "./HostBridge.ts";
import * as Host from "./Host.ts";
import * as Runtime from "./Runtime.ts";
import * as Service from "./Service.ts";

it.live(
  "tasks.cancel stops a restart-cut child awaiting continuation and returns cancel_requested",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-task-cancel-" });
      const configuration = { home, cwd: home, providers: { codex: { driver: "codex" } } };
      const notify = () => Effect.void;
      const identity = Environment.layerIdentity.pipe(
        Layer.provide(Runtime.layerConfiguration(configuration)),
        Layer.provide(NodeServices.layer),
      );
      const bridge = Bridge.layer(configuration, notify).pipe(
        Layer.provide(identity),
        Layer.provide(NodeServices.layer),
      );
      const host = Host.layer(configuration).pipe(
        Layer.provide(Bridge.layerExecutionHost.pipe(Layer.provide(bridge))),
      );
      // Seed restart recovery before activating the effect worker; no provider process is opened.
      const application = Service.layer(notify, configuration.providers).pipe(
        Layer.provideMerge(host),
        Layer.provideMerge(bridge),
      );
      yield* Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* Service.AgentRuntime;
          const request = (method: string, input: unknown) =>
            runtime.handle({ id: method, method, input });
          const parentId = ThreadId.make("thread:cancel-parent");
          yield* request("project.upsert", {
            id: "project:cancel",
            title: "Cancel",
            workspaceRoot: home,
          });
          yield* request("command.dispatch", {
            command: {
              type: "thread.create",
              commandId: "command:cancel-create",
              threadId: parentId,
              projectId: "project:cancel",
              title: "Cancel",
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: home,
              createdBy: "user",
              creationSource: "web",
            },
          });
          yield* request("command.dispatch", {
            command: {
              type: "message.dispatch",
              commandId: "command:cancel-parent-run",
              threadId: parentId,
              messageId: "message:cancel-parent",
              text: "Delegate",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
              createdBy: "user",
              creationSource: "web",
            },
          });
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const parent = yield* orchestrator.getThreadProjection(parentId);
          yield* request("command.dispatch", {
            command: {
              type: "delegated_task.request",
              commandId: "command:cancel-delegate",
              parentThreadId: parentId,
              parentRunId: parent.runs[0]!.id,
              parentNodeId: parent.runs[0]!.rootNodeId!,
              task: "Continue after restart",
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              completionWake: "always",
              createdBy: "agent",
              creationSource: "mcp",
            },
          });
          const task = (yield* orchestrator.getThreadProjection(parentId)).subagents[0]!;
          const child = yield* orchestrator.getThreadProjection(task.childThreadId!);
          const run = child.runs[0]!;
          const now = yield* DateTime.now;
          const sink = yield* EventSink.EventSinkV2;
          yield* sink.writeWithEffects({
            commandId: CommandId.make("command:cancel-restart-cut"),
            events: [
              {
                id: EventId.make("event:cancel-restart-cut"),
                type: "run.updated",
                threadId: child.thread.id,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "interrupted", startedAt: now, completedAt: now },
              },
            ],
            effects: [
              {
                id: `effect:restart-continuation:${run.id}`,
                commandId: CommandId.make("command:cancel-restart-cut"),
                threadId: child.thread.id,
                request: { type: "provider-runtime.continue", sourceRunId: run.id },
              },
            ],
          });
          expect(yield* orchestrator.delegatedTaskResultPending(child.thread.id, task.id)).toBe(
            true,
          );
          expect(
            yield* request("tasks.cancel", {
              threadId: parentId,
              taskId: task.id,
              commandId: "command:cancel-restart-child",
            }),
          ).toEqual({ taskId: task.id, status: "cancel_requested" });
          const stopped = yield* orchestrator.getThreadRecords(child.thread.id, ["turnItems"], {
            turnItemTypes: ["run_interrupt_request"],
            turnItemRunIds: [run.id],
          });
          expect(stopped.turnItems).toHaveLength(1);
        }).pipe(Effect.provide(application)),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
