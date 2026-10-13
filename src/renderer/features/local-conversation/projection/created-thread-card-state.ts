const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Compact replies end at a word boundary without splitting a visible character. */
export function truncateCreatedThreadReply(text: string): string {
  const characters = Array.from(graphemes.segment(text), (part) => part.segment);
  if (characters.length <= 120) return text;
  const prefix = characters.slice(0, 119).join("");
  const boundary = characters[119] === " " ? -1 : prefix.lastIndexOf(" ");
  return `${boundary < 0 ? prefix : prefix.slice(0, boundary)}…`;
}
