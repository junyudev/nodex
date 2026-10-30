import { open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { AgentPromptImage } from "../../shared/agent-conversation";
import type { CodexPromptImageInput } from "../../shared/types";
import { parseAssetSource } from "../../shared/assets";
import { TemporaryAssets } from "../local-store/TemporaryAssets";
import {
  AGENT_IMAGE_LIMITS,
  AgentImageFitting,
  fitPromptImages,
  type FitPromptImage,
  type PromptImageBytes,
} from "./AgentImageFitting";
import { agentRuntimeError } from "./AgentRuntimeError";
import type { AgentRuntimeError } from "./AgentRuntimeError";

const MAX_IMAGE_BYTES = AGENT_IMAGE_LIMITS.imageBytes;
const MAX_SOURCE_BYTES = AGENT_IMAGE_LIMITS.sourceBytes;

const types = new Map<string, AgentPromptImage["mediaType"]>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

export const isNativePromptImageType = (mimeType: string): boolean =>
  [...types.values()].some((type) => type === mimeType);

const toPromptImage = ({ mediaType, bytes }: PromptImageBytes): AgentPromptImage => ({
  mediaType,
  data: Buffer.from(bytes).toString("base64"),
});

/**
 * Materialize only the images explicitly attached by a trusted renderer, with no network
 * fetches, fitted to what an Agent takes with one message.
 */
export async function prepareNativePromptImages(
  images: readonly CodexPromptImageInput[],
  readManaged: (source: string) => { readonly mimeType: string; readonly bytes: Uint8Array },
  fit: FitPromptImage,
): Promise<readonly AgentPromptImage[]> {
  if (images.length > AGENT_IMAGE_LIMITS.count) throw new Error("Attach at most 20 images");
  const prepared: PromptImageBytes[] = [];
  for (const { source } of images) {
    let bytes: Uint8Array;
    let mediaType: AgentPromptImage["mediaType"] | undefined;
    if (parseAssetSource(source)) {
      const asset = readManaged(source);
      bytes = asset.bytes;
      mediaType = [...types.values()].find((type) => type === asset.mimeType);
    } else if (source.startsWith("data:")) {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(source);
      if (!match || source.length > MAX_SOURCE_BYTES * 1.4)
        throw new Error("Attach a valid PNG, JPEG, GIF or WebP image");
      mediaType = match[1] as AgentPromptImage["mediaType"];
      bytes = Buffer.from(match[2]!, "base64");
    } else {
      const filePath = source.startsWith("file:") ? fileURLToPath(source) : source;
      if (!path.isAbsolute(filePath)) throw new Error("Attach a local image file");
      mediaType = types.get(path.extname(filePath).toLowerCase());
      const file = await open(filePath, "r");
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES)
          throw new Error("Each image must be at most 64 MB");
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
    }
    if (!mediaType || !bytes.byteLength || bytes.byteLength > MAX_SOURCE_BYTES)
      throw new Error("Attach a supported image of at most 64 MB");
    prepared.push({ mediaType, bytes });
  }
  return (await fitPromptImages(prepared, fit)).map(toPromptImage);
}

export class NativePromptImages extends Context.Service<
  NativePromptImages,
  {
    readonly prepare: (
      images: readonly CodexPromptImageInput[],
    ) => Effect.Effect<readonly AgentPromptImage[], AgentRuntimeError>;
    /** Proves that the native codec can decode an image with positive dimensions. */
    readonly validate: (image: PromptImageBytes) => Effect.Effect<void, AgentRuntimeError>;
    /** Fits images already read to what an Agent takes with one message. */
    readonly fit: (
      images: readonly PromptImageBytes[],
    ) => Effect.Effect<readonly AgentPromptImage[], AgentRuntimeError>;
    readonly materialize: (image: AgentPromptImage) => Effect.Effect<string, AgentRuntimeError>;
  }
>()("nodex/main/agent-backend/NativePromptImages") {}

export const layer = Layer.effect(
  NativePromptImages,
  Effect.gen(function* () {
    const assets = yield* TemporaryAssets;
    const { fit } = yield* AgentImageFitting;
    const failure = (cause: unknown) =>
      agentRuntimeError({
        operation: "Claude image input",
        reason: "request",
        retryable: true,
        cause,
      });
    return NativePromptImages.of({
      materialize: (image) =>
        Effect.tryPromise({
          try: async () => {
            if (image.data.length > MAX_IMAGE_BYTES * 1.4)
              throw new Error("The native image exceeds its size limit");
            const bytes = Buffer.from(image.data, "base64");
            if (
              !bytes.byteLength ||
              bytes.byteLength > MAX_IMAGE_BYTES ||
              ![...types.values()].includes(image.mediaType)
            )
              throw new Error("The native image is invalid");
            const result = await assets.saveUploadedImage({
              name: `claude-image${[...types].find(([, type]) => type === image.mediaType)?.[0] ?? ".png"}`,
              mimeType: image.mediaType,
              bytes,
            });
            return result.source;
          },
          catch: (cause) =>
            agentRuntimeError({
              operation: "Claude history image",
              reason: "request",
              retryable: false,
              cause,
            }),
        }),
      prepare: (images) =>
        Effect.tryPromise({
          try: () => prepareNativePromptImages(images, assets.readManagedAssetImage, fit),
          catch: failure,
        }),
      validate: (image) =>
        Effect.tryPromise({
          try: () => fit(image, MAX_SOURCE_BYTES),
          catch: failure,
        }).pipe(Effect.asVoid),
      fit: (images) =>
        Effect.tryPromise({
          try: async () => (await fitPromptImages(images, fit)).map(toPromptImage),
          catch: failure,
        }),
    });
  }),
);
