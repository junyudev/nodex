import { Buffer } from "node:buffer";
import * as nodePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { ThreadItemEntry } from "@nodex/codex-app-server-protocol/v2";
import {
  CommandId,
  EventId,
  MessageId,
  ModelSelection,
  getProviderAttachmentLimitError,
  ProviderInteractionMode,
  OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2UnavailableImage,
  type UploadChatImageAttachment,
  ProjectId,
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
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ProviderSessionManagerV2 } from "../orchestration-v2/ProviderSessionManager.ts";
import { ThreadCommandExecutor } from "../orchestration-v2/ThreadCommandExecutor.ts";
import { persistChatAttachments } from "../assets/PersistChatAttachments.ts";
import { importChatAttachments } from "../assets/ImportChatAttachments.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { nativeSessionMediaResources } from "./NativeAttachmentResource.ts";
import * as Base64 from "effect/encoding/Base64";
import * as Mime from "effect/http/Mime";
import * as Option from "effect/Option";
import { importHistoryEvents, importIdentity } from "./NativeImportHistory.ts";
import { openCodexImportSource } from "./CodexImportSource.ts";
import { openClaudeImportSource } from "./ClaudeImportSource.ts";
import {
  AGENT_RUNTIME_NATIVE_IMPORT_MAX_TIMEOUT_MS,
  NATIVE_THREAD_IMPORT_OPERATION_PREFIX,
} from "./NativeImportLimits.ts";

export const NativeImportInput = Schema.Struct({
  commandId: CommandId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.NonEmptyString,
  backendKind: Schema.Literals(["codex", "claude"]),
  sourceHome: Schema.NonEmptyString,
  sourceNativeThreadId: Schema.NonEmptyString,
  modelSelection: ModelSelection,
  cwd: Schema.NonEmptyString,
  interactionMode: Schema.optional(ProviderInteractionMode),
  sideChatCapture: Schema.optional(Schema.Literal(true)),
});
export const NativeImportsFindInput = Schema.Struct({
  backendKind: Schema.Literals(["codex", "claude"]),
  sourceHome: Schema.NonEmptyString,
  nativeThreadIds: Schema.Array(Schema.NonEmptyString).check(Schema.isMaxLength(100)),
});

export const makeFind = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return Effect.fn("NativeImport.find")(function* (input: typeof NativeImportsFindInput.Type) {
    if (input.nativeThreadIds.length === 0) return { imports: [] };
    const rows = yield* sql<{
      readonly source_native_thread_id: string;
      readonly thread_id: string;
    }>`
      SELECT imports.source_native_thread_id, imports.thread_id FROM orchestration_v2_native_imports imports
      JOIN orchestration_v2_projection_threads threads ON threads.thread_id = imports.thread_id
      WHERE imports.backend_kind = ${input.backendKind} AND imports.source_home = ${input.sourceHome}
        AND ${sql.in("imports.source_native_thread_id", input.nativeThreadIds)}
        AND imports.phase = 'complete' AND threads.deleted_at IS NULL
      ORDER BY imports.created_at ASC`;
    return {
      imports: rows.map((row) => ({
        sourceNativeThreadId: row.source_native_thread_id,
        threadId: row.thread_id,
      })),
    };
  });
});
type Input = typeof NativeImportInput.Type;
type Journal = {
  readonly command_id: string;
  readonly request_json: string;
  readonly phase: "prepared" | "history" | "complete";
  readonly boundary_item_id: string | null;
  readonly boundary_turn_id: string | null;
  readonly history_mode: "legacy" | "paginated" | "claude" | null;
  readonly source_cwd: string | null;
  readonly source_revision: string | null;
  readonly history_cursor: string | null;
  readonly item_count: number;
};
const fail = (message: string) => Effect.fail(new Error(message));
const requestCodec = Schema.toCodecJson(NativeImportInput);
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
    SELECT command_id, request_json, phase, boundary_item_id, boundary_turn_id, history_mode, source_cwd, source_revision,
      history_cursor, item_count FROM orchestration_v2_native_imports WHERE thread_id = ${threadId}`;

  const run = Effect.fn("NativeImport.run")(function* (requested: Input) {
    const existing = (yield* read(requested.threadId))[0];
    const input = existing ? decodeRequest(JSON.parse(existing.request_json)) : requested;
    if (
      existing &&
      (existing.command_id !== requested.commandId ||
        input.sourceNativeThreadId !== requested.sourceNativeThreadId ||
        input.backendKind !== requested.backendKind ||
        input.sourceHome !== requested.sourceHome ||
        input.projectId !== requested.projectId ||
        input.cwd !== requested.cwd ||
        (input.interactionMode ?? "default") !== (requested.interactionMode ?? "default"))
    )
      return yield* fail("This import identity already belongs to another request.");
    const previousThread = existing ? yield* store.getThread(input.threadId) : null;
    if (previousThread?.deletedAt)
      return yield* fail("The unfinished chat for this import was deleted.");
    if (existing?.phase === "complete") return { threadId: input.threadId };
    if (!nodePath.isAbsolute(input.cwd))
      return yield* fail("Choose an absolute working directory.");
    const directory = yield* fs.stat(input.cwd);
    if (directory.type !== "Directory")
      return yield* fail("The working directory is no longer available. Choose another folder.");
    const requestJson = JSON.stringify(encodeRequest(input));
    const adapter = yield* registry.get(input.modelSelection.instanceId);
    if (adapter.driver !== (input.backendKind === "claude" ? "claudeAgent" : "codex"))
      return yield* fail("The destination Agent must match the source conversation.");
    if (
      !nodePath.isAbsolute(input.sourceHome) ||
      nodePath.normalize(input.sourceHome) !== input.sourceHome
    )
      return yield* fail("Import requires an absolute captured source home.");
    const now = yield* DateTime.now;
    const operationId = `${NATIVE_THREAD_IMPORT_OPERATION_PREFIX}${input.commandId}`;
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
        interactionMode: input.interactionMode ?? "default",
        branch: null,
        worktreePath: input.cwd,
        activeProviderThreadId: null,
        historyOrigin: "native_import",
        ...(input.sideChatCapture
          ? {
              sideChat: {
                sourceThreadId: ThreadId.make(input.sourceNativeThreadId),
                sourceRunId: null,
                nativeFork: false,
              },
            }
          : {}),
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
          yield* sql`INSERT INTO orchestration_v2_native_imports
          (thread_id, command_id, request_json, backend_kind, source_home, source_native_thread_id, phase, created_at, updated_at)
          VALUES (${input.threadId}, ${input.commandId}, ${requestJson}, ${input.backendKind}, ${input.sourceHome}, ${input.sourceNativeThreadId}, 'prepared',
            ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)})`;
          yield* sink.write({
            events: [
              {
                id: EventId.make(`native-import:admit:${importIdentity(input.commandId)}`),
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
    if (current.deletedAt !== null)
      return yield* fail("The unfinished chat for this import was deleted.");
    if (journal.phase === "complete") return { threadId: input.threadId };
    if (current.executionHandoff?.operationId !== operationId)
      return yield* fail("The import no longer owns its destination conversation.");
    const source = yield* input.backendKind === "codex"
      ? openCodexImportSource(input)
      : openClaudeImportSource(input);
    if (journal.phase === "prepared") {
      const captured = yield* source.capture();
      yield* sql`UPDATE orchestration_v2_native_imports SET phase = 'history',
        boundary_item_id = ${captured.boundaryItemId}, boundary_turn_id = ${captured.boundaryTurnId},
        history_mode = ${captured.historyMode}, source_cwd = ${captured.sourceCwd}, source_revision = ${captured.sourceRevision} WHERE thread_id = ${input.threadId}`;
      journal = (yield* read(input.threadId))[0]!;
    }
    if (journal.source_cwd === null)
      return yield* fail("The original conversation’s history folder is no longer available.");
    let cursor = journal.history_cursor;
    let ordinal = journal.item_count;
    const seen = new Set<string>();
    do {
      const nativePage = yield* source.page(
        {
          boundaryItemId: journal.boundary_item_id,
          boundaryTurnId: journal.boundary_turn_id,
          historyMode: journal.history_mode!,
          sourceCwd: journal.source_cwd,
          sourceRevision: journal.source_revision,
        },
        cursor,
      );
      const entries = nativePage.data;
      const boundaryIndex = entries.findIndex(
        (entry) =>
          entry.item.id === journal.boundary_item_id && entry.turnId === journal.boundary_turn_id,
      );
      if (journal.boundary_item_id !== null && nativePage.nextCursor === null && boundaryIndex < 0)
        return yield* fail("The source conversation changed while its history was being copied.");
      const page = {
        data: boundaryIndex < 0 ? entries : entries.slice(0, boundaryIndex + 1),
        nextCursor: boundaryIndex >= 0 ? null : nativePage.nextCursor,
      };
      if (page.nextCursor !== null && (page.nextCursor === cursor || seen.has(page.nextCursor)))
        return yield* fail("Import history repeated a continuation cursor.");
      if (page.nextCursor !== null) seen.add(page.nextCursor);
      if (Buffer.byteLength(JSON.stringify(page.data), "utf8") > 8 * 1024 * 1024)
        return yield* fail("Part of this conversation is too large to import.");
      const events: OrchestrationV2DomainEvent[] = [];
      for (const entry of page.data) {
        const { attachments, unavailableImages, importedImageLinks } = yield* persistImages(
          input,
          entry,
          journal.source_cwd,
        );
        events.push(
          ...importHistoryEvents({
            threadId: input.threadId,
            driver: adapter.driver,
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
      if (completed) yield* source.close;
      const completedAt = yield* DateTime.now;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          if (events.length > 0) yield* sink.write({ events });
          yield* sql`UPDATE orchestration_v2_native_imports SET
          history_cursor = ${page.nextCursor}, item_count = ${ordinal},
          updated_at = ${DateTime.formatIso(completedAt)} WHERE thread_id = ${input.threadId}`;
          if (!completed) return;
          const thread = yield* store.getThread(input.threadId);
          const completion = yield* sink.commitCommand({
            commandId: input.commandId,
            threadId: input.threadId,
            commandType: "thread.import-native",
            acceptedAt: completedAt,
            effects: [],
            events: [
              {
                id: EventId.make(`native-import:complete:${importIdentity(input.commandId)}`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                occurredAt: completedAt,
                payload: { ...thread, executionHandoff: null, updatedAt: completedAt },
              },
            ],
          });
          if (
            completion.receipt.threadId !== input.threadId ||
            completion.receipt.commandType !== "thread.import-native" ||
            completion.receipt.status !== "accepted" ||
            !completion.committed
          )
            return yield* fail("The import command identity already belongs to another operation.");
          yield* sql`UPDATE orchestration_v2_native_imports SET phase = 'complete'
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
        Effect.timeout(AGENT_RUNTIME_NATIVE_IMPORT_MAX_TIMEOUT_MS),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ServerConfig, config),
        Effect.provideService(EventSinkV2, sink),
        Effect.provideService(ProviderSessionManagerV2, sessions),
      );
});

/** The captured source owns these locators; unresolved provider identities never become files. */
const persistAdditionalMedia = Effect.fn("NativeImport.persistMedia")(function* (
  input: Input,
  entry: ThreadItemEntry,
  sourceCwd: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const media = nativeSessionMediaResources(entry.item).filter((resource) =>
    entry.item.type === "userMessage"
      ? resource.media === "audio"
      : entry.item.type !== "imageView",
  );
  if (!media.length) return [];
  const resources = yield* Effect.forEach(
    media,
    (item) =>
      Effect.gen(function* () {
        const resource = item.resource;
        if (!resource)
          return yield* fail(
            `resource_unavailable: Native media ${entry.item.id}/${item.id} has no producer byte export.`,
          );
        const maximum = item.media === "image" ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
        if (resource.source.startsWith("data:")) {
          const data = parseBase64DataUrl(resource.source);
          if (!data || !data.mimeType.startsWith(`${item.media}/`))
            return yield* fail("A Native media payload is invalid.");
          const bytes = yield* Effect.fromResult(Base64.decode(data.base64));
          if (bytes.byteLength === 0 || bytes.byteLength > maximum)
            return yield* fail("A Native media payload exceeds its byte budget.");
          return {
            ...resource,
            source: resource.source,
            mimeType: data.mimeType,
            sizeBytes: bytes.byteLength,
          };
        }
        if (
          /^[a-z][a-z0-9+.-]*:/iu.test(resource.source) &&
          !resource.source.startsWith("file:") &&
          !/^[a-z]:[\\/]/iu.test(resource.source)
        )
          return yield* fail(
            `resource_unavailable: Native media ${entry.item.id}/${item.id} has no producer byte export.`,
          );
        const source = yield* Effect.try(() =>
          resolveMarkdownImagePath(
            resource.source,
            sourceCwd,
            path.sep === "\\" ? "win32" : "posix",
          ),
        );
        const info = yield* fs.stat(source);
        if (info.type !== "File" || info.size < 1 || info.size > maximum)
          return yield* fail("A Native media file is unavailable or exceeds its byte budget.");
        const mimeType =
          resource.mimeType ??
          Option.getOrElse(Mime.getType(source), () =>
            item.media === "image" ? "image/png" : "application/octet-stream",
          );
        return { name: resource.name, source, mimeType, sizeBytes: Number(info.size) };
      }),
    { concurrency: 1 },
  );
  return yield* importChatAttachments({
    threadId: input.threadId,
    messageId: MessageId.make(
      `native-import:${importIdentity(input.threadId, entry.turnId, entry.item.id)}:media`,
    ),
    attachments: resources,
  });
});

const persistImages = Effect.fn("NativeImport.persistImages")(function* (
  input: Input,
  entry: ThreadItemEntry,
  sourceCwd: string,
) {
  const path = yield* Path.Path;
  const pathStyle = path.sep === "\\" ? "win32" : "posix";
  const assistantImages = entry.item.type === "agentMessage";
  const content =
    entry.item.type === "userMessage"
      ? entry.item.content
      : entry.item.type === "imageView"
        ? entry.item.path.startsWith("data:image/")
          ? [{ type: "image" as const, url: entry.item.path }]
          : [{ type: "localImage" as const, path: entry.item.path }]
        : entry.item.type === "agentMessage"
          ? localMarkdownImagePaths(entry.item.text, pathStyle).map((path) => ({
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
    if (part.type === "image")
      return yield* fail(
        `resource_unavailable: Native media ${entry.item.id} has no producer byte export.`,
      );
    if (part.type !== "localImage") continue;
    // Historical locators belong to the source directory, including when it has disappeared.
    // The new execution directory must never supply an unrelated same-name image.
    const sourcePath = assistantImages
      ? yield* Effect.try({
          try: () => resolveMarkdownImagePath(part.path, sourceCwd, pathStyle),
          catch: (cause) =>
            cause instanceof Error
              ? cause
              : new Error(
                  "A reply in this conversation links an image with an invalid local path.",
                ),
        })
      : path.resolve(sourceCwd, part.path);
    const name = path.basename(sourcePath) || "Image";
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
    const extension = path.extname(sourcePath).toLowerCase();
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
            `native-import:${importIdentity(input.threadId, entry.turnId, entry.item.id)}`,
          ),
          attachments: images,
        });
  const importedImageLinks = links.map(({ sourcePath, imageIndex }) => ({
    sourcePath,
    attachmentId: imageIndex === null ? null : attachments[imageIndex]!.id,
  }));
  const additional = yield* persistAdditionalMedia(input, entry, sourceCwd);
  const copied = [...attachments, ...additional];
  const limit = getProviderAttachmentLimitError(copied);
  if (limit) return yield* fail(limit);
  return { attachments: copied, unavailableImages, importedImageLinks };
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
  platform: "win32" | "posix",
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
  platform: "win32" | "posix",
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
