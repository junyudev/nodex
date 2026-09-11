import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { ContentAccessContext } from "../../shared/content-access-context";
import type { LibraryFilePresentation, ReadFileBytesInput } from "../../shared/library-files";
import type { NodexClipboardEnvelopeV1 } from "../../shared/clipboard-paste";
import {
  clipboardFileReferences,
  replaceClipboardFileReferences,
} from "../../shared/clipboard-file-references";
import { FILE_MAX_BYTES } from "../../shared/file-resources";
import { MainConfig } from "../app/MainConfig";
import {
  fileExportPath,
  publishFileExport,
  verifyFileExport,
} from "../platform/node/file-export-cache";
import { LibraryModule } from "./LibraryModule";

export class FileExportError extends Schema.TaggedError<FileExportError>()("FileExportError", {
  cause: Schema.Defect(),
}) {}

export class FileExportRuntime extends Context.Service<
  FileExportRuntime,
  {
    readonly materialize: (
      access: ContentAccessContext,
      input: ReadFileBytesInput,
      defaultName?: string,
    ) => Effect.Effect<string, FileExportError>;
    readonly clipboardText: (
      access: ContentAccessContext,
      envelope: NodexClipboardEnvelopeV1,
      text: string,
    ) => Effect.Effect<string, FileExportError>;
  }
>()("nodex/main/library-application/FileExportRuntime") {}

export const live = Layer.effect(
  FileExportRuntime,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const library = yield* LibraryModule;
    // Two 64 MiB Files bound both transport concurrency and in-flight bytes to 128 MiB.
    const permits = yield* Semaphore.make(2);
    const root = path.join(config.nodexHome, "cache", "file-exports");
    const metadata = Effect.fn("FileExportRuntime.metadata")(
      function* (access: ContentAccessContext, input: ReadFileBytesInput) {
        const result = yield* library.read(access, {
          read: {
            mode: "file_presentation",
            file_id: input.fileId,
            source: input.source,
            version: input.version,
          },
        });
        if (!result.ok || result.value.value.kind !== "file_presentation")
          return yield* new FileExportError({ cause: new Error("File export is not authorized") });
        const presentation = result.value.value.value;
        if (presentation.byte_length > FILE_MAX_BYTES)
          return yield* new FileExportError({
            cause: new Error("File export exceeds its byte limit"),
          });
        return presentation;
      },
      Effect.mapError((cause) => new FileExportError({ cause })),
    );
    const materializeBound = Effect.fn("FileExportRuntime.materializeBound")(
      function* (
        access: ContentAccessContext,
        input: ReadFileBytesInput,
        presentation: LibraryFilePresentation,
        defaultName?: string,
      ) {
        const target = fileExportPath(
          root,
          presentation.blob_etag,
          defaultName ?? presentation.default_name,
        );
        const exists = yield* Effect.tryPromise({
          try: (signal) =>
            verifyFileExport(target, presentation.blob_etag, presentation.byte_length, signal),
          catch: (cause) => new FileExportError({ cause }),
        });
        if (exists) return target;
        const blob = yield* library.readFileBlob(access, {
          ...input,
          version: presentation.version,
        });
        if (
          blob.etag !== presentation.blob_etag ||
          blob.bytes.byteLength !== presentation.byte_length
        )
          return yield* new FileExportError({
            cause: new Error("File export changed during its read"),
          });
        yield* Effect.tryPromise({
          try: (signal) => publishFileExport(root, target, blob.bytes, blob.etag, signal),
          catch: (cause) => new FileExportError({ cause }),
        });
        return target;
      },
      Effect.mapError((cause) => new FileExportError({ cause })),
    );
    const materialize = Effect.fn("FileExportRuntime.materialize")(function* (
      access: ContentAccessContext,
      input: ReadFileBytesInput,
      defaultName?: string,
    ) {
      const presentation = yield* metadata(access, input);
      return yield* materializeBound(access, input, presentation, defaultName);
    }, permits.withPermits(1));
    const clipboardText = Effect.fn("FileExportRuntime.clipboardText")(function* (
      access: ContentAccessContext,
      envelope: NodexClipboardEnvelopeV1,
      text: string,
    ) {
      const references = clipboardFileReferences(text);
      if (!references || references.length === 0) return text;
      const source = {
        kind: "structural_clipboard" as const,
        bundle_id: envelope.bundleId,
        capability: envelope.capability,
        manifest_hash: envelope.manifestHash,
        store_epoch: envelope.storeEpoch,
      };
      const replacements = yield* Effect.forEach(
        references,
        ({ fileId, source: locator }) =>
          materialize(access, { fileId, source }).pipe(
            Effect.map((localPath) => ({ locator, localPath })),
          ),
        { concurrency: 2 },
      );
      // Recheck lease and source authorization after the slow work, immediately before native CAS.
      yield* Effect.forEach(references, ({ fileId }) => metadata(access, { fileId, source }), {
        concurrency: 2,
        discard: true,
      });
      return replaceClipboardFileReferences(
        text,
        new Map(replacements.map(({ locator, localPath }) => [locator, localPath])),
      );
    });
    return FileExportRuntime.of({ materialize, clipboardText });
  }),
);
