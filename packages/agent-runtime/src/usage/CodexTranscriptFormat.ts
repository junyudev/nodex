import * as Schema from "effect/Schema";

import {
  asRecord,
  parseTimestampMs,
  type TranscriptFormat,
  type TranscriptRecord,
  type UsageRequestRecord,
  type UsageSpeed,
} from "./UsageRecord.ts";

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const CodexTokenUsage = Schema.Struct({
  input_tokens: TokenCount,
  cached_input_tokens: TokenCount,
  cache_write_input_tokens: TokenCount,
  output_tokens: TokenCount,
  reasoning_output_tokens: TokenCount,
  total_tokens: TokenCount,
}).check(
  Schema.makeFilter(
    (usage) =>
      usage.cached_input_tokens + usage.cache_write_input_tokens <= usage.input_tokens &&
      usage.reasoning_output_tokens <= usage.output_tokens &&
      usage.total_tokens >= usage.input_tokens + usage.output_tokens,
  ),
);
type CodexTokenUsage = typeof CodexTokenUsage.Type;
const isCodexTokenUsage = Schema.is(CodexTokenUsage);
const CODEX_USAGE_FIELDS = Object.keys(CodexTokenUsage.fields) as (keyof CodexTokenUsage)[];

function readCodexTokenUsage(value: unknown): CodexTokenUsage | null {
  const raw = asRecord(value);
  if (raw === null) return null;
  const input = raw["input_tokens"];
  const output = raw["output_tokens"];
  if (typeof input !== "number" || typeof output !== "number") return null;
  const usage = {
    input_tokens: input,
    cached_input_tokens: raw["cached_input_tokens"] === undefined ? 0 : raw["cached_input_tokens"],
    cache_write_input_tokens:
      raw["cache_write_input_tokens"] === undefined ? 0 : raw["cache_write_input_tokens"],
    output_tokens: output,
    reasoning_output_tokens:
      raw["reasoning_output_tokens"] === undefined ? 0 : raw["reasoning_output_tokens"],
    total_tokens: raw["total_tokens"] === undefined ? input + output : raw["total_tokens"],
  };
  return isCodexTokenUsage(usage) ? usage : null;
}

const CodexSpeed = Schema.Literals(["standard", "fast", "ultrafast"]);

// What a request is billed as is fixed when it is read, not when a later snapshot reconciles it.
const CodexUnreportedRequest = Schema.Struct({
  timestampMs: Schema.Finite,
  model: Schema.String,
  speed: CodexSpeed,
  usage: CodexTokenUsage,
});
type CodexUnreportedRequest = typeof CodexUnreportedRequest.Type;
type CodexRequestAttribution = Omit<CodexUnreportedRequest, "usage">;

/**
 * Codex `token_count` events carry no model or service tier, so both carry forward: the model from
 * the most recent `turn_context`, the tier from the most recent `thread_settings_applied`.
 */
export const CodexScanState = Schema.Struct({
  model: Schema.mutableKey(Schema.String),
  speed: Schema.mutableKey(CodexSpeed),
  sessionId: Schema.mutableKey(Schema.String),
  /** The conversation a subagent or fork works for, which is the one its origin follows. */
  parentSessionId: Schema.mutableKey(Schema.NullOr(Schema.String)),
  subagent: Schema.mutableKey(Schema.Boolean),
  lastUsageSignature: Schema.mutableKey(Schema.NullOr(Schema.String)),
  lastCumulativeUsage: Schema.mutableKey(Schema.NullOr(CodexTokenUsage)),
  sequenceStartSignature: Schema.mutableKey(Schema.optionalKey(Schema.String)),
  // `token_usage_record` usage since the last cumulative snapshot, one entry per record.
  unreportedRequests: Schema.mutableKey(
    Schema.optionalKey(Schema.mutable(Schema.Array(CodexUnreportedRequest))),
  ),
  sawSessionMeta: Schema.mutableKey(Schema.Boolean),
  suppressingForkCopies: Schema.mutableKey(Schema.Boolean),
  forkCopyAnchorMs: Schema.mutableKey(Schema.Finite),
});
export type CodexScanState = typeof CodexScanState.Type;
const isCodexScanState = Schema.is(CodexScanState);

function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    speed: "standard",
    sessionId: "",
    parentSessionId: null,
    subagent: false,
    lastUsageSignature: null,
    lastCumulativeUsage: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

// A zeroed baseline rebases the counters, so the sequence start measured against it is forgotten.
function rebaseCodexUsage(state: CodexScanState, cumulative: CodexTokenUsage) {
  state.lastCumulativeUsage = cumulative;
  delete state.unreportedRequests;
  if (cumulative.input_tokens + cumulative.output_tokens === 0) delete state.sequenceStartSignature;
}

function advanceCodexUsage(previous: CodexTokenUsage | null, last: CodexTokenUsage) {
  return readCodexTokenUsage(
    Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, (previous?.[key] ?? 0) + last[key]])),
  );
}

// An interrupted turn can end before a snapshot reports its last request. Bill those requests only
// when the `token_usage_record`s since the previous snapshot explain the whole gap; `last` is the
// final one.
function unreportedRequests(
  previous: CodexTokenUsage | null,
  cumulative: CodexTokenUsage,
  last: CodexTokenUsage,
  pending: readonly CodexUnreportedRequest[] | undefined,
) {
  if (
    previous === null ||
    pending === undefined ||
    CODEX_USAGE_FIELDS.some(
      (key) =>
        cumulative[key] - previous[key] !==
        pending.reduce((sum, request) => sum + request.usage[key], 0),
    )
  ) {
    return null;
  }
  const final = pending.at(-1)!;
  const remainder = readCodexTokenUsage(
    Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, final.usage[key] - last[key]])),
  );
  if (remainder === null) return null;
  return [...pending.slice(0, -1), { ...final, usage: remainder }].filter(
    (request) => request.usage.input_tokens + request.usage.output_tokens > 0,
  );
}

/** Forks copy and restamp parent history in a burst (0-40ms gaps); genuine child usage follows a model turn (5s+ observed). */
const FORK_COPY_MAX_GAP_MS = 1000;

function forkParent(payload: Record<string, unknown>): string | null {
  if (typeof payload["forked_from_id"] === "string") return payload["forked_from_id"];
  const spawn = asRecord(asRecord(asRecord(payload["source"])?.["subagent"])?.["thread_spawn"]);
  return typeof spawn?.["parent_thread_id"] === "string" ? spawn["parent_thread_id"] : null;
}

// The first usage line past the copied burst ends suppression for the rest of the rollout.
function isForkCopy(state: CodexScanState, timestampMs: number): boolean {
  if (!state.suppressingForkCopies) return false;
  if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
    state.forkCopyAnchorMs = timestampMs;
    return true;
  }
  state.suppressingForkCopies = false;
  state.lastUsageSignature = null;
  return false;
}

/** Missing, default and standard tiers bill as standard; fast aliases priority. */
function codexSpeed(serviceTier: unknown): UsageSpeed {
  if (serviceTier === "priority" || serviceTier === "fast") return "fast";
  if (serviceTier === "ultrafast") return "ultrafast";
  return "standard";
}

const attribution = (state: CodexScanState, timestampMs: number): CodexRequestAttribution => ({
  timestampMs,
  model: state.model,
  speed: state.speed,
});

function requestRecord(
  usage: CodexTokenUsage,
  { timestampMs, model, speed }: CodexRequestAttribution,
): UsageRequestRecord {
  return {
    kind: "request",
    timestampMs,
    model,
    totals: {
      // Codex reports `input_tokens` inclusive of the cached portion.
      uncachedInputTokens:
        usage.input_tokens - usage.cached_input_tokens - usage.cache_write_input_tokens,
      cachedInputTokens: usage.cached_input_tokens,
      cacheCreationTokens: usage.cache_write_input_tokens,
      outputTokens: usage.output_tokens,
      // Reported inside output_tokens, surfaced separately for the token mix.
      reasoningTokens: usage.reasoning_output_tokens,
    },
    speed,
    dedupeKey: null,
  };
}

function parseTokenCount(
  record: Record<string, unknown>,
  payload: Record<string, unknown>,
  state: CodexScanState,
): readonly TranscriptRecord[] {
  const info = asRecord(payload["info"]);
  if (info === null) return [];

  // Codex may re-emit these counters after the model or timestamp becomes available.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null || state.model.length === 0) return [];

  const last = readCodexTokenUsage(info["last_token_usage"]);
  const rawCumulative = info["total_token_usage"];
  const hasCumulative = rawCumulative !== undefined && rawCumulative !== null;
  const cumulative = hasCumulative ? readCodexTokenUsage(rawCumulative) : null;

  if (isForkCopy(state, timestampMs)) {
    // Copied history is already billed in the parent, but establishes the child's baseline.
    const signature = last === null ? null : JSON.stringify(last);
    if (cumulative !== null) rebaseCodexUsage(state, cumulative);
    else if (!hasCumulative && last !== null && signature !== state.lastUsageSignature) {
      state.lastCumulativeUsage = advanceCodexUsage(state.lastCumulativeUsage, last);
    }
    state.lastUsageSignature = signature;
    return [];
  }

  const previous = state.lastCumulativeUsage;
  const pending = state.unreportedRequests;
  // A valid snapshot remains the next baseline even when its paired request is malformed.
  if (cumulative !== null) rebaseCodexUsage(state, cumulative);
  if (last === null || (hasCumulative && cumulative === null)) return [];

  // Zero-component counters report context size, not a request: fill_to_context_window, or the
  // post-compaction marker whose total is the new context size (its cumulative may reset to zero).
  if (last.input_tokens + last.output_tokens === 0) {
    state.lastUsageSignature = null;
    return [];
  }

  if (
    cumulative !== null &&
    previous !== null &&
    CODEX_USAGE_FIELDS.every((key) => cumulative[key] === previous[key])
  ) {
    return [];
  }

  if (last.total_tokens !== last.input_tokens + last.output_tokens) return [];

  const signature = JSON.stringify(last);
  let unreported: readonly CodexUnreportedRequest[] = [];
  if (cumulative !== null) {
    // A session resumed in a new Codex process restarts its cumulative counters at this request.
    const restarted = CODEX_USAGE_FIELDS.every((key) => cumulative[key] === last[key]);
    const sequenceStart = JSON.stringify([timestampMs, last]);
    // Only the same event is a replay; a later request can restart with identical counters.
    if (restarted && sequenceStart === state.sequenceStartSignature) {
      state.lastCumulativeUsage = previous;
      return [];
    }
    // Forks and paginated continuations can inherit totals without copying a counter snapshot.
    // Only bill the latest request, and require the unseen prefix to be valid usage too.
    const reconciled =
      previous === null
        ? readCodexTokenUsage(
            Object.fromEntries(CODEX_USAGE_FIELDS.map((key) => [key, cumulative[key] - last[key]])),
          ) !== null
        : CODEX_USAGE_FIELDS.every((key) => cumulative[key] - previous[key] === last[key]);
    if (!restarted && !reconciled) {
      const bridged = unreportedRequests(previous, cumulative, last, pending);
      if (bridged === null) return [];
      unreported = bridged;
    }
    if (restarted) state.sequenceStartSignature = sequenceStart;
  } else {
    if (signature === state.lastUsageSignature) return [];
    // Advance expected totals for billed legacy requests so a cumulative re-emission is stale.
    const advanced = advanceCodexUsage(previous, last);
    if (advanced === null) return [];
    state.lastCumulativeUsage = advanced;
  }
  state.lastUsageSignature = signature;

  return [
    ...unreported.map((request) => requestRecord(request.usage, request)),
    requestRecord(last, attribution(state, timestampMs)),
  ];
}

/** Cumulative counters validate request deltas; older events without them dedupe consecutively. */
export function parseCodexLine(line: string, state: CodexScanState): readonly TranscriptRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const record = asRecord(parsed);
  const payload = asRecord(record?.["payload"]);
  if (record === null || payload === null) return [];
  const payloadType = payload["type"];

  if (record["type"] === "session_meta") {
    // Only the first meta identifies this session; copied ancestor metas would misattribute later records.
    if (state.sawSessionMeta) return [];
    state.sawSessionMeta = true;
    const id = payload["id"] ?? payload["session_id"];
    if (typeof id === "string") state.sessionId = id;
    state.subagent = asRecord(payload["source"])?.["subagent"] !== undefined;
    state.parentSessionId = forkParent(payload);
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && state.parentSessionId !== null) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return [];
  }

  if (record["type"] === "turn_context") {
    if (typeof payload["model"] === "string") state.model = payload["model"];
    return [];
  }

  // Several of these may sit between two snapshots, so they only explain a gap in the counters.
  if (record["type"] === "token_usage_record") {
    const timestampMs = parseTimestampMs(record["timestamp"]);
    const usage = readCodexTokenUsage(payload["usage"]);
    if (timestampMs === null || usage === null || state.model.length === 0) return [];
    if (isForkCopy(state, timestampMs)) return [];
    (state.unreportedRequests ??= []).push({ ...attribution(state, timestampMs), usage });
    return [];
  }

  if (payloadType === "thread_settings_applied") {
    const settings = asRecord(payload["thread_settings"]);
    if (settings !== null) state.speed = codexSpeed(settings["service_tier"]);
    return [];
  }

  // Each turn a person starts begins one task; subagents and copied forks are not people talking.
  if (payloadType === "task_started") {
    const timestampMs = parseTimestampMs(record["timestamp"]);
    if (timestampMs === null || state.subagent || state.suppressingForkCopies) return [];
    return [{ kind: "message", timestampMs, dedupeKey: null }];
  }

  if (payloadType !== "token_count") return [];
  return parseTokenCount(record, payload, state);
}

export const codexTranscriptFormat: TranscriptFormat<CodexScanState> = {
  // Metadata lines carry model, tier and session even without usage.
  lineMarkers: [
    '"token_count"',
    '"token_usage_record"',
    '"turn_context"',
    '"thread_settings_applied"',
    '"session_meta"',
    '"task_started"',
  ],
  initialState: initialCodexScanState,
  isState: (value): value is CodexScanState => isCodexScanState(value),
  parseLine: parseCodexLine,
  describeSession: ({ state }) => ({
    sessionId: state.parentSessionId ?? state.sessionId,
    subagent: state.subagent,
  }),
};
