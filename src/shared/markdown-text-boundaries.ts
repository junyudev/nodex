/** Trim boundary blanks without changing code indentation or interior Markdown hard breaks. */
export function trimMarkdownBlankLines(value: string): string {
  if (!value.trim()) return "";
  return value.replace(/^(?:[ \t]*\r?\n)+|(?:\r?\n[ \t]*)+$/g, "").trimEnd();
}
