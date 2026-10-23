import {
  CommandId,
  ChatAttachmentId,
  ModelSelection,
  MessageId,
  OrchestrationV2Command,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
  ProjectId,
  ThreadId,
  TurnItemId,
  RunId,
  ServerProvider,
  OrchestrationV2ThreadShell,
  OrchestrationV2DomainEvent,
  PersistChatAttachmentsInput,
  PersistChatAttachmentsResult,
  ProviderInstanceConfigMap,
  OrchestrationV2Subagent,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionLocation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Schedule from "effect/Schedule";
import { createHash } from "node:crypto";
import * as NetAddress from "effect/net/NetAddress";
import { HttpServer } from "effect/http";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { HostBridge } from "./HostBridge.ts";
import * as Authority from "./Authority.ts";
import * as NativeInteraction from "./NativeInteraction.ts";
import * as ExecutionLocation from "./ExecutionLocation.ts";
import * as NativeRuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { make as makeThreadAttachmentReader } from "./Attachment.ts";
import { compactThread } from "./Compact.ts";
import {
  EXECUTION_ACTIVITY_MAX_PAGE_LIMIT,
  EXECUTION_ACTIVITY_MAX_POINT_READS,
  readRootActivity,
} from "../orchestration-v2/ExecutionActivity.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as Duration from "effect/Duration";
import { rollbackThread } from "./Rollback.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Providers from "../provider/ProviderRegistry.ts";
import * as Configuration from "../config.ts";
import { persistChatAttachments } from "../assets/PersistChatAttachments.ts";
import * as ProviderConfiguration from "./ProviderConfiguration.ts";
import * as StorageSnapshot from "./StorageSnapshot.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { buildBoundedThreadStreamSnapshot } from "../orchestration-v2/ThreadStream.ts";
import {
  projectStoredEventForWire,
  assertPublicWirePayloadBudget,
  projectTurnItemForDetail,
} from "../orchestration-v2/WireProjection.ts";
import {
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "../orchestration-v2/threadHistoryPaging.ts";
import type {
  AgentEvent,
  AgentRuntimeIdentity,
  AgentRuntimeNotification,
  AgentRuntimeConfiguration,
} from "./Interface.ts";
import { AGENT_RUNTIME_STRUCTURED_GENERATION_MAX_TIMEOUT_MS } from "./TextGenerationLimits.ts";

const request = <Method extends string, Input extends Schema.Constraint>(
  method: Method,
  input: Input,
) => Schema.Struct({ id: Schema.String, method: Schema.Literal(method), input });
const EventType = Schema.Literals(
  OrchestrationV2DomainEvent.members.flatMap((member) => {
    const type = member.fields.type;
    return "literals" in type ? type.literals : [type.literal];
  }),
);
const NativeSource = Schema.Struct({
  runtimeGeneration: Schema.String,
  threadId: ThreadId,
  providerSessionId: Schema.String,
  nativeGeneration: Schema.Int,
  providerThreadId: Schema.String,
  nativeThreadId: Schema.String,
});
const VoiceClaim = { claimId: Schema.String, source: NativeSource };
const AgentRequest = Schema.Union([
  request("execution.handoff.pending", Schema.Struct({ cursor: Schema.optional(Schema.String) })),
  request(
    "execution.handoff.hold",
    Schema.Struct({
      threadId: ThreadId,
      operationId: Schema.String,
      action: Schema.Literals(["acquire", "recovery", "release"]),
      recoveryRequired: Schema.optional(Schema.Boolean),
      sourceLocation: Schema.optional(OrchestrationV2ExecutionLocation),
    }),
  ),
  request(
    "execution.handoff.quiesce",
    Schema.Struct({ threadId: ThreadId, operationId: Schema.String }),
  ),
  request(
    "execution.handoff.commit",
    Schema.Struct({
      threadId: ThreadId,
      operationId: Schema.String,
      location: OrchestrationV2ExecutionLocation,
      sourceWorkspaceRoot: Schema.optional(Schema.String),
      childrenOnly: Schema.optional(Schema.Boolean),
    }),
  ),
  request("native.voice.prepare", Schema.Struct({ threadId: ThreadId, claimId: Schema.String })),
  request("native.voice.current", NativeSource),
  request(
    "native.voice.start",
    Schema.Struct({
      ...VoiceClaim,
      settings: Schema.Unknown,
      sdp: Schema.String.check(Schema.isMaxLength(131072)),
    }),
  ),
  request("native.voice.stop", Schema.Struct(VoiceClaim)),
  request(
    "native.voice.append-text",
    Schema.Struct({
      ...VoiceClaim,
      role: Schema.String,
      text: Schema.String.check(Schema.isMaxLength(65536)),
    }),
  ),
  request(
    "native.voice.append-speech",
    Schema.Struct({ ...VoiceClaim, text: Schema.String.check(Schema.isMaxLength(65536)) }),
  ),
  request("native.voice.inject", Schema.Struct({ ...VoiceClaim, items: Schema.Unknown })),
  request("native.voice.release", Schema.Struct({ claimId: Schema.String })),
  request(
    "native.prediction.request",
    Schema.Struct({
      threadId: ThreadId,
      latestRunId: Schema.String,
      generationTrigger: Schema.Literals(["live", "catch-up"]),
      configuration: Schema.Struct({
        prompt: Schema.String.check(Schema.isMaxLength(65536)),
        prompt_version: Schema.String,
        prediction_reasoning_effort: Schema.String,
        unsupported_models: Schema.optional(Schema.Array(Schema.String)),
        sample_rate: Schema.optional(Schema.Number),
        live_sample_rate: Schema.optional(Schema.Number),
        catch_up_sample_rate: Schema.optional(Schema.Number),
      }),
    }),
  ),
  request("native.prediction.clear", Schema.Struct({ threadId: Schema.optional(ThreadId) })),
  request(
    "text.generate-structured",
    Schema.Struct({
      cwd: Schema.String,
      prompt: Schema.String.check(Schema.isMaxLength(262144)),
      modelSelection: ModelSelection,
      outputSchema: Schema.Record(Schema.String, Schema.Unknown),
      maxOutputBytes: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 262144 })),
      ),
      timeoutMs: Schema.optional(
        Schema.Int.check(
          Schema.isBetween({
            minimum: 1,
            maximum: AGENT_RUNTIME_STRUCTURED_GENERATION_MAX_TIMEOUT_MS,
          }),
        ),
      ),
    }),
  ),
  request(
    "tasks.overview",
    Schema.Struct({
      threadId: ThreadId,
      activeCursor: Schema.optional(Schema.String),
      terminalCursor: Schema.optional(Schema.String),
    }),
  ),
  request("storage.snapshot.acquire", Schema.Struct({})),
  request("storage.snapshot.release", Schema.Struct({ leaseId: Schema.String })),
  request("providers.configure", Schema.Struct({ providers: ProviderInstanceConfigMap })),
  request("attachments.persist", PersistChatAttachmentsInput),
  request("thread.read", Schema.Struct({ threadId: ThreadId })),
  request("thread.control", Schema.Struct({ threadId: ThreadId, runId: Schema.optional(RunId) })),
  request(
    "thread.fork-source",
    Schema.Struct({ threadId: ThreadId, runId: Schema.optional(RunId) }),
  ),
  request(
    "providers.read",
    Schema.Struct({
      refresh: Schema.optional(Schema.Boolean),
      instanceIds: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  request(
    "native-session.authority",
    Schema.Struct({
      threadId: ThreadId,
      providerSessionId: Schema.String,
      nativeGeneration: Schema.Number,
      incarnationId: Schema.String,
    }),
  ),
  request("thread.authority", Schema.Struct({ threadId: ThreadId, runId: RunId })),
  request("run.outcome", Schema.Struct({ threadId: ThreadId, messageId: MessageId })),
  request("command.dispatch", OrchestrationV2Command),
  request("command.receipt", Schema.Struct({ commandId: CommandId, threadId: ThreadId })),
  request("thread.compact", Schema.Struct({ threadId: ThreadId, requestId: CommandId })),
  request(
    "thread.rollback",
    Schema.Struct({ threadId: ThreadId, requestId: CommandId, runId: RunId }),
  ),
  request(
    "project.upsert",
    Schema.Struct({
      id: ProjectId,
      title: Schema.String,
      workspaceRoot: Schema.String,
      defaultModelSelection: Schema.optional(ModelSelection),
    }),
  ),
  request("project.read", Schema.Struct({ projectId: ProjectId })),
  request("project.activity", Schema.Struct({ projectId: ProjectId })),
  request(
    "project.roots",
    Schema.Struct({ projectId: ProjectId, cursor: Schema.optional(Schema.String) }),
  ),
  request(
    "thread.queue",
    Schema.Struct({ threadId: ThreadId, cursor: Schema.optional(Schema.String) }),
  ),
  request("thread.queued-preview", Schema.Struct({ threadId: ThreadId, runId: RunId })),
  request("thread.run-message", Schema.Struct({ threadId: ThreadId, runId: RunId })),
  request("project.close", Schema.Struct({ projectId: ProjectId })),
  request(
    "shell.read",
    Schema.Struct({
      projectId: Schema.optional(ProjectId),
      location: Schema.optional(Schema.Literals(["active", "archive"])),
    }),
  ),
  request("thread.snapshot", Schema.Struct({ threadId: ThreadId })),
  request(
    "thread.history",
    Schema.Struct({
      threadId: ThreadId,
      cursor: Schema.String,
      throughEntryId: Schema.optional(Schema.String),
      conversationOnly: Schema.optional(Schema.Boolean),
    }),
  ),
  request(
    "thread.item",
    Schema.Struct({
      threadId: ThreadId,
      itemId: TurnItemId,
      sourceThreadId: Schema.optional(ThreadId),
    }),
  ),
  request(
    "thread.attachment",
    Schema.Struct({
      threadId: ThreadId,
      sourceThreadId: Schema.optional(ThreadId),
      itemId: TurnItemId,
      attachmentId: ChatAttachmentId,
    }),
  ),
  request(
    "thread.item.full",
    Schema.Struct({
      threadId: ThreadId,
      itemId: TurnItemId,
      sourceThreadId: Schema.optional(ThreadId),
    }),
  ),
  request(
    "events.observe",
    Schema.Struct({
      threadId: Schema.optional(ThreadId),
      afterSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      eventTypes: Schema.optional(Schema.Array(EventType).check(Schema.isMaxLength(64))),
    }),
  ),
  request(
    "execution.observe",
    Schema.Struct({
      threadId: Schema.optional(ThreadId),
      afterSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    }),
  ),
  request(
    "execution.activity",
    Schema.Struct({
      cursor: Schema.optional(Schema.String),
      limit: Schema.optional(
        Schema.Int.check(
          Schema.isBetween({ minimum: 1, maximum: EXECUTION_ACTIVITY_MAX_PAGE_LIMIT }),
        ),
      ),
      rootThreadIds: Schema.optional(
        Schema.Array(ThreadId).check(Schema.isMaxLength(EXECUTION_ACTIVITY_MAX_POINT_READS)),
      ),
    }),
  ),
  request("events.unobserve", Schema.Struct({ subscriptionId: Schema.String })),
  request("runtime.identity", Schema.Struct({})),
  request("shutdown", Schema.Struct({})),
]);
const decodeRequest = Schema.decodeUnknownEffect(Schema.toCodecJson(AgentRequest));
const encodeShell = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadShellSnapshot));
const encodeProviders = Schema.encodeEffect(Schema.toCodecJson(Schema.Array(ServerProvider)));
const encodeThreadShell = Schema.encodeEffect(
  Schema.toCodecJson(Schema.NullOr(OrchestrationV2ThreadShell)),
);
const encodeSnapshotJson = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
const encodeSnapshot = (snapshot: OrchestrationV2ThreadStreamItem) =>
  encodeSnapshotJson(snapshot).pipe(
    Effect.flatMap((encoded) => Effect.try(() => assertPublicWirePayloadBudget(encoded))),
  );
const encodeHistory = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage));
const encodeItem = Schema.encodeEffect(Schema.toCodecJson(Schema.NullOr(OrchestrationV2TurnItem)));
const encodeQueuedMessage = Schema.encodeEffect(
  Schema.toCodecJson(Schema.NullOr(OrchestrationV2ConversationMessage)),
);
const encodeEvent = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2StoredEvent));
const encodeAttachments = Schema.encodeEffect(Schema.toCodecJson(PersistChatAttachmentsResult));
const overviewFields = OrchestrationV2Subagent.fields;
const OverviewItem = Schema.Struct({
  id: overviewFields.id,
  threadId: overviewFields.threadId,
  runId: overviewFields.runId,
  parentNodeId: overviewFields.parentNodeId,
  origin: overviewFields.origin,
  driver: overviewFields.driver,
  providerInstanceId: overviewFields.providerInstanceId,
  providerThreadId: overviewFields.providerThreadId,
  childThreadId: overviewFields.childThreadId,
  title: overviewFields.title,
  model: overviewFields.model,
  modelSelection: overviewFields.modelSelection,
  status: overviewFields.status,
  startedAt: overviewFields.startedAt,
  completedAt: overviewFields.completedAt,
  updatedAt: overviewFields.updatedAt,
  childRunId: Schema.NullOr(RunId),
  resultAvailable: Schema.Boolean,
});
const OverviewPage = Schema.Struct({
  items: Schema.Array(OverviewItem),
  nextCursor: Schema.NullOr(Schema.String),
  hasMore: Schema.Boolean,
  totalCount: Schema.Int,
});
const encodeOverview = Schema.encodeEffect(
  Schema.toCodecJson(Schema.Struct({ active: OverviewPage, terminal: OverviewPage })),
);

/** Runtime identity is persisted by the engine and never derived from the current process ID. */
export const readIdentity = Effect.gen(function* () {
  const configuration = yield* Configuration.ServerConfig;
  const environment = yield* Environment.ServerEnvironmentIdentity;
  const server = yield* HttpServer.HttpServer;
  const eventSink = yield* EventSink.EventSinkV2;
  const bridge = yield* HostBridge;
  const mcpEndpoint = NetAddress.isInetAddress(server.address)
    ? `http://127.0.0.1:${server.address.port}/mcp`
    : "http://127.0.0.1/mcp";
  return {
    runtimeId: yield* environment.getEnvironmentId,
    runtimeGeneration: bridge.runtimeGeneration,
    schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
    databasePath: configuration.dbPath,
    mcpEndpoint,
    lastSequence: yield* eventSink.latestSequence(),
  } satisfies AgentRuntimeIdentity;
});

/** Validates commands once at the transport boundary and only exposes bounded reads. */
export const make = Effect.fn("AgentRuntime.makeService")(function* (
  notify: (notification: AgentRuntimeNotification) => Effect.Effect<void>,
  initialProviders: AgentRuntimeConfiguration["providers"],
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threads = yield* ThreadManagementService;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const sql = yield* SqlClient.SqlClient;
  // A Thread's root never changes; observation resolves it once per Thread.
  const roots = new Map<string, string>();
  const rootOf = Effect.fnUntraced(function* (threadId: ThreadId) {
    const known = roots.get(threadId);
    if (known !== undefined) return known;
    const root = (yield* projections.getThread(threadId)).lineage.rootThreadId;
    if (roots.size >= 4096) roots.delete(roots.keys().next().value!);
    roots.set(threadId, root);
    return root;
  });
  const projects = yield* Projects.ProjectService;
  const projections = yield* ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const identity = yield* readIdentity;
  const effectOutbox = yield* EffectOutboxV2;
  const providers = yield* Providers.ProviderRegistry;
  const providerConfiguration = yield* ProviderConfiguration.make(
    yield* Schema.decodeUnknownEffect(ProviderInstanceConfigMap)(initialProviders),
  );
  // SQL waiters cannot delay interruption of the lease fiber that releases their connection.
  const processScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
  const storageSnapshot = yield* StorageSnapshot.make(identity, providerConfiguration).pipe(
    Effect.provideService(Scope.Scope, processScope),
  );
  const textGeneration = yield* TextGeneration;
  const nativeInteraction = yield* NativeInteraction.make(identity.runtimeGeneration, notify).pipe(
    Effect.provide(NativeRuntimePolicy.layerFromProjectStore),
  );
  const executionLocation = yield* ExecutionLocation.make;
  const readAuthority = yield* Authority.make;
  const readNativeSessionAuthority = yield* Authority.makeNativeSession;
  const configuration = yield* Configuration.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const subscriptions = yield* Ref.make<ReadonlyMap<string, Fiber.Fiber<void>>>(new Map());
  const unobserve = Effect.fn("AgentRuntime.unobserve")(function* (id: string) {
    const fiber = yield* Ref.modify(subscriptions, (current) => {
      const next = new Map(current);
      next.delete(id);
      return [current.get(id), next];
    });
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
  });

  const readThreadAttachment = yield* makeThreadAttachmentReader;

  const execute = Effect.fn("AgentRuntime.executeRequest")(function* (
    input: typeof AgentRequest.Type,
  ) {
    switch (input.method) {
      case "execution.handoff.pending":
        return yield* projections.getExecutionHandoffs(input.input.cursor);
      case "execution.handoff.hold":
        return yield* executionLocation.hold(input.input);
      case "execution.handoff.quiesce":
        return yield* executionLocation.quiesce(input.input);
      case "execution.handoff.commit":
        return yield* executionLocation.commit(input.input);
      case "project.close": {
        const projectId = input.input.projectId;
        if (Option.isNone(yield* projects.getById(projectId))) return { closedBindings: 0 };
        let closedBindings = 0;
        let cursor: string | undefined;
        do {
          const activity = yield* projections.getProjectExecutionActivity(projectId);
          if (
            activity.run ||
            activity.runtimeRequest ||
            activity.nativeBackground ||
            activity.executionHandoff
          )
            return yield* Effect.fail(new Error("The Project has active Agent execution."));
          const page = yield* projections.getProjectProviderSessionBindings(projectId, cursor);
          for (const binding of page.items) {
            const commandId = CommandId.make(
              `host:project-close:${createHash("sha256")
                .update(
                  JSON.stringify([
                    projectId,
                    binding.threadId,
                    binding.providerSessionId,
                    page.snapshotSequence,
                  ]),
                )
                .digest("base64url")}`,
            );
            yield* orchestrator.dispatch({
              type: "provider-session.detach",
              commandId,
              ...binding,
              onlyIfIdle: true,
              revokeMcpCredential: true,
              reason: "Project archived",
            });
            const effectId = `effect:${commandId}:provider-session.detach:${binding.providerSessionId}`;
            yield* Effect.gen(function* () {
              const effect = yield* effectOutbox.get(effectId);
              if (Option.isNone(effect))
                return yield* Effect.fail(new Error("The provider detach receipt is unavailable."));
              if (effect.value.status === "failed" || effect.value.status === "cancelled")
                return yield* Effect.fail(new Error("The provider detach did not complete."));
              return effect.value.status === "succeeded";
            }).pipe(
              Effect.repeat({ until: (done) => done, schedule: Schedule.spaced("25 millis") }),
              Effect.timeout("10 seconds"),
            );
            closedBindings += 1;
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return { closedBindings };
      }
      case "run.outcome":
        return yield* projections.getRunOutcome(input.input.threadId, input.input.messageId);
      case "project.activity":
        return yield* projections.getProjectExecutionActivity(input.input.projectId);
      case "project.roots":
        return yield* projections.getProjectRoots(input.input.projectId, input.input.cursor);
      case "thread.queue":
        return yield* projections.getQueuedRunPage(input.input.threadId, input.input.cursor);
      case "thread.queued-preview":
        return yield* projections.getQueuedRunPreview(input.input.threadId, input.input.runId);
      case "thread.run-message":
        return yield* projections
          .getRunUserMessage(input.input.threadId, input.input.runId)
          .pipe(Effect.flatMap(encodeQueuedMessage));
      case "tasks.overview":
        return yield* projections
          .getThreadSubagentOverview({
            threadId: input.input.threadId,
            ...(input.input.activeCursor === undefined
              ? {}
              : { activeCursor: input.input.activeCursor }),
            ...(input.input.terminalCursor === undefined
              ? {}
              : { terminalCursor: input.input.terminalCursor }),
          })
          .pipe(Effect.flatMap(encodeOverview));
      case "storage.snapshot.acquire":
        return yield* storageSnapshot.acquire;
      case "storage.snapshot.release":
        return yield* storageSnapshot.release(input.input.leaseId);
      case "providers.configure":
        return yield* providerConfiguration.configure(input.input.providers);
      case "attachments.persist": {
        const shell = yield* orchestrator.getThreadShell(input.input.threadId);
        if (shell === null)
          return yield* Effect.fail(new Error("The attachment target Thread does not exist."));
        const attachments = yield* persistChatAttachments(input.input).pipe(
          Effect.provideService(Configuration.ServerConfig, configuration),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        return yield* encodeAttachments({ attachments });
      }
      case "native.voice.prepare":
        return yield* nativeInteraction.prepare(input.input);
      case "native.voice.current":
        return yield* nativeInteraction.current(input.input);
      case "native.voice.start":
        yield* nativeInteraction.start(input.input);
        return null;
      case "native.voice.stop":
        yield* nativeInteraction.stop(input.input);
        return null;
      case "native.voice.append-text":
        yield* nativeInteraction.appendText(input.input);
        return null;
      case "native.voice.append-speech":
        yield* nativeInteraction.appendSpeech(input.input);
        return null;
      case "native.voice.inject":
        yield* nativeInteraction.inject(input.input);
        return null;
      case "native.voice.release":
        yield* nativeInteraction.release(input.input.claimId);
        return null;
      case "native.prediction.request":
        return yield* nativeInteraction.predict(input.input);
      case "native.prediction.clear":
        yield* nativeInteraction.clearPredictions(input.input.threadId);
        return null;
      case "text.generate-structured":
        if (!textGeneration.generateStructured)
          return yield* Effect.fail(new Error("Structured generation is unavailable"));
        return yield* textGeneration.generateStructured(input.input);
      case "thread.read":
        return yield* orchestrator
          .getThreadShell(input.input.threadId)
          .pipe(Effect.flatMap(encodeThreadShell));
      case "providers.read": {
        const named = input.input.instanceIds;
        return yield* (
          input.input.refresh
            ? providers.refresh()
            : named
              ? providers.getCheckedProvidersFor(named)
              : providers.getCheckedProviders
        ).pipe(
          Effect.map((all) =>
            named ? all.filter((provider) => named.includes(provider.instanceId)) : all,
          ),
          Effect.flatMap(encodeProviders),
        );
      }
      case "native-session.authority":
        return yield* readNativeSessionAuthority(input.input);
      case "thread.authority":
        return yield* readAuthority(input.input);
      case "runtime.identity":
        return { ...identity, lastSequence: yield* eventSink.latestSequence() };
      case "shutdown":
        return { stopped: true };
      case "command.dispatch": {
        const result = yield* orchestrator.dispatch(input.input);
        return { sequence: result.sequence };
      }
      case "command.receipt": {
        const found = yield* orchestrator.getReceipt(input.input.commandId);
        if (Option.isNone(found)) return null;
        const receipt = found.value;
        if (receipt.threadId !== input.input.threadId)
          return yield* Effect.fail(new Error("Command receipt belongs to another Thread"));
        return {
          status: receipt.status,
          sequence: receipt.resultSequence,
          error: receipt.error,
        };
      }
      case "thread.compact":
        return yield* compactThread(input.input).pipe(
          Effect.provideService(ThreadManagementService, threads),
        );
      case "thread.rollback":
        return yield* rollbackThread(input.input).pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.provideService(IdAllocator.IdAllocatorV2, idAllocator),
        );
      case "project.upsert": {
        const { id, ...properties } = input.input;
        const existing = yield* projects.getById(id);
        const mutation = {
          ...properties,
          projectId: id,
          commandId: CommandId.make(`host:project:${input.id}`),
        };
        if (Option.isNone(existing)) yield* projects.create(mutation);
        else yield* projects.update(mutation);
        return { id };
      }
      case "project.read": {
        const project = yield* projects.getById(input.input.projectId);
        return Option.isNone(project)
          ? null
          : {
              id: project.value.id,
              title: project.value.title,
              workspaceRoot: project.value.workspaceRoot,
            };
      }
      case "shell.read":
        return yield* orchestrator
          .getShellSnapshot({
            ...(input.input.projectId === undefined ? {} : { projectId: input.input.projectId }),
            ...(input.input.location === undefined ? {} : { location: input.input.location }),
          })
          .pipe(Effect.flatMap(encodeShell));
      case "thread.fork-source":
        return yield* orchestrator.getThreadForkSource(input.input.threadId, input.input.runId);
      case "thread.control":
      case "thread.snapshot": {
        const snapshot = yield* orchestrator.getThreadSnapshotWindow(input.input.threadId, {
          rowLimit: input.method === "thread.control" ? 0 : THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          controlOnly: input.method === "thread.control",
          requiredRunId: input.method === "thread.control" ? input.input.runId : undefined,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
        return yield* encodeSnapshot(
          buildBoundedThreadStreamSnapshot({
            ...snapshot,
            compactTurnItems: true,
            requiredRunId: input.method === "thread.control" ? input.input.runId : undefined,
          }),
        );
      }
      case "thread.history":
        return yield* orchestrator
          .getThreadHistoryPage(
            input.input.threadId,
            input.input.cursor,
            input.input.throughEntryId,
            input.input.conversationOnly,
          )
          .pipe(Effect.flatMap(encodeHistory));
      case "thread.item":
        return yield* projections
          .getVisibleTurnItem({
            threadId: input.input.threadId,
            itemId: input.input.itemId,
            ...(input.input.sourceThreadId === undefined
              ? {}
              : { sourceThreadId: input.input.sourceThreadId }),
          })
          .pipe(
            Effect.map((item) => (item === null ? null : projectTurnItemForDetail(item))),
            Effect.flatMap(encodeItem),
          );
      case "thread.attachment":
        return yield* readThreadAttachment({
          threadId: input.input.threadId,
          itemId: input.input.itemId,
          attachmentId: input.input.attachmentId,
          ...(input.input.sourceThreadId === undefined
            ? {}
            : { sourceThreadId: input.input.sourceThreadId }),
        });
      case "thread.item.full": {
        const item = yield* projections
          .getVisibleTurnItem({
            threadId: input.input.threadId,
            itemId: input.input.itemId,
            ...(input.input.sourceThreadId === undefined
              ? {}
              : { sourceThreadId: input.input.sourceThreadId }),
          })
          .pipe(Effect.flatMap(encodeItem));
        if (new TextEncoder().encode(JSON.stringify(item)).byteLength > 15 * 1024 * 1024)
          return yield* Effect.fail(
            new Error("The full item exceeds the single-response transport budget."),
          );
        return item;
      }
      case "execution.activity":
        return yield* readRootActivity(input.input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      case "events.unobserve": {
        yield* unobserve(input.input.subscriptionId);
        return { unsubscribed: true };
      }
      case "execution.observe":
      case "events.observe": {
        yield* unobserve(input.id);
        const afterSequence = input.input.afterSequence ?? (yield* eventSink.latestSequence());
        const cursor = {
          afterSequence,
          ...(input.input.threadId === undefined ? {} : { threadId: input.input.threadId }),
        };
        // Execution observation also follows every event that can change a root's activity.
        const eventTypes =
          input.method === "execution.observe"
            ? [
                "run.updated",
                "thread.deleted",
                "runtime-request.updated",
                "subagent.updated",
                "provider-thread.updated",
              ]
            : input.input.eventTypes;
        // Type-specific channels filter before retaining live events or decoding SQL replay.
        const stream =
          eventTypes === undefined
            ? orchestrator.streamStoredEventsFrom(cursor)
            : Stream.mergeAll(
                [...new Set(eventTypes)].map((eventType) =>
                  orchestrator.streamStoredEventsFrom({
                    ...cursor,
                    eventType: eventType as OrchestrationV2DomainEvent["type"],
                  }),
                ),
                { concurrency: "unbounded", bufferSize: 16 },
              );
        const observeExecution = (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
          Effect.gen(function* () {
            const changedRoots = new Map<string, number>();
            for (const event of events) {
              if (event.event.type === "run.updated" || event.event.type === "thread.deleted")
                yield* notify({
                  type: "execution.lifecycle",
                  subscriptionId: input.id,
                  runtimeGeneration: identity.runtimeGeneration,
                  sequence: event.sequence,
                  threadId: event.event.threadId,
                  eventType: event.event.type,
                  ...(event.event.type === "run.updated"
                    ? { runId: event.event.payload.id, runStatus: event.event.payload.status }
                    : {}),
                });
              changedRoots.set(yield* rootOf(event.event.threadId), event.sequence);
            }
            // One compact change per root and burst; readers point-read the root's activity.
            for (const [rootThreadId, sequence] of changedRoots)
              yield* notify({ type: "activity", rootThreadId, sequence });
          });
        const consume: Effect.Effect<void, unknown> =
          input.method === "execution.observe"
            ? stream.pipe(
                Stream.groupedWithin(64, Duration.millis(50)),
                Stream.runForEach(observeExecution),
              )
            : stream.pipe(
                Stream.runForEach((event) =>
                  Effect.try(() => projectStoredEventForWire(event)).pipe(
                    Effect.flatMap(encodeEvent),
                    Effect.flatMap((encoded) =>
                      Effect.try(() => assertPublicWirePayloadBudget(encoded)),
                    ),
                    Effect.flatMap((encoded) =>
                      notify({
                        type: "event",
                        subscriptionId: input.id,
                        event: encoded as AgentEvent,
                      }),
                    ),
                  ),
                ),
              );
        const fiber = yield* consume.pipe(
          Effect.catchCause((cause) =>
            notify({
              type: "event.error",
              subscriptionId: input.id,
              message: String(cause),
            }),
          ),
          Effect.forkIn(processScope),
        );
        yield* Ref.update(subscriptions, (current) => new Map(current).set(input.id, fiber));
        return { subscribed: true, subscriptionId: input.id, afterSequence };
      }
    }
  });

  const handle = Effect.fn("AgentRuntime.handleRequest")(function* (value: unknown) {
    const input = yield* decodeRequest(value);
    // New operations participate in the writer fence unless explicitly proven read-only.
    switch (input.method) {
      case "storage.snapshot.acquire":
      case "storage.snapshot.release":
      case "thread.read":
      case "tasks.overview":
      case "native-session.authority":
      case "thread.authority":
      case "project.read":
      case "project.activity":
      case "project.roots":
      case "thread.queue":
      case "thread.run-message":
      case "thread.queued-preview":
      case "shell.read":
      case "thread.snapshot":
      case "thread.control":
      case "thread.fork-source":
      case "run.outcome":
      case "thread.history":
      case "thread.item":
      case "thread.item.full":
      case "thread.attachment":
      case "events.observe":
      case "execution.observe":
      case "execution.activity":
      case "events.unobserve":
      case "runtime.identity":
      case "shutdown":
        return yield* execute(input);
      case "providers.read":
        if (input.input.refresh !== true) return yield* execute(input);
        return yield* storageSnapshot.withWriter(execute(input));
      default:
        return yield* storageSnapshot.withWriter(execute(input));
    }
  });
  return {
    identity,
    handle: (value: unknown) =>
      handle(value).pipe(Effect.forkIn(processScope), Effect.flatMap(Fiber.join)),
  };
});

export class AgentRuntime extends Context.Service<
  AgentRuntime,
  Effect.Success<ReturnType<typeof make>>
>()("@nodex/agent-runtime/Service") {}

export const layer = (
  notify: (notification: AgentRuntimeNotification) => Effect.Effect<void>,
  initialProviders: AgentRuntimeConfiguration["providers"],
) => Layer.effect(AgentRuntime, make(notify, initialProviders));
