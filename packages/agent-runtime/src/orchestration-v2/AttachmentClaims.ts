import { createHash } from "node:crypto";
import * as FileSystem from "effect/FileSystem";
import {
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  type ChatAttachment,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";

export class AttachmentClaimError extends Schema.TaggedError<AttachmentClaimError>()(
  "AttachmentClaimError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const validateAttachmentLimits = Effect.fn("AttachmentClaims.validateAttachmentLimits")(
  function* (attachments: ReadonlyArray<ChatAttachment>) {
    const error = getProviderAttachmentLimitError(attachments);
    if (error) return yield* new AttachmentClaimError({ message: error });
  },
);

export interface ClaimedAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly claimedPaths: ReadonlyArray<string>;
}

export function attachmentIsPendingUpload(attachment: ChatAttachment): boolean {
  return parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT;
}

/** Remove partial claims only before dispatch, or after proving they were not accepted. */
export const releaseClaimedAttachments = Effect.fn("AttachmentClaims.releaseClaimedAttachments")(
  function* (claimedPaths: ReadonlyArray<string>) {
    if (claimedPaths.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(claimedPaths, (path) => fileSystem.remove(path).pipe(Effect.ignore), {
      concurrency: 1,
      discard: true,
    }).pipe(Effect.uninterruptible);
  },
);

/**
 * Claims pending uploads into the target thread's attachment store before the
 * command enters the orchestrator: verifies the staged file, copies it under a
 * thread-scoped id, and rewrites the attachment ref. A copy, not a move — the
 * pending file stays behind as the retry source for a failed bootstrap, and
 * the periodic pending sweep reclaims it later. Already-claimed attachments
 * pass through untouched.
 */
export const claimPendingAttachments = Effect.fn("AttachmentClaims.claimPendingAttachments")(
  function* (input: {
    readonly threadId: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    yield* validateAttachmentLimits(input.attachments);
    if (
      new Set(input.attachments.map((attachment) => attachment.id)).size !==
      input.attachments.length
    ) {
      return yield* new AttachmentClaimError({
        message: "Duplicate attachment ids are not allowed.",
      });
    }
    if (!input.attachments.some(attachmentIsPendingUpload)) {
      return { attachments: input.attachments, claimedPaths: [] } satisfies ClaimedAttachments;
    }
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const claimedPaths: string[] = [];
    const attachments = yield* Effect.forEach(
      input.attachments,
      (attachment) =>
        Effect.scoped(
          Effect.gen(function* () {
            if (!attachmentIsPendingUpload(attachment)) {
              return attachment;
            }
            const currentPath = resolveAttachmentPathById({
              attachmentsDir: serverConfig.attachmentsDir,
              attachmentId: attachment.id,
            });
            if (currentPath === null) {
              return yield* new AttachmentClaimError({
                message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
              });
            }
            const info = yield* fileSystem.stat(currentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new AttachmentClaimError({
                    message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                    cause,
                  }),
              ),
            );
            if (Number(info.size) !== attachment.sizeBytes) {
              return yield* new AttachmentClaimError({
                message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
              });
            }
            // Snapshot the pending bytes before deriving their identity. A copy,
            // rather than a hard link, keeps native edits out of the retry source.
            const temporaryPath = yield* fileSystem.makeTempFileScoped({
              directory: serverConfig.attachmentsDir,
              prefix: "claim-",
              suffix: ".part",
            });
            // An interrupted copy still finishes before Scope removes its temp file.
            yield* fileSystem.copyFile(currentPath, temporaryPath).pipe(Effect.uninterruptible);
            if (Number((yield* fileSystem.stat(temporaryPath)).size) !== attachment.sizeBytes) {
              return yield* new AttachmentClaimError({
                message: `Attachment '${attachment.name}' changed while it was being claimed.`,
              });
            }
            // Hash incrementally so an upload retry keeps its accepted identity,
            // while changed bytes cannot borrow that receipt. No file body is cached.
            const digest = yield* fileSystem.stream(temporaryPath).pipe(
              Stream.runFold(
                () => createHash("sha256"),
                (hash, bytes) => hash.update(bytes),
              ),
              Effect.map((hash) => hash.digest("hex")),
              Effect.mapError(
                (cause) =>
                  new AttachmentClaimError({
                    message: `Failed to read attachment '${attachment.name}'.`,
                    cause,
                  }),
              ),
            );
            const claim = planAttachmentClaim({
              attachmentsDir: serverConfig.attachmentsDir,
              threadId: input.threadId,
              attachmentId: attachment.id,
              contentDigest: digest,
            });
            if (!claim.ok)
              return yield* new AttachmentClaimError({
                message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
              });
            const normalized: ChatAttachment = {
              ...attachment,
              id: ChatAttachmentId.make(claim.finalId),
              mimeType: attachment.mimeType.toLowerCase(),
            };
            const expectedPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment: normalized,
            });
            if (expectedPath !== claim.finalPath) {
              return yield* new AttachmentClaimError({
                message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
              });
            }
            // The intake lock covers claiming through dispatch/rollback. A prior
            // accepted copy belongs to its message and must never be overwritten
            // or registered for this attempt's cleanup.
            if (yield* fileSystem.exists(claim.finalPath)) return normalized;
            // Publish the immutable snapshot and register rollback atomically.
            yield* fileSystem
              .rename(temporaryPath, claim.finalPath)
              .pipe(
                Effect.andThen(Effect.sync(() => claimedPaths.push(claim.finalPath))),
                Effect.uninterruptible,
              );
            return normalized;
          }).pipe(
            Effect.mapError((cause) =>
              cause instanceof AttachmentClaimError
                ? cause
                : new AttachmentClaimError({
                    message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                    cause,
                  }),
            ),
          ),
        ),
      { concurrency: 1 },
    ).pipe(Effect.onError(() => releaseClaimedAttachments(claimedPaths)));
    return { attachments, claimedPaths } satisfies ClaimedAttachments;
  },
);
