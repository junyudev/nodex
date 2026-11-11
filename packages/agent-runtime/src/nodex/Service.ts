import { canAdvanceReadback } from "../orchestration-v2/RunReadback.ts";
import * as SessionPause from "./SessionPause.ts";
import type { AgentRuntimeOperations } from "./Interface.ts";
import { RuntimeModelPolicy, executionProviders } from "./ModelPolicy.ts";
import {
  isModelOn,
  spendsNodexCredit,
  type ModelPolicy,
} from "../../../../src/shared/model-policy.ts";
import { withSupportedRuntimeModes } from "./ProviderRuntimeModes.ts";
import { CodexAppServerClientFactory } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { WINDOWS_SANDBOX_NOT_APPLICABLE } from "../provider/CodexWindowsSandbox.ts";
import { pendingUserQuestionIds } from "./PendingUserQuestions.ts";
import * as SessionStop from "./SessionStop.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import {
  ImportChatAttachmentsInput,
  importChatAttachments,
} from "../assets/ImportChatAttachments.ts";
import { ChatAttachment } from "@nodex/runtime-contracts";
import { runtimeHistoryContent } from "./RuntimeHistoryContent.ts";
import * as OrchestratorMcp from "../mcp/OrchestratorMcpService.ts";
import { EnvironmentId } from "@nodex/runtime-contracts";
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
  ProviderSessionId,
  OrchestrationV2Subagent,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionLocation,
} from "@nodex/runtime-contracts";
import * as UsageLedger from "../usage/UsageLedger.ts";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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
import { threadCreatedAnalytics } from "./ExecutionAnalytics.ts";
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
  SubagentOverviewAttention,
  type ProjectionSubagentOverviewItem,
} from "../orchestration-v2/ProjectionStore.ts";
import * as Projects from "../project/ProjectService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import { readExecution, waitExecution, readExecutionItemIds } from "./ExecutionRead.ts";
import { EffectOutboxV2 } from "../orchestration-v2/EffectOutbox.ts";
import { readDesktopToolSkills } from "../desktopTools/Skills.ts";
import { HostBridge } from "./HostBridge.ts";
import * as Authority from "./Authority.ts";
import * as NativeInteraction from "./NativeInteraction.ts";
import * as ExecutionLocation from "./ExecutionLocation.ts";
import * as NativeImport from "./NativeImport.ts";
import * as SessionQueue from "./SessionQueue.ts";
import * as SessionControlReceipts from "./SessionControlReceipts.ts";
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
  readActivityRootIds,
} from "../orchestration-v2/ExecutionActivity.ts";
import {
  SESSION_CATALOG_MAX_LIMIT,
  readSessionCatalog,
} from "../orchestration-v2/SessionCatalog.ts";
import * as SqlClient from "effect/sql/SqlClient";
import * as RunAdmission from "../orchestration-v2/RunAdmission.ts";
import { readSessionDetails } from "../orchestration-v2/SessionReadDetails.ts";
import { readSessionMetadata } from "../orchestration-v2/SessionMetadata.ts";
import { readSessionSearch, resolveSessionSearch } from "../orchestration-v2/SessionSearch.ts";
import * as Duration from "effect/Duration";
import { rollbackThread } from "./Rollback.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as IdAllocator from "@nodex/provider-core/server/IdAllocator";
import * as Providers from "../provider/ProviderRegistry.ts";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import * as Configuration from "../config.ts";
import { persistChatAttachments } from "../assets/PersistChatAttachments.ts";
import * as ProviderConfiguration from "./ProviderConfiguration.ts";
import * as ExecutionRoots from "./ExecutionRoots.ts";
import * as StoreCoordinate from "./StoreCoordinate.ts";
import * as AcpManagement from "./AcpManagement.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import { buildBoundedThreadStreamSnapshot } from "../orchestration-v2/ThreadStream.ts";
import {
  projectStoredEventForWire,
  assertPublicWirePayloadBudget,
  projectTurnItemForDetail,
} from "../orchestration-v2/WireProjection.ts";
import { withToolResultImages } from "../orchestration-v2/toolResultImages.ts";
import {
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
  threadHistoryPositionCursor,
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
  request("execution.roots", ExecutionRoots.Input),
  request("execution.workspace-in-use", ExecutionRoots.WorkspaceInUseInput),
  request(
    "insights.read",
    Schema.Struct({
      timeZone: Schema.String.check(Schema.isMaxLength(128)),
      origin: Schema.Literals(["all", "nodex"]),
      sources: Schema.Array(
        Schema.Struct({
          provider: Schema.Literals(["claude", "codex"]),
          home: Schema.String,
          origin: Schema.Literals(["nodex", "external"]),
        }),
      ).check(Schema.isMaxLength(64)),
    }),
  ),
  request("insights.access", Schema.Struct({ granted: Schema.Boolean })),
  request("store.coordinate.read", Schema.Struct({})),
  request("store.coordinate.record", Schema.Struct({ coordinate: Schema.String })),
  request("thread.import-native", NativeImport.NativeImportInput),
  request("native-imports.find", NativeImport.NativeImportsFindInput),
  request("thread.pause", Schema.Struct({ threadId: ThreadId, revision: Schema.String })),
  request("thread.resume", Schema.Struct({ threadId: ThreadId })),
  request("thread.queue-control", SessionQueue.SessionQueueInput),
  request("session-control.receipt", SessionControlReceipts.SessionControlReceiptInput),
  request(
    "thread.stop",
    Schema.Struct({
      threadId: ThreadId,
      commandId: CommandId,
      reason: Schema.optional(Schema.String),
      modeLimit: Schema.optional(DispatchModeLimitSchema),
    }),
  ),
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
      webSearch: Schema.optional(Schema.Boolean),
    }),
  ),
  request(
    "background.stop",
    Schema.Struct({
      threadId: ThreadId,
      commandId: CommandId,
      taskIds: OrchestrationV2BackgroundTaskIds,
      runId: Schema.optional(RunId),
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
      runId: Schema.optional(RunId),
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
  request(
    "models.assert",
    Schema.Struct({
      modelSelection: ModelSelection,
      origin: Schema.Literals(["person", "nodex-agent", "agent", "automatic"]),
      caller: Schema.optional(
        Schema.Struct({
          threadId: Schema.String,
          runId: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    }),
  ),
  request("models.running-credit", Schema.Struct({})),
  request(
    "providers.configure",
    Schema.Struct({
      providers: ProviderInstanceConfigMap,
      automaticWorkAtOnce: Schema.optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
      ),
      modelPolicy: Schema.optional(Schema.Unknown),
    }),
  ),
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
      createdBy: Schema.Literals(["user", "agent", "system"]),
      senderThreadId: Schema.optional(ThreadId),
      senderRunId: Schema.optional(Schema.NullOr(RunId)),
      modeLimit: Schema.optional(DispatchModeLimitSchema),
    }),
  ),
  request("thread.stop-host-input", Schema.Struct({ threadId: ThreadId, messageId: MessageId })),
  request("thread.read", Schema.Struct({ threadId: ThreadId })),
  request("thread.questions.list", Schema.Struct({ threadId: ThreadId })),
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
  request(
    "providers.read",
    Schema.Struct({
      refresh: Schema.optional(Schema.Boolean),
      instanceIds: Schema.optional(Schema.Array(Schema.String)),
    }),
  ),
  request(
    "providers.skills.read",
    Schema.Struct({
      instanceId: ProviderInstanceId,
      cwd: Schema.NullOr(Schema.String),
      composer: Schema.optional(Schema.Boolean),
    }),
  ),
  request("providers.logout", Schema.Struct({ instanceIds: Schema.Array(ProviderInstanceId) })),
  request(
    "providers.windows-sandbox.read",
    Schema.Struct({
      instanceId: ProviderInstanceId,
      refresh: Schema.optional(Schema.Boolean),
    }),
  ),
  request(
    "providers.windows-sandbox.setup",
    Schema.Struct({
      instanceId: ProviderInstanceId,
      mode: Schema.Literals(["elevated", "unelevated"]),
    }),
  ),
  request(
    "providers.windows-sandbox.cancel",
    Schema.Struct({
      instanceId: ProviderInstanceId,
      generation: Schema.String,
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
  request(
    "thread.compact",
    Schema.Struct({
      threadId: ThreadId,
      requestId: CommandId,
      failedRunId: Schema.optional(RunId),
    }),
  ),
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
  request("thread.message-turn", Schema.Struct({ threadId: ThreadId, messageId: MessageId })),
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
      cursor: Schema.Union([
        Schema.String,
        Schema.Struct({
          type: Schema.Literal("item"),
          sourceThreadId: Schema.String,
          sourceItemId: Schema.String,
          ordinal: Schema.optional(Schema.Int),
        }),
      ]),
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
      runId: Schema.optional(RunId),
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
    "thread.message-attachment",
    Schema.Struct({ threadId: ThreadId, messageId: MessageId, attachmentId: ChatAttachmentId }),
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
const encodeProviderSnapshots = Schema.encodeEffect(
  Schema.toCodecJson(Schema.Array(ServerProvider)),
);
const encodeProviders = (providers: readonly ServerProvider[]) =>
  encodeProviderSnapshots(providers.map(withSupportedRuntimeModes));
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
  recovery: overviewFields.recovery,
  status: overviewFields.status,
  startedAt: overviewFields.startedAt,
  completedAt: overviewFields.completedAt,
  updatedAt: overviewFields.updatedAt,
  childRunId: Schema.NullOr(RunId),
  resultAvailable: Schema.Boolean,
  attention: SubagentOverviewAttention,
});
// Encoding drops fields the served schema omits; every projected overview field must be served.
type UnservedOverviewFields = Exclude<
  keyof ProjectionSubagentOverviewItem,
  keyof typeof OverviewItem.fields
>;
const overviewServesEveryField: [UnservedOverviewFields] extends [never]
  ? true
  : UnservedOverviewFields = true;
void overviewServesEveryField;
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
  // Execution ancestry and captured side-chat sources never change.
  const roots = new Map<string, readonly string[]>();
  const activityRootsOf = Effect.fnUntraced(function* (threadId: ThreadId) {
    const known = roots.get(threadId);
    if (known !== undefined) return known;
    const affected = yield* readActivityRootIds(threadId).pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    );
    if (roots.size >= 4096) roots.delete(roots.keys().next().value!);
    roots.set(threadId, affected);
    return affected;
  });
  const projects = yield* Projects.ProjectService;
  const projections = yield* ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const identity = yield* readIdentity;
  const effectOutbox = yield* EffectOutboxV2;
  const providers = yield* Providers.ProviderRegistry;
  const host = yield* HostBridge;
  const codexClients = yield* CodexAppServerClientFactory;
  const instances = yield* ProviderInstanceRegistry;
  const modelPolicy = yield* RuntimeModelPolicy;
  const providerConfiguration = yield* ProviderConfiguration.make(
    executionProviders(
      (yield* modelPolicy.current).policy,
      yield* Schema.decodeUnknownEffect(ProviderInstanceConfigMap)(initialProviders),
    ),
  );
  const processScope = yield* Scope.make("parallel");
  yield* Effect.addFinalizer((exit) => Scope.close(processScope, exit));
  const usageLedger = yield* UsageLedger.make({
    stateDir: (yield* Configuration.ServerConfig).stateDir,
    scope: processScope,
  }).pipe(Effect.provide(FetchHttpClient.layer));
  const acp = yield* AcpManagement.make(identity.runtimeGeneration);
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
  // Only Threads started from now on count, so observation begins at the current sequence.
  yield* orchestrator
    .streamStoredEventsFrom({
      afterSequence: yield* eventSink.latestSequence(),
      eventType: "thread.created",
    })
    .pipe(
      Stream.runForEach(({ event }) =>
        Effect.gen(function* () {
          if (event.type !== "thread.created") return;
          const driver = yield* sessionMetadataOptions
            .providerDriver(event.payload.providerInstanceId)
            .pipe(Effect.orElseSucceed(() => null));
          const properties = threadCreatedAnalytics(event.payload, driver);
          if (properties !== null)
            yield* notify({ type: "product-analytics", name: "thread.created", properties });
        }),
      ),
      Effect.catchCause((cause) => Effect.logWarning("Thread analytics stopped", { cause })),
      Effect.forkIn(processScope),
    );
  const textGeneration = yield* TextGeneration;
  const nativeInteraction = yield* NativeInteraction.make(identity.runtimeGeneration, notify).pipe(
    Effect.provide(NativeRuntimePolicy.layerFromProjectStore),
  );
  const executionLocation = yield* ExecutionLocation.make;
  const importNative = yield* NativeImport.make;
  const findNativeImports = yield* NativeImport.makeFind;
  const sessionPause = yield* SessionPause.make;
  const sessionStop = yield* SessionStop.make;
  const sessionQueue = yield* SessionQueue.make;
  const sessionControlReceipt = yield* SessionControlReceipts.make;
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
      case "thread.queue-control":
        return yield* sessionQueue(input.input);
      case "session-control.receipt":
        return yield* sessionControlReceipt(input.input);
      case "thread.pause":
        return yield* sessionPause.pause(input.input);
      case "thread.resume":
        return yield* sessionPause.resume(input.input);
      case "thread.stop":
        return yield* sessionStop(input.input);
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
      case "thread.message-turn":
        return yield* projections.getMessageTurnOutcome(
          input.input.threadId,
          input.input.messageId,
        );
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
      case "execution.workspace-in-use":
        return yield* ExecutionRoots.workspaceInUse(input.input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      case "execution.roots":
        return yield* ExecutionRoots.read(input.input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      case "store.coordinate.read":
        return yield* StoreCoordinate.read.pipe(Effect.provideService(SqlClient.SqlClient, sql));
      case "store.coordinate.record":
        return yield* StoreCoordinate.record(input.input.coordinate).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
      case "models.assert": {
        const caller = input.input.caller;
        const records = caller
          ? yield* projections
              .getThreadRecords(ThreadId.make(caller.threadId), ["runs"], {
                runIds: caller.runId ? [RunId.make(caller.runId)] : [],
              })
              .pipe(Effect.catch(() => Effect.succeed(undefined)))
          : undefined;
        const selection = caller?.runId
          ? records?.runs.find((run) => run.id === caller.runId)?.modelSelection
          : records?.thread.modelSelection;
        const origin =
          caller && input.input.origin !== "automatic"
            ? yield* modelPolicy.origin(true, selection?.instanceId)
            : input.input.origin;
        yield* modelPolicy.assert(input.input.modelSelection, origin);
        return null;
      }
      case "models.running-credit": {
        const rows = yield* sql<{
          readonly thread_id: string;
          readonly payload_json: string;
        }>`SELECT thread_id, payload_json FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'starting', 'running', 'waiting')`;
        const result: AgentRuntimeOperations["models.running-credit"]["output"][number][] = [];
        for (const row of rows) {
          const run = JSON.parse(row.payload_json) as {
            modelSelection: { instanceId: string; model: string };
          };
          if (!spendsNodexCredit({ instanceId: run.modelSelection.instanceId, driver: "codex" }))
            continue;
          for (const rootThreadId of yield* activityRootsOf(ThreadId.make(row.thread_id)))
            result.push({ rootThreadId, threadId: row.thread_id, ...run.modelSelection });
        }
        // Native work can outlive its foreground Run. Include credit roots that
        // still report background activity, without inventing a second activity model.
        let cursor: string | undefined;
        do {
          const page = yield* readRootActivity({
            cursor,
            limit: EXECUTION_ACTIVITY_MAX_PAGE_LIMIT,
          }).pipe(Effect.provideService(SqlClient.SqlClient, sql));
          for (const item of page.items) {
            if (
              !spendsNodexCredit({ instanceId: item.providerInstanceId, driver: "codex" }) ||
              result.some(
                (run) => run.rootThreadId === item.rootThreadId && run.model === item.model,
              )
            )
              continue;
            result.push({
              rootThreadId: item.rootThreadId,
              threadId: item.rootThreadId,
              instanceId: item.providerInstanceId,
              model: item.model,
            });
          }
          cursor = page.nextCursor ?? undefined;
        } while (cursor !== undefined);
        return result;
      }
      case "providers.configure": {
        if (input.input.automaticWorkAtOnce !== undefined) {
          yield* RunAdmission.configure(input.input.automaticWorkAtOnce).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
          );
        }
        const before = yield* providerPolicy.current;
        const previousPolicy = yield* modelPolicy.current;
        const nextPolicy =
          (input.input.modelPolicy as ModelPolicy | undefined) ?? previousPolicy.policy;
        const wanted = executionProviders(nextPolicy, input.input.providers);
        // Close model admission before cancelling queues or releasing any credential-bearing process.
        yield* modelPolicy.replace({
          policy: nextPolicy,
          providers: { ...before, ...input.input.providers },
        });
        const retiring = Object.entries(before).filter(
          ([id, entry]) => entry.source === "nodex" && !wanted[id as ProviderInstanceId],
        );
        // Queue cancellation precedes native teardown: Stop alone holds queued work for later.
        if (retiring.length) yield* providerConfiguration.closeAdmission(wanted);
        for (const [id, declaration] of Object.entries(before).filter(
          ([id, entry]) =>
            entry.source === "nodex" &&
            (retiring.some(([retired]) => retired === id) ||
              JSON.stringify(previousPolicy.policy) !== JSON.stringify(nextPolicy)),
        )) {
          const active = yield* sql<{
            readonly run_id: string;
            readonly thread_id: string;
            readonly status: string;
            readonly payload_json: string;
          }>`
            SELECT run_id, thread_id, status, payload_json FROM orchestration_v2_projection_runs
            WHERE provider_instance_id = ${id} AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
          `;
          const affected = active.filter(
            (run) =>
              retiring.some(([retired]) => retired === id) ||
              !isModelOn(
                nextPolicy,
                { ...declaration, instanceId: id },
                (JSON.parse(run.payload_json) as { modelSelection: { model: string } })
                  .modelSelection.model,
              ),
          );
          for (const row of affected.filter((run) => run.status === "queued"))
            yield* orchestrator.dispatch({
              type: "queued-run.cancel-internal",
              commandId: CommandId.make(`nodex-retire:queue:${row.run_id}`),
              threadId: ThreadId.make(row.thread_id),
              runId: RunId.make(row.run_id),
            });
          for (const row of affected.filter((run) => run.status !== "queued"))
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make(`nodex-retire:active:${row.run_id}`),
              threadId: ThreadId.make(row.thread_id),
              reason: "Nodex model access changed",
            });
          const restricted = declaration.modelAllowlist?.some(
            (model) =>
              isModelOn(previousPolicy.policy, { ...declaration, instanceId: id }, model) &&
              !isModelOn(nextPolicy, { ...declaration, instanceId: id }, model),
          );
          // Claude captures managed restrictions per process. Retire its existing queries so an
          // allowed parent cannot keep an old native child/helper policy after this update.
          if (
            retiring.some(([retired]) => retired === id) ||
            (restricted && declaration.driver === "claudeAgent")
          ) {
            yield* providerSessions.closeInstance(ProviderInstanceId.make(id));
            continue;
          }
          if (!restricted) continue;
          const nativeSessions = yield* sql<{
            readonly provider_session_id: string;
            readonly payload_json: string;
          }>`SELECT provider_session_id, payload_json FROM orchestration_v2_projection_provider_sessions WHERE provider_instance_id = ${id}`;
          for (const session of nativeSessions) {
            const model = (JSON.parse(session.payload_json) as { model: string | null }).model;
            if (model && !isModelOn(nextPolicy, { ...declaration, instanceId: id }, model))
              yield* providerSessions.close(ProviderSessionId.make(session.provider_session_id));
          }
        }
        const configured = yield* providerConfiguration.configure(wanted);
        if (input.input.automaticWorkAtOnce !== undefined) yield* effectOutbox.notifyAvailable(16);
        return configured;
      }
      case "thread.stop-host-input": {
        const { threadId, messageId } = input.input;
        const read = projections.getRunOutcome({ threadId, messageId });
        let run = yield* read;
        if (!run) return null;
        const message = yield* projections.getRunUserMessage(threadId, run.runId);
        if (message?.createdBy !== "system" || message.creationSource !== "server") return null;
        if (run.status === "queued") {
          const cancelled = yield* orchestrator
            .dispatch({
              type: "queued-run.cancel-internal",
              commandId: CommandId.make(`host-input:cancel:${run.runId}`),
              threadId,
              runId: run.runId,
            })
            .pipe(Effect.result);
          if (cancelled._tag === "Success") return null;
          // A queued Run can start between its lookup and cancellation.
          run = yield* read;
          if (run?.status === "queued") return yield* cancelled.failure;
        }
        if (
          run?.status !== "preparing" &&
          run?.status !== "starting" &&
          run?.status !== "running" &&
          run?.status !== "waiting"
        )
          return null;
        yield* orchestrator.dispatch({
          type: "run.interrupt",
          commandId: CommandId.make(`host-input:interrupt:${run.runId}`),
          threadId,
          runId: run.runId,
        });
        return null;
      }
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
            creationSource:
              request.createdBy === "system"
                ? "server"
                : request.createdBy === "agent"
                  ? "mcp"
                  : "web",
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
        yield* modelPolicy.assert(input.input.modelSelection, "person");
        const target = (yield* providerPolicy.admission)[input.input.modelSelection.instanceId];
        if (!target || target.enabled === false)
          return yield* Effect.fail(
            new Error("This Agent is disabled. Enable it before starting a utility request."),
          );
        if (
          target.modelAllowlist &&
          !target.modelAllowlist.includes(input.input.modelSelection.model)
        )
          return yield* Effect.fail(new Error("This model is unavailable from Nodex."));
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
      case "providers.windows-sandbox.read":
      case "providers.windows-sandbox.setup":
      case "providers.windows-sandbox.cancel": {
        const instance = yield* instances.getInstance(
          ProviderInstanceId.make(input.input.instanceId),
        );
        if (!instance?.enabled || instance.driverKind !== "codex")
          return WINDOWS_SANDBOX_NOT_APPLICABLE;
        const sandbox = codexClients.windowsSandbox;
        if (!sandbox) return WINDOWS_SANDBOX_NOT_APPLICABLE;
        if (input.method === "providers.windows-sandbox.setup")
          return yield* sandbox.setup(input.input.instanceId, input.input.mode);
        if (input.method === "providers.windows-sandbox.cancel")
          return yield* sandbox.cancel(input.input.instanceId, input.input.generation);
        return yield* sandbox.read(input.input.instanceId, input.input.refresh);
      }
      case "providers.skills.read": {
        const { instanceId, cwd, composer } = input.input;
        const instance = yield* instances.getInstance(instanceId);
        if (!instance?.enabled) return [];
        const { driverKind } = instance;
        const native = Effect.gen(function* () {
          if (cwd !== null) {
            if (instance.skillsForCwd) return (yield* instance.skillsForCwd(cwd)) ?? [];
            const workspace = yield* instance.snapshotForCwd?.(cwd) ?? Effect.succeed(null);
            if (workspace) return workspace.skills;
          }
          return composer ? (yield* instance.snapshot.getSnapshot).skills : [];
        });
        if (!composer)
          return ["codex", "claude", "opencode"].includes(driverKind) ? yield* native : [];
        if (driverKind === "codex") return [];
        const { skills, roots } = yield* Effect.all(
          {
            skills: native.pipe(
              Effect.catch(() =>
                Effect.map(instance.snapshot.getSnapshot, (snapshot) => snapshot.skills),
              ),
            ),
            roots: host.desktopSkillRoots(instanceId, driverKind),
          },
          { concurrency: "unbounded" },
        );
        const desktop = yield* Effect.promise(() => readDesktopToolSkills(roots));
        const paths = new Set(desktop.map((skill) => skill.path));
        return [
          ...skills.filter((skill) => !paths.has(skill.path)),
          ...desktop.map(({ iconPath, brandColor, ...skill }) => ({
            ...skill,
            enabled: true,
            desktopTool: {
              ...(iconPath ? { iconPath } : {}),
              ...(brandColor ? { brandColor } : {}),
            },
          })),
        ];
      }
      case "providers.read": {
        const policy = yield* providerPolicy.admission;
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
            all.flatMap((provider) => {
              const declaration = policy[provider.instanceId];
              if (!declaration || (named && !named.includes(provider.instanceId))) return [];
              if (declaration.source === "nodex" && declaration.enabled === false) return [];
              return [
                {
                  ...provider,
                  ...(declaration.source ? { source: declaration.source } : {}),
                  models: declaration.modelAllowlist
                    ? provider.models.filter((model) =>
                        declaration.modelAllowlist!.includes(model.slug),
                      )
                    : provider.models,
                },
              ];
            }),
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
        yield* modelPolicy.assert(
          (yield* orchestrator.getThreadProjection(input.input.threadId)).thread.modelSelection,
          "person",
        );
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
      case "thread.questions.list": {
        const projection = yield* projections.getThreadRecords(input.input.threadId, [
          "runtimeRequests",
        ]);
        return { requestIds: pendingUserQuestionIds(projection.runtimeRequests) };
      }
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
            threadHistoryPositionCursor(input.input.cursor),
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
          input.input.runId,
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
      case "thread.message-attachment":
        return yield* readThreadAttachment({
          threadId: input.input.threadId,
          itemId: IdAllocator.derive.userTurnItem({ messageId: input.input.messageId }),
          attachmentId: input.input.attachmentId,
        });
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
          .pipe(
            Effect.map((item) => (item === null ? null : withToolResultImages(item))),
            Effect.flatMap(encodeItem),
          );
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
      case "insights.read":
        return yield* usageLedger.read(input.input);
      case "insights.access":
        return yield* usageLedger.setAccess(input.input.granted);
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
          // A caller's own cursor can predate pruning; event.error makes it reload a snapshot.
          capturedCursor: input.input.afterSequence === undefined,
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
                "turn-item.updated",
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
              for (const root of yield* activityRootsOf(event.event.threadId))
                changedRoots.set(root, event.sequence);
            }
            // One compact change per root and burst; readers point-read the root's activity.
            for (const [rootThreadId, sequence] of changedRoots)
              yield* notify({ type: "activity", rootThreadId, sequence });
          });
        const consume: Effect.Effect<void, unknown> =
          input.method === "execution.observe"
            ? stream.pipe(
                // Only secret cards and the write-once opening statement affect activity.
                Stream.filterEffect((stored) =>
                  Effect.gen(function* () {
                    const event = stored.event;
                    if (
                      event.type !== "turn-item.updated" ||
                      event.payload.type === "secret_request"
                    )
                      return true;
                    if (event.payload.runId === null || !canAdvanceReadback(event.payload))
                      return false;
                    const rows = yield* sql<{ readonly found: number }>`SELECT 1 AS found
                    FROM orchestration_v2_projection_runs WHERE run_id = ${event.payload.runId}
                      AND json_extract(payload_json, '$.readback.eventId') = ${event.id}`;
                    return rows.length > 0;
                  }),
                ),
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
    return yield* execute(input);
  });
  return {
    identity,
    handle: Effect.fn("AgentRuntime.request")(function* (value: unknown) {
      const task = yield* handle(value).pipe(Effect.forkIn(processScope));
      const result = Fiber.join(task);
      // Utilities follow both request and process lifetimes; durable commands survive client loss.
      if (
        value !== null &&
        typeof value === "object" &&
        "method" in value &&
        value.method === "text.generate-structured"
      )
        return yield* result.pipe(Effect.onInterrupt(() => Fiber.interrupt(task)));
      return yield* result;
    }),
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
