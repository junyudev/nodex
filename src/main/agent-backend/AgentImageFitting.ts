import * as Context from "effect/Context";
import type { AgentPromptImage } from "../../shared/agent-conversation";

/** What an Agent takes with one message: each image, all of them together, and their count. */
export const AGENT_IMAGE_LIMITS = {
  imageBytes: 5 * 1024 * 1024,
  totalBytes: 20 * 1024 * 1024,
  count: 20,
  /** The largest image read for fitting at all. */
  sourceBytes: 64 * 1024 * 1024,
} as const;

export interface PromptImageBytes {
  readonly mediaType: AgentPromptImage["mediaType"];
  readonly bytes: Uint8Array;
}

/** Decodes one image and re-encodes it only when needed to fit its byte budget. */
export type FitPromptImage = (
  image: PromptImageBytes,
  budgetBytes: number,
) => Promise<PromptImageBytes>;

/** The image codec that fits images for Agents; Electron supplies it in the app. */
export class AgentImageFitting extends Context.Service<
  AgentImageFitting,
  { readonly fit: FitPromptImage }
>()("nodex/main/agent-backend/AgentImageFitting") {}

/**
 * Sends every image an Agent can take instead of failing or dropping the large ones: each gets
 * an equal share of what one message may carry, and only an image over its share is fitted.
 */
export async function fitPromptImages(
  images: readonly PromptImageBytes[],
  fit: FitPromptImage,
): Promise<readonly PromptImageBytes[]> {
  if (images.length > AGENT_IMAGE_LIMITS.count) throw new Error("Attach at most 20 images");
  const budget = Math.min(
    AGENT_IMAGE_LIMITS.imageBytes,
    Math.floor(AGENT_IMAGE_LIMITS.totalBytes / Math.max(1, images.length)),
  );
  const fitted: PromptImageBytes[] = [];
  for (const image of images) {
    if (image.bytes.byteLength <= budget) {
      fitted.push(image);
      continue;
    }
    const smaller = await fit(image, budget);
    if (smaller.bytes.byteLength > budget)
      throw new Error("An image is too large to send to the Agent");
    fitted.push(smaller);
  }
  return fitted;
}

/** The decoded image an encoder works on; Electron's `NativeImage` has this shape. */
export interface EncodableImage {
  isEmpty(): boolean;
  getSize(): { readonly width: number; readonly height: number };
  resize(options: { width: number; height: number; quality: "best" }): EncodableImage;
  toPNG(): Uint8Array;
  toJPEG(quality: number): Uint8Array;
}

/** Longest edges tried in turn: what Agents read at full detail, then progressively less. */
const FITTED_EDGES = [2048, 1568, 1024, 768] as const;
const JPEG_QUALITIES = [85, 70] as const;

/**
 * Fits an image by stepping its longest edge down, keeping PNG while that fits, so screenshots
 * stay sharp, and otherwise writing JPEG.
 */
export const fitWithImageCodec =
  (decode: (bytes: Uint8Array) => EncodableImage): FitPromptImage =>
  async (image, budgetBytes) => {
    const source = decode(image.bytes);
    if (source.isEmpty()) throw new Error("An image could not be read to send to the Agent");
    const { width, height } = source.getSize();
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
      throw new Error("An image could not be read to send to the Agent");
    if (image.bytes.byteLength <= budgetBytes) return image;
    const longest = Math.max(width, height);
    for (const edge of FITTED_EDGES) {
      const scale = Math.min(1, edge / longest);
      const sized =
        scale < 1
          ? source.resize({
              width: Math.max(1, Math.round(width * scale)),
              height: Math.max(1, Math.round(height * scale)),
              quality: "best",
            })
          : source;
      const png = sized.toPNG();
      if (png.byteLength <= budgetBytes) return { mediaType: "image/png", bytes: png };
      for (const quality of JPEG_QUALITIES) {
        const jpeg = sized.toJPEG(quality);
        if (jpeg.byteLength <= budgetBytes) return { mediaType: "image/jpeg", bytes: jpeg };
      }
    }
    throw new Error("An image is too large to send to the Agent");
  };
