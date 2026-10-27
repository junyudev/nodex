import { createHash } from "node:crypto";
import {
  ChatAttachmentId,
  ThreadId,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  PersistChatAttachmentsError,
  getProviderAttachmentLimitError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";
import { persistChatAttachments } from "./PersistChatAttachments.ts";
import { parseBase64DataUrl } from "../imageMime.ts";
import * as Base64 from "effect/encoding/Base64";

export const ImportChatAttachmentsInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  attachments: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      mimeType: Schema.String,
      sizeBytes: Schema.Int,
      source: Schema.String,
    }),
  ).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
});
export type ImportChatAttachmentsInput = typeof ImportChatAttachmentsInput.Type;

/** Trusted Host resource resolution supplies sources; public callers cannot submit local paths. */
export const importChatAttachments = Effect.fn("Runtime.importChatAttachments")(function* (
  input: ImportChatAttachmentsInput,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const limit = getProviderAttachmentLimitError(
    input.attachments.map((attachment) => ({
      ...attachment,
      type: attachment.mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
    })),
  );
  if (limit) return yield* new PersistChatAttachmentsError({ message: limit });
  return yield* Effect.forEach(
    input.attachments,
    (attachment, index) =>
      Effect.scoped(
        Effect.gen(function* () {
          const image = attachment.mimeType.startsWith("image/");
          const maximumBytes = image
            ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
          if (attachment.sizeBytes < 1 || attachment.sizeBytes > maximumBytes)
            return yield* new PersistChatAttachmentsError({
              message: "Attachment exceeds its byte budget",
            });
          let bytes: Uint8Array | undefined;
          if (attachment.source.startsWith("data:")) {
            const data = parseBase64DataUrl(attachment.source);
            if (!data || data.mimeType !== attachment.mimeType.toLowerCase())
              return yield* new PersistChatAttachmentsError({
                message: "Attachment media payload is invalid",
              });
            bytes = yield* Effect.fromResult(Base64.decode(data.base64)).pipe(
              Effect.mapError(
                (cause) =>
                  new PersistChatAttachmentsError({
                    message: "Attachment media payload is invalid",
                    cause,
                  }),
              ),
            );
            if (bytes.byteLength !== attachment.sizeBytes)
              return yield* new PersistChatAttachmentsError({
                message: "Attachment resource changed",
              });
          } else {
            const file = yield* fs.open(attachment.source, { flag: "r" });
            const info = yield* file.stat;
            if (info.type !== "File" || Number(info.size) !== attachment.sizeBytes)
              return yield* new PersistChatAttachmentsError({
                message: "Attachment resource changed",
              });
            bytes = new Uint8Array(attachment.sizeBytes);
            let offset = 0;
            while (offset < bytes.byteLength) {
              const count = yield* file.read(bytes.subarray(offset));
              if (count === 0)
                return yield* new PersistChatAttachmentsError({
                  message: "Attachment bytes changed",
                });
              offset += count;
            }
            if ((yield* file.read(new Uint8Array(1))) !== 0)
              return yield* new PersistChatAttachmentsError({
                message: "Attachment bytes changed",
              });
          }
          if (image) {
            const persisted = yield* persistChatAttachments({
              threadId: input.threadId,
              messageId: MessageId.make(`${input.messageId}:${index}`),
              attachments: [
                {
                  type: "image",
                  name: attachment.name,
                  mimeType: attachment.mimeType,
                  sizeBytes: attachment.sizeBytes,
                  dataUrl: bytes
                    ? `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`
                    : attachment.source,
                },
              ],
            });
            return persisted[0]!;
          }
          if (!bytes)
            return yield* new PersistChatAttachmentsError({
              message: "File resource requires a materialized source",
            });
          const digest = createHash("sha256").update(bytes).digest("hex");
          const id = createDeterministicAttachmentId(
            input.threadId,
            `${input.messageId}:${index}:${digest}`,
          );
          if (!id)
            return yield* new PersistChatAttachmentsError({
              message: "Attachment identity is invalid",
            });
          const persisted: ChatAttachment = {
            type: "file",
            id: ChatAttachmentId.make(id),
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
          };
          const temporary = yield* fs.makeTempFileScoped({
            directory: config.attachmentsDir,
            prefix: "import-",
            suffix: ".part",
          });
          yield* fs.writeFile(temporary, bytes);
          yield* fs
            .link(temporary, path.join(config.attachmentsDir, attachmentRelativePath(persisted)!))
            .pipe(
              Effect.catch((error) =>
                error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
              ),
            );
          return persisted;
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof PersistChatAttachmentsError
              ? cause
              : new PersistChatAttachmentsError({
                  message: `Could not import attachment ${attachment.name}`,
                  cause,
                }),
          ),
        ),
      ),
    { concurrency: 1 },
  );
});
