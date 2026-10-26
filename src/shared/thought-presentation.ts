import { projectCodexMarkdownToPlainText } from "./codex-markdown-text";

/** The status line of a Thought whose text names no heading. */
export const THOUGHT_STATUS_FALLBACK = "Thinking";

const LINE_BREAK = /\r\n|\r|\n|[\u2028\u2029\u0085]/u;
// A whole line of bold text, still open while it streams, or an ATX heading, either one quoted.
const HEADING_LINE = /^(?:>\s*)*(?:\*\*(?<strong>[^*\n]+?)(?:\*\*)?|#{1,6}\s+(?<atx>\S.*))$/u;

function stripHtmlComments(markdown: string): string {
  return markdown.replace(/<!--[\s\S]*?(?:-->|$)/gu, (comment) => comment.replace(/[^\r\n]/gu, ""));
}

/**
 * The latest heading a Thought names, as plain text.
 *
 * Summarized reasoning that is written as headed sections names what the Agent is doing in each
 * heading, so that heading is the Thought's status line. Prose thinking has no heading and none is
 * derived from it: its sentences are content, which never becomes a status line.
 */
export function resolveThoughtHeading(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  const lines = stripHtmlComments(markdown).split(LINE_BREAK);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = HEADING_LINE.exec(lines[index]?.trim() ?? "");
    const heading = match?.groups?.strong ?? match?.groups?.atx;
    if (!heading) continue;
    const text = projectCodexMarkdownToPlainText(heading.trim());
    if (text) return text;
  }
  return null;
}

/** The single line that stands for a live Thought: its latest heading, or generic Thinking. */
export function resolveThoughtStatusLine(markdown: string | null | undefined): string {
  return resolveThoughtHeading(markdown) ?? THOUGHT_STATUS_FALLBACK;
}

const EXCERPT_SOURCE_CHARS = 600;

/**
 * One line that previews a settled Thought in a list of work: its latest heading, or the start of
 * its prose. Display truncates it to the row; only a bounded prefix of long thinking is read.
 */
export function resolveThoughtExcerpt(markdown: string | null | undefined): string | null {
  if (!markdown) return null;
  const heading = resolveThoughtHeading(markdown);
  if (heading !== null) return heading;
  const text = projectCodexMarkdownToPlainText(
    stripHtmlComments(markdown).slice(0, EXCERPT_SOURCE_CHARS),
  );
  return text || null;
}
