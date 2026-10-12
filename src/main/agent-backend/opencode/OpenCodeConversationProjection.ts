import type { Message, Part } from "@opencode-ai/sdk/v2";
import type {
  AgentCanonicalSessionUpdate,
  AgentConversationActor,
  AgentConversationSnapshot,
  AgentConversationTurn,
} from "../../../shared/agent-conversation";
import type { OpenCodeNativeMessage } from "../../platform/node/OpenCodeSdk";
import {
  beginAgentConversationTurn,
  boundAgentConversationTurns,
  reduceAgentConversationEvent,
} from "../AgentConversationProjection";

export const openCodePromptImages = (message: OpenCodeNativeMessage) =>
  message.parts
    .filter((part) => part.type === "file" && part.mime.startsWith("image/"))
    .map((part, index) => ({
      nativeMessageId: message.info.id,
      index,
      mediaType: part.type === "file" ? part.mime : "",
    }));
export const openCodePromptText = (message: OpenCodeNativeMessage): string =>
  message.parts
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored)
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("\n");

/** Native part IDs remain stable across streamed updates and paginated history. */
export const openCodePartUpdate = (
  part: Part,
  actor?: AgentConversationActor,
): AgentCanonicalSessionUpdate | null => {
  const common = {
    key: `opencode:${part.id}`,
    messageId: part.messageID,
    recordIds: [part.messageID],
    ...(actor ? { actor } : {}),
  };
  if (part.type === "text" || part.type === "reasoning")
    return {
      ...common,
      kind: "message",
      role: part.type === "reasoning" ? "thought" : "agent",
      text: part.text,
    };
  if (part.type !== "tool") return null;
  const state = part.state;
  const toolKind =
    part.tool === "bash"
      ? "execute"
      : part.tool === "read"
        ? "read"
        : part.tool === "edit" || part.tool === "write" || part.tool === "apply_patch"
          ? "edit"
          : part.tool === "grep" || part.tool === "glob"
            ? "search"
            : part.tool === "webfetch"
              ? "fetch"
              : "other";
  return {
    ...common,
    kind: "tool-call",
    toolCallId: part.callID,
    title: "title" in state && state.title ? state.title : part.tool,
    name: part.tool,
    toolKind,
    status:
      state.status === "running"
        ? "in_progress"
        : state.status === "error"
          ? "failed"
          : state.status,
    detail: state.status === "error" ? state.error : "",
    input: JSON.stringify(state.input),
    locations: typeof state.input.filePath === "string" ? [state.input.filePath] : [],
    ...(state.status === "completed"
      ? {
          output: state.output.slice(0, 8192),
          outputRecordId: part.messageID,
          truncated: state.output.length > 8192,
        }
      : {}),
    ...("time" in state && "end" in state.time
      ? { elapsedSeconds: (state.time.end - state.time.start) / 1000 }
      : {}),
  };
};
export const openCodeMessageUsage = (
  message: Message,
  contextSize: number,
): AgentCanonicalSessionUpdate | null => {
  if (message.role !== "assistant") return null;
  return {
    kind: "usage",
    key: "usage",
    used: message.tokens.input + message.tokens.cache.read + message.tokens.cache.write,
    size: contextSize,
    cost: { amount: message.cost, currency: "USD" },
    tokens: {
      input: message.tokens.input,
      output: message.tokens.output,
      cacheRead: message.tokens.cache.read,
      cacheWrite: message.tokens.cache.write,
    },
    model: `${message.providerID}/${message.modelID}`,
  };
};
const projectOpenCodeAssistant = (
  snapshot: AgentConversationSnapshot,
  message: OpenCodeNativeMessage,
  sequence: number,
  contextSize: number,
): AgentConversationSnapshot => {
  const info = message.info;
  if (info.role !== "assistant") return snapshot;
  let next = snapshot;
  for (const part of message.parts) {
    const projected = openCodePartUpdate(part);
    const update =
      projected?.kind === "message" && info.summary
        ? { ...projected, role: "compaction" as const }
        : projected;
    if (update)
      next = reduceAgentConversationEvent(next, {
        kind: "session_update",
        turnSequence: sequence,
        update,
      });
  }
  const usage = openCodeMessageUsage(info, contextSize);
  if (usage)
    next = reduceAgentConversationEvent(next, {
      kind: "session_update",
      turnSequence: sequence,
      update: usage,
    });
  const completedAt = info.time.completed;
  if (completedAt === undefined) return next;
  const error = info.error && "message" in info.error.data ? String(info.error.data.message) : null;
  return {
    ...next,
    turns: next.turns.map((turn) =>
      turn.sequence === sequence
        ? {
            ...turn,
            status:
              info.error?.name === "MessageAbortedError"
                ? "cancelled"
                : info.error
                  ? "failed"
                  : info.finish && info.finish !== "tool-calls"
                    ? "completed"
                    : turn.status,
            stopReason: info.finish ?? turn.stopReason,
            error,
            completedAt: new Date(completedAt).toISOString(),
          }
        : turn,
    ),
  };
};

export const projectOpenCodeHistory = (
  snapshot: AgentConversationSnapshot,
  messages: readonly OpenCodeNativeMessage[],
  contextSize = 0,
): AgentConversationSnapshot => {
  const ordered = messages
    .filter((message) => message.info.sessionID === snapshot.sessionId)
    .toSorted(
      (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
    );
  const turns: { prompt: OpenCodeNativeMessage; responses: OpenCodeNativeMessage[] }[] = [];
  const parents = new Map<string, (typeof turns)[number]>();
  for (const message of ordered) {
    if (message.info.role !== "user") continue;
    if (message.parts.some((part) => part.type === "compaction")) {
      const turn = turns.at(-1);
      if (turn) parents.set(message.info.id, turn);
      continue;
    }
    const turn = { prompt: message, responses: [] as OpenCodeNativeMessage[] };
    turns.push(turn);
    parents.set(message.info.id, turn);
  }
  for (const message of ordered) {
    if (message.info.role !== "assistant") continue;
    parents.get(message.info.parentID)?.responses.push(message);
  }
  let next = snapshot;
  let sequence = 0;
  // Complete each causal turn before the shared presentation budget can evict it.
  for (const { prompt: message, responses } of turns) {
    sequence += 1;
    next = beginAgentConversationTurn(next, sequence, openCodePromptText(message), message.info.id);
    next = {
      ...next,
      turns: next.turns.map((turn) =>
        turn.sequence === sequence
          ? {
              ...turn,
              nativeUserMessageId: message.info.id,
              promptImages: openCodePromptImages(message),
              createdAt: new Date(message.info.time.created).toISOString(),
              status: undefined,
            }
          : turn,
      ),
    };
    for (const assistant of responses) {
      next = projectOpenCodeAssistant(next, assistant, sequence, contextSize);
    }
  }
  return {
    ...next,
    status: "idle",
    turns: boundAgentConversationTurns(next.turns),
    revision: snapshot.revision + 1,
  };
};
export const prependOpenCodeHistory = (
  snapshot: AgentConversationSnapshot,
  older: AgentConversationSnapshot,
  hasOlder: boolean,
  cursor?: string,
): AgentConversationSnapshot => {
  const known = new Set(snapshot.turns.map((turn) => turn.nativeUserMessageId));
  const additions = older.turns.filter((turn) => !known.has(turn.nativeUserMessageId));
  const firstSequence = snapshot.turns[0]?.sequence ?? 1;
  const reindexed: readonly AgentConversationTurn[] = additions.map((turn, index) => ({
    ...turn,
    sequence: firstSequence - additions.length + index,
  }));
  const merged = snapshot.turns.map((turn) => {
    const previous = older.turns.find(
      (candidate) => candidate.nativeUserMessageId === turn.nativeUserMessageId,
    );
    if (!previous) return turn;
    const keys = new Set(turn.updates.map((update) => update.key));
    return {
      ...turn,
      updates: [...previous.updates.filter((update) => !keys.has(update.key)), ...turn.updates],
      createdAt: previous.createdAt ?? turn.createdAt,
    };
  });
  const turns = boundAgentConversationTurns([...reindexed, ...merged]);
  return {
    ...snapshot,
    turns,
    history: {
      hasOlder,
      oldestSequence: turns[0]?.sequence ?? null,
      cursor,
      windowSize: 512,
      windowFull: additions.length > 0 && turns.length === snapshot.turns.length,
    },
    revision: snapshot.revision + 1,
  };
};
