import type { ThreadItem } from "@nodex/codex-app-server-protocol/v2";
import type { OrchestrationV2TurnItem } from "@nodex/runtime-contracts";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

const field = (value: unknown, key: string): unknown =>
  Predicate.isObject(value) ? value[key] : undefined;

type McpToolCall = Extract<ThreadItem, { readonly type: "mcpToolCall" }>;
type CommonJson = Schema.Json & McpToolCall["arguments"];
type RuntimeMcpToolCall = NonNullable<
  Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }>["mcpToolCall"]
>;

// Claude appends this local file note after an image; it is not server output.
const CLI_IMAGE_NOTE =
  /^\[Image: source: (?:\/|[A-Za-z]:[\\/])[^\r\n\]]+[\\/]tool-results[\\/][^\r\n\]]+\](?![\s\S])/u;

const isJson = Schema.is(Schema.Json);
// The wire protocol declares mutable arrays; validation does not mutate the provider's JSON.
const jsonValue = (value: unknown): CommonJson => (isJson(value) ? (value as CommonJson) : null);

function isCliImageNote(block: unknown, previous: unknown): boolean {
  const text = field(block, "text");
  return (
    field(block, "type") === "text" &&
    typeof text === "string" &&
    CLI_IMAGE_NOTE.test(text) &&
    field(previous, "type") === "image"
  );
}

function normalizeContent(output: unknown, omitImageSourceNotes: boolean): CommonJson[] {
  const rawContent = field(output, "content") ?? output;
  if (typeof rawContent === "string") return [{ type: "text", text: rawContent }];
  if (!Array.isArray(rawContent)) return [];
  return rawContent
    .filter(
      (block, index) => !omitImageSourceNotes || !isCliImageNote(block, rawContent[index - 1]),
    )
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

/** Normalize MCP content for transcript persistence and image indexing. */
export function normalizeMcpToolCall(input: {
  readonly server: string;
  readonly tool: string;
  readonly nativeItemId: string;
  readonly arguments: unknown;
  readonly output: unknown;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAtMs?: number;
  readonly updatedAtMs?: number;
  readonly errorMessage?: string;
  readonly omitImageSourceNotes?: boolean;
}) {
  const running = input.status === "running";
  const failed =
    input.status !== "completed" ||
    input.errorMessage !== undefined ||
    field(input.output, "isError") === true ||
    field(input.output, "is_error") === true;
  const content = normalizeContent(input.output, input.omitImageSourceNotes === true);
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
    server: input.server,
    tool: input.tool,
    environmentId: null,
    appContext: null,
    mcpAppUi: null,
    pluginId: null,
    readOnlyHint: null,
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
              input.errorMessage ??
              (errorText || `Tool call ${input.status === "completed" ? "failed" : input.status}`),
          },
    durationMs:
      running || input.startedAtMs === undefined || input.updatedAtMs === undefined
        ? null
        : Math.max(0, input.updatedAtMs - input.startedAtMs),
  } satisfies McpToolCall & RuntimeMcpToolCall;
}
