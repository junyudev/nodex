import { cacheContentAddressedBytes } from "../../local-store/assets";
import { readFileBytesSchema, saveFileSchema } from "../../../shared/library-files-transport";
import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { lookup as lookupMimeType } from "mime-types";
import { parseContentAccessContext } from "../../../shared/content-access-context";
import { FILE_IMPORT_MAX_BYTES, FILE_MAX_BYTES } from "../../../shared/file-resources";
import { MainConfig } from "../../app/MainConfig";
import { LibraryModule } from "../../library-application/LibraryModule";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { collectLocalFileCandidates, readLocalFile } from "./file-local-import";

export class FilesIpcError extends Schema.TaggedError<FilesIpcError>()("FilesIpcError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

const assertPreparedBytes = (bytes: Uint8Array): Uint8Array => {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("File contents must be bytes");
  }
  if (bytes.byteLength > FILE_MAX_BYTES) {
    throw new Error("File exceeds the 64 MiB limit");
  }
  return bytes;
};

const writeRegularFile = async (filePath: string, bytes: Uint8Array): Promise<void> => {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error("File output must be a regular file");
    await handle.truncate(0);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
};

export const live: Layer.Layer<
  never,
  never,
  ElectronDesktop | ElectronIpc | LibraryModule | MainConfig | WindowRuntime
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const desktop = yield* ElectronDesktop;
    const ipc = yield* ElectronIpc;
    const library = yield* LibraryModule;
    const windows = yield* WindowRuntime;
    const { handlePlainCommand, handleQuery } = ipc;
    const authorize = (event: IpcMainInvokeEvent) =>
      Effect.try({
        try: () => {
          requireTrustedAppRendererSender(event, "Files", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("File access requires an active Nodex window");
          }
        },
        catch: (cause) => new FilesIpcError({ operation: "authorize-renderer", cause }),
      });
    const run = <A>(operation: string, task: () => A | Promise<A>) =>
      Effect.tryPromise({
        try: () => Promise.resolve(task()),
        catch: (cause) => new FilesIpcError({ operation, cause }),
      });
    const prepare = (
      access: ReturnType<typeof parseContentAccessContext>,
      operationId: string,
      idempotencySlot: string,
      input: { logicalPath: string; mimeType: string; bytes: Uint8Array },
    ) =>
      Effect.gen(function* () {
        if (!operationId || operationId.length > 512) {
          return yield* Effect.fail(
            new FilesIpcError({
              operation: "prepare",
              cause: new Error("File operation identity is invalid"),
            }),
          );
        }
        const bytes = yield* run("validate-bytes", () => assertPreparedBytes(input.bytes));
        const prepared = yield* library.prepareFileBlob(
          access,
          operationId,
          idempotencySlot,
          bytes,
        );
        return {
          logicalPath: input.logicalPath,
          mimeType: input.mimeType,
          receiptId: prepared.receipt_id,
          blobEtag: prepared.blob_etag,
          byteLength: prepared.byte_length,
          expiresAtUnixMs: prepared.expires_at_unix_ms,
        };
      });
    const prepareLocalSelection = (
      access: ReturnType<typeof parseContentAccessContext>,
      operationId: string,
      selectedPaths: readonly string[],
    ) =>
      Effect.gen(function* () {
        const candidates = yield* run("enumerate-local-selection", () =>
          collectLocalFileCandidates(selectedPaths),
        );
        let actualByteLength = 0;
        return yield* Effect.forEach(
          candidates.map((candidate, index) => ({ candidate, index })),
          ({ candidate, index }) =>
            Effect.gen(function* () {
              const bytes = yield* run("read", () => readLocalFile(candidate.filePath));
              actualByteLength += bytes.byteLength;
              if (actualByteLength > FILE_IMPORT_MAX_BYTES) {
                return yield* Effect.fail(
                  new FilesIpcError({
                    operation: "read",
                    cause: new Error("File import exceeds the 256 MiB batch limit"),
                  }),
                );
              }
              return yield* prepare(access, operationId, `selection:${index}`, {
                logicalPath: candidate.logicalPath,
                mimeType: lookupMimeType(candidate.filePath) || "application/octet-stream",
                bytes,
              });
            }),
          { concurrency: 1 },
        );
      });

    yield* handlePlainCommand("files:pick-and-prepare", (event, rawAccess, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const access = yield* Effect.try({
              try: () => parseContentAccessContext(rawAccess),
              catch: (cause) => new FilesIpcError({ operation: "parse-access", cause }),
            });
            const owner = windows.get(event.sender.id);
            const options: OpenDialogOptions = {
              title: input.title ?? (input.selection === "directory" ? "Add folder" : "Add Files"),
              properties:
                input.selection === "directory"
                  ? ["openDirectory"]
                  : ["openFile", "multiSelections"],
            };
            const picked = yield* run("pick", () =>
              owner
                ? desktop.dialog.showOpenDialog(owner, options)
                : desktop.dialog.showOpenDialog(options),
            );
            if (picked.canceled || picked.filePaths.length === 0) {
              return { cancelled: true, files: [] } as const;
            }
            const files = yield* prepareLocalSelection(access, input.operationId, picked.filePaths);
            return { cancelled: false, files } as const;
          }),
        ),
      ),
    );

    yield* handlePlainCommand("files:prepare-local-drop", (event, rawAccess, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const access = yield* Effect.try({
              try: () => parseContentAccessContext(rawAccess),
              catch: (cause) => new FilesIpcError({ operation: "parse-access", cause }),
            });
            const files = yield* prepareLocalSelection(access, input.operationId, input.localPaths);
            return { files };
          }),
        ),
      ),
    );

    yield* handlePlainCommand("files:prepare", (event, rawAccess, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const access = yield* Effect.try({
              try: () => parseContentAccessContext(rawAccess),
              catch: (cause) => new FilesIpcError({ operation: "parse-access", cause }),
            });
            if (input.source.kind === "bytes") {
              const logicalPath = input.source.logicalPath.trim();
              if (!logicalPath) {
                return yield* Effect.fail(
                  new FilesIpcError({
                    operation: "prepare",
                    cause: new Error("File name is required"),
                  }),
                );
              }
              return yield* prepare(access, input.operationId, input.idempotencySlot ?? "single", {
                logicalPath,
                mimeType:
                  input.source.mimeType?.trim() ||
                  lookupMimeType(logicalPath) ||
                  "application/octet-stream",
                bytes: input.source.bytes,
              });
            }

            const localPath = input.source.path;
            const bytes = yield* run("read", () => readLocalFile(localPath));
            return yield* prepare(access, input.operationId, input.idempotencySlot ?? "single", {
              logicalPath: path.basename(localPath),
              mimeType: lookupMimeType(localPath) || "application/octet-stream",
              bytes,
            });
          }),
        ),
      ),
    );

    yield* handleQuery("files:read", (event, rawAccess, rawInput) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const { access, input } = yield* run("parse-file-read", () => ({
              access: parseContentAccessContext(rawAccess),
              input: readFileBytesSchema.parse(rawInput),
            }));
            return yield* library.readFileBlob(access, input);
          }),
        ),
      ),
    );

    yield* handlePlainCommand("files:materialize", (event, rawAccess, rawInput) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const { access, input } = yield* run("parse-file-materialize", () => ({
              access: parseContentAccessContext(rawAccess),
              input: saveFileSchema.parse(rawInput),
            }));
            const { defaultName, ...read } = input;
            // Reauthorize every export, even if these bytes already have a temporary cache entry.
            const blob = yield* library.readFileBlob(access, read);
            return yield* run("materialize-file", () => {
              const suffix = path.extname(defaultName);
              const extension = /^\.[a-zA-Z0-9]{1,20}$/.test(suffix) ? suffix : ".blob";
              const root = path.join(config.nodexHome, "cache", "file-exports");
              const filename = `${blob.etag}${extension}`;
              cacheContentAddressedBytes(root, filename, Buffer.from(blob.bytes), blob.etag);
              return path.join(root, filename);
            });
          }),
        ),
      ),
    );

    yield* handlePlainCommand("files:save", (event, rawAccess, rawInput) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const { access, input } = yield* run("parse-file-save", () => ({
              access: parseContentAccessContext(rawAccess),
              input: saveFileSchema.parse(rawInput),
            }));
            const owner = windows.get(event.sender.id);
            const options = { title: "Save File", defaultPath: path.basename(input.defaultName) };
            const save = yield* run("choose-destination", () =>
              owner
                ? desktop.dialog.showSaveDialog(owner, options)
                : desktop.dialog.showSaveDialog(options),
            );
            if (save.canceled || !save.filePath) return { status: "cancelled" } as const;
            const { defaultName: _name, ...read } = input;
            const blob = yield* library.readFileBlob(access, read);
            yield* run("write", () => writeRegularFile(save.filePath!, blob.bytes));
            return { status: "saved" } as const;
          }),
        ),
      ),
    );
  }),
);
