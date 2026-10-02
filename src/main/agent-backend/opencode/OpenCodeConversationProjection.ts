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
export const projectOpenCodeHistory = (
  snapshot: AgentConversationSnapshot,
  messages: readonly OpenCodeNativeMessage[],
  contextSize = 0,
): AgentConversationSnapshot => {
  let next = snapshot;
  let sequence = 0;
  const parents = new Map<string, number>();
  for (const message of [...messages].sort(
    (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
  )) {
    if (message.info.role === "user") {
      if (message.parts.some((part) => part.type === "compaction")) {
        if (sequence > 0) parents.set(message.info.id, sequence);
        continue;
      }
      sequence += 1;
      parents.set(message.info.id, sequence);
      next = beginAgentConversationTurn(
        next,
        sequence,
        openCodePromptText(message),
        message.info.id,
      );
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
      continue;
    }
    const parent = parents.get(message.info.parentID);
    if (parent === undefined) continue;
    for (const part of message.parts) {
      const projected = openCodePartUpdate(part);
      const update =
        projected?.kind === "message" && message.info.summary
          ? { ...projected, role: "compaction" as const }
          : projected;
      if (update)
        next = reduceAgentConversationEvent(next, {
          kind: "session_update",
          turnSequence: parent,
          update,
        });
    }
    const usage = openCodeMessageUsage(message.info, contextSize);
    if (usage)
      next = reduceAgentConversationEvent(next, {
        kind: "session_update",
        turnSequence: parent,
        update: usage,
      });
    if (!message.info.time.completed) continue;
    const info = message.info;
    const error =
      info.error && "message" in info.error.data ? String(info.error.data.message) : null;
    next = {
      ...next,
      turns: next.turns.map((turn) =>
        turn.sequence === parent
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
              completedAt: new Date(info.time.completed!).toISOString(),
            }
          : turn,
      ),
    };
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
