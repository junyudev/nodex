import { join } from "node:path";
import {
  MOBILE_FILE_CHUNK_BYTES,
  MOBILE_UPLOAD_MAX_BYTES,
  type FileRef,
} from "@nodex/mobile-protocol";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { z } from "zod";
import { libraryContentRoute } from "../../shared/content-routing-context";
import { fileSource, parseFileSource } from "../../shared/file-resources";
import { LibraryModule } from "../../main/library-application/LibraryModule";
import { makeLibraryUploads } from "../../main/library-application/LibraryUploads";
import { PhoneFiles } from "../../main/platform/node/PhoneFiles";
import { MainConfig } from "../../main/app/MainConfig";
import { ChatAttachments } from "../ChatAttachments";
import { invalid, missing, rpcError, unavailable, type MobileHandlers } from "./rpc";

const attachmentPrefix = "nodex://chat-attachments/";
const identity = z.string().min(1).max(512);
/**
 * A chat picture by the identities its transcript carries: Session, source thread, item and the
 * picture's place in it. A connected conversation's item is also named by its Run.
 */
const attachmentLocator = z.union([
  z.tuple([identity, identity, identity, identity]),
  z.tuple([identity, identity, identity, identity, identity]),
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
const downloadConflict = () => rpcError("conflict", "This file changed. Download it again.");
const writeFailure = () => unavailable("Nodex on your desktop could not save this file.");
export const makeMobileFiles = Effect.gen(function* () {
  const attachments = yield* ChatAttachments;
  const library = yield* LibraryModule;
  const platform = yield* PhoneFiles;
  const uploads = yield* makeLibraryUploads;
  const config = yield* MainConfig;
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
          // A chat's attachments have one owner for every Device the Member reads them from.
          const [sessionId, sourceThreadId, itemId, attachmentId, runId] = locator;
          return yield* attachments
            .read({
              sessionId,
              sourceThreadId,
              itemId,
              attachmentId,
              offset,
              length,
              ...(runId === undefined ? {} : { runId }),
              ...(version == null ? {} : { version }),
            })
            .pipe(
              Effect.mapError((refusal) =>
                refusal.reason === "changed" ? downloadConflict() : notFound(),
              ),
            );
        }),
      );

    const pending = new Map<
      string,
      { name: string; mimeType: string; size: number; written: number; expiresAt: number }
    >();
    const committed = new Map<string, FileRef>();
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
          const fileId = yield* uploads
            .save("mobile-upload", {
              name: upload.name,
              mimeType: upload.mimeType,
              bytes,
            })
            .pipe(Effect.mapError(writeFailure));
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
  return { open, captureImages };
});
