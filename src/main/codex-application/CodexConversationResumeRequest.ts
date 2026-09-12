import * as Effect from "effect/Effect";
import type { ClientRequestParamsByMethod } from "@nodex/effect-codex-app-server/rpc";
import type { CodexGateway, CodexGatewayRequestOptions } from "../codex-runtime/CodexGateway";
import {
  INITIAL_CONVERSATION_RESUME_RETRY,
  conversationResumeTimeoutMs,
  nextConversationResumeRetry,
} from "../../shared/codex-conversation-resume-retry";
import { encodeCodexNativeRequestFailure } from "../../shared/codex-native-request-outcome";

/** The caller's Scope owns native attempts and all retry waits. */
export const requestMainConversationResume = Effect.fn("CodexConversationResumeRequest.send")(
  function* (
    gateway: Pick<CodexGateway["Service"], "requestOnHost">,
    hostId: string,
    params: ClientRequestParamsByMethod["thread/resume"],
    options: CodexGatewayRequestOptions = {},
  ) {
    let retry = INITIAL_CONVERSATION_RESUME_RETRY;
    for (;;) {
      const result = yield* gateway
        .requestOnHost(hostId, "thread/resume", params, {
          ...options,
          timeoutMs: conversationResumeTimeoutMs(retry, options.timeoutMs),
        })
        .pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      const message =
        result.failure.reason === "timeout"
          ? "Timeout"
          : encodeCodexNativeRequestFailure(result.failure).message;
      const next = nextConversationResumeRetry(retry, params.threadId, message, options.timeoutMs);
      if (!next) return yield* Effect.fail(result.failure);
      retry = next.state;
      yield* Effect.sleep(next.delayMs);
    }
  },
);
