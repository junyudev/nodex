import { nativeSessionAttachmentResource } from "@nodex/agent-runtime/native-attachment-resource";
import { parseBase64DataUrl } from "@nodex/agent-runtime/image-mime";
import path from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import { ExecutionHostRuntime } from "../codex-application/ExecutionHostRuntime";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import { getMimeTypeForAssetFile } from "../local-store/assets";
import { makeNativeSessionHistory } from "./NativeSessionHistory";
import { SessionMessageIntakeError } from "./SessionMessageIntakeError";
import type { ResolvedSessionAttachment } from "./SessionMessageAttachments";

export { nativeSessionAttachmentResource } from "@nodex/agent-runtime/native-attachment-resource";

/** Resource bytes stay on the original host until its existing filesystem bridge exports them. */
export const make = Effect.gen(function* () {
  const native = yield* makeNativeSessionHistory;
  const gateway = yield* CodexGateway;
  const hosts = yield* ExecutionHostRuntime;
  const assets = yield* TemporaryAssets;
  return Effect.fn("NativeSessionMessageAttachments.resolve")(function* (input: {
    readonly threadId: string;
    readonly hostId: string;
    readonly itemId: string;
    readonly runId: string;
    readonly attachmentId: string;
  }) {
    const owner = yield* native(input.threadId, input.hostId);
    const locator = { itemId: input.itemId, runId: input.runId };
    const { entry } = yield* owner.readItem(locator);
    const resource = nativeSessionAttachmentResource(entry.item, input.attachmentId);
    if (!resource)
      return yield* new SessionMessageIntakeError({
        message: "Native attachment is unavailable; use its input/content index or image resource",
      });
    const sourcePath = resource.source.startsWith("file:")
      ? fileURLToPath(resource.source)
      : resource.source;
    if (
      owner.hostId === gateway.localHostId &&
      (path.posix.isAbsolute(sourcePath) || path.win32.isAbsolute(sourcePath))
    ) {
      const stored = yield* Effect.tryPromise(() => assets.materializeLocalResource(sourcePath));
      const maximum = stored.mimeType.startsWith("image/") ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
      if (!stored.bytes || stored.bytes > maximum)
        return yield* new SessionMessageIntakeError({
          message: "Native attachment exceeds its byte budget",
        });
      const check = yield* owner.readItem(locator);
      if (
        JSON.stringify(nativeSessionAttachmentResource(check.entry.item, input.attachmentId)) !==
        JSON.stringify(resource)
      )
        return yield* new SessionMessageIntakeError({
          message: "Native attachment changed during export",
        });
      return {
        name: resource.name,
        mimeType: stored.mimeType,
        sizeBytes: stored.bytes,
        source: assets.resolveAssetPath(stored.fileName),
      } satisfies ResolvedSessionAttachment;
    }
    let bytes: Buffer;
    let mimeType = resource.mimeType;
    if (resource.source.startsWith("data:")) {
      const parsed =
        resource.source.length <= 70 * 1024 * 1024 + 1024
          ? parseBase64DataUrl(resource.source)
          : null;
      if (!parsed || parsed.base64.length > 70 * 1024 * 1024)
        return yield* new SessionMessageIntakeError({
          message: "Native attachment data is unavailable or too large",
        });
      mimeType ??= parsed.mimeType;
      bytes = Buffer.from(parsed.base64, "base64");
    } else {
      const source = resource.source.startsWith("file:")
        ? fileURLToPath(resource.source)
        : resource.source;
      if (!path.posix.isAbsolute(source) && !path.win32.isAbsolute(source))
        return yield* new SessionMessageIntakeError({
          message: "Native attachment producer does not expose downloadable bytes",
        });
      const host = yield* hosts.resolve(owner.hostId);
      const transfer = host.transfer;
      if (!transfer)
        return yield* new SessionMessageIntakeError({
          message: "Native attachment host transfer is unavailable",
        });
      const metadata = yield* transfer.describe(source);
      mimeType ??= getMimeTypeForAssetFile(source);
      const maximum = mimeType.startsWith("image/") ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
      if (!Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > maximum)
        return yield* new SessionMessageIntakeError({
          message: "Native attachment exceeds its byte budget",
        });
      bytes = yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* Effect.acquireRelease(
            Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "nodex-native-attachment-"))),
            (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true })),
          );
          const destinationPath = path.join(temporary, "resource");
          const downloaded = yield* transfer.download({ source: metadata, destinationPath });
          if (downloaded.sha256 !== metadata.sha256 || downloaded.size !== metadata.size)
            return yield* new SessionMessageIntakeError({
              message: "Native attachment changed during export",
            });
          const result = yield* Effect.tryPromise(() => readFile(destinationPath));
          if (result.byteLength !== metadata.size)
            return yield* new SessionMessageIntakeError({
              message: "Native attachment changed during export",
            });
          return result;
        }),
      );
    }
    mimeType ??= "application/octet-stream";
    const maximum = mimeType.startsWith("image/") ? 10 * 1024 * 1024 : 50 * 1024 * 1024;
    if (bytes.byteLength === 0 || bytes.byteLength > maximum)
      return yield* new SessionMessageIntakeError({
        message: "Native attachment exceeds its byte budget",
      });
    const check = yield* owner.readItem(locator);
    if (
      JSON.stringify(nativeSessionAttachmentResource(check.entry.item, input.attachmentId)) !==
      JSON.stringify(resource)
    )
      return yield* new SessionMessageIntakeError({
        message: "Native attachment changed during export",
      });
    const stored = yield* Effect.tryPromise(() =>
      assets.saveUploadedResource({ name: resource.name, mimeType, bytes }),
    );
    return {
      name: resource.name,
      mimeType,
      sizeBytes: bytes.byteLength,
      source: assets.resolveAssetPath(stored.fileName),
    } satisfies ResolvedSessionAttachment;
  });
});
