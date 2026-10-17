import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import { isNativeCodexThreadId } from "../../../../shared/agent-runtime-api";
import type { CodexConversationResumeState } from "../../../../shared/types";
import type { LocalConversationAttachmentState } from "../conversation-attachment-state";
import { subscribeCodexAppServerMessage } from "../app-server-message-bus";
import { subscribeCodexEvents } from "../local-conversation-deps";
import { useCodexAppServerRegistry } from "../local-conversation-store";
import type { InlineVisualizationFrameOwner } from "../../../lib/inline-visualization/inline-visualization-frame-owner";
import { useInlineVisualizationFrameOwner } from "./inline-visualization-window";

/** Only accepted Thread lifecycle metadata participates in retained guest eviction. */
export function InlineVisualizationWindowLifecycle() {
  const owner = useInlineVisualizationFrameOwner();
  if (!owner) return null;
  return <Lifecycle owner={owner} />;
}

function Lifecycle({ owner }: { readonly owner: InlineVisualizationFrameOwner }) {
  const ids = useSyncExternalStore(owner.subscribe, owner.readIds, owner.readIds);
  useEffect(
    () =>
      subscribeCodexEvents((event) => {
        if (event.type !== "threadDeleted") return;
        owner.releaseThread(event.hostId, event.threadId);
      }),
    [owner],
  );
  useEffect(
    () =>
      subscribeCodexAppServerMessage("thread-deleted", ({ hostId, threadId }) =>
        owner.releaseThread(hostId, threadId),
      ),
    [owner],
  );
  const threads = new Map<string, { hostId: string; threadId: string }>();
  for (const id of ids) {
    const identity = owner.readFrame(id)?.identity;
    if (!identity) continue;
    threads.set(JSON.stringify([identity.hostId, identity.threadId]), identity);
  }
  return [...threads].map(([key, { hostId, threadId }]) => (
    <ThreadLifetime key={key} owner={owner} hostId={hostId} threadId={threadId} />
  ));
}

function ThreadLifetime({
  owner,
  hostId,
  threadId,
}: {
  readonly owner: InlineVisualizationFrameOwner;
  readonly hostId: string;
  readonly threadId: string;
}) {
  const registry = useCodexAppServerRegistry();
  const manager = registry.getForHostId(hostId);
  // Agent execution keeps an Agent chat's history itself; it never needs a native resume.
  const native = isNativeCodexThreadId(threadId);
  const current = useSyncExternalStore(
    (listener) => {
      if (!native) return () => {};
      const stopConversation = manager.addConversationCallback(threadId, listener);
      const stopAttachment = manager.subscribeConversationAttachment(threadId, listener);
      return () => {
        stopConversation();
        stopAttachment();
      };
    },
    () =>
      !native ||
      isNativeHistoryCurrent(
        manager.readConversation(threadId)?.resumeState ?? null,
        manager.readConversationAttachmentState(threadId),
      ),
  );
  useLayoutEffect(() => {
    owner.reportHistory(hostId, threadId, current);
  }, [owner, hostId, threadId, current]);
  return null;
}

/**
 * A native Thread's loaded history is current while it is resumed, or while read-only history
 * stays attached without a resume. A reconnect detaches it and asks for a resume.
 */
export function isNativeHistoryCurrent(
  resumeState: CodexConversationResumeState | null,
  attachment: LocalConversationAttachmentState,
): boolean {
  if (resumeState === "resumed") return true;
  return resumeState === "needs_resume" && attachment.status === "attached";
}
