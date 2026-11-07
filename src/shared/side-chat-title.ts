import { cleanCodexAutoTitlePrompt, projectCodexMarkdownToPlainText } from "./codex-thread-title";

export const SIDE_CHAT_DEFAULT_TITLE = "Side chat";

/** The first request names a side chat; display truncation belongs to the view. */
export function sideChatRequestTitle(text: string): string | null {
  const contextStart = "<page-comment-context>\n";
  const contextEnd = "\n</page-comment-context>\n## My request:\n";
  const contextEndIndex = text.startsWith(contextStart)
    ? text.indexOf(contextEnd, contextStart.length)
    : -1;
  const request =
    contextEndIndex >= 0
      ? text.slice(contextEndIndex + contextEnd.length)
      : cleanCodexAutoTitlePrompt(text, Number.MAX_SAFE_INTEGER);
  return projectCodexMarkdownToPlainText(request).replace(/\s+/gu, " ").trim() || null;
}
