import type { ClipboardEvent } from "react";
import { readMarkdownPaste } from "../../shared/markdown";

/**
 * Pastes into a plain text field that holds Markdown, such as the Inbox Composer, the Markdown
 * source of what was copied (`readMarkdownPaste`). Plain text pastes as the field pastes it;
 * rich text arrives as its Markdown, inserted as typing would insert it, so undo takes it back.
 */
export function pasteMarkdownSource(
  event: ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>,
): void {
  const clipboard = event.clipboardData;
  const text = readMarkdownPaste({
    types: Array.from(clipboard.types),
    getData: (format) => clipboard.getData(format),
  });
  if (text === null || text === clipboard.getData("text/plain")) return;
  event.preventDefault();
  insertTyped(event.currentTarget, text);
}

function insertTyped(field: HTMLTextAreaElement | HTMLInputElement, text: string): void {
  field.focus();
  // The editing command keeps the field's own undo history.
  if (document.execCommand?.("insertText", false, text)) return;
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  field.setRangeText(text, start, end, "end");
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
