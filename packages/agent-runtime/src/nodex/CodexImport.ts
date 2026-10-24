import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  ThreadItemEntry,
  ThreadItemsListResponse,
  ThreadTurnsListResponse,
  ThreadTimelineListResponse,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexNativeInteraction } from "@t3tools/provider-core/server/nativeInteraction";
import {
  CommandId,
  EventId,
  MessageId,
  ModelSelection,
  OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2UnavailableImage,
  type UploadChatImageAttachment,
  ProjectId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadCommandExecutor } from "../orchestration-v2/ThreadCommandExecutor.ts";
import { persistChatAttachments } from "../assets/PersistChatAttachments.ts";
import { importHistoryEvents, importIdentity } from "./CodexImportHistory.ts";
import { isAgentRuntimeCodexThreadSource } from "./CodexThreadSource.ts";
import {
  AGENT_RUNTIME_CODEX_IMPORT_MAX_TIMEOUT_MS,
  CODEX_THREAD_IMPORT_OPERATION_PREFIX,
} from "./CodexImportLimits.ts";

export const CodexImportInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.NonEmptyString,
  sourceNativeThreadId: Schema.NonEmptyString,
  modelSelection: ModelSelection,
  cwd: Schema.NonEmptyString,
});
type Input = typeof CodexImportInput.Type;
type Journal = {
  readonly command_id: string;
  readonly request_json: string;
  readonly phase: "prepared" | "history" | "complete";
  readonly boundary_item_id: string | null;
  readonly boundary_turn_id: string | null;
  readonly history_mode: "legacy" | "paginated" | null;
  readonly source_cwd: string | null;
  readonly history_cursor: string | null;
  readonly item_count: number;
};
const fail = (message: string) => Effect.fail(new Error(message));
const requestCodec = Schema.toCodecJson(CodexImportInput);
const encodeRequest = Schema.encodeSync(requestCodec);
const decodeRequest = Schema.decodeUnknownSync(requestCodec);
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ProjectionStoreV2;
  const sink = yield* EventSinkV2;
  const sessions = yield* ProviderSessionManagerV2;
  const registry = yield* ProviderAdapterRegistryV2;
  const commands = yield* ThreadCommandExecutor;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const read = (threadId: ThreadId) => sql<Journal>`
    SELECT command_id, request_json, phase, boundary_item_id, boundary_turn_id, history_mode, source_cwd,
      history_cursor, item_count FROM orchestration_v2_codex_imports WHERE thread_id = ${threadId}`;

  const run = Effect.fn("CodexImport.run")(function* (requested: Input) {
    const existing = (yield* read(requested.threadId))[0];
    const input = existing ? decodeRequest(JSON.parse(existing.request_json)) : requested;
    if (
      existing &&
      (existing.command_id !== requested.commandId ||
        input.sourceNativeThreadId !== requested.sourceNativeThreadId ||
        input.projectId !== requested.projectId ||
        input.cwd !== requested.cwd)
    )
      return yield* fail("This import identity already belongs to another request.");
    const previousThread = existing ? yield* store.getThread(input.threadId) : null;
    if (previousThread?.deletedAt) return yield* fail("The import destination was deleted.");
    if (existing?.phase === "complete") return { threadId: input.threadId };
    if (!nodePath.isAbsolute(input.cwd))
      return yield* fail("Choose an absolute working directory.");
    const directory = yield* fs.stat(input.cwd);
    if (directory.type !== "Directory")
      return yield* fail("The working directory is no longer available. Choose another folder.");
    const requestJson = JSON.stringify(encodeRequest(input));
    const adapter = yield* registry.get(input.modelSelection.instanceId);
    if (adapter.driver !== "codex") return yield* fail("Codex import requires a Codex Agent.");
    const now = yield* DateTime.now;
    const operationId = `${CODEX_THREAD_IMPORT_OPERATION_PREFIX}${input.commandId}`;
    if (!existing) {
      const destination = yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE thread_id = ${input.threadId} LIMIT 1`;
      if (destination.length > 0)
        return yield* fail("The import destination already contains a conversation.");
      const thread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: input.threadId,
        projectId: input.projectId,
        title: input.title,
        providerInstanceId: input.modelSelection.instanceId,
        modelSelection: input.modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: input.cwd,
        activeProviderThreadId: null,
        historyOrigin: "native_import",
        executionHandoff: { operationId, recoveryRequired: true },
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO orchestration_v2_codex_imports
          (thread_id, command_id, request_json, phase, created_at, updated_at)
          VALUES (${input.threadId}, ${input.commandId}, ${requestJson}, 'prepared',
            ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)})`;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`codex-import:admit:${importIdentity(input.commandId)}`),
                type: "thread.created",
                threadId: input.threadId,
                occurredAt: now,
                payload: thread,
              },
            ],
          });
        }),
      );
    }
    let journal = (yield* read(input.threadId))[0]!;
    const current = yield* store.getThread(input.threadId);
    if (current.deletedAt !== null) return yield* fail("The import destination was deleted.");
    if (journal.phase === "complete") return { threadId: input.threadId };
    if (current.executionHandoff?.operationId !== operationId)
      return yield* fail("The import no longer owns its destination conversation.");
    const runtimePolicy = {
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      cwd: input.cwd,
    };
    const sourceSessionId = ProviderSessionId.make(
      `codex-import:${importIdentity(input.threadId)}`,
    );
    let sourceClosed = false;
    const closeSource = Effect.fn("CodexImport.closeSource")(function* () {
      if (sourceClosed) return;
      yield* sessions.close(sourceSessionId);
      const closedAt = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(randomUUID()),
            type: "provider-session.detached",
            threadId: input.threadId,
            occurredAt: closedAt,
            payload: {
              providerSessionId: sourceSessionId,
              detachedAt: closedAt,
              reason: "Codex import history reader released",
            },
          },
        ],
      });
      sourceClosed = true;
    });
    const session = yield* Effect.acquireRelease(
      sessions.open({
        threadId: input.threadId,
        providerSessionId: sourceSessionId,
        modelSelection: input.modelSelection,
        runtimePolicy,
      }),
      () => closeSource().pipe(Effect.orDie),
    );
    const native = session.codexNative;
    if (!native) return yield* fail("The Codex Agent does not expose native import capabilities.");
    yield* native.initialize;
    if (journal.phase === "prepared") {
      const source = (yield* native.request("thread/read", {
        threadId: input.sourceNativeThreadId,
        includeTurns: false,
      })).thread;
      if (source.id !== input.sourceNativeThreadId)
        return yield* fail("Codex returned a different source conversation.");
      if (!nodePath.isAbsolute(source.cwd))
        return yield* fail("This Codex conversation has no working directory to import.");
      if (source.parentThreadId || isAgentRuntimeCodexThreadSource(source.threadSource))
        return yield* fail("Subagent and Nodex-run Codex conversations cannot be imported.");
      if (source.ephemeral || source.status.type === "active")
        return yield* fail(
          "This Codex conversation is still running. Import it after it finishes.",
        );
      if (source.historyMode === "paginated")
        yield* assertOrdinaryHistory(native, input.sourceNativeThreadId);
      const latest = yield* native.request("thread/turns/list", {
        threadId: input.sourceNativeThreadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      });
      const turn = latest.data[0];
      if (turn?.status === "inProgress")
        return yield* fail(
          "This Codex conversation is still running. Import it after it finishes.",
        );
      const boundary = turn?.items.at(-1);
      if (turn && !boundary)
        return yield* fail("Codex could not read the latest turn of this conversation.");
      yield* sql`UPDATE orchestration_v2_codex_imports SET phase = 'history',
        boundary_item_id = ${boundary?.id ?? null}, boundary_turn_id = ${turn?.id ?? null},
        history_mode = ${source.historyMode}, source_cwd = ${source.cwd} WHERE thread_id = ${input.threadId}`;
      journal = (yield* read(input.threadId))[0]!;
    }
    const nativeId = input.sourceNativeThreadId;
    if (journal.source_cwd === null)
      return yield* fail("The import's captured source directory is unavailable.");
    let cursor = journal.history_cursor;
    let ordinal = journal.item_count;
    const seen = new Set<string>();
    do {
      const nativePage: ThreadItemsListResponse | ThreadTurnsListResponse =
        journal.boundary_item_id === null
          ? { data: [], nextCursor: null, backwardsCursor: null }
          : journal.history_mode === "legacy"
            ? yield* native.request("thread/turns/list", {
                threadId: nativeId,
                cursor,
                limit: 20,
                sortDirection: "asc",
                itemsView: "full",
              })
            : yield* native.request("thread/items/list", {
                threadId: nativeId,
                cursor,
                limit: 50,
                sortDirection: "asc",
              });
      const entries: ThreadItemEntry[] =
        journal.history_mode === "legacy"
          ? (nativePage as ThreadTurnsListResponse).data.flatMap((turn) =>
              turn.items.map((item) => ({
                turnId: turn.id,
                item,
                startedAtMs: turn.startedAt === null ? null : turn.startedAt * 1000,
                completedAtMs: turn.completedAt === null ? null : turn.completedAt * 1000,
              })),
            )
          : (nativePage as ThreadItemsListResponse).data;
      const boundaryIndex = entries.findIndex(
        (entry) =>
          entry.item.id === journal.boundary_item_id && entry.turnId === journal.boundary_turn_id,
      );
      if (journal.boundary_item_id !== null && nativePage.nextCursor === null && boundaryIndex < 0)
        return yield* fail("This Codex conversation changed while its history was being copied.");
      const page = {
        data: boundaryIndex < 0 ? entries : entries.slice(0, boundaryIndex + 1),
        nextCursor: boundaryIndex >= 0 ? null : nativePage.nextCursor,
      };
      if (page.nextCursor !== null && (page.nextCursor === cursor || seen.has(page.nextCursor)))
        return yield* fail("Codex import history repeated a continuation cursor.");
      if (page.nextCursor !== null) seen.add(page.nextCursor);
      if (Buffer.byteLength(JSON.stringify(page.data), "utf8") > 8 * 1024 * 1024)
        return yield* fail("Part of this conversation is too large to import.");
      const events: OrchestrationV2DomainEvent[] = [];
      for (const entry of page.data) {
        if (hasUncopiedMedia(entry))
          return yield* fail(
            "This conversation contains media that cannot yet be copied into Nodex.",
          );
        const { attachments, unavailableImages, importedImageLinks } = yield* persistImages(
          input,
          entry,
          journal.source_cwd,
        );
        events.push(
          ...importHistoryEvents({
            threadId: input.threadId,
            entry,
            ordinal: ++ordinal,
            fallbackAt: now,
            attachments,
            unavailableImages,
            importedImageLinks,
          }),
        );
      }
      const completed = page.nextCursor === null;
      if (completed) yield* closeSource();
      const completedAt = yield* DateTime.now;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (events.length > 0) yield* sink.write({ events });
          yield* sql`UPDATE orchestration_v2_codex_imports SET
          history_cursor = ${page.nextCursor}, item_count = ${ordinal},
          updated_at = ${DateTime.formatIso(completedAt)} WHERE thread_id = ${input.threadId}`;
          if (!completed) return;
          const thread = yield* store.getThread(input.threadId);
          const completion = yield* sink.commitCommand({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: "thread.import-codex",
            acceptedAt: completedAt,
            effects: [],
            events: [
              {
                id: EventId.make(`codex-import:complete:${importIdentity(input.commandId)}`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                occurredAt: completedAt,
                payload: { ...thread, executionHandoff: null, updatedAt: completedAt },
              },
            ],
          });
          if (
            completion.receipt.threadId !== input.threadId ||
            completion.receipt.commandType !== "thread.import-codex" ||
            completion.receipt.status !== "accepted" ||
            !completion.committed
          )
            return yield* fail("The import command identity already belongs to another operation.");
          yield* sql`UPDATE orchestration_v2_codex_imports SET phase = 'complete'
          WHERE thread_id = ${input.threadId}`;
        }),
      );
      cursor = page.nextCursor;
      yield* Effect.yieldNow;
    } while (cursor !== null);
    return { threadId: input.threadId };
  });
  return (input: Input) =>
    commands
      .withLock(input.threadId, Effect.scoped(run(input)))
      .pipe(
        Effect.timeout(AGENT_RUNTIME_CODEX_IMPORT_MAX_TIMEOUT_MS),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, config),
      );
});

/** Reject provider-owned media locators until their bytes have a Runtime attachment owner. */
function hasUncopiedMedia(entry: ThreadItemEntry): boolean {
  const item = entry.item;
  if (item.type === "imageGeneration") return true;
  if (
    item.type !== "mcpToolCall" &&
    item.type !== "dynamicToolCall" &&
    item.type !== "functionCallOutput"
  )
    return false;
  const stack: unknown[] = [item];
  while (stack.length > 0) {
    const value = stack.pop();
    if (Array.isArray(value)) {
      stack.push(...value);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === "string" && child.startsWith("file://")) return true;
      if (
        typeof child === "string" &&
        (key === "imageUrl" || key === "audioUrl") &&
        !child.startsWith("data:")
      )
        return true;
      stack.push(child);
    }
  }
  return false;
}

const assertOrdinaryHistory = Effect.fn("CodexImport.assertOrdinaryHistory")(function* (
  native: CodexNativeInteraction,
  threadId: string,
) {
  let cursor: string | null = null;
  const seen = new Set<string>();
  do {
    const page: ThreadTimelineListResponse = yield* native.request("thread/timeline/list", {
      threadId,
      cursor,
      limit: 100,
    });
    if (
      page.activeRealtimeSessionAtPageStart ||
      page.data.some((entry) => entry.type === "realtime")
    )
      return yield* fail("Voice conversations cannot yet be copied into Nodex.");
    if (Buffer.byteLength(JSON.stringify(page), "utf8") > 8 * 1024 * 1024)
      return yield* fail("Part of this conversation is too large to import.");
    if (page.nextCursor !== null && (page.nextCursor === cursor || seen.has(page.nextCursor)))
      return yield* fail("Codex import timeline repeated a continuation cursor.");
    cursor = page.nextCursor;
    if (cursor !== null) seen.add(cursor);
  } while (cursor !== null);
});

const persistImages = Effect.fn("CodexImport.persistImages")(function* (
  input: Input,
  entry: ThreadItemEntry,
  sourceCwd: string,
) {
  const assistantImages = entry.item.type === "agentMessage";
  const content =
    entry.item.type === "userMessage"
      ? entry.item.content
      : entry.item.type === "imageView"
        ? [{ type: "localImage" as const, path: entry.item.path }]
        : entry.item.type === "agentMessage"
          ? localMarkdownImagePaths(entry.item.text).map((path) => ({
              type: "localImage" as const,
              path,
            }))
          : [];
  const fs = yield* FileSystem.FileSystem;
  const images: UploadChatImageAttachment[] = [];
  const unavailableImages: OrchestrationV2UnavailableImage[] = [];
  const links: Array<{ sourcePath: string; imageIndex: number | null }> = [];
  for (const part of content) {
    if (part.type === "image" && "url" in part && part.url.startsWith("data:image/")) {
      const mimeType = part.url.slice(5, part.url.indexOf(";"));
      images.push({
        type: "image",
        name: `image-${images.length + 1}`,
        mimeType,
        sizeBytes: Buffer.from(part.url.slice(part.url.indexOf(",") + 1), "base64").byteLength,
        dataUrl: part.url,
      });
      continue;
    }
    if (part.type === "image" || part.type === "audio" || part.type === "localAudio")
      return yield* fail("This conversation contains media that cannot yet be copied into Nodex.");
    if (part.type !== "localImage") continue;
    // Historical locators belong to the source directory, including when it has disappeared.
    // The new execution directory must never supply an unrelated same-name image.
    const sourcePath = assistantImages
      ? yield* Effect.try({
          try: () => resolveMarkdownImagePath(part.path, sourceCwd),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error(
                  "A reply in this conversation links an image with an invalid local path.",
                ),
        })
      : nodePath.resolve(sourceCwd, part.path);
    const name = nodePath.basename(sourcePath) || "Image";
    const info = yield* fs
      .stat(sourcePath)
      .pipe(
        Effect.catch((cause) =>
          cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
        ),
      );
    if (info !== null && info.size > 10 * 1024 * 1024)
      return yield* fail(
        "An image in this conversation is larger than 10 MB and cannot be imported.",
      );
    const bytes =
      info === null
        ? null
        : yield* fs
            .readFile(sourcePath)
            .pipe(
              Effect.catch((cause) =>
                cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
              ),
            );
    if (bytes === null) {
      unavailableImages.push({
        name,
        sourcePath: part.path,
        reason: "source_missing",
      });
      if (assistantImages) links.push({ sourcePath: part.path, imageIndex: null });
      continue;
    }
    if (bytes.byteLength > 10 * 1024 * 1024)
      return yield* fail(
        "An image in this conversation is larger than 10 MB and cannot be imported.",
      );
    const extension = nodePath.extname(sourcePath).toLowerCase();
    if (![".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(extension))
      return yield* fail("An image in this conversation uses a format Nodex cannot import.");
    const mimeType =
      extension === ".jpg" || extension === ".jpeg"
        ? "image/jpeg"
        : extension === ".webp"
          ? "image/webp"
          : extension === ".gif"
            ? "image/gif"
            : "image/png";
    if (assistantImages) links.push({ sourcePath: part.path, imageIndex: images.length });
    images.push({
      type: "image",
      name,
      mimeType,
      sizeBytes: bytes.byteLength,
      dataUrl: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
    });
  }
  const attachments =
    images.length === 0
      ? []
      : yield* persistChatAttachments({
          threadId: input.threadId,
          messageId: MessageId.make(
            `codex-import:${importIdentity(input.threadId, entry.turnId, entry.item.id)}`,
          ),
          attachments: images,
        });
  const importedImageLinks = links.map(({ sourcePath, imageIndex }) => ({
    sourcePath,
    attachmentId: imageIndex === null ? null : attachments[imageIndex]!.id,
  }));
  return { attachments, unavailableImages, importedImageLinks };
});

type MarkdownNode = {
  readonly type: string;
  readonly url?: string;
  readonly identifier?: string;
  readonly children?: readonly MarkdownNode[];
};

/** Parse actual images, including references; code examples never acquire attachment ownership. */
export function localMarkdownImagePaths(
  text: string,
  platform = process.platform,
): readonly string[] {
  const pending: MarkdownNode[] = [fromMarkdown(text)];
  const images: MarkdownNode[] = [];
  const definitions = new Map<string, string>();
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (
      node.type === "definition" &&
      node.identifier &&
      node.url &&
      !definitions.has(node.identifier)
    )
      definitions.set(node.identifier, node.url);
    if (node.type === "image" || node.type === "imageReference") images.push(node);
    if (node.children) pending.push(...node.children.toReversed());
  }
  return [
    ...new Set(images.flatMap((node) => node.url ?? definitions.get(node.identifier ?? "") ?? [])),
  ]
    .filter((url) => url.length > 0 && !url.startsWith("#"))
    .filter((url) => platform === "win32" || !url.startsWith("//"))
    .filter(
      (url) =>
        windowsDrivePrefix.test(url) || !/^[a-z][a-z0-9+.-]*:/iu.test(url) || /^file:/iu.test(url),
    );
}

const windowsDrivePrefix = /^[a-z]:/iu;
const windowsAbsolutePath = /^[a-z]:[\\/]/iu;
const windowsUncPath = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/u;

/** Resolve authored image URLs on their source host; foreign native paths are never guessed. */
export function resolveMarkdownImagePath(
  sourcePath: string,
  sourceCwd: string,
  platform = process.platform,
): string {
  const windows = platform === "win32";
  if (windowsDrivePrefix.test(sourcePath) || windowsUncPath.test(sourcePath)) {
    if (!windows)
      throw new Error(
        "A reply in this conversation links a Windows image path this computer cannot read.",
      );
    if (!windowsAbsolutePath.test(sourcePath) && !windowsUncPath.test(sourcePath))
      throw new Error("A reply in this conversation links a relative Windows image path.");
    return nodePath.win32.normalize(decodeURIComponent(sourcePath));
  }
  const path = windows ? nodePath.win32 : nodePath.posix;
  const url = new URL(sourcePath, pathToFileURL(`${sourceCwd}${path.sep}`, { windows }));
  if (!windows && /^\/[a-z]:[\\/]/iu.test(url.pathname))
    throw new Error(
      "A reply in this conversation links a Windows image path this computer cannot read.",
    );
  return fileURLToPath(url, { windows });
}
