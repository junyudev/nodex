import type {
  AgentCommand,
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
  /** Structured editor input is authoritative; absent input permits standalone NFM lines. */
  readonly agentConfigs?: readonly import("./types").CodexPromptAgentConfigInput[];
}

export interface AgentRuntimeLaunch {
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

export interface AgentRuntimeSessionTarget {
  readonly sessionId: string;
  /** A descendant remains within the Session's explicitly bound root execution. */
  readonly threadId?: string;
}

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
  "node.updated",
  "runtime-request.updated",
  "subagent.updated",
  "provider-thread.updated",
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
export type AgentRuntimeStopInput = AgentRuntimeSessionTarget & { readonly runId: string };
export type AgentRuntimeResponseInput = AgentRuntimeSessionTarget &
  Pick<Respond, "requestId" | "decision" | "answers" | "attachmentsByQuestionId"> & {
    readonly runId: string | null;
  };
export type AgentRuntimeModelInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly modelSelection: CreateThread["modelSelection"];
};
export type AgentRuntimeModeInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly interactionMode?: CreateThread["interactionMode"];
};
export type AgentRuntimeCompactInput = AgentRuntimeSessionTarget & { readonly requestId: string };
export type AgentRuntimeQueueReadInput = AgentRuntimeSessionTarget & { readonly cursor?: string };
export type AgentRuntimeQueuePage = AgentRuntimeOperations["thread.queue"]["output"];
export type AgentRuntimeQueuedMessageInput = AgentRuntimeSessionTarget & { readonly runId: string };
export type AgentRuntimeQueuedPreview = AgentRuntimeOperations["thread.queued-preview"]["output"];
export type AgentRuntimeQueuedMessage = AgentRuntimeOperations["thread.queued-message"]["output"];
export type AgentRuntimeRollbackInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly runId: string;
};
export type AgentRuntimeTaskStopInput = AgentRuntimeSessionTarget & {
  readonly requestId: string;
  readonly runId: string;
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
    | { readonly action: "resume" }
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
  readonly activeTaskCount: number;
  readonly resumesAutomatically: boolean;
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
    args: [target: AgentRuntimeSessionTarget];
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
    result: { readonly sequence: number };
  };
  "agent-runtime:session:queue-message": {
    args: [input: AgentRuntimeMessageInput];
    result: { readonly sequence: number };
  };
  "agent-runtime:session:queue": {
    args: [input: AgentRuntimeQueueInput];
    result: { readonly sequence: number };
  };
  "agent-runtime:session:fork": {
    args: [input: AgentRuntimeForkInput];
    result: AgentRuntimeLaunchResult & { readonly sourceSessionId: string };
  };
  "agent-runtime:session:stop": {
    args: [input: AgentRuntimeStopInput];
    result: { readonly stopped: boolean };
  };
  "agent-runtime:session:respond": {
    args: [input: AgentRuntimeResponseInput];
    result: { readonly sequence: number };
  };
  "agent-runtime:session:set-model": {
    args: [input: AgentRuntimeModelInput];
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
  "agent-runtime:session:move": {
    args: [input: AgentRuntimeSessionMoveInput];
    result: { readonly sessionId: string; readonly projectId: string | null };
  };
  "agent-runtime:session:history": {
    args: [input: AgentRuntimeHistoryInput];
    result: AgentHistoryPage;
  };
  "agent-runtime:session:queue-read": {
    args: [input: AgentRuntimeQueueReadInput];
    result: AgentRuntimeQueuePage;
  };
  "agent-runtime:session:queued-preview": {
    args: [input: AgentRuntimeQueuedMessageInput];
    result: AgentRuntimeQueuedPreview;
  };
  "agent-runtime:session:queued-message": {
    args: [input: AgentRuntimeQueuedMessageInput];
    result: AgentRuntimeQueuedMessage;
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
  "agent-runtime:session:observe": {
    args: [input: AgentRuntimeObserveInput];
    result: { readonly observed: true };
  };
  "agent-runtime:session:unobserve": {
    args: [input: { readonly subscriptionId: string }];
    result: { readonly unobserved: true };
  };
}

export type AgentRuntimeStructuredGenerationInput =
  AgentRuntimeOperations["text.generate-structured"]["input"];
