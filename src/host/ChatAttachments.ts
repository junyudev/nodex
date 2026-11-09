import { MainConfig } from "../main/app/MainConfig";
import { hostPathFlavor } from "./host-paths";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBase64DataUrl } from "@nodex/agent-runtime/image-mime";
import { resolveMarkdownImagePath } from "@nodex/agent-runtime/markdown-image-paths";
import { localMarkdownImagePaths } from "@nodex/agent-runtime/markdown-images";
import { nativeSessionMediaResources } from "@nodex/agent-runtime/native-attachment-resource";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type { z } from "zod";
import { AgentRuntimeApplication } from "../main/agent-runtime/AgentRuntimeApplication";
import { makeNativeSessionHistory } from "../main/app-tools/NativeSessionHistory";
import { CodexNativeThreadLookup } from "../main/codex-application/CodexNativeThreadLookup";
import { ExecutionHostRuntime } from "../main/codex-application/ExecutionHostRuntime";
import { CodexGateway } from "../main/codex-runtime/CodexGateway";
import { openRegularFile } from "../main/platform/node/open-regular-file";
import { ProjectWorkspace } from "../main/project-application/ProjectWorkspace";
import type { ProjectSession } from "../shared/types";
import { parseReplyPictureAttachmentId } from "../shared/agent-runtime-attachments";
import { RENDERABLE_IMAGE_SIGNATURE_BYTES, renderableImageType } from "../shared/renderable-image";
import type {
  HostedChatAttachmentChunk,
  HostedChatAttachmentReadSchema,
} from "../shared/schemas/agent-runtime-api";
import { HostInvocation } from "./HostInvocation";

export type ChatAttachmentRead = z.infer<typeof HostedChatAttachmentReadSchema> & {
  /**
   * A connected Codex conversation's item is also named by its Run. Only the desktop that holds
   * the conversation reads it; a hosted Space has none.
   */
  readonly runId?: string;
};

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
  /** The picture these bytes are, for an entry later ranges find by version alone. */
  readonly picture?: string;
  readonly name?: string;
}

/** A connected conversation's picture, or a reply's, is at most what a provider turn accepts. */
const NATIVE_IMAGE_BYTES = 10 * 1024 * 1024;
const NATIVE_DATA_URL_CHARS = Math.ceil(NATIVE_IMAGE_BYTES / 3) * 4 + 256;

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
  // A desktop reads its connected conversations; a hosted Space has none.
  const gateway = yield* Effect.serviceOption(CodexGateway);
  const lookup = yield* Effect.serviceOption(CodexNativeThreadLookup);
  const hosts = yield* Effect.serviceOption(ExecutionHostRuntime);
  const native =
    Option.isSome(gateway) && Option.isSome(lookup) && Option.isSome(hosts)
      ? {
          history: yield* makeNativeSessionHistory.pipe(
            Effect.provideService(CodexGateway, gateway.value),
            Effect.provideService(CodexNativeThreadLookup, lookup.value),
          ),
          hosts: hosts.value,
        }
      : null;
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

  const chunk = (entry: InlineImage, offset: number, length: number) => {
    const start = Math.min(offset, entry.bytes.length);
    return {
      base64: entry.bytes.subarray(start, start + length).toString("base64"),
      totalBytes: entry.bytes.length,
      mimeType: entry.mimeType,
    };
  };

  /**
   * Where a connected conversation's picture lives: in the conversation itself, or as a file on the
   * machine that ran it, read through that execution host. Its fingerprint versions the bytes.
   */
  const nativeSource = (source: string, hostId: string) =>
    Effect.gen(function* () {
      if (!native) return yield* missing();
      if (source.startsWith("data:")) {
        const parsed = source.length <= NATIVE_DATA_URL_CHARS && parseBase64DataUrl(source);
        if (!parsed) return yield* missing();
        return {
          fingerprint: createHash("sha256").update(parsed.base64).digest("hex"),
          load: Effect.succeed(Buffer.from(parsed.base64, "base64")),
        };
      }
      const path = yield* Effect.try({
        try: () => (source.startsWith("file:") ? fileURLToPath(source) : source),
        catch: missing,
      });
      if (!posix.isAbsolute(path) && !win32.isAbsolute(path)) return yield* missing();
      const transfer = (yield* native.hosts.resolve(hostId).pipe(Effect.mapError(missing)))
        .transfer;
      if (!transfer) return yield* missing();
      const file = yield* transfer.describe(path).pipe(Effect.mapError(missing));
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > NATIVE_IMAGE_BYTES)
        return yield* missing();
      const load = Effect.gen(function* () {
        const directory = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => mkdtemp(join(tmpdir(), "nodex-chat-picture-")),
            catch: missing,
          }),
          (created) => Effect.promise(() => rm(created, { recursive: true, force: true })),
        );
        const destinationPath = join(directory, "picture");
        const copied = yield* transfer
          .download({ source: file, destinationPath })
          .pipe(Effect.mapError(changed));
        if (copied.sha256 !== file.sha256 || copied.size !== file.size) return yield* changed();
        const bytes = yield* Effect.tryPromise({
          try: () => readFile(destinationPath),
          catch: changed,
        });
        return bytes.byteLength === file.size ? bytes : yield* changed();
      }).pipe(Effect.scoped);
      return { fingerprint: `${file.sha256}:${file.size}`, load };
    });

  /**
   * A connected conversation's picture, as its desktop shows it. Its item is read again for the
   * first range, so the picture is the one the transcript names now; later ranges of that version
   * come from what the first one read. Only a picture leaves the desktop: a conversation that
   * names any other file reads as missing.
   */
  const readNative = Effect.fn("ChatAttachments.readNative")(function* (
    chat: ProjectSession,
    input: ChatAttachmentRead & { readonly runId: string },
    unavailable: () => ChatAttachmentRefusal,
  ) {
    const thread = chat.thread;
    if (
      !native ||
      chat.executionRef ||
      thread?.backendBinding.kind !== "codex" ||
      input.sourceThreadId !== thread.threadId
    )
      return yield* unavailable();
    const picture = versionOf(
      "picture",
      input.sessionId,
      thread.threadId,
      input.itemId,
      input.runId,
      input.attachmentId,
    );
    const held = input.version === undefined ? undefined : recall(input.version);
    if (held?.picture === picture && input.version !== undefined)
      return { ...chunk(held, input.offset, input.length), name: null, version: input.version };
    const owner = yield* native
      .history(thread.threadId, thread.executionHostId)
      .pipe(Effect.mapError(unavailable));
    const { entry } = yield* owner
      .readItem({ itemId: input.itemId, sourceThreadId: thread.threadId, runId: input.runId })
      .pipe(Effect.mapError(unavailable));
    const resource = nativeSessionMediaResources(entry.item).find(
      (media) => media.id === input.attachmentId && media.media === "image",
    )?.resource;
    if (!resource) return yield* unavailable();
    const source = yield* nativeSource(resource.source, owner.hostId).pipe(
      Effect.mapError(unavailable),
    );
    const version = versionOf("native", picture, source.fingerprint);
    if (input.version !== undefined && input.version !== version) return yield* changed();
    let loaded = recall(version);
    if (loaded?.picture !== picture) {
      const bytes = yield* source.load;
      const mimeType = renderableImageType(bytes.subarray(0, RENDERABLE_IMAGE_SIGNATURE_BYTES));
      if (!mimeType) return yield* unavailable();
      loaded = { bytes, mimeType, picture };
      remember(version, loaded);
    }
    return { ...chunk(loaded, input.offset, input.length), name: resource.name, version };
  });

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
    if (input.runId !== undefined)
      return yield* readNative(chat, { ...input, runId: input.runId }, unavailable);
    const replyPicture = parseReplyPictureAttachmentId(input.attachmentId);
    if (replyPicture !== null) return yield* readReplyPicture(input, replyPicture, unavailable);
    const { offset, length, version: expected, runId: _native, ...attachment } = input;
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
      return { ...chunk(entry, offset, length), name: null, version };
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
