export interface AgentInteractionRequest {
  readonly id: string;
  readonly toolName: string;
  readonly title: string;
  readonly detail: string;
  readonly kind?: "tool" | "dialog" | "elicitation";
  readonly toolUseId?: string;
  readonly actor?: AgentConversationActor;
  readonly blockedPath?: string;
  readonly decisionReason?: string;
  readonly mcpServer?: { readonly name: string; readonly source?: string };
  readonly displayName?: string;
  readonly description?: string;
  readonly constraints?: {
    readonly defaultToNo?: boolean;
    readonly suppressAlwaysAllowRule?: boolean;
    readonly allowForSession?: boolean;
  };
  readonly dialog?: { readonly kind: string; readonly payload: Readonly<Record<string, unknown>> };
  readonly elicitation?: {
    readonly mode: "form" | "url";
    readonly message: string;
    readonly requestedSchema?: Readonly<Record<string, unknown>>;
    readonly url?: string;
    readonly elicitationId?: string;
  };
  readonly questions: readonly {
    readonly id: string;
    readonly question: string;
    readonly header?: string;
    readonly multiSelect: boolean;
    readonly options: readonly { readonly label: string; readonly description: string }[];
  }[];
}

export type AgentInteractionResponse =
  | { readonly decision: "allow" | "allow-for-session" | "deny" }
  | { readonly decision: "answer"; readonly answers: Readonly<Record<string, string>> }
  | { readonly decision: "dialog"; readonly result: unknown }
  | {
      readonly decision: "elicitation";
      readonly action: "accept" | "decline" | "cancel";
      readonly content?: Readonly<Record<string, unknown>>;
    };

/** Prepared by Main from owned assets; never accepted directly from renderer controls. */
export interface AgentPromptImage {
  readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly data: string;
}

export type AgentConversationStatus =
  | "idle"
  | "running"
  | "authentication-required"
  | "failed"
  | "closed";

export type AgentCanonicalToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export type AgentCanonicalToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentConversationActor {
  readonly taskId?: string;
  readonly parentToolUseId?: string;
  readonly agentId?: string;
}

export interface AgentConversationTokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

export interface AgentConversationTask {
  readonly id: string;
  readonly bornTurnSequence: number | null;
  readonly toolUseId?: string;
  readonly parentTaskId?: string;
  readonly agentId?: string;
  readonly description: string;
  readonly taskType?: string;
  readonly spawnDepth?: number;
  readonly workflowName?: string;
  readonly role?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly status: "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";
  readonly backgrounded?: boolean;
  readonly ambient?: boolean;
  readonly hidden?: boolean;
  readonly summary?: string;
  readonly outputFile?: string;
  readonly error?: string;
  readonly lastToolName?: string;
  readonly elapsedSeconds?: number;
  readonly usage?: AgentConversationTokenUsage & {
    readonly totalTokens?: number;
    readonly toolUses?: number;
  };
  readonly resourceLinks?: readonly { readonly uri: string; readonly name?: string }[];
}

interface AgentCanonicalUpdateIdentity {
  readonly truncated?: boolean;
  readonly actor?: AgentConversationActor;
  /** SDK record UUIDs are distinct from API message IDs and support native retractions. */
  readonly recordIds?: readonly string[];
}

export type AgentCanonicalSessionUpdate = AgentCanonicalUpdateIdentity &
  (
    | {
        readonly kind: "message";
        readonly key: string;
        readonly role: "user" | "agent" | "thought" | "compaction";
        readonly messageId: string | null;
        readonly text: string;
      }
    | {
        readonly kind: "tool-call";
        readonly key: string;
        readonly toolCallId: string;
        readonly title: string;
        readonly name: string | null;
        readonly toolKind: AgentCanonicalToolKind | null;
        readonly status: AgentCanonicalToolCallStatus;
        readonly detail: string;
        readonly input?: string;
        readonly locations: readonly string[];
        readonly output?: unknown;
        /** Native user record containing this result, for authority-bound lazy expansion. */
        readonly outputRecordId?: string;
        readonly presentation?:
          | "command"
          | "file-change"
          | "search"
          | "image"
          | "web-search"
          | "mcp"
          | "generic";
        readonly elapsedSeconds?: number;
        readonly progress?: string;
        readonly changes?: readonly {
          readonly path: string;
          readonly kind: "add" | "update" | "delete";
          readonly diff?: string;
        }[];
        readonly resources?: readonly {
          readonly uri: string;
          readonly name?: string;
          readonly mimeType?: string;
        }[];
      }
    | {
        readonly kind: "plan";
        readonly key: string;
        readonly planId: string | null;
        readonly state: "present" | "removed";
        readonly entries: readonly {
          readonly content: string;
          readonly priority: "high" | "medium" | "low";
          readonly status: "pending" | "in_progress" | "completed";
        }[];
        readonly markdown: string | null;
        readonly uri: string | null;
      }
    | {
        readonly kind: "mode";
        readonly key: "mode";
        readonly currentModeId: string;
      }
    | {
        readonly kind: "config";
        readonly key: "config";
        readonly optionIds: readonly string[];
      }
    | {
        readonly kind: "session-info";
        readonly key: "session-info";
        readonly title: string | null;
        readonly updatedAt: string | null;
      }
    | {
        readonly kind: "usage";
        readonly key: "usage";
        readonly used: number;
        readonly size: number;
        readonly cost: { readonly amount: number; readonly currency: string } | null;
        readonly tokens?: AgentConversationTokenUsage;
        readonly cumulativeTokens?: AgentConversationTokenUsage;
        readonly model?: string;
        readonly contextEstimated?: boolean;
      }
    | {
        readonly kind: "commands";
        readonly key: "commands";
        readonly commands: readonly {
          readonly name: string;
          readonly description: string;
          readonly inputHint: string | null;
        }[];
      }
    | {
        readonly kind: "compaction";
        readonly key: string;
        readonly compactionId: string;
        readonly status: string;
        readonly summary: string;
        readonly error: string | null;
        readonly trigger?: "manual" | "auto";
        readonly preTokens?: number;
        readonly postTokens?: number;
        readonly durationMs?: number;
      }
    | {
        readonly kind: "rate-limit";
        readonly key: string;
        readonly status: "allowed" | "allowed_warning" | "rejected";
        readonly limitType?: string;
        readonly resetsAt?: number;
        readonly utilization?: number;
        readonly overageStatus?: string;
        readonly overageReason?: string;
        readonly usingOverage?: boolean;
      }
    | {
        readonly kind: "diagnostic";
        readonly key: string;
        readonly severity: "info" | "warning" | "error";
        readonly code: string;
        readonly message: string;
        readonly details?: Readonly<Record<string, unknown>>;
      }
  );

export interface AgentConversationTurn {
  readonly sequence: number | null;
  readonly clientUserMessageId: string | null;
  readonly nativeUserMessageId?: string;
  readonly promptText: string | null;
  readonly promptImages?: readonly import("./agent-history-images").AgentPromptImageDescriptor[];
  readonly updates: readonly AgentCanonicalSessionUpdate[];
  readonly stopReason: string | null;
  readonly status?: "running" | "completed" | "failed" | "cancelled";
  readonly error?: string | null;
  readonly createdAt?: string;
  readonly completedAt?: string;
}

/** Durable observations join native history by UUID; they contain no transcript or media bytes. */
export interface AgentHistoryFact {
  readonly clientUserMessageId: string;
  readonly nativeUserMessageId?: string;
  readonly stopReason: string | null;
  readonly error?: string | null;
  readonly createdAt?: string;
  readonly completedAt?: string;
  readonly usage?: Omit<Extract<AgentCanonicalSessionUpdate, { kind: "usage" }>, "kind" | "key">;
  readonly compactions?: readonly {
    readonly compactionId: string;
    readonly status: string;
    readonly summary?: string;
    readonly error?: string | null;
    readonly trigger?: "manual" | "auto";
    readonly preTokens?: number;
    readonly postTokens?: number;
    readonly durationMs?: number;
  }[];
  readonly artifacts?: readonly {
    readonly filename: string;
    readonly fileId?: string;
    readonly error?: string;
  }[];
}

export interface AgentConversationSnapshot {
  readonly backend: "acp" | "claude";
  readonly threadId: string;
  readonly sessionId: string;
  readonly status: AgentConversationStatus;
  readonly error: string | null;
  readonly requests?: readonly AgentInteractionRequest[];
  readonly metadata?: AgentSessionMetadata;
  readonly tasks?: readonly AgentConversationTask[];
  /** Native level signal; undefined means this CLI has not advertised a level snapshot. */
  readonly liveBackgroundTaskIds?: readonly string[];
  readonly toolCalls?: readonly {
    readonly turnSequence: number | null;
    readonly update: Extract<AgentCanonicalSessionUpdate, { kind: "tool-call" }>;
  }[];
  readonly history?: {
    readonly hasOlder: boolean;
    readonly oldestSequence: number | null;
    readonly cursor?: string;
    readonly windowSize?: number;
    /** The bounded read window cannot retain another older turn without evicting current content. */
    readonly windowFull?: boolean;
  };
  readonly turns: readonly AgentConversationTurn[];
  readonly revision: number;
}

export interface AgentConversationTurnDelta {
  readonly sequence: number | null;
  readonly clientUserMessageId: string | null;
  readonly nativeUserMessageId?: string;
  readonly promptText: string | null;
  readonly promptImages?: readonly import("./agent-history-images").AgentPromptImageDescriptor[];
  readonly stopReason: string | null;
  readonly status?: AgentConversationTurn["status"];
  readonly error?: string | null;
  readonly createdAt?: string;
  readonly completedAt?: string;
  readonly removedUpdateKeys: readonly string[];
  readonly updates: readonly AgentConversationUpdateDelta[];
}

export type AgentConversationUpdateDelta =
  | {
      readonly kind: "replace";
      readonly update: AgentCanonicalSessionUpdate;
    }
  | {
      readonly kind: "append-message";
      readonly key: string;
      readonly text: string;
    };

/**
 * One exact, consecutive mutation of a canonical Agent snapshot. Deltas never carry
 * raw protocol values and are rejected unless they continue the receiver's exact
 * session and revision.
 */
export interface AgentConversationDelta {
  /** Explicit invalidation: query the exact snapshot rather than apply a partial oversized delta. */
  readonly resync?: true;
  readonly backend: "acp" | "claude";
  readonly threadId: string;
  readonly sessionId: string;
  readonly baseRevision: number;
  readonly revision: number;
  readonly status: AgentConversationStatus;
  readonly error: string | null;
  readonly requests?: readonly AgentInteractionRequest[];
  readonly metadata?: AgentSessionMetadata;
  readonly tasks?: readonly AgentConversationTask[];
  readonly liveBackgroundTaskIds?: readonly string[];
  readonly toolCalls?: AgentConversationSnapshot["toolCalls"];
  readonly history?: AgentConversationSnapshot["history"];
  readonly removedTurnSequences: readonly (number | null)[];
  readonly turns: readonly AgentConversationTurnDelta[];
}

const updateSnapshotTurn = (
  current: AgentConversationTurn | undefined,
  delta: AgentConversationTurnDelta,
): AgentConversationTurn | null => {
  const removed = new Set(delta.removedUpdateKeys);
  const updates = (current?.updates ?? []).filter(({ key }) => !removed.has(key));
  for (const incoming of delta.updates) {
    const key = incoming.kind === "replace" ? incoming.update.key : incoming.key;
    const existingIndex = updates.findIndex((update) => update.key === key);
    if (incoming.kind === "append-message") {
      const existing = updates[existingIndex];
      if (existingIndex < 0 || existing?.kind !== "message") return null;
      updates[existingIndex] = { ...existing, text: `${existing.text}${incoming.text}` };
      continue;
    }
    if (existingIndex < 0) {
      updates.push(incoming.update);
      continue;
    }
    updates[existingIndex] = incoming.update;
  }
  if (new Set(updates.map(({ key }) => key)).size !== updates.length) return null;
  return {
    sequence: delta.sequence,
    clientUserMessageId: delta.clientUserMessageId,
    nativeUserMessageId: delta.nativeUserMessageId,
    promptText: delta.promptText,
    promptImages: delta.promptImages,
    updates,
    stopReason: delta.stopReason,
    status: delta.status,
    error: delta.error,
    createdAt: delta.createdAt,
    completedAt: delta.completedAt,
  };
};

/** Applies a delta only when it is the exact next value for this local replica. */
export const applyAgentConversationDelta = (
  snapshot: AgentConversationSnapshot,
  delta: AgentConversationDelta,
): AgentConversationSnapshot | null => {
  if (
    delta.resync ||
    delta.backend !== snapshot.backend ||
    snapshot.threadId !== delta.threadId ||
    snapshot.sessionId !== delta.sessionId ||
    snapshot.revision !== delta.baseRevision ||
    delta.revision !== delta.baseRevision + 1
  ) {
    return null;
  }

  const removedTurns = new Set(delta.removedTurnSequences);
  const turns = snapshot.turns.filter(({ sequence }) => !removedTurns.has(sequence));
  for (const turnDelta of delta.turns) {
    const existingIndex = turns.findIndex(({ sequence }) => sequence === turnDelta.sequence);
    const nextTurn = updateSnapshotTurn(
      existingIndex < 0 ? undefined : turns[existingIndex],
      turnDelta,
    );
    if (!nextTurn) return null;
    if (existingIndex < 0) {
      turns.push(nextTurn);
      continue;
    }
    turns[existingIndex] = nextTurn;
  }
  if (new Set(turns.map(({ sequence }) => sequence)).size !== turns.length) return null;

  return {
    ...snapshot,
    status: delta.status,
    error: delta.error,
    ...(delta.requests === undefined ? {} : { requests: delta.requests }),
    ...(delta.metadata === undefined ? {} : { metadata: delta.metadata }),
    ...(delta.tasks === undefined ? {} : { tasks: delta.tasks }),
    ...(delta.liveBackgroundTaskIds === undefined
      ? {}
      : { liveBackgroundTaskIds: delta.liveBackgroundTaskIds }),
    ...(delta.toolCalls === undefined ? {} : { toolCalls: delta.toolCalls }),
    ...(delta.history === undefined ? {} : { history: delta.history }),
    turns,
    revision: delta.revision,
  };
};

export interface AgentBackendSessionPresentation {
  readonly snapshot: AgentConversationSnapshot;
  readonly capabilities: AgentBackendCapabilityProfile;
  readonly modes: AgentSessionModeState | null;
  readonly configOptions: readonly AgentSessionConfigOption[];
}

export interface AgentAuthenticationMethod {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: "agent" | "terminal";
}

export interface AgentSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface AgentSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: readonly AgentSessionMode[];
}

export interface AgentSessionConfigSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description: string | null;
  /** Advertised reasoning controls when this option selects a model. */
  readonly reasoningEfforts?: readonly string[];
  readonly fastMode?: boolean;
  readonly adaptiveThinking?: boolean;
  readonly disableThinking?: boolean;
  readonly disabledThinkingEfforts?: readonly string[];
  readonly contextWindows?: readonly string[];
}

export interface AgentSessionConfigSelectGroup {
  readonly group: string;
  readonly name: string;
  readonly options: readonly AgentSessionConfigSelectOption[];
}

interface AgentSessionConfigOptionBase {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
}

export type AgentSessionConfigOption =
  | (AgentSessionConfigOptionBase & {
      readonly type: "boolean";
      readonly currentValue: boolean;
    })
  | (AgentSessionConfigOptionBase & {
      readonly type: "select";
      readonly currentValue: string;
      readonly options: readonly (AgentSessionConfigSelectOption | AgentSessionConfigSelectGroup)[];
    });

export interface AgentBackendCapabilityProfile {
  readonly controls?: {
    readonly steer?: boolean;
    readonly compact?: boolean;
    readonly rollback?: boolean;
    readonly fork?: boolean;
    readonly stopTask?: boolean;
  };
  readonly prompt: {
    readonly text: true;
    readonly resourceLink: true;
    readonly image: boolean;
    readonly audio: boolean;
    readonly embeddedContext: boolean;
  };
  readonly session: {
    readonly load: boolean;
    readonly list: boolean;
    readonly delete: boolean;
    readonly resume: boolean;
    readonly unstableFork: boolean;
    readonly close: boolean;
    readonly additionalDirectories: boolean;
  };
  readonly authMethods: readonly AgentAuthenticationMethod[];
}

/** Native observations published with the same revision as the transcript. */
export interface AgentSessionMetadata {
  readonly revision: number;
  readonly configOptions: readonly AgentSessionConfigOption[];
  readonly modes: AgentSessionModeState | null;
  readonly capabilities: AgentBackendCapabilityProfile;
  readonly permissionMode?: import("./agent-backend-api").NativePermissionMode;
  readonly effectiveSelection?: {
    readonly model: string | null;
    readonly effort: string | null;
    readonly fast?: boolean | null;
    readonly thinking?: boolean | null;
    readonly permissionMode?: string;
  };
  readonly requestedSelection?: {
    readonly model: string;
    readonly effort: string;
    readonly fast?: boolean;
    readonly thinking?: boolean;
    readonly context?: string;
  };
  readonly requestedMode?: "default" | "plan";
  readonly commands?: readonly {
    readonly name: string;
    readonly description: string;
    readonly inputHint: string | null;
  }[];
  readonly diagnostics?: readonly {
    readonly severity: "info" | "warning" | "error";
    readonly code: string;
    readonly message: string;
  }[];
}

export const isAgentConversationTaskLive = (task: AgentConversationTask): boolean =>
  task.status === "pending" || task.status === "running" || task.status === "paused";

/** A background level roster is authoritative even when a terminal bookend was missed. */
export const isAgentConversationTaskLiveInSnapshot = (
  task: AgentConversationTask,
  snapshot: Pick<AgentConversationSnapshot, "liveBackgroundTaskIds">,
): boolean => {
  if (!isAgentConversationTaskLive(task)) return false;
  if (!task.backgrounded || snapshot.liveBackgroundTaskIds === undefined) return true;
  return snapshot.liveBackgroundTaskIds.includes(task.id);
};
