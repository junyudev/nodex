import type {
  OrchestrationV2ToolResultImage,
  OrchestrationV2TurnItem,
} from "@nodex/runtime-contracts";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  boundedToolOutputImage,
} from "@nodex/runtime-shared/toolOutput";
import * as Predicate from "effect/Predicate";
import {
  isToolResultAudioBase64,
  parseToolResultAudioDataUrl,
  toolResultAudioMimeType,
} from "../toolResultAudio.ts";

type DynamicTool = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

const ATTACHMENT_ID = /^tool-result:(0|[1-9]\d*)$/u;
const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,/iu;

/** The output's typed blocks, by their original positions. */
export function toolResultOutputBlocks(output: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(output)) return output;
  if (Predicate.isObject(output) && Array.isArray(output.content)) return output.content;
  return [output];
}

/** The result's blocks, by the position a media attachment id names. */
function resultBlocks(item: DynamicTool): ReadonlyArray<unknown> {
  if (item.mcpToolCall?.result) return item.mcpToolCall.result.content;
  return toolResultOutputBlocks(item.output);
}

type ServedMedia = { readonly mimeType: string; readonly dataUrl: () => string };

export function isInlineToolResultAudio(block: unknown): block is Record<PropertyKey, unknown> & {
  readonly type: "audio" | "inputAudio";
} {
  if (!Predicate.isObject(block)) return false;
  return (
    block.type === "audio" ||
    (block.type === "inputAudio" &&
      (typeof block.audioUrl !== "string" || /^data:/iu.test(block.audioUrl)))
  );
}

export function servedToolResultAudio(block: unknown): ServedMedia | null {
  if (!isInlineToolResultAudio(block)) return null;
  if (block.type === "inputAudio") {
    if (typeof block.audioUrl !== "string") return null;
    const audio = parseToolResultAudioDataUrl(block.audioUrl);
    return (
      audio && {
        mimeType: audio.mimeType,
        dataUrl: () => `data:${audio.mimeType};base64,${audio.base64}`,
      }
    );
  }
  const { data } = block;
  const mimeType = toolResultAudioMimeType(block.mimeType);
  return mimeType && isToolResultAudioBase64(data)
    ? { mimeType, dataUrl: () => `data:${mimeType};base64,${data}` }
    : null;
}

/**
 * A picture block whose bytes the item still holds and an attachment read serves: a data URL, or a
 * base64 image block, either within the size an image asset may have.
 */
function servedPicture(item: DynamicTool, block: unknown): ServedMedia | null {
  if (
    !item.mcpToolCall?.result &&
    item.viewedImagePath &&
    item.attachments?.some((attachment) => attachment.type === "image")
  )
    return null;
  if (Predicate.isObject(block) && block.type === "inputImage") {
    const url = typeof block.imageUrl === "string" ? block.imageUrl : "";
    const type = IMAGE_DATA_URL.exec(url)?.[1];
    if (!type || url.length - url.indexOf(",") - 1 > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH)
      return null;
    return { mimeType: type.toLowerCase(), dataUrl: () => url };
  }
  const image = boundedToolOutputImage(block);
  return (
    image && {
      mimeType: image.mimeType,
      dataUrl: () => `data:${image.mimeType};base64,${image.data}`,
    }
  );
}

/** The media a tool returned at `tool-result:<index>`, as a data URL to serve. */
export function toolResultMediaDataUrl(item: DynamicTool, attachmentId: string): string | null {
  const index = ATTACHMENT_ID.exec(attachmentId)?.[1];
  if (index === undefined || !Number.isSafeInteger(Number(index))) return null;
  const block = resultBlocks(item)[Number(index)];
  return (servedToolResultAudio(block) ?? servedPicture(item, block))?.dataUrl() ?? null;
}

/** Every picture a tool returned that an attachment read serves, in result order. */
export function toolResultImages(item: DynamicTool): ReadonlyArray<OrchestrationV2ToolResultImage> {
  return resultBlocks(item).flatMap((block, index) => {
    const picture = servedPicture(item, block);
    return picture ? [{ attachmentId: `tool-result:${index}`, mimeType: picture.mimeType }] : [];
  });
}

/**
 * The item as a read gives it: a tool's result pictures listed by id, so a reader that never sees
 * the output can still name them. Nothing is stored with the list.
 */
export function withToolResultImages<Item extends OrchestrationV2TurnItem>(item: Item): Item {
  if (item.type !== "dynamic_tool") return item;
  const resultImages = toolResultImages(item);
  return resultImages.length === 0 ? item : ({ ...item, resultImages } as Item);
}
