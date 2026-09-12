import type { CodexLiveFileAttachment } from "./types";

function codexLiveFileAttachmentKey(attachment: CodexLiveFileAttachment): string {
  return JSON.stringify([
    attachment.label,
    attachment.path,
    attachment.fsPath,
    attachment.startLine,
    attachment.endLine,
  ]);
}

/** Exact bundle `rH`: retain the first original object for each five-field identity. */
export function dedupeCodexLiveFileAttachments<T extends CodexLiveFileAttachment>(
  attachments: readonly T[],
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const attachment of attachments) {
    const key = codexLiveFileAttachmentKey(attachment);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(attachment);
  }
  return result;
}

export function isCodexLiveFileAttachment(value: unknown): value is CodexLiveFileAttachment {
  if (value === null || typeof value !== "object") return false;
  return (
    typeof Reflect.get(value, "label") === "string" &&
    typeof Reflect.get(value, "path") === "string" &&
    typeof Reflect.get(value, "fsPath") === "string"
  );
}
