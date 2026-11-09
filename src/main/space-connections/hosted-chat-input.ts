import { lstat } from "node:fs/promises";
import { basename, isAbsolute } from "node:path";
import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
} from "@nodex/agent-runtime/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { lookup as lookupMimeType } from "mime-types";
import type { z } from "zod";
import type {
  AgentRuntimeLaunch,
  AgentRuntimeMessage,
  AgentRuntimeMessageInput,
  AgentRuntimeMessageUpload,
  AgentRuntimeQueueInput,
  AgentRuntimeRewriteMessageInput,
} from "../../shared/agent-runtime-api";
import { fileSource } from "../../shared/file-resources";
import {
  HOSTED_CHAT_MAX_FILES,
  type HostedChatDeliverySchema,
} from "../../shared/schemas/agent-runtime-api";
import { NativePromptImages } from "../agent-backend/NativePromptImages";
import { readLocalFile } from "../ipc/handlers/file-local-import";
import { makeLibraryUploads, type LibraryUpload } from "../library-application/LibraryUploads";

/** Why a message cannot leave this computer for its Space's host, in words the person can act on. */
export class HostedChatInputError extends Schema.TaggedError<HostedChatInputError>()(
  "HostedChatInputError",
  { message: Schema.String },
) {}

const refuse = (message: string) => new HostedChatInputError({ message });
const causeMessage = (cause: unknown, fallback: string) => {
  const reason = cause instanceof Error && "cause" in cause ? cause.cause : cause;
  return reason instanceof Error ? reason.message : fallback;
};
/** A Library File name: the file's own name, without any folder or control character. */
const fileName = (candidate: string | undefined, fallback: string) => {
  const name = basename(candidate ?? "")
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, 255);
  return name || fallback;
};
const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

const readUpload = (upload: AgentRuntimeMessageUpload) =>
  Effect.tryPromise({
    try: async (): Promise<LibraryUpload> => {
      const name = fileName(upload.name || upload.path, "File");
      if (!isAbsolute(upload.path)) throw refuse(`Attach ${name} again to send it.`);
      const info = await lstat(upload.path);
      if (info.isDirectory())
        throw refuse("Attach files rather than folders to a chat on this Space's host.");
      if (!info.isFile()) throw refuse(`${name} is not a file this computer can send.`);
      if (info.size === 0) throw refuse(`${name} is empty.`);
      if (info.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES)
        throw refuse(`${name} is larger than a chat takes. Attach files of at most 50 MB.`);
      return {
        name,
        mimeType: lookupMimeType(upload.path) || "application/octet-stream",
        bytes: await readLocalFile(upload.path),
      };
    },
    catch: (cause) =>
      cause instanceof HostedChatInputError
        ? cause
        : refuse(`${fileName(upload.name || upload.path, "A file")} can't be read.`),
  });

/**
 * What a team desktop's Composer sends to a chat on its Space's host: the words, the context they
 * reference and the choices as written, as a local chat receives them. This computer's images and
 * files become Library Files saved with this Member's authority, which the host reads as that
 * Member; no path on this computer, and no byte outside the Library, follows the message.
 */
export const makeHostedChatInput = Effect.gen(function* () {
  const images = yield* NativePromptImages;
  const uploads = yield* makeLibraryUploads;
  const fileRefs = Effect.fn("HostedChatInput.fileRefs")(function* (message: AgentRuntimeMessage) {
    const attached = message.images ?? [];
    const files = message.uploads ?? [];
    if (attached.length + files.length === 0) return [];
    if (attached.length + files.length > HOSTED_CHAT_MAX_FILES)
      return yield* refuse(`Attach up to ${HOSTED_CHAT_MAX_FILES} files to one message.`);
    // Images are fitted here exactly as for a chat on this computer, before anything uploads.
    const pictures: LibraryUpload[] = attached.length
      ? (yield* images
          .prepare(attached)
          .pipe(
            Effect.mapError((cause) =>
              refuse(causeMessage(cause, "An image can’t be read. Remove it or add it again.")),
            ),
          )).map((image, index) => ({
          name: fileName(
            attached[index]?.caption,
            `Image ${index + 1}.${IMAGE_EXTENSIONS[image.mediaType] ?? "png"}`,
          ),
          mimeType: image.mediaType,
          bytes: Buffer.from(image.data, "base64"),
        }))
      : [];
    const documents = yield* Effect.forEach(files, readUpload, { concurrency: 1 });
    const all = [...pictures, ...documents];
    const limit = getProviderAttachmentLimitError(
      all.map(({ mimeType, bytes }) => ({
        type: mimeType.startsWith("image/") ? ("image" as const) : ("file" as const),
        mimeType,
        sizeBytes: bytes.byteLength,
      })),
    );
    if (limit) return yield* refuse(limit);
    return yield* Effect.forEach(
      all,
      (upload) =>
        uploads.save("chat-upload", upload).pipe(
          Effect.map(fileSource),
          Effect.mapError(() => refuse(`${upload.name} could not be uploaded to this Space.`)),
        ),
      { concurrency: 1 },
    );
  });
  const hostedMessage = Effect.fn("HostedChatInput.message")(function* (
    message: AgentRuntimeMessage,
  ) {
    // Attachments already recorded by this computer's own Runtime belong to its own chats.
    if (message.attachments?.length)
      return yield* refuse("Attach these files again to send them to this Space's host.");
    const refs = yield* fileRefs(message);
    return {
      messageId: message.messageId,
      text: message.text,
      ...(refs.length ? { fileRefs: refs } : {}),
      ...(message.context === undefined ? {} : { context: message.context }),
      ...(message.agentConfigs === undefined ? {} : { agentConfigs: [...message.agentConfigs] }),
      ...(message.modelSelection ? { modelSelection: message.modelSelection } : {}),
      ...(message.interactionMode ? { interactionMode: message.interactionMode } : {}),
    };
  });
  return {
    /**
     * A new chat's first message, as the Space host starts it. The host chooses where it runs and
     * prepares any worktree; nothing that presents the turn in this window crosses to it.
     */
    start: (input: AgentRuntimeLaunch) =>
      Effect.gen(function* () {
        const { sessionId, launchId, acceptedAt, projectId, title, initialPageIds } = input;
        return {
          sessionId,
          launchId,
          acceptedAt,
          projectId,
          title,
          ...(initialPageIds?.length ? { initialPageIds: [...initialPageIds] } : {}),
          modelSelection: input.modelSelection,
          interactionMode: input.interactionMode,
          ...(input.runInTarget ? { runInTarget: input.runInTarget } : {}),
          message: yield* hostedMessage(input.message),
        };
      }),
    /** The same chat message a local Composer sends, as the Space host receives it. */
    message: (input: AgentRuntimeMessageInput, queued: boolean) =>
      Effect.gen(function* () {
        if (input.intent === "restart")
          return yield* refuse("Stop the running turn, then send again");
        const delivery: z.infer<typeof HostedChatDeliverySchema> = queued
          ? "queue"
          : input.intent === "steer"
            ? "steer"
            : "send";
        return {
          ...target(input),
          message: yield* hostedMessage(input.message),
          delivery,
        };
      }),
    /** An edit of the Member's own message; the host presents nothing in this window. */
    rewrite: (input: AgentRuntimeRewriteMessageInput) =>
      Effect.gen(function* () {
        const { sessionId, threadId, requestId, runId } = input;
        return {
          ...target({ sessionId, ...(threadId === undefined ? {} : { threadId }) }),
          requestId,
          runId,
          message: yield* hostedMessage(input.message),
        };
      }),
    /** Queue controls cross unchanged; an edited message keeps only what a hosted Run reads. */
    queue: (input: AgentRuntimeQueueInput) =>
      Effect.gen(function* () {
        if (input.action !== "edit") return input;
        const { presentationTicket: _presentation, message, ...edit } = input;
        return { ...edit, message: yield* hostedMessage(message) };
      }),
  };
});

const target = ({ sessionId, threadId }: { sessionId: string; threadId?: string }) => ({
  sessionId,
  ...(threadId === undefined ? {} : { threadId }),
});
