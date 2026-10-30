import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { AgentPromptImage } from "../../shared/agent-conversation";
import {
  MAX_LIBRARY_READ_LIMIT,
  type LibraryModuleReadResult,
  type LibraryReadValue,
} from "../../shared/library-module";
import { parseFileSource } from "../../shared/file-resources";
import { AGENT_IMAGE_LIMITS, type PromptImageBytes } from "../agent-backend/AgentImageFitting";
import { isNativePromptImageType, NativePromptImages } from "../agent-backend/NativePromptImages";
import type { CoreInboxMessageImage } from "../core-client/inbox-adapter";
import type { ManagedBlobBytes } from "../core-client/types";
import { LibraryModule } from "../library-application/LibraryModule";

export interface LoadedInboxImages {
  readonly images: readonly AgentPromptImage[];
  /** One-based positions in the supplied references, even when earlier images are unavailable. */
  readonly attachedMarkers: readonly number[];
}

/** Shares one Library-image path between suggestion requests and confirmed chat handoffs. */
export const makeInboxImageLoader = Effect.gen(function* () {
  const library = yield* LibraryModule;
  const promptImages = yield* NativePromptImages;
  // File heads are mutable; only a readable immutable version with matching bytes is eligible.
  const readReviewedImage = Effect.fn("InboxImages.readReviewedImage")(function* (
    image: CoreInboxMessageImage,
  ): Effect.fn.Return<ManagedBlobBytes | null> {
    let cursor: string | null = null;
    while (true) {
      const result: Option.Option<LibraryModuleReadResult> = yield* library
        .read(
          { kind: "library" },
          {
            read: {
              mode: "file_versions",
              file_id: image.file_id,
              limit: MAX_LIBRARY_READ_LIMIT,
              cursor,
            },
          },
        )
        .pipe(Effect.option);
      if (Option.isNone(result) || !result.value.ok) return null;
      const snapshot: LibraryReadValue = result.value.value.value;
      if (snapshot.kind !== "file_versions") return null;
      for (const version of snapshot.value.items) {
        if (version.blob_etag !== image.content_hash) continue;
        const file = yield* library
          .readFileBlob(
            { kind: "library" },
            {
              fileId: image.file_id,
              source: { kind: "direct" },
              version: version.version,
            },
          )
          .pipe(Effect.option);
        if (
          Option.isNone(file) ||
          !isNativePromptImageType(file.value.mimeType) ||
          !file.value.bytes.byteLength ||
          file.value.bytes.byteLength > AGENT_IMAGE_LIMITS.sourceBytes
        )
          continue;
        if (createHash("sha256").update(file.value.bytes).digest("hex") !== image.content_hash)
          continue;
        return file.value;
      }
      if (
        !snapshot.value.has_more ||
        !snapshot.value.next_cursor ||
        snapshot.value.next_cursor === cursor
      )
        return null;
      cursor = snapshot.value.next_cursor;
    }
  });
  return Effect.fn("InboxImages.load")(function* (
    references: readonly CoreInboxMessageImage[],
  ): Effect.fn.Return<LoadedInboxImages> {
    if (references.length === 0) return { images: [], attachedMarkers: [] };
    const read: PromptImageBytes[] = [];
    const attachedMarkers: number[] = [];
    for (const [index, reference] of references.entries()) {
      const fileId = parseFileSource(reference.source);
      if (!fileId || fileId !== reference.file_id || read.length >= AGENT_IMAGE_LIMITS.count)
        continue;
      const file = yield* readReviewedImage(reference);
      if (!file) continue;
      const image: PromptImageBytes = {
        mediaType: file.mimeType as PromptImageBytes["mediaType"],
        bytes: file.bytes,
      };
      const readable = yield* promptImages.validate(image).pipe(Effect.option);
      if (Option.isNone(readable)) continue;
      read.push(image);
      attachedMarkers.push(index + 1);
    }
    if (read.length === 0) return { images: [], attachedMarkers: [] };
    const fitted = yield* promptImages.fit(read).pipe(Effect.option);
    if (Option.isNone(fitted)) return { images: [], attachedMarkers: [] };
    return { images: fitted.value, attachedMarkers };
  });
});
