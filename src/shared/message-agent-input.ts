import { containsSkillMention } from "./rich-text/skill-mention";
import { classifyImageSource } from "./image-source";
import {
  readMarkdown,
  writeAgentMessageMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "./nodex-markdown";
import type { CodexPromptAgentConfigInput, CodexPromptImageInput, CodexPromptInput } from "./types";

/**
 * A written message as an Agent receives it. Every image whose picture Nodex holds — a Library
 * File, a managed asset, a file on disk or an image carried in its source — travels as an image
 * and is marked where it sat by a numbered placeholder, which keeps its caption and, for a file
 * on disk, the path the Agent can act on. A web image stays a link in the text: Nodex never
 * fetches the web for an Agent. Agent settings travel as typed sidecars.
 */
export type MessageAgentInput = Pick<CodexPromptInput, "text" | "images" | "agentConfigs">;

export interface MessageAgentInputOptions {
  /** Images that travel ahead of the text, such as a Composer's attachment row, count first. */
  readonly precedingImageCount?: number;
}

/** Whether an image in a message travels to an Agent as an image. */
export const travelsAsImage = (source: string): boolean => {
  const kind = classifyImageSource(source).kind;
  return kind === "file" || kind === "asset" || kind === "data" || kind === "path";
};

/** How an Agent reads the image numbered `number`, where the image sat. */
export function imagePlaceholder(number: number, source: string, caption: string): string {
  const image = classifyImageSource(source);
  const details = [
    ...(caption ? [`caption: ${caption}`] : []),
    ...(image.kind === "path" ? [`path: ${image.path}`] : []),
  ];
  return details.length ? `[Image #${number}] (${details.join("; ")})` : `[Image #${number}]`;
}

/** An image as the Agent read it, at its placeholder: its number, caption and path. */
export interface ImagePlaceholderReference {
  readonly number: number;
  readonly caption: string;
  readonly path: string | null;
}

const IMAGE_PLACEHOLDER = /\[Image #(\d+)\]/gu;

/** The details after a placeholder, ` (caption: …; path: …)`, up to its balanced close. */
function placeholderDetails(text: string, from: number): string | null {
  if (!text.startsWith(" (caption: ", from) && !text.startsWith(" (path: ", from)) return null;
  let depth = 0;
  for (let index = from + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === "\n") return null;
    if (character === "(") depth += 1;
    if (character === ")" && --depth === 0) return text.slice(from + 2, index);
  }
  return null;
}

function placeholderReference(number: string, details: string | null): ImagePlaceholderReference {
  const text = details ?? "";
  const pathAt = text.startsWith("path: ") ? 0 : text.lastIndexOf("; path: ") + 2;
  const path = pathAt >= 0 && text.startsWith("path: ", pathAt) ? text.slice(pathAt + 6) : null;
  const caption = text.startsWith("caption: ")
    ? text.slice(9, path === null ? undefined : pathAt - 2)
    : "";
  return { number: Number(number), caption, path };
}

/**
 * A sent message's Blocks with each image placeholder its text holds read back as an
 * `imagePlaceholder` inline, so the message shows the image where the Agent read it.
 */
export function readImagePlaceholders(blocks: readonly MarkdownBlock[]): MarkdownBlock[] {
  const inline = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content;
    return (content as MarkdownInline[]).flatMap((item): MarkdownInline[] => {
      if (item.type !== "text" || item.styles?.code || !item.text?.includes("[Image #"))
        return Array.isArray(item.content)
          ? [{ ...item, content: inline(item.content) as MarkdownInline[] }]
          : [item];
      const parts: MarkdownInline[] = [];
      let cursor = 0;
      for (const match of item.text.matchAll(IMAGE_PLACEHOLDER)) {
        if (match.index < cursor) continue;
        const end = match.index + match[0].length;
        const details = placeholderDetails(item.text, end);
        if (match.index > cursor)
          parts.push({ ...item, text: item.text.slice(cursor, match.index) });
        parts.push({
          type: "imagePlaceholder",
          props: { ...placeholderReference(match[1]!, details) },
        });
        cursor = details === null ? end : end + details.length + 3;
      }
      if (cursor < item.text.length) parts.push({ ...item, text: item.text.slice(cursor) });
      return parts;
    });
  };
  return blocks.map((block) => {
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
      ...(block.children ? { children: readImagePlaceholders(block.children) } : {}),
    };
  });
}

/** The highest image number a sent message's text names, which no image it carries can exceed. */
export function imagePlaceholderCount(text: string): number {
  let highest = 0;
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== "object") return;
    const item = value as { type?: string; props?: { number?: unknown } };
    if (item.type === "imagePlaceholder" && typeof item.props?.number === "number")
      highest = Math.max(highest, item.props.number);
    Object.values(item).forEach(visit);
  };
  if (text.includes("[Image #")) visit(readImagePlaceholders(readMarkdown(text)));
  return highest;
}

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/u;
const INLINE_CODE = /(?<!`)(`+)(?!`).*?(?<!`)\1(?!`)/gu;

/** One line without the image numbered `number`, and with the images after it moved up. */
function renumberPlaceholders(line: string, number: number): string {
  const code = [...line.matchAll(INLINE_CODE)].map(
    (match) => [match.index, match.index + match[0].length] as const,
  );
  let written = "";
  let cursor = 0;
  for (const match of line.matchAll(IMAGE_PLACEHOLDER)) {
    if (code.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const named = Number(match[1]);
    if (named < number) continue;
    const end = match.index + match[0].length;
    if (named > number) {
      written += `${line.slice(cursor, match.index)}[Image #${named - 1}]`;
      cursor = end;
      continue;
    }
    const details = placeholderDetails(line, end);
    let after = details === null ? end : end + details.length + 3;
    let before = line.slice(cursor, match.index);
    // The words around it stay one space apart, and punctuation stays against its word.
    if (before.endsWith(" ") && !/^[\p{L}\p{N}]/u.test(line.slice(after)))
      before = before.slice(0, -1);
    else if (`${written}${before}`.trim() === "" && line[after] === " ") after += 1;
    written += before;
    cursor = after;
  }
  return written + line.slice(cursor);
}

/**
 * A message's text once its image numbered `number` leaves it: the placeholders that name that
 * image go with their details, and later images move up, so every placeholder still names the
 * image it did. A line that held only that image goes too. Code keeps its text.
 */
export function removeImagePlaceholder(text: string, number: number): string {
  if (!text.includes("[Image #")) return text;
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = line.match(CODE_FENCE)?.[1];
    if (fence !== null) {
      if (marker?.startsWith(fence) && line.trim() === marker) fence = null;
      lines.push(line);
      continue;
    }
    if (marker) {
      fence = marker;
      lines.push(line);
      continue;
    }
    const written = renumberPlaceholders(line, number);
    if (written !== line && written.trim() === "") {
      // The blank line that set it apart goes with it.
      if (lines.at(-1)?.trim() === "") lines.pop();
      continue;
    }
    lines.push(written);
  }
  const result = lines.join("\n");
  return result === text ? text : result.trim();
}

export function projectMessageBlocks(
  blocks: readonly MarkdownBlock[],
  options: MessageAgentInputOptions = {},
): MessageAgentInput {
  const firstNumber = (options.precedingImageCount ?? 0) + 1;
  const images: CodexPromptImageInput[] = [];
  const agentConfigs: CodexPromptAgentConfigInput[] = [];
  const image = (source: string, caption: string): string => {
    images.push({ source, ...(caption ? { caption } : {}) });
    return imagePlaceholder(firstNumber + images.length - 1, source, caption);
  };
  const placeholder = (text: string): MarkdownInline => ({ type: "text", text, styles: {} });
  const inline = (content: unknown): unknown => {
    if (!Array.isArray(content)) return content;
    return (content as MarkdownInline[]).flatMap((item): MarkdownInline[] => {
      const props = item.props ?? {};
      if (item.type === "agentConfig") {
        agentConfigs.push(promptAgentConfig(props));
        return [];
      }
      if (item.type === "inlineImage" && travelsAsImage(String(props.url ?? "")))
        return [placeholder(image(String(props.url ?? "").trim(), String(props.alt ?? "")))];
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
      if (block.type === "image" && travelsAsImage(String(block.props?.url ?? "")))
        return {
          type: "paragraph",
          content: [
            placeholder(
              image(String(block.props?.url ?? "").trim(), String(block.props?.caption ?? "")),
            ),
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
    text: writeAgentMessageMarkdown(visit(blocks.flatMap(projectPromptBlockForSend))).trim(),
    ...(images.length ? { images } : {}),
    ...(agentConfigs.length ? { agentConfigs } : {}),
  };
}

/** A Prompt reaches a chat as its content: its first line and children, never its send record. */
export function projectPromptBlockForSend(block: MarkdownBlock): MarkdownBlock[] {
  const children = (block.children ?? []).flatMap(projectPromptBlockForSend);
  if (block.type !== "prompt") return [{ ...block, children }];
  return [
    { type: "paragraph", ...(block.content !== undefined ? { content: block.content } : {}) },
    ...children,
  ];
}

/**
 * A message's text as an Agent receives it. Text with nothing to project reaches the Agent
 * exactly as written.
 */
export function projectMessageText(
  text: string,
  options: MessageAgentInputOptions = {},
): MessageAgentInput {
  const blocks = readMarkdown(text);
  const projected = projectMessageBlocks(blocks, options);
  return projected.images || projected.agentConfigs || containsSkillMention(blocks)
    ? projected
    : { text };
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
