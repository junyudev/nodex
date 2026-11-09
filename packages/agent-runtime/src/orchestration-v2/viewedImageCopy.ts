import { createHash } from "node:crypto";
import {
  ChatAttachmentId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  isProviderSendTurnSupportedImageMimeType,
  type ChatImageAttachment,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UnavailableImage,
} from "@nodex/runtime-contracts";
import { toolOutputImages } from "@nodex/runtime-shared/toolOutput";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Mime from "effect/http/Mime";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";

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
    }
  | { readonly type: "file"; readonly path: string };

type ViewedPicture =
  | { readonly kind: "picture"; readonly mimeType: string; readonly bytes: Uint8Array }
  /** The named file is gone or unreadable, so nothing can ever show it. */
  | { readonly kind: "missing" }
  /** Not a picture the chat keeps (absent, unsupported or too large); the step stays as it was. */
  | { readonly kind: "none" };

const none: ViewedPicture = { kind: "none" };

/** The picture a read returned: a structured result's `file`, or an image content block. */
function outputPicture(output: unknown): ViewedPicture {
  const file =
    Predicate.isObject(output) && output.type === "image" && Predicate.isObject(output.file)
      ? output.file
      : undefined;
  const image =
    file !== undefined
      ? typeof file.base64 === "string" && typeof file.type === "string"
        ? { mimeType: file.type.toLowerCase(), data: file.base64 }
        : null
      : (toolOutputImages(output)[0] ?? null);
  return image?.data === undefined
    ? none
    : { kind: "picture", mimeType: image.mimeType, bytes: Buffer.from(image.data, "base64") };
}

/**
 * A completed step that viewed or made a picture keeps it as the step's own attachment. Every
 * Device then shows it from the chat's recorded bytes, as it shows any other picture in the chat,
 * rather than from a path on the machine that ran the Agent; the path still says what was read.
 * Without a source the picture is the one the tool's result holds. A named file that cannot be
 * read is recorded as unavailable instead, and no longer offered as the step's preview. Keeping the
 * copy is idempotent, and a picture that cannot be kept leaves the item as it was.
 */
export const keepViewedImage =
  (store: {
    readonly attachmentsDir: string;
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
  }) =>
  (
    item: OrchestrationV2TurnItem,
    source?: ViewedPictureSource,
  ): Effect.Effect<OrchestrationV2TurnItem> => {
    if (
      item.type !== "dynamic_tool" ||
      item.status !== "completed" ||
      (source === undefined && item.viewedImagePath === undefined) ||
      item.attachments?.some((attachment) => attachment.type === "image")
    )
      return Effect.succeed(item);
    const name =
      (source?.type === "data"
        ? source.name
        : store.path.basename(source?.path ?? item.viewedImagePath ?? "")
      )
        .slice(0, 255)
        .trim() || "Image";
    const readFile = (path: string) =>
      Effect.gen(function* () {
        const info = yield* store.fileSystem.stat(path);
        if (info.type !== "File") return { kind: "missing" } as const;
        if (Number(info.size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) return none;
        return {
          kind: "picture",
          mimeType: Option.getOrElse(Mime.getType(path), () => "application/octet-stream"),
          bytes: yield* store.fileSystem.readFile(path),
        } as const;
      }).pipe(Effect.catch(() => Effect.succeed({ kind: "missing" } as const)));
    const picture: Effect.Effect<ViewedPicture> =
      source === undefined
        ? Effect.succeed(outputPicture(item.output))
        : source.type === "data"
          ? Effect.succeed({
              kind: "picture",
              mimeType: source.mimeType.toLowerCase(),
              bytes: Buffer.from(source.base64, "base64"),
            })
          : readFile(source.path);
    return Effect.gen(function* () {
      const seen = yield* picture;
      if (seen.kind === "missing" && source?.type === "file") {
        const { viewedImagePath: _unreadable, ...rest } = item;
        const unavailable: OrchestrationV2UnavailableImage = {
          name,
          sourcePath: source.path.slice(0, 4096),
          reason: "source_missing",
        };
        return { ...rest, unavailableImages: [...(item.unavailableImages ?? []), unavailable] };
      }
      if (
        seen.kind !== "picture" ||
        !isProviderSendTurnSupportedImageMimeType(seen.mimeType) ||
        seen.bytes.byteLength === 0 ||
        seen.bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      )
        return item;
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
