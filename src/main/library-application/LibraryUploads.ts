import * as Effect from "effect/Effect";
import { libraryContentRoute } from "../../shared/content-routing-context";
import type { LibraryFile } from "../../shared/library-files";
import { CoreAuthority } from "../core-runtime/CoreAuthority";
import { createOperationId } from "../core-runtime/operation-identity";
import { contentFingerprint, stableId } from "../platform/node/content-identity";
import { LibraryModule } from "./LibraryModule";

export interface LibraryUpload {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/**
 * Saves bytes a Member sends from one of their Devices as a Library File, with that Member's
 * authority. The same bytes, name and type resolve to the same File, so a retried send keeps its
 * reference; an upload never changes a File, and one edited or removed since moves to the next.
 */
export const makeLibraryUploads = Effect.gen(function* () {
  const library = yield* LibraryModule;
  const authority = yield* CoreAuthority;
  const save = Effect.fn("LibraryUploads.save")(function* (purpose: string, upload: LibraryUpload) {
    const etag = contentFingerprint(upload.bytes);
    const holdsUpload = (file: LibraryFile) =>
      file.lifecycle === "live" &&
      file.blob_etag === etag &&
      file.mime_type === upload.mimeType &&
      file.byte_length === upload.bytes.byteLength;
    const current = (fileId: string) =>
      library.read(libraryContentRoute, { read: { mode: "file", file_id: fileId } }).pipe(
        Effect.flatMap((result) => {
          if (!result.ok)
            return result.error.code === "resource_not_found"
              ? Effect.succeed(null)
              : Effect.fail(new Error(result.error.message));
          return result.value.value.kind === "file"
            ? Effect.succeed(result.value.value.value)
            : Effect.fail(new Error("The Library returned another kind of record"));
        }),
      );
    for (let candidate = 0; ; candidate++) {
      const fileId = stableId(
        purpose,
        upload.name,
        upload.mimeType,
        upload.bytes,
        String(candidate),
      );
      const existing = yield* current(fileId);
      if (existing) {
        if (holdsUpload(existing)) return fileId;
        continue;
      }
      const operationId = createOperationId("library.upload");
      const prepared = yield* library.prepareFileBlob(
        libraryContentRoute,
        operationId,
        purpose,
        upload.bytes,
      );
      yield* library.apply(libraryContentRoute, {
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
      });
      // The create may have lost to the same upload arriving at once from elsewhere.
      const saved = yield* current(fileId);
      if (saved && holdsUpload(saved)) return fileId;
    }
  });
  return { save };
});
