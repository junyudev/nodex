import { projectCodexMarkdownToPlainText } from "./codex-markdown-text";

/** Convert at native delivery, preserving Markdown structure until this boundary. */
export function toDesktopNotificationPlainText(value: string | null | undefined): string {
  return value ? projectCodexMarkdownToPlainText(value) : "";
}
