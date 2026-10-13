import type {
  ThreadItem,
  ThreadRealtimeBemItemPresentation,
} from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalItem } from "../../../../shared/types";
import { readNativeCreatedThreadResult } from "../../../../shared/codex-created-thread-result";

/** A local presentation descriptor over the existing native wholeItem receipt. */
export type TimelineWholeItemPresentation =
  | {
      readonly type: "generatedImage";
      readonly itemId: string;
    }
  | { readonly type: "createdThreads"; readonly itemId: string; readonly resultCount?: number }
  | { readonly type: "subagentActivity"; readonly itemId: string; readonly agentThreadId: string };

export function resolveTimelineWholeItemPresentation(
  item: CodexCanonicalItem | ThreadItem | null,
  presentation: ThreadRealtimeBemItemPresentation | undefined,
): TimelineWholeItemPresentation | null {
  if (presentation?.type !== "wholeItem" || !item) return null;
  if (item.type === "imageGeneration") return { type: "generatedImage", itemId: item.id };
  const created = readNativeCreatedThreadResult(item);
  if (created && created.kind !== "chatgpt") return { type: "createdThreads", itemId: item.id };
  if (item.type === "subAgentActivity" && item.kind === "started")
    return { type: "subagentActivity", itemId: item.id, agentThreadId: item.agentThreadId };
  return null;
}
