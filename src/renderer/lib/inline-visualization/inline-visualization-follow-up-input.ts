import {
  isAppContextJsonObject,
  type CodexUntrustedAppMessage,
} from "../../../shared/codex-untrusted-app-input";
import type { InlineVisualizationFollowUpMessage } from "./inline-visualization-follow-up-context";

export function captureInlineVisualizationFollowUp(
  message: InlineVisualizationFollowUpMessage,
): CodexUntrustedAppMessage {
  const { context } = message;
  if (context === undefined)
    return { source: "visualization", sourceId: message.sourceId, text: message.prompt };
  if (!isAppContextJsonObject(context)) throw new Error("Invalid visualization message context");
  return {
    source: "visualization",
    sourceId: message.sourceId,
    text: message.prompt,
    structuredContent: structuredClone(context),
  };
}
