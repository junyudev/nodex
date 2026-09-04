import * as fs from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClipboardWriteImageResult } from "../shared/ipc-api";
import { parseAssetSource } from "../shared/assets";
import type {
  ElectronClipboardPort,
  ClipboardOperationError,
} from "./platform/electron/ElectronClipboard";

class ClipboardImageSourceError extends Schema.TaggedError<ClipboardImageSourceError>()(
  "ClipboardImageSourceError",
  { message: Schema.String },
) {}

interface NativeImageLike {
  isEmpty(): boolean;
}

interface ClipboardImageWriterDeps {
  fetchImpl?: typeof fetch;
  readFile?: (filePath: string) => Promise<Buffer>;
  resolveAssetPath?: (fileName: string) => string;
}

type ClipboardImagePlatform = Pick<
  ElectronClipboardPort,
  "createImageFromBuffer" | "createImageFromDataUrl" | "writeImage"
>;

function fail(message: string): ClipboardWriteImageResult {
  return { ok: false, message };
}

function isHttpLikeUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function isDataImageUrl(value: string): boolean {
  return value.startsWith("data:image/");
}

function resolveLocalImagePath(
  source: string,
  assetPathResolver: (fileName: string) => string,
): string | null {
  const assetSource = parseAssetSource(source);
  if (assetSource) {
    return assetPathResolver(assetSource.fileName);
  }

  if (source.startsWith("file://")) {
    try {
      return fileURLToPath(source);
    } catch {
      throw new Error("Could not load the image file.");
    }
  }

  if (path.isAbsolute(source)) {
    return path.resolve(source);
  }

  return null;
}

async function createNativeImageFromSource(
  source: string,
  platform: ClipboardImagePlatform,
  deps: Required<ClipboardImageWriterDeps>,
): Promise<NativeImageLike | null> {
  if (isDataImageUrl(source)) {
    return platform.createImageFromDataUrl(source);
  }

  if (isHttpLikeUrl(source)) {
    let response: Response;
    try {
      response = await deps.fetchImpl(source);
    } catch {
      throw new Error("Could not load the image file.");
    }
    if (!response.ok) {
      throw new Error("Could not load the image file.");
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    return platform.createImageFromBuffer(bytes);
  }

  const localPath = resolveLocalImagePath(source, deps.resolveAssetPath);
  if (!localPath) {
    return null;
  }

  let bytes: Buffer;
  try {
    bytes = await deps.readFile(localPath);
  } catch {
    throw new Error("Could not load the image file.");
  }
  return platform.createImageFromBuffer(bytes);
}

function resolveClipboardImageWriterDeps(
  deps: ClipboardImageWriterDeps,
): Required<ClipboardImageWriterDeps> {
  if (!deps.resolveAssetPath) {
    throw new Error("Managed asset path resolver is required");
  }
  return {
    fetchImpl: deps.fetchImpl ?? fetch,
    readFile: deps.readFile ?? fs.readFile,
    resolveAssetPath: deps.resolveAssetPath,
  };
}

export const writeImageToClipboard = Effect.fn("writeImageToClipboard")(
  function* (
    source: string,
    platform: ClipboardImagePlatform,
    deps: ClipboardImageWriterDeps,
  ): Effect.fn.Return<
    ClipboardWriteImageResult,
    ClipboardImageSourceError | ClipboardOperationError
  > {
    const normalizedSource = source.trim();
    if (!normalizedSource) {
      return fail("Could not copy image.");
    }

    const resolvedDeps = resolveClipboardImageWriterDeps(deps);

    const image = yield* Effect.tryPromise({
      try: () => createNativeImageFromSource(normalizedSource, platform, resolvedDeps),
      catch: (cause) =>
        new ClipboardImageSourceError({
          message: cause instanceof Error ? cause.message : "Could not load the image file.",
        }),
    });
    if (!image) {
      return fail("Could not copy image.");
    }
    if (image.isEmpty()) {
      return fail("Could not decode this image format for clipboard copy.");
    }

    yield* platform.writeImage(image as Parameters<ClipboardImagePlatform["writeImage"]>[0]);
    return { ok: true };
  },
  Effect.catch((error) =>
    Effect.succeed(
      fail(
        Schema.is(ClipboardImageSourceError)(error) && error.message.length > 0
          ? error.message
          : "Could not copy image.",
      ),
    ),
  ),
);
