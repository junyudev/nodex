import type { z } from "zod";
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
  if (toolResultBytes(value) > Math.min(maxBytes, 768 * 1024))
    return toolFailure(
      "result_too_large",
      "The complete result exceeds the tool budget. Narrow the query; no partial result was returned.",
    );
  return result;
};

/** Admission and delivery charge the same complete MCP envelope. */
export const toolResultBytes = (value: Record<string, unknown>): number =>
  Buffer.byteLength(
    JSON.stringify({
      content: [{ type: "text", text: JSON.stringify(value) }],
      structuredContent: value,
    }),
    "utf8",
  );

/** Parse once at the tool boundary and retain field paths and reasons in the MCP error. */
export const parseAppToolArguments = <T extends z.ZodType>(
  schema: T,
  input: unknown,
):
  | { readonly success: true; readonly data: z.output<T> }
  | { readonly success: false; readonly result: CallToolResult } => {
  const parsed = schema.safeParse(input);
  if (parsed.success) return { success: true, data: parsed.data as z.output<T> };
  const issues = parsed.error.issues.flatMap((issue) => {
    const path = issue.path.map((part) => (typeof part === "symbol" ? String(part) : part));
    if (issue.code === "unrecognized_keys")
      return issue.keys.map((key) => ({
        path: [...path, key],
        message: `Unknown argument "${key}". Remove it or use a supported field.`,
      }));
    return [{ path, message: issue.message }];
  });
  return {
    success: false,
    result: toolFailure("invalid_arguments", "Correct the listed argument fields and try again.", {
      issues,
    }),
  };
};
