import type { PlaygroundTool } from "@/lib/content-image";

const groupTimeFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatGeneratedImageGroupTime(
  timestampMs: number,
  locales?: string | readonly string[],
): string {
  const key = locales === undefined ? "default" : JSON.stringify(locales);
  let formatter = groupTimeFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locales, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    groupTimeFormatters.set(key, formatter);
  }
  return formatter.format(timestampMs);
}

export function isGeneratedImageTileEmphasized(input: {
  readonly active: boolean;
  readonly commentCount: number;
  readonly draftActive: boolean;
  readonly selected: boolean;
  readonly tool: PlaygroundTool;
}): boolean {
  if (input.tool === "comment") {
    return input.draftActive || input.commentCount > 0;
  }
  if (input.tool === "select") return input.selected;
  return input.active;
}
