import type { AgentAcpManagementOperations } from "./AcpManagementContract.ts";
import type {
  HostTurnIdentity,
  HostNativeSessionIdentity,
} from "@t3tools/provider-core/server/ExecutionHost";
import type * as DateTime from "effect/DateTime";
import type * as Brand from "effect/Brand";
import type {
  ModelSelection,
  OrchestrationV2Command,
  OrchestrationV2StoredEvent,
  OrchestrationV2ThreadHistoryPage,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
  ProviderInstanceConfig,
  ServerProvider,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
  OrchestrationV2DomainEvent,
  PersistChatAttachmentsInput,
  PersistChatAttachmentsResult,
  OrchestrationV2Subagent,
  OrchestrationV2ConversationMessage,
  ChatImageAttachment,
} from "@t3tools/contracts";

/** Plain transport types. Execution schemas and their codecs stay in the engine process. */
export type AgentWire<T> = T extends DateTime.Utc
  ? string
  : T extends string
    ? T extends Brand.Brand<infer _Key>
      ? string
      : T
    : T extends ReadonlyArray<infer Item>
      ? ReadonlyArray<AgentWire<Item>>
      : T extends object
        ? { readonly [Key in keyof T]: AgentWire<T[Key]> }
        : T;
export type AgentCommand = AgentWire<OrchestrationV2Command>;
export type AgentDispatchModeLimit = AgentWire<
  import("../orchestration-v2/DispatchModeLimit.ts").DispatchModes
>;
export type AgentEvent = AgentWire<OrchestrationV2StoredEvent>;
export type AgentSnapshot = Extract<
  AgentWire<OrchestrationV2ThreadStreamItem>,
  { readonly kind: "snapshot" }
>;
export type AgentHistoryPage = AgentWire<OrchestrationV2ThreadHistoryPage>;
export type AgentShellSnapshot = AgentWire<OrchestrationV2ThreadShellSnapshot>;
export type AgentTurnItem = AgentWire<OrchestrationV2TurnItem>;
export type AgentTimelinePage = AgentWire<
  import("../orchestration-v2/ProjectionStore.ts").ProjectionTimelineMetadataPage
>;
export interface AgentItemContentSlice {
  readonly itemId: string;
  readonly sourceThreadId: string;
  readonly runId: string | null;
  readonly type: AgentTurnItem["type"];
  readonly status: AgentTurnItem["status"];
  readonly updatedAt: string;
  readonly contentVersion: string;
  readonly format: "text" | "json";
  readonly text: string;
  /** UTF-16 code-unit offsets; joining consecutive slices reproduces the exact canonical content. */
  readonly textOffset: number;
  readonly totalChars: number;
  readonly nextTextOffset: number | null;
}
/** A wait pins selectedRunId once, then follows only its restart continuation chain. */
export interface AgentThreadExecution {
  readonly selectedRunId: string | null;
  readonly runId: string | null;
  readonly status: OrchestrationV2Run["status"] | null;
  readonly continuationPending: boolean;
  readonly activeFlags: readonly string[];
  readonly revision: string;
}

export interface AgentThreadProgress {
  readonly latestReply: AgentItemContentSlice | null;
  readonly latestActivity: {
    readonly itemId: string;
    readonly sourceThreadId: string;
    readonly runId: string | null;
    readonly type: AgentTurnItem["type"];
    readonly status: AgentTurnItem["status"];
    readonly updatedAt: string;
  } | null;
}
export type AgentProjectExecutionActivity = AgentWire<
  import("../orchestration-v2/ProjectionStore.ts").ProjectionProjectExecutionActivity
>;
export type AgentSubagentOverviewItem = AgentWire<
  Pick<
    OrchestrationV2Subagent,
    | "id"
    | "threadId"
    | "runId"
    | "parentNodeId"
    | "origin"
    | "driver"
    | "providerInstanceId"
    | "providerThreadId"
    | "childThreadId"
    | "title"
    | "model"
    | "modelSelection"
    | "status"
    | "startedAt"
    | "completedAt"
    | "updatedAt"
  >
> & { readonly childRunId: string | null; readonly resultAvailable: boolean };
export interface AgentSubagentOverviewPage {
  readonly items: ReadonlyArray<AgentSubagentOverviewItem>;
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
  /** Every task in this section, loaded or not. */
  readonly totalCount: number;
}
export interface AgentSubagentOverview {
  readonly active: AgentSubagentOverviewPage;
  readonly terminal: AgentSubagentOverviewPage;
}

export interface AgentRuntimeConfiguration {
  /** Absolute, dedicated writable directory owned by this Profile's execution runtime. */
  readonly home: string;
  readonly cwd: string;
  readonly providers: Readonly<Record<string, AgentWire<ProviderInstanceConfig>>>;
  readonly host?: { readonly tools: ReadonlyArray<AgentHostTool> };
}

export interface AgentRuntimeIdentity {
  readonly runtimeId: string;
  readonly runtimeGeneration: string;
  readonly schemaVersion: number;
  readonly databasePath: string;
  readonly mcpEndpoint: string;
  readonly lastSequence: number;
}

export interface AgentStorageSnapshot {
  readonly leaseId: string;
  readonly runtimeId: string;
  readonly runtimeGeneration: string;
  readonly sequence: number;
  readonly databasePath: string;
  readonly attachmentsPath: string;
  readonly environmentIdPath: string;
}

/** Captured execution identity and lifecycle metadata, without transcript bodies. */
export type AgentThreadAuthority = AgentHostTurnIdentity & {
  /** When the Run was requested; Host operation identities derived from it survive restarts. */
  readonly admittedAtMs: number;
  readonly userMessageId: string;
  readonly rootThreadId: string;
  readonly status: OrchestrationV2Run["status"];
  readonly archived: boolean;
  readonly nativeTurnId: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly hasNativeBackgroundWork: boolean;
};

export type AgentNativeSessionAuthority = AgentHostNativeSessionIdentity & {
  /** When this physical native connection opened. */
  readonly admittedAtMs: number;
  readonly rootThreadId: string;
  readonly status: null;
  readonly archived: boolean;
  readonly nativeTurnId: null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly hasNativeBackgroundWork: boolean;
};

export interface AgentNativeSource {
  readonly runtimeGeneration: string;
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly nativeGeneration: number;
  readonly providerThreadId: string;
  readonly nativeThreadId: string;
}
export interface AgentVoiceCapture {
  readonly source: AgentNativeSource;
  readonly userAgent: string;
  readonly voices: import("@nodex/codex-app-server-protocol/v2").ThreadRealtimeListVoicesResponse["voices"];
  readonly features: readonly { readonly name: string; readonly enabled: boolean }[];
  readonly history: readonly { readonly role: string; readonly text: string }[];
}
export interface AgentPredictionInput {
  readonly threadId: string;
  readonly latestRunId: string;
  readonly generationTrigger: "live" | "catch-up";
  readonly configuration: {
    readonly prompt: string;
    readonly prompt_version: string;
    readonly prediction_reasoning_effort: string;
    readonly unsupported_models?: readonly string[] | undefined;
    readonly sample_rate?: number | undefined;
    readonly live_sample_rate?: number | undefined;
    readonly catch_up_sample_rate?: number | undefined;
  };
}
export type AgentExecutionLocation = AgentWire<
  import("@t3tools/contracts").OrchestrationV2AppThread["executionLocation"]
> & {};

export type AgentBackgroundTask =
  import("../orchestration-v2/ExecutionActivity.ts").RootActivityBackgroundTask;

/** Live execution facts for one non-idle root Thread. */
export interface AgentRootActivity {
  readonly rootThreadId: string;
  /** `waiting`: an information question awaits the user; `background`: no foreground Run. */
  readonly status: "running" | "waiting" | "background";
  readonly activeRunId: string | null;
  readonly pendingRequestCount: number;
  readonly backgroundTasks: ReadonlyArray<AgentBackgroundTask>;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly updatedAt: string;
}

export interface AgentRuntimeOperations extends AgentAcpManagementOperations {
  readonly "thread.import-native": {
    readonly input: {
      readonly commandId: string;
      readonly threadId: string;
      readonly projectId: string;
      readonly title: string;
      readonly backendKind: "codex" | "claude";
      readonly sourceHome: string;
      readonly sourceNativeThreadId: string;
      readonly modelSelection: AgentWire<ModelSelection>;
      readonly cwd: string;
      readonly interactionMode?: "default" | "plan";
      readonly sideChatCapture?: true;
    };
    readonly output: { readonly threadId: string };
  };
  readonly "native-imports.find": {
    readonly input: {
      readonly backendKind: "codex" | "claude";
      readonly sourceHome: string;
      readonly nativeThreadIds: readonly string[];
    };
    readonly output: {
      readonly imports: readonly {
        readonly sourceNativeThreadId: string;
        readonly threadId: string;
      }[];
    };
  };
  readonly "native-message.receipt": {
    readonly input: import("./NativeMessageReceipts.ts").NativeMessageLookup;
    readonly output: import("./NativeMessageReceipts.ts").NativeMessageReceipt | null;
  };
  readonly "native-message.reserve": {
    readonly input: import("./NativeMessageReceipts.ts").NativeMessageReserve;
    readonly output: import("./NativeMessageReceipts.ts").NativeMessageReceipt;
  };
  readonly "native-message.settle": {
    readonly input: import("./NativeMessageReceipts.ts").NativeMessageSettle;
    readonly output: import("./NativeMessageReceipts.ts").NativeMessageReceipt;
  };
  readonly "execution.handoff.pending": {
    readonly input: { readonly cursor?: string };
    readonly output: AgentWire<
      import("../orchestration-v2/ProjectionStore.ts").ProjectionExecutionHandoffPage
    >;
  };
  readonly "execution.handoff.hold": {
    readonly input: {
      readonly threadId: string;
      readonly operationId: string;
      readonly action: "acquire" | "recovery" | "release";
      readonly recoveryRequired?: boolean;
      readonly sourceLocation?: AgentExecutionLocation;
    };
    readonly output: null;
  };
  readonly "execution.handoff.quiesce": {
    readonly input: { readonly threadId: string; readonly operationId: string };
    readonly output: null;
  };
  readonly "execution.handoff.commit": {
    readonly input: {
      readonly threadId: string;
      readonly operationId: string;
      readonly location: AgentExecutionLocation;
      readonly sourceWorkspaceRoot?: string;
      readonly childrenOnly?: boolean;
    };
    readonly output: null;
  };
  readonly "native.voice.prepare": {
    readonly input: { readonly threadId: string; readonly claimId: string };
    readonly output: AgentVoiceCapture;
  };
  readonly "native.voice.current": { readonly input: AgentNativeSource; readonly output: boolean };
  readonly "native.voice.start": {
    readonly input: {
      readonly claimId: string;
      readonly source: AgentNativeSource;
      readonly settings: unknown;
      readonly sdp: string;
    };
    readonly output: null;
  };
  readonly "native.voice.stop": {
    readonly input: { readonly claimId: string; readonly source: AgentNativeSource };
    readonly output: null;
  };
  readonly "native.voice.append-text": {
    readonly input: {
      readonly claimId: string;
      readonly source: AgentNativeSource;
      readonly role: string;
      readonly text: string;
    };
    readonly output: null;
  };
  readonly "native.voice.append-speech": {
    readonly input: {
      readonly claimId: string;
      readonly source: AgentNativeSource;
      readonly text: string;
    };
    readonly output: null;
  };
  readonly "native.voice.inject": {
    readonly input: {
      readonly claimId: string;
      readonly source: AgentNativeSource;
      readonly items: unknown;
    };
    readonly output: null;
  };
  readonly "native.voice.release": {
    readonly input: { readonly claimId: string };
    readonly output: null;
  };
  readonly "native.prediction.request": {
    readonly input: AgentPredictionInput;
    readonly output: unknown;
  };
  readonly "native.prediction.clear": {
    readonly input: { readonly threadId?: string };
    readonly output: null;
  };
  /** Prepared images accompany the prompt, after its text and in their supplied order. */
  readonly "text.generate-structured": {
    readonly input: AgentWire<
      import("@t3tools/provider-core/server/textGeneration").StructuredGenerationInput
    >;
    readonly output: unknown;
  };
  readonly "project.close": {
    readonly input: { readonly projectId: string };
    readonly output: { readonly closedBindings: number };
  };
  readonly "run.outcome": {
    readonly input: AgentWire<
      import("../orchestration-v2/ProjectionStore.ts").ProjectionRunOutcomeQuery
    >;
    readonly output: AgentWire<
      import("../orchestration-v2/ProjectionStore.ts").ProjectionRunOutcome
    > | null;
  };
  readonly "background.stop": {
    readonly input: {
      readonly threadId: string;
      readonly commandId: string;
      readonly taskIds: ReadonlyArray<string>;
    };
    readonly output: { readonly stopping: ReadonlyArray<string> };
  };
  readonly "background.output": {
    readonly input: { readonly threadId: string; readonly taskId: string };
    readonly output: {
      readonly text: string;
      readonly truncated: boolean;
      readonly totalBytes: number;
    } | null;
  };
  readonly "tasks.cancel": {
    readonly input: {
      readonly threadId: string;
      readonly taskId: string;
      readonly commandId: string;
      readonly reason?: string;
    };
    readonly output: { readonly taskId: string; readonly status: string };
  };
  readonly "tasks.overview": {
    readonly input: {
      readonly threadId: string;
      readonly activeCursor?: string;
      readonly terminalCursor?: string;
    };
    readonly output: AgentSubagentOverview;
  };
  readonly "storage.snapshot.acquire": {
    readonly input: Record<string, never>;
    readonly output: AgentStorageSnapshot;
  };
  readonly "storage.snapshot.release": {
    readonly input: { readonly leaseId: string };
    readonly output: { readonly released: boolean };
  };
  readonly "attachments.import": {
    readonly input: AgentWire<
      import("../assets/ImportChatAttachments.ts").ImportChatAttachmentsInput
    >;
    readonly output: AgentWire<PersistChatAttachmentsResult>;
  };
  readonly "thread.send": {
    readonly input: {
      readonly threadId: string;
      readonly commandId: string;
      readonly messageId: string;
      readonly text: string;
      readonly attachments: readonly AgentWire<import("@t3tools/contracts").ChatAttachment>[];
      readonly context?: Extract<AgentCommand, { readonly type: "message.dispatch" }>["context"];
      readonly interactionMode?: Extract<
        AgentCommand,
        { readonly type: "thread.create" }
      >["interactionMode"];
      readonly modelSelection?: AgentWire<ModelSelection>;
      readonly mode: "auto" | "queue" | "steer" | "restart";
      /** Host-authenticated origin; message admission retains it when another caller retries. */
      readonly createdBy: "user" | "agent";
      readonly senderThreadId?: string;
      readonly senderRunId?: string | null;
      readonly modeLimit?: AgentDispatchModeLimit;
    };
    readonly output: {
      readonly messageId: string;
      readonly runId: string;
      readonly status: OrchestrationV2Run["status"];
      readonly delivery: "started" | "queued" | "steered" | "restarted";
      readonly taskId?: string;
    };
  };
  readonly "thread.message-admit": {
    readonly input: AgentWire<import("./RuntimeMessageReceipts.ts").RuntimeMessageAdmission>;
    readonly output: { readonly admitted: boolean };
  };
  readonly "thread.message-replay": {
    readonly input: AgentWire<import("./RuntimeMessageReceipts.ts").RuntimeMessageIdentity>;
    readonly output: AgentRuntimeOperations["thread.send"]["output"] | null;
  };
  readonly "thread.message-launch": {
    readonly input: AgentRuntimeOperations["thread.message-replay"]["input"];
    readonly output: AgentWire<import("./RuntimeMessageReceipts.ts").RuntimeMessageLaunch> | null;
  };
  readonly "thread.message-stage": {
    readonly input: AgentWire<import("./RuntimeMessageReceipts.ts").RuntimeMessageLaunchStage>;
    readonly output: AgentWire<import("./RuntimeMessageReceipts.ts").RuntimeMessageLaunch>;
  };
  readonly "attachments.persist": {
    readonly input: AgentWire<PersistChatAttachmentsInput>;
    readonly output: AgentWire<PersistChatAttachmentsResult>;
  };
  readonly "thread.execution": {
    readonly input: {
      readonly threadId: string;
      readonly runId?: string | null;
      readonly messageId?: string;
    };
    readonly output: AgentThreadExecution;
  };
  readonly "thread.execution.wait": {
    readonly input: {
      readonly threadId: string;
      readonly runId: string | null;
      readonly afterRevision: string;
      readonly timeoutMs: number;
    };
    readonly output: AgentThreadExecution;
  };
  readonly "thread.read": {
    readonly input: { readonly threadId: string };
    readonly output:
      | (AgentWire<OrchestrationV2ThreadShell> & { readonly providerDriver: string | null })
      | null;
  };
  readonly "providers.read": {
    /**
     * Naming instances reads only those Agents, without waiting for the others' checks. A
     * refresh that names them checks only them, from scratch, so usage they report is read
     * again rather than reused from a recent check.
     */
    readonly input: { readonly refresh?: boolean; readonly instanceIds?: ReadonlyArray<string> };
    readonly output: ReadonlyArray<AgentWire<ServerProvider>>;
  };
  readonly "providers.logout": {
    /** Signs the named Agents out of the sign-in their own CLI keeps, then checks them again. */
    readonly input: { readonly instanceIds: ReadonlyArray<string> };
    readonly output: ReadonlyArray<AgentWire<ServerProvider>>;
  };
  readonly "providers.configure": {
    readonly input: { readonly providers: AgentRuntimeConfiguration["providers"] };
    readonly output: {
      readonly applied: boolean;
      readonly deferredInstanceIds: ReadonlyArray<string>;
    };
  };
  readonly "native-session.authority": {
    readonly input: {
      readonly threadId: string;
      readonly providerSessionId: string;
      readonly nativeGeneration: number;
      readonly incarnationId: string;
    };
    readonly output: AgentNativeSessionAuthority | null;
  };
  readonly "thread.authority": {
    readonly input: { readonly threadId: string; readonly runId: string };
    readonly output: AgentThreadAuthority | null;
  };
  readonly "command.dispatch": {
    readonly input: { readonly command: AgentCommand; readonly modeLimit?: AgentDispatchModeLimit };
    readonly output: { readonly sequence: number };
  };
  /** Durable admission evidence, independent of a Thread's current execution/lifecycle state. */
  readonly "command.receipt": {
    readonly input: { readonly commandId: string; readonly threadId: string };
    readonly output: {
      readonly status: "accepted" | "rejected";
      readonly sequence: number;
      readonly error: string | null;
    } | null;
  };
  readonly "thread.compact": {
    readonly input: { readonly threadId: string; readonly requestId: string };
    readonly output: {
      readonly commandId: string;
      readonly messageId: string;
      readonly runId: string;
      readonly sequence: number;
    };
  };
  readonly "thread.rollback": {
    readonly input: {
      readonly threadId: string;
      readonly requestId: string;
      readonly runId: string;
    };
    readonly output: {
      readonly commandId: string;
      readonly userMessageId: string;
      readonly sequence: number;
    };
  };
  readonly "project.upsert": {
    readonly input: {
      readonly id: string;
      readonly title: string;
      readonly workspaceRoot: string;
      readonly defaultModelSelection?: { readonly instanceId: string; readonly model: string };
    };
    readonly output: { readonly id: string };
  };
  readonly "project.read": {
    readonly input: { readonly projectId: string };
    readonly output: {
      readonly id: string;
      readonly title: string;
      readonly workspaceRoot: string;
    } | null;
  };
  readonly "project.activity": {
    readonly input: { readonly projectId: string };
    readonly output: AgentProjectExecutionActivity;
  };
  readonly "project.roots": {
    readonly input: { readonly projectId: string; readonly cursor?: string };
    readonly output: { readonly threadIds: readonly string[]; readonly nextCursor: string | null };
  };
  readonly "thread.queue": {
    readonly input: { readonly threadId: string; readonly cursor?: string };
    readonly output: import("../orchestration-v2/ProjectionStore.ts").ProjectionQueuedRunPage;
  };
  readonly "thread.queued-preview": {
    readonly input: { readonly threadId: string; readonly runId: string };
    readonly output: {
      readonly threadId: string;
      readonly runId: string;
      readonly messageId: string;
      readonly text: string;
      readonly images: ReadonlyArray<AgentWire<Omit<ChatImageAttachment, "source">>>;
    } | null;
  };
  /** The user message that started a Run still in the conversation, queued or settled. */
  readonly "thread.run-message": {
    readonly input: { readonly threadId: string; readonly runId: string };
    readonly output: AgentWire<OrchestrationV2ConversationMessage> | null;
  };
  /** The first own user turn admitted to the conversation, excluding inherited and queued-only history. */
  readonly "thread.opening-request": {
    readonly input: { readonly threadId: string };
    readonly output: AgentWire<OrchestrationV2ConversationMessage> | null;
  };
  readonly "shell.read": {
    readonly input: { readonly projectId?: string; readonly location?: "active" | "archive" };
    readonly output: AgentShellSnapshot;
  };
  readonly "thread.snapshot": {
    readonly input: { readonly threadId: string };
    readonly output: AgentSnapshot;
  };
  readonly "thread.control": {
    readonly input: {
      readonly threadId: string;
      readonly runId?: string;
      readonly requestId?: string;
    };
    readonly output: AgentSnapshot;
  };
  readonly "thread.fork-source": {
    readonly input: { readonly threadId: string; readonly runId?: string };
    readonly output: string | null;
  };
  /** Validates side-chat save admission without accepting a command or changing history. */
  readonly "thread.side-chat-save-source": {
    readonly input: { readonly threadId: string };
    readonly output: string | null;
  };
  readonly "thread.history": {
    readonly input: {
      readonly threadId: string;
      readonly cursor: string;
      readonly throughEntryId?: string;
      readonly conversationOnly?: boolean;
    };
    readonly output: AgentHistoryPage;
  };
  /** Visible item windows, including captured fork ancestry, without a UI snapshot. */
  readonly "thread.timeline": {
    readonly input: {
      readonly threadId: string;
      readonly beforeItem?: { readonly sourceThreadId: string; readonly sourceItemId: string };
      readonly afterItem?: { readonly sourceThreadId: string; readonly sourceItemId: string };
      readonly order?: "oldest_first" | "newest_first";
      readonly view?: "messages" | "activity";
      readonly limit: number;
    };
    readonly output: AgentTimelinePage;
  };
  /** Compact newest reply and activity markers, independent of history volume. */
  readonly "thread.read-details": {
    readonly input: {
      readonly threadId: string;
      readonly runLimit: number;
      readonly beforeOrdinal?: number;
    };
    readonly output: import("../orchestration-v2/SessionReadDetails.ts").SessionReadDetails;
  };
  /** Complete child-result evidence; the Runtime revalidates its task delivery owner. */
  readonly "thread.acknowledge-read": {
    readonly input: {
      readonly callerThreadId: string;
      readonly callerRunId: string;
      readonly threadId: string;
      readonly items: readonly import("./history-contracts.ts").ThreadReadEvidence[];
    };
    readonly output: { readonly acknowledged: number };
  };
  readonly "thread.progress": {
    readonly input: { readonly threadId: string; readonly runId?: string };
    readonly output: AgentThreadProgress;
  };
  /** Each of the thread's own Runs' opening prompt and latest reply, oldest first. */
  readonly "thread.prompt-index": {
    readonly input: { readonly threadId: string };
    readonly output: import("../orchestration-v2/threadPromptIndex.ts").ThreadPromptIndex;
  };
  readonly "thread.item": {
    readonly input: {
      readonly threadId: string;
      readonly itemId: string;
      readonly sourceThreadId?: string;
    };
    readonly output: AgentTurnItem | null;
  };
  readonly "thread.attachment": {
    readonly input: {
      readonly threadId: string;
      readonly sourceThreadId?: string;
      readonly itemId: string;
      readonly attachmentId: string;
    };
    readonly output:
      | (({ readonly path: string } | { readonly dataUrl: string }) & {
          readonly attachment?: AgentWire<import("@t3tools/contracts").ChatAttachment>;
        })
      | null;
  };
  readonly "thread.item.full": {
    readonly input: {
      readonly threadId: string;
      readonly itemId: string;
      readonly sourceThreadId?: string;
    };
    readonly output: AgentTurnItem | null;
  };
  /** Lossless, resumable canonical item content; never constrained by whole-item transport size. */
  readonly "thread.item.content": {
    readonly input: {
      readonly threadId: string;
      readonly itemId: string;
      readonly runId?: string | null;
      readonly sourceThreadId?: string;
      readonly format?: "text" | "json";
      readonly textOffset?: number;
      readonly maxChars?: number;
    };
    readonly output:
      | (AgentItemContentSlice & {
          readonly reference: import("./HistoryRead.ts").HistoryItemReference;
        })
      | null;
  };
  readonly "events.observe": {
    readonly input: {
      readonly threadId?: string;
      readonly afterSequence?: number;
      readonly eventTypes?: ReadonlyArray<OrchestrationV2DomainEvent["type"]>;
    };
    readonly output: {
      readonly subscribed: true;
      readonly subscriptionId: string;
      readonly afterSequence: number;
    };
  };
  /**
   * Non-idle root Threads from SQL: an active Run, a pending information request, live delegated
   * or native background work, or a delegated completion that will wake the root. Idle roots are
   * absent. `rootThreadIds` point-reads those roots; otherwise pages follow `cursor`.
   */
  readonly "sessions.search": {
    readonly input: import("../orchestration-v2/SessionSearch.ts").SessionSearchInput;
    readonly output: import("../orchestration-v2/SessionSearch.ts").SessionSearchPage;
  };
  readonly "sessions.search-resolve": {
    readonly input: import("../orchestration-v2/SessionSearch.ts").SessionSearchResolveInput;
    readonly output: import("../orchestration-v2/SessionSearch.ts").SessionSearchResolvePage;
  };
  readonly "sessions.metadata": {
    readonly input: { readonly threadIds: readonly string[] };
    readonly output: readonly import("../orchestration-v2/SessionMetadata.ts").SessionExecutionMetadata[];
  };
  readonly "sessions.catalog": {
    readonly input: import("../orchestration-v2/SessionCatalog.ts").SessionCatalogInput;
    readonly output: import("../orchestration-v2/SessionCatalog.ts").SessionCatalogPage;
  };
  readonly "execution.activity": {
    readonly input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly rootThreadIds?: readonly string[];
    };
    readonly output: {
      readonly snapshotSequence: number;
      readonly items: readonly AgentRootActivity[];
      readonly nextCursor: string | null;
    };
  };
  readonly "execution.observe": {
    readonly input: { readonly threadId?: string; readonly afterSequence?: number };
    readonly output: {
      readonly subscribed: true;
      readonly subscriptionId: string;
      readonly afterSequence: number;
    };
  };
  readonly "events.unobserve": {
    readonly input: { readonly subscriptionId: string };
    readonly output: { readonly unsubscribed: true };
  };
  readonly "runtime.identity": {
    readonly input: Record<string, never>;
    readonly output: AgentRuntimeIdentity;
  };
  readonly shutdown: {
    readonly input: Record<string, never>;
    readonly output: { readonly stopped: true };
  };
}

export type AgentRuntimeMethod = keyof AgentRuntimeOperations;
export type AgentRuntimeRequest = {
  readonly [M in AgentRuntimeMethod]: {
    readonly id: string;
    readonly method: M;
    readonly input: AgentRuntimeOperations[M]["input"];
  };
}[AgentRuntimeMethod];

export type AgentRuntimeResponse =
  | { readonly id: string; readonly success: true; readonly output: unknown }
  | {
      readonly id: string;
      readonly success: false;
      readonly error: {
        readonly message: string;
        readonly tag?: string;
        readonly reason?: string;
        readonly acp?: import("./AcpManagementContract.ts").AgentAcpFailure;
      };
    };

export interface AgentHostTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly annotations?: Readonly<Record<string, unknown>>;
}

export type AgentHostTurnIdentity = AgentWire<HostTurnIdentity> & {
  readonly runtimeId: string;
  readonly runtimeGeneration: string;
};
export type AgentHostNativeSessionIdentity = AgentWire<HostNativeSessionIdentity> & {
  readonly runtimeId: string;
  readonly runtimeGeneration: string;
};
export type AgentHostExecutionIdentity = AgentHostTurnIdentity | AgentHostNativeSessionIdentity;
export type AgentHostToolIdentity = AgentHostExecutionIdentity & {
  readonly nativeTurnId?: string;
  readonly nativeCallId?: string;
  readonly nativeCallKey?: string;
  readonly mcpClientId?: number;
  readonly mcpRequestId?: string | number;
  readonly requestMetadata?: Readonly<Record<string, unknown>>;
};
export type AgentProviderAuthentication = AgentWire<
  import("@t3tools/provider-core/server/ExecutionHost").ProviderAuthentication
>;
export type AgentHostRequest =
  | {
      readonly type: "host.request";
      readonly id: string;
      readonly operation: "provider.auth";
      readonly identity: {
        readonly runtimeId: string;
        readonly runtimeGeneration: string;
        readonly providerInstanceId: string;
      };
      readonly refresh: boolean;
      readonly previousAccountId: string | null;
    }
  | {
      readonly type: "host.request";
      readonly id: string;
      readonly operation: "turn.prepare";
      readonly identity: AgentHostTurnIdentity;
    }
  | {
      readonly type: "host.request";
      readonly id: string;
      readonly operation: "thread.prepare";
      readonly identity: {
        readonly runtimeId: string;
        readonly runtimeGeneration: string;
        readonly threadId: string;
        readonly providerInstanceId: string;
        readonly nativeDriver: string;
      };
      readonly cwd: string | null;
    }
  | {
      readonly type: "host.request";
      readonly id: string;
      readonly operation: "turn.native";
      readonly identity: AgentHostTurnIdentity;
      readonly nativeTurnId: string;
      readonly phase: "started" | "ended";
    }
  | {
      readonly type: "host.request";
      readonly id: string;
      readonly operation: "tool.call";
      readonly identity: AgentHostToolIdentity;
      readonly tool: string;
      readonly input: unknown;
    };
export type AgentHostResult =
  | {
      readonly type: "host.result";
      readonly id: string;
      readonly success: true;
      readonly output: unknown;
    }
  | {
      readonly type: "host.result";
      readonly id: string;
      readonly success: false;
      readonly error: { readonly message: string };
    };

export type AgentRuntimeNotification =
  | {
      readonly type: "host.cancel";
      readonly id: string;
      readonly runtimeId: string;
      readonly runtimeGeneration: string;
    }
  | {
      readonly type: "native.voice.event";
      readonly claimId: string;
      readonly source: AgentNativeSource;
      readonly notification: { readonly method: string; readonly params: unknown };
    }
  | {
      readonly type: "native.voice.closed";
      readonly claimId: string;
      readonly source: AgentNativeSource;
    }
  | AgentHostRequest
  | { readonly type: "ready"; readonly identity: AgentRuntimeIdentity }
  | {
      readonly type: "execution.native-session.closed";
      readonly runtimeId: string;
      readonly runtimeGeneration: string;
      readonly providerSessionId: string;
      readonly nativeGeneration: number;
      readonly incarnationId: string;
    }
  | { readonly type: "event"; readonly subscriptionId: string; readonly event: AgentEvent }
  | {
      readonly type: "execution.lifecycle";
      readonly subscriptionId: string;
      readonly runtimeGeneration: string;
      readonly sequence: number;
      readonly threadId: string;
      readonly eventType: "run.updated" | "thread.deleted";
      readonly runId?: string;
      readonly runStatus?: OrchestrationV2Run["status"];
    }
  /** Execution observation: a committed event may have changed this root's activity. */
  | { readonly type: "activity"; readonly rootThreadId: string; readonly sequence: number }
  | { readonly type: "event.error"; readonly subscriptionId: string; readonly message: string };
