/** One line of a Comment for lists: Markdown syntax removed, whitespace collapsed. */
export function commentPreviewText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<nodex:\/\/[^>]+>/g, "")
    .replace(/(\*\*|__|\*|_|~~|`)/g, "")
    .replace(/^\s{0,3}(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
