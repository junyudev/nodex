type UnknownRecord = Record<string, unknown>;

const MCP_ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "content",
  "structuredContent",
  "isError",
  "is_error",
  "_meta",
]);
const MAX_ENVELOPE_DEPTH = 4;
/** Claude reports a failed call's result as text after this label. */
const FAILURE_LABEL = /^\s*Error:\s*/u;

const asRecord = (value: unknown): UnknownRecord | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

/**
 * A provider hands back a tool's result as its own JSON or inside an MCP envelope that may hold it
 * as text. Only a value made of envelope keys is unwrapped, because a result can have its own
 * `content` field. Returns null for anything that is not a JSON object.
 */
export function unwrapToolResult(value: unknown, depth = 0): UnknownRecord | null {
  if (depth > MAX_ENVELOPE_DEPTH) return null;
  if (typeof value === "string") {
    const text = value.replace(FAILURE_LABEL, "");
    if (!/^\s*[{[]/u.test(text)) return null;
    try {
      return unwrapToolResult(JSON.parse(text), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const block of value) {
      const result = unwrapToolResult(asRecord(block)?.text, depth + 1);
      if (result) return result;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  const isEnvelope =
    Object.keys(record).every((key) => MCP_ENVELOPE_KEYS.has(key)) &&
    (record.structuredContent != null || record.content !== undefined);
  return isEnvelope
    ? unwrapToolResult(record.structuredContent ?? record.content, depth + 1)
    : record;
}

/** A tool's output as a person reads it: its own JSON, or the words it answered with. */
export function formatToolResultText(text: string): string {
  const result = unwrapToolResult(text);
  if (result) return JSON.stringify(result, null, 2);
  const unlabelled = text.replace(FAILURE_LABEL, "");
  try {
    const content = asRecord(JSON.parse(unlabelled))?.content;
    return typeof content === "string" ? content.replace(FAILURE_LABEL, "") : unlabelled;
  } catch {
    return unlabelled;
  }
}
