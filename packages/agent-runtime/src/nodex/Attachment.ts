import type { ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
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
    if (!item || (item.type !== "user_message" && item.type !== "assistant_message")) return null;
    const image = item.attachments?.find(
      (attachment) => attachment.type === "image" && attachment.id === input.attachmentId,
    );
    if (!image || image.type !== "image") return null;
    const path = resolveAttachmentPath({
      attachmentsDir: config.attachmentsDir,
      attachment: image,
    });
    if (path === null || !(yield* fs.exists(path))) return null;
    return { path };
  });
});
