import type {
  AgentCommand,
  AgentRootActivity,
  AgentEvent,
  AgentHistoryPage,
  AgentRuntimeOperations,
  AgentSnapshot,
  AgentTurnItem,
} from "@nodex/agent-runtime/contracts";

type CreateThread = Extract<AgentCommand, { readonly type: "thread.create" }>;
type DispatchMessage = Extract<AgentCommand, { readonly type: "message.dispatch" }>;
type Respond = Extract<AgentCommand, { readonly type: "runtime-request.respond" }>;

export interface AgentRuntimeMessage {
  readonly messageId: string;
  readonly text: string;
  readonly attachments?: DispatchMessage["attachments"];
  readonly images?: readonly import("./types").CodexPromptImageInput[];
  readonly context?: DispatchMessage["context"];
  readonly modelSelection?: DispatchMessage["modelSelection"];
  readonly interactionMode?: CreateThread["interactionMode"];
  /** Structured editor input is authoritative; absent input permits standalone Nodex Markdown lines. */
  readonly agentConfigs?: readonly import("./types").CodexPromptAgentConfigInput[];
}

export interface AgentRuntimeLaunch {
  /** Immutable application-tool request identity; receipt replay precedes mutable preparation. */
  readonly messageFingerprint?: string;
  readonly interactionModeCeiling?: "plan";
  /** Host-authorized resources, materialized by the execution owner before its first message. */
  readonly resources?: AgentRuntimeOperations["attachments.import"]["input"]["attachments"];
  readonly launchId: string;
  readonly acceptedAt: number;
  /** The unstarted product Session is promoted without changing its identity. */
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly title: string;
  readonly initialPageIds?: readonly string[];
  readonly presentationTicket?: import("./nodex-app-tools/turn-presentation").CodexTurnPresentationTicket;
  readonly sourceRoot?: string;
  readonly modelSelection: CreateThread["modelSelection"];
  readonly interactionMode: CreateThread["interactionMode"];
  readonly runInTarget?: "localProject" | "newWorktree";
  readonly runInEnvironmentPath?: string | null;
  readonly worktreeStartingState?: import("./codex-pending-worktree").CodexPendingWorktreeStartingState;
  readonly branch?: string | null;
  readonly worktreePath?: string | null;
  readonly message: AgentRuntimeMessage;
}

const AGENT_EXECUTION_THREAD_PREFIX = "nodex:thread:";

/** Agent execution names a chat's root Thread itself; native Codex Threads are UUIDs. */
export const agentExecutionThreadId = (digest: string): string =>
  `${AGENT_EXECUTION_THREAD_PREFIX}${digest}`;

export const isAgentExecutionThreadId = (threadId: string): boolean =>
  threadId.startsWith(AGENT_EXECUTION_THREAD_PREFIX);

/** Only a native app-server conversation is a UUID; no Agent execution Thread, root or child, is. */
export const isNativeCodexThreadId = (threadId: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(threadId);

export interface AgentRuntimeSessionTarget {
  readonly sessionId: string;
  /** A descendant remains within the Session's explicitly bound root execution. */
  readonly threadId?: string;
}

/** Retains one exact Run's control metadata without reading its transcript. */
export type AgentRuntimeControlInput = AgentRuntimeSessionTarget & { readonly runId?: string };

export interface AgentRuntimeLaunchResult {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly threadId: string;
}

export interface AgentRuntimeConversation {
  readonly sessionId: string;
  readonly projectId: string | null;
  readonly threadId: string;
  readonly snapshot: AgentSnapshot;
}

export const AGENT_RUNTIME_CONTROL_EVENT_TYPES = [
  "run.created",
  "run.updated",
  "run.execution-retired",
  "run-attempt.created",
  "run-attempt.updated",
  "provider-turn.updated",
  "node.updated",
  "runtime-request.updated",
  "subagent.updated",
  "provider-thread.updated",
  "provider-session.attached",
  "provider-session.updated",
  "provider-session.detached",
  "thread.created",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.settled",
  "thread.unsettled",
  "thread.metadata-updated",
  "thread.interaction-mode-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
] as const satisfies readonly AgentEvent["event"]["type"][];

/** Metadata and verified lineage for navigation; this never hydrates transcript items. */
export interface AgentRuntimeInspection extends AgentRuntimeLaunchResult {
  readonly runtimeId: string;
  readonly rootThreadId: string;
  readonly thread: NonNullable<AgentRuntimeOperations["thread.read"]["output"]>;
}

export type AgentRuntimeMessageInput = AgentRuntimeSessionTarget & {
  readonly message: AgentRuntimeMessage;
  readonly intent?: DispatchMessage["deliveryIntent"];
  readonly presentationTicket?: import("./nodex-app-tools/turn-presentation").CodexTurnPresentationTicket;
};

export type AgentRuntimeSendMessageResult = AgentRuntimeOperations["thread.send"]["output"] & {
  readonly sessionId: string;
  readonly threadId: string;
  readonly sideChatTitle?: string;
};
export type AgentRuntimeStopInput = AgentRuntimeSessionTarget & { readonly runId: string };
/** The fork Session whose newest finished Run merges back into the chat it came from. */
export type AgentRuntimeMergeBackInput = AgentRuntimeSessionTarget & { readonly requestId: string };
export type AgentRuntimeResponseInput = AgentRuntimeSessionTarget &
  Pick<Respond, "requestId" | "decision" | "answers" | "attachmentsByQuestionId"> & {
    readonly runId: string | null;
    /** One accepted answer batch; retries reuse it and later answers allocate a new identity. */
    readonly submissionId?: string;
  };
export type AgentRuntimeModeInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly interactionMode?: CreateThread["interactionMode"];
};
export type AgentRuntimeCompactInput = AgentRuntimeSessionTarget & { readonly requestId: string };
/** Ends the chat's context; its next message starts every Agent's conversation fresh. */
export type AgentRuntimeClearContextInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
};
export type AgentRuntimeQueueReadInput = AgentRuntimeSessionTarget & { readonly cursor?: string };
export type AgentRuntimeQueuePage = AgentRuntimeOperations["thread.queue"]["output"];
export type AgentRuntimeRunInput = AgentRuntimeSessionTarget & { readonly runId: string };
export type AgentRuntimeQueuedPreview = AgentRuntimeOperations["thread.queued-preview"]["output"];
export type AgentRuntimeRunMessage = AgentRuntimeOperations["thread.run-message"]["output"];
export type AgentRuntimePromptIndex = AgentRuntimeOperations["thread.prompt-index"]["output"];
export type AgentRuntimeRollbackInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly runId: string;
};
export type AgentRuntimeTaskStopInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly runId: string;
  readonly taskId: string;
};
export type AgentRuntimeBackgroundStopInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly taskIds: readonly string[];
};
export type AgentRuntimeBackgroundOutputInput = AgentRuntimeSessionTarget & {
  readonly taskId: string;
};
export interface AgentRuntimeBackgroundOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly totalBytes: number;
}
export type AgentRuntimeTaskCancelInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly taskId: string;
};
/** Changes product placement; the Session keeps its execution root and working directory. */
export interface AgentRuntimeSessionMoveInput {
  readonly operationId: string;
  readonly sessionId: string;
  readonly projectId: string | null;
}
/** Retry a failed workspace preparation, or start the Run in the source checkout instead. */
export type AgentRuntimePreparationRetryInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly runId: string;
  readonly workLocally: boolean;
};
export type AgentRuntimeQueueInput = AgentRuntimeSessionTarget & { readonly requestId: string } & (
    | { readonly action: "resume"; readonly runId?: string }
    | { readonly action: "cancel"; readonly runId: string }
    | {
        readonly action: "reorder";
        readonly orderedRunIds: readonly string[];
        readonly beforeRunId?: string | null;
      }
    | {
        readonly action: "edit";
        readonly runId: string;
        readonly message: AgentRuntimeMessage;
        readonly presentationTicket?: import("./nodex-app-tools/turn-presentation").CodexTurnPresentationTicket;
      }
    | { readonly action: "steer"; readonly runId: string; readonly targetRunId: string }
  );
/** Captures the source now; execution waits for the first side-chat message. */
export interface AgentRuntimeSideChatCreateInput {
  readonly source: AgentRuntimeSessionTarget;
  readonly sessionId: string;
  readonly requestId: string;
  readonly acceptedAt: number;
}
export interface AgentRuntimeSideChatDiscardInput {
  readonly sessionId: string;
  readonly requestId: string;
}
/** Freezes an idle side chat as an ordinary Session without starting a Run. */
export type AgentRuntimeSideChatSaveInput = AgentRuntimeSideChatCreateInput;
export interface AgentRuntimeForkInput {
  readonly source: AgentRuntimeSessionTarget;
  readonly sessionId: string;
  readonly requestId: string;
  readonly acceptedAt: number;
  readonly environment: "same-directory" | "worktree";
  readonly sourceRunId?: string;
  readonly runInEnvironmentPath?: string | null;
}
export type AgentRuntimeHistoryInput = AgentRuntimeSessionTarget &
  Omit<AgentRuntimeOperations["thread.history"]["input"], "threadId">;
export type AgentRuntimeOverviewInput = AgentRuntimeSessionTarget &
  Omit<AgentRuntimeOperations["tasks.overview"]["input"], "threadId">;
export type AgentRuntimeItemInput = AgentRuntimeSessionTarget & {
  readonly itemId: string;
  readonly sourceThreadId?: string;
  /** Explicit export/detail read; ordinary transcript windows remain bounded previews. */
  readonly full?: true;
};
export type AgentRuntimeAttachmentInput = AgentRuntimeSessionTarget &
  Omit<AgentRuntimeOperations["thread.attachment"]["input"], "threadId">;
export type AgentRuntimeObserveInput = AgentRuntimeSessionTarget & {
  readonly subscriptionId: string;
  readonly afterSequence?: number;
  /** Metadata observers filter before engine replay/body decoding. */
  readonly eventTypes?: readonly (typeof AGENT_RUNTIME_CONTROL_EVENT_TYPES)[number][];
};
export type AgentRuntimeSessionEvent =
  | {
      readonly type: "event";
      readonly subscriptionId?: string;
      readonly sessionId: string;
      readonly threadId: string;
      readonly event: AgentEvent;
    }
  | {
      readonly type: "reset-required";
      readonly subscriptionId?: string;
      readonly sessionId: string;
      readonly threadId: string;
      readonly reason: "delivery-gap" | "runtime-restarted" | "stream-failed";
    };

/**
 * Live execution facts for one Runtime-bound Session. Idle Sessions are absent.
 * `waiting` means an information question awaits the user; `background` means no
 * foreground Run is active but delegated or native background work is live, or a
 * delegated result will wake the Session automatically.
 */
export interface AgentRuntimeSessionActivity {
  readonly sessionId: string;
  readonly threadId: string;
  readonly status: "running" | "waiting" | "background";
  readonly activeRunId: string | null;
  readonly pendingRequestCount: number;
  readonly backgroundTasks: AgentRootActivity["backgroundTasks"];
  readonly providerInstanceId: string;
  readonly model: string;
  readonly updatedAt: string;
}

/** Bounded snapshot of non-idle Sessions; `complete: false` means more exist than were returned. */
export interface AgentRuntimeSessionActivitySnapshot {
  readonly sequence: number;
  readonly items: readonly AgentRuntimeSessionActivity[];
  readonly complete: boolean;
}

export type AgentRuntimeSessionActivityChange =
  | {
      readonly type: "upsert";
      readonly sequence: number;
      readonly activity: AgentRuntimeSessionActivity;
    }
  | { readonly type: "remove"; readonly sequence: number; readonly sessionId: string }
  /** Consumers discard local state and read a fresh snapshot. */
  | { readonly type: "reset"; readonly sequence: number };

/**
 * Claude subscription usage as Main last read it from the Claude Agents' own checks; every
 * window shows this one snapshot.
 */
export interface ClaudeUsageSnapshot {
  /** `loading`: nothing read yet. `ready`: the latest read answered. `unavailable`: it failed. */
  readonly status: "loading" | "ready" | "unavailable";
  /** The Claude Agents as last read, kept through a failed read; null before the first read. */
  readonly providers: AgentRuntimeOperations["providers.read"]["output"] | null;
  /** Why the latest read failed. */
  readonly reason: string | null;
}

/** Supervised execution process availability, independent of any one Session. */
export type AgentRuntimeConnectionState =
  /** Not running and nothing requires it; the next operation starts it. */
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | { readonly status: "ready"; readonly generation: string }
  | { readonly status: "restarting"; readonly attempt: number }
  | { readonly status: "failed"; readonly message: string };

export interface AgentRuntimeIpcApi {
  "agent-runtime:activity:read": {
    args: [];
    result: AgentRuntimeSessionActivitySnapshot;
  };
  "agent-runtime:connection:read": {
    args: [];
    result: AgentRuntimeConnectionState;
  };
  "agent-runtime:session:launch": {
    args: [input: AgentRuntimeLaunch];
    result: AgentRuntimeLaunchResult;
  };
  "agent-runtime:session:read": {
    args: [target: AgentRuntimeSessionTarget];
    result: AgentRuntimeConversation;
  };
  "agent-runtime:session:control": {
    args: [target: AgentRuntimeControlInput];
    result: AgentRuntimeConversation;
  };
  "agent-runtime:session:inspect": {
    args: [target: AgentRuntimeSessionTarget];
    result: AgentRuntimeInspection;
  };
  "agent-runtime:session:overview": {
    args: [input: AgentRuntimeOverviewInput];
    result: AgentRuntimeOperations["tasks.overview"]["output"];
  };
  "agent-runtime:session:message": {
    args: [input: AgentRuntimeMessageInput];
    result: { readonly sequence: number; readonly sideChatTitle?: string };
  };
  "agent-runtime:session:queue-message": {
    args: [input: AgentRuntimeMessageInput];
    result: { readonly sequence: number; readonly sideChatTitle?: string };
  };
  "agent-runtime:session:queue": {
    args: [input: AgentRuntimeQueueInput];
    result: { readonly sequence: number; readonly sideChatTitle?: string };
  };
  "agent-runtime:session:create-side-chat": {
    args: [input: AgentRuntimeSideChatCreateInput];
    result: AgentRuntimeLaunchResult;
  };
  "agent-runtime:session:discard-side-chat": {
    args: [input: AgentRuntimeSideChatDiscardInput];
    result: { readonly discarded: boolean };
  };
  "agent-runtime:session:save-side-chat": {
    args: [input: AgentRuntimeSideChatSaveInput];
    result: AgentRuntimeLaunchResult & { readonly sourceSessionId: string };
  };
  "agent-runtime:session:fork": {
    args: [input: AgentRuntimeForkInput];
    result: AgentRuntimeLaunchResult & { readonly sourceSessionId: string };
  };
  "agent-runtime:session:merge-back": {
    args: [input: AgentRuntimeMergeBackInput];
    result: AgentRuntimeLaunchResult;
  };
  "agent-runtime:session:stop": {
    args: [input: AgentRuntimeStopInput];
    result: { readonly stopped: boolean };
  };
  "agent-runtime:session:respond": {
    args: [input: AgentRuntimeResponseInput];
    result: { readonly sequence: number };
  };
  "agent-runtime:session:set-modes": {
    args: [input: AgentRuntimeModeInput];
    result: { readonly changed: boolean };
  };
  "agent-runtime:session:compact": {
    args: [input: AgentRuntimeCompactInput];
    result: AgentRuntimeOperations["thread.compact"]["output"];
  };
  "agent-runtime:session:clear-context": {
    args: [input: AgentRuntimeClearContextInput];
    result: { readonly cleared: true };
  };
  "agent-runtime:session:rollback": {
    args: [input: AgentRuntimeRollbackInput];
    result: { readonly rolledBack: true };
  };
  "agent-runtime:session:retry-preparation": {
    args: [input: AgentRuntimePreparationRetryInput];
    result: { readonly retried: true };
  };
  "agent-runtime:session:stop-task": {
    args: [input: AgentRuntimeTaskStopInput];
    result: { readonly sequence: number };
  };
  "agent-runtime:session:stop-background": {
    args: [input: AgentRuntimeBackgroundStopInput];
    result: { readonly stopping: readonly string[] };
  };
  "agent-runtime:session:background-output": {
    args: [input: AgentRuntimeBackgroundOutputInput];
    result: AgentRuntimeBackgroundOutput | null;
  };
  "agent-runtime:session:cancel-task": {
    args: [input: AgentRuntimeTaskCancelInput];
    result: { readonly taskId: string; readonly status: string };
  };
  "agent-runtime:session:move": {
    args: [input: AgentRuntimeSessionMoveInput];
    result: { readonly sessionId: string; readonly projectId: string | null };
  };
  "agent-runtime:session:history": {
    args: [input: AgentRuntimeHistoryInput];
    result: AgentHistoryPage;
  };
  "agent-runtime:session:prompt-index": {
    args: [input: AgentRuntimeSessionTarget];
    result: AgentRuntimePromptIndex;
  };
  "agent-runtime:session:queue-read": {
    args: [input: AgentRuntimeQueueReadInput];
    result: AgentRuntimeQueuePage;
  };
  "agent-runtime:session:queued-preview": {
    args: [input: AgentRuntimeRunInput];
    result: AgentRuntimeQueuedPreview;
  };
  "agent-runtime:session:run-message": {
    args: [input: AgentRuntimeRunInput];
    result: AgentRuntimeRunMessage;
  };
  "agent-runtime:session:item": {
    args: [input: AgentRuntimeItemInput];
    result: AgentTurnItem | null;
  };
  "agent-runtime:session:attachment": {
    args: [input: AgentRuntimeAttachmentInput];
    result: AgentRuntimeOperations["thread.attachment"]["output"];
  };
  "agent-runtime:providers:read": {
    args: [input?: AgentRuntimeOperations["providers.read"]["input"]];
    result: AgentRuntimeOperations["providers.read"]["output"];
  };
  /** The catalog Nodex already knows, never starting execution; null before the first live read. */
  "agent-runtime:providers:known": {
    args: [];
    result: AgentRuntimeOperations["providers.read"]["output"] | null;
  };
  "agent-runtime:claude-usage:read": { args: []; result: ClaudeUsageSnapshot };
  /** Reads Claude usage again now, unless it was read moments ago. */
  "agent-runtime:claude-usage:refresh": { args: []; result: ClaudeUsageSnapshot };
  "agent-runtime:claude-usage:logout": {
    args: [input: { readonly instanceIds: readonly string[] }];
    result: ClaudeUsageSnapshot;
  };
  "agent-runtime:session:observe": {
    args: [input: AgentRuntimeObserveInput];
    result: { readonly observed: true };
  };
  "agent-runtime:session:unobserve": {
    args: [input: { readonly subscriptionId: string }];
    result: { readonly unobserved: true };
  };
}

/** Main supplies fitted AgentPromptImage bytes in `images`, following the prompt in order. */
export type AgentRuntimeStructuredGenerationInput =
  AgentRuntimeOperations["text.generate-structured"]["input"];
