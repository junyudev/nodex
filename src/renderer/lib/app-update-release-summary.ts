export interface AppUpdateReleaseSummary {
  /** The release's one-line headline, when its notes open with one. */
  readonly headline: string | null;
  /** The first sentence of each of the release's first changes, in the notes' order. */
  readonly highlights: readonly string[];
}

const MAX_HIGHLIGHTS = 3;

/** Reads Markdown inline formatting as the plain text it shows. */
function plainInline(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\*\*(.+?)\*\*/gu, "$1")
    .replace(/(?<!\w)__(.+?)__(?!\w)/gu, "$1")
    .replace(/\*(.+?)\*/gu, "$1")
    .replace(/(?<!\w)_(.+?)_(?!\w)/gu, "$1")
    .replace(/`([^`]*)`/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

/** The first sentence of a change, which is written to stand on its own. */
function firstSentence(text: string): string {
  const match = /^.+?(?:[.!?](?=\s)|[。！？])/u.exec(text);
  return (match?.[0] ?? text).trim();
}

/**
 * Summarizes an update's release notes for a glance: the headline its notes open with and the
 * lead sentence of its first few changes. Notes are the release's changelog section in Markdown.
 */
export function summarizeAppUpdateReleaseNotes(notes: string | null): AppUpdateReleaseSummary {
  if (!notes) return { headline: null, highlights: [] };
  let headline: string | null = null;
  let inSections = false;
  const highlights: string[] = [];
  for (const rawLine of notes.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      // A release heading may precede the headline; a section heading starts the changes.
      if (/^#{3,}\s/u.test(line)) inSections = true;
      continue;
    }
    const bullet = /^[-*+]\s+(.+)$/u.exec(line);
    if (bullet) {
      inSections = true;
      if (highlights.length < MAX_HIGHLIGHTS) {
        const text = firstSentence(plainInline(bullet[1]!));
        if (text) highlights.push(text);
      }
      continue;
    }
    if (!inSections && headline === null) headline = plainInline(line) || null;
  }
  return { headline, highlights };
}
