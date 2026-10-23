import type {
  HostTurnIdentity,
  HostNativeSessionIdentity,
} from "@t3tools/provider-core/server/ExecutionHost";
import type * as DateTime from "effect/DateTime";
import type * as Brand from "effect/Brand";
import type {
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
export type AgentEvent = AgentWire<OrchestrationV2StoredEvent>;
export type AgentSnapshot = Extract<
  AgentWire<OrchestrationV2ThreadStreamItem>,
  { readonly kind: "snapshot" }
>;
export type AgentHistoryPage = AgentWire<OrchestrationV2ThreadHistoryPage>;
export type AgentShellSnapshot = AgentWire<OrchestrationV2ThreadShellSnapshot>;
export type AgentTurnItem = AgentWire<OrchestrationV2TurnItem>;
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

/** Live execution facts for one non-idle root Thread. */
export interface AgentRootActivity {
  readonly rootThreadId: string;
  /** `waiting`: an information question awaits the user; `background`: no foreground Run. */
  readonly status: "running" | "waiting" | "background";
  readonly activeRunId: string | null;
  readonly pendingRequestCount: number;
  readonly activeTaskCount: number;
  readonly resumesAutomatically: boolean;
  readonly providerInstanceId: string;
  readonly model: string;
  readonly updatedAt: string;
}

export interface AgentRuntimeOperations {
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
    readonly input: { readonly threadId: string; readonly messageId: string };
    readonly output: AgentWire<
      import("../orchestration-v2/ProjectionStore.ts").ProjectionRunOutcome
    > | null;
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
  readonly "attachments.persist": {
    readonly input: AgentWire<PersistChatAttachmentsInput>;
    readonly output: AgentWire<PersistChatAttachmentsResult>;
  };
  readonly "thread.read": {
    readonly input: { readonly threadId: string };
    readonly output: AgentWire<OrchestrationV2ThreadShell> | null;
  };
  readonly "providers.read": {
    /** Naming instances reads only those Agents, without waiting for the others' checks. */
    readonly input: { readonly refresh?: boolean; readonly instanceIds?: ReadonlyArray<string> };
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
    readonly input: AgentCommand;
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
  readonly "shell.read": {
    readonly input: { readonly projectId?: string; readonly location?: "active" | "archive" };
    readonly output: AgentShellSnapshot;
  };
  readonly "thread.snapshot": {
    readonly input: { readonly threadId: string };
    readonly output: AgentSnapshot;
  };
  readonly "thread.control": {
    readonly input: { readonly threadId: string; readonly runId?: string };
    readonly output: AgentSnapshot;
  };
  readonly "thread.fork-source": {
    readonly input: { readonly threadId: string; readonly runId?: string };
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
    readonly output: { readonly path: string } | null;
  };
  readonly "thread.item.full": {
    readonly input: {
      readonly threadId: string;
      readonly itemId: string;
      readonly sourceThreadId?: string;
    };
    readonly output: AgentTurnItem | null;
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
      readonly error: { readonly message: string; readonly tag?: string };
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
