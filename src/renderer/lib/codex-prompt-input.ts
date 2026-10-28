import type {
  CodexPromptAgentConfigInput,
  CodexPromptImageInput,
  CodexPromptInput,
} from "@/lib/types";
import {
  writeMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "../../shared/nodex-markdown";

/** Block text stays exact; image placeholders and Agent settings travel with typed sidecars. */
export function buildCodexPromptInputFromBlockNoteBlocks(
  blocks: readonly MarkdownBlock[],
): CodexPromptInput {
  return buildCodexPromptInputFromMarkdownBlocks(blocks);
}

export function buildCodexPromptInputFromMarkdownBlocks(
  blocks: readonly MarkdownBlock[],
): CodexPromptInput {
  const images: CodexPromptImageInput[] = [];
  const agentConfigs: CodexPromptAgentConfigInput[] = [];
  const image = (source: string, caption: string): string => {
    images.push({ source, ...(caption ? { caption } : {}) });
    return caption
      ? `[Image #${images.length}] (caption: ${caption})`
      : `[Image #${images.length}]`;
  };
  const inline = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content;
    return (content as MarkdownInline[]).flatMap((item): MarkdownInline[] => {
      const props = item.props ?? {};
      if (item.type === "agentConfig") {
        agentConfigs.push(promptAgentConfig(props));
        return [];
      }
      if (item.type === "inlineImage")
        return [
          {
            type: "text",
            text: image(String(props.url ?? ""), String(props.alt ?? "")),
            styles: {},
          },
        ];
      return [
        {
          ...item,
          ...(Array.isArray(item.content)
            ? { content: inline(item.content) as MarkdownInline[] }
            : {}),
        },
      ];
    });
  };
  const visit = (items: readonly MarkdownBlock[]): MarkdownBlock[] =>
    items.map((block) => {
      if (block.type === "image")
        return {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: image(String(block.props?.url ?? ""), String(block.props?.caption ?? "")),
              styles: {},
            },
          ],
        };
      const content =
        block.type === "table" && block.content && typeof block.content === "object"
          ? {
              ...block.content,
              rows: (block.content as { rows: { cells: { content?: unknown }[] }[] }).rows.map(
                (row) => ({
                  ...row,
                  cells: row.cells.map((cell) => ({ ...cell, content: inline(cell.content) })),
                }),
              ),
            }
          : inline(block.content);
      return {
        ...block,
        ...(content !== undefined ? { content } : {}),
        children: visit(block.children ?? []),
      };
    });
  return {
    text: writeMarkdown(visit(blocks)).trim(),
    ...(images.length ? { images } : {}),
    ...(agentConfigs.length ? { agentConfigs } : {}),
  };
}

export function promptAgentConfig(
  props: Readonly<Record<string, unknown>>,
): CodexPromptAgentConfigInput {
  const known = Object.fromEntries(
    ["mode", "provider", "model", "reasoning", "speed"].flatMap((key) =>
      typeof props[key] === "string" && props[key] ? [[key, props[key]]] : [],
    ),
  );
  const unknownAttributes =
    typeof props.unknownAttributes === "string"
      ? props.unknownAttributes.split(",").filter(Boolean)
      : [];
  return { ...known, ...(unknownAttributes.length ? { unknownAttributes } : {}) };
}
