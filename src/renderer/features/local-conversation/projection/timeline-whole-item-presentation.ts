import type { ThreadRealtimeBemItemPresentation } from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalItem } from "../../../../shared/types";

/** A local presentation descriptor over the existing native wholeItem receipt. */
export type TimelineWholeItemPresentation = {
  readonly type: "generatedImage";
  readonly itemId: string;
};

export function resolveTimelineWholeItemPresentation(
  item: Pick<CodexCanonicalItem, "id" | "type"> | null,
  presentation: ThreadRealtimeBemItemPresentation | undefined,
): TimelineWholeItemPresentation | null {
  if (presentation?.type !== "wholeItem" || item?.type !== "imageGeneration") return null;
  return { type: "generatedImage", itemId: item.id };
}
