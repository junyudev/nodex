import { cleanCodexAutoTitlePrompt, projectCodexMarkdownToPlainText } from "./codex-thread-title";
import { agentMessageDisplayText } from "./agent-prompt";

export const SIDE_CHAT_DEFAULT_TITLE = "Side chat";

/** The first request names a side chat; display truncation belongs to the view. */
export function sideChatRequestTitle(text: string): string | null {
  const displayText = agentMessageDisplayText(text);
  const contextStart = "<page-comment-context>\n";
  const contextEnd = "\n</page-comment-context>\n## My request:\n";
  const contextEndIndex = displayText.startsWith(contextStart)
    ? displayText.indexOf(contextEnd, contextStart.length)
    : -1;
  const request =
    contextEndIndex >= 0
      ? displayText.slice(contextEndIndex + contextEnd.length)
      : cleanCodexAutoTitlePrompt(displayText, Number.MAX_SAFE_INTEGER);
  return projectCodexMarkdownToPlainText(request).replace(/\s+/gu, " ").trim() || null;
}
