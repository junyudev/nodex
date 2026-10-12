import {
  isAppContextJsonObject,
  type CodexUntrustedAppMessage,
} from "../../../shared/codex-untrusted-app-input";
import type { InlineVisualizationFollowUpMessage } from "./inline-visualization-follow-up-context";
import type { InlineVisualizationAnnotationSubmitHandler } from "./inline-visualization-follow-up-context";
import type { CodexPromptInput } from "../../../shared/types";

/** Only the host controls UI uses this attachment path; guest follow-ups retain their review and gesture policy. */
export function captureInlineVisualizationAnnotationInput(
  message: Parameters<InlineVisualizationAnnotationSubmitHandler>[0],
): CodexPromptInput {
  if (message.context === undefined) return { text: message.prompt };
  if (!isAppContextJsonObject(message.context))
    throw new Error("Invalid visualization annotation context");
  return {
    text: message.prompt,
    mcpAppModelContextAttachments: [
      {
        id: message.sourceId,
        kind: "context",
        sourceName: message.title,
        text: null,
        structuredContent: structuredClone(message.context),
        imageAttachments: [],
        untrusted: true,
      },
    ],
  };
}

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
