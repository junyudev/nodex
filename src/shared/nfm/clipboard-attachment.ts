import {
  escapeClipboardMarkdownLinkText,
  formatClipboardMarkdownDestination,
} from "../clipboard-markdown";
import type { NfmAttachmentInlineContent } from "./types";

/** Copy the current attachment target; an imported origin is not its saved content. */
export function serializeAttachmentClipboardText(attachment: NfmAttachmentInlineContent): string {
  const label = attachment.name.replace(/\s+/gu, " ").trim() || "Untitled attachment";
  if (!attachment.source.trim()) return `[Attachment: ${label}]`;
  return `[${escapeClipboardMarkdownLinkText(label)}](${formatClipboardMarkdownDestination(attachment.source)})`;
}
