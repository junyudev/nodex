export type WorkReportOutcome = "ready" | "blocked" | "failed" | "dropped";

/** A report's first meaningful line as plain text, for one-line previews. */
export function workReportLine(summary: string): string {
  const line =
    summary
      .split("\n")
      .map((text) => text.trim())
      .find((text) => text.length > 0 && !/^(#{1,6}|[-*_]{3,})\s*$/.test(text)) ?? "";
  return line
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+|^\d+[.)]\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .trim();
}
