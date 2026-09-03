export type AcpConversationStatus =
  | "idle"
  | "running"
  | "authentication-required"
  | "failed"
  | "closed";

export type AcpCanonicalToolKind =
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

export type AcpCanonicalToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export type AcpCanonicalSessionUpdate =
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
      readonly toolKind: AcpCanonicalToolKind | null;
      readonly status: AcpCanonicalToolCallStatus;
      readonly detail: string;
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

export interface AcpConversationTurn {
  readonly sequence: number | null;
  readonly clientUserMessageId: string | null;
  readonly promptText: string | null;
  readonly updates: readonly AcpCanonicalSessionUpdate[];
  readonly stopReason: string | null;
}

export interface AcpConversationSnapshot {
  readonly backend: "acp";
  readonly threadId: string;
  readonly sessionId: string;
  readonly status: AcpConversationStatus;
  readonly error: string | null;
  readonly turns: readonly AcpConversationTurn[];
  readonly revision: number;
}

export interface AcpConversationTurnDelta {
  readonly sequence: number | null;
  readonly clientUserMessageId: string | null;
  readonly promptText: string | null;
  readonly stopReason: string | null;
  readonly removedUpdateKeys: readonly string[];
  readonly updates: readonly AcpConversationUpdateDelta[];
}

export type AcpConversationUpdateDelta =
  | {
      readonly kind: "replace";
      readonly update: AcpCanonicalSessionUpdate;
    }
  | {
      readonly kind: "append-message";
      readonly key: string;
      readonly text: string;
    };

/**
 * One exact, consecutive mutation of a canonical ACP snapshot. Deltas never carry
 * raw protocol values and are rejected unless they continue the receiver's exact
 * session and revision.
 */
export interface AcpConversationDelta {
  readonly backend: "acp";
  readonly threadId: string;
  readonly sessionId: string;
  readonly baseRevision: number;
  readonly revision: number;
  readonly status: AcpConversationStatus;
  readonly error: string | null;
  readonly removedTurnSequences: readonly (number | null)[];
  readonly turns: readonly AcpConversationTurnDelta[];
}

const updateSnapshotTurn = (
  current: AcpConversationTurn | undefined,
  delta: AcpConversationTurnDelta,
): AcpConversationTurn | null => {
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
export const applyAcpConversationDelta = (
  snapshot: AcpConversationSnapshot,
  delta: AcpConversationDelta,
): AcpConversationSnapshot | null => {
  if (
    delta.backend !== "acp" ||
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
    turns,
    revision: delta.revision,
  };
};

export interface AcpBackendSessionPresentation {
  readonly snapshot: AcpConversationSnapshot;
  readonly capabilities: AcpBackendCapabilityProfile;
  readonly modes: AcpSessionModeState | null;
  readonly configOptions: readonly AcpSessionConfigOption[];
}

export interface AcpAuthenticationMethod {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: "agent" | "terminal";
}

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
}

export interface AcpSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: readonly AcpSessionMode[];
}

export interface AcpSessionConfigSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description: string | null;
}

export interface AcpSessionConfigSelectGroup {
  readonly group: string;
  readonly name: string;
  readonly options: readonly AcpSessionConfigSelectOption[];
}

interface AcpSessionConfigOptionBase {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly category: string | null;
}

export type AcpSessionConfigOption =
  | (AcpSessionConfigOptionBase & {
      readonly type: "boolean";
      readonly currentValue: boolean;
    })
  | (AcpSessionConfigOptionBase & {
      readonly type: "select";
      readonly currentValue: string;
      readonly options: readonly (AcpSessionConfigSelectOption | AcpSessionConfigSelectGroup)[];
    });

export interface AcpBackendCapabilityProfile {
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
  readonly authMethods: readonly AcpAuthenticationMethod[];
}
