import type {
  SessionMessage,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadItem, ThreadItemEntry, UserInput } from "@nodex/codex-app-server-protocol/v2";
import * as nodePath from "node:path";
import * as Effect from "effect/Effect";
import { loadClaudeAgentSdk } from "../provider/ClaudeAgentSdk.ts";
import { createClaudeSessionStores } from "../provider/ClaudeSessionStore.ts";
import { field, text } from "../orchestration-v2/unknownField.ts";
import { readClaudeWebSearchResults } from "../provider/ClaudeWebSearch.ts";
import type { NativeImportInput } from "./NativeImport.ts";
import * as Schema from "effect/Schema";
import { toolReadImagePath } from "@nodex/runtime-shared/filePreview";
import { normalizeMcpToolCall } from "@nodex/provider-core/server/mcpToolCall";
import { claudeMcpToolIdentity } from "../orchestration-v2/Adapters/ClaudeMcpToolCall.ts";
import { viewedToolOutputImage } from "../orchestration-v2/viewedImageCopy.ts";
import { frozenNativeImportSource, nativeReadContent } from "./NativeImportSource.ts";

const failure = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

/** Read only the captured account. An absent source never falls back to ambient SDK history. */
export const openClaudeImportSource = Effect.fn("ClaudeImportSource.open")(function* (
  input: typeof NativeImportInput.Type,
) {
  const sdk = yield* Effect.tryPromise({ try: loadClaudeAgentSdk, catch: failure });
  const records = yield* Effect.tryPromise({
    try: () =>
      createClaudeSessionStores()(input.sourceHome).load({
        projectKey: "native-import",
        sessionId: input.sourceNativeThreadId,
      }),
    catch: failure,
  });
  if (!records?.length)
    return yield* Effect.fail(new Error("The original conversation is no longer available."));
  const store: SessionStore = {
    load: (key) => Promise.resolve(key.sessionId === input.sourceNativeThreadId ? records : null),
    append: () => Promise.reject(new Error("Import cannot write source history.")),
  };
  // Metadata determines root eligibility; the SDK filters mixed-in sidechain history below.
  const metadata = yield* Effect.tryPromise({
    try: () => sdk.getSessionInfo(input.sourceNativeThreadId, { sessionStore: store }),
    catch: failure,
  });
  if (!metadata?.cwd || !nodePath.isAbsolute(metadata.cwd))
    return yield* Effect.fail(
      new Error("This conversation has no recorded working folder, so it can’t be imported."),
    );
  const messages = yield* Effect.tryPromise({
    try: () =>
      sdk.getSessionMessages(input.sourceNativeThreadId, {
        sessionStore: store,
        includeSystemMessages: true,
      }),
    catch: failure,
  });
  const entries = yield* Effect.try({
    try: () => normalizeMessages(messages, records),
    catch: failure,
  });
  return frozenNativeImportSource(entries, metadata.cwd, "claude");
});

type TrackedTool = {
  readonly entry: ThreadItemEntry;
  readonly finish: (block: unknown, structured: unknown, completedAt: number | null) => ThreadItem;
};

type JsonValue = Extract<ThreadItem, { type: "dynamicToolCall" }>["arguments"];
const isJson = Schema.is(Schema.Json);

function trackedClaudeTool(input: {
  readonly id: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly startedAt: number | null;
}): Omit<TrackedTool, "entry"> | undefined {
  const { id, toolName, args, startedAt } = input;
  const mcp = claudeMcpToolIdentity(toolName);
  if (mcp) {
    return {
      finish: (block, structured, at) => {
        const fallback = field(block, "content");
        const structuredContent = field(structured, "content") ?? structured;
        const content =
          viewedToolOutputImage(fallback) && !viewedToolOutputImage(structuredContent)
            ? fallback
            : Array.isArray(structuredContent) || typeof structuredContent === "string"
              ? structuredContent
              : fallback;
        return normalizeMcpToolCall({
          ...mcp,
          omitImageSourceNotes: true,
          nativeItemId: id,
          arguments: args,
          status:
            block === undefined
              ? "running"
              : field(block, "is_error") === true
                ? "failed"
                : "completed",
          output: {
            content,
            structuredContent: field(structured, "structuredContent"),
            _meta: field(structured, "_meta"),
            isError: field(structured, "isError"),
            is_error: field(structured, "is_error"),
          },
          ...(startedAt === null || at === null ? {} : { startedAtMs: startedAt, updatedAtMs: at }),
        });
      },
    };
  }
  if (toolName !== "Read") return undefined;
  const path = toolReadImagePath(text(field(args, "file_path") ?? field(args, "path"))?.trim());
  if (path === undefined) return undefined;
  return {
    finish: (block, structured, at) => {
      const fallback = field(block, "content");
      const outputText =
        typeof fallback === "string"
          ? fallback
          : Array.isArray(fallback)
            ? fallback
                .flatMap((part: unknown) => {
                  const value = text(field(part, "text"));
                  return field(part, "type") === "text" && value !== undefined ? [value] : [];
                })
                .join("\n") || undefined
            : undefined;
      const image = viewedToolOutputImage(structured) ?? viewedToolOutputImage(fallback);
      const contentItems = nativeReadContent(outputText, image);
      const status =
        block === undefined
          ? "inProgress"
          : field(block, "is_error") === true
            ? "failed"
            : "completed";
      return {
        type: "dynamicToolCall",
        id,
        tool: "Read",
        namespace: null,
        arguments: isJson(args) ? (args as JsonValue) : { file_path: path },
        status,
        success: status === "inProgress" ? null : status === "completed",
        contentItems: contentItems.length > 0 ? contentItems : null,
        durationMs: startedAt === null || at === null ? null : Math.max(0, at - startedAt),
      };
    },
  };
}

/** The import vocabulary reuses the protocol's stored item shapes; driver identity stays Claude. */
function normalizeMessages(
  messages: readonly SessionMessage[],
  records: readonly SessionStoreEntry[],
): ThreadItemEntry[] {
  const raw = new Map(
    records.flatMap((entry) => (entry.uuid ? [[entry.uuid, entry] as const] : [])),
  );
  const webSearches = new Map<string, ThreadItemEntry>();
  const tools = new Map<string, TrackedTool>();
  return messages.flatMap((message) => {
    const record = raw.get(message.uuid);
    const timestamp = typeof record?.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    const at = Number.isFinite(timestamp) ? timestamp : null;
    const wrap = (item: ThreadItem): ThreadItemEntry => ({
      turnId: message.uuid,
      item,
      startedAtMs: at,
      completedAtMs: at,
    });
    if (message.type === "system") {
      if (record?.subtype === "compact_boundary")
        return [wrap({ type: "contextCompaction", id: message.uuid })];
      return [
        wrap({
          type: "functionCallOutput",
          id: message.uuid,
          name: "system",
          namespace: null,
          output: JSON.stringify(message.message) ?? "",
        }),
      ];
    }
    const content = field(message.message, "content");
    if (typeof content !== "string" && !Array.isArray(content))
      throw new Error("A message in this conversation has no readable content.");
    const blocks: readonly unknown[] =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    const result: ThreadItemEntry[] = [];
    const structuredResult =
      blocks.filter((part) => field(part, "type") === "tool_result").length === 1
        ? record?.toolUseResult
        : undefined;
    const userContent: UserInput[] = [];
    for (const [index, block] of blocks.entries()) {
      const id = `${message.uuid}:${index}`;
      const type = field(block, "type");
      if (type === "text" && typeof field(block, "text") === "string") {
        const text = field(block, "text") as string;
        if (message.type === "user") userContent.push({ type: "text", text, text_elements: [] });
        else
          result.push(
            wrap({
              type: "agentMessage",
              moderation: null,
              id,
              text,
              phase: "final_answer",
              memoryCitation: null,
              delivery: null,
              questions: null,
            }),
          );
        continue;
      }
      if (type === "thinking") {
        result.push(
          wrap({
            type: "reasoning",
            id,
            summary: [],
            content: [String(field(block, "thinking") ?? "")],
          }),
        );
        continue;
      }
      if (type === "image" && message.type === "user") {
        userContent.push({ type: "image", url: imageUrl(block) });
        continue;
      }
      const toolName = field(block, "name");
      if (
        (type === "tool_use" || type === "server_tool_use") &&
        (toolName === "WebSearch" || toolName === "web_search")
      ) {
        const toolId = field(block, "id");
        const query = text(field(field(block, "input"), "query")) ?? "";
        const entry = wrap({
          type: "webSearch",
          id,
          query,
          action: { type: "search", query: query || null, queries: null },
          results: null,
        });
        if (typeof toolId === "string") webSearches.set(toolId, entry);
        result.push(entry);
        continue;
      }
      const toolUseId = field(block, "tool_use_id");
      const search = typeof toolUseId === "string" ? webSearches.get(toolUseId) : undefined;
      if (
        search?.item.type === "webSearch" &&
        (type === "tool_result" || type === "web_search_tool_result")
      ) {
        const results = readClaudeWebSearchResults(
          type === "web_search_tool_result" ? field(block, "content") : record?.toolUseResult,
        );
        if (results.length > 0) {
          search.item = { ...search.item, results };
          search.completedAtMs = at;
          continue;
        }
      }
      if (type === "tool_use" && typeof toolName === "string") {
        const toolId = field(block, "id");
        if (typeof toolId === "string") {
          const tool = trackedClaudeTool({
            id,
            toolName,
            args: field(block, "input"),
            startedAt: at,
          });
          if (tool) {
            const entry = wrap(tool.finish(undefined, undefined, null));
            tools.set(toolId, { ...tool, entry });
            result.push(entry);
            continue;
          }
        }
      }
      if (type === "tool_result" && typeof toolUseId === "string") {
        const tool = tools.get(toolUseId);
        if (tool) {
          tool.entry.item = tool.finish(block, structuredResult, at);
          tool.entry.completedAtMs = at;
          continue;
        }
      }
      const images: string[] = [];
      const copied = withoutMedia(block, images);
      const serialized = JSON.stringify(copied);
      result.push(
        wrap({
          type: "functionCallOutput",
          id,
          name: typeof toolName === "string" ? toolName : String(type ?? "native_record"),
          namespace: null,
          output:
            images.length === 0
              ? serialized
              : [
                  { type: "input_text", text: serialized },
                  ...images.map((image_url) => ({ type: "input_image" as const, image_url })),
                ],
        }),
      );
    }
    if (userContent.length > 0)
      result.unshift(
        wrap({ type: "userMessage", id: message.uuid, clientId: null, content: userContent }),
      );
    return result;
  });
}

function imageUrl(value: unknown): string {
  const source = field(value, "source");
  const type = field(source, "type");
  const mime = field(source, "media_type");
  const data = field(source, "data");
  if (
    type !== "base64" ||
    typeof mime !== "string" ||
    !mime.startsWith("image/") ||
    typeof data !== "string"
  )
    throw new Error("This conversation contains an image that cannot be copied into Nodex.");
  return `data:${mime};base64,${data}`;
}

function withoutMedia(value: unknown, images: string[]): unknown {
  if (Array.isArray(value)) return value.map((entry) => withoutMedia(entry, images));
  if (typeof value !== "object" || value === null) return value;
  const type = field(value, "type");
  if (type === "image") {
    images.push(imageUrl(value));
    return { type: "image", copied: true };
  }
  if (type === "document" || type === "audio" || type === "video")
    throw new Error("This conversation contains media that cannot yet be copied into Nodex.");
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, withoutMedia(entry, images)]),
  );
}
