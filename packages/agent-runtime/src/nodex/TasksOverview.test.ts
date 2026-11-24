import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { makeSubagentChildThread } from "@nodex/provider-core/server/subagentProjection";
import {
  EventId,
  NodeId,
  MessageId,
  RunId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
} from "@nodex/runtime-contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Application from "./Application.ts";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Environment from "../environment/ServerEnvironment.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import * as Bridge from "./HostBridge.ts";
import * as Host from "./Host.ts";
import type { AgentRuntimeNotification } from "./Interface.ts";
import * as Runtime from "./Runtime.ts";
import * as Service from "./Service.ts";

it.live("serves each task overview section with its total", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-task-overview-" });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* Service.AgentRuntime;
        const request = (method: string, input: unknown = {}) =>
          runtime.handle({ id: method, method, input });
        yield* request("project.upsert", {
          id: "project:overview",
          title: "Overview",
          workspaceRoot: home,
        });
        yield* request("command.dispatch", {
          command: {
            type: "thread.create",
            commandId: "command:overview",
            threadId: "thread:overview",
            projectId: "project:overview",
            title: "Overview",
            modelSelection: { instanceId: "codex", model: "gpt-5.4" },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: home,
            createdBy: "user",
            creationSource: "web",
          },
        });
        expect(
          (yield* request("command.dispatch", {
            command: {
              type: "background-task.settle",
              commandId: "command:forged-settle",
              threadId: "thread:overview",
              providerThreadId: "provider:forged",
              taskId: "still-running",
              turnItemIds: [],
            },
          }).pipe(Effect.result))._tag,
        ).toBe("Failure");
        const empty = { items: [], nextCursor: null, hasMore: false, totalCount: 0 };
        expect(
          yield* request("background.output", { threadId: "thread:overview", taskId: "missing" }),
        ).toBeNull();
        for (const taskIds of [
          undefined,
          [],
          ["duplicate", "duplicate"],
          Array.from({ length: 26 }, (_, i) => `task:${i}`),
        ]) {
          expect(
            (yield* request("background.stop", {
              threadId: "thread:overview",
              commandId: "command:invalid-stop",
              taskIds,
            }).pipe(Effect.result))._tag,
          ).toBe("Failure");
        }
        expect(
          yield* request("background.stop", {
            threadId: "thread:overview",
            commandId: "command:stop-one-empty",
            taskIds: ["missing"],
          }),
        ).toEqual({ stopping: [] });
        const cancel = yield* request("tasks.cancel", {
          threadId: "thread:overview",
          taskId: "missing",
          commandId: "command:cancel-missing",
        }).pipe(Effect.result);
        expect(cancel._tag).toBe("Failure");
        expect(yield* request("tasks.overview", { threadId: "thread:overview" })).toEqual({
          active: empty,
          terminal: empty,
        });
        yield* request("command.dispatch", {
          command: {
            type: "thread.pull-request.watch",
            commandId: "command:overview-watch",
            threadId: "thread:overview",
            host: "github.com",
            repository: "acme/app",
            number: 1,
            watching: true,
            link: { url: "https://github.com/acme/app/pull/1", source: "agent" },
          },
        });
        const stop = {
          threadId: "thread:overview",
          commandId: "command:overview-stop",
          taskIds: ["pull-request-watch:github.com/acme/app#1"],
        };
        expect(yield* request("background.stop", stop)).toEqual({
          stopping: [],
        });
        expect(yield* request("background.stop", stop)).toEqual({
          stopping: [],
        });
      }).pipe(
        Effect.provide(Application.layer({ home, cwd: home, providers: {} }, () => Effect.void)),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.live("routes live and replayed task metadata to delegation ancestors only", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "nodex-task-tree-observe-" });
    const configuration = { home, cwd: home, providers: {} };
    const updates = yield* Queue.unbounded<Extract<AgentRuntimeNotification, { type: "event" }>>();
    const notify = (notification: AgentRuntimeNotification) =>
      notification.type === "event"
        ? Queue.offer(updates, notification).pipe(Effect.asVoid)
        : Effect.void;
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
    const application = Service.layer(notify, {}).pipe(
      Layer.provideMerge(host),
      Layer.provideMerge(bridge),
    );
    yield* Effect.gen(function* () {
      const runtime = yield* Service.AgentRuntime;
      const sink = yield* EventSinkV2;
      const projections = yield* ProjectionStoreV2;
      const now = yield* DateTime.now;
      const create = (threadId: ThreadId) =>
        runtime.handle({
          id: threadId,
          method: "command.dispatch",
          input: {
            command: {
              type: "thread.create",
              commandId: threadId + ":create",
              threadId,
              projectId: "project:overview",
              title: threadId,
              modelSelection: { instanceId: "codex", model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: home,
              createdBy: "user",
              creationSource: "web",
            },
          },
        });
      yield* runtime.handle({
        id: "project",
        method: "project.upsert",
        input: { id: "project:overview", title: "Tasks", workspaceRoot: home },
      });
      const rootId = ThreadId.make("root");
      const otherId = ThreadId.make("other");
      yield* create(rootId);
      yield* create(otherId);
      const root = yield* projections.getThread(rootId);
      const spawn = (parentThread: OrchestrationV2AppThread, id: string) =>
        makeSubagentChildThread({
          parentThread,
          childThreadId: ThreadId.make(id),
          parentNodeId: NodeId.make(id + ":task"),
          now,
          title: id,
          activeProviderThreadId: null,
          providerInstanceId: root.providerInstanceId,
          modelSelection: root.modelSelection,
          createdBy: "agent",
          creationSource: "provider",
        });
      const child = spawn(root, "child");
      const grandchild = spawn(child, "grandchild");
      const threadCreated = (thread: OrchestrationV2AppThread): OrchestrationV2DomainEvent => ({
        type: "thread.created",
        id: EventId.make(thread.id + ":create"),
        threadId: thread.id,
        occurredAt: now,
        payload: thread,
      });
      const task = (
        owner: ThreadId,
        name: string,
        childThreadId: ThreadId | null = null,
      ): Extract<OrchestrationV2DomainEvent, { type: "subagent.updated" }> => ({
        type: "subagent.updated",
        id: EventId.make(name + ":update"),
        threadId: owner,
        occurredAt: now,
        payload: {
          id: NodeId.make(name + ":task"),
          threadId: owner,
          runId: null,
          parentNodeId: NodeId.make("execution"),
          origin: "provider_native",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: root.providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Detail only",
          title: name,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      const seeded = yield* sink.write({
        events: [
          threadCreated(child),
          task(rootId, "child", child.id),
          threadCreated(grandchild),
          task(child.id, "grandchild", grandchild.id),
        ],
      });
      const afterSequence = seeded.at(-1)!.sequence;
      const observe = (id: string, subagentTree: boolean, cursor: number) =>
        runtime.handle({
          id,
          method: "events.observe",
          input: {
            threadId: rootId,
            eventTypes: ["subagent.updated"],
            subagentTree,
            afterSequence: cursor,
          },
        });
      yield* observe("work-tree", true, afterSequence);
      yield* observe("direct", false, afterSequence);
      const launched = task(grandchild.id, "deep");
      const deep = {
        ...launched,
        payload: {
          ...launched.payload,
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: ProviderInstanceId.make("antigravity"),
        },
      };
      yield* sink.write({
        events: [task(otherId, "unrelated"), deep, task(rootId, "direct")],
      });

      const firstThree = yield* Queue.takeN(updates, 3);
      const routed = firstThree.filter((event) => event.subscriptionId === "work-tree");
      expect(routed.map((event) => event.event.overviewSubagent?.id)).toEqual([
        "deep:task",
        "direct:task",
      ]);
      expect(routed[0]?.event).toMatchObject({
        event: { threadId: grandchild.id },
        overviewSubagent: {
          threadId: grandchild.id,
          parentTaskId: "grandchild:task",
          parentTaskChildThreadId: grandchild.id,
        },
      });
      expect(
        firstThree.find((event) => event.subscriptionId === "direct")?.event.event,
      ).toMatchObject({
        threadId: rootId,
        payload: { id: "direct:task" },
      });
      yield* observe("replay", true, afterSequence);
      const replayed = yield* Queue.takeN(updates, 2);
      expect(
        replayed.map((event) => [event.subscriptionId, event.event.overviewSubagent?.id]),
      ).toEqual([
        ["replay", "deep:task"],
        ["replay", "direct:task"],
      ]);

      const overview = yield* runtime.handle({
        id: "overview",
        method: "tasks.overview",
        input: { threadId: rootId },
      });
      expect(overview).toMatchObject({
        active: {
          totalCount: 4,
          items: expect.arrayContaining([
            expect.objectContaining({
              id: "deep:task",
              parentTaskId: "grandchild:task",
              parentTaskChildThreadId: grandchild.id,
            }),
          ]),
        },
      });

      // Each tree observer receives the current addressed metadata from either phase.
      for (const [status, seconds] of [
        ["idle", 1],
        ["running", 2],
      ] as const) {
        const updatedAt = DateTime.add(now, { seconds });
        yield* sink.write({
          events: [
            {
              ...deep,
              id: EventId.make(`deep:${status}`),
              occurredAt: updatedAt,
              payload: {
                ...deep.payload,
                status,
                updatedAt,
                completedAt: status === "idle" ? updatedAt : null,
              },
            },
          ],
        });
        const reports = yield* Queue.takeN(updates, 2);
        expect(reports.map((report) => report.subscriptionId).sort()).toEqual([
          "replay",
          "work-tree",
        ]);
        for (const report of reports) {
          expect(report.event.overviewSubagent).toMatchObject({
            id: deep.payload.id,
            status,
            parentTaskId: "grandchild:task",
            parentTaskChildThreadId: grandchild.id,
          });
        }
      }
      yield* runtime.handle({
        id: "unobserve-direct",
        method: "events.unobserve",
        input: { subscriptionId: "direct" },
      });
      const original = task(rootId, "child", child.id).payload;
      const at = (seconds: number) => DateTime.add(now, { seconds });
      const applyTask = Effect.fnUntraced(function* (payload: typeof original) {
        yield* sink.write({
          events: [
            {
              type: "subagent.updated",
              id: EventId.make(`${payload.id}:${payload.status}`),
              threadId: rootId,
              occurredAt: payload.updatedAt,
              payload,
            },
          ],
        });
        return yield* Queue.takeN(updates, 2);
      });
      yield* applyTask({
        ...original,
        origin: "app_owned",
        status: "interrupted",
        completedAt: at(3),
        updatedAt: at(3),
      });
      const followup: typeof original = {
        ...original,
        origin: "app_owned",
        id: NodeId.make("task:child-follow-up"),
        title: "Changed name",
        status: "running",
        startedAt: at(4),
        updatedAt: at(4),
      };
      const started = yield* applyTask(followup);
      for (const report of started) {
        expect(report.event.overviewSubagent).toMatchObject({
          id: original.id,
          taskId: followup.id,
          delegatedAt: DateTime.formatIso(now),
          title: original.title,
          status: "running",
        });
      }

      const settled = yield* applyTask({
        ...followup,
        status: "completed",
        completedAt: at(5),
        updatedAt: at(5),
      });
      for (const report of settled) {
        expect(report.event.overviewSubagent).toMatchObject({
          id: original.id,
          taskId: followup.id,
          status: "completed",
          updatedAt: DateTime.formatIso(at(5)),
        });
      }

      const queuedId = NodeId.make("task:child-queued");
      const queued = {
        id: RunId.make("run:child-queued"),
        threadId: child.id,
        ordinal: 1,
        providerInstanceId: child.providerInstanceId,
        modelSelection: child.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:child-queued"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "queued" as const,
        requestedAt: at(6),
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        delegatedTaskId: queuedId,
      };
      yield* sink.write({
        events: [
          {
            type: "run.created",
            id: EventId.make("run:child-queued:created"),
            threadId: child.id,
            occurredAt: at(6),
            payload: queued,
          },
        ],
      });
      yield* applyTask({
        ...followup,
        id: queuedId,
        status: "pending",
        startedAt: at(6),
        updatedAt: at(6),
      });
      for (const [held, taskId, status] of [
        [true, followup.id, "completed"],
        [false, queuedId, "pending"],
      ] as const) {
        yield* sink.write({
          events: [
            {
              type: "run.updated",
              id: EventId.make(`run:child-queued:held:${held}`),
              threadId: child.id,
              occurredAt: at(held ? 7 : 8),
              payload: { ...queued, queueHeld: held },
            },
          ],
        });
        const reports = yield* Queue.takeN(updates, 2);
        for (const report of reports) {
          expect(report.event.event.type).toBe("run.updated");
          expect(report.event.overviewSubagent).toMatchObject({
            id: original.id,
            taskId,
            status,
            updatedAt: DateTime.formatIso(at(6)),
          });
        }
      }
    }).pipe(Effect.provide(application));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
