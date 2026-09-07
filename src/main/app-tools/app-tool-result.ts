import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const toolFailure = (
  code: string,
  message = code,
  details?: Record<string, unknown>,
): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: details ? JSON.stringify({ message, ...details }) : message }],
  structuredContent: { error: { code, ...(details ? { details } : {}) } },
});

/** Leave protocol overhead below the private bridge's complete-frame budget. */
export const toolSuccess = (
  value: Record<string, unknown>,
  maxBytes = 768 * 1024,
): CallToolResult => {
  const result: CallToolResult = {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
  };
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > Math.min(maxBytes, 768 * 1024))
    return toolFailure(
      "result_too_large",
      "The complete result exceeds the tool budget. Narrow the query; no partial result was returned.",
    );
  return result;
};
