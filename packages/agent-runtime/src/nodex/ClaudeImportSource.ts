import type {
  SessionMessage,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadItem, ThreadItemEntry, UserInput } from "@nodex/codex-app-server-protocol/v2";
import * as nodePath from "node:path";
import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import { loadClaudeAgentSdk } from "../provider/ClaudeAgentSdk.ts";
import { createClaudeSessionStores } from "../provider/ClaudeSessionStore.ts";
import { field } from "../orchestration-v2/unknownField.ts";
import type { NativeImportInput } from "./NativeImport.ts";
import type { NativeImportBoundary } from "./NativeImportSource.ts";

const failure = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));
const revision = (entries: readonly ThreadItemEntry[]) =>
  createHash("sha256").update(JSON.stringify(entries)).digest("hex");

/** Read only the captured account. An absent source never falls back to ambient SDK history. */
export const openClaudeImportSource = Effect.fn("ClaudeImportSource.open")(function* (
  input: typeof NativeImportInput.Type,
) {
  const sdk = yield* Effect.tryPromise({ try: loadClaudeAgentSdk, catch: failure });
  const records = yield* Effect.tryPromise({
    try: () =>
      createClaudeSessionStores()(input.sourceHome, input.sourceNativeThreadId).load({
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
  return {
    capture: () =>
      Effect.succeed({
        boundaryItemId: entries.at(-1)?.item.id ?? null,
        boundaryTurnId: entries.at(-1)?.turnId ?? null,
        historyMode: "claude" as const,
        sourceCwd: metadata.cwd!,
        sourceRevision: revision(entries),
      }),
    page: (boundary: NativeImportBoundary, cursor: string | null) =>
      Effect.try({
        try: () => {
          if (boundary.boundaryItemId === null) return { data: [], nextCursor: null };
          const end = entries.findIndex(
            (entry) =>
              entry.item.id === boundary.boundaryItemId && entry.turnId === boundary.boundaryTurnId,
          );
          if (end < 0)
            throw new Error("The source conversation changed while its history was being copied.");
          if (boundary.sourceRevision !== revision(entries.slice(0, end + 1)))
            throw new Error("The source conversation changed while its history was being copied.");
          const start =
            cursor === null ? 0 : entries.findIndex((entry) => entry.item.id === cursor) + 1;
          if (cursor !== null && start === 0)
            throw new Error("The source conversation changed while its history was being copied.");
          const data = entries.slice(start, Math.min(start + 25, end + 1));
          return { data, nextCursor: start + data.length <= end ? data.at(-1)!.item.id : null };
        },
        catch: failure,
      }),
    close: Effect.void,
  };
});

/** The import vocabulary reuses the protocol's stored item shapes; driver identity stays Claude. */
function normalizeMessages(
  messages: readonly SessionMessage[],
  records: readonly SessionStoreEntry[],
): ThreadItemEntry[] {
  const raw = new Map(
    records.flatMap((entry) => (entry.uuid ? [[entry.uuid, entry] as const] : [])),
  );
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
      const images: string[] = [];
      const copied = withoutMedia(block, images);
      if (type !== "image")
        result.push(
          wrap({
            type: "functionCallOutput",
            id,
            name:
              typeof field(block, "name") === "string"
                ? (field(block, "name") as string)
                : String(type ?? "native_record"),
            namespace: null,
            output: JSON.stringify(copied),
          }),
        );
      for (const [imageIndex, path] of images.entries())
        result.push(wrap({ type: "imageView", id: `${id}:image:${imageIndex}`, path }));
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
