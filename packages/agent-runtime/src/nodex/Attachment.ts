import type { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  readToolOutputImage,
} from "@t3tools/shared/toolOutput";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";

/** Resolve one image from the target's visible native history or captured fork prefix. */
export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStoreV2;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  return Effect.fn("AgentRuntime.readThreadAttachment")(function* (input: {
    readonly threadId: ThreadId;
    readonly sourceThreadId?: ThreadId;
    readonly itemId: TurnItemId;
    readonly attachmentId: string;
  }) {
    const item = yield* projections.getVisibleTurnItem({
      threadId: input.threadId,
      itemId: input.itemId,
      ...(input.sourceThreadId === undefined ? {} : { sourceThreadId: input.sourceThreadId }),
    });
    if (!item) return null;
    const attachment =
      item.type === "user_message" ||
      item.type === "assistant_message" ||
      item.type === "dynamic_tool"
        ? item.attachments?.find(
            (entry) => entry.type === "image" && entry.id === input.attachmentId,
          )
        : undefined;
    if (attachment?.type === "image") {
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      return path !== null && (yield* fs.exists(path)) ? { path } : null;
    }
    if (item.type === "dynamic_tool") {
      const match = /^tool-result:(0|[1-9]\d*)$/.exec(input.attachmentId);
      if (!match) return null;
      const index = Number(match[1]);
      if (!Number.isSafeInteger(index)) return null;
      const content =
        item.mcpToolCall?.result?.content ?? (Array.isArray(item.output) ? item.output : []);
      const block = content[index];
      if (
        block !== null &&
        typeof block === "object" &&
        !Array.isArray(block) &&
        block.type === "inputImage" &&
        typeof block.imageUrl === "string"
      ) {
        const dataUrl = block.imageUrl;
        const comma = dataUrl.indexOf(",");
        if (
          comma < 0 ||
          !/^data:image\/(?:png|jpeg|gif|webp);base64,/iu.test(dataUrl) ||
          dataUrl.length - comma - 1 > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH
        )
          return null;
        return { dataUrl };
      }
      const image = readToolOutputImage(block);
      if (!image?.data || image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH) return null;
      return { dataUrl: `data:${image.mimeType};base64,${image.data}` };
    }
    return null;
  });
});
