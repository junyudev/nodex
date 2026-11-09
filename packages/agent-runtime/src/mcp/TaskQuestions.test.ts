import { recordTaskResult, withTaskResultDelivery } from "./TaskResultDelivery.ts";
import * as ExecutionHost from "@nodex/provider-core/server/ExecutionHost";
import { DEFAULT_MODEL_POLICY } from "../../../../src/shared/model-policy.ts";
import { RuntimeModelPolicy, make as makePolicy } from "../nodex/ModelPolicy.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  OrchestratorMcpRuntimeMode,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  type RuntimeMode,
  ThreadId,
  TurnItemId,
} from "@nodex/runtime-contracts";
import type * as ProviderAdapter from "@nodex/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Questions from "../orchestration-v2/DelegatedTaskQuestionReactor.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as Settings from "../serverSettings.ts";
import { layerToolkit } from "../nodex/Mcp.ts";
import * as Invocation from "./McpInvocationContext.ts";
import * as Tasks from "./OrchestratorMcpService.ts";
import * as Access from "./McpToolAccess.ts";
import { dispatchFailure } from "./threadAccess.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-6-luna" };
const parentId = ThreadId.make("thread:question-parent");
const providerSessionId = ProviderSessionId.make("session:child-question");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Question control tests never launch a provider"),
} satisfies ProviderAdapter.ProviderAdapterV2["Service"];
const registry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
const database = Sqlite.layerMemory;
const engine = Replay.layerWithRegistry({ name: "task-questions" }, registry, {
  databaseLayer: database,
  runEffectWorker: false,
});
const threads = Threads.layer.pipe(
  Layer.provideMerge(engine),
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(database))),
  Layer.provide(Settings.layerTest()),
);
const layerTest = layerToolkit.pipe(
  Layer.provideMerge(Tasks.layer),
  Layer.provideMerge(database),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(Questions.layer),
  Layer.provideMerge(threads),
  Layer.provideMerge(registry),
  Layer.provideMerge(
    ProviderRegistryMock.layer([
      {
        instanceId,
        driver: adapter.driver,
        enabled: true,
        installed: true,
        version: "test",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-31T00:00:00.000Z",
        models: [
          {
            slug: modelSelection.model,
            name: modelSelection.model,
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      },
    ]),
  ),
  Layer.provideMerge(Settings.layerTest()),
  Layer.provideMerge(NodeServices.layer),
);
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "task-questions", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "task-questions", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const scope = (threadId = parentId): Invocation.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:task-questions"),
  requestNamespace: `task-questions:${threadId}`,
  thread: { threadId, providerInstanceId: instanceId, providerSessionId: "session:parent" },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
});
const questions = [
  {
    id: "format",
    header: "Format",
    question: "Which format?",
    options: [],
    allowCustomAnswer: true,
  },
];
const failure = (result: McpSchema.CallToolResult) => {
  const content = result.content[0];
  expect(result.isError).toBe(true);
  if (content?.type !== "text") throw new Error("Expected a declared tool failure");
  return JSON.parse(content.text);
};
const setup = Effect.fn("TaskQuestions.setup")(function* (
  completionWake: "always" | "settled_only" = "always",
  runtimeMode: RuntimeMode = "full-access",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const reactor = yield* Questions.DelegatedTaskQuestionReactor;
  const server = yield* McpServer.McpServer;
  const create = (threadId: ThreadId) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:questions"),
      title: "Question coordinator",
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  yield* create(parentId);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("start:question-parent"),
    threadId: parentId,
    messageId: MessageId.make("message:question-parent"),
    text: "Delegate the research",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const parentRun = (yield* projections.getThreadRecords(parentId, ["runs"])).runs[0]!;
  yield* orchestrator.dispatch({
    type: "delegated_task.request",
    commandId: CommandId.make("delegate:question-task"),
    parentThreadId: parentId,
    parentRunId: parentRun.id,
    parentNodeId: parentRun.rootNodeId!,
    task: "Research the sources",
    completionWake,
    modelSelection,
    runtimeMode,
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
  });
  const task = (yield* projections.getThreadRecords(parentId, ["subagents"])).subagents[0]!;
  const addRequest = Effect.fn("TaskQuestions.addRequest")(function* (
    id: string,
    capability: "live" | "message" | "codex_question_reply" = "live",
    kind: OrchestrationV2RuntimeRequest["kind"] = "user_input",
    target = task,
    createdAt?: DateTime.Utc,
  ) {
    const threadId = target.childThreadId!;
    const child = yield* projections.getThreadRecords(threadId, ["runs"]);
    const run = child.runs.find((run) => run.delegatedTaskId === target.id) ?? child.runs[0]!;
    const now = createdAt ?? (yield* DateTime.now);
    const requestId = RuntimeRequestId.make(id);
    const nodeId = NodeId.make(`node:${id}`);
    const event = {
      id: EventId.make(`event:${id}`),
      type: "runtime-request.updated",
      threadId,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability:
          capability === "live"
            ? { type: "live", providerSessionId }
            : capability === "codex_question_reply"
              ? { type: "message", replyFormat: "codex_question_reply" }
              : { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    } satisfies OrchestrationV2DomainEvent;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`session:${id}`),
          type: "provider-session.attached",
          threadId,
          occurredAt: now,
          payload: {
            id: providerSessionId,
            driver: adapter.driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        },
        {
          id: EventId.make(`node:${id}`),
          type: "node.updated",
          threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            id: nodeId,
            threadId,
            runId: run.id,
            parentNodeId: run.rootNodeId,
            rootNodeId: run.rootNodeId!,
            kind: kind === "user_input" ? "user_input_request" : "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        event,
        ...(kind !== "user_input"
          ? []
          : [
              {
                id: EventId.make(`item:${id}`),
                type: "turn-item.updated" as const,
                threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`item:${id}`),
                  threadId,
                  runId: run.id,
                  nodeId,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: 10,
                  status: "waiting" as const,
                  title: null,
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  type: "user_input_request" as const,
                  requestId,
                  questions,
                },
              },
            ]),
      ],
    });
    return event;
  });
  const invoke = (name: string, args: Record<string, unknown>, caller = scope()) =>
    server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(Invocation.McpInvocationContext, caller),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  const question = (args: Record<string, unknown>, caller = scope()) =>
    invoke("task_question", { taskId: task.id, ...args }, caller);
  const notifications = () =>
    projections.getThreadRecords(parentId, ["messages", "runs"]).pipe(
      Effect.map((parent) => ({
        ...parent,
        messages: parent.messages.filter((message) => message.notification !== undefined),
      })),
    );
  const settleParent = Effect.fn("TaskQuestions.settleParent")(function* () {
    const now = yield* DateTime.now;
    const event = {
      id: EventId.make("parent:settled"),
      type: "run.updated",
      threadId: parentId,
      runId: parentRun.id,
      occurredAt: now,
      payload: { ...parentRun, status: "completed", completedAt: now },
    } satisfies OrchestrationV2DomainEvent;
    yield* sink.write({
      commandId: CommandId.make("command:runtime-reconcile:question-parent"),
      events: [event],
    });
    return event;
  });
  const settleChild = Effect.fn("TaskQuestions.settleChild")(function* () {
    const child = yield* projections.getThreadRecords(task.childThreadId!, ["runs"]);
    const childRun = child.runs[0]!;
    const now = yield* DateTime.now;
    yield* sink.write({
      commandId: CommandId.make("command:runtime-reconcile:finished-question-child"),
      events: [
        {
          id: EventId.make("run:finished-child"),
          type: "run.updated",
          threadId: task.childThreadId!,
          occurredAt: now,
          payload: { ...childRun, status: "completed", completedAt: now },
        },
        {
          id: EventId.make("task:finished-child"),
          type: "subagent.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            ...task,
            status: "completed",
            result: "Research finished",
            completedAt: now,
          },
        },
      ],
    });
  });
  return {
    settleChild,
    orchestrator,
    projections,
    sink,
    reactor,
    task,
    parentRun,
    create,
    addRequest,
    invoke,
    question,
    notifications,
    settleParent,
  };
});

it.effect.each(["live", "message", "codex_question_reply"] as const)(
  "lists, reads and answers a delegated %s question",
  (capability) =>
    Effect.gen(function* () {
      const f = yield* setup();
      const event = yield* f.addRequest("request:question", capability);
      expect((yield* f.question({ action: "list" })).structuredContent).toEqual({
        requestIds: [event.payload.id],
      });
      expect(
        (yield* f.question({ action: "read", requestId: event.payload.id })).structuredContent,
      ).toEqual({ requestId: event.payload.id, questions });
      const response = yield* f.question({
        action: "respond",
        requestId: event.payload.id,
        answers: { format: "Markdown" },
      });
      expect(response.isError).not.toBe(true);
      expect(response.structuredContent).toMatchObject({ sequence: expect.any(Number) });
      const context = yield* f.projections.getRuntimeResponseContext(
        f.task.childThreadId!,
        event.payload.id,
      );
      expect(context.request).toMatchObject({
        status: "resolved",
        answers: { format: "Markdown" },
        respondedBy: { kind: "agent", senderThreadId: parentId },
      });
      expect(context.item).toMatchObject({
        type: "user_input_request",
        questionAnswer: {
          answers: { format: "Markdown" },
          respondedBy: { kind: "agent", senderThreadId: parentId },
        },
      });
      if (capability !== "live") {
        const child = yield* f.projections.getThreadRecords(f.task.childThreadId!, ["messages"]);
        expect(child.messages.some((message) => message.text.includes("Markdown"))).toBe(true);
      }
      expect((yield* f.question({ action: "list" })).structuredContent).toEqual({ requestIds: [] });
      expect(
        failure(
          yield* f.question({
            action: "respond",
            requestId: event.payload.id,
            answers: { format: "PDF" },
          }),
        ),
      ).toMatchObject({
        code: "invalid_request",
        message: "The user-input request was already answered.",
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "excludes approvals, refuses permission responses and validates required action fields",
  () =>
    Effect.gen(function* () {
      const f = yield* setup();
      for (const kind of [
        "command",
        "file-read",
        "file-change",
        "mcp-elicitation",
        "permission",
      ] as const) {
        const approval = yield* f.addRequest(`approval:${kind}`, "live", kind);
        for (const action of ["read", "respond"]) {
          expect(
            failure(
              yield* f.question({
                action,
                requestId: approval.payload.id,
                answers: { decision: "accept" },
              }),
            ),
          ).toMatchObject({
            code: "invalid_request",
            message: "The pending user-input request was not found.",
          });
        }
        const request = yield* f.projections.getRuntimeRequest(
          f.task.childThreadId!,
          approval.payload.id,
        );
        expect(request?.status).toBe("pending");
        expect(request?.decision).toBeUndefined();
      }
      expect((yield* f.question({ action: "list" })).structuredContent).toEqual({ requestIds: [] });
      const event = yield* f.addRequest("question:required-fields");
      for (const action of ["read", "respond"]) {
        expect(failure(yield* f.question({ action }))).toMatchObject({
          code: "invalid_request",
          message: "This action needs `requestId`.",
        });
      }
      expect(
        failure(yield* f.question({ action: "respond", requestId: event.payload.id })),
      ).toMatchObject({ code: "invalid_request", message: "This action needs `answers`." });
      expect(failure(yield* f.question({ action: "read", requestId: "missing" }))).toMatchObject({
        code: "invalid_request",
      });
      const cancelled = {
        ...event,
        id: EventId.make("question:cancelled"),
        payload: { ...event.payload, status: "cancelled" as const },
      };
      yield* f.sink.write({ events: [cancelled] });
      expect(
        failure(yield* f.question({ action: "respond", requestId: event.payload.id, answers: {} })),
      ).toMatchObject({
        code: "invalid_request",
        message: "The user-input request is no longer pending (cancelled).",
      });
    }).pipe(Effect.provide(layerTest)),
);

it.effect("restricts task questions and controls to the Agent that delegated the task", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const event = yield* f.addRequest("question:owner");
    const otherId = ThreadId.make("thread:other-coordinator");
    yield* f.create(otherId);
    for (const action of ["list", "read", "respond"]) {
      expect(
        failure(
          yield* f.question(
            { action, requestId: event.payload.id, answers: { format: "Markdown" } },
            scope(otherId),
          ),
        ),
      ).toMatchObject({ code: "capability_denied" });
    }
    for (const name of ["task_send", "task_cancel", "task_status", "task_wait"]) {
      expect(
        failure(
          yield* f.invoke(
            name,
            {
              taskId: f.task.id,
              ...(name === "task_send" ? { message: "Take over" } : {}),
              ...(name === "task_wait" ? { timeoutMs: 1 } : {}),
            },
            scope(otherId),
          ),
        ),
      ).toMatchObject({ code: "capability_denied" });
    }
    expect(
      (yield* f.projections.getRuntimeRequest(f.task.childThreadId!, event.payload.id))?.status,
    ).toBe("pending");
  }).pipe(Effect.provide(layerTest)),
);

const watchingTasks = Effect.fn("TaskQuestions.watchingTasks")(function* () {
  const subscribed = yield* Deferred.make<void>();
  const threads = yield* Threads.ThreadManagementService;
  const tasks = yield* Tasks.make.pipe(
    Effect.provideService(Threads.ThreadManagementService, {
      ...threads,
      streamStoredEventsFrom: (input) =>
        Stream.unwrap(
          Deferred.succeed(subscribed, undefined).pipe(
            Effect.as(threads.streamStoredEventsFrom(input)),
          ),
        ),
    }),
  );
  return { tasks, subscribed };
});

const executionModeCases: ReadonlyArray<{
  readonly name: string;
  readonly caller: RuntimeMode;
  readonly requested?: OrchestratorMcpRuntimeMode;
  readonly supported?: ReadonlyArray<RuntimeMode>;
  readonly expected?: RuntimeMode;
  readonly error?: "invalid_request" | "runtime_mode_escalation_denied";
}> = [
  { name: "inherits an omitted mode", caller: "auto", expected: "auto" },
  {
    name: "inherits an explicit inherit",
    caller: "approval-required",
    requested: "inherit",
    expected: "approval-required",
  },
  {
    name: "accepts a narrower explicit mode",
    caller: "full-access",
    requested: "approval-required",
    expected: "approval-required",
  },
  {
    name: "refuses a broader explicit mode",
    caller: "approval-required",
    requested: "full-access",
    error: "runtime_mode_escalation_denied",
  },
  {
    name: "steps unsupported inheritance down",
    caller: "auto",
    supported: ["approval-required", "full-access"],
    expected: "approval-required",
  },
  {
    name: "chooses the broadest supported narrower mode",
    caller: "full-access",
    supported: ["approval-required", "auto"],
    expected: "auto",
  },
  {
    name: "refuses unsupported explicit modes",
    caller: "full-access",
    requested: "auto",
    supported: ["approval-required", "full-access"],
    error: "invalid_request",
  },
  {
    name: "falls back without escalating",
    caller: "approval-required",
    supported: ["full-access"],
    expected: "approval-required",
  },
  { name: "treats empty support as unrestricted", caller: "auto", supported: [], expected: "auto" },
];

it.effect("starts threads with the caller's modes and refuses broader requests", () =>
  Effect.gen(function* () {
    const f = yield* setup("always", "auto");
    const definition = Toolkit.make(
      Tool.make("start_thread", {
        parameters: Schema.Struct({
          threadId: ThreadId,
          runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
        }),
        success: ThreadId,
        failure: OrchestratorMcpFailure,
        failureMode: "return",
        dependencies: [Invocation.McpInvocationContext, Threads.ThreadManagementService],
      }),
    );
    const handlers = Access.toLayer(definition, {
      start_thread: Access.startsThreads(
        (input) => input,
        (input, modes) =>
          f.orchestrator
            .dispatch({
              type: "thread.create",
              commandId: CommandId.make(`create:${input.threadId}`),
              threadId: input.threadId,
              projectId: ProjectId.make("project:questions"),
              title: "Agent-launched conversation",
              modelSelection,
              ...modes,
              branch: null,
              worktreePath: null,
              createdBy: "agent",
              creationSource: "mcp",
            })
            .pipe(Effect.mapError(dispatchFailure), Effect.as(input.threadId)),
      ),
    });
    const toolkit = yield* definition.pipe(Effect.provide(Access.HandlersLayer.layer(handlers)));
    for (const [index, runtimeMode] of (
      [undefined, "inherit", "approval-required", "full-access"] as const
    ).entries()) {
      const threadId = ThreadId.make(`thread:agent-launch:${index}`);
      const results = yield* toolkit
        .handle("start_thread", { threadId, runtimeMode })
        .pipe(
          Effect.flatMap(Stream.runCollect),
          Effect.provideService(Invocation.McpInvocationContext, scope()),
        );
      if (runtimeMode === "full-access") {
        expect(results[0]).toMatchObject({
          isFailure: true,
          result: { code: "runtime_mode_escalation_denied" },
        });
        expect(yield* f.projections.getThreadShell(threadId)).toBeNull();
        continue;
      }
      expect(results[0]?.isFailure).toBe(false);
      expect((yield* f.projections.getThreadRecords(threadId, [])).thread).toMatchObject({
        runtimeMode: runtimeMode === "approval-required" ? runtimeMode : "auto",
        interactionMode: "default",
      });
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(executionModeCases)("delegation $name", (testCase) =>
  Effect.gen(function* () {
    const f = yield* setup("always", testCase.caller);
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const tasks = yield* Tasks.make.pipe(
      Effect.provideService(ProviderRegistry.ProviderRegistry, {
        ...providers,
        getCheckedProviders: providers.getCheckedProviders.pipe(
          Effect.map((snapshots) =>
            snapshots.map((provider) => ({
              ...provider,
              ...(testCase.supported === undefined
                ? {}
                : { supportedRuntimeModes: testCase.supported }),
            })),
          ),
        ),
      }),
    );
    const operation = tasks.delegateTask(scope(), {
      task: "Inspect the sources within the selected execution mode.",
      parentRunId: f.parentRun.id,
      ...(testCase.requested === undefined ? {} : { runtimeMode: testCase.requested }),
    });
    if (testCase.error !== undefined) {
      expect(yield* Effect.flip(operation)).toMatchObject({ code: testCase.error });
      expect(
        (yield* f.projections.getThreadRecords(parentId, ["subagents"])).subagents,
      ).toHaveLength(1);
      return;
    }
    const task = yield* operation;
    const child = yield* f.projections.getThreadRecords(task.childThreadId, []);
    expect(child.thread.runtimeMode).toBe(testCase.expected);
    expect(child.thread.interactionMode).toBe("default");
    expect((yield* f.projections.getThreadRecords(parentId, [])).thread.runtimeMode).toBe(
      testCase.caller,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("keeps delegated planning intent within the caller's ceiling", () =>
  Effect.gen(function* () {
    const f = yield* setup("always", "auto");
    yield* f.orchestrator.dispatch({
      type: "thread.interaction-mode.set",
      commandId: CommandId.make("plan:parent"),
      threadId: parentId,
      interactionMode: "plan",
    });
    const tasks = yield* Tasks.OrchestratorMcpService;
    expect(
      yield* tasks
        .delegateTask(scope(), {
          task: "Leave Plan mode",
          parentRunId: f.parentRun.id,
          interactionMode: "default",
        })
        .pipe(Effect.flip),
    ).toMatchObject({ code: "interaction_mode_escalation_denied" });
    const task = yield* tasks.delegateTask(scope(), {
      task: "Keep planning",
      parentRunId: f.parentRun.id,
    });
    expect((yield* f.projections.getThreadRecords(task.childThreadId, [])).thread).toMatchObject({
      runtimeMode: "auto",
      interactionMode: "plan",
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses task controls above the caller while preserving task reads", () =>
  Effect.gen(function* () {
    const f = yield* setup("always", "approval-required");
    const question = yield* f.addRequest("question:broader-child");
    yield* f.orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId: CommandId.make("raise:child"),
      threadId: f.task.childThreadId!,
      runtimeMode: "full-access",
    });
    for (const mode of ["auto", "queue", "steer", "restart"]) {
      expect(
        failure(
          yield* f.invoke("task_send", {
            taskId: f.task.id,
            message: "Continue the work",
            mode,
          }),
        ),
      ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    }
    expect(failure(yield* f.invoke("task_cancel", { taskId: f.task.id }))).toMatchObject({
      code: "runtime_mode_escalation_denied",
    });
    expect(
      failure(
        yield* f.question({
          action: "respond",
          requestId: question.payload.id,
          answers: { format: "Markdown" },
        }),
      ),
    ).toMatchObject({ code: "runtime_mode_escalation_denied" });
    for (const name of ["task_read", "task_status", "task_wait"]) {
      expect((yield* f.invoke(name, { taskId: f.task.id })).isError).not.toBe(true);
    }
    expect(
      (yield* f.question({ action: "read", requestId: question.payload.id })).isError,
    ).not.toBe(true);
    expect(
      (yield* f.projections.getRuntimeRequest(f.task.childThreadId!, question.payload.id))?.status,
    ).toBe("pending");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["send", "cancel", "respond"] as const)(
  "rechecks the caller ceiling at the command lock for task %s",
  (control) =>
    Effect.gen(function* () {
      const f = yield* setup("always", "approval-required");
      const question = yield* f.addRequest("question:mode-race");
      const threads = yield* Threads.ThreadManagementService;
      // A person's independent mode change lands after the MCP preflight.
      const raiseMode = f.orchestrator
        .dispatch({
          type: "thread.runtime-mode.set",
          commandId: CommandId.make("raise:child-after-preflight"),
          threadId: f.task.childThreadId!,
          runtimeMode: "full-access",
        })
        .pipe(Effect.provideService(DispatchModeLimit, undefined));
      const tasks = yield* Tasks.make.pipe(
        Effect.provideService(Threads.ThreadManagementService, {
          ...threads,
          sendToThread: (input) => raiseMode.pipe(Effect.andThen(threads.sendToThread(input))),
          cancelDelegatedTask: (input) =>
            raiseMode.pipe(Effect.orDie, Effect.andThen(threads.cancelDelegatedTask(input))),
          dispatch: (command) =>
            (command.type === "runtime-request.respond" ? raiseMode : Effect.void).pipe(
              Effect.andThen(threads.dispatch(command)),
            ),
        }),
      );
      const operation: Effect.Effect<unknown, OrchestratorMcpFailure> =
        control === "send"
          ? tasks.sendToThread(scope(), {
              threadId: f.task.childThreadId!,
              message: "Continue working",
            })
          : control === "cancel"
            ? tasks.cancelTask(scope(), { taskId: f.task.id })
            : tasks.taskQuestion(scope(), {
                action: "respond",
                taskId: f.task.id,
                requestId: question.payload.id,
                answers: { format: "Markdown" },
              });
      expect(yield* operation.pipe(Effect.flip)).toMatchObject({
        code: "runtime_mode_escalation_denied",
      });
      expect(
        (yield* f.projections.getThreadRecords(f.task.childThreadId!, ["runs"])).runs,
      ).toHaveLength(1);
      expect(
        (yield* f.projections.getRuntimeRequest(f.task.childThreadId!, question.payload.id))
          ?.status,
      ).toBe("pending");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["user_input", "permission"] as const)(
  "ends task_wait when a child's %s request arrives",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* setup("always", "approval-required");
      const { tasks, subscribed } = yield* watchingTasks();
      const waiting = yield* tasks.waitTask(scope(), { taskId: f.task.id }).pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      const event = yield* f.addRequest("request:wait", "live", kind);
      const expected = {
        status: "running",
        pendingQuestions:
          kind === "user_input"
            ? [
                expect.objectContaining({
                  requestId: event.payload.id,
                  blocking: true,
                  preview: "Which format?",
                }),
              ]
            : [],
        pendingApproval:
          kind === "permission" ? { requestId: event.payload.id, kind, runId: event.runId } : null,
        waitTimedOut: false,
      };
      expect(yield* Fiber.join(waiting)).toMatchObject(expected);
      expect(
        (yield* f.invoke("task_status", { taskId: f.task.id })).structuredContent,
      ).toMatchObject(expected);
      expect((yield* f.invoke("task_wait", { taskId: f.task.id })).structuredContent).toMatchObject(
        expected,
      );
      expect(
        (yield* f.projections.getThreadRecords(parentId, ["subagents"])).subagents[0]
          ?.completionDelivery?.state,
      ).not.toBe("acknowledged");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["user_input", "permission"] as const)(
  "returns a blocking delegation on %s and keeps completion delivery armed",
  (kind) =>
    Effect.gen(function* () {
      const f = yield* setup("always", "approval-required");
      const { tasks, subscribed } = yield* watchingTasks();
      const waiting = yield* tasks
        .delegateTask(scope(), {
          task: "Ask the coordinator",
          title: "Blocking question",
          parentRunId: f.parentRun.id,
          mode: "wait",
          idempotencyKey: "blocking-question",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(subscribed);
      const task = (yield* f.projections.getThreadRecords(parentId, ["subagents"])).subagents.find(
        (task) => task.title === "Blocking question",
      )!;
      const event = yield* f.addRequest("request:blocking", "live", kind, task);
      expect(
        (yield* f.projections.getThreadRecords(task.childThreadId!, [])).thread.runtimeMode,
      ).toBe("approval-required");
      expect(yield* Fiber.join(waiting)).toMatchObject({
        taskId: task.id,
        status: "running",
        pendingQuestions:
          kind === "user_input"
            ? [
                expect.objectContaining({
                  requestId: event.payload.id,
                  blocking: true,
                  preview: "Which format?",
                }),
              ]
            : [],
        pendingApproval: kind === "permission" ? { requestId: event.payload.id } : null,
        waitTimedOut: false,
      });
      expect(
        (yield* f.projections.getThreadRecords(parentId, ["subagents"])).subagents.find(
          (candidate) => candidate.id === task.id,
        )?.completionWake,
      ).toBe("always");
    }).pipe(Effect.provide(layerTest)),
);

it.effect("reports only the oldest live approval on an unfinished task Run", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const now = yield* DateTime.now;
    yield* f.addRequest(
      "approval:newer",
      "live",
      "command",
      f.task,
      DateTime.add(now, { seconds: 1 }),
    );
    const oldest = yield* f.addRequest("approval:oldest", "live", "permission", f.task, now);
    yield* f.addRequest(
      "approval:message",
      "message",
      "permission",
      f.task,
      DateTime.subtract(now, { seconds: 1 }),
    );
    expect((yield* f.invoke("task_status", { taskId: f.task.id })).structuredContent).toMatchObject(
      {
        pendingApproval: { requestId: oldest.payload.id, kind: "permission", runId: oldest.runId },
        pendingQuestions: [],
      },
    );
    const disposed: OrchestrationV2Subagent = {
      ...f.task,
      completionDelivery: { state: "disposed", observedByRunId: null },
    };
    yield* f.sink.write({
      events: [
        {
          id: EventId.make("task:disposed"),
          type: "subagent.updated",
          threadId: parentId,
          occurredAt: now,
          payload: disposed,
        },
      ],
    });
    expect((yield* f.invoke("task_status", { taskId: f.task.id })).structuredContent).toMatchObject(
      { pendingApproval: null },
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["live", "message"] as const)(
  "wakes an async coordinator once for a %s question and cancels its queued wake after an answer",
  (capability) =>
    Effect.gen(function* () {
      const f = yield* setup();
      const event = yield* f.addRequest("question:async-wake", capability);
      yield* f.reactor.handle(event);
      yield* f.reactor.handle(event);
      const parent = yield* f.notifications();
      expect(parent.messages).toHaveLength(1);
      expect(parent.messages[0]?.notification).toMatchObject({
        source: { kind: "delegated_task", taskIds: [f.task.id] },
        outcome: "updated",
      });
      expect(parent.messages[0]?.text).toContain(
        `taskId ${f.task.id}, requestId ${event.payload.id}`,
      );
      expect(parent.messages[0]?.text).toContain("Which format?");
      expect(parent.messages[0]?.text).toContain('"header":"Format"');
      expect(parent.messages[0]?.text).toContain(
        capability === "live" ? "blocked until you answer" : "keeps working",
      );
      const approval = yield* f.addRequest("approval:no-wake", "live", "permission");
      yield* f.reactor.handle(approval);
      expect((yield* f.notifications()).messages).toHaveLength(1);
      const queued = parent.runs.find((run) => run.userMessageId === parent.messages[0]!.id)!;
      expect(queued.status).toBe("queued");
      const response = yield* f.question({
        action: "respond",
        requestId: event.payload.id,
        answers: { format: "Markdown" },
      });
      expect(response.isError).not.toBe(true);
      const request = (yield* f.projections.getRuntimeRequest(
        f.task.childThreadId!,
        event.payload.id,
      ))!;
      yield* f.reactor.handle({
        ...event,
        id: EventId.make("question:resolved-wake"),
        payload: request,
      });
      expect((yield* f.notifications()).runs.find((run) => run.id === queued.id)?.status).toBe(
        "cancelled",
      );
      yield* f.reactor.handle(event);
      expect((yield* f.notifications()).messages).toHaveLength(1);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "delivers asynchronous questions during a blocking delegation and catches up live questions when the parent settles",
  () =>
    Effect.gen(function* () {
      const f = yield* setup("settled_only");
      const live = yield* f.addRequest("question:live-wait");
      const message = yield* f.addRequest("question:message-wait", "message");
      yield* f.orchestrator.dispatch({
        type: "delegated_task.question-wait",
        commandId: CommandId.make("wait:register"),
        parentThreadId: parentId,
        parentRunId: f.parentRun.id,
        waitId: "wait",
        active: true,
      });
      yield* f.reactor.handle(live);
      yield* f.reactor.handle(message);
      expect((yield* f.notifications()).messages).toHaveLength(0);
      const settled = yield* f.settleParent();
      yield* f.reactor.handle(settled);
      yield* f.reactor.handle(settled);
      expect((yield* f.notifications()).messages).toHaveLength(2);
      const resolved = {
        ...live,
        id: EventId.make("question:live-wait-resolved"),
        payload: { ...live.payload, status: "resolved" as const },
      };
      yield* f.sink.write({ events: [resolved] });
      yield* f.reactor.handle(live);
      expect((yield* f.notifications()).messages).toHaveLength(2);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("answers asynchronous questions after the delegated child finishes", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const event = yield* f.addRequest("question:finished-child", "message");
    const approval = yield* f.addRequest("approval:finished-child", "live", "permission");
    yield* f.settleChild();
    expect((yield* f.invoke("task_status", { taskId: f.task.id })).structuredContent).toMatchObject(
      {
        status: "completed",
        pendingQuestions: [
          expect.objectContaining({ requestId: event.payload.id, blocking: false }),
        ],
        pendingApproval: null,
      },
    );
    yield* f.reactor.handle(event);
    expect((yield* f.notifications()).messages).toHaveLength(1);
    expect(
      (yield* f.question({ action: "read", requestId: event.payload.id })).structuredContent,
    ).toEqual({ requestId: event.payload.id, questions });
    const answered = yield* f.question({
      action: "respond",
      requestId: event.payload.id,
      answers: { format: "Markdown" },
    });
    expect(answered.isError).not.toBe(true);
    expect(answered.structuredContent).toMatchObject({
      followUp: { taskId: expect.any(String), message: expect.stringContaining("follow-up turn") },
    });
    const followUp = (yield* f.projections.getThreadRecords(parentId, [
      "subagents",
    ])).subagents.find((task) => task.id !== f.task.id);
    expect(followUp).toMatchObject({
      runId: f.parentRun.id,
      childThreadId: f.task.childThreadId,
      completionWake: "always",
      completionDelivery: { state: "pending" },
    });
    const followUpRuns = yield* f.projections.getThreadRecords(f.task.childThreadId!, ["runs"]);
    expect(followUpRuns.runs.at(-1)?.delegatedTaskId).toBe(followUp?.id);
    expect(
      (yield* f.projections.getRuntimeRequest(f.task.childThreadId!, event.payload.id))?.status,
    ).toBe("resolved");
    expect(
      (yield* f.projections.getRuntimeRequest(f.task.childThreadId!, approval.payload.id))?.status,
    ).toBe("pending");
    const response = yield* f.projections.getRuntimeResponseContext(
      f.task.childThreadId!,
      event.payload.id,
    );
    expect(response.request?.respondedBy).toEqual({ kind: "agent", senderThreadId: parentId });
    expect(
      response.item?.type === "user_input_request" && response.item.questionAnswer?.respondedBy,
    ).toEqual({ kind: "agent", senderThreadId: parentId });
    const messages = yield* f.projections.getThreadRecords(f.task.childThreadId!, ["messages"]);
    expect(messages.messages.at(-1)).toMatchObject({
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: parentId,
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("routes follow-up questions to their current task and leaves older results settled", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    yield* f.addRequest("approval:previous-turn", "live", "permission");
    yield* f.settleChild();
    yield* f.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("question:follow-up-message"),
      threadId: f.task.childThreadId!,
      messageId: MessageId.make("message:question-follow-up"),
      text: "Review the research again",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const followUp = (yield* f.projections.getThreadRecords(parentId, [
      "subagents",
    ])).subagents.find(
      (task) => task.childThreadId === f.task.childThreadId && task.id !== f.task.id,
    );
    expect(followUp).toBeDefined();
    if (followUp === undefined) return yield* Effect.die("Missing follow-up task");
    const followUpQuestion = yield* f.addRequest(
      "question:follow-up",
      "live",
      "user_input",
      followUp,
    );
    yield* f.reactor.handle(followUpQuestion);
    expect((yield* f.notifications()).messages.at(-1)?.notification?.source).toMatchObject({
      kind: "delegated_task",
      taskIds: [followUp.id],
    });
    expect(
      (yield* f.invoke("task_status", { taskId: followUp.id })).structuredContent,
    ).toMatchObject({
      pendingQuestions: [
        expect.objectContaining({ requestId: followUpQuestion.payload.id, blocking: true }),
      ],
      pendingApproval: null,
    });
    expect((yield* f.invoke("task_status", { taskId: f.task.id })).structuredContent).toMatchObject(
      {
        status: "completed",
        pendingQuestions: [],
        pendingApproval: null,
      },
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("accepts partial asynchronous replies until every question is answered", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const event = yield* f.addRequest("question:partial", "message");
    const context = yield* f.projections.getRuntimeResponseContext(
      f.task.childThreadId!,
      event.payload.id,
    );
    if (context.item?.type !== "user_input_request")
      return yield* Effect.die("Missing question fixture");
    const now = yield* DateTime.now;
    yield* f.sink.write({
      events: [
        {
          id: EventId.make("question:partial-items"),
          type: "turn-item.updated",
          threadId: f.task.childThreadId!,
          occurredAt: now,
          payload: {
            ...context.item,
            questions: [
              ...questions,
              {
                id: "delivery",
                header: "Delivery",
                question: "Where should it go?",
                options: [],
                required: false,
              },
            ],
          },
        },
      ],
    });
    expect(
      (yield* f.question({
        action: "respond",
        requestId: event.payload.id,
        answers: { format: "Markdown" },
      })).isError,
    ).not.toBe(true);
    expect(
      (yield* f.projections.getRuntimeRequest(f.task.childThreadId!, event.payload.id))?.status,
    ).toBe("pending");
    expect((yield* f.question({ action: "list" })).structuredContent).toEqual({
      requestIds: [event.payload.id],
    });
    expect(
      (yield* f.question({
        action: "respond",
        requestId: event.payload.id,
        answers: { delivery: "The report Page" },
      })).isError,
    ).not.toBe(true);
    expect(
      yield* f.projections.getRuntimeRequest(f.task.childThreadId!, event.payload.id),
    ).toMatchObject({
      status: "resolved",
      answers: { format: "Markdown", delivery: "The report Page" },
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["live", "message"] as const)(
  "starts a settled async coordinator through the %s question event stream",
  (capability) =>
    Effect.gen(function* () {
      const f = yield* setup();
      yield* f.settleParent();
      const afterSequence = yield* f.orchestrator.getThreadEventSequence(parentId);
      const subscribed = yield* Deferred.make<void>();
      const reactor = yield* Questions.make.pipe(
        Effect.provideService(Orchestrator.OrchestratorV2, {
          ...f.orchestrator,
          streamStoredEventsFrom: (input) =>
            Stream.unwrap(
              Deferred.succeed(subscribed, undefined).pipe(
                Effect.as(f.orchestrator.streamStoredEventsFrom(input)),
              ),
            ),
        }),
      );
      yield* reactor.start();
      yield* Deferred.await(subscribed);
      yield* f.addRequest("question:stream-wake", capability);
      yield* f.sink.stream({ threadId: parentId, afterSequence, eventType: "run.created" }).pipe(
        Stream.filter(
          ({ event }) => event.type === "run.created" && event.payload.id !== f.parentRun.id,
        ),
        Stream.runHead,
      );
      const parent = yield* f.notifications();
      expect(parent.messages).toHaveLength(1);
      expect(parent.runs.find((run) => run.userMessageId === parent.messages[0]!.id)?.status).toBe(
        "starting",
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["live", "message", "codex_question_reply"] as const)(
  "credit authority applies before a %s question response changes state",
  (capability) =>
    Effect.gen(function* () {
      const f = yield* setup();
      const childId = f.task.childThreadId!;
      const child = yield* f.projections.getThreadRecords(childId, ["runs"]);
      const run = child.runs[0]!;
      const credit = ProviderInstanceId.make("nodex_codex_test");
      yield* f.sink.write({
        events: [
          {
            id: EventId.make("credit-model"),
            type: "run.updated",
            threadId: childId,
            occurredAt: yield* DateTime.now,
            payload: {
              ...run,
              providerInstanceId: credit,
              modelSelection: { instanceId: credit, model: "gpt-6.1-sol" },
            },
          },
        ],
      });
      const request = yield* f.addRequest("credit-question", capability);
      const refused = yield* f.question({
        action: "respond",
        requestId: request.payload.id,
        answers: { format: "Markdown" },
      });
      expect(refused.isError).toBe(true);
      expect(failure(refused)).toMatchObject({ code: "credit_requires_person" });
      expect(
        (yield* f.projections.getRuntimeResponseContext(childId, request.payload.id)).request
          ?.status,
      ).toBe("pending");
      const threads = yield* Threads.ThreadManagementService;
      yield* threads.dispatch({
        type: "runtime-request.respond",
        threadId: childId,
        commandId: CommandId.make("person-credit-answer"),
        requestId: request.payload.id,
        answers: { format: "Markdown" },
      });
      expect(
        (yield* f.projections.getRuntimeResponseContext(childId, request.payload.id)).request
          ?.status,
      ).toBe("resolved");
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each(["nodex-agent", "opt-in"] as const)(
  "%s can answer an on Nodex model's live question",
  (authority) =>
    Effect.gen(function* () {
      const owner = yield* makePolicy(
        { ...DEFAULT_MODEL_POLICY, agentsMayChooseCredit: authority === "opt-in" },
        {},
      );
      return yield* Effect.gen(function* () {
        const f = yield* setup();
        const childId = f.task.childThreadId!;
        const child = yield* f.projections.getThreadRecords(childId, ["runs"]);
        const credit = ProviderInstanceId.make("nodex_codex_test");
        const creditSelection = { instanceId: credit, model: "gpt-6.1-sol" };
        const runs = authority === "nodex-agent" ? [child.runs[0]!, f.parentRun] : [child.runs[0]!];
        for (const run of runs)
          yield* f.sink.write({
            events: [
              {
                id: EventId.make(`credit:${run.id}`),
                type: "run.updated",
                threadId: run.threadId,
                occurredAt: yield* DateTime.now,
                payload: { ...run, providerInstanceId: credit, modelSelection: creditSelection },
              },
            ],
          });
        const request = yield* f.addRequest("permitted-credit-question", "live");
        const caller = scope();
        const result = yield* f
          .question(
            { action: "respond", requestId: request.payload.id, answers: { format: "Markdown" } },
            authority === "nodex-agent"
              ? { ...caller, thread: { ...caller.thread!, providerInstanceId: credit } }
              : caller,
          )
          .pipe(
            Effect.provideService(ExecutionHost.McpTurnAdmission, {
              actor: {
                runtimeId: "test-runtime",
                runtimeGeneration: "test-generation",
                projectId: ProjectId.make("project:questions"),
                threadId: parentId,
                runId: f.parentRun.id,
                attemptId: f.parentRun.activeAttemptId!,
                providerInstanceId: authority === "nodex-agent" ? credit : instanceId,
                providerSessionId: ProviderSessionId.make("session:parent"),
                providerThreadId: ProviderThreadId.make("provider-thread:parent"),
                nativeGeneration: 1,
                nativeThreadRef: null,
                cwd: null,
              },
              requestId: undefined,
              assertCurrent: () => Effect.void,
            }),
          );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(
          (yield* f.projections.getRuntimeResponseContext(childId, request.payload.id)).request
            ?.status,
        ).toBe("resolved");
      }).pipe(Effect.provide(layerTest), Effect.provideService(RuntimeModelPolicy, owner));
    }),
);

it.effect.each(["live", "message"] as const)(
  "returns task B's wait for task A's %s question exactly once",
  (capability) =>
    Effect.gen(function* () {
      const f = yield* setup();
      const tasks = yield* Tasks.OrchestratorMcpService;
      const b = yield* tasks.delegateTask(scope(), {
        task: "Independent work",
        parentRunId: f.parentRun.id,
        mode: "async",
      });
      const watched = yield* watchingTasks();
      const waiting = yield* watched.tasks
        .waitTask(scope(), { taskId: b.taskId })
        .pipe(Effect.forkChild);
      yield* Deferred.await(watched.subscribed);
      const event = yield* f.addRequest("question:sibling", capability);
      yield* f.reactor.handle(event);
      const result = yield* Fiber.join(waiting);
      expect(result).toMatchObject({
        taskId: b.taskId,
        status: "running",
        waitTimedOut: false,
        questions: [
          {
            taskId: f.task.id,
            requestId: event.payload.id,
            blocking: capability === "live",
            preview: "Which format?",
            detail: expect.stringContaining("Which format?"),
          },
        ],
      });
      expect((yield* f.notifications()).messages).toHaveLength(0);
      const recovered = yield* Questions.make;
      yield* recovered.recover();
      yield* recovered.handle(event);
      expect((yield* f.notifications()).messages).toHaveLength(0);
      const again = yield* tasks.waitTask(scope(), { taskId: b.taskId });
      expect(again.questions).toEqual([]);
      expect(
        (yield* f.projections.getThreadRecords(parentId, ["subagents"])).subagents.find(
          (task) => task.id === f.task.id,
        )?.receivedQuestionIds,
      ).toEqual([event.payload.id]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("consumes a queued notice through a wait and cancels its Run atomically", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const event = yield* f.addRequest("question:queued-wait", "message");
    yield* f.reactor.handle(event);
    const notice = (yield* f.notifications()).messages[0]!;
    const tasks = yield* Tasks.OrchestratorMcpService;
    const result = yield* tasks.waitTask(scope(), { taskId: f.task.id });
    expect(result.questions).toMatchObject([{ taskId: f.task.id, requestId: event.payload.id }]);
    expect(
      (yield* f.notifications()).runs.find((run) => run.userMessageId === notice.id)?.status,
    ).toBe("cancelled");
    yield* f.reactor.recover();
    expect((yield* f.notifications()).messages).toHaveLength(1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("recovers undelivered questions after a restart once, excluding resolved requests", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const resolved = yield* f.addRequest("question:resolved-before-crash", "message");
    yield* f.question({
      action: "respond",
      requestId: resolved.payload.id,
      answers: { format: "Markdown" },
    });
    const pending = yield* f.addRequest("question:missed-event", "message");
    yield* f.settleChild();
    const recovered = yield* Questions.make;
    yield* recovered.recover();
    yield* recovered.recover();
    yield* recovered.handle(pending);
    const notices = (yield* f.notifications()).messages;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.text).toContain(pending.payload.id);
    expect(notices[0]?.text).not.toContain(resolved.payload.id);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("dismisses an owned message question as the Agent and cancels its notice", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const event = yield* f.addRequest("question:dismiss", "message");
    yield* f.reactor.handle(event);
    const result = yield* f.question({ action: "dismiss", requestId: event.payload.id });
    expect(result.isError).not.toBe(true);
    expect(
      yield* f.projections.getRuntimeRequest(f.task.childThreadId!, event.payload.id),
    ).toMatchObject({
      status: "resolved",
      decision: "cancel",
      respondedBy: { kind: "agent", senderThreadId: parentId },
    });
    yield* f.reactor.handle(event);
    const notices = yield* f.notifications();
    expect(notices.runs.find((run) => run.userMessageId === notices.messages[0]?.id)?.status).toBe(
      "cancelled",
    );
    const live = yield* f.addRequest("question:live-dismiss");
    expect((yield* f.question({ action: "dismiss", requestId: live.payload.id })).isError).toBe(
      true,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("completion wakes remind the coordinator about still-open questions", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const question = yield* f.addRequest("question:completion-open", "message");
    yield* f.settleChild();
    const parent = yield* f.projections.getThreadRecords(parentId, ["runs", "subagents"]);
    const now = yield* DateTime.now;
    const messageId = MessageId.make("message:completion-with-question");
    yield* f.sink.write({
      events: [
        {
          id: EventId.make("completion:cohort"),
          type: "run.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            ...parent.runs[0]!,
            delegatedCompletion: {
              disposition: "open",
              nextGeneration: 2,
              delivery: { generation: 1, messageId, taskIds: [f.task.id] },
            },
          },
        },
      ],
    });
    yield* f.orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("completion:dispatch"),
      threadId: parentId,
      messageId,
      text: "Finished",
      delegatedCompletion: { parentRunId: f.parentRun.id, generation: 1, taskIds: [f.task.id] },
      dispatchMode: { type: "queue_after_active" },
      attachments: [],
      createdBy: "agent",
      creationSource: "server",
    });
    const messages = yield* f.projections.getThreadRecords(parentId, ["messages"]);
    expect(messages.messages.find((message) => message.id === messageId)?.text).toContain(
      `${question.payload.id}: Which format?`,
    );
    expect(messages.messages.find((message) => message.id === messageId)?.text).toContain(
      "Answering starts a follow-up turn",
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("startup releases abandoned question waits before delivering pending questions", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    yield* f.orchestrator.dispatch({
      type: "delegated_task.question-wait",
      commandId: CommandId.make("abandoned:wait"),
      parentThreadId: parentId,
      parentRunId: f.parentRun.id,
      waitId: "old-process",
      active: true,
    });
    const event = yield* f.addRequest("question:abandoned-wait", "message");
    const recovered = yield* Questions.make;
    yield* recovered.recover();
    expect((yield* f.notifications()).messages[0]?.text).toContain(event.payload.id);
    expect(
      (yield* f.projections.getThreadRecords(parentId, ["runs"])).runs.find(
        (run) => run.id === f.parentRun.id,
      )?.taskQuestionWaits,
    ).toEqual([]);
    yield* recovered.recover();
    expect((yield* f.notifications()).messages).toHaveLength(1);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not start a queued question notice resolved before queue admission", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const event = yield* f.addRequest("question:resolved-at-admission", "message");
    yield* f.reactor.handle(event);
    const notice = (yield* f.notifications()).messages[0]!;
    yield* f.question({ action: "dismiss", requestId: event.payload.id });
    yield* f.settleParent();
    // Deliberately omit the reactor's resolution event to exercise the admission race.
    yield* f.orchestrator.resumeQueuedRuns;
    expect(
      (yield* f.notifications()).runs.find((run) => run.userMessageId === notice.id)?.status,
    ).toBe("cancelled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([false, true])(
  "retries a crashed native wait claim with queued notice=%s",
  (queued) =>
    Effect.gen(function* () {
      const f = yield* setup();
      const event = yield* f.addRequest("question:unreceived-wait", "message");
      if (queued) yield* f.reactor.handle(event);
      yield* f.orchestrator.dispatch({
        type: "delegated_task.question.receive",
        commandId: CommandId.make("wait:unconfirmed"),
        parentThreadId: parentId,
        parentRunId: f.parentRun.id,
        taskId: f.task.id,
        requestId: event.payload.id,
        awaitNativeReceipt: true,
      });
      expect(
        (yield* f.projections.getThreadRecords(parentId, ["subagents"])).subagents[0]
          ?.unconfirmedQuestionIds,
      ).toEqual([event.payload.id]);
      const recovered = yield* Questions.make;
      yield* recovered.recover();
      yield* recovered.recover();
      expect((yield* f.notifications()).messages).toHaveLength(1);
      const task = (yield* f.projections.getThreadRecords(parentId, ["subagents"])).subagents[0];
      expect(task?.receivedQuestionIds).toEqual([]);
      expect(task?.unconfirmedQuestionIds).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
);

it.effect("retains a question's completed native wait receipt across restart", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const question = yield* f.addRequest("question:native-received", "message");
    const records = yield* f.projections.getThreadRecords(parentId, [
      "runs",
      "attempts",
      "providerThreads",
    ]);
    const run = records.runs[0]!;
    const attempt = records.attempts.find((attempt) => attempt.id === run.activeAttemptId)!;
    const provider = records.providerThreads.find(
      (provider) => provider.id === run.providerThreadId,
    )!;
    const now = yield* DateTime.now;
    const nativeThreadId = "native:question-receipt";
    const turnId = ProviderTurnId.make("turn:question-receipt");
    const tasks = yield* Tasks.OrchestratorMcpService;
    const output = yield* withTaskResultDelivery(
      Effect.gen(function* () {
        const result = yield* tasks.waitTask(scope(), { taskId: f.task.id });
        yield* recordTaskResult(result);
        return new McpSchema.CallToolResult({
          content: [{ type: "text", text: JSON.stringify(result) }],
          structuredContent: result,
        });
      }),
    ).pipe(
      Effect.provideService(ExecutionHost.McpTurnAdmission, {
        actor: {
          runtimeId: "questions",
          runtimeGeneration: "generation:questions",
          projectId: ProjectId.make("project:questions"),
          threadId: parentId,
          runId: run.id,
          attemptId: attempt.id,
          providerInstanceId: instanceId,
          providerSessionId: ProviderSessionId.make("session:parent"),
          providerThreadId: provider.id,
          nativeGeneration: 1,
          nativeThreadRef: { driver: adapter.driver, nativeId: nativeThreadId, strength: "strong" },
          cwd: null,
        },
        requestId: 1,
        assertCurrent: () => Effect.void,
      }),
    );
    expect(output._meta).toMatchObject({
      "nodex/task-result-delivery": {
        questions: [{ taskId: f.task.id, requestId: question.payload.id }],
      },
    });
    const item = {
      id: TurnItemId.make("item:native-wait-result"),
      threadId: parentId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: provider.id,
      providerTurnId: turnId,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 100,
      type: "dynamic_tool" as const,
      toolName: "task_wait",
      input: { taskId: f.task.id },
      output,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const event = {
      id: EventId.make("event:native-wait-result"),
      type: "turn-item.updated" as const,
      threadId: parentId,
      runId: run.id,
      occurredAt: now,
      payload: item,
    };
    yield* f.sink.write({
      events: [
        {
          id: EventId.make("attempt:question-receipt"),
          type: "run-attempt.updated",
          threadId: parentId,
          occurredAt: now,
          payload: { ...attempt, nativeThreadId },
        },
        {
          id: EventId.make("provider:question-receipt"),
          type: "provider-thread.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            ...provider,
            nativeThreadRef: {
              driver: adapter.driver,
              nativeId: nativeThreadId,
              strength: "strong",
            },
          },
        },
        {
          id: EventId.make("turn:question-receipt"),
          type: "provider-turn.updated",
          threadId: parentId,
          occurredAt: now,
          payload: {
            id: turnId,
            providerThreadId: provider.id,
            nodeId: run.rootNodeId!,
            runAttemptId: attempt.id,
            nativeTurnRef: null,
            ordinal: 1,
            status: "completed",
            startedAt: now,
            completedAt: now,
          },
        },
        event,
      ],
    });
    // Startup must discover the receipt even if its live event was lost in the crash.
    const recovered = yield* Questions.make;
    yield* recovered.recover();
    expect((yield* f.notifications()).messages).toHaveLength(0);
    const task = (yield* f.projections.getThreadRecords(parentId, ["subagents"])).subagents[0];
    expect(task?.receivedQuestionIds).toEqual([question.payload.id]);
    expect(task?.unconfirmedQuestionIds).toEqual([]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("cancels a resolved queued notice even when its native wait receipt was lost", () =>
  Effect.gen(function* () {
    const f = yield* setup();
    const event = yield* f.addRequest("question:resolved-unconfirmed", "message");
    yield* f.reactor.handle(event);
    const notice = (yield* f.notifications()).messages[0]!;
    yield* f.orchestrator.dispatch({
      type: "delegated_task.question.receive",
      commandId: CommandId.make("wait:resolved-unconfirmed"),
      parentThreadId: parentId,
      parentRunId: f.parentRun.id,
      taskId: f.task.id,
      requestId: event.payload.id,
      awaitNativeReceipt: true,
    });
    yield* f.question({ action: "dismiss", requestId: event.payload.id });
    yield* f.settleParent();
    yield* f.orchestrator.resumeQueuedRuns;
    expect(
      (yield* f.notifications()).runs.find((run) => run.userMessageId === notice.id)?.status,
    ).toBe("cancelled");
  }).pipe(Effect.provide(layerTest)),
);
