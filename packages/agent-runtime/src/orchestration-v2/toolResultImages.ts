import type {
  OrchestrationV2ToolResultImage,
  OrchestrationV2TurnItem,
} from "@nodex/runtime-contracts";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  readToolOutputImage,
} from "@nodex/runtime-shared/toolOutput";
import * as Predicate from "effect/Predicate";

type DynamicTool = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;

const ATTACHMENT_ID = /^tool-result:(0|[1-9]\d*)$/u;
const DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,/iu;

/** The result's blocks, by the position a picture's attachment id names. */
const resultBlocks = (item: DynamicTool): ReadonlyArray<unknown> =>
  item.mcpToolCall?.result?.content ?? (Array.isArray(item.output) ? item.output : []);

/**
 * A picture block whose bytes the item still holds and an attachment read serves: a data URL, or a
 * base64 image block, either within the size an image asset may have.
 */
function servedPicture(
  block: unknown,
): { readonly mimeType: string; readonly dataUrl: () => string } | null {
  if (Predicate.isObject(block) && block.type === "inputImage") {
    const url = typeof block.imageUrl === "string" ? block.imageUrl : "";
    const type = DATA_URL.exec(url)?.[1];
    if (!type || url.length - url.indexOf(",") - 1 > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH)
      return null;
    return { mimeType: type.toLowerCase(), dataUrl: () => url };
  }
  const image = readToolOutputImage(block);
  const data = image?.data;
  if (!image || !data || data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH) return null;
  return { mimeType: image.mimeType, dataUrl: () => `data:${image.mimeType};base64,${data}` };
}

/** The picture a tool returned at `tool-result:<index>`, as a data URL to serve. */
export function toolResultPicture(item: DynamicTool, attachmentId: string): string | null {
  const index = ATTACHMENT_ID.exec(attachmentId)?.[1];
  if (index === undefined || !Number.isSafeInteger(Number(index))) return null;
  return servedPicture(resultBlocks(item)[Number(index)])?.dataUrl() ?? null;
}

/** Every picture a tool returned that an attachment read serves, in result order. */
export function toolResultImages(item: DynamicTool): ReadonlyArray<OrchestrationV2ToolResultImage> {
  return resultBlocks(item).flatMap((block, index) => {
    const picture = servedPicture(block);
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
