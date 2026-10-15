import { createHash } from "node:crypto";
import {
  ChatAttachmentId,
  PersistChatAttachmentsError,
  getProviderAttachmentLimitError,
  type PersistChatAttachmentsInput,
} from "@t3tools/contracts";
import * as Base64 from "effect/encoding/Base64";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ServerConfig from "../config.ts";
import { attachmentRelativePath, createDeterministicAttachmentId } from "../attachmentStore.ts";
import { parseBase64DataUrl } from "../imageMime.ts";

/** Persist validated image inputs atomically; content identity prevents retry overwrites. */
export const persistChatAttachments = Effect.fn("AgentRuntime.persistChatAttachments")(function* (
  input: PersistChatAttachmentsInput,
) {
  const limitError = getProviderAttachmentLimitError(input.attachments);
  if (limitError !== undefined)
    return yield* new PersistChatAttachmentsError({ message: limitError });
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* Effect.forEach(
    input.attachments,
    (attachment, index) =>
      Effect.scoped(
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (parsed === null || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
            return yield* new PersistChatAttachmentsError({
              message: `Attachment ${attachment.name} has an invalid image payload.`,
            });
          }
          const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
            Effect.mapError(
              (cause) =>
                new PersistChatAttachmentsError({
                  message: `Attachment ${attachment.name} is not valid base64.`,
                  cause,
                }),
            ),
          );
          if (bytes.byteLength !== attachment.sizeBytes) {
            return yield* new PersistChatAttachmentsError({
              message: `Attachment ${attachment.name} size does not match its payload.`,
            });
          }
          const digest = createHash("sha256").update(bytes).digest("hex");
          const rawId = createDeterministicAttachmentId(
            input.threadId,
            `${input.messageId}:${index}:${digest}`,
          );
          if (rawId === null)
            return yield* new PersistChatAttachmentsError({
              message: "Could not allocate an attachment identifier.",
            });
          const persisted = {
            type: "image" as const,
            id: ChatAttachmentId.make(rawId),
            name: attachment.name,
            mimeType: attachment.mimeType,
            sizeBytes: attachment.sizeBytes,
            ...(attachment.source === undefined ? {} : { source: attachment.source }),
          };
          const temporaryPath = yield* fs.makeTempFileScoped({
            directory: config.attachmentsDir,
            prefix: "upload-",
            suffix: ".part",
          });
          yield* fs.writeFile(temporaryPath, bytes);
          // Publish the complete private temp file without replacing an
          // accepted copy. Scope removes its temporary alias before return.
          yield* fs
            .link(
              temporaryPath,
              path.join(config.attachmentsDir, attachmentRelativePath(persisted)!),
            )
            .pipe(
              Effect.catch((cause) =>
                cause.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(cause),
              ),
            );
          return persisted;
        }).pipe(
          Effect.mapError((cause) =>
            cause instanceof PersistChatAttachmentsError
              ? cause
              : new PersistChatAttachmentsError({
                  message: `Could not persist attachment ${attachment.name}.`,
                  cause,
                }),
          ),
        ),
      ),
    { concurrency: 2 },
  );
});
