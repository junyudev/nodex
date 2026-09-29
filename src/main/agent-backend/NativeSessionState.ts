import type {
  AgentConversationSnapshot,
  AgentConversationTurn,
  AgentHistoryFact,
  AgentConversationTokenUsage,
} from "../../shared/agent-conversation";
import type { ClaudeModelSelection } from "../../shared/claude-models";
import { isClaudeEffortLevel } from "../../shared/claude-models";
import type { DesktopProjectWorkspaceNativeAgentState } from "../core-client/project-workspace-adapter";

const boundedText = (value: string, limit = 4096): string => {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= limit) return value;
  let end = limit;
  while ((bytes[end]! & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
};

type NativeTurnFact = NonNullable<DesktopProjectWorkspaceNativeAgentState["turns"]>[number];
const counter = (value: number) =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value)));
const nativeTokens = (tokens: AgentConversationTokenUsage) => ({
  input: counter(tokens.input),
  output: counter(tokens.output),
  cache_read: counter(tokens.cacheRead),
  cache_write: counter(tokens.cacheWrite),
});
const restoredTokens = (tokens: NonNullable<NonNullable<NativeTurnFact["usage"]>["tokens"]>) => ({
  input: tokens.input,
  output: tokens.output,
  cacheRead: tokens.cache_read,
  cacheWrite: tokens.cache_write,
});

/** Only observation summaries cross Core; messages, tool output and attachment bytes stay native. */
const turnObservations = (turn: AgentConversationTurn, previous?: NativeTurnFact) => {
  const usage = turn.updates.findLast((update) => update.kind === "usage");
  const observedCompactions = turn.updates.flatMap((update) => {
    if (
      update.kind !== "compaction" ||
      !["completed", "failed", "cancelled"].includes(update.status)
    )
      return [];
    return [
      {
        id: boundedText(update.compactionId, 512),
        status: update.status,
        summary: boundedText(update.summary, 1024),
        ...(update.error ? { error: boundedText(update.error, 1024) } : {}),
        ...(update.trigger ? { trigger: update.trigger } : {}),
        ...(update.preTokens === undefined ? {} : { pre_tokens: counter(update.preTokens) }),
        ...(update.postTokens === undefined ? {} : { post_tokens: counter(update.postTokens) }),
        ...(update.durationMs === undefined ? {} : { duration_ms: counter(update.durationMs) }),
      },
    ];
  });
  const compactions = new Map((previous?.compactions ?? []).map((item) => [item.id, item]));
  for (const item of observedCompactions) compactions.set(item.id, item);
  const artifacts = new Map(
    (previous?.artifacts ?? []).map((file) => [file.file_id ?? file.filename, file]),
  );
  for (const update of turn.updates) {
    if (update.kind !== "diagnostic" || !update.code.startsWith("files:")) continue;
    for (const value of [update.details?.files, update.details?.failed]) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (
          !item ||
          typeof item !== "object" ||
          typeof item.filename !== "string" ||
          !item.filename
        )
          continue;
        const artifact = {
          filename: boundedText(item.filename, 512),
          ...(typeof item.file_id === "string" && item.file_id
            ? { file_id: boundedText(item.file_id, 512) }
            : {}),
          ...(typeof item.error === "string" ? { error: boundedText(item.error, 1024) } : {}),
        };
        artifacts.set(artifact.file_id ?? artifact.filename, artifact);
      }
    }
  }
  return {
    ...(usage
      ? {
          usage: {
            used: counter(usage.used),
            size: counter(usage.size),
            ...(usage.cost && Number.isFinite(usage.cost.amount) && usage.cost.amount >= 0
              ? {
                  cost_micros: counter(Math.round(usage.cost.amount * 1_000_000)),
                  currency: boundedText(usage.cost.currency, 64),
                }
              : {}),
            ...(usage.tokens ? { tokens: nativeTokens(usage.tokens) } : {}),
            ...(usage.cumulativeTokens
              ? { cumulative_tokens: nativeTokens(usage.cumulativeTokens) }
              : {}),
            ...(usage.model ? { model: boundedText(usage.model, 512) } : {}),
            ...(usage.contextEstimated === undefined
              ? {}
              : { context_estimated: usage.contextEstimated }),
          },
        }
      : previous?.usage
        ? { usage: previous.usage }
        : {}),
    compactions: [...compactions.values()].slice(-8),
    artifacts: [...artifacts.values()].slice(-32),
  };
};

export const nativeSelectionFromState = (
  state: DesktopProjectWorkspaceNativeAgentState | null,
): ClaudeModelSelection => ({
  model: state?.preferences.model ?? "default",
  effort: isClaudeEffortLevel(state?.preferences.effort) ? state.preferences.effort : "default",
  ...(state?.preferences.fast == null ? {} : { fast: state.preferences.fast }),
  ...(state?.preferences.thinking == null ? {} : { thinking: state.preferences.thinking }),
  ...(state?.preferences.context == null ? {} : { context: state.preferences.context }),
});

/** Persist user choices and outcome facts only; native Claude remains the content authority. */
export const nativeStateFromSnapshot = (
  snapshot: AgentConversationSnapshot,
  previous: DesktopProjectWorkspaceNativeAgentState | null,
  everSaved = previous?.ever_saved ?? false,
): DesktopProjectWorkspaceNativeAgentState => {
  const selected = snapshot.metadata?.requestedSelection ?? nativeSelectionFromState(previous);
  const facts = new Map((previous?.turns ?? []).map((turn) => [turn.client_user_message_id, turn]));
  for (const turn of snapshot.turns) {
    if (!turn.clientUserMessageId || !turn.stopReason) continue;
    const timestamp = (value: string | undefined) => {
      const milliseconds = value ? Date.parse(value) : NaN;
      return Number.isSafeInteger(milliseconds) && milliseconds >= 0 ? milliseconds : undefined;
    };
    facts.set(turn.clientUserMessageId, {
      client_user_message_id: turn.clientUserMessageId,
      ...(turn.nativeUserMessageId ? { native_user_message_id: turn.nativeUserMessageId } : {}),
      stop_reason: turn.stopReason,
      ...(turn.error ? { error: boundedText(turn.error) } : {}),
      created_at: timestamp(turn.createdAt),
      completed_at: timestamp(turn.completedAt),
      ...turnObservations(turn, facts.get(turn.clientUserMessageId)),
    });
  }
  const state: DesktopProjectWorkspaceNativeAgentState = {
    preferences: {
      model: selected.model,
      effort: selected.effort,
      interaction_mode:
        snapshot.metadata?.requestedMode ?? previous?.preferences.interaction_mode ?? "default",
      ...(selected.fast === undefined ? {} : { fast: selected.fast }),
      ...(selected.thinking === undefined ? {} : { thinking: selected.thinking }),
      ...(selected.context === undefined ? {} : { context: selected.context }),
    },
    ever_saved: everSaved,
    turns: [...facts.values()].slice(-64),
  };
  let turns = state.turns ?? [];
  while (turns.length && Buffer.byteLength(JSON.stringify({ ...state, turns }), "utf8") > 262_144)
    turns = turns.slice(1);
  return { ...state, turns };
};

export const nativeHistoryFacts = (
  state: DesktopProjectWorkspaceNativeAgentState | null,
): AgentHistoryFact[] =>
  (state?.turns ?? []).map((turn): AgentHistoryFact => ({
    clientUserMessageId: turn.client_user_message_id,
    ...(turn.native_user_message_id ? { nativeUserMessageId: turn.native_user_message_id } : {}),
    stopReason: turn.stop_reason,
    error: turn.error,
    ...(turn.created_at == null ? {} : { createdAt: new Date(turn.created_at).toISOString() }),
    ...(turn.completed_at == null
      ? {}
      : { completedAt: new Date(turn.completed_at).toISOString() }),
    ...(turn.usage
      ? {
          usage: {
            used: turn.usage.used,
            size: turn.usage.size,
            cost:
              turn.usage.cost_micros == null
                ? null
                : {
                    amount: turn.usage.cost_micros / 1_000_000,
                    currency: turn.usage.currency ?? "USD",
                  },
            ...(turn.usage.tokens ? { tokens: restoredTokens(turn.usage.tokens) } : {}),
            ...(turn.usage.cumulative_tokens
              ? { cumulativeTokens: restoredTokens(turn.usage.cumulative_tokens) }
              : {}),
            ...(turn.usage.model ? { model: turn.usage.model } : {}),
            ...(turn.usage.context_estimated == null
              ? {}
              : { contextEstimated: turn.usage.context_estimated }),
          },
        }
      : {}),
    ...(turn.compactions?.length
      ? {
          compactions: turn.compactions.map(
            (item): NonNullable<AgentHistoryFact["compactions"]>[number] => ({
              compactionId: item.id,
              status: item.status,
              summary: item.summary,
              error: item.error,
              ...(item.trigger === "auto" || item.trigger === "manual"
                ? { trigger: item.trigger }
                : {}),
              ...(item.pre_tokens == null ? {} : { preTokens: item.pre_tokens }),
              ...(item.post_tokens == null ? {} : { postTokens: item.post_tokens }),
              ...(item.duration_ms == null ? {} : { durationMs: item.duration_ms }),
            }),
          ),
        }
      : {}),
    ...(turn.artifacts?.length
      ? {
          artifacts: turn.artifacts.map((item) => ({
            filename: item.filename,
            ...(item.file_id == null ? {} : { fileId: item.file_id }),
            ...(item.error == null ? {} : { error: item.error }),
          })),
        }
      : {}),
  }));

/** Forked native records get new UUIDs; unmatched facts never cross the branch boundary. */
export const remapNativeState = (
  state: DesktopProjectWorkspaceNativeAgentState,
  messageIdMap: Readonly<Record<string, string>>,
) => ({
  ...state,
  turns: (state.turns ?? []).flatMap((turn) => {
    const uuid = turn.native_user_message_id && messageIdMap[turn.native_user_message_id];
    return uuid ? [{ ...turn, native_user_message_id: uuid }] : [];
  }),
});
