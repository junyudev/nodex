import type {
  AgentCanonicalSessionUpdate,
  AgentConversationDelta,
  AgentConversationSnapshot,
  AgentConversationStatus,
  AgentConversationTurn,
  AgentConversationUpdateDelta,
  AgentHistoryFact,
  AgentSessionMetadata,
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
    const text = `${previous.text}${incoming.text}`;
    return {
      ...incoming,
      ...(incoming.truncated || previous.truncated || text.length > MAX_TEXT_CHARACTERS
        ? { truncated: true }
        : {}),
      text: boundedString(text),
    };
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
  update = { ...update, truncated: true };
  switch (update.kind) {
    case "message":
      return truncateStringToFit(update.text, maximumBytes, (text) => ({ ...update, text }));
    case "tool-call": {
      let candidate = update;
      if (candidate.output !== undefined) candidate = { ...candidate, output: undefined };
      if (candidate.resources?.length) candidate = { ...candidate, resources: [] };
      if (candidate.changes?.length)
        candidate = {
          ...candidate,
          changes: candidate.changes.map((change) => ({ ...change, diff: undefined })),
        };
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
    case "rate-limit":
      return update;
    case "diagnostic":
      return truncateStringToFit(update.message, maximumBytes, (message) => ({
        ...update,
        message,
        details: undefined,
      }));
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
  maximumTurns = AGENT_CONVERSATION_MAX_TURNS,
): readonly AgentConversationTurn[] => {
  let bounded = turns
    .slice(-Math.min(512, Math.max(AGENT_CONVERSATION_MAX_TURNS, maximumTurns)))
    .map(boundTurn);
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
    turns: boundAgentConversationTurns(
      [
        ...snapshot.turns.filter(({ sequence: candidate }) => candidate !== sequence),
        {
          sequence,
          clientUserMessageId,
          promptText: boundedString(prompt),
          updates: [],
          stopReason: null,
          status: "running",
          error: null,
        },
      ],
      snapshot.history?.windowSize,
    ),
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
        turns: snapshot.turns.map((turn, index) =>
          index === snapshot.turns.length - 1
            ? {
                ...turn,
                status: "failed",
                stopReason: "error",
                error: boundedString(error instanceof Error ? error.message : String(error), 8_192),
              }
            : turn,
        ),
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

/** A dead native process cannot keep any task or tool running in the live registry. */
const settleAgentRuntime = (
  snapshot: AgentConversationSnapshot,
  status: "failed" | "cancelled",
  error: string | null,
): AgentConversationSnapshot => {
  const settleTool = (update: AgentCanonicalSessionUpdate): AgentCanonicalSessionUpdate =>
    update.kind === "tool-call" && (update.status === "pending" || update.status === "in_progress")
      ? { ...update, status, detail: error ?? update.detail }
      : update;
  return {
    ...snapshot,
    liveBackgroundTaskIds: [],
    tasks: snapshot.tasks?.map((task) =>
      ["pending", "running", "paused"].includes(task.status)
        ? { ...task, status, error: error ?? task.error }
        : task,
    ),
    toolCalls: snapshot.toolCalls?.map((call) => ({
      ...call,
      update: settleTool(call.update) as Extract<
        AgentCanonicalSessionUpdate,
        { kind: "tool-call" }
      >,
    })),
    turns: snapshot.turns.map((turn) => ({
      ...turn,
      ...(turn.status === "running"
        ? { status, error, stopReason: status === "failed" ? "error" : "cancelled" }
        : {}),
      updates: turn.updates.map(settleTool),
    })),
  };
};

export const failAgentConversation = (
  snapshot: AgentConversationSnapshot,
  error: unknown,
): AgentConversationSnapshot => {
  if (snapshot.status === "closed") return snapshot;
  const message = boundedString(error instanceof Error ? error.message : String(error), 8_192);
  return {
    ...settleAgentRuntime(snapshot, "failed", message),
    status: "failed",
    error: message,
    revision: snapshot.revision + 1,
  };
};

export const closeAgentConversation = (
  snapshot: AgentConversationSnapshot,
): AgentConversationSnapshot =>
  snapshot.status === "closed"
    ? snapshot
    : {
        ...settleAgentRuntime(snapshot, "cancelled", null),
        status: "closed",
        revision: snapshot.revision + 1,
      };

export const updateAgentSessionMetadata = (
  snapshot: AgentConversationSnapshot,
  metadata: Omit<AgentSessionMetadata, "revision">,
): AgentConversationSnapshot => {
  const { revision: _revision, ...previous } = snapshot.metadata ?? { revision: 0 };
  if (JSON.stringify(previous) === JSON.stringify(metadata)) return snapshot;
  return {
    ...snapshot,
    metadata: { ...metadata, revision: (snapshot.metadata?.revision ?? 0) + 1 },
    revision: snapshot.revision + 1,
  };
};

export interface AgentConversationTurnOutcome {
  readonly status: "completed" | "failed" | "cancelled";
  readonly stopReason: string;
  readonly error: string | null;
  readonly authenticationRequired?: boolean;
}

/** A turn outcome survives later background events; only foreground tools are settled. */
export const completeAgentConversationTurn = (
  snapshot: AgentConversationSnapshot,
  sequence: number,
  outcome: AgentConversationTurnOutcome,
): AgentConversationSnapshot => {
  if (snapshot.status === "closed") return snapshot;
  const liveTaskToolIds = new Set(
    (snapshot.tasks ?? [])
      .filter(
        (task) =>
          task.status === "pending" || task.status === "running" || task.status === "paused",
      )
      .map((task) => task.toolUseId),
  );
  const turns = snapshot.turns.map((turn) => {
    if (turn.sequence !== sequence) return turn;
    return {
      ...turn,
      status: outcome.status,
      stopReason: outcome.stopReason,
      error: outcome.error,
      updates: turn.updates.map((value): AgentCanonicalSessionUpdate => {
        if (
          value.kind !== "tool-call" ||
          (value.status !== "in_progress" && value.status !== "pending") ||
          liveTaskToolIds.has(value.toolCallId)
        )
          return value;
        if (value.actor?.parentToolUseId || value.actor?.taskId) return value;
        return {
          ...value,
          status:
            outcome.status === "completed"
              ? "completed"
              : outcome.status === "cancelled"
                ? "cancelled"
                : "failed",
        };
      }),
    };
  });
  return {
    ...snapshot,
    turns,
    requests: [],
    toolCalls: snapshot.toolCalls?.map((entry) => {
      const projected = turns
        .find((turn) => turn.sequence === entry.turnSequence)
        ?.updates.find((value) => value.key === entry.update.key);
      return projected?.kind === "tool-call" ? { ...entry, update: projected } : entry;
    }),
    status: outcome.authenticationRequired ? "authentication-required" : "idle",
    error: outcome.error,
    revision: snapshot.revision + 1,
  };
};

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
      : {
          ...selected,
          stopReason: event.stopReason,
          status:
            event.stopReason === "error"
              ? ("failed" as const)
              : event.stopReason === "cancelled" || event.stopReason === "interrupted"
                ? ("cancelled" as const)
                : ("failed" as const),
        };
  const turns =
    existingIndex >= 0
      ? snapshot.turns.map((entry, index) => (index === existingIndex ? turn : entry))
      : [...snapshot.turns, turn];
  return {
    ...snapshot,
    status: event.kind === "turn_stopped" ? "idle" : snapshot.status,
    error: snapshot.error,
    turns: boundAgentConversationTurns(turns, snapshot.history?.windowSize),
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
  if (previous.threadId !== next.threadId || previous.backend !== next.backend) return null;
  const resync = (): AgentConversationDelta => ({
    resync: true,
    backend: next.backend,
    threadId: next.threadId,
    sessionId: next.sessionId,
    baseRevision: previous.revision,
    revision: next.revision,
    status: next.status,
    error: null,
    removedTurnSequences: [],
    turns: [],
  });
  if (previous.sessionId !== next.sessionId || next.revision > previous.revision + 1)
    return resync();
  if (next.revision !== previous.revision + 1) return null;
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
        JSON.stringify({ ...previousUpdate, text: null }) ===
          JSON.stringify({ ...update, text: null }) &&
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
      JSON.stringify(existing.promptImages) !== JSON.stringify(turn.promptImages) ||
      existing.stopReason !== turn.stopReason;
    const outcomeChanged =
      existing?.status !== turn.status ||
      existing?.error !== turn.error ||
      existing?.createdAt !== turn.createdAt ||
      existing?.completedAt !== turn.completedAt;
    const identityChanged = existing?.nativeUserMessageId !== turn.nativeUserMessageId;
    if (
      !scalarChanged &&
      !outcomeChanged &&
      !identityChanged &&
      removedUpdateKeys.length === 0 &&
      updates.length === 0
    )
      return [];
    return [
      {
        sequence: turn.sequence,
        clientUserMessageId: turn.clientUserMessageId,
        nativeUserMessageId: turn.nativeUserMessageId,
        promptText: turn.promptText,
        promptImages: turn.promptImages,
        stopReason: turn.stopReason,
        status: turn.status,
        error: turn.error,
        createdAt: turn.createdAt,
        completedAt: turn.completedAt,
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
    ...(next.requests === undefined ||
    JSON.stringify(previous.requests) === JSON.stringify(next.requests)
      ? {}
      : { requests: next.requests }),
    ...(next.metadata === undefined ||
    JSON.stringify(previous.metadata) === JSON.stringify(next.metadata)
      ? {}
      : { metadata: next.metadata }),
    ...(next.tasks === undefined || JSON.stringify(previous.tasks) === JSON.stringify(next.tasks)
      ? {}
      : { tasks: next.tasks }),
    ...(next.liveBackgroundTaskIds === undefined ||
    JSON.stringify(previous.liveBackgroundTaskIds) === JSON.stringify(next.liveBackgroundTaskIds)
      ? {}
      : { liveBackgroundTaskIds: next.liveBackgroundTaskIds }),
    ...(next.toolCalls === undefined ||
    JSON.stringify(previous.toolCalls) === JSON.stringify(next.toolCalls)
      ? {}
      : { toolCalls: next.toolCalls }),
    ...(next.history === undefined ||
    JSON.stringify(previous.history) === JSON.stringify(next.history)
      ? {}
      : { history: next.history }),
    removedTurnSequences,
    turns,
  };
  if (encodedBytes(delta) > AGENT_CONVERSATION_MAX_DELTA_BYTES) {
    return resync();
  }
  return delta;
};

/** Extracts observations for an exact native-history join, without retaining content bodies. */
export const agentHistoryFactFromTurn = (turn: AgentConversationTurn): AgentHistoryFact | null => {
  if (!turn.clientUserMessageId) return null;
  const usage = turn.updates.findLast((update) => update.kind === "usage");
  const compactions = turn.updates.flatMap((update) =>
    update.kind === "compaction" && ["completed", "failed", "cancelled"].includes(update.status)
      ? [
          {
            compactionId: update.compactionId,
            status: update.status,
            summary: update.summary,
            error: update.error,
            trigger: update.trigger,
            preTokens: update.preTokens,
            postTokens: update.postTokens,
            durationMs: update.durationMs,
          },
        ]
      : [],
  );
  const artifacts = new Map<string, NonNullable<AgentHistoryFact["artifacts"]>[number]>();
  for (const update of turn.updates) {
    if (
      update.kind !== "diagnostic" ||
      !(update.code.startsWith("files:") || update.code === "restored-files")
    )
      continue;
    const values = [
      update.details?.files,
      update.details?.failed,
      update.details?.artifacts,
    ].flatMap((items) => (Array.isArray(items) ? items : []));
    for (const value of values) {
      if (!value || typeof value !== "object" || typeof value.filename !== "string") continue;
      const fileId =
        typeof value.fileId === "string"
          ? value.fileId
          : typeof value.file_id === "string"
            ? value.file_id
            : undefined;
      artifacts.set(fileId ?? value.filename, {
        filename: value.filename,
        ...(fileId ? { fileId } : {}),
        ...(typeof value.error === "string" ? { error: value.error } : {}),
      });
    }
  }
  return {
    clientUserMessageId: turn.clientUserMessageId,
    nativeUserMessageId: turn.nativeUserMessageId,
    stopReason: turn.stopReason,
    error: turn.error,
    createdAt: turn.createdAt,
    completedAt: turn.completedAt,
    ...(usage
      ? {
          usage: {
            used: usage.used,
            size: usage.size,
            cost: usage.cost,
            tokens: usage.tokens,
            cumulativeTokens: usage.cumulativeTokens,
            model: usage.model,
            contextEstimated: usage.contextEstimated,
          },
        }
      : {}),
    ...(compactions.length ? { compactions } : {}),
    ...(artifacts.size ? { artifacts: [...artifacts.values()] } : {}),
  };
};

/** Rejoins durable turn outcomes to Claude's native history by UUID, never transcript position. */
export const applyAgentHistoryFacts = (
  snapshot: AgentConversationSnapshot,
  facts: readonly AgentHistoryFact[],
): AgentConversationSnapshot => ({
  ...snapshot,
  turns: snapshot.turns.map((turn) => {
    const fact = facts.find(
      (candidate) =>
        (candidate.nativeUserMessageId === turn.nativeUserMessageId &&
          turn.nativeUserMessageId !== undefined) ||
        (candidate.clientUserMessageId === turn.clientUserMessageId &&
          turn.clientUserMessageId !== null),
    );
    if (!fact) return turn;
    const { usage, compactions, artifacts, ...outcome } = fact;
    let updates = [...turn.updates];
    if (usage)
      updates = [
        ...updates.filter((update) => update.kind !== "usage"),
        { ...usage, kind: "usage", key: "usage" },
      ];
    for (const compaction of compactions ?? []) {
      const key = `compaction:${compaction.compactionId}`;
      updates = [
        ...updates.filter(
          (update) =>
            update.kind !== "compaction" || update.compactionId !== compaction.compactionId,
        ),
        {
          ...compaction,
          kind: "compaction",
          key,
          summary: compaction.summary ?? "",
          error: compaction.error ?? null,
        },
      ];
    }
    if (artifacts?.length) {
      const key = "diagnostic:restored-files";
      updates = [
        ...updates.filter((update) => update.key !== key),
        {
          kind: "diagnostic",
          key,
          code: "restored-files",
          severity: artifacts.some((artifact) => artifact.error) ? "error" : "info",
          message: artifacts
            .map((artifact) =>
              artifact.error
                ? `${artifact.filename}: ${artifact.error}`
                : `Saved ${artifact.filename}`,
            )
            .join("\n"),
          details: { artifacts },
        },
      ];
    }
    return {
      ...turn,
      ...outcome,
      updates,
      status:
        fact.error || fact.stopReason === "error"
          ? "failed"
          : fact.stopReason === "cancelled" || fact.stopReason === "interrupted"
            ? "cancelled"
            : fact.stopReason
              ? "completed"
              : undefined,
    };
  }),
});
