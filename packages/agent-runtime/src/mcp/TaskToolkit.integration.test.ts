import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpCapabilitiesResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  ProviderThreadId,
  ProviderTurnId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { CodexOrchestratorReplayHarness } from "../orchestration-v2/Adapters/CodexAdapterV2.testkit.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ExecutionHost from "@t3tools/provider-core/server/ExecutionHost";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import {
  decodeProviderReplayNdjson,
  materializeReplayTranscriptWorkspace,
} from "@t3tools/provider-testing/replayTranscript";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { layerToolkit } from "../nodex/Mcp.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import {
  TaskCancelResult,
  TaskReadResult,
  TaskSendResult,
  TaskView,
} from "./toolkits/task/tools.ts";

// Effect returns a declared tool failure as `isError` with its encoded payload
// as JSON text, never as `structuredContent`.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const parentThreadId = ThreadId.make("thread:mcp-task-parent");
const projectId = ProjectId.make("project:mcp-task");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexModel = "gpt-5.4";
const claudeModel = "claude-sonnet-4-6";
const parentPrompt = "Keep this parent turn active while task tools are tested.";
const delegatedPrompt = "Inspect the delegated API boundary and return the result.";
const delegatedResult = "Delegated API boundary inspected.";
const cancellationPrompt = "Remain active until the parent cancels this delegated task.";
const followUpPrompt = "Summarize the boundary again.";
const queuedFollowupPrompt = "Complete the queued follow-up and return the final result.";
const queuedFollowupResult = "Queued delegated follow-up completed.";

const decodeTaskView = Schema.decodeUnknownEffect(TaskView);
const decodeTaskCancel = Schema.decodeUnknownEffect(TaskCancelResult);
const decodeTaskRead = Schema.decodeUnknownEffect(TaskReadResult);
const decodeTaskSend = Schema.decodeUnknownEffect(TaskSendResult);
const decodeModels = Schema.decodeUnknownEffect(OrchestratorMcpCapabilitiesResult);

const codexSelection = {
  instanceId: codexInstanceId,
  model: codexModel,
} satisfies ModelSelection;

const delegatedTaskStatusTranscriptFile = new URL(
  "../orchestration-v2/testkit/fixtures/delegated_task_status/codex_transcript.ndjson",
  import.meta.url,
);

const readDelegatedTaskStatusTranscript = Effect.fn("readDelegatedTaskStatusTranscript")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const text = yield* fs.readFileString(
      decodeURIComponent(delegatedTaskStatusTranscriptFile.pathname),
    );
    return yield* decodeProviderReplayNdjson(text);
  },
  Effect.provide(NodeServices.layer),
);

interface CapturedTurn {
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly text: string;
}

function unsupported(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly optionDescriptors?: ReadonlyArray<ProviderOptionDescriptor>;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [
      {
        slug: input.model,
        name: input.model,
        isCustom: false,
        capabilities:
          input.optionDescriptors === undefined
            ? null
            : { optionDescriptors: input.optionDescriptors },
      },
    ],
    slashCommands: [],
    skills: [],
  };
}

function makeDeterministicAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly capturedTurns: Ref.Ref<ReadonlyArray<CapturedTurn>>;
  readonly shouldComplete: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => boolean;
  readonly terminalGate?: (
    turn: ProviderAdapter.ProviderAdapterV2TurnInput,
  ) => Deferred.Deferred<void> | undefined;
  readonly response: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => string;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };

        const publish = (providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();
        const turnInputs = new Map<ProviderTurnId, ProviderAdapter.ProviderAdapterV2TurnInput>();

        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              yield* Ref.update(input.capturedTurns, (turns) => [
                ...turns,
                {
                  instanceId: input.instanceId,
                  threadId: turnInput.threadId,
                  text: turnInput.message.text,
                },
              ]);
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              turnInputs.set(providerTurnId, turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "running",
                    startedAt: eventTime,
                    completedAt: null,
                  },
                },
              ]);
              const terminalGate = input.terminalGate?.(turnInput);
              if (terminalGate !== undefined) {
                yield* Deferred.await(terminalGate);
              } else if (!input.shouldComplete(turnInput)) {
                return;
              }
              const response = input.response(turnInput);
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turnInput.providerThread.id,
                    nodeId: turnInput.rootNodeId,
                    runAttemptId: turnInput.attemptId,
                    nativeTurnRef: {
                      driver: input.driver,
                      nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                      strength: "strong",
                    },
                    ordinal: turnInput.providerTurnOrdinal,
                    status: "completed",
                    startedAt: eventTime,
                    completedAt: eventTime,
                  },
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: response,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            Effect.gen(function* () {
              const turnInput = turnInputs.get(providerTurnId);
              const completedAt = yield* DateTime.now;
              if (turnInput !== undefined) {
                yield* publish([
                  {
                    type: "provider_turn.updated",
                    driver: input.driver,
                    providerTurn: {
                      id: providerTurnId,
                      providerThreadId: providerThread.id,
                      nodeId: turnInput.rootNodeId,
                      runAttemptId: turnInput.attemptId,
                      nativeTurnRef: {
                        driver: input.driver,
                        nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                        strength: "strong",
                      },
                      ordinal: turnInput.providerTurnOrdinal,
                      status: "interrupted",
                      startedAt: completedAt,
                      completedAt,
                    },
                  },
                ]);
              }
              yield* publish([
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: providerThread.id,
                  providerTurnId,
                  runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
                  status: "interrupted",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () =>
            unsupported(input.driver, "readThreadSnapshot is unused in this test"),
          rollbackThread: () => unsupported(input.driver, "rollbackThread is unused in this test"),
          forkThread: () => unsupported(input.driver, "forkThread is unused in this test"),
        };
      }),
  };
}

function waitForProjection(
  orchestrator: Orchestrator.OrchestratorV2Shape,
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      if (predicate(projection)) {
        return projection;
      }
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(
      new Error(`Timed out waiting for orchestration projection ${threadId}.`),
    );
  });
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "task-tools-test", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "task-tools-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const scopeFor = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
  ({
    environmentId: EnvironmentId.make("environment:mcp-task"),
    requestNamespace: `mcp-provider-session:${threadId}`,
    thread: {
      threadId,
      providerSessionId: `mcp-provider-session:${threadId}`,
      providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  }) satisfies McpInvocationContext.McpInvocationScope;

const stringValues = (value: unknown): ReadonlyArray<string> =>
  typeof value === "string"
    ? [value]
    : typeof value === "object" && value !== null
      ? Object.values(value).flatMap(stringValues)
      : [];

/** No Agent-facing field carries a Runtime conversation identity. */
const expectNoConversationIdentity = (value: unknown, childThreadId: ThreadId) => {
  expect(stringValues(value)).not.toContain(childThreadId);
  expect(stringValues(value)).not.toContain(parentThreadId);
};

const childThreadOf = (
  orchestrator: Orchestrator.OrchestratorV2Shape,
  taskId: string,
): Effect.Effect<ThreadId> =>
  orchestrator.getThreadProjection(parentThreadId).pipe(
    Effect.orDie,
    Effect.flatMap((projection) => {
      const childThreadId = projection.subagents.find((task) => task.id === taskId)?.childThreadId;
      return childThreadId == null
        ? Effect.die(new Error(`Task ${taskId} has no conversation.`))
        : Effect.succeed(childThreadId);
    }),
  );

describe("task tools", () => {
  it.live("delegate, observe, follow up and cancel tasks by taskId only", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("mcp-task-tools");
        const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
        const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
          makeDeterministicAdapter({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            capabilities: {
              ...CodexProviderCapabilitiesV2,
              turns: { ...CodexProviderCapabilitiesV2.turns, supportsActiveSteering: false },
            },
            capturedTurns,
            shouldComplete: (turn) => turn.threadId !== parentThreadId,
            response: (turn) => `Codex completed: ${turn.message.text}`,
          }),
          makeDeterministicAdapter({
            instanceId: claudeInstanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            capabilities: ClaudeProviderCapabilitiesV2,
            capturedTurns,
            shouldComplete: (turn) => turn.message.text !== cancellationPrompt,
            response: (turn) =>
              turn.message.text === delegatedPrompt
                ? delegatedResult
                : `Claude completed: ${turn.message.text}`,
          }),
        ]);
        // Wakes are observed, not started, so the parent turn stays put.
        const layerContinuationProbe = Layer.succeed(
          ProviderContinuationRequests.ProviderContinuationRequests,
          { offer: () => Effect.void, take: Effect.never },
        );
        const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
          { name: "mcp-task-tools", runtimePolicyOverride: { cwd } },
          layerRegistry,
        ).pipe(Layer.provide(layerContinuationProbe));
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const reasoning: ProviderOptionDescriptor = {
          id: "reasoningEffort",
          label: "Reasoning effort",
          type: "select",
          options: [
            { id: "low", label: "Low" },
            { id: "high", label: "High" },
          ],
        };
        const layerProviderRegistry = ProviderRegistryMock.layer([
          makeProviderSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: codexModel,
            optionDescriptors: [reasoning],
          }),
          makeProviderSnapshot({
            instanceId: claudeInstanceId,
            driver: ProviderDriverKind.make("claudeAgent"),
            model: claudeModel,
          }),
          makeProviderSnapshot({
            instanceId: ProviderInstanceId.make("opencode"),
            driver: ProviderDriverKind.make("opencode"),
            model: "opencode/test",
          }),
        ]);
        const layerTest = layerToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(layerRegistry),
          Layer.provide(layerProviderRegistry),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const server = yield* McpServer.McpServer;
          yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-task-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "Task parent",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-task-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-task-parent:start"),
            text: parentPrompt,
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const parent = yield* waitForProjection(
            orchestrator,
            parentThreadId,
            (projection) =>
              projection.runs.some((run) => run.status === "running") &&
              projection.providerTurns.some((turn) => turn.status === "running"),
          );
          const parentRun = parent.runs[0]!;
          const invoke = (name: string, args: Record<string, unknown>) =>
            server.callTool({ name, arguments: args }).pipe(
              Effect.provideService(ExecutionHost.McpTurnAdmission, {
                actor: {
                  runtimeId: "runtime-mcp-task",
                  runtimeGeneration: "generation-mcp-task",
                  projectId,
                  threadId: parentThreadId,
                  runId: parentRun.id,
                  attemptId: parentRun.activeAttemptId!,
                  providerInstanceId: codexInstanceId,
                  providerSessionId: parent.providerThreads[0]!.providerSessionId!,
                  providerThreadId: parent.providerThreads[0]!.id,
                  nativeGeneration: 1,
                  nativeThreadRef: parent.providerThreads[0]!.nativeThreadRef,
                  cwd,
                },
                requestId: undefined,
                assertCurrent: () => Effect.void,
              }),
              Effect.provideService(
                McpInvocationContext.McpInvocationContext,
                scopeFor(parentThreadId, codexInstanceId),
              ),
              Effect.provideService(McpSchema.McpServerClient, client),
            );
          // Every structured result conforms to the schema the tool publishes.
          const call = (name: string, args: Record<string, unknown>) =>
            Effect.gen(function* () {
              const result = yield* invoke(name, args);
              expect(result.isError, `${name}: ${JSON.stringify(result.content)}`).not.toBe(true);
              const definition = server.tools.find(({ tool }) => tool.name === name)!;
              const validate = new AjvJsonSchemaValidator().getValidator(
                definition.tool.outputSchema! as JsonSchemaType,
              );
              expect(validate(result.structuredContent).valid, name).toBe(true);
              return result.structuredContent;
            });

          expect(server.tools.map(({ tool }) => tool.name).toSorted()).toEqual([
            "delegate_task",
            "list_agent_models",
            "stop_workflow",
            "task_cancel",
            "task_read",
            "task_send",
            "task_status",
            "task_wait",
          ]);

          const models = yield* decodeModels(yield* call("list_agent_models", {})).pipe(
            Effect.orDie,
          );
          expect(models.inherited).toEqual({
            providerInstanceId: codexInstanceId,
            model: codexModel,
            interactionMode: "default",
          });
          expect(
            models.providers.find((p) => p.providerInstanceId === codexInstanceId),
          ).toMatchObject({ available: true, models: [{ id: codexModel, options: [reasoning] }] });
          const opencode = models.providers.find((p) => p.driverKind === "opencode");
          expect(opencode?.available).toBe(false);
          expect(opencode?.constraints.length).toBeGreaterThan(0);

          // Async delegation, then an explicit wait for its result.
          const delegateArgs = {
            task: delegatedPrompt,
            target: { providerInstanceId: claudeInstanceId, model: claudeModel },
            clientRequestId: "delegate-boundary",
          };
          const started = yield* decodeTaskView(yield* call("delegate_task", delegateArgs)).pipe(
            Effect.orDie,
          );
          expect(started).toMatchObject({
            providerInstanceId: claudeInstanceId,
            model: claudeModel,
            waitTimedOut: false,
          });
          const childThreadId = yield* childThreadOf(orchestrator, started.taskId);
          expectNoConversationIdentity(started, childThreadId);
          const retried = yield* decodeTaskView(yield* call("delegate_task", delegateArgs)).pipe(
            Effect.orDie,
          );
          expect(retried.taskId).toBe(started.taskId);
          // Agents copy the task id into every task tool call; it stays short and unescaped.
          expect(started.taskId.length).toBeLessThanOrEqual(32);
          expect(started.taskId).not.toContain("%");

          const waited = yield* decodeTaskView(
            yield* call("task_wait", { taskId: started.taskId, timeoutMs: 30_000 }),
          ).pipe(Effect.orDie);
          expect(waited).toMatchObject({
            taskId: started.taskId,
            status: "completed",
            workState: "result_available",
            summary: delegatedResult,
            latestResult: { status: "completed", summary: delegatedResult },
            hasPendingFollowUps: false,
            waitTimedOut: false,
          });
          const acknowledged = yield* waitForProjection(
            orchestrator,
            parentThreadId,
            (projection) =>
              projection.subagents.find((task) => task.id === started.taskId)?.completionDelivery
                ?.state === "acknowledged",
          );
          expect(
            acknowledged.subagents.find((task) => task.id === started.taskId)?.completionDelivery,
          ).toMatchObject({ state: "acknowledged", observedByRunId: parentRun.id });

          // The task's conversation is readable through its taskId only.
          const read = yield* decodeTaskRead(
            yield* call("task_read", { taskId: started.taskId, limit: 10 }),
          ).pipe(Effect.orDie);
          expect(read.conversation).toMatchObject({
            taskId: started.taskId,
            providerInstanceId: claudeInstanceId,
            model: claudeModel,
            status: "completed",
          });
          expect(read.items.map((item) => [item.type, item.text])).toEqual(
            expect.arrayContaining([
              ["user_message", delegatedPrompt],
              ["assistant_message", delegatedResult],
            ]),
          );
          expectNoConversationIdentity(read, childThreadId);
          const firstAssistant = read.items.find((item) => item.type === "assistant_message")!;
          const truncated = yield* decodeTaskRead(
            yield* call("task_read", {
              taskId: started.taskId,
              itemId: firstAssistant.itemId,
              maxCharsPerItem: 5,
            }),
          ).pipe(Effect.orDie);
          expect(truncated.items[0]).toMatchObject({
            text: delegatedResult.slice(0, 5),
            textTruncated: true,
            nextTextOffset: 5,
          });
          const misspelled = yield* invoke("task_read", { taskId: started.taskId, after: 3 }).pipe(
            Effect.flip,
          );
          expect(misspelled._tag).toBe("InvalidParams");

          // A follow-up after the result becomes its own task.
          const followUp = yield* decodeTaskSend(
            yield* call("task_send", {
              taskId: started.taskId,
              message: followUpPrompt,
              clientRequestId: "follow-up-boundary",
            }),
          ).pipe(Effect.orDie);
          expect(followUp.taskId).not.toBe(started.taskId);
          expect(followUp.delivery).toBe("started");
          const followUpRetry = yield* decodeTaskSend(
            yield* call("task_send", {
              taskId: started.taskId,
              message: followUpPrompt,
              clientRequestId: "follow-up-boundary",
            }),
          ).pipe(Effect.orDie);
          expect(followUpRetry.taskId).toBe(followUp.taskId);
          const followUpDone = yield* decodeTaskView(
            yield* call("task_wait", { taskId: followUp.taskId }),
          ).pipe(Effect.orDie);
          expect(followUpDone).toMatchObject({
            status: "completed",
            summary: `Claude completed: ${followUpPrompt}`,
          });
          expect(
            yield* decodeTaskView(yield* call("task_status", { taskId: started.taskId })).pipe(
              Effect.orDie,
            ),
          ).toMatchObject({
            summary: delegatedResult,
            latestResult: { status: "completed", summary: `Claude completed: ${followUpPrompt}` },
          });

          // A bounded wait returns without cancelling; cancel stops the task.
          const blocking = yield* decodeTaskView(
            yield* call("delegate_task", {
              task: cancellationPrompt,
              target: { providerInstanceId: claudeInstanceId },
              mode: "wait",
              timeoutMs: 50,
              clientRequestId: "delegate-blocking",
            }),
          ).pipe(Effect.orDie);
          expect(blocking).toMatchObject({ waitTimedOut: true, workState: "working" });
          const blockingChild = yield* childThreadOf(orchestrator, blocking.taskId);
          yield* waitForProjection(orchestrator, blockingChild, (projection) =>
            projection.providerTurns.some((turn) => turn.status === "running"),
          );
          const timedOutWait = yield* decodeTaskView(
            yield* call("task_wait", { taskId: blocking.taskId, timeoutMs: 20 }),
          ).pipe(Effect.orDie);
          expect(timedOutWait).toMatchObject({ waitTimedOut: true, status: "running" });
          const cancelled = yield* decodeTaskCancel(
            yield* call("task_cancel", {
              taskId: blocking.taskId,
              clientRequestId: "cancel-blocking",
            }),
          ).pipe(Effect.orDie);
          expect(cancelled).toEqual({ taskId: blocking.taskId, status: "cancel_requested" });
          const stopped = yield* decodeTaskView(
            yield* call("task_wait", { taskId: blocking.taskId }),
          ).pipe(Effect.orDie);
          expect(["cancelled", "interrupted"]).toContain(stopped.status);

          // Omitting taskId reads the caller's own conversation.
          const own = yield* decodeTaskRead(
            yield* call("task_read", { view: "activity", limit: 100 }),
          ).pipe(Effect.orDie);
          expect(own.conversation).toMatchObject({
            taskId: null,
            activeRunId: parentRun.id,
            providerInstanceId: codexInstanceId,
          });
          expect(own.items.find((item) => item.type === "user_message")?.text).toBe(parentPrompt);
          expect(
            own.items.filter((item) => item.type === "subagent").map((item) => item.taskId),
          ).toEqual(expect.arrayContaining([started.taskId, blocking.taskId]));
          expectNoConversationIdentity(own.items, childThreadId);

          // Delegated tasks are not workflows, and unknown tasks fail explicitly.
          expect(
            declaredFailure(yield* invoke("stop_workflow", { taskId: started.taskId })),
          ).toMatchObject({ code: "invalid_request" });
          expect(
            declaredFailure(yield* invoke("task_status", { taskId: "task:missing" })),
          ).toMatchObject({ code: "task_not_found" });
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );

  it.live("reports running and queued follow-ups from a Codex replay transcript", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const cwd = yield* checkpointWorkspace("delegated-task-status");
        const rawTranscript = yield* readDelegatedTaskStatusTranscript();
        const transcript = yield* CodexOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptWorkspace(rawTranscript, cwd),
        );
        const layerOrchestrator = ProviderReplayHarness.layerProviderReplay(
          {
            name: "delegated-task-status/codex",
            transcript,
            commands: [],
            runtimePolicyOverride: { cwd },
          },
          CodexOrchestratorReplayHarness,
        );
        const layerOrchestration = Layer.merge(
          layerOrchestrator,
          ThreadManagementService.layer.pipe(
            Layer.provide(layerOrchestrator),
            Layer.provide(ServerSettings.layerTest()),
            Layer.provide(
              CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
            ),
          ),
        );
        const layerTest = layerToolkit.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(layerOrchestration),
          Layer.provide(
            CodexOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(transcript).pipe(
              Layer.provide(McpProviderSessions.layer),
            ),
          ),
          Layer.provide(
            ProviderRegistryMock.layer([
              makeProviderSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: codexModel,
              }),
            ]),
          ),
          Layer.provide(ServerSettings.layerTest()),
          Layer.provide(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threads = yield* ThreadManagementService.ThreadManagementService;
          const server = yield* McpServer.McpServer;
          const parentCreate = yield* orchestrator.dispatch({
            type: "thread.create",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:create"),
            threadId: parentThreadId,
            projectId,
            title: "MCP replay parent",
            modelSelection: codexSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("command:mcp-replay-parent:start"),
            threadId: parentThreadId,
            messageId: MessageId.make("message:mcp-replay-parent:start"),
            text: "Keep this parent turn active while orchestration tools are tested.",
            attachments: [],
            modelSelection: codexSelection,
            dispatchMode: { type: "start_immediately" },
          });
          const awaitEvent = (
            threadId: ThreadId,
            afterSequence: number,
            matches: (stored: OrchestrationV2StoredEvent) => boolean,
            message: string,
          ) =>
            orchestrator
              .streamStoredEventsFrom({ threadId, afterSequence })
              .pipe(
                Stream.filter(matches),
                Stream.runHead,
                Effect.flatMap(
                  Option.match({ onNone: () => Effect.die(message), onSome: () => Effect.void }),
                ),
              );
          yield* awaitEvent(
            parentThreadId,
            parentCreate.sequence,
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
            "Parent provider turn did not start.",
          );

          const invoke = (name: string, args: Record<string, unknown>) =>
            server
              .callTool({ name, arguments: args })
              .pipe(
                Effect.provideService(
                  McpInvocationContext.McpInvocationContext,
                  scopeFor(parentThreadId, codexInstanceId),
                ),
                Effect.provideService(McpSchema.McpServerClient, client),
              );

          const delegationStart = yield* orchestrator.getThreadEventSequence(parentThreadId);
          const delegated = yield* decodeTaskView(
            (yield* invoke("delegate_task", {
              parentRunId: (yield* orchestrator.getThreadShell(parentThreadId))!.activeRunId!,
              task: delegatedPrompt,
              target: { providerInstanceId: codexInstanceId, model: codexModel },
              mode: "async",
              clientRequestId: "delegate-codex-replay-1",
            })).structuredContent,
          ).pipe(Effect.orDie);
          const childThreadId = yield* childThreadOf(orchestrator, delegated.taskId);
          yield* awaitEvent(
            parentThreadId,
            delegationStart,
            (stored) =>
              stored.event.type === "context-transfer.created" &&
              stored.event.payload.type === "subagent_result" &&
              stored.event.payload.sourceThreadId === childThreadId,
            "Delegated result transfer was not created.",
          );
          const completed = yield* decodeTaskView(
            (yield* invoke("task_status", { taskId: delegated.taskId })).structuredContent,
          ).pipe(Effect.orDie);
          expect(completed).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            hasPendingFollowUps: false,
            latestResult: { status: "completed", summary: delegatedResult },
          });

          const followupStart = yield* orchestrator.getThreadEventSequence(childThreadId);
          const running = yield* decodeTaskSend(
            (yield* invoke("task_send", {
              taskId: delegated.taskId,
              message: cancellationPrompt,
              clientRequestId: "delegated-child-replay-running-1",
            })).structuredContent,
          ).pipe(Effect.orDie);
          yield* awaitEvent(
            childThreadId,
            followupStart,
            (stored) =>
              stored.event.type === "provider-turn.updated" &&
              stored.event.payload.status === "running",
            "Follow-up provider turn did not start.",
          );
          const queued = yield* decodeTaskSend(
            (yield* invoke("task_send", {
              taskId: delegated.taskId,
              message: queuedFollowupPrompt,
              mode: "queue",
              clientRequestId: "delegated-child-replay-queued-1",
            })).structuredContent,
          ).pipe(Effect.orDie);
          expect(queued).toMatchObject({ status: "queued", delivery: "queued" });
          expect(new Set([delegated.taskId, running.taskId, queued.taskId]).size).toBe(3);

          const pending = yield* decodeTaskView(
            (yield* invoke("task_status", { taskId: delegated.taskId })).structuredContent,
          ).pipe(Effect.orDie);
          expect(pending).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            hasPendingFollowUps: true,
          });

          // The user, not a tool, interrupts the running follow-up here.
          const finalSequence = yield* orchestrator.getThreadEventSequence(childThreadId);
          const runningRun = (yield* orchestrator.getThreadShell(childThreadId))!.activeRunId!;
          yield* threads
            .interruptThread({
              projectId,
              commandId: CommandId.make("command:mcp-replay:interrupt-running-followup"),
              threadId: childThreadId,
              runId: runningRun,
              reason: "Allow the queued replay follow-up to run.",
            })
            .pipe(Effect.orDie);
          const queuedDone = yield* decodeTaskView(
            (yield* invoke("task_wait", { taskId: queued.taskId })).structuredContent,
          ).pipe(Effect.orDie);
          expect(queuedDone).toMatchObject({ status: "completed", summary: queuedFollowupResult });
          yield* awaitEvent(
            parentThreadId,
            finalSequence,
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === running.taskId &&
              stored.event.payload.status === "interrupted",
            "Interrupted follow-up task did not settle.",
          );
          const final = yield* decodeTaskView(
            (yield* invoke("task_status", { taskId: delegated.taskId })).structuredContent,
          ).pipe(Effect.orDie);
          expect(final).toMatchObject({
            status: "completed",
            summary: delegatedResult,
            hasPendingFollowUps: false,
            latestResult: { status: "completed", summary: queuedFollowupResult },
          });
          expectNoConversationIdentity(final, childThreadId);
        }).pipe(Effect.provide(layerTest));
      }),
    ),
  );
});
