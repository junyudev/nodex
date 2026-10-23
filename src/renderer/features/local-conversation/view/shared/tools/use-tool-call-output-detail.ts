import { useEffect, useState } from "react";
import type { CodexTranscriptEntry } from "../../../../../lib/types";
import { useConversationRuntimeOverride } from "../../../conversation-runtime";

/** An open output follows new completion evidence; closed or superseded reads cannot publish errors. */
export function useToolCallOutputDetail(
  item: CodexTranscriptEntry,
  expanded: boolean,
  outputOmitted: boolean | undefined,
) {
  const runtime = useConversationRuntimeOverride();
  const [error, setError] = useState<string | null>(null);
  const itemId = item.rawItemId ?? item.itemId;
  const threadId = item.threadId;
  const needsDetail = expanded && outputOmitted === true;
  useEffect(() => {
    if (!needsDetail || !runtime?.readItemDetail) return;
    let current = true;
    setError(null);
    void runtime.readItemDetail(threadId, itemId).catch(() => {
      if (current) setError("Unable to load tool output");
    });
    return () => {
      current = false;
    };
  }, [needsDetail, runtime, threadId, itemId]);
  return { error: needsDetail ? error : null, available: Boolean(runtime?.readItemDetail) };
}
