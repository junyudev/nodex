import type { ThreadId, TurnItemId } from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { ServerConfig } from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { toolResultPicture } from "../orchestration-v2/toolResultImages.ts";

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
            (entry) =>
              (entry.type === "image" || entry.type === "file") && entry.id === input.attachmentId,
          )
        : undefined;
    if (attachment?.type === "image" || attachment?.type === "file") {
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      return path !== null && (yield* fs.exists(path)) ? { path, attachment } : null;
    }
    if (item.type === "dynamic_tool") {
      const dataUrl = toolResultPicture(item, input.attachmentId);
      return dataUrl === null ? null : { dataUrl };
    }
    return null;
  });
});
