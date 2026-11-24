import { CHAT_REPLY_PREVIEW_LIMIT } from "./chat-reply-preview";
import { projectCodexMarkdownToPlainText } from "./codex-markdown-text";

// Reading Markdown needs the whole Markdown parser, so this lives apart from the limits that
// startup code and schemas share; Main loads it only when a sidebar first asks for replies.
/**
 * A reply as the plain text a chat row shows under its title: Markdown read as text, whitespace
 * collapsed, and bounded. Null when nothing readable is left.
 */
export function presentChatReplyPreview(markdown: string): string | null {
  const text = projectCodexMarkdownToPlainText(markdown);
  if (!text) return null;
  return Array.from(text).slice(0, CHAT_REPLY_PREVIEW_LIMIT).join("");
}
