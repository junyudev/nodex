import { useEffect, useState } from "react";
import type { InboxReplyDestination } from "../../../shared/inbox";
import { readInboxReplyDestination } from "@/lib/inbox-runtime";
import { useDebouncedValue } from "@/lib/use-debounced-value";

const SETTLE_MS = 250;

/**
 * The Host previews the same reply decision it revalidates at capture. Typing waits for the
 * text to settle, and the last destination for the same post stays shown meanwhile, since only
 * an answer's wording can change it.
 */
export function useInboxReplyDestination(pageId: string | undefined, body: string) {
  const settledBody = useDebouncedValue(body, SETTLE_MS);
  const [resolved, setResolved] = useState<{
    pageId: string;
    destination: InboxReplyDestination;
  } | null>(null);
  useEffect(() => {
    if (!pageId) return;
    let current = true;
    void readInboxReplyDestination(pageId, settledBody).then(
      (destination) => {
        if (current) setResolved({ pageId, destination });
      },
      () => {
        if (current) setResolved({ pageId, destination: { kind: "nodex", chat: null } });
      },
    );
    return () => {
      current = false;
    };
  }, [pageId, settledBody]);
  return resolved && resolved.pageId === pageId ? resolved.destination : null;
}
