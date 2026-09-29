/** Native user/tool-result records share a wire type; only human main-thread prompts start turns. */
export const isClaudeHistoryPrompt = (entry: {
  readonly type: string;
  readonly parent_tool_use_id?: string | null;
  readonly parent_agent_id?: string | null;
  readonly message: unknown;
  readonly isSynthetic?: boolean;
  readonly isMeta?: boolean;
}): boolean => {
  if (
    entry.type !== "user" ||
    entry.parent_tool_use_id ||
    entry.parent_agent_id ||
    entry.isSynthetic ||
    entry.isMeta
  )
    return false;
  if (!entry.message || typeof entry.message !== "object" || Array.isArray(entry.message))
    return false;
  const message = entry.message as Record<string, unknown>;
  if (message.isSynthetic === true || message.isMeta === true) return false;
  if (typeof message.content === "string") return message.content.trim().length > 0;
  if (!Array.isArray(message.content)) return false;
  const blocks = message.content as readonly { readonly type?: string; readonly text?: unknown }[];
  if (blocks.some((block) => block.type === "tool_result")) return false;
  return blocks.some(
    (block) =>
      block.type === "image" ||
      (block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0),
  );
};

export const claudeHistoryPromptText = (entry: { readonly message: unknown }): string => {
  if (!entry.message || typeof entry.message !== "object" || Array.isArray(entry.message))
    return "";
  const message = entry.message as Record<string, unknown>;
  if (typeof message.content === "string") return message.content.slice(0, 64 * 1024);
  if (!Array.isArray(message.content)) return "";
  return (message.content as readonly { readonly type?: string; readonly text?: unknown }[])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .slice(0, 64 * 1024);
};
