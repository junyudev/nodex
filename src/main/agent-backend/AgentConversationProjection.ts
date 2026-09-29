import type {
  AgentCanonicalSessionUpdate,
  AgentConversationDelta,
  AgentConversationSnapshot,
  AgentConversationStatus,
  AgentConversationTurn,
  AgentConversationUpdateDelta,
} from "../../shared/agent-conversation";
export const AGENT_CONVERSATION_MAX_TURNS = 64;
export const AGENT_CONVERSATION_MAX_UPDATES_PER_TURN = 128;
export const AGENT_CONVERSATION_MAX_TURN_BYTES = 512 * 1024;
export const AGENT_CONVERSATION_MAX_SESSION_BYTES = 2 * 1024 * 1024;
export const AGENT_CONVERSATION_MAX_DELTA_BYTES = 1024 * 1024;
const MAX_TEXT_CHARACTERS = 64 * 1024;

const boundedString = (value: string, maximum = MAX_TEXT_CHARACTERS): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum)}\n[output truncated]`;

export type AgentSessionEvent =
  | {
      readonly kind: "session_update";
      readonly turnSequence: number | null;
      readonly update: AgentCanonicalSessionUpdate;
      readonly append?: boolean;
    }
  | { readonly kind: "turn_stopped"; readonly turnSequence: number; readonly stopReason: string };

const mergeUpdate = (
  previous: AgentCanonicalSessionUpdate,
  incoming: AgentCanonicalSessionUpdate,
): AgentCanonicalSessionUpdate => {
  if (previous.kind === "message" && incoming.kind === "message") {
    return { ...incoming, text: boundedString(`${previous.text}${incoming.text}`) };
  }
  if (previous.kind === "tool-call" && incoming.kind === "tool-call") {
    return {
      ...previous,
      ...incoming,
      title: incoming.title === "Tool call" ? previous.title : incoming.title,
      name: incoming.name ?? previous.name,
      toolKind: incoming.toolKind ?? previous.toolKind,
      status: incoming.status,
      detail: incoming.detail || previous.detail,
      locations: incoming.locations.length > 0 ? incoming.locations : previous.locations,
    };
  }
  return incoming;
};

const reduceUpdate = (
  updates: readonly AgentCanonicalSessionUpdate[],
  incoming: AgentCanonicalSessionUpdate,
  append: boolean,
): readonly AgentCanonicalSessionUpdate[] => {
  const existingIndex = updates.findIndex((entry) => entry.key === incoming.key);
  if (existingIndex >= 0) {
    const next = [...updates];
    next[existingIndex] = append ? mergeUpdate(next[existingIndex]!, incoming) : incoming;
    return next;
  }
  return [...updates, incoming].slice(-AGENT_CONVERSATION_MAX_UPDATES_PER_TURN);
};

const encodedBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

const truncateStringToFit = <Value>(
  value: string,
  maximumBytes: number,
  build: (text: string) => Value,
): Value => {
  if (encodedBytes(build(value)) <= maximumBytes) return build(value);
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (encodedBytes(build(value.slice(0, middle))) <= maximumBytes) lower = middle;
    else upper = middle - 1;
  }
  return build(value.slice(0, lower));
};

const boundCanonicalUpdate = (
  update: AgentCanonicalSessionUpdate,
  maximumBytes: number,
): AgentCanonicalSessionUpdate => {
  if (encodedBytes(update) <= maximumBytes) return update;
  switch (update.kind) {
    case "message":
      return truncateStringToFit(update.text, maximumBytes, (text) => ({ ...update, text }));
    case "tool-call": {
      let candidate = update;
      while (candidate.locations.length > 0 && encodedBytes(candidate) > maximumBytes) {
        candidate = { ...candidate, locations: candidate.locations.slice(0, -1) };
      }
      if (encodedBytes(candidate) <= maximumBytes) return candidate;
      candidate = truncateStringToFit(candidate.detail, maximumBytes, (detail) => ({
        ...candidate,
        detail,
      }));
      if (encodedBytes(candidate) <= maximumBytes || candidate.input === undefined)
        return candidate;
      return truncateStringToFit(candidate.input, maximumBytes, (input) => ({
        ...candidate,
        input,
      }));
    }
    case "plan": {
      let candidate = update;
      while (candidate.entries.length > 0 && encodedBytes(candidate) > maximumBytes) {
        candidate = { ...candidate, entries: candidate.entries.slice(0, -1) };
      }
      if (encodedBytes(candidate) <= maximumBytes || candidate.markdown === null) return candidate;
      return truncateStringToFit(candidate.markdown, maximumBytes, (markdown) => ({
        ...candidate,
        markdown,
      }));
    }
    case "commands": {
      let candidate = update;
      while (candidate.commands.length > 0 && encodedBytes(candidate) > maximumBytes) {
        candidate = { ...candidate, commands: candidate.commands.slice(0, -1) };
      }
      return candidate;
    }
    case "config": {
      let candidate = update;
      while (candidate.optionIds.length > 0 && encodedBytes(candidate) > maximumBytes) {
        candidate = { ...candidate, optionIds: candidate.optionIds.slice(0, -1) };
      }
      return candidate;
    }
    case "compaction": {
      const withoutError = { ...update, error: null };
      if (encodedBytes(withoutError) <= maximumBytes) return withoutError;
      return truncateStringToFit(withoutError.summary, maximumBytes, (summary) => ({
        ...withoutError,
        summary,
      }));
    }
    case "mode":
    case "session-info":
    case "usage":
      return update;
  }
};

const boundTurn = (turn: AgentConversationTurn): AgentConversationTurn => {
  let candidate = turn;
  if (
    encodedBytes(candidate) > AGENT_CONVERSATION_MAX_TURN_BYTES &&
    candidate.promptText !== null
  ) {
    candidate = truncateStringToFit(
      candidate.promptText,
      AGENT_CONVERSATION_MAX_TURN_BYTES,
      (promptText) => ({ ...candidate, promptText }),
    );
  }
  let updates = [...candidate.updates]
    .slice(-AGENT_CONVERSATION_MAX_UPDATES_PER_TURN)
    .map((update) => boundCanonicalUpdate(update, AGENT_CONVERSATION_MAX_TURN_BYTES));
  while (
    updates.length > 1 &&
    encodedBytes({ ...candidate, updates }) > AGENT_CONVERSATION_MAX_TURN_BYTES
  ) {
    updates = updates.slice(1);
  }
  if (
    updates.length === 1 &&
    encodedBytes({ ...candidate, updates }) > AGENT_CONVERSATION_MAX_TURN_BYTES
  ) {
    const fixedBytes = encodedBytes({ ...candidate, updates: [] });
    const updateBudget = Math.max(1_024, AGENT_CONVERSATION_MAX_TURN_BYTES - fixedBytes - 16);
    updates = [boundCanonicalUpdate(updates[0]!, updateBudget)];
  }
  const bounded = { ...candidate, updates };
  if (encodedBytes(bounded) <= AGENT_CONVERSATION_MAX_TURN_BYTES) return bounded;
  if (bounded.promptText === null) return { ...bounded, updates: [] };
  return truncateStringToFit(
    bounded.promptText,
    AGENT_CONVERSATION_MAX_TURN_BYTES,
    (promptText) => ({
      ...bounded,
      promptText,
    }),
  );
};

export const boundAgentConversationTurns = (
  turns: readonly AgentConversationTurn[],
): readonly AgentConversationTurn[] => {
  let bounded = turns.slice(-AGENT_CONVERSATION_MAX_TURNS).map(boundTurn);
  while (bounded.length > 1 && encodedBytes(bounded) > AGENT_CONVERSATION_MAX_SESSION_BYTES) {
    bounded = bounded.slice(1);
  }
  if (encodedBytes(bounded) <= AGENT_CONVERSATION_MAX_SESSION_BYTES) return bounded;
  const last = bounded.at(-1);
  if (!last) return [];
  let updates = [...last.updates];
  while (
    updates.length > 0 &&
    encodedBytes([{ ...last, updates }]) > AGENT_CONVERSATION_MAX_SESSION_BYTES
  ) {
    updates = updates.slice(1);
  }
  return [{ ...last, updates }];
};

export const emptyAgentConversationSnapshot = (input: {
  readonly threadId: string;
  readonly sessionId: string;
  readonly backend?: "acp" | "claude";
}): AgentConversationSnapshot => ({
  backend: input.backend ?? "acp",
  threadId: input.threadId,
  sessionId: input.sessionId,
  status: "idle",
  error: null,
  turns: [],
  revision: 0,
});

export const beginAgentConversationTurn = (
  snapshot: AgentConversationSnapshot,
  sequence: number,
  prompt: string,
  clientUserMessageId: string | null = null,
): AgentConversationSnapshot => {
  if (snapshot.status === "closed") return snapshot;
  return {
    ...snapshot,
    status: "running",
    error: null,
    revision: snapshot.revision + 1,
    turns: boundAgentConversationTurns([
      ...snapshot.turns.filter(({ sequence: candidate }) => candidate !== sequence),
      {
        sequence,
        clientUserMessageId,
        promptText: boundedString(prompt),
        updates: [],
        stopReason: null,
      },
    ]),
  };
};

export const rebindAgentConversationSession = (
  snapshot: AgentConversationSnapshot,
  sessionId: string,
): AgentConversationSnapshot =>
  snapshot.status === "closed" || snapshot.sessionId === sessionId
    ? snapshot
    : { ...snapshot, sessionId, revision: snapshot.revision + 1 };

export const recoverAgentConversationTurnFailure = (
  snapshot: AgentConversationSnapshot,
  error: unknown,
  status: Extract<AgentConversationStatus, "idle" | "authentication-required">,
): AgentConversationSnapshot =>
  snapshot.status === "closed" || snapshot.status === "failed"
    ? snapshot
    : {
        ...snapshot,
        status,
        error: boundedString(error instanceof Error ? error.message : String(error), 8_192),
        revision: snapshot.revision + 1,
      };

export const completeAgentConversationAuthentication = (
  snapshot: AgentConversationSnapshot,
  sessionId: string,
): AgentConversationSnapshot =>
  snapshot.status === "closed" || snapshot.status === "failed"
    ? snapshot
    : {
        ...snapshot,
        sessionId,
        status: "idle",
        error: null,
        revision: snapshot.revision + 1,
      };

export const failAgentConversation = (
  snapshot: AgentConversationSnapshot,
  error: unknown,
): AgentConversationSnapshot =>
  snapshot.status === "closed"
    ? snapshot
    : {
        ...snapshot,
        status: "failed",
        error: boundedString(error instanceof Error ? error.message : String(error), 8_192),
        revision: snapshot.revision + 1,
      };

export const closeAgentConversation = (
  snapshot: AgentConversationSnapshot,
): AgentConversationSnapshot =>
  snapshot.status === "closed"
    ? snapshot
    : { ...snapshot, status: "closed", revision: snapshot.revision + 1 };

export const reduceAgentConversationEvent = (
  snapshot: AgentConversationSnapshot,
  event: AgentSessionEvent,
): AgentConversationSnapshot => {
  if (snapshot.status === "closed") return snapshot;
  const existingIndex = snapshot.turns.findIndex(({ sequence }) => sequence === event.turnSequence);
  const fallback: AgentConversationTurn = {
    sequence: event.turnSequence,
    clientUserMessageId: null,
    promptText: null,
    updates: [],
    stopReason: null,
  };
  const selected = existingIndex >= 0 ? snapshot.turns[existingIndex]! : fallback;
  const turn =
    event.kind === "session_update"
      ? {
          ...selected,
          updates: reduceUpdate(selected.updates, event.update, event.append ?? false),
        }
      : { ...selected, stopReason: event.stopReason };
  const turns =
    existingIndex >= 0
      ? snapshot.turns.map((entry, index) => (index === existingIndex ? turn : entry))
      : [...snapshot.turns, turn];
  return {
    ...snapshot,
    status: event.kind === "turn_stopped" ? "idle" : snapshot.status,
    error: null,
    turns: boundAgentConversationTurns(turns),
    revision: snapshot.revision + 1,
  };
};

const equalUpdate = (
  previous: AgentCanonicalSessionUpdate | undefined,
  next: AgentCanonicalSessionUpdate,
): boolean => previous === next || JSON.stringify(previous) === JSON.stringify(next);

/** Builds the exact consecutive transport delta between two canonical snapshots. */
export const diffAgentConversationSnapshots = (
  previous: AgentConversationSnapshot,
  next: AgentConversationSnapshot,
): AgentConversationDelta | null => {
  if (
    previous.threadId !== next.threadId ||
    previous.sessionId !== next.sessionId ||
    next.revision !== previous.revision + 1
  ) {
    return null;
  }
  const removedTurnSequences = previous.turns
    .filter(({ sequence }) => !next.turns.some((candidate) => candidate.sequence === sequence))
    .map(({ sequence }) => sequence);
  const turns = next.turns.flatMap((turn) => {
    const existing = previous.turns.find(({ sequence }) => sequence === turn.sequence);
    const removedUpdateKeys = (existing?.updates ?? [])
      .filter(({ key }) => !turn.updates.some((candidate) => candidate.key === key))
      .map(({ key }) => key);
    const updates = turn.updates.flatMap((update): AgentConversationUpdateDelta[] => {
      const previousUpdate = existing?.updates.find(({ key }) => key === update.key);
      if (equalUpdate(previousUpdate, update)) return [];
      if (
        previousUpdate?.kind === "message" &&
        update.kind === "message" &&
        previousUpdate.role === update.role &&
        previousUpdate.messageId === update.messageId &&
        update.text.startsWith(previousUpdate.text)
      ) {
        return [
          {
            kind: "append-message",
            key: update.key,
            text: update.text.slice(previousUpdate.text.length),
          },
        ];
      }
      return [{ kind: "replace", update }];
    });
    const scalarChanged =
      existing === undefined ||
      existing.clientUserMessageId !== turn.clientUserMessageId ||
      existing.promptText !== turn.promptText ||
      existing.stopReason !== turn.stopReason;
    if (!scalarChanged && removedUpdateKeys.length === 0 && updates.length === 0) return [];
    return [
      {
        sequence: turn.sequence,
        clientUserMessageId: turn.clientUserMessageId,
        promptText: turn.promptText,
        stopReason: turn.stopReason,
        removedUpdateKeys,
        updates,
      },
    ];
  });
  const delta: AgentConversationDelta = {
    backend: next.backend,
    threadId: next.threadId,
    sessionId: next.sessionId,
    baseRevision: previous.revision,
    revision: next.revision,
    status: next.status,
    error: next.error,
    ...(next.requests === undefined ? {} : { requests: next.requests }),
    removedTurnSequences,
    turns,
  };
  if (encodedBytes(delta) > AGENT_CONVERSATION_MAX_DELTA_BYTES) {
    throw new RangeError("ACP conversation delta exceeded its transport byte budget");
  }
  return delta;
};
