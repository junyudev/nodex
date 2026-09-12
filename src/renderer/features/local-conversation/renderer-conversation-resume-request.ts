import type { ThreadResumeResponse } from "@nodex/codex-app-server-protocol/v2/ThreadResumeResponse";
import {
  INITIAL_CONVERSATION_RESUME_RETRY,
  conversationResumeTimeoutMs,
  nextConversationResumeRetry,
} from "../../../shared/codex-conversation-resume-retry";
import { encodeCodexNativeRequestFailure } from "../../../shared/codex-native-request-outcome";
import type { CodexRendererResumePreparation } from "../../../shared/codex-renderer-resume";
import type { RendererNativeAppServer } from "./renderer-native-app-server";
import { runConversationOperation } from "./local-conversation-deps";

export interface ConversationResumeRequestLifetime {
  isCurrent(): boolean;
  setRetryCleanup(cleanup: () => void): void;
}

/** One preparation survives retries; each physical dispatch has a fresh request identity. */
export async function requestRendererConversationResume(
  native: RendererNativeAppServer,
  prepared: Pick<CodexRendererResumePreparation, "receiptId" | "nativeRequestId" | "params">,
  lifetime: ConversationResumeRequestLifetime,
  timeoutMs?: number,
  priority: "interactive" | "critical" = "critical",
): Promise<ThreadResumeResponse | null> {
  let retry = INITIAL_CONVERSATION_RESUME_RETRY;
  let requestId = prepared.nativeRequestId;
  let renew = false;
  while (lifetime.isCurrent()) {
    if (renew) {
      requestId = await runConversationOperation("codex:thread:resume:retry", prepared.receiptId);
      if (!lifetime.isCurrent()) return null;
    }
    try {
      return await native.request("thread/resume", prepared.params, {
        requestId,
        timeoutMs: conversationResumeTimeoutMs(retry, timeoutMs),
        source: "thread_hydration",
        priority,
      });
    } catch (error) {
      const next = nextConversationResumeRetry(
        retry,
        prepared.params.threadId,
        encodeCodexNativeRequestFailure(error).message,
        timeoutMs,
      );
      if (!next) throw error;
      if (!lifetime.isCurrent()) return null;
      retry = next.state;
      renew = true;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, next.delayMs);
        lifetime.setRetryCleanup(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
  return null;
}
