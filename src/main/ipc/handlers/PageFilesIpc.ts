import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type { IpcMainInvokeEvent, OpenDialogOptions } from "electron";
import { lookup as lookupMimeType } from "mime-types";
import { parseContentAccessContext } from "../../../shared/content-access-context";
import { PAGE_FILE_IMPORT_MAX_BYTES, PAGE_FILE_MAX_BYTES } from "../../../shared/page-files";
import { MainConfig } from "../../app/MainConfig";
import { LibraryModule } from "../../library-application/LibraryModule";
import { ElectronDesktop } from "../../platform/electron/ElectronDesktop";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";
import { collectLocalPageFileCandidates, readLocalPageFile } from "./page-file-local-import";

export class PageFilesIpcError extends Schema.TaggedError<PageFilesIpcError>()(
  "PageFilesIpcError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const assertPreparedBytes = (bytes: Uint8Array): Uint8Array => {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error("Page File contents must be bytes");
  }
  if (bytes.byteLength > PAGE_FILE_MAX_BYTES) {
    throw new Error("Page File exceeds the 64 MiB limit");
  }
  return bytes;
};

const writeRegularFile = async (filePath: string, bytes: Uint8Array): Promise<void> => {
  const handle = await fs.open(
    filePath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
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
          requireTrustedAppRendererSender(event, "Page Files", config.rendererUrl);
          if (!windows.has(event.sender.id)) {
            throw new Error("Page File access requires an active Nodex window");
          }
        },
        catch: (cause) => new PageFilesIpcError({ operation: "authorize-renderer", cause }),
      });
    const run = <A>(operation: string, task: () => A | Promise<A>) =>
      Effect.tryPromise({
        try: () => Promise.resolve(task()),
        catch: (cause) => new PageFilesIpcError({ operation, cause }),
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
            new PageFilesIpcError({
              operation: "prepare",
              cause: new Error("Page File operation identity is invalid"),
            }),
          );
        }
        const bytes = yield* run("validate-bytes", () => assertPreparedBytes(input.bytes));
        const prepared = yield* library.preparePageFileBlob(
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
          collectLocalPageFileCandidates(selectedPaths),
        );
        let actualByteLength = 0;
        return yield* Effect.forEach(
          candidates.map((candidate, index) => ({ candidate, index })),
          ({ candidate, index }) =>
            Effect.gen(function* () {
              const bytes = yield* run("read", () => readLocalPageFile(candidate.filePath));
              actualByteLength += bytes.byteLength;
              if (actualByteLength > PAGE_FILE_IMPORT_MAX_BYTES) {
                return yield* Effect.fail(
                  new PageFilesIpcError({
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

    yield* handlePlainCommand("page-files:pick-and-prepare", (event, rawAccess, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const access = yield* Effect.try({
              try: () => parseContentAccessContext(rawAccess),
              catch: (cause) => new PageFilesIpcError({ operation: "parse-access", cause }),
            });
            const owner = windows.get(event.sender.id);
            const options: OpenDialogOptions = {
              title:
                input.title ??
                (input.selection === "directory" ? "Add folder to Page" : "Add files to Page"),
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

    yield* handlePlainCommand("page-files:prepare-local-drop", (event, rawAccess, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const access = yield* Effect.try({
              try: () => parseContentAccessContext(rawAccess),
              catch: (cause) => new PageFilesIpcError({ operation: "parse-access", cause }),
            });
            const files = yield* prepareLocalSelection(access, input.operationId, input.localPaths);
            return { files };
          }),
        ),
      ),
    );

    yield* handlePlainCommand("page-files:prepare", (event, rawAccess, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const access = yield* Effect.try({
              try: () => parseContentAccessContext(rawAccess),
              catch: (cause) => new PageFilesIpcError({ operation: "parse-access", cause }),
            });
            if (input.source.kind === "bytes") {
              const logicalPath = input.source.logicalPath.trim();
              if (!logicalPath) {
                return yield* Effect.fail(
                  new PageFilesIpcError({
                    operation: "prepare",
                    cause: new Error("Page File name is required"),
                  }),
                );
              }
              return yield* prepare(access, input.operationId, "single", {
                logicalPath,
                mimeType:
                  input.source.mimeType?.trim() ||
                  lookupMimeType(logicalPath) ||
                  "application/octet-stream",
                bytes: input.source.bytes,
              });
            }

            const localPath = input.source.path;
            const bytes = yield* run("read", () => readLocalPageFile(localPath));
            return yield* prepare(access, input.operationId, "single", {
              logicalPath: path.basename(localPath),
              mimeType: lookupMimeType(localPath) || "application/octet-stream",
              bytes,
            });
          }),
        ),
      ),
    );

    yield* handleQuery("page-files:read", (event, rawAccess, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const access = yield* Effect.try({
              try: () => parseContentAccessContext(rawAccess),
              catch: (cause) => new PageFilesIpcError({ operation: "parse-access", cause }),
            });
            const blob = yield* library.readPageFileBlob(access, input);
            return { bytes: blob.bytes, mimeType: blob.mimeType, etag: blob.etag };
          }),
        ),
      ),
    );

    yield* handlePlainCommand("page-files:save", (event, rawAccess, input) =>
      authorize(event).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const access = yield* Effect.try({
              try: () => parseContentAccessContext(rawAccess),
              catch: (cause) => new PageFilesIpcError({ operation: "parse-access", cause }),
            });
            const owner = windows.get(event.sender.id);
            const save = yield* run("choose-destination", () =>
              owner
                ? desktop.dialog.showSaveDialog(owner, {
                    title: "Save Page File",
                    defaultPath: path.basename(input.logicalPath),
                  })
                : desktop.dialog.showSaveDialog({
                    title: "Save Page File",
                    defaultPath: path.basename(input.logicalPath),
                  }),
            );
            if (save.canceled || !save.filePath) return { status: "cancelled" } as const;
            const blob = yield* library.readPageFileBlob(access, input);
            // The native save dialog owns overwrite confirmation. Requiring an exclusive
            // create here would make a user-confirmed replacement fail after the dialog closes.
            yield* run("write", () => writeRegularFile(save.filePath!, blob.bytes));
            return { status: "saved" } as const;
          }),
        ),
      ),
    );
  }),
);
