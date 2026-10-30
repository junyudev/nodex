import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import {
  ImportChatAttachmentsInput,
  importChatAttachments,
} from "../assets/ImportChatAttachments.ts";
import { ChatAttachment } from "@t3tools/contracts";
import { runtimeHistoryContent } from "./RuntimeHistoryContent.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import { EnvironmentId } from "@t3tools/contracts";
import {
  CommandId,
  ChatAttachmentId,
  OrchestrationMessageContext,
  ProviderInteractionMode,
  ModelSelection,
  MessageId,
  NodeId,
  OrchestrationV2Command,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
  OrchestrationV2ProjectedTurnItem,
  ProjectId,
  ThreadId,
  TurnItemId,
  RunId,
  RuntimeRequestId,
  ServerProvider,
  OrchestrationV2ThreadShell,
  OrchestrationV2DomainEvent,
  OrchestrationV2BackgroundTaskIds,
  PersistChatAttachmentsInput,
  PersistChatAttachmentsResult,
  ProviderInstanceConfigMap,
  ProviderInstanceId,
  OrchestrationV2Subagent,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionLocation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
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
  DispatchModeLimit,
  DispatchModeLimitSchema,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
  ProjectionStoreV2,
} from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { readExecution, waitExecution, readExecutionItemIds } from "./ExecutionRead.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { HostBridge } from "./HostBridge.ts";
import * as Authority from "./Authority.ts";
import * as NativeInteraction from "./NativeInteraction.ts";
import * as ExecutionLocation from "./ExecutionLocation.ts";
import * as NativeImport from "./NativeImport.ts";
import * as NativeMessageReceipts from "./NativeMessageReceipts.ts";
import * as RuntimeMessageReceipts from "./RuntimeMessageReceipts.ts";
import * as NativeRuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { PromptImage } from "./PromptImage.ts";
import { make as makeThreadAttachmentReader } from "./Attachment.ts";
import { compactThread } from "./Compact.ts";
import {
  EXECUTION_ACTIVITY_MAX_PAGE_LIMIT,
  EXECUTION_ACTIVITY_MAX_POINT_READS,
  readRootActivity,
} from "../orchestration-v2/ExecutionActivity.ts";
import {
  SESSION_CATALOG_MAX_LIMIT,
  readSessionCatalog,
} from "../orchestration-v2/SessionCatalog.ts";
import * as SqlClient from "effect/sql/SqlClient";
import { readSessionDetails } from "../orchestration-v2/SessionReadDetails.ts";
import { readSessionMetadata } from "../orchestration-v2/SessionMetadata.ts";
import { readSessionSearch, resolveSessionSearch } from "../orchestration-v2/SessionSearch.ts";
import * as Duration from "effect/Duration";
import { rollbackThread } from "./Rollback.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Providers from "../provider/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as Configuration from "../config.ts";
import { persistChatAttachments } from "../assets/PersistChatAttachments.ts";
import * as ProviderConfiguration from "./ProviderConfiguration.ts";
import * as StorageSnapshot from "./StorageSnapshot.ts";
import * as AcpManagement from "./AcpManagement.ts";
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
import { turnItemText } from "../orchestration-v2/turnItemContent.ts";

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
  ...AcpManagement.Request.members,
  request("thread.import-native", NativeImport.NativeImportInput),
  request("native-imports.find", NativeImport.NativeImportsFindInput),
  request("native-message.receipt", NativeMessageReceipts.NativeMessageLookup),
  request("native-message.reserve", NativeMessageReceipts.NativeMessageReserve),
  request("native-message.settle", NativeMessageReceipts.NativeMessageSettle),
  request("thread.message-admit", RuntimeMessageReceipts.RuntimeMessageAdmission),
  request("thread.message-replay", RuntimeMessageReceipts.RuntimeMessageIdentity),
  request("thread.message-launch", RuntimeMessageReceipts.RuntimeMessageIdentity),
  request("thread.message-stage", RuntimeMessageReceipts.RuntimeMessageLaunchStage),
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
      images: Schema.optional(Schema.Array(PromptImage)),
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
    "background.stop",
    Schema.Struct({
      threadId: ThreadId,
      commandId: CommandId,
      taskIds: OrchestrationV2BackgroundTaskIds,
    }),
  ),
  request(
    "background.output",
    Schema.Struct({ threadId: ThreadId, taskId: Schema.String.check(Schema.isMinLength(1)) }),
  ),
  request(
    "tasks.cancel",
    Schema.Struct({
      threadId: ThreadId,
      taskId: NodeId,
      commandId: CommandId,
      reason: Schema.optional(Schema.String),
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
  request("attachments.import", ImportChatAttachmentsInput),
  request(
    "thread.send",
    Schema.Struct({
      threadId: ThreadId,
      commandId: CommandId,
      messageId: MessageId,
      text: Schema.String,
      attachments: Schema.Array(ChatAttachment),
      context: Schema.optional(OrchestrationMessageContext),
      interactionMode: Schema.optional(ProviderInteractionMode),
      modelSelection: Schema.optional(ModelSelection),
      mode: Schema.Literals(["auto", "queue", "steer", "restart"]),
      createdBy: Schema.Literals(["user", "agent"]),
      senderThreadId: Schema.optional(ThreadId),
      senderRunId: Schema.optional(Schema.NullOr(RunId)),
      modeLimit: Schema.optional(DispatchModeLimitSchema),
    }),
  ),
  request("thread.read", Schema.Struct({ threadId: ThreadId })),
  request(
    "thread.control",
    Schema.Struct({
      threadId: ThreadId,
      runId: Schema.optional(RunId),
      requestId: Schema.optional(RuntimeRequestId),
    }),
  ),
  request(
    "thread.execution",
    Schema.Struct({
      threadId: ThreadId,
      runId: Schema.optional(Schema.NullOr(RunId)),
      messageId: Schema.optional(MessageId),
    }),
  ),
  request(
    "thread.execution.wait",
    Schema.Struct({
      threadId: ThreadId,
      runId: Schema.NullOr(RunId),
      afterRevision: Schema.String,
      timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30000 })),
    }),
  ),
  request(
    "thread.fork-source",
    Schema.Struct({ threadId: ThreadId, runId: Schema.optional(RunId) }),
  ),
  request("thread.side-chat-save-source", Schema.Struct({ threadId: ThreadId })),
  request(
    "providers.read",
    Schema.Struct({
      refresh: Schema.optional(Schema.Boolean),
      instanceIds: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  request("providers.logout", Schema.Struct({ instanceIds: Schema.Array(ProviderInstanceId) })),
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
  request(
    "run.outcome",
    Schema.Union([
      Schema.Struct({
        threadId: ThreadId,
        messageId: MessageId,
        runId: Schema.optionalKey(Schema.Never),
      }),
      Schema.Struct({
        threadId: ThreadId,
        runId: RunId,
        messageId: Schema.optionalKey(Schema.Never),
      }),
    ]),
  ),
  request(
    "command.dispatch",
    Schema.Struct({
      command: OrchestrationV2Command,
      modeLimit: Schema.optional(DispatchModeLimitSchema),
    }),
  ),
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
  request("thread.opening-request", Schema.Struct({ threadId: ThreadId })),
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
  request("thread.prompt-index", Schema.Struct({ threadId: ThreadId })),
  request(
    "thread.acknowledge-read",
    Schema.Struct({
      callerThreadId: ThreadId,
      callerRunId: RunId,
      threadId: ThreadId,
      items: Schema.Array(
        Schema.Struct({
          itemId: TurnItemId,
          sourceThreadId: ThreadId,
          format: Schema.Literals(["text", "json"]),
          contentVersion: Schema.String.check(Schema.isMinLength(43), Schema.isMaxLength(43)),
          offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          length: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          totalChars: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      ).check(Schema.isMaxLength(100)),
    }),
  ),
  request("thread.progress", Schema.Struct({ threadId: ThreadId, runId: Schema.optional(RunId) })),
  request(
    "thread.read-details",
    Schema.Struct({
      threadId: ThreadId,
      runLimit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
      beforeOrdinal: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    }),
  ),
  request(
    "thread.timeline",
    Schema.Struct({
      threadId: ThreadId,
      beforeItem: Schema.optional(
        Schema.Struct({ sourceThreadId: ThreadId, sourceItemId: TurnItemId }),
      ),
      afterItem: Schema.optional(
        Schema.Struct({ sourceThreadId: ThreadId, sourceItemId: TurnItemId }),
      ),
      order: Schema.optional(Schema.Literals(["oldest_first", "newest_first"])),
      view: Schema.optional(Schema.Literals(["messages", "activity"])),
      limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
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
      attachmentId: Schema.Union([
        ChatAttachmentId,
        Schema.String.check(Schema.isPattern(/^tool-result:(0|[1-9]\d*)$/)),
      ]),
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
    "thread.item.content",
    Schema.Struct({
      threadId: ThreadId,
      itemId: TurnItemId,
      runId: Schema.optional(Schema.NullOr(RunId)),
      sourceThreadId: Schema.optional(ThreadId),
      format: Schema.optional(Schema.Literals(["text", "json"])),
      textOffset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      maxChars: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 256 * 1024 })),
      ),
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
    "sessions.search",
    Schema.Struct({
      query: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
      threadIds: Schema.optional(Schema.Array(ThreadId).check(Schema.isMaxLength(100))),
      cursor: Schema.optional(Schema.String),
      limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    }),
  ),
  request(
    "sessions.search-resolve",
    Schema.Struct({
      query: Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
      references: Schema.Array(
        Schema.Struct({
          threadId: ThreadId,
          itemId: TurnItemId,
          messageId: MessageId,
          contentVersion: Schema.String.check(Schema.isMinLength(43), Schema.isMaxLength(43)),
        }),
      ).check(Schema.isMaxLength(50)),
    }),
  ),
  request(
    "sessions.metadata",
    Schema.Struct({ threadIds: Schema.Array(ThreadId).check(Schema.isMaxLength(100)) }),
  ),
  request(
    "sessions.catalog",
    Schema.Struct({
      includeSubagents: Schema.optional(Schema.Boolean),
      cursor: Schema.optional(Schema.String),
      query: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
      limit: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: SESSION_CATALOG_MAX_LIMIT })),
      ),
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
  Schema.toCodecJson(
    Schema.NullOr(
      OrchestrationV2ThreadShell.mapFields((fields) => ({
        ...fields,
        providerDriver: Schema.NullOr(Schema.String),
      })),
    ),
  ),
);
const encodeSnapshotJson = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadStreamItem));
const encodeSnapshot = (snapshot: OrchestrationV2ThreadStreamItem) =>
  encodeSnapshotJson(snapshot).pipe(
    Effect.flatMap((encoded) => Effect.try(() => assertPublicWirePayloadBudget(encoded))),
  );
const encodeHistory = Schema.encodeEffect(Schema.toCodecJson(OrchestrationV2ThreadHistoryPage));
const encodeItem = Schema.encodeEffect(Schema.toCodecJson(Schema.NullOr(OrchestrationV2TurnItem)));
const encodeTimeline = Schema.encodeEffect(
  Schema.toCodecJson(
    Schema.Struct({
      items: Schema.Array(
        OrchestrationV2ProjectedTurnItem.mapFields((fields) => ({
          ...fields,
          metadata: Schema.optional(
            Schema.Struct({
              messageId: Schema.NullOr(Schema.String),
              createdBy: Schema.NullOr(Schema.Literals(["user", "agent", "system"])),
              creationSource: Schema.NullOr(Schema.String),
              senderThreadId: Schema.NullOr(Schema.String),
              title: Schema.NullOr(Schema.String),
            }),
          ),
          item: Schema.Struct({
            id: TurnItemId,
            runId: Schema.NullOr(RunId),
            type: Schema.Literals(
              OrchestrationV2TurnItem.members.map((member) => member.fields.type.literal),
            ),
            status: OrchestrationV2TurnItem.members[0].fields.status,
            updatedAt: OrchestrationV2TurnItem.members[0].fields.updatedAt,
          }),
        })),
      ),
      totalItems: Schema.Int,
      hasMore: Schema.Boolean,
      anchorFound: Schema.Boolean,
    }),
  ),
);
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
  const providerSessions = yield* ProviderSessionManagerV2;
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
  const instances = yield* ProviderInstanceRegistry;
  const providerConfiguration = yield* ProviderConfiguration.make(
    yield* Schema.decodeUnknownEffect(ProviderInstanceConfigMap)(initialProviders),
  );
  // SQL waiters cannot delay interruption of the lease fiber that releases their connection.
  const processScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
  const storageSnapshot = yield* StorageSnapshot.make(identity, providerConfiguration).pipe(
    Effect.provideService(Scope.Scope, processScope),
  );
  const acp = yield* AcpManagement.make(storageSnapshot.withWriter, identity.runtimeGeneration);
  const providerPolicy = yield* ProviderConfiguration.ProviderPolicy;
  const sessionMetadataOptions = {
    shell: (threadId: string) => projections.getThreadShell(ThreadId.make(threadId)),
    providerDriver: (instanceId: string) =>
      Effect.gen(function* () {
        const id = ProviderInstanceId.make(instanceId);
        const instance = yield* instances.getInstance(id);
        return instance?.driverKind ?? (yield* providerPolicy.current)[id]?.driver ?? null;
      }),
  };
  const textGeneration = yield* TextGeneration;
  const nativeInteraction = yield* NativeInteraction.make(identity.runtimeGeneration, notify).pipe(
    Effect.provide(NativeRuntimePolicy.layerFromProjectStore),
  );
  const executionLocation = yield* ExecutionLocation.make;
  const importNative = yield* NativeImport.make;
  const findNativeImports = yield* NativeImport.makeFind;
  const nativeMessageReceipts = yield* NativeMessageReceipts.make;
  const runtimeMessageReceipts = yield* RuntimeMessageReceipts.make;
  const taskReads = yield* OrchestratorMcp.make;
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
      case "thread.message-admit":
        return yield* runtimeMessageReceipts.admit(input.input);
      case "thread.message-replay":
        return yield* runtimeMessageReceipts.replay(input.input);
      case "thread.message-launch":
        return yield* runtimeMessageReceipts.launch(input.input);
      case "thread.message-stage":
        return yield* runtimeMessageReceipts
          .stage(input.input)
          .pipe(
            Effect.provideService(Configuration.ServerConfig, configuration),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
      case "acp.activity":
      case "acp.registry.search":
      case "acp.install.preview":
      case "acp.inspect":
      case "acp.install.start":
      case "acp.registry.uninstall":
      case "acp.connection.start":
      case "acp.operation.read":
      case "acp.operation.cancel":
      case "acp.auth.read":
      case "acp.auth.start":
      case "acp.auth.respond":
      case "acp.auth.complete":
      case "acp.auth.cancel":
      case "acp.auth.logout":
      case "acp.urlAuth.accept":
      case "acp.sessions.list":
      case "acp.sessions.prepareImport":
      case "acp.sessions.import":
      case "acp.sessions.delete":
      case "acp.modelProviders.list":
      case "acp.modelProviders.set":
      case "acp.modelProviders.disable":
        return yield* acp.execute(input);
      case "thread.import-native":
        return yield* importNative(input.input);
      case "native-imports.find":
        return yield* findNativeImports(input.input);
      case "native-message.receipt":
        return yield* nativeMessageReceipts.lookup(input.input);
      case "native-message.reserve":
        return yield* nativeMessageReceipts.reserve(input.input);
      case "native-message.settle":
        return yield* nativeMessageReceipts.settle(input.input);
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
        return yield* projections.getRunOutcome(input.input);
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
      case "thread.opening-request":
        return yield* projections
          .getOpeningRequest(input.input.threadId)
          .pipe(Effect.flatMap(encodeQueuedMessage));
      case "background.stop":
        return yield* threads.stopBackgroundWork(input.input);
      case "background.output":
        return yield* threads.backgroundOutput(input.input);
      case "tasks.cancel":
        return yield* threads.cancelDelegatedTask(input.input);
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
      case "thread.send": {
        const shell = yield* orchestrator.getThreadShell(input.input.threadId);
        if (!shell) return yield* Effect.fail(new Error("Target execution is unavailable"));
        const request = input.input;
        const result = yield* threads
          .sendToThread({
            projectId: shell.projectId,
            commandId: request.commandId,
            threadId: request.threadId,
            messageId: request.messageId,
            text: request.text,
            attachments: request.attachments,
            mode: request.mode,
            ...(request.context === undefined ? {} : { context: request.context }),
            ...(request.interactionMode === undefined
              ? {}
              : { interactionMode: request.interactionMode }),
            ...(request.modelSelection === undefined
              ? {}
              : { modelSelection: request.modelSelection }),
            ...(request.senderThreadId === undefined
              ? {}
              : { senderThreadId: request.senderThreadId }),
            ...(request.senderRunId === undefined ? {} : { senderRunId: request.senderRunId }),
            createdBy: request.createdBy,
            creationSource: request.createdBy === "agent" ? "mcp" : "web",
          })
          .pipe(Effect.provideService(DispatchModeLimit, request.modeLimit));
        return {
          messageId: result.message.id,
          runId: result.run.id,
          status: result.run.status,
          delivery: result.delivery,
          ...(result.run.delegatedTaskId === undefined
            ? {}
            : { taskId: result.run.delegatedTaskId }),
        };
      }
      case "attachments.import": {
        const shell = yield* orchestrator.getThreadShell(input.input.threadId);
        if (!shell)
          return yield* Effect.fail(new Error("Attachment target execution is unavailable"));
        const attachments = yield* importChatAttachments(input.input).pipe(
          Effect.provideService(Configuration.ServerConfig, configuration),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        return yield* encodeAttachments({ attachments });
      }
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
      case "text.generate-structured": {
        const target = (yield* providerPolicy.admission)[input.input.modelSelection.instanceId];
        if (!target || target.enabled === false)
          return yield* Effect.fail(
            new Error("This Agent is disabled. Enable it before starting a utility request."),
          );
        if (!textGeneration.generateStructured)
          return yield* Effect.fail(new Error("Structured generation is unavailable"));
        return yield* textGeneration.generateStructured(input.input);
      }
      case "thread.read": {
        const thread = yield* orchestrator.getThreadShell(input.input.threadId);
        if (thread === null) return null;
        const instance = yield* instances.getInstance(
          ProviderInstanceId.make(thread.providerInstanceId),
        );
        const configured = yield* providerPolicy.current;
        return yield* encodeThreadShell({
          ...thread,
          providerDriver:
            instance?.driverKind ?? configured[thread.providerInstanceId]?.driver ?? null,
        });
      }
      case "providers.read": {
        const named = input.input.instanceIds;
        return yield* (
          input.input.refresh
            ? named
              ? Effect.forEach(
                  named,
                  (instanceId) =>
                    providers.refreshInstance(instanceId as ProviderInstanceId, { fresh: true }),
                  { concurrency: "unbounded", discard: true },
                ).pipe(Effect.andThen(providers.getProviders))
              : providers.refresh()
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
      case "providers.logout": {
        const named = input.input.instanceIds;
        // One at a time: profiles that share a config directory share one sign-in.
        for (const instanceId of named) {
          const instance = yield* instances.getInstance(instanceId);
          if (!instance?.signOut)
            return yield* Effect.fail(new Error("This Agent cannot be signed out in Nodex."));
          yield* instance.signOut.pipe(Effect.mapError((error) => new Error(error.detail)));
        }
        return yield* providers.getCheckedProvidersFor(named).pipe(Effect.flatMap(encodeProviders));
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
        const result = yield* threads
          .dispatch(input.input.command)
          .pipe(Effect.provideService(DispatchModeLimit, input.input.modeLimit));
        if (input.input.command.type === "thread.delete")
          yield* providerSessions.discardSideChatNative(input.input.command.threadId);
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
      case "thread.side-chat-save-source":
        return yield* orchestrator.getSideChatSaveSource(input.input.threadId);
      case "thread.control":
      case "thread.snapshot": {
        const snapshot = yield* orchestrator.getThreadSnapshotWindow(input.input.threadId, {
          rowLimit: input.method === "thread.control" ? 0 : THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          controlOnly: input.method === "thread.control",
          requiredRunId: input.method === "thread.control" ? input.input.runId : undefined,
          requiredRequestId: input.method === "thread.control" ? input.input.requestId : undefined,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
        return yield* encodeSnapshot(
          buildBoundedThreadStreamSnapshot({
            ...snapshot,
            compactTurnItems: true,
            requiredRunId: input.method === "thread.control" ? input.input.runId : undefined,
            requiredRequestId:
              input.method === "thread.control" ? input.input.requestId : undefined,
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
      case "thread.prompt-index":
        return yield* projections.getThreadPromptIndex(input.input.threadId);
      case "thread.read-details":
        return yield* readSessionDetails(
          input.input.threadId,
          input.input.runLimit,
          input.input.beforeOrdinal,
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql));
      case "thread.timeline":
        return yield* projections
          .getTimelineMetadataPage(input.input.threadId, {
            limit: input.input.limit,
            ...(input.input.beforeItem === undefined ? {} : { beforeItem: input.input.beforeItem }),
            ...(input.input.afterItem === undefined ? {} : { afterItem: input.input.afterItem }),
            ...(input.input.order === undefined ? {} : { order: input.input.order }),
            ...(input.input.view === undefined ? {} : { view: input.input.view }),
          })
          .pipe(Effect.flatMap(encodeTimeline));
      case "thread.execution":
        return yield* readExecution(input.input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      case "thread.execution.wait":
        return yield* waitExecution(input.input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.provideService(Orchestrator.OrchestratorV2, orchestrator),
          Effect.provideService(EffectOutboxV2, effectOutbox),
        );
      case "thread.progress": {
        const scoped =
          input.input.runId === undefined
            ? undefined
            : yield* readExecutionItemIds(input.input.threadId, input.input.runId).pipe(
                Effect.provideService(SqlClient.SqlClient, sql),
              );
        const selectedReply = scoped?.replyId
          ? yield* projections.getVisibleTurnItem({
              threadId: input.input.threadId,
              itemId: TurnItemId.make(scoped.replyId),
            })
          : null;
        const replies = scoped
          ? {
              items: selectedReply
                ? [
                    {
                      sourceItemId: selectedReply.id,
                      sourceThreadId: input.input.threadId,
                      item: selectedReply,
                    },
                  ]
                : [],
            }
          : yield* projections.getTimelinePage(input.input.threadId, {
              itemTypes: ["assistant_message"],
              view: "activity",
              order: "newest_first",
              limit: 1,
            });
        const activities = scoped
          ? {
              items: scoped.activity
                ? [
                    {
                      sourceItemId: scoped.activity.turn_item_id,
                      sourceThreadId: input.input.threadId,
                      item: {
                        runId: input.input.runId!,
                        type: scoped.activity.type,
                        status: scoped.activity.status,
                        updatedAt: DateTime.makeUnsafe(scoped.activity.updated_at),
                      },
                    },
                  ]
                : [],
            }
          : yield* projections.getTimelineMetadataPage(input.input.threadId, {
              itemTypes: OrchestrationV2TurnItem.members
                .map((member) => member.fields.type.literal)
                .filter(
                  (type) => !["user_message", "assistant_message", "reasoning"].includes(type),
                ),
              view: "activity",
              order: "newest_first",
              limit: 1,
            });
        const reply = replies.items[0];
        const activity = activities.items[0];
        const text = reply === undefined ? "" : (turnItemText(reply.item) ?? "");
        const end = Math.min(text.length, 1024);
        return {
          latestReply:
            reply === undefined
              ? null
              : {
                  itemId: reply.sourceItemId,
                  sourceThreadId: reply.sourceThreadId,
                  runId: reply.item.runId,
                  type: reply.item.type,
                  status: reply.item.status,
                  updatedAt: DateTime.formatIso(reply.item.updatedAt),
                  contentVersion: createHash("sha256").update(text).digest("base64url"),
                  format: "text" as const,
                  text: text.slice(0, end),
                  textOffset: 0,
                  totalChars: text.length,
                  nextTextOffset: end < text.length ? end : null,
                },
          latestActivity:
            activity === undefined
              ? null
              : {
                  itemId: activity.sourceItemId,
                  sourceThreadId: activity.sourceThreadId,
                  runId: activity.item.runId,
                  type: activity.item.type,
                  status: activity.item.status,
                  updatedAt: DateTime.formatIso(activity.item.updatedAt),
                },
        };
      }
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
      case "thread.acknowledge-read": {
        const actor = yield* readAuthority({
          threadId: input.input.callerThreadId,
          runId: input.input.callerRunId,
        });
        if (!actor) return { acknowledged: 0 };
        return yield* taskReads.acknowledgeRead(
          {
            environmentId: EnvironmentId.make(identity.runtimeId),
            capabilities: new Set(["orchestration"]),
            issuedAt: actor.admittedAtMs,
            requestNamespace: `session-read:${actor.threadId}:${actor.runId}`,
            thread: {
              threadId: input.input.callerThreadId,
              providerSessionId: actor.providerSessionId,
              providerInstanceId: ProviderInstanceId.make(actor.providerInstanceId),
            },
            client: undefined,
          },
          {
            threadId: input.input.threadId,
            callerRunId: input.input.callerRunId,
            items: input.input.items,
          },
        );
      }
      case "thread.item.content": {
        const record = yield* projections.getVisibleTurnItemRecord({
          threadId: input.input.threadId,
          itemId: input.input.itemId,
          ...(input.input.sourceThreadId === undefined
            ? {}
            : { sourceThreadId: input.input.sourceThreadId }),
        });
        if (
          record === null ||
          (input.input.runId !== undefined && record.item.runId !== input.input.runId)
        )
          return null;
        return yield* runtimeHistoryContent(record, {
          format: input.input.format ?? "text",
          offset: input.input.textOffset ?? 0,
          maxChars: input.input.maxChars ?? 16_384,
        });
      }
      case "sessions.search":
        return yield* readSessionSearch(input.input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      case "sessions.search-resolve":
        return yield* resolveSessionSearch(input.input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      case "sessions.metadata":
        return yield* readSessionMetadata(input.input.threadIds, sessionMetadataOptions).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      case "sessions.catalog":
        return yield* readSessionCatalog(input.input, sessionMetadataOptions).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
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
      case "acp.activity":
      case "acp.registry.search":
      case "acp.install.preview":
      case "acp.inspect":
      case "acp.operation.read":
      case "acp.operation.cancel":
      case "acp.auth.read":
      case "acp.auth.respond":
      case "acp.auth.cancel":
      case "acp.urlAuth.accept":
      case "storage.snapshot.acquire":
      case "storage.snapshot.release":
      case "thread.read":
      case "background.output":
      case "tasks.overview":
      case "native-session.authority":
      case "thread.authority":
      case "project.read":
      case "project.activity":
      case "project.roots":
      case "thread.queue":
      case "thread.run-message":
      case "thread.opening-request":
      case "thread.message-replay":
      case "thread.message-launch":
      case "native-message.receipt":
      case "thread.queued-preview":
      case "shell.read":
      case "thread.snapshot":
      case "thread.control":
      case "thread.fork-source":
      case "thread.side-chat-save-source":
      case "run.outcome":
      case "thread.history":
      case "thread.timeline":
      case "thread.progress":
      case "thread.execution":
      case "thread.execution.wait":
      case "thread.read-details":
      case "thread.prompt-index":
      case "thread.item":
      case "thread.item.full":
      case "thread.item.content":
      case "thread.attachment":
      case "events.observe":
      case "execution.observe":
      case "execution.activity":
      case "sessions.catalog":
      case "sessions.metadata":
      case "sessions.search":
      case "sessions.search-resolve":
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
