import type { ThreadItem, ThreadTimelineListResponse } from "@nodex/codex-app-server-protocol/v2";
import { timelineOwnerFixture } from "./normalized-timeline.test-fixtures";

export function nativeGeneratedImage(
  id = "image",
  status = "in_progress",
  src = "",
): Extract<ThreadItem, { type: "imageGeneration" }> {
  return { type: "imageGeneration", id, status, revisedPrompt: null, result: src, failure: null };
}

export function imageReceipt(
  id: string,
  itemId: string,
  position: number,
): ThreadTimelineListResponse["data"][number] {
  return {
    type: "realtime",
    position,
    item: {
      type: "bemItemPromoted",
      id,
      realtimeSessionId: "session",
      turnId: "one",
      itemId,
      presentation: { type: "wholeItem" },
    },
  };
}

export function nativeImageTimelineFixture(
  image = nativeGeneratedImage(),
  receiptIds = ["first", "second"],
) {
  return timelineOwnerFixture(
    {
      data: [
        { type: "item", position: 0, turnId: "one", item: image },
        ...receiptIds.map((id, index) => imageReceipt(id, image.id, index + 1)),
      ],
      nextCursor: null,
      activeRealtimeSessionAtPageStart: null,
    },
    [image],
  );
}
