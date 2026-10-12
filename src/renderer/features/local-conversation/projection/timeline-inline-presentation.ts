import type { ThreadRealtimeBemItemPresentation } from "@nodex/codex-app-server-protocol/v2";
import type { CodexCanonicalItem } from "../../../../shared/types";

export type TimelineInlinePresentation =
  | { readonly type: "markdown"; readonly content: string }
  | {
      readonly type: "visualization";
      readonly file: string;
      readonly sourceThreadId: string | null;
    };

/** Inline promotions address an existing native assistant item and its declared display channel. */
export function resolveTimelineInlinePresentation(
  item: CodexCanonicalItem | null,
  presentation: ThreadRealtimeBemItemPresentation,
): TimelineInlinePresentation | null {
  if (item?.type !== "agentMessage" || presentation.type === "wholeItem") return null;
  const trimmed = item.text.trimStart();
  const channel = /^\[([A-Z][A-Z0-9_-]*)\][ \t]*/.exec(trimmed);
  if (!channel && (trimmed === "[" || /^\[[A-Z][A-Z0-9_-]*$/.test(trimmed))) return null;
  const content = channel ? trimmed.slice(channel[0].length).replace(/^\r?\n/, "") : item.text;
  const lines = content.split(/\r?\n/);
  if (presentation.type === "inlineMarkdown") {
    if (lines[0] !== "::codex-realtime-inline{}" || lines.length < 2) return null;
    return { type: "markdown", content: lines.slice(1).join("\n") };
  }
  const visualizations: Array<Extract<TimelineInlinePresentation, { type: "visualization" }>> = [];
  let fence: { readonly character: string; readonly length: number } | null = null;
  for (const line of lines) {
    if (fence) {
      if (new RegExp(`^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`).test(line))
        fence = null;
      continue;
    }
    const directive =
      /^ {0,3}::codex-inline-vis\{file="([^"]+)"(?:[ \t]+threadId="([^"]+)")?\}[ \t]*$/.exec(line);
    if (directive?.[1]) {
      visualizations.push({
        type: "visualization",
        file: directive[1],
        sourceThreadId: directive[2] ?? null,
      });
      continue;
    }
    const legacy = /^ {0,3}visualize(\{.*\})[ \t]*$/.exec(line);
    if (legacy?.[1]) {
      const file = legacyVisualizationFile(legacy[1]);
      if (file !== null) visualizations.push({ type: "visualization", file, sourceThreadId: null });
      continue;
    }
    const opening = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (opening) fence = { character: opening[0]!, length: opening.length };
  }
  return visualizations[presentation.index] ?? null;
}

function legacyVisualizationFile(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("path" in parsed) ||
      typeof parsed.path !== "string"
    )
      return null;
    const path = parsed.path.trim();
    if (!path) return null;
    return path.replace(/\\/g, "/").replace(/\/+$/, "").split("/").at(-1) ?? "";
  } catch {
    return null;
  }
}
