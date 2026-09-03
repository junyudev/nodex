import type { PromptRequest, SessionUpdate } from "@agentclientprotocol/sdk";
import type {
  AcpCanonicalSessionUpdate,
  AcpConversationDelta,
  AcpConversationSnapshot,
  AcpConversationStatus,
  AcpConversationTurn,
  AcpConversationUpdateDelta,
} from "../../../shared/acp-conversation";
import type { AcpSessionRuntimeEvent } from "./AcpSessionRuntime";

export const ACP_CONVERSATION_MAX_TURNS = 64;
export const ACP_CONVERSATION_MAX_UPDATES_PER_TURN = 128;
export const ACP_CONVERSATION_MAX_TURN_BYTES = 512 * 1024;
export const ACP_CONVERSATION_MAX_SESSION_BYTES = 2 * 1024 * 1024;
export const ACP_CONVERSATION_MAX_DELTA_BYTES = 1024 * 1024;
const MAX_TEXT_CHARACTERS = 64 * 1024;
const MAX_COLLECTION_ITEMS = 128;

const boundedString = (value: string, maximum = MAX_TEXT_CHARACTERS): string =>
  value.length <= maximum ? value : `${value.slice(0, maximum)}\n[output truncated]`;

const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

const boundedDiagnosticText = (value: unknown): string => {
  if (typeof value === "string") return boundedString(value);
  try {
    return boundedString(JSON.stringify(value));
  } catch {
    return "[unavailable output]";
  }
};

const contentText = (value: unknown): string => {
  const content = record(value);
  if (content.type === "text" && typeof content.text === "string") return content.text;
  if (content.type === "resource_link" && typeof content.uri === "string") return content.uri;
  if (content.type === "resource") {
    const resource = record(content.resource);
    if (typeof resource.uri === "string") return resource.uri;
  }
  if (content.type === "image") return "[image]";
  if (content.type === "audio") return "[audio]";
  return "";
};

const toolDetail = (update: Readonly<Record<string, unknown>>): string => {
  const content = Array.isArray(update.content)
    ? update.content
        .slice(0, MAX_COLLECTION_ITEMS)
        .map((entry) => {
          const item = record(entry);
          if (item.type === "content") return contentText(item.content);
          if (item.type === "diff") {
            const path = typeof item.path === "string" ? item.path : "file";
            return `[diff: ${path}]`;
          }
          if (item.type === "terminal") return "[terminal output]";
          return "";
        })
        .filter(Boolean)
        .join("\n")
    : "";
  const rawOutput = update.rawOutput === undefined ? "" : boundedDiagnosticText(update.rawOutput);
  return boundedString([content, rawOutput].filter(Boolean).join("\n"));
};

const toolLocations = (update: Readonly<Record<string, unknown>>): readonly string[] =>
  Array.isArray(update.locations)
    ? update.locations
        .slice(0, MAX_COLLECTION_ITEMS)
        .map((entry) => record(entry).path)
        .filter((path): path is string => typeof path === "string")
        .map((path) => boundedString(path, 4_096))
    : [];

const messageRole = (
  sessionUpdate: string,
): Extract<AcpCanonicalSessionUpdate, { readonly kind: "message" }>["role"] => {
  if (sessionUpdate === "user_message_chunk") return "user";
  if (sessionUpdate === "agent_thought_chunk") return "thought";
  if (sessionUpdate === "compaction_summary_chunk") return "compaction";
  return "agent";
};

const messageKey = (
  updates: readonly AcpCanonicalSessionUpdate[],
  role: Extract<AcpCanonicalSessionUpdate, { readonly kind: "message" }>["role"],
  messageId: string | null,
): string => {
  if (messageId) return `message:${role}:${messageId}`;
  const previous = updates.at(-1);
  if (previous?.kind === "message" && previous.role === role && previous.messageId === null) {
    return previous.key;
  }
  return `message:${role}:anonymous-${updates.length}`;
};

const planUpdate = (
  update: Readonly<Record<string, unknown>>,
): Extract<AcpCanonicalSessionUpdate, { readonly kind: "plan" }> => {
  type PlanEntry = Extract<AcpCanonicalSessionUpdate, { readonly kind: "plan" }>["entries"][number];
  const sessionUpdate = String(update.sessionUpdate);
  const plan = sessionUpdate === "plan_update" ? record(update.plan) : update;
  const planId =
    typeof plan.planId === "string"
      ? boundedString(plan.planId, 512)
      : typeof update.planId === "string"
        ? boundedString(update.planId, 512)
        : null;
  const entries = Array.isArray(plan.entries)
    ? plan.entries.slice(0, MAX_COLLECTION_ITEMS).flatMap((entry): PlanEntry[] => {
        const item = record(entry);
        if (
          typeof item.content !== "string" ||
          (item.priority !== "high" && item.priority !== "medium" && item.priority !== "low") ||
          (item.status !== "pending" &&
            item.status !== "in_progress" &&
            item.status !== "completed")
        ) {
          return [];
        }
        const priority = item.priority as PlanEntry["priority"];
        const status = item.status as PlanEntry["status"];
        return [{ content: boundedString(item.content, 8_192), priority, status }];
      })
    : [];
  return {
    kind: "plan",
    key: `plan:${planId ?? "default"}`,
    planId,
    state: sessionUpdate === "plan_removed" ? "removed" : "present",
    entries,
    markdown: typeof plan.content === "string" ? boundedString(plan.content) : null,
    uri: typeof plan.uri === "string" ? boundedString(plan.uri, 4_096) : null,
  };
};

const canonicalUpdate = (
  updates: readonly AcpCanonicalSessionUpdate[],
  value: SessionUpdate,
): AcpCanonicalSessionUpdate => {
  const update = record(value);
  const sessionUpdate = value.sessionUpdate;
  if (
    sessionUpdate === "user_message_chunk" ||
    sessionUpdate === "agent_message_chunk" ||
    sessionUpdate === "agent_thought_chunk" ||
    sessionUpdate === "compaction_summary_chunk"
  ) {
    const role = messageRole(sessionUpdate);
    const messageId = typeof update.messageId === "string" ? update.messageId : null;
    return {
      kind: "message",
      key: messageKey(updates, role, messageId),
      role,
      messageId,
      text: boundedString(contentText(update.content)),
    };
  }
  if (sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update") {
    const toolCallId =
      typeof update.toolCallId === "string"
        ? boundedString(update.toolCallId, 512)
        : `unknown-${updates.length}`;
    const toolKind =
      update.kind === "read" ||
      update.kind === "edit" ||
      update.kind === "delete" ||
      update.kind === "move" ||
      update.kind === "search" ||
      update.kind === "execute" ||
      update.kind === "think" ||
      update.kind === "fetch" ||
      update.kind === "switch_mode" ||
      update.kind === "other"
        ? update.kind
        : null;
    const status =
      update.status === "pending" ||
      update.status === "in_progress" ||
      update.status === "completed" ||
      update.status === "failed"
        ? update.status
        : "pending";
    return {
      kind: "tool-call",
      key: `tool:${toolCallId}`,
      toolCallId,
      title: typeof update.title === "string" ? boundedString(update.title, 8_192) : "Tool call",
      name: typeof update.name === "string" ? boundedString(update.name, 512) : null,
      toolKind,
      status,
      detail: toolDetail(update),
      locations: toolLocations(update),
    };
  }
  if (
    sessionUpdate === "plan" ||
    sessionUpdate === "plan_update" ||
    sessionUpdate === "plan_removed"
  ) {
    return planUpdate(update);
  }
  if (sessionUpdate === "current_mode_update") {
    return {
      kind: "mode",
      key: "mode",
      currentModeId:
        typeof update.currentModeId === "string" ? boundedString(update.currentModeId, 512) : "",
    };
  }
  if (sessionUpdate === "config_option_update") {
    return {
      kind: "config",
      key: "config",
      optionIds: Array.isArray(update.configOptions)
        ? update.configOptions
            .slice(0, MAX_COLLECTION_ITEMS)
            .map((option) => record(option).id)
            .filter((id): id is string => typeof id === "string")
            .map((id) => boundedString(id, 512))
        : [],
    };
  }
  if (sessionUpdate === "session_info_update") {
    return {
      kind: "session-info",
      key: "session-info",
      title: typeof update.title === "string" ? boundedString(update.title, 8_192) : null,
      updatedAt: typeof update.updatedAt === "string" ? boundedString(update.updatedAt, 256) : null,
    };
  }
  if (sessionUpdate === "usage_update") {
    const cost = record(update.cost);
    return {
      kind: "usage",
      key: "usage",
      used: typeof update.used === "number" && Number.isFinite(update.used) ? update.used : 0,
      size: typeof update.size === "number" && Number.isFinite(update.size) ? update.size : 0,
      cost:
        typeof cost.amount === "number" &&
        Number.isFinite(cost.amount) &&
        typeof cost.currency === "string"
          ? { amount: cost.amount, currency: boundedString(cost.currency, 16) }
          : null,
    };
  }
  if (sessionUpdate === "available_commands_update") {
    return {
      kind: "commands",
      key: "commands",
      commands: Array.isArray(update.availableCommands)
        ? update.availableCommands.slice(0, MAX_COLLECTION_ITEMS).flatMap((command) => {
            const item = record(command);
            if (typeof item.name !== "string" || typeof item.description !== "string") return [];
            return [
              {
                name: boundedString(item.name, 512),
                description: boundedString(item.description, 4_096),
                inputHint:
                  typeof record(item.input).hint === "string"
                    ? boundedString(String(record(item.input).hint), 2_048)
                    : null,
              },
            ];
          })
        : [],
    };
  }
  const compactionId =
    typeof update.compactionId === "string"
      ? boundedString(update.compactionId, 512)
      : `unknown-${updates.length}`;
  return {
    kind: "compaction",
    key: `compaction:${compactionId}`,
    compactionId,
    status: typeof update.status === "string" ? boundedString(update.status, 128) : "in_progress",
    summary: Array.isArray(update.summary)
      ? boundedString(update.summary.map(contentText).filter(Boolean).join("\n"))
      : "",
    error: typeof update.error === "string" ? boundedString(update.error, 8_192) : null,
  };
};

const mergeUpdate = (
  previous: AcpCanonicalSessionUpdate,
  incoming: AcpCanonicalSessionUpdate,
): AcpCanonicalSessionUpdate => {
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
  updates: readonly AcpCanonicalSessionUpdate[],
  value: SessionUpdate,
): readonly AcpCanonicalSessionUpdate[] => {
  const incoming = canonicalUpdate(updates, value);
  const existingIndex = updates.findIndex((entry) => entry.key === incoming.key);
  if (existingIndex >= 0) {
    const next = [...updates];
    next[existingIndex] = mergeUpdate(next[existingIndex]!, incoming);
    return next;
  }
  return [...updates, incoming].slice(-ACP_CONVERSATION_MAX_UPDATES_PER_TURN);
};

const promptText = (prompt: PromptRequest["prompt"]): string =>
  boundedString(prompt.map(contentText).filter(Boolean).join("\n"));

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
  update: AcpCanonicalSessionUpdate,
  maximumBytes: number,
): AcpCanonicalSessionUpdate => {
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
      return truncateStringToFit(candidate.detail, maximumBytes, (detail) => ({
        ...candidate,
        detail,
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

const boundTurn = (turn: AcpConversationTurn): AcpConversationTurn => {
  let candidate = turn;
  if (encodedBytes(candidate) > ACP_CONVERSATION_MAX_TURN_BYTES && candidate.promptText !== null) {
    candidate = truncateStringToFit(
      candidate.promptText,
      ACP_CONVERSATION_MAX_TURN_BYTES,
      (promptText) => ({ ...candidate, promptText }),
    );
  }
  let updates = [...candidate.updates]
    .slice(-ACP_CONVERSATION_MAX_UPDATES_PER_TURN)
    .map((update) => boundCanonicalUpdate(update, ACP_CONVERSATION_MAX_TURN_BYTES));
  while (
    updates.length > 1 &&
    encodedBytes({ ...candidate, updates }) > ACP_CONVERSATION_MAX_TURN_BYTES
  ) {
    updates = updates.slice(1);
  }
  if (
    updates.length === 1 &&
    encodedBytes({ ...candidate, updates }) > ACP_CONVERSATION_MAX_TURN_BYTES
  ) {
    const fixedBytes = encodedBytes({ ...candidate, updates: [] });
    const updateBudget = Math.max(1_024, ACP_CONVERSATION_MAX_TURN_BYTES - fixedBytes - 16);
    updates = [boundCanonicalUpdate(updates[0]!, updateBudget)];
  }
  const bounded = { ...candidate, updates };
  if (encodedBytes(bounded) <= ACP_CONVERSATION_MAX_TURN_BYTES) return bounded;
  if (bounded.promptText === null) return { ...bounded, updates: [] };
  return truncateStringToFit(bounded.promptText, ACP_CONVERSATION_MAX_TURN_BYTES, (promptText) => ({
    ...bounded,
    promptText,
  }));
};

const boundTurns = (turns: readonly AcpConversationTurn[]): readonly AcpConversationTurn[] => {
  let bounded = turns.slice(-ACP_CONVERSATION_MAX_TURNS).map(boundTurn);
  while (bounded.length > 1 && encodedBytes(bounded) > ACP_CONVERSATION_MAX_SESSION_BYTES) {
    bounded = bounded.slice(1);
  }
  if (encodedBytes(bounded) <= ACP_CONVERSATION_MAX_SESSION_BYTES) return bounded;
  const last = bounded.at(-1);
  if (!last) return [];
  let updates = [...last.updates];
  while (
    updates.length > 0 &&
    encodedBytes([{ ...last, updates }]) > ACP_CONVERSATION_MAX_SESSION_BYTES
  ) {
    updates = updates.slice(1);
  }
  return [{ ...last, updates }];
};

export const emptyAcpConversationSnapshot = (input: {
  readonly threadId: string;
  readonly sessionId: string;
}): AcpConversationSnapshot => ({
  backend: "acp",
  threadId: input.threadId,
  sessionId: input.sessionId,
  status: "idle",
  error: null,
  turns: [],
  revision: 0,
});

export const beginAcpConversationTurn = (
  snapshot: AcpConversationSnapshot,
  sequence: number,
  prompt: PromptRequest["prompt"],
  clientUserMessageId: string | null = null,
): AcpConversationSnapshot => {
  if (snapshot.status === "closed") return snapshot;
  return {
    ...snapshot,
    status: "running",
    error: null,
    revision: snapshot.revision + 1,
    turns: boundTurns([
      ...snapshot.turns.filter(({ sequence: candidate }) => candidate !== sequence),
      {
        sequence,
        clientUserMessageId,
        promptText: promptText(prompt),
        updates: [],
        stopReason: null,
      },
    ]),
  };
};

export const rebindAcpConversationSession = (
  snapshot: AcpConversationSnapshot,
  sessionId: string,
): AcpConversationSnapshot =>
  snapshot.status === "closed" || snapshot.sessionId === sessionId
    ? snapshot
    : { ...snapshot, sessionId, revision: snapshot.revision + 1 };

export const recoverAcpConversationTurnFailure = (
  snapshot: AcpConversationSnapshot,
  error: unknown,
  status: Extract<AcpConversationStatus, "idle" | "authentication-required">,
): AcpConversationSnapshot =>
  snapshot.status === "closed" || snapshot.status === "failed"
    ? snapshot
    : {
        ...snapshot,
        status,
        error: boundedString(error instanceof Error ? error.message : String(error), 8_192),
        revision: snapshot.revision + 1,
      };

export const completeAcpConversationAuthentication = (
  snapshot: AcpConversationSnapshot,
  sessionId: string,
): AcpConversationSnapshot =>
  snapshot.status === "closed" || snapshot.status === "failed"
    ? snapshot
    : {
        ...snapshot,
        sessionId,
        status: "idle",
        error: null,
        revision: snapshot.revision + 1,
      };

export const failAcpConversation = (
  snapshot: AcpConversationSnapshot,
  error: unknown,
): AcpConversationSnapshot =>
  snapshot.status === "closed"
    ? snapshot
    : {
        ...snapshot,
        status: "failed",
        error: boundedString(error instanceof Error ? error.message : String(error), 8_192),
        revision: snapshot.revision + 1,
      };

export const closeAcpConversation = (snapshot: AcpConversationSnapshot): AcpConversationSnapshot =>
  snapshot.status === "closed"
    ? snapshot
    : { ...snapshot, status: "closed", revision: snapshot.revision + 1 };

export const reduceAcpConversationEvent = (
  snapshot: AcpConversationSnapshot,
  event: AcpSessionRuntimeEvent,
): AcpConversationSnapshot => {
  if (snapshot.status === "closed") return snapshot;
  const existingIndex = snapshot.turns.findIndex(({ sequence }) => sequence === event.turnSequence);
  const fallback: AcpConversationTurn = {
    sequence: event.turnSequence,
    clientUserMessageId: null,
    promptText: null,
    updates: [],
    stopReason: null,
  };
  const selected = existingIndex >= 0 ? snapshot.turns[existingIndex]! : fallback;
  const turn =
    event.kind === "session_update"
      ? { ...selected, updates: reduceUpdate(selected.updates, event.update) }
      : { ...selected, stopReason: event.response.stopReason };
  const turns =
    existingIndex >= 0
      ? snapshot.turns.map((entry, index) => (index === existingIndex ? turn : entry))
      : [...snapshot.turns, turn];
  return {
    ...snapshot,
    status: event.kind === "turn_stopped" ? "idle" : snapshot.status,
    error: null,
    turns: boundTurns(turns),
    revision: snapshot.revision + 1,
  };
};

const equalUpdate = (
  previous: AcpCanonicalSessionUpdate | undefined,
  next: AcpCanonicalSessionUpdate,
): boolean => previous === next || JSON.stringify(previous) === JSON.stringify(next);

/** Builds the exact consecutive transport delta between two canonical snapshots. */
export const diffAcpConversationSnapshots = (
  previous: AcpConversationSnapshot,
  next: AcpConversationSnapshot,
): AcpConversationDelta | null => {
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
    const updates = turn.updates.flatMap((update): AcpConversationUpdateDelta[] => {
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
  const delta: AcpConversationDelta = {
    backend: "acp",
    threadId: next.threadId,
    sessionId: next.sessionId,
    baseRevision: previous.revision,
    revision: next.revision,
    status: next.status,
    error: next.error,
    removedTurnSequences,
    turns,
  };
  if (encodedBytes(delta) > ACP_CONVERSATION_MAX_DELTA_BYTES) {
    throw new RangeError("ACP conversation delta exceeded its transport byte budget");
  }
  return delta;
};
