import { join } from "node:path";
import {
  MOBILE_FILE_CHUNK_BYTES,
  MOBILE_UPLOAD_MAX_BYTES,
  type FileRef,
} from "@nodex/mobile-protocol";
import { parseBase64DataUrl } from "@nodex/agent-runtime/image-mime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { z } from "zod";
import { libraryContentRoute } from "../../shared/content-routing-context";
import type { LibraryFile } from "../../shared/library-files";
import { fileSource, parseFileSource } from "../../shared/file-resources";
import { createOperationId } from "../core-runtime/operation-identity";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { AgentRuntimeApplication } from "../agent-runtime/AgentRuntimeApplication";
import { FileExportRuntime } from "../library-application/FileExportRuntime";
import { LibraryModule } from "../library-application/LibraryModule";
import { MobileProfileFiles } from "../platform/node/MobileProfileFiles";
import { MainConfig } from "../app/MainConfig";
import { downloadConflict, readMobileAttachment } from "./attachment-read";
import { invalid, missing, unavailable, type MobileHandlers } from "./rpc";

const attachmentPrefix = "nodex://chat-attachments/";
const attachmentLocator = z.tuple([
  z.string().min(1).max(512),
  z.string().min(1).max(512),
  z.string().min(1).max(512),
  z.string().min(1).max(512),
]);
type AttachmentLocator = z.infer<typeof attachmentLocator>;

export const attachmentRef = (locator: AttachmentLocator) =>
  attachmentPrefix + Buffer.from(JSON.stringify(locator)).toString("base64url");

export const parseAttachmentRef = (ref: string): AttachmentLocator | null => {
  if (!ref.startsWith(attachmentPrefix)) return null;
  const token = ref.slice(attachmentPrefix.length);
  if (!/^[A-Za-z0-9_-]{1,12000}$/u.test(token)) return null;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) return null;
    const result = attachmentLocator.safeParse(JSON.parse(bytes.toString()));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
};

export const decodeUploadChunk = (base64: string): Buffer | null => {
  if (base64.length === 0 || base64.length > Math.ceil(MOBILE_FILE_CHUNK_BYTES / 3) * 4)
    return null;
  const bytes = Buffer.from(base64, "base64");
  return bytes.length <= MOBILE_FILE_CHUNK_BYTES && bytes.toString("base64") === base64
    ? bytes
    : null;
};

const MAX_UPLOADS = 4;
const UPLOAD_IDLE_MILLIS = 2 * 60_000;
const MAX_COMMITTED = 32;
const MAX_REFS = 12;
const direct = { kind: "direct" } as const;
const notFound = () => missing("This file is unavailable.");
const writeFailure = () => unavailable("Nodex on your desktop could not save this file.");
export const makeMobileFiles = Effect.gen(function* () {
  const runtime = yield* AgentRuntimeApplication;
  const library = yield* LibraryModule;
  const exports = yield* FileExportRuntime;
  const platform = yield* MobileProfileFiles;
  const config = yield* MainConfig;
  const authority = yield* CoreAuthority;
  const fs = yield* FileSystem.FileSystem;
  const clock = yield* Clock.Clock;
  const blobReads = yield* Semaphore.make(2);

  const metadata = Effect.fn("MobileFiles.metadata")(function* (fileId: string) {
    const result = yield* library
      .read(libraryContentRoute, {
        read: { mode: "file_presentation", file_id: fileId, source: direct },
      })
      .pipe(Effect.mapError(notFound));
    if (!result.ok || result.value.value.kind !== "file_presentation")
      return yield* Effect.fail(notFound());
    return result.value.value.value;
  });

  const libraryIds = (refs: readonly string[]) =>
    Effect.gen(function* () {
      if (refs.length > MAX_REFS) return yield* Effect.fail(invalid("Too many attachments."));
      return yield* Effect.forEach(refs, (ref) => {
        const id = parseFileSource(ref);
        return id ? Effect.succeed(id) : Effect.fail(notFound());
      });
    });
  const captureImages = (refs: readonly string[]) =>
    libraryIds(refs).pipe(
      Effect.flatMap((ids) =>
        Effect.forEach(ids, (id) =>
          metadata(id).pipe(
            Effect.flatMap((file) =>
              file.mime_type.startsWith("image/")
                ? Effect.succeed(id)
                : Effect.fail(invalid("Inbox attachments must be images.")),
            ),
          ),
        ),
      ),
    );

  const chatResources = (refs: readonly string[]) =>
    libraryIds(refs).pipe(
      Effect.flatMap((ids) =>
        Effect.forEach(ids, (fileId) =>
          Effect.gen(function* () {
            const file = yield* metadata(fileId);
            const source = yield* exports
              .materialize(libraryContentRoute, { fileId, source: direct, version: file.version })
              .pipe(Effect.mapError(notFound));
            return {
              source,
              name: file.default_name,
              mimeType: file.mime_type,
              sizeBytes: file.byte_length,
            };
          }),
        ),
      ),
    );

  const open = Effect.gen(function* () {
    const scope = yield* Scope.Scope;
    const staging = yield* Scope.fork(scope);
    const directoryLane = yield* Semaphore.make(1);
    const downloadLane = yield* Semaphore.make(1);
    const uploadLane = yield* Semaphore.make(1);
    let directory: string | null = null;
    const stagingDirectory = directoryLane.withPermit(
      Effect.gen(function* () {
        directory ??= yield* platform
          .uploads(config.nodexHome)
          .pipe(Scope.provide(staging), Effect.mapError(writeFailure));
        return directory;
      }).pipe(Effect.uninterruptible),
    );
    let download: { ref: string; version: string; mimeType: string } | null = null;
    const readStaged = Effect.fn("MobileFiles.readStaged")(function* (
      ref: string,
      version: string,
      offset: number,
      length: number,
      load: Effect.Effect<{ bytes: Uint8Array; mimeType: string }, ReturnType<typeof notFound>>,
    ) {
      const path = join(yield* stagingDirectory, "download");
      let cached = download;
      if (cached?.ref !== ref || cached.version !== version) {
        cached = yield* blobReads.withPermit(
          Effect.gen(function* () {
            const { bytes, mimeType } = yield* load;
            const entry = { ref, version, mimeType };
            yield* Effect.gen(function* () {
              download = null;
              yield* fs.writeFile(path, bytes, { mode: 0o600 }).pipe(Effect.mapError(writeFailure));
              download = entry;
            }).pipe(Effect.uninterruptible);
            return entry;
          }),
        );
      }
      const chunk = yield* platform
        .readAttachment(path, offset, length)
        .pipe(Effect.mapError(notFound));
      return { ...chunk, version, mimeType: cached.mimeType };
    });

    const read: MobileHandlers["files.read"] = ({ ref, offset, length, version }) =>
      downloadLane.withPermit(
        Effect.gen(function* () {
          if (!Number.isSafeInteger(offset))
            return yield* Effect.fail(invalid("The file offset is invalid."));
          const unavailableVersion = version === undefined ? notFound : downloadConflict;
          const fileId = parseFileSource(ref);
          if (fileId) {
            const file = yield* metadata(fileId).pipe(Effect.mapError(unavailableVersion));
            const current = String(file.version);
            if (version !== undefined && version !== current)
              return yield* Effect.fail(downloadConflict());
            const bytes = yield* readStaged(
              ref,
              current,
              offset,
              length,
              library
                .readFileBlob(libraryContentRoute, {
                  fileId,
                  source: direct,
                  version: file.version,
                })
                .pipe(Effect.mapError(unavailableVersion)),
            );
            return { ...bytes, mimeType: file.mime_type, name: file.default_name };
          }
          const locator = parseAttachmentRef(ref);
          if (!locator) return yield* Effect.fail(notFound());
          const [sessionId, sourceThreadId, itemId, attachmentId] = locator;
          const input = { sessionId, sourceThreadId, itemId, attachmentId };
          if (attachmentId.startsWith("tool-result:")) {
            // The full item version covers inline attachment bytes, without sending them on each range read.
            const itemVersion = runtime
              .itemContent({ sessionId, sourceThreadId, itemId, format: "json", maxChars: 1 })
              .pipe(
                Effect.mapError(unavailableVersion),
                Effect.flatMap((item) =>
                  item ? Effect.succeed(item.contentVersion) : Effect.fail(unavailableVersion()),
                ),
              );
            const current = yield* itemVersion;
            if (version !== undefined && version !== current)
              return yield* Effect.fail(downloadConflict());
            const bytes = yield* readStaged(
              ref,
              current,
              offset,
              length,
              Effect.gen(function* () {
                const resource = yield* runtime
                  .attachment(input)
                  .pipe(Effect.mapError(unavailableVersion));
                const parsed =
                  resource && "dataUrl" in resource && parseBase64DataUrl(resource.dataUrl);
                if (!parsed) return yield* Effect.fail(unavailableVersion());
                if ((yield* itemVersion) !== current) return yield* Effect.fail(downloadConflict());
                return { bytes: Buffer.from(parsed.base64, "base64"), mimeType: parsed.mimeType };
              }),
            );
            return { ...bytes, name: null };
          }
          const resource = yield* runtime
            .attachment(input)
            .pipe(Effect.mapError(unavailableVersion));
          if (!resource || !("path" in resource)) return yield* Effect.fail(unavailableVersion());
          const bytes = yield* readMobileAttachment(
            resource.path,
            offset,
            length,
            version,
            (identity) => platform.stableId("mobile-chat-attachment", ref, resource.path, identity),
          );
          return {
            ...bytes,
            mimeType: resource.attachment?.mimeType ?? null,
            name: resource.attachment?.name ?? null,
          };
        }),
      );

    const pending = new Map<
      string,
      { name: string; mimeType: string; size: number; written: number; expiresAt: number }
    >();
    const committed = new Map<string, FileRef>();
    const uploadFile = Effect.fn("MobileFiles.uploadFile")(function* (fileId: string) {
      const result = yield* library
        .read(libraryContentRoute, { read: { mode: "file", file_id: fileId } })
        .pipe(Effect.mapError(writeFailure));
      if (!result.ok) {
        if (result.error.code === "resource_not_found") return null;
        return yield* Effect.fail(writeFailure());
      }
      if (result.value.value.kind !== "file") return yield* Effect.fail(writeFailure());
      return result.value.value.value;
    });
    /**
     * The same attachment resolves to the same File, so a retried capture keeps its reference. An
     * upload never changes a File: one edited or removed since moves on to the next candidate.
     */
    const saveUpload = Effect.fn("MobileFiles.saveUpload")(function* (
      upload: Pick<FileRef, "name" | "size"> & { mimeType: string },
      bytes: Uint8Array,
    ) {
      const etag = platform.contentFingerprint(bytes);
      const holdsUpload = (file: LibraryFile) =>
        file.lifecycle === "live" &&
        file.blob_etag === etag &&
        file.mime_type === upload.mimeType &&
        file.byte_length === upload.size;
      for (let candidate = 0; ; candidate++) {
        const fileId = platform.stableId(
          "mobile-upload",
          upload.name,
          upload.mimeType,
          bytes,
          String(candidate),
        );
        const existing = yield* uploadFile(fileId);
        if (existing) {
          if (holdsUpload(existing)) return fileId;
          continue;
        }
        const operationId = createOperationId("mobile.file.upload");
        const prepared = yield* library
          .prepareFileBlob(libraryContentRoute, operationId, "mobile-upload", bytes)
          .pipe(Effect.mapError(writeFailure));
        yield* library
          .apply(libraryContentRoute, {
            operationId,
            storeEpoch: authority.identity.storeEpoch,
            operation: {
              kind: "apply_file_change",
              change: {
                kind: "create",
                file_id: fileId,
                default_name: upload.name,
                mime_type: upload.mimeType,
                prepared_blob_receipt_id: prepared.receipt_id,
              },
            },
          })
          .pipe(Effect.mapError(writeFailure));
        // The create may have lost to the same attachment arriving at once from elsewhere.
        const saved = yield* uploadFile(fileId);
        if (saved && holdsUpload(saved)) return fileId;
      }
    });
    const removePending = (path: string, id: string) =>
      platform
        .removeUpload(path, id)
        .pipe(Effect.andThen(Effect.sync(() => pending.delete(id))), Effect.asVoid);
    const sweepUploads = uploadLane.withPermit(
      Effect.gen(function* () {
        if (!directory) return;
        const now = clock.currentTimeMillisUnsafe();
        for (const [id, upload] of pending) {
          if (upload.expiresAt <= now) yield* removePending(directory, id);
        }
      }),
    );
    yield* Effect.forever(Effect.sleep("30 seconds").pipe(Effect.andThen(sweepUploads))).pipe(
      Effect.forkScoped,
    );
    const expiresAt = () => clock.currentTimeMillisUnsafe() + UPLOAD_IDLE_MILLIS;
    const uploadBegin: MobileHandlers["files.upload.begin"] = (input) =>
      uploadLane.withPermit(
        Effect.gen(function* () {
          const name = input.name.trim();
          const mimeType = input.mimeType.trim().toLowerCase();
          if (
            !name ||
            name.length > 255 ||
            /[/\\\p{Cc}]/u.test(name) ||
            !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/u.test(mimeType) ||
            mimeType.length > 128
          )
            return yield* Effect.fail(invalid("The file name or type is invalid."));
          const reserved = [...pending.values()].reduce((sum, entry) => sum + entry.size, 0);
          if (pending.size >= MAX_UPLOADS || reserved + input.size > MOBILE_UPLOAD_MAX_BYTES)
            return yield* Effect.fail(unavailable("Too many uploads are open."));
          yield* stagingDirectory;
          const uploadId = platform.randomId();
          pending.set(uploadId, {
            name,
            mimeType,
            size: input.size,
            written: 0,
            expiresAt: expiresAt(),
          });
          return { uploadId };
        }),
      );
    const uploadChunk: MobileHandlers["files.upload.chunk"] = ({ uploadId, offset, base64 }) =>
      uploadLane.withPermit(
        Effect.gen(function* () {
          const upload = pending.get(uploadId);
          if (!directory || !upload)
            return yield* Effect.fail(missing("This upload is no longer open."));
          const bytes = decodeUploadChunk(base64);
          if (!bytes || offset !== upload.written || offset + bytes.length > upload.size)
            return yield* Effect.fail(
              invalid("The upload chunk does not match the declared file."),
            );
          const path = directory;
          yield* platform.append(path, uploadId, bytes).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                upload.written += bytes.length;
                upload.expiresAt = expiresAt();
              }),
            ),
            Effect.tapError(() => removePending(path, uploadId)),
            Effect.uninterruptible,
            Effect.mapError(writeFailure),
          );
          return {};
        }),
      );
    const uploadCommit: MobileHandlers["files.upload.commit"] = ({ uploadId }) =>
      uploadLane.withPermit(
        Effect.gen(function* () {
          const prior = committed.get(uploadId);
          if (prior) return prior;
          const upload = pending.get(uploadId);
          if (!directory || !upload)
            return yield* Effect.fail(missing("This upload is no longer open."));
          if (upload.written !== upload.size)
            return yield* Effect.fail(invalid("This upload is incomplete."));
          const bytes = yield* platform
            .readUpload(directory, uploadId)
            .pipe(Effect.mapError(writeFailure));
          if (bytes.byteLength !== upload.size)
            return yield* Effect.fail(invalid("The uploaded size changed."));
          const fileId = yield* saveUpload(upload, bytes);
          const ref = {
            ref: fileSource(fileId),
            name: upload.name,
            mimeType: upload.mimeType,
            size: upload.size,
          };
          yield* removePending(directory, uploadId).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (committed.size >= MAX_COMMITTED)
                  committed.delete(committed.keys().next().value!);
                committed.set(uploadId, ref);
              }),
            ),
            Effect.uninterruptible,
          );
          return ref;
        }),
      );
    return {
      "files.read": read,
      "files.upload.begin": uploadBegin,
      "files.upload.chunk": uploadChunk,
      "files.upload.commit": uploadCommit,
    };
  });
  return { open, captureImages, chatResources };
});
