import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { field } from "../unknownField.ts";

type McpToolCall = NonNullable<
  Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>["mcpToolCall"]
>;

// Claude appends this local file note after an image; it is not server output.
const CLI_IMAGE_NOTE =
  /^\[Image: source: (?:\/|[A-Za-z]:[\\/])[^\r\n\]]+[\\/]tool-results[\\/][^\r\n\]]+\](?![\s\S])/u;

const isJson = Schema.is(Schema.Json);
const jsonValue = (value: unknown): Schema.Json => (isJson(value) ? value : null);

function isCliImageNote(block: unknown, previous: unknown): boolean {
  const text = field(block, "text");
  return (
    field(block, "type") === "text" &&
    typeof text === "string" &&
    CLI_IMAGE_NOTE.test(text) &&
    field(previous, "type") === "image"
  );
}

function normalizeContent(output: unknown): ReadonlyArray<Schema.Json> {
  const rawContent = field(output, "content") ?? output;
  if (typeof rawContent === "string") return [{ type: "text", text: rawContent }];
  if (!Array.isArray(rawContent)) return [];
  return rawContent
    .filter((block, index) => !isCliImageNote(block, rawContent[index - 1]))
    .map((block) => {
      const source = field(block, "source");
      if (
        field(block, "type") !== "image" ||
        field(source, "type") !== "base64" ||
        typeof field(source, "media_type") !== "string" ||
        typeof field(source, "data") !== "string"
      )
        return jsonValue(block);
      const { source: _source, ...rest } = block as Record<string, unknown>;
      return jsonValue({
        ...rest,
        mimeType: field(source, "media_type"),
        data: field(source, "data"),
      });
    });
}

/** Normalize Claude's MCP envelope once, before persistence and image indexing. */
export function claudeMcpToolCall(input: {
  readonly toolName: string;
  readonly nativeItemId: string;
  readonly arguments: unknown;
  readonly output: unknown;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAtMs: number;
  readonly updatedAtMs: number;
}): McpToolCall | undefined {
  const match = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/u.exec(input.toolName);
  if (!match || match[1] === "nodex_app") return undefined;
  const running = input.status === "running";
  const failed =
    input.status !== "completed" ||
    field(input.output, "isError") === true ||
    field(input.output, "is_error") === true;
  const content = normalizeContent(input.output);
  const errorText = content
    .flatMap((block) =>
      field(block, "type") === "text" && typeof field(block, "text") === "string"
        ? [field(block, "text") as string]
        : [],
    )
    .join("\n")
    .trim();
  return {
    type: "mcpToolCall",
    id: input.nativeItemId,
    server: match[1]!,
    tool: match[2]!,
    arguments: jsonValue(input.arguments),
    status: running ? "inProgress" : failed ? "failed" : "completed",
    result:
      running || input.output === undefined
        ? null
        : {
            content,
            structuredContent: jsonValue(field(input.output, "structuredContent")),
            _meta: jsonValue(field(input.output, "_meta")),
          },
    error:
      running || !failed
        ? null
        : {
            message:
              errorText || `Tool call ${input.status === "completed" ? "failed" : input.status}`,
          },
    durationMs: running ? null : Math.max(0, input.updatedAtMs - input.startedAtMs),
  };
}
