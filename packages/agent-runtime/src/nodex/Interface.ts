import type { HostTurnIdentity } from "@t3tools/provider-core/server/ExecutionHost";
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
  OrchestrationV2AppThread,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
  OrchestrationV2DomainEvent,
  PersistChatAttachmentsInput,
  PersistChatAttachmentsResult,
  OrchestrationV2Subagent,
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
export interface AgentSubagentOverview {
  readonly active: {
    readonly items: ReadonlyArray<AgentSubagentOverviewItem>;
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
  readonly terminal: {
    readonly items: ReadonlyArray<AgentSubagentOverviewItem>;
    readonly nextCursor: string | null;
    readonly hasMore: boolean;
  };
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

/** Metadata proof from the engine's current foreground actor, without transcript bodies. */
export type AgentThreadAuthority = AgentHostTurnIdentity & {
  readonly rootThreadId: string;
  readonly parent: { readonly threadId: string; readonly runId: string } | null;
  readonly runtimeMode: OrchestrationV2AppThread["runtimeMode"];
  readonly interactionMode: OrchestrationV2AppThread["interactionMode"];
  readonly status: OrchestrationV2Run["status"];
  readonly readOnly: boolean;
  readonly archived: boolean;
  readonly nativeTurnId: string | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly hasNativeBackgroundWork: boolean;
};

export interface AgentRuntimeOperations {
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
    readonly input: { readonly refresh?: boolean };
    readonly output: ReadonlyArray<AgentWire<ServerProvider>>;
  };
  readonly "providers.configure": {
    readonly input: { readonly providers: AgentRuntimeConfiguration["providers"] };
    readonly output: {
      readonly applied: boolean;
      readonly deferredInstanceIds: ReadonlyArray<string>;
    };
  };
  readonly "thread.authority": {
    readonly input: { readonly threadId: string; readonly runId: string };
    readonly output: AgentThreadAuthority | null;
  };
  readonly "command.dispatch": {
    readonly input: AgentCommand;
    readonly output: { readonly sequence: number };
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
  readonly "shell.read": {
    readonly input: { readonly projectId?: string; readonly location?: "active" | "archive" };
    readonly output: AgentShellSnapshot;
  };
  readonly "thread.snapshot": {
    readonly input: { readonly threadId: string };
    readonly output: AgentSnapshot;
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
export type AgentHostToolIdentity = AgentHostTurnIdentity & {
  readonly nativeTurnId?: string;
  readonly mcpClientId?: number;
  readonly mcpRequestId?: string | number;
  readonly requestMetadata?: Readonly<Record<string, unknown>>;
};
export type AgentHostRequest =
  | {
      readonly type: "host.request";
      readonly id: string;
      readonly operation: "turn.prepare";
      readonly identity: AgentHostTurnIdentity;
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
  | AgentHostRequest
  | { readonly type: "ready"; readonly identity: AgentRuntimeIdentity }
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
  | { readonly type: "event.error"; readonly subscriptionId: string; readonly message: string };
