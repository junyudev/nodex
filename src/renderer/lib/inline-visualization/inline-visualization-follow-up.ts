import type { McpAppFollowUpMessage } from "../mcp-app/mcp-app-follow-up";
import type { InlineVisualizationFollowUpHandler } from "./inline-visualization-follow-up-context";

/** Only a native gesture or an explicitly reviewed prompt can authorize a document follow-up. */
export async function sendInlineVisualizationFollowUp(input: {
  readonly message: McpAppFollowUpMessage;
  readonly sourceId: string;
  readonly signal: AbortSignal;
  readonly consumeGesture: () => Promise<boolean>;
  readonly review: (message: McpAppFollowUpMessage, signal: AbortSignal) => Promise<string | null>;
  readonly send: InlineVisualizationFollowUpHandler;
}): Promise<void> {
  if (input.signal.aborted) return;
  const granted = await input.consumeGesture();
  if (input.signal.aborted) return;
  const prompt = granted ? input.message.prompt : await input.review(input.message, input.signal);
  if (!prompt || input.signal.aborted) return;
  await input.send({
    sourceId: input.sourceId,
    prompt,
    ...(granted && input.message.context !== undefined ? { context: input.message.context } : {}),
  });
}
