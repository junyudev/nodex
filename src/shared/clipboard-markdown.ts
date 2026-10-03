/** Preserve literal paths inside Markdown links, including native Windows paths. */
export function formatClipboardMarkdownDestination(source: string): string {
  const escaped = source
    .replace(/[\u0000-\u001f\u007f]/gu, (character) => encodeURIComponent(character))
    .replace(/[\\<>&]/gu, "\\$&");
  if (/\s/u.test(source)) return `<${escaped}>`;
  return escaped.replace(/[()]/gu, "\\$&");
}

export function escapeClipboardMarkdownLinkText(text: string): string {
  return text.replace(/[\\`*_[\]<>~&]/gu, "\\$&");
}
