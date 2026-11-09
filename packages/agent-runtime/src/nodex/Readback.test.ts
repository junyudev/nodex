import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import {
  EventId,
  MessageId,
  NodeId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2DomainEvent,
} from "@nodex/runtime-contracts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderEventIngestor from "../orchestration-v2/ProviderEventIngestor.ts";
import * as Analytics from "../telemetry/AnalyticsService.ts";
import * as Bridge from "./HostBridge.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Runtime from "./Runtime.ts";
import * as Host from "./Host.ts";
import * as Service from "./Service.ts";
import type { AgentRuntimeOperations, AgentRuntimeNotification } from "./Interface.ts";

it.live(
  "execution observers see a committed opening statement without a Run lifecycle update",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-readback-observe-" });
        const configuration = { home, cwd: home, providers: {} };
        const changes =
          yield* Queue.unbounded<Extract<AgentRuntimeNotification, { type: "activity" }>>();
        const notify = (event: AgentRuntimeNotification) =>
          event.type === "activity" ? Queue.offer(changes, event).pipe(Effect.asVoid) : Effect.void;
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
          Layer.provide(
            ProviderEventIngestor.layerAnalytics.pipe(
              Layer.provide(Analytics.layerFromHost(() => Effect.void)),
            ),
          ),
        );
        const layer = Service.layer(notify, {}).pipe(
          Layer.provideMerge(host),
          Layer.provideMerge(bridge),
        );
        yield* Effect.gen(function* () {
          const runtime = yield* Service.AgentRuntime;
          const sink = yield* EventSink.EventSinkV2;
          const threadId = ThreadId.make("readback-thread");
          const rootNodeId = NodeId.make("readback-root");
          const messageNodeId = NodeId.make("readback-message-node");
          const runId = RunId.make("readback-run");
          const now = yield* DateTime.now;
          const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
          yield* runtime.handle({
            id: "project",
            method: "project.upsert",
            input: { id: "project", title: "Test", workspaceRoot: home },
          });
          yield* runtime.handle({
            id: "thread",
            method: "command.dispatch",
            input: {
              command: {
                type: "thread.create",
                commandId: "create",
                threadId,
                projectId: "project",
                title: "Readback",
                modelSelection: selection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: null,
                worktreePath: home,
                createdBy: "user",
                creationSource: "web",
              },
            },
          });
          yield* runtime.handle({ id: "observe", method: "execution.observe", input: {} });
          const run: OrchestrationV2Run = {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: selection.instanceId,
            modelSelection: selection,
            userMessageId: MessageId.make("person-message"),
            providerThreadId: null,
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
            startedByPerson: true,
            modelPolicyOrigin: "person",
          };
          yield* sink.write({
            events: [
              {
                id: EventId.make("run-start"),
                type: "run.updated",
                threadId,
                occurredAt: now,
                payload: run,
              },
            ],
          });
          yield* Queue.take(changes);
          const node: Extract<OrchestrationV2DomainEvent, { type: "node.updated" }> = {
            id: EventId.make("message-node"),
            type: "node.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: messageNodeId,
              threadId,
              runId,
              rootNodeId,
              parentNodeId: rootNodeId,
              kind: "assistant_message",
              status: "completed",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: now,
            },
          };
          const opening: Extract<OrchestrationV2DomainEvent, { type: "turn-item.updated" }> = {
            id: EventId.make("opening-complete"),
            type: "turn-item.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("opening"),
              threadId,
              runId,
              nodeId: messageNodeId,
              parentItemId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              ordinal: 1,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make("opening"),
              text: "I'll inspect the build first.",
              streaming: false,
            },
          };
          yield* sink.write({ events: [node, opening] });
          const read = runtime
            .handle({
              id: "read",
              method: "execution.activity",
              input: { rootThreadIds: [threadId] },
            })
            .pipe(
              Effect.map(
                (value) => value as AgentRuntimeOperations["execution.activity"]["output"],
              ),
            );
          assert.isNull((yield* read).items[0]?.readback);
          const committed = yield* sink.write({
            events: [
              {
                ...opening,
                id: EventId.make("first-action"),
                payload: {
                  id: TurnItemId.make("command"),
                  threadId,
                  runId,
                  nodeId: messageNodeId,
                  parentItemId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  ordinal: 2,
                  status: "running",
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  type: "command_execution",
                  input: "pwd",
                },
              },
            ],
          });
          const changed = yield* Queue.take(changes);
          assert.equal(changed.rootThreadId, threadId);
          assert.equal(changed.sequence, committed[0]!.sequence);
          assert.deepEqual((yield* read).items[0]?.readback, {
            runId,
            itemId: "opening",
            text: "I'll inspect the build first.",
            startedByPerson: true,
          });
        }).pipe(Effect.provide(layer));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);
