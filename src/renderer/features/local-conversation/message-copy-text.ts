import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";
/** Normalize display-only references without rewriting examples inside Markdown code. */
export function normalizeMessageCopyText(markdown: string): string {
  const protectedRanges: { start: number; end: number }[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === "code" || node.type === "inlineCode") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) protectedRanges.push({ start, end });
      return;
    }
    if ("children" in node) node.children.forEach(visit);
  };
  visit(fromMarkdown(markdown));
  const normalize = (value: string): string =>
    value
      .replace(/^::[a-zA-Z0-9-]+.*$/gm, "")
      .replace(/\uE200[^\uE201]*\uE201/g, "")
      .replace(
        /【([^†】\n]+)†L(\d+)(?:-L(\d+))?】/g,
        (original, path: string, start: string, end?: string) => {
          const source = path.trim().replace(/^F:\s*/, "");
          if (!path.startsWith("F:") && !/^(?:\/|[a-zA-Z]:[\\/]|\.\.?\/)/.test(source))
            return original;
          let decoded = source;
          try {
            decoded = decodeURI(source);
          } catch {
            /* Keep malformed escapes readable. */
          }
          if (end !== undefined && end !== start) return `${decoded}:${start}-${end}`;
          return start === "1" ? decoded : `${decoded}:${start}`;
        },
      )
      .replace(/:codex-annotation\{index="([1-9]\d*)"\}/g, "Annotation $1");
  let offset = 0;
  const parts: string[] = [];
  for (const range of protectedRanges) {
    parts.push(
      normalize(markdown.slice(offset, range.start)),
      markdown.slice(range.start, range.end),
    );
    offset = range.end;
  }
  parts.push(normalize(markdown.slice(offset)));
  return parts.join("").trim();
}
