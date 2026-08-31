import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const MAX_ROLLOUT_FILES = 16;
const MAX_ROLLOUT_BYTES = 8 * 1024 * 1024;

export interface PaidAgentRolloutTurnContext {
  readonly turnId: string | null;
  readonly model: string | null;
  readonly effort: string | null;
}

export interface PaidAgentRolloutToolCall {
  readonly type: string;
  readonly name: string | null;
  readonly server: string | null;
  readonly tool: string | null;
  readonly status: string | null;
}

export interface PaidAgentRolloutEvidence {
  readonly threadId: string;
  readonly modelProvider: string | null;
  readonly turnContexts: readonly PaidAgentRolloutTurnContext[];
  readonly toolCalls: readonly PaidAgentRolloutToolCall[];
  readonly malformedLineCount: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

const listRolloutFiles = async (directory: string): Promise<string[]> => {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) return await listRolloutFiles(candidate);
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [candidate] : [];
    }),
  );
  return nested.flat();
};

const parseJsonLines = (
  contents: string,
): { records: Record<string, unknown>[]; malformed: number } => {
  const records: Record<string, unknown>[] = [];
  let malformed = 0;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { records, malformed };
};

const isToolCallPayload = (payload: Record<string, unknown>): boolean => {
  const type = stringOrNull(payload.type);
  if (!type || type.endsWith("_output")) return false;
  return type.includes("tool_call") || type === "function_call" || type === "custom_tool_call";
};

/** Extracts a bounded, allowlisted diagnostic summary from the exact thread rollout. */
export async function readPaidAgentRolloutEvidence(
  codexHome: string,
  threadId: string,
): Promise<PaidAgentRolloutEvidence | null> {
  const files = (await listRolloutFiles(path.join(codexHome, "sessions")))
    .sort()
    .slice(-MAX_ROLLOUT_FILES);
  for (const file of files.reverse()) {
    const metadata = await stat(file);
    if (metadata.size > MAX_ROLLOUT_BYTES) {
      throw new Error(`Paid Agent rollout exceeds the ${MAX_ROLLOUT_BYTES}-byte evidence bound`);
    }
    const parsed = parseJsonLines(await readFile(file, "utf8"));
    const sessionMeta = parsed.records.find(
      (record) =>
        record.type === "session_meta" &&
        isRecord(record.payload) &&
        record.payload.id === threadId,
    );
    if (!sessionMeta || !isRecord(sessionMeta.payload)) continue;

    const turnContexts: PaidAgentRolloutTurnContext[] = [];
    const toolCalls: PaidAgentRolloutToolCall[] = [];
    for (const record of parsed.records) {
      if (!isRecord(record.payload)) continue;
      const payload = record.payload;
      if (record.type === "turn_context") {
        turnContexts.push({
          turnId: stringOrNull(payload.turn_id),
          model: stringOrNull(payload.model),
          effort: stringOrNull(payload.effort),
        });
      }
      if (record.type === "response_item" && isToolCallPayload(payload)) {
        toolCalls.push({
          type: stringOrNull(payload.type) ?? "unknown",
          name: stringOrNull(payload.name),
          server: stringOrNull(payload.server),
          tool: stringOrNull(payload.tool),
          status: stringOrNull(payload.status),
        });
      }
    }
    return {
      threadId,
      modelProvider: stringOrNull(sessionMeta.payload.model_provider),
      turnContexts,
      toolCalls,
      malformedLineCount: parsed.malformed,
    };
  }
  return null;
}
