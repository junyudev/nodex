export interface AgentInteractionRequest {
  readonly id: string;
  readonly toolName: string;
  readonly title: string;
  readonly detail: string;
  readonly questions: readonly {
    readonly id: string;
    readonly question: string;
    readonly multiSelect: boolean;
    readonly options: readonly { readonly label: string; readonly description: string }[];
  }[];
}

export type AgentInteractionResponse =
  | { readonly decision: "allow" | "deny" }
  | { readonly decision: "answer"; readonly answers: Readonly<Record<string, string>> };

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

export type AgentCanonicalToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type AgentCanonicalSessionUpdate =
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
    };

export interface AgentConversationTurn {
  readonly sequence: number | null;
  readonly clientUserMessageId: string | null;
  readonly promptText: string | null;
  readonly updates: readonly AgentCanonicalSessionUpdate[];
  readonly stopReason: string | null;
}

export interface AgentConversationSnapshot {
  readonly backend: "acp" | "claude";
  readonly threadId: string;
  readonly sessionId: string;
  readonly status: AgentConversationStatus;
  readonly error: string | null;
  readonly requests?: readonly AgentInteractionRequest[];
  readonly turns: readonly AgentConversationTurn[];
  readonly revision: number;
}

export interface AgentConversationTurnDelta {
  readonly sequence: number | null;
  readonly clientUserMessageId: string | null;
  readonly promptText: string | null;
  readonly stopReason: string | null;
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
  readonly backend: "acp" | "claude";
  readonly threadId: string;
  readonly sessionId: string;
  readonly baseRevision: number;
  readonly revision: number;
  readonly status: AgentConversationStatus;
  readonly error: string | null;
  readonly requests?: readonly AgentInteractionRequest[];
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
    promptText: delta.promptText,
    updates,
    stopReason: delta.stopReason,
  };
};

/** Applies a delta only when it is the exact next value for this local replica. */
export const applyAgentConversationDelta = (
  snapshot: AgentConversationSnapshot,
  delta: AgentConversationDelta,
): AgentConversationSnapshot | null => {
  if (
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
