import { expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  NodeId,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ProviderThread,
  ProviderThreadId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";

import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

it("stamps authoritative provenance on commands that create threads or messages", () => {
  const command: OrchestrationV2Command = {
    type: "thread.create",
    createdBy: "agent",
    creationSource: "mcp",
    commandId: CommandId.make("command:thread-management:create"),
    threadId: ThreadId.make("thread:thread-management:create"),
    projectId: ProjectId.make("project:thread-management"),
    title: "Thread management",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5-codex",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
  };

  expect(
    ThreadManagementService.withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toMatchObject({
    createdBy: "user",
    creationSource: "web",
  });
});

it("leaves commands that do not create durable authored content unchanged", () => {
  const command: OrchestrationV2Command = {
    type: "run.interrupt",
    commandId: CommandId.make("command:thread-management:interrupt"),
    threadId: ThreadId.make("thread:thread-management:interrupt"),
    runId: RunId.make("run:thread-management:interrupt"),
  };

  expect(
    ThreadManagementService.withCreationProvenance(command, {
      createdBy: "user",
      creationSource: "web",
    }),
  ).toBe(command);
});

it("identifies every existing thread that must be hydrated before dispatch", () => {
  const sourceThreadId = ThreadId.make("thread:thread-management:source");
  const targetThreadId = ThreadId.make("thread:thread-management:target");
  const parentThreadId = ThreadId.make("thread:thread-management:parent");

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:create"),
      threadId: targetThreadId,
      projectId: ProjectId.make("project:thread-management"),
      title: "Created thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    }),
  ).toEqual([]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.archive",
      commandId: CommandId.make("command:thread-management:archive"),
      threadId: targetThreadId,
    }),
  ).toEqual([targetThreadId]);

  // Read-state commands skip transcript hydration entirely: they fire on
  // every activity bump while a thread is open and never touch messages.
  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.visit",
      commandId: CommandId.make("command:thread-management:visit"),
      threadId: targetThreadId,
      visitedAt: "2026-07-30T00:00:00.000Z",
    }),
  ).toEqual([]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.mark-unread",
      commandId: CommandId.make("command:thread-management:mark-unread"),
      threadId: targetThreadId,
    }),
  ).toEqual([]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.fork",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.merge_back",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:thread-management:merge"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: {
        type: "run",
        runId: RunId.make("run:thread-management:source"),
      },
    }),
  ).toEqual([sourceThreadId, targetThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "provider",
      commandId: CommandId.make("command:thread-management:delegate"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      task: "Inspect the migration",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
    }),
  ).toEqual([parentThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "delegated_task.wake-policy",
      commandId: CommandId.make("command:thread-management:wake-policy"),
      parentThreadId,
      taskId: NodeId.make("node:thread-management:delegated"),
      completionWake: "always",
    }),
  ).toEqual([parentThreadId]);

  expect(
    ThreadManagementService.existingThreadIdsForCommand({
      type: "thread.created.record",
      commandId: CommandId.make("command:thread-management:record"),
      parentThreadId,
      parentRunId: RunId.make("run:thread-management:parent"),
      parentNodeId: NodeId.make("node:thread-management:parent"),
      targetThreadId,
      targetRunId: null,
    }),
  ).toEqual([parentThreadId, targetThreadId]);
});

it("derives thread management messages from structural error attributes", () => {
  const projectId = ProjectId.make("project:thread-management:errors");
  const threadId = ThreadId.make("thread:thread-management:errors");
  const runId = RunId.make("run:thread-management:errors");
  const messageId = MessageId.make("message:thread-management:errors");
  const infrastructureCause = new Error("private sqlite detail");

  const threadNotFound = new ThreadManagementService.ThreadManagementThreadNotFoundError({
    projectId,
    threadId,
  });
  expect(threadNotFound).toMatchObject({ projectId, threadId });
  expect(threadNotFound.message).toBe(`Thread ${threadId} was not found in project ${projectId}.`);

  const runNotFound = new ThreadManagementService.ThreadManagementRunNotFoundError({
    threadId,
    runId,
  });
  expect(runNotFound).toMatchObject({ threadId, runId });
  expect(runNotFound.message).toBe(`Run ${runId} does not belong to thread ${threadId}.`);

  const archived = new ThreadManagementService.ThreadManagementThreadArchivedError({
    threadId,
  });
  expect(archived).toMatchObject({ threadId });
  expect(archived.message).toBe(`Thread ${threadId} is archived and cannot receive messages.`);

  const notInterruptible = new ThreadManagementService.ThreadManagementThreadNotInterruptibleError({
    threadId,
    runId,
  });
  expect(notInterruptible).toMatchObject({ threadId, runId });
  expect(notInterruptible.message).toBe(`Run ${runId} is not currently interruptible.`);

  const listFailure = new ThreadManagementService.ThreadManagementProjectThreadsListError({
    projectId,
    cause: infrastructureCause,
  });
  expect(listFailure).toMatchObject({ projectId, cause: infrastructureCause });
  expect(listFailure.message).toBe(`Unable to list threads in project ${projectId}.`);
  expect(listFailure.message).not.toContain(infrastructureCause.message);

  const durableProjectionFailure =
    new ThreadManagementService.ThreadManagementDurableRunProjectionError({
      threadId,
      messageId,
    });
  expect(durableProjectionFailure).toMatchObject({ threadId, messageId });
  expect(durableProjectionFailure.message).toBe(
    `Message ${messageId} was accepted on thread ${threadId} without a durable run projection.`,
  );
});

const layerReceiptsTest = CommandReceiptStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
);

const layerThreadManagementTest = (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) =>
  ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(Layer.mock(Orchestrator.OrchestratorV2)({})),
    Layer.provide(settingsLayer),
    Layer.provide(layerReceiptsTest),
  );

it.effect("refuses a new turn when the project effectively disables the instance", () => {
  const projectId = ProjectId.make("project:thread-management:gate-disabled");
  const instanceId = ProviderInstanceId.make("codex_work");
  const commandId = CommandId.make("command:thread-management:gate-disabled");
  const layerTest = layerThreadManagementTest(
    ServerSettings.layerTest({
      providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      },
    }),
  );

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(
      threads.assertProviderInstanceEnabled({ projectId, commandId, instanceId }),
    );

    expect(error).toBeInstanceOf(
      ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
    );
    expect(error).toMatchObject({ projectId, instanceId });
    expect(error.message).toBe(
      `Provider instance "${instanceId}" is disabled for project ${projectId}.`,
    );
  }).pipe(Effect.provide(layerTest));
});

it.effect("allows a new turn when the project enables an instance the machine disabled", () => {
  const projectId = ProjectId.make("project:thread-management:gate-enabled");
  const instanceId = ProviderInstanceId.make("codex_work");
  const commandId = CommandId.make("command:thread-management:gate-enabled");
  const layerTest = layerThreadManagementTest(
    ServerSettings.layerTest({
      providerInstances: { [instanceId]: { driver: "codex", enabled: false } },
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    }),
  );

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    yield* threads.assertProviderInstanceEnabled({ projectId, commandId, instanceId });
  }).pipe(Effect.provide(layerTest));
});

it.effect("inherits the machine value when the project has no override", () => {
  const projectId = ProjectId.make("project:thread-management:gate-inherit");
  const instanceId = ProviderInstanceId.make("codex_work");
  const commandId = CommandId.make("command:thread-management:gate-inherit");
  const layerTest = layerThreadManagementTest(
    ServerSettings.layerTest({
      providerInstances: { [instanceId]: { driver: "codex", enabled: false } },
    }),
  );

  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(
      threads.assertProviderInstanceEnabled({ projectId, commandId, instanceId }),
    );

    expect(error).toBeInstanceOf(
      ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
    );
  }).pipe(Effect.provide(layerTest));
});

const layerDispatchChokepointTest =
  (settingsLayer: ReturnType<typeof ServerSettings.layerTest>) => (dispatched: Array<string>) =>
    ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadRecords: () =>
            Effect.succeed({
              thread: {
                id: ThreadId.make("thread:thread-management:chokepoint"),
                projectId: ProjectId.make("project:thread-management:chokepoint"),
                deletedAt: null,
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex_work"),
                  model: "test",
                },
              },
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(settingsLayer),
      Layer.provideMerge(layerReceiptsTest),
    );

it.effect(
  "rechecks the admitted foreground before a command reaches the durable dispatcher",
  () => {
    const dispatched: string[] = [];
    let checks = 0;
    const layer = layerDispatchChokepointTest(ServerSettings.layerTest({}))(dispatched);
    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const result = yield* threads
        .dispatch({
          type: "thread.visit",
          commandId: CommandId.make("command:stale-admission"),
          threadId: ThreadId.make("thread:stale-admission"),
          visitedAt: "2026-10-14T00:00:00.000Z",
        })
        .pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(checks).toBe(1);
      expect(dispatched).toEqual([]);
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(ExecutionHost.McpTurnAdmission, {
        actor: undefined,
        requestId: "request:stale",
        assertCurrent: () =>
          Effect.sync(() => {
            checks++;
          }).pipe(
            Effect.andThen(
              Effect.fail(
                new ExecutionHost.ExecutionHostError({
                  operation: "mcp.admission",
                  message: "The foreground Run changed.",
                }),
              ),
            ),
          ),
      }),
    );
  },
);

it.effect(
  "the dispatch chokepoint refuses a continuation message.dispatch on a project-disabled instance before reaching the orchestrator",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-disabled");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const error = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId,
          threadId,
          messageId: MessageId.make("message:thread-management:chokepoint-disabled"),
          text: "Background task completed.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        }),
      );

      expect(error).toBeInstanceOf(
        ThreadManagementService.ThreadManagementProviderInstanceDisabledError,
      );
      expect(error).toMatchObject({ projectId, instanceId });
      expect(dispatched).toEqual([]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "a replay of an already-accepted command id dispatches despite the instance now being disabled",
  () => {
    const projectId = ProjectId.make("project:thread-management:chokepoint");
    const threadId = ThreadId.make("thread:thread-management:chokepoint");
    const instanceId = ProviderInstanceId.make("codex_work");
    const commandId = CommandId.make("command:thread-management:chokepoint-replay");
    const dispatched: Array<string> = [];
    const layerTest = layerDispatchChokepointTest(
      ServerSettings.layerTest({
        providerInstances: { [instanceId]: { driver: "codex", enabled: true } },
        projectSettingsOverrides: {
          [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
        },
      }),
    )(dispatched);

    return Effect.gen(function* () {
      const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
      yield* receipts.insertIfAbsent({
        commandId,
        threadId,
        commandType: "message.dispatch",
        acceptedAt: yield* DateTime.now,
        resultSequence: 1,
        status: "accepted",
        error: null,
      });

      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.dispatch({
        type: "message.dispatch",
        commandId,
        threadId,
        messageId: MessageId.make("message:thread-management:chokepoint-replay"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });

      expect(dispatched).toEqual(["message.dispatch"]);
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect("classifies projection infrastructure failures separately from a missing thread", () => {
  const projectId = ProjectId.make("project:thread-management:projection-failure");
  const threadId = ThreadId.make("thread:thread-management:projection-failure");
  const infrastructureCause = new Error("sqlite read failed");
  const projectionError = new Orchestrator.OrchestratorProjectionError({
    threadId,
    cause: infrastructureCause,
  });
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () => Effect.fail(projectionError),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementProjectionLoadError);
    expect(error).toMatchObject({
      projectId,
      threadId,
      cause: projectionError,
    });
    expect(error.message).toBe(`Unable to load thread ${threadId} in project ${projectId}.`);
  }).pipe(Effect.provide(layerTest));
});

it.effect("uses thread-not-found only after a projection loads outside the project", () => {
  const projectId = ProjectId.make("project:thread-management:requested");
  const otherProjectId = ProjectId.make("project:thread-management:other");
  const threadId = ThreadId.make("thread:thread-management:wrong-project");
  const projection = {
    thread: {
      id: threadId,
      projectId: otherProjectId,
      deletedAt: null,
    },
  } as OrchestrationV2ThreadProjection;
  const layerTest = ThreadManagementService.layer.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadProjection: () => Effect.succeed(projection),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );

  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* Effect.flip(service.getProjectThread({ projectId, threadId }));

    expect(error).toBeInstanceOf(ThreadManagementService.ThreadManagementThreadNotFoundError);
    expect(error).toMatchObject({ projectId, threadId });
    expect("cause" in error).toBe(false);
  }).pipe(Effect.provide(layerTest));
});

it.effect("preserves failed legacy materialization when reading checkpoint context", () => {
  const threadId = ThreadId.make("thread:thread-management:checkpoint-import-failure");
  const importError = new LegacyV1ThreadImporter.LegacyV1ThreadImportError({
    threadId,
    operation: "hydrate transcript for",
    cause: new Error("checkpoint import failed"),
  });
  const layerTest = ThreadManagementService.layerWithLegacyImporter.pipe(
    Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getCheckpointContext: () =>
            Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] }),
        }),
        Layer.mock(LegacyV1ThreadImporter.LegacyV1ThreadImporter)({
          ensureTranscript: () => Effect.fail(importError),
        }),
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(layerReceiptsTest),
  );
  return Effect.gen(function* () {
    const service = yield* ThreadManagementService.ThreadManagementService;
    const error = yield* service.getCheckpointContext(threadId).pipe(Effect.flip);
    expect(error).toBeInstanceOf(Orchestrator.OrchestratorProjectionError);
    expect(error).toMatchObject({ threadId, cause: importError });
  }).pipe(Effect.provide(layerTest));
});

it.effect.each([
  { finalStatus: "completed" as const, timedOut: false },
  { finalStatus: "failed" as const, timedOut: false },
  { finalStatus: "cancelled" as const, timedOut: false },
  { finalStatus: "interrupted" as const, timedOut: false },
  { finalStatus: "rolled_back" as const, timedOut: false },
  { finalStatus: "running" as const, timedOut: true },
  { finalStatus: "missing" as const },
])("waitForThread timeout final read when selected run is $finalStatus", (scenario) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-timeout");
    const threadId = ThreadId.make("thread:thread-management:wait-timeout");
    const runId = RunId.make("run:thread-management:wait-timeout");
    const subscribed = yield* Deferred.make<void>();
    let reads = 0;
    const projection = (status: OrchestrationV2Run["status"] | "missing") =>
      ({
        thread: { id: threadId, projectId, deletedAt: null },
        runs: status === "missing" ? [] : [{ id: runId, status }],
      }) as unknown as OrchestrationV2ThreadProjection;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          // No run update arrives, so the timeout path runs while a final
          // projection read can still observe a terminal run.
          streamStoredEventsFrom: () =>
            Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
              Stream.drain,
              Stream.concat(Stream.never),
            ),
          getThreadRecords: () =>
            Effect.sync(() => {
              reads += 1;
              return projection(reads === 1 ? "running" : scenario.finalStatus);
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({
        projectId,
        threadId,
        runId,
        timeoutMs: 1,
      })
      .pipe(Effect.result, Effect.forkChild);
    yield* Deferred.await(subscribed);
    yield* TestClock.adjust(Duration.millis(1));
    const result = yield* Fiber.join(fiber);

    if (scenario.finalStatus === "missing") {
      expect(result._tag).toBe("Failure");
      expect(result).toMatchObject({
        failure: expect.any(ThreadManagementService.ThreadManagementRunNotFoundError),
      });
      expect(result).toMatchObject({
        failure: { threadId, runId },
      });
    } else {
      expect(result._tag).toBe("Success");
      expect(result).toMatchObject({
        success: {
          threadId,
          timedOut: scenario.timedOut,
          run: { id: runId, status: scenario.finalStatus },
        },
      });
    }
  }),
);

it.effect("waitForThread reads the run again only when the run updates", () =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:wait-event");
    const threadId = ThreadId.make("thread:thread-management:wait-event");
    const runId = RunId.make("run:thread-management:wait-event");
    const subscribed = yield* Deferred.make<void>();
    const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    let status: OrchestrationV2Run["status"] = "running";
    let reads = 0;
    const stored = (sequence: number, event: object) =>
      ({ sequence, event: { threadId, ...event } }) as unknown as OrchestrationV2StoredEvent;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          // Only the run.updated stream carries events in this test.
          streamStoredEventsFrom: (input) =>
            input?.eventType === "run.updated"
              ? Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
                  Stream.drain,
                  Stream.concat(Stream.fromQueue(events)),
                )
              : Stream.never,
          getThreadRecords: () =>
            Effect.sync(() => {
              reads += 1;
              return {
                thread: { id: threadId, projectId, deletedAt: null },
                runs: [{ id: runId, status }],
              } as unknown as OrchestrationV2ThreadProjection;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );
    const fiber = yield* service
      .waitForThread({ projectId, threadId, runId, timeoutMs: 60 * 60 * 1_000 })
      .pipe(Effect.forkChild);
    yield* Deferred.await(subscribed);
    status = "completed";
    yield* Queue.offer(events, stored(1, { type: "run.updated", payload: { id: "other-run" } }));
    yield* Queue.offer(events, stored(2, { type: "run.updated", payload: { id: runId, status } }));
    const result = yield* Fiber.join(fiber);

    expect(result).toMatchObject({ timedOut: false, run: { id: runId, status: "completed" } });
    // The first read plus one for this run's update. The other run caused none.
    expect(reads).toBe(2);
  }),
);

it.effect.each([
  "running",
  "missing",
  "completed",
  "unsupported",
  "missing-native-id",
  "wrong-thread",
  "no-session",
  "unsupported-runtime",
  "provider-failed",
  "provider-timeout",
] as const)("stops a persisted workflow with state %s", (state) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:workflow-stop");
    const subagentId = NodeId.make("node:workflow-stop");
    const runId = RunId.make("run:workflow-stop");
    const providerThreadId = ProviderThreadId.make("provider-thread:workflow-stop");
    const providerSessionId = ProviderSessionId.make("provider-session:workflow-stop");
    const driver = ProviderDriverKind.make("claudeAgent");
    const instanceId = ProviderInstanceId.make("claudeAgent");
    const now = yield* DateTime.now;
    const targetModes: Pick<OrchestrationV2ThreadShell, "runtimeMode" | "interactionMode"> = {
      runtimeMode: "full-access",
      interactionMode: "plan",
    };
    const task: OrchestrationV2Subagent = {
      id: subagentId,
      threadId,
      runId,
      parentNodeId: NodeId.make("node:workflow-parent"),
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId: instanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef:
        state === "missing-native-id"
          ? null
          : {
              driver,
              nativeId: "native-workflow-id",
              strength: "strong",
            },
      workflow: { phases: [], agents: [] },
      prompt: "Run the workflow",
      title: null,
      model: null,
      status: state === "completed" ? "completed" : "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      ...(state === "unsupported" ? { driver: ProviderDriverKind.make("codex") } : {}),
    };
    const providerThread: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId: instanceId,
      providerSessionId,
      appThreadId: state === "wrong-thread" ? ThreadId.make("other-thread") : threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: null,
      createdAt: now,
      updatedAt: now,
    };
    const calls: Array<{ taskId: string; providerThread: OrchestrationV2ProviderThread }> = [];
    const stopStarted = yield* Deferred.make<void>();
    const runtime = {
      driver,
      providerSessionId,
      instanceId,
      ...(state === "unsupported-runtime"
        ? {}
        : {
            stopTask: (input: (typeof calls)[number]) =>
              state === "provider-failed"
                ? Effect.fail(
                    new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: "private provider detail",
                    }),
                  )
                : state === "provider-timeout"
                  ? Deferred.succeed(stopStarted, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.sync(() => {
                      calls.push(input);
                    }),
          }),
    } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getThreadRecords: () =>
              Effect.sync(
                () =>
                  ({
                    thread: { id: threadId, deletedAt: null, ...targetModes },
                    subagents: state === "missing" ? [] : [task],
                    runs: [{ id: runId, providerThreadId }],
                    providerThreads: [providerThread],
                  }) as unknown as OrchestrationV2ThreadProjection,
              ),
          }),
          Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
            get: (id) => {
              expect(id).toBe(providerSessionId);
              return Effect.succeed(state === "no-session" ? Option.none() : Option.some(runtime));
            },
          }),
        ),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    yield* Effect.gen(function* () {
      const service = yield* ThreadManagementService.ThreadManagementService;
      const stop = service.stopWorkflow({ threadId, subagentId }).pipe(Effect.result);
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const result =
        state === "provider-timeout"
          ? yield* Effect.gen(function* () {
              const finished = yield* Ref.make(false);
              const pending = yield* stop.pipe(
                Effect.tap(() => Ref.set(finished, true)),
                Effect.forkChild,
              );
              yield* Deferred.await(stopStarted);
              yield* TestClock.adjust("15 seconds");
              expect(yield* Ref.get(finished)).toBe(true);
              const result = yield* Fiber.join(pending);
              expect(yield* executor.withLock(threadId, Effect.succeed("lock-released"))).toBe(
                "lock-released",
              );
              return result;
            })
          : yield* stop;
      if (state === "running") {
        expect(result).toMatchObject({ _tag: "Success" });
        expect(calls).toEqual([{ taskId: "native-workflow-id", providerThread }]);
        expect(task.status).toBe("running");
      } else {
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "OrchestrationV2StopWorkflowError",
            threadId,
            subagentId,
            reason:
              state === "missing" || state === "completed"
                ? "not-running"
                : state === "unsupported" || state === "unsupported-runtime"
                  ? "unsupported"
                  : state === "provider-failed" || state === "provider-timeout"
                    ? "stop-failed"
                    : "unavailable",
          },
        });
        expect(calls).toEqual([]);
        if (state === "provider-timeout") {
          expect(result).toMatchObject({ failure: { cause: { _tag: "TimeoutError" } } });
        }
      }
    }).pipe(Effect.provide(Layer.merge(layerTest, ThreadCommandExecutor.layer)));
  }),
);

it.effect.each([
  { status: "completed" as const, settles: true },
  { status: "failed" as const, settles: false },
  { status: "interrupted" as const, settles: false },
])("settleAfterRun settles only when the run $status", ({ status, settles }) =>
  Effect.gen(function* () {
    const projectId = ProjectId.make("project:thread-management:settle-after-run");
    const threadId = ThreadId.make("thread:thread-management:settle-after-run");
    const runId = RunId.make("run:thread-management:settle-after-run");
    const dispatched: Array<string> = [];
    const layerTest = ThreadManagementService.layer.pipe(
      Layer.provide(Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({})),
      Layer.provide(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadEventSequence: () => Effect.succeed(0),
          getThreadRecords: () =>
            Effect.succeed({
              thread: { id: threadId, projectId, deletedAt: null },
              runs: [{ id: runId, status }],
            } as unknown as OrchestrationV2ThreadProjection),
          dispatch: (command) =>
            Effect.sync(() => {
              dispatched.push(command.type);
              return { sequence: 1, storedEvents: [] } as never;
            }),
        }),
      ),
      Layer.provide(ServerSettings.layerTest()),
      Layer.provide(layerReceiptsTest),
    );
    const service = yield* ThreadManagementService.ThreadManagementService.pipe(
      Effect.provide(layerTest),
    );

    yield* service.settleAfterRun({ projectId, threadId, runId });

    expect(dispatched).toEqual(settles ? ["thread.settle"] : []);
  }),
);

it.effect(
  "reads output from the live task's owning provider thread instead of the foreground owner",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:background-output");
      const providerSessionId = ProviderSessionId.make("session:background-output");
      const ownerId = ProviderThreadId.make("provider-thread:background-output");
      const calls: string[] = [];
      const owner: OrchestrationV2ProviderThread = {
        id: ownerId,
        appThreadId: threadId,
        providerSessionId,
        driver: ProviderDriverKind.make("claude"),
        providerInstanceId: ProviderInstanceId.make("claude"),
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        createdAt: yield* DateTime.now,
        updatedAt: yield* DateTime.now,
        pendingBackgroundTasks: [
          { taskId: "shell", kind: "command" },
          { taskId: "agent", kind: "subagent" },
        ],
      };
      const runtime = {
        readTaskOutput: (input: {
          providerThread: OrchestrationV2ProviderThread;
          taskId: string;
        }) =>
          Effect.sync(() => {
            expect(input.providerThread.id).toBe(ownerId);
            calls.push(input.taskId);
            return { text: "Ready", truncated: false, totalBytes: 5 };
          }),
      } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime;
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: () =>
                Effect.succeed({
                  thread: {
                    id: threadId,
                    activeProviderThreadId: ProviderThreadId.make("foreground"),
                  },
                  providerThreads: [
                    {
                      ...owner,
                      id: ProviderThreadId.make("foreign"),
                      appThreadId: null,
                      pendingBackgroundTasks: [{ taskId: "foreign", kind: "command" }],
                    },
                    {
                      ...owner,
                      id: ProviderThreadId.make("foreground"),
                      pendingBackgroundTasks: [],
                    },
                    owner,
                  ],
                } as unknown as OrchestrationV2ThreadProjection),
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
              get: (id) => {
                expect(id).toBe(providerSessionId);
                return Effect.succeed(Option.some(runtime));
              },
            }),
          ),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        expect(yield* service.backgroundOutput({ threadId, taskId: "shell" })).toEqual({
          text: "Ready",
          truncated: false,
          totalBytes: 5,
        });
        for (const taskId of ["gone", "agent", "foreign"])
          expect(yield* service.backgroundOutput({ threadId, taskId })).toBeNull();
        expect(calls).toEqual(["shell"]);
      }).pipe(Effect.provide(layerTest));
    }),
);

it.effect.each(["interrupted", "completed", "terminal"] as const)(
  "preserves waiting versus terminal cancellation semantics after disposal fails: %s",
  (status) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("parent:restart-cancel");
      const childThreadId = ThreadId.make("child:restart-cancel");
      const taskId = NodeId.make("task:restart-cancel");
      const run = {
        id: RunId.make("run:restart-cancel"),
        ordinal: 1,
        status: status === "terminal" ? "completed" : status,
        delegatedTaskId: taskId,
      } as OrchestrationV2Run;
      const task = {
        id: taskId,
        threadId,
        origin: "app_owned",
        childThreadId,
        status: status === "terminal" ? "completed" : "running",
        result: status === "terminal" ? "Final result" : null,
        completionDelivery: { state: "pending", observedByRunId: null },
      } as unknown as OrchestrationV2Subagent;
      const commands: string[] = [];
      const layerTest = ThreadManagementService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getThreadRecords: (id) =>
                Effect.succeed({
                  thread: { id },
                  runs: [run],
                  subagents: id === threadId ? [task] : [],
                  contextTransfers: [],
                } as unknown as OrchestrationV2ThreadProjection),
              delegatedTaskResultPending: () => Effect.succeed(status !== "terminal"),
              getThreadShell: () => Effect.die("Waiting delegated work has no foreground Run"),
              dispatch: (command) => {
                commands.push(command.type);
                return command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(
                      new Orchestrator.OrchestratorDispatchError({
                        commandId: command.commandId,
                        commandType: command.type,
                        cause: "Delivery is not ready",
                      }),
                    )
                  : Effect.succeed({ sequence: 1, storedEvents: [] });
              },
            }),
            Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
          ),
        ),
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(layerReceiptsTest),
      );
      yield* Effect.gen(function* () {
        const service = yield* ThreadManagementService.ThreadManagementService;
        const result = yield* service
          .cancelDelegatedTask({
            threadId,
            taskId,
            commandId: CommandId.make("command:restart-cancel"),
          })
          .pipe(Effect.result);
        if (status === "terminal")
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { reason: "orchestration-error" },
          });
        else
          expect(result).toMatchObject({
            _tag: "Success",
            success: { taskId, status: "cancel_requested" },
          });
        expect(commands).toEqual(["thread.stop", "delegated_task.completion-delivery.dispose"]);
      }).pipe(Effect.provide(layerTest));
    }),
);
