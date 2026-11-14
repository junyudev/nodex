const MAX_MCP_APP_FOLLOW_UP_CONTEXT_CHARACTERS = 32_768;
const MAX_MCP_APP_FOLLOW_UP_TITLE_CHARACTERS = 250;

export interface McpAppFollowUpMessage {
  context?: unknown;
  prompt: string;
  title?: string;
  send?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function serializeContext(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value, null, 2);
    if (typeof serialized !== "string") return null;
    if (serialized.length > MAX_MCP_APP_FOLLOW_UP_CONTEXT_CHARACTERS) return null;
    return serialized;
  } catch {
    return null;
  }
}

export function parseMcpAppFollowUpMessage(value: unknown): McpAppFollowUpMessage | null {
  const record = asRecord(value);
  if (!record || typeof record.prompt !== "string") return null;
  const prompt = record.prompt.trim();
  if (!prompt) return null;

  const titleValue = record.title;
  const title = typeof titleValue === "string" ? titleValue.trim() : null;
  if (
    titleValue !== undefined &&
    (!title || title.length > MAX_MCP_APP_FOLLOW_UP_TITLE_CHARACTERS)
  ) {
    return null;
  }

  if (record.context !== undefined && serializeContext(record.context) === null) return null;
  return {
    ...(record.context === undefined ? {} : { context: record.context }),
    prompt,
    ...(title === null ? {} : { title }),
  };
}

export function buildMcpAppFollowUpPrompt(message: McpAppFollowUpMessage): string {
  if (message.context === undefined) return message.prompt;
  const context = serializeContext(message.context);
  if (context === null) return message.prompt;
  return `${message.prompt}\n\nCurrent widget context (JSON):\n${context}`;
}

/** OpenAI's message extension keeps the selected chat as the sole recipient. */
export function parsePluginAppMessage(value: unknown): McpAppFollowUpMessage | null {
  const message = asRecord(value);
  if (message?.role !== "user" || !Array.isArray(message.content)) return null;
  const options = asRecord(asRecord(message._meta)?.["openai/message"]);
  if (options?.target !== undefined && options.target !== "active") return null;
  if (options?.send !== undefined && typeof options.send !== "boolean") return null;
  const parts = message.content.map(asRecord);
  if (!parts.every((part) => part?.type === "text" && typeof part.text === "string")) return null;
  const prompt = parts
    .map((part) => part?.text)
    .join("\n\n")
    .trim();
  if (!prompt || prompt.length > MAX_MCP_APP_FOLLOW_UP_CONTEXT_CHARACTERS) return null;
  return { prompt, send: options?.send !== false };
}
