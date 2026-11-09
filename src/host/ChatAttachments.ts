import { MainConfig } from "../main/app/MainConfig";
import { hostPathFlavor } from "./host-paths";
import { createHash } from "node:crypto";
import { basename, join, posix, win32 } from "node:path";
import { parseBase64DataUrl } from "@nodex/agent-runtime/image-mime";
import { resolveMarkdownImagePath } from "@nodex/agent-runtime/markdown-image-paths";
import { localMarkdownImagePaths } from "@nodex/agent-runtime/markdown-images";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { z } from "zod";
import { AgentRuntimeApplication } from "../main/agent-runtime/AgentRuntimeApplication";
import { openRegularFile } from "../main/platform/node/open-regular-file";
import { ProjectWorkspace } from "../main/project-application/ProjectWorkspace";
import { parseReplyPictureAttachmentId } from "../shared/agent-runtime-attachments";
import { RENDERABLE_IMAGE_SIGNATURE_BYTES, renderableImageType } from "../shared/renderable-image";
import type {
  HostedChatAttachmentChunk,
  HostedChatAttachmentReadSchema,
} from "../shared/schemas/agent-runtime-api";
import { HostInvocation } from "./HostInvocation";


/** Why an attachment was not read: it is not there for this Member, or it changed between ranges. */
export class ChatAttachmentRefusal extends Schema.TaggedError<ChatAttachmentRefusal>()(
  "ChatAttachmentRefusal",
  { reason: Schema.Literals(["missing", "changed"]) },
) {}

const missing = () => new ChatAttachmentRefusal({ reason: "missing" });
const changed = () => new ChatAttachmentRefusal({ reason: "changed" });

/** Images a tool returned inline are decoded once and kept briefly for the ranges that follow. */
const INLINE_CACHE_BYTES = 24 * 1024 * 1024;
const TOOL_RESULT = /^tool-result:(?:0|[1-9]\d*)$/u;
interface InlineImage {
  readonly bytes: Buffer;
  readonly mimeType: string | null;
  readonly name?: string;
}

/** A connected conversation's picture, or a reply's, is at most what a provider turn accepts. */
/** Opaque, and bound to the attachment it versions; it never reveals where the bytes live. */
const versionOf = (...parts: readonly string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);

/**
 * A picture's type comes from its own bytes. A record claiming a picture its bytes are not is
 * served as opaque bytes, so no surface draws it; other files keep their recorded type.
 */
function contentType(declared: string | null, head: Uint8Array): string | null {
  const image = renderableImageType(head);
  if (image) return image;
  if (declared === null) return null;
  return /^image\//iu.test(declared) ? "application/octet-stream" : declared;
}

/** A range of a recorded attachment file, pinned to that file's identity so ranges never splice. */
const readFileRange = (
  path: string,
  range: { readonly offset: number; readonly length: number },
  versionOfIdentity: (identity: string) => string,
  expected: string | undefined,
) =>
  Effect.tryPromise({
    try: async () => {
      const file = await openRegularFile(path);
      try {
        const opened = await file.stat({ bigint: true });
        const identity = ({ dev, ino, size, mtimeNs, ctimeNs }: typeof opened) =>
          `${dev}:${ino}:${size}:${mtimeNs}:${ctimeNs}`;
        const version = versionOfIdentity(identity(opened));
        if (expected !== undefined && expected !== version) return null;
        const totalBytes = Number(opened.size);
        const read = async (position: number, length: number) => {
          const target = Buffer.alloc(Math.max(0, Math.min(length, totalBytes - position)));
          const { bytesRead } = target.length
            ? await file.read(target, 0, target.length, position)
            : { bytesRead: 0 };
          return target.subarray(0, bytesRead);
        };
        const bytes = await read(range.offset, range.length);
        const head =
          range.offset === 0 && bytes.length >= RENDERABLE_IMAGE_SIGNATURE_BYTES
            ? bytes
            : await read(0, RENDERABLE_IMAGE_SIGNATURE_BYTES);
        const current = await lstat(path, { bigint: true });
        if (!current.isFile() || identity(current) !== identity(opened)) return null;
        return { bytes, head, totalBytes, version };
      } finally {
        await file.close();
      }
    },
    catch: () => (expected === undefined ? missing() : changed()),
  }).pipe(Effect.filterOrFail(Predicate.isNotNull, changed));

/**
 * One read of a hosted chat's attachments, for whichever of a Member's Devices asks: a team
 * desktop through Core's host relay or a phone through its façade. An attachment is named only by
 * the identities its transcript carries, never by where its bytes live. Every range is read under
 * the Member's Core invocation: Core reads the chat for that Member first, so its read rules and a
 * revoked Device or removed Member apply to each range, never to the host's own authority.
 */
export const make = Effect.gen(function* () {
  const hostPaths = hostPathFlavor((yield* MainConfig).platform);
  const runtime = yield* AgentRuntimeApplication;
  const projects = yield* ProjectWorkspace;
  // Keyed by version, which names the attachment and its item's content; most recently read last.
  const inline = new Map<string, InlineImage>();
  let inlineBytes = 0;
  const remember = (key: string, entry: InlineImage) => {
    inline.set(key, entry);
    inlineBytes += entry.bytes.length;
    for (const [oldest, value] of inline) {
      if (inlineBytes <= INLINE_CACHE_BYTES || oldest === key) break;
      inline.delete(oldest);
      inlineBytes -= value.bytes.length;
    }
  };
  const recall = (key: string) => {
    const entry = inline.get(key);
    if (!entry) return undefined;
    inline.delete(key);
    inline.set(key, entry);
    return entry;
  };

  /**
   * A picture a reply shows from a file on this host, named by the address the reply wrote. The
   * reply is read again for the first range, so only a picture it shows now is read, and only its
   * bytes leave the host when they are a picture; later ranges of that version come from them.
   */
  const readReplyPicture = Effect.fn("ChatAttachments.readReplyPicture")(function* (
    input: ChatAttachmentRead,
    address: string,
    unavailable: () => ChatAttachmentRefusal,
  ) {
    const { sessionId, threadId, sourceThreadId, itemId, attachmentId, offset, length } = input;
    const picture = versionOf("reply", sessionId, sourceThreadId ?? "", itemId, attachmentId);
    const held = input.version === undefined ? undefined : recall(input.version);
    if (held?.picture === picture && input.version !== undefined)
      return { ...chunk(held, offset, length), name: held.name ?? null, version: input.version };
    const target = { sessionId, ...(threadId === undefined ? {} : { threadId }) };
    const item = yield* runtime
      .item({
        ...target,
        itemId,
        ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
        full: true,
      })
      .pipe(Effect.mapError(unavailable));
    if (
      item?.type !== "assistant_message" ||
      !localMarkdownImagePaths(item.text, hostPaths).includes(address)
    )
      return yield* unavailable();
    // A relative address is read from where the reply's chat works on this host.
    const relative =
      !/^file:/iu.test(address) && !posix.isAbsolute(address) && !win32.isAbsolute(address);
    const cwd = relative
      ? (yield* runtime
          .inspect({ sessionId, threadId: sourceThreadId ?? item.threadId })
          .pipe(Effect.mapError(unavailable))).thread.worktreePath
      : "/";
    if (!cwd) return yield* unavailable();
    const path = yield* Effect.try({
      try: () => resolveMarkdownImagePath(address, cwd, hostPaths),
      catch: unavailable,
    });
    const bytes = yield* Effect.tryPromise({
      try: async () => {
        const file = await openRegularFile(path);
        try {
          const { size } = await file.stat();
          return size < 1 || size > NATIVE_IMAGE_BYTES ? null : await file.readFile();
        } finally {
          await file.close();
        }
      },
      catch: unavailable,
    }).pipe(Effect.filterOrFail(Predicate.isNotNull, unavailable));
    const mimeType = renderableImageType(bytes.subarray(0, RENDERABLE_IMAGE_SIGNATURE_BYTES));
    if (!mimeType) return yield* unavailable();
    const version = versionOf("reply", picture, createHash("sha256").update(bytes).digest("hex"));
    if (input.version !== undefined && input.version !== version) return yield* changed();
    const entry = { bytes, mimeType, picture, name: basename(path) };
    remember(version, entry);
    return { ...chunk(entry, offset, length), name: entry.name, version };
  });

  const read = Effect.fn("ChatAttachments.read")(function* (
    input: ChatAttachmentRead,
  ): Effect.fn.Return<HostedChatAttachmentChunk, ChatAttachmentRefusal> {
    // A missing range after the first one means the attachment went away mid-read: start over.
    const unavailable = input.version === undefined ? missing : changed;
    if (!(yield* HostInvocation)) return yield* missing();
    const chat = yield* projects
      .getProjectSession(input.sessionId)
      .pipe(Effect.mapError(unavailable));
    if (!chat) return yield* unavailable();
    const replyPicture = parseReplyPictureAttachmentId(input.attachmentId);
    if (replyPicture !== null) return yield* readReplyPicture(input, replyPicture, unavailable);
    const { sessionId, sourceThreadId, itemId, attachmentId } = attachment;
    const identity = [sessionId, input.threadId ?? "", sourceThreadId ?? "", itemId, attachmentId];

    if (TOOL_RESULT.test(attachmentId)) {
      // The item's content version covers its inline bytes without carrying them on every range.
      const itemVersion = runtime
        .itemContent({
          sessionId,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
          ...(sourceThreadId === undefined ? {} : { sourceThreadId }),
          itemId,
          format: "json",
          maxChars: 1,
        })
        .pipe(
          Effect.mapError(unavailable),
          Effect.flatMap((item) =>
            item ? Effect.succeed(item.contentVersion) : Effect.fail(unavailable()),
          ),
        );
      const current = yield* itemVersion;
      const version = versionOf("inline", ...identity, current);
      if (expected !== undefined && expected !== version) return yield* changed();
      let entry = recall(version);
      if (!entry) {
        const resource = yield* runtime.attachment(attachment).pipe(Effect.mapError(unavailable));
        const parsed = resource && "dataUrl" in resource && parseBase64DataUrl(resource.dataUrl);
        if (!parsed) return yield* unavailable();
        const bytes = Buffer.from(parsed.base64, "base64");
        if ((yield* itemVersion) !== current) return yield* changed();
        entry = { bytes, mimeType: contentType(parsed.mimeType, bytes) };
        remember(version, entry);
      }
    }

    const resource = yield* runtime.attachment(attachment).pipe(Effect.mapError(unavailable));
    if (!resource || !("path" in resource)) return yield* unavailable();
    const range = yield* readFileRange(
      resource.path,
      { offset, length },
      (file) => versionOf("file", ...identity, file),
      expected,
    );
    return {
      base64: range.bytes.toString("base64"),
      totalBytes: range.totalBytes,
      mimeType: contentType(resource.attachment?.mimeType ?? null, range.head),
      name: resource.attachment?.name ?? null,
      version: range.version,
    };
  });
  return { read };
});

export class ChatAttachments extends Context.Service<
  ChatAttachments,
  Effect.Success<typeof make>
>()("nodex/host/ChatAttachments") {}
export const live = Layer.effect(ChatAttachments, make);
