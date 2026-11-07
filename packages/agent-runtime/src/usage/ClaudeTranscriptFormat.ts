import * as nodePath from "node:path";

import {
  asRecord,
  parseTimestampMs,
  tokenCount,
  type TranscriptFormat,
  type TranscriptRecord,
  type UsageRequestRecord,
} from "./UsageRecord.ts";

// Claude Code uses this model for local placeholders that never reached the API.
const SYNTHETIC_MODEL = "<synthetic>";

function isPersonMessage(record: Record<string, unknown>, line: string): boolean {
  if (record["isMeta"] === true || record["isSidechain"] === true) return false;
  if (record["isCompactSummary"] === true) return false;
  if (line.includes('"tool_result"')) return false;
  const content = asRecord(record["message"])?.["content"];
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content
            .map((part) => asRecord(part)?.["text"])
            .find((part) => typeof part === "string") ?? "")
        : "";
  // Local slash-command output is written as a user line but nobody typed it.
  return typeof text === "string" && !text.startsWith("<local-command");
}

/**
 * Claude Code writes one record per assistant content block, each repeating its message's complete
 * usage, so summing them overcounts; `dedupeKey` keeps the first. Top-level usage is the executor's
 * alone: advisor calls bill another model and appear only in `iterations`.
 */
export function parseClaudeLine(line: string): readonly TranscriptRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [];
  }
  const record = asRecord(parsed);
  if (record === null) return [];

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return [];

  if (record["type"] === "user") {
    if (!isPersonMessage(record, line)) return [];
    const uuid = record["uuid"];
    return [{ kind: "message", timestampMs, dedupeKey: typeof uuid === "string" ? uuid : null }];
  }

  if (record["type"] !== "assistant") return [];
  const message = asRecord(record["message"]);
  const usage = asRecord(message?.["usage"]);
  if (message === null || usage === null) return [];

  const model = typeof message["model"] === "string" ? message["model"] : "";
  if (model.length === 0 || model === SYNTHETIC_MODEL) return [];

  const messageId = typeof message["id"] === "string" ? message["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;
  const speed = usage["speed"] === "fast" ? "fast" : "standard";

  const executor: UsageRequestRecord = {
    kind: "request",
    timestampMs,
    model,
    totals: {
      uncachedInputTokens: tokenCount(usage["input_tokens"]),
      cachedInputTokens: tokenCount(usage["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usage["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usage["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    speed,
    dedupeKey,
  };

  const records: TranscriptRecord[] = [executor];
  const iterations = Array.isArray(usage["iterations"]) ? usage["iterations"] : [];
  for (const [index, iteration] of iterations.entries()) {
    const advisor = asRecord(iteration);
    if (advisor === null || advisor["type"] !== "advisor_message") continue;
    const advisorModel = typeof advisor["model"] === "string" ? advisor["model"] : "";
    if (advisorModel.length === 0 || advisorModel === SYNTHETIC_MODEL) continue;
    records.push({
      kind: "request",
      timestampMs,
      model: advisorModel,
      totals: {
        uncachedInputTokens: tokenCount(advisor["input_tokens"]),
        cachedInputTokens: tokenCount(advisor["cache_read_input_tokens"]),
        cacheCreationTokens: tokenCount(advisor["cache_creation_input_tokens"]),
        outputTokens: tokenCount(advisor["output_tokens"]),
        reasoningTokens: 0,
      },
      speed,
      dedupeKey: dedupeKey === null ? null : `${dedupeKey}:advisor:${index}`,
    });
  }
  return records;
}

export const claudeTranscriptFormat: TranscriptFormat<null> = {
  lineMarkers: ['"usage"', '"type":"user"'],
  initialState: () => null,
  isState: (value): value is null => value === null,
  parseLine: (line) => parseClaudeLine(line),
  describeSession: ({ path }) => {
    // A session's file is named after it; subagent work lives in `<session>/subagents/`.
    const parts = path.split(nodePath.sep);
    const subagents = parts.lastIndexOf("subagents");
    return subagents > 0
      ? { sessionId: parts[subagents - 1]!, subagent: true }
      : { sessionId: nodePath.basename(path).replace(/\.jsonl(\.zst)?$/, ""), subagent: false };
  },
};
