import { createHash } from "node:crypto";
import {
  ChatAttachmentId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  isProviderSendTurnSupportedImageMimeType,
  type ChatImageAttachment,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UnavailableImage,
} from "@nodex/runtime-contracts";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  toolOutputImages,
} from "@nodex/runtime-shared/toolOutput";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import { renderableImageType } from "../renderableImage.ts";

/**
 * Where the picture a step saw or made is, when its tool's own result does not hold it: bytes its
 * provider reported with the step, or the file the step named.
 */
export type ViewedPictureSource =
  | {
      readonly type: "data";
      readonly name: string;
      readonly mimeType: string;
      readonly base64: string;
      readonly fallbackPath?: string;
      readonly locator?: string;
    }
  | { readonly type: "file"; readonly path: string }
  | { readonly type: "unavailable"; readonly name: string; readonly locator: string };

type Picture = { readonly mimeType: string; readonly bytes: Uint8Array };
type PictureData = Pick<Extract<ViewedPictureSource, { type: "data" }>, "mimeType" | "base64">;

function boundedPictureData(mimeType: unknown, base64: unknown): PictureData | undefined {
  return typeof mimeType === "string" &&
    isProviderSendTurnSupportedImageMimeType(mimeType) &&
    typeof base64 === "string" &&
    base64.length > 0 &&
    base64.length <= MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH
    ? { mimeType: mimeType.toLowerCase(), base64 }
    : undefined;
}

/** A read may return a structured image file, image blocks or native history content items. */
export function viewedToolOutputImage(output: unknown): PictureData | undefined {
  if (Predicate.isObject(output) && output.type === "image" && Predicate.isObject(output.file)) {
    return boundedPictureData(output.file.type, output.file.base64);
  }
  for (const image of toolOutputImages(output)) {
    const picture = boundedPictureData(image.mimeType, image.data);
    if (picture !== undefined) return picture;
  }
  if (!Array.isArray(output)) return undefined;
  for (const block of output) {
    if (
      !Predicate.isObject(block) ||
      block.type !== "inputImage" ||
      typeof block.imageUrl !== "string"
    )
      continue;
    const image = parseBase64DataUrl(block.imageUrl);
    const picture = boundedPictureData(image?.mimeType, image?.base64);
    if (picture !== undefined) return picture;
  }
  return undefined;
}

function decodePicture(data: PictureData | undefined): Picture | undefined {
  const bounded = boundedPictureData(data?.mimeType, data?.base64);
  if (bounded === undefined) return undefined;
  const bytes = Result.getOrUndefined(Base64.decode(bounded.base64));
  return bytes && bytes.byteLength > 0 && bytes.byteLength <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
    ? { mimeType: bounded.mimeType, bytes }
    : undefined;
}

/** Keep the picture with the completed step. Prefer provider bytes, then its named local file. */
export const keepViewedImage =
  (store: {
    readonly attachmentsDir: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) =>
  (
    item: OrchestrationV2TurnItem,
    source?: ViewedPictureSource,
    cwd?: string | null,
  ): Effect.Effect<OrchestrationV2TurnItem> => {
    if (
      item.type !== "dynamic_tool" ||
      item.status !== "completed" ||
      (source === undefined && item.viewedImagePath === undefined) ||
      item.attachments?.some((attachment) => attachment.type === "image")
    )
      return Effect.succeed(item);
    const filePath =
      source?.type === "file"
        ? source.path
        : source?.type === "data"
          ? (source.fallbackPath ?? item.viewedImagePath)
          : item.viewedImagePath;
    const locator = (
      filePath ??
      (source?.type === "unavailable" || source?.type === "data" ? source.locator : undefined)
    )
      ?.slice(0, 4096)
      .trim();
    const basename = (path: string | undefined) => path?.split(/[\\/]/u).at(-1);
    const name =
      (
        basename(item.viewedImagePath) ??
        (source?.type === "data" || source?.type === "unavailable"
          ? source.name
          : basename(filePath)) ??
        "Image"
      )
        .slice(0, 255)
        .trim() || "Image";
    const readFile = Effect.fnUntraced(
      function* (path: string) {
        // Only a file in the provider's execution filesystem can supply the fallback bytes.
        const local = store.path.isAbsolute(path)
          ? path
          : cwd
            ? store.path.resolve(cwd, path)
            : null;
        if (local === null) return undefined;
        const info = yield* store.fileSystem.stat(local);
        if (info.type !== "File" || info.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
          return undefined;
        const file = yield* store.fileSystem.open(local);
        const read = yield* file.readAlloc(Number(info.size) + 1);
        const bytes = Option.getOrUndefined(read);
        if (bytes === undefined || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
          return undefined;
        const mimeType = renderableImageType(bytes);
        return mimeType === null ? undefined : { mimeType, bytes };
      },
      Effect.catch(() => Effect.succeed(undefined)),
    );
    return Effect.gen(function* () {
      const inline =
        source?.type === "data"
          ? decodePicture(source)
          : source === undefined
            ? decodePicture(viewedToolOutputImage(item.output))
            : undefined;
      const seen = inline ?? (filePath === undefined ? undefined : yield* readFile(filePath));
      if (seen === undefined) {
        if (!locator || item.unavailableImages?.some((image) => image.sourcePath === locator))
          return item;
        const unavailable: OrchestrationV2UnavailableImage = {
          name,
          sourcePath: locator,
          reason: "source_missing",
        };
        return { ...item, unavailableImages: [...(item.unavailableImages ?? []), unavailable] };
      }
      const digest = createHash("sha256").update(seen.bytes).digest("hex");
      const id = createDeterministicAttachmentId(
        item.threadId,
        `viewed-image:${item.id}:${digest}`,
      );
      if (id === null) return item;
      const copy: ChatImageAttachment = {
        type: "image",
        id: ChatAttachmentId.make(id),
        name,
        mimeType: seen.mimeType,
        sizeBytes: seen.bytes.byteLength,
      };
      const temporary = yield* store.fileSystem.makeTempFileScoped({
        directory: store.attachmentsDir,
        prefix: "viewed-",
        suffix: ".part",
      });
      yield* store.fileSystem.writeFile(temporary, seen.bytes);
      // Publish the complete private file without replacing a copy an earlier update kept.
      yield* store.fileSystem
        .link(temporary, store.path.join(store.attachmentsDir, attachmentRelativePath(copy)!))
        .pipe(
          Effect.catch((cause) =>
            cause.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(cause),
          ),
        );
      return { ...item, attachments: [...(item.attachments ?? []), copy] };
    }).pipe(
      Effect.scoped,
      Effect.catch((cause) =>
        Effect.logWarning("orchestration-v2.viewed-image-copy-failed", { cause }).pipe(
          Effect.as(item),
        ),
      ),
    );
  };
