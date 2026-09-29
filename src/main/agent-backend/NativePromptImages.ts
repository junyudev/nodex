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
import { agentRuntimeError } from "./AgentRuntimeError";
import type { AgentRuntimeError } from "./AgentRuntimeError";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const types = new Map<string, AgentPromptImage["mediaType"]>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

/** Materialize only the images explicitly attached by a trusted renderer. No network fetches. */
export async function prepareNativePromptImages(
  images: readonly CodexPromptImageInput[],
  readManaged: (source: string) => { readonly mimeType: string; readonly bytes: Uint8Array },
): Promise<readonly AgentPromptImage[]> {
  if (images.length > 20) throw new Error("Attach at most 20 images");
  let total = 0;
  const prepared: AgentPromptImage[] = [];
  for (const { source } of images) {
    let bytes: Uint8Array;
    let mediaType: AgentPromptImage["mediaType"] | undefined;
    if (parseAssetSource(source)) {
      const asset = readManaged(source);
      bytes = asset.bytes;
      mediaType = [...types.values()].find((type) => type === asset.mimeType);
    } else if (source.startsWith("data:")) {
      const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(source);
      if (!match || source.length > MAX_IMAGE_BYTES * 1.4)
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
        if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
          throw new Error("Each image must be at most 5 MB");
        bytes = await file.readFile();
      } finally {
        await file.close();
      }
    }
    total += bytes.byteLength;
    if (
      !mediaType ||
      !bytes.byteLength ||
      bytes.byteLength > MAX_IMAGE_BYTES ||
      total > MAX_TOTAL_BYTES
    )
      throw new Error("Attach supported images totaling at most 20 MB");
    prepared.push({ mediaType, data: Buffer.from(bytes).toString("base64") });
  }
  return prepared;
}

export class NativePromptImages extends Context.Service<
  NativePromptImages,
  {
    readonly prepare: (
      images: readonly CodexPromptImageInput[],
    ) => Effect.Effect<readonly AgentPromptImage[], AgentRuntimeError>;
    readonly materialize: (image: AgentPromptImage) => Effect.Effect<string, AgentRuntimeError>;
  }
>()("nodex/main/agent-backend/NativePromptImages") {}

export const layer = Layer.effect(
  NativePromptImages,
  Effect.gen(function* () {
    const assets = yield* TemporaryAssets;
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
          try: () => prepareNativePromptImages(images, assets.readManagedAssetImage),
          catch: (cause) =>
            agentRuntimeError({
              operation: "Claude image input",
              reason: "request",
              retryable: true,
              cause,
            }),
        }),
    });
  }),
);
