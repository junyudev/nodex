import type { CodexCanonicalConversationMetadata } from "../../../shared/codex-conversation-state/codex-conversation-state";

/** Read the Thread's execution provenance when submitting, without subscribing its body to metadata. */
export function readCodexFollowUpDeliveryPolicy(
  source: Pick<CodexCanonicalConversationMetadata, "threadStartKind" | "threadSource">,
): "queue" | "send-now" {
  return source.threadStartKind === "aeon" || source.threadSource === "aeon" ? "send-now" : "queue";
}
