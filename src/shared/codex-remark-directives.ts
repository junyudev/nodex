import { trimMarkdownBlankLines } from "./markdown-text-boundaries";

export function stripCodexRemarkDirectiveLines(
  value: string | null | undefined,
  options: { readonly keepInlineVisualizations?: boolean } = {},
): string {
  let fence: { readonly marker: string; readonly length: number } | null = null;
  return trimMarkdownBlankLines(
    (value ?? "")
      .split("\n")
      .map((line) => {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
        if (fence) {
          if (
            marker?.[1]?.[0] === fence.marker &&
            marker[1].length >= fence.length &&
            !marker[2]?.trim()
          )
            fence = null;
          return line;
        }
        if (marker?.[1] && (marker[1][0] !== "`" || !marker[2]?.includes("`"))) {
          fence = { marker: marker[1][0]!, length: marker[1].length };
          return line;
        }
        if (options.keepInlineVisualizations && /^ {0,3}::codex-inline-vis(?:\{|\s|$)/.test(line))
          return line;
        return /^ {0,3}::[a-zA-Z0-9-]+/.test(line) ? "" : line;
      })
      .join("\n")
      .replace(/\n{3,}/g, "\n\n"),
  );
}
