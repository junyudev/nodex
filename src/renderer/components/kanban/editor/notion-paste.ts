import type { NfmBlock, NfmColor, NfmInlineContent, NfmStyleSet } from "../../../lib/nfm";
import { nfmToBlockNote } from "../../../lib/nfm";

export const CHROMIUM_WEB_CUSTOM_DATA_MIME = "org.chromium.web-custom-data";
export const NOTION_BLOCKS_MIME = "text/_notion-blocks-v3-production";
export const NOTION_MULTI_TEXT_MIME = "text/_notion-multi-text-production";
export const NOTION_PAGE_SOURCE_MIME = "text/_notion-page-source-production";

type JsonRecord = Record<string, unknown>;

interface ClipboardDataLike {
  types: readonly string[] | DOMStringList;
  getData: (format: string) => string;
}

interface ClipboardEditorBlock {
  id: string;
  type: string;
  content?: unknown;
  children?: ClipboardEditorBlock[];
}

interface ClipboardEditorSelection {
  blocks: ClipboardEditorBlock[];
}

interface ClipboardEditorLike {
  getSelection: () => ClipboardEditorSelection | undefined;
  getTextCursorPosition: () => { block: ClipboardEditorBlock };
  replaceBlocks: (blocksToRemove: string[], blocksToInsert: unknown[]) => unknown;
  insertBlocks: (
    blocksToInsert: unknown[],
    referenceBlock: string,
    placement: "before" | "after",
  ) => unknown;
}

interface NotionTreeNode {
  id: string;
  type: string;
  text: string;
  title?: unknown;
  children: NotionTreeNode[];
  properties?: JsonRecord;
  format?: JsonRecord;
}

export function handleNotionPasteFromClipboard(
  editor: ClipboardEditorLike,
  clipboardData: ClipboardDataLike | null | undefined,
): boolean {
  const blocks = extractNotionNfmBlocksFromClipboardData(clipboardData);
  if (!blocks || blocks.length === 0) {
    return false;
  }
  return insertNfmBlocksFromPaste(editor, blocks);
}

export function extractNotionNfmBlocksFromClipboardData(
  clipboardData: ClipboardDataLike | null | undefined,
): NfmBlock[] | null {
  if (!clipboardData) return null;

  for (const mimeType of [NOTION_BLOCKS_MIME, NOTION_MULTI_TEXT_MIME]) {
    const directPayload = readJsonClipboardData(clipboardData, mimeType);
    const blocksFromDirect = directPayload
      ? extractNotionNfmBlocksFromPayload(directPayload)
      : null;
    if (blocksFromDirect && blocksFromDirect.length > 0) {
      return blocksFromDirect;
    }
  }

  const chromiumPairs = readChromiumPairsFromClipboard(clipboardData);
  if (!chromiumPairs) return null;

  for (const mimeType of [NOTION_BLOCKS_MIME, NOTION_MULTI_TEXT_MIME]) {
    const rawNotionPayload = chromiumPairs.get(mimeType);
    if (!rawNotionPayload) continue;

    const parsedNotionPayload = tryParseJson(rawNotionPayload);
    if (!parsedNotionPayload) continue;

    const blocks = extractNotionNfmBlocksFromPayload(parsedNotionPayload);
    if (blocks && blocks.length > 0) return blocks;
  }

  return null;
}

export function extractNotionNfmBlocksFromPayload(payload: unknown): NfmBlock[] | null {
  const selectionPayload = extractSelectionPayload(payload);
  const roots = normalizeNotionRoots(selectionPayload);
  if (roots.length === 0) return null;

  const blocks = roots
    .map(mapNotionNodeToNfm)
    .filter((block): block is NfmBlock => block !== null);

  return blocks.length > 0 ? blocks : null;
}

export function insertNfmBlocksFromPaste(
  editor: ClipboardEditorLike,
  blocks: NfmBlock[],
): boolean {
  if (blocks.length === 0) return false;

  const bnBlocks = nfmToBlockNote(blocks);
  if (bnBlocks.length === 0) return false;

  const selectedBlocks = getSelectedBlocks(editor);
  if (selectedBlocks.length > 0) {
    editor.replaceBlocks(
      selectedBlocks.map((block) => block.id),
      bnBlocks,
    );
    return true;
  }

  const currentBlock = getCursorBlock(editor);
  if (!currentBlock) return false;

  if (isEmptyParagraphBlock(currentBlock)) {
    editor.replaceBlocks([currentBlock.id], bnBlocks);
    return true;
  }

  editor.insertBlocks(bnBlocks, currentBlock.id, "after");
  return true;
}

function getSelectedBlocks(editor: ClipboardEditorLike): ClipboardEditorBlock[] {
  try {
    const selection = editor.getSelection();
    if (!selection || !Array.isArray(selection.blocks)) return [];
    return selection.blocks.filter((block) => typeof block.id === "string");
  } catch {
    return [];
  }
}

function getCursorBlock(editor: ClipboardEditorLike): ClipboardEditorBlock | null {
  try {
    const cursor = editor.getTextCursorPosition();
    if (!cursor || !cursor.block || typeof cursor.block.id !== "string") return null;
    return cursor.block;
  } catch {
    return null;
  }
}

function isEmptyParagraphBlock(block: ClipboardEditorBlock): boolean {
  if (block.type !== "paragraph") return false;
  if (Array.isArray(block.children) && block.children.length > 0) return false;

  if (!Array.isArray(block.content)) return true;
  return block.content.length === 0;
}

function readJsonClipboardData(
  clipboardData: ClipboardDataLike,
  mimeType: string,
): unknown | null {
  if (!hasClipboardType(clipboardData, mimeType)) return null;
  const raw = clipboardData.getData(mimeType);
  if (!raw) return null;
  return tryParseJson(raw);
}

function readChromiumPairsFromClipboard(
  clipboardData: ClipboardDataLike,
): Map<string, string> | null {
  if (!hasClipboardType(clipboardData, CHROMIUM_WEB_CUSTOM_DATA_MIME)) {
    return null;
  }

  const raw = clipboardData.getData(CHROMIUM_WEB_CUSTOM_DATA_MIME);
  if (!raw) return null;

  try {
    return decodeChromiumWebCustomData(binaryStringToBytes(raw));
  } catch {
    return null;
  }
}

function hasClipboardType(clipboardData: ClipboardDataLike, mimeType: string): boolean {
  const types = Array.from(clipboardData.types);
  return types.includes(mimeType);
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractSelectionPayload(payload: unknown): unknown {
  if (!isRecord(payload)) return payload;
  if ("selection" in payload) {
    return payload.selection;
  }
  if ("blockSelection" in payload) {
    return payload.blockSelection;
  }
  return payload;
}

function normalizeNotionRoots(payload: unknown): NotionTreeNode[] {
  if (!isRecord(payload)) return [];

  const normalizedRoots = readNormalizedRoots(payload);
  if (normalizedRoots.length > 0) return normalizedRoots;

  const rawBlocks = payload.blocks;
  if (!Array.isArray(rawBlocks)) return [];

  return rawBlocks
    .map(normalizeRootFromRawBlock)
    .filter((node): node is NotionTreeNode => node !== null);
}

function readNormalizedRoots(payload: JsonRecord): NotionTreeNode[] {
  if (!Array.isArray(payload.roots)) return [];

  return payload.roots
    .map(normalizeRootFromNormalizedNode)
    .filter((node): node is NotionTreeNode => node !== null);
}

function normalizeRootFromNormalizedNode(node: unknown): NotionTreeNode | null {
  if (!isRecord(node)) return null;

  const id = asString(node.id);
  const type = asString(node.type);
  if (!id || !type) return null;

  const children = Array.isArray(node.children)
    ? node.children
      .map(normalizeRootFromNormalizedNode)
      .filter((child): child is NotionTreeNode => child !== null)
    : [];

  const text = type === "text"
    ? asString(node.text) ?? asString(node.title) ?? ""
    : asString(node.title) ?? asString(node.text) ?? "";
  const title = node.title ?? node.text;

  return {
    id,
    type,
    text,
    title,
    children,
  };
}

function normalizeRootFromRawBlock(rawBlock: unknown): NotionTreeNode | null {
  if (!isRecord(rawBlock)) return null;

  const rootId = asString(rawBlock.blockId);
  if (!rootId) return null;

  const subtree = asRecord(rawBlock.blockSubtree);
  const blockMap = asRecord(subtree?.block);
  if (!blockMap) return null;

  return buildTreeNode(rootId, blockMap, new Set<string>());
}

function buildTreeNode(
  blockId: string,
  blockMap: JsonRecord,
  visited: Set<string>,
): NotionTreeNode | null {
  if (visited.has(blockId)) return null;
  visited.add(blockId);

  const blockEntry = asRecord(blockMap[blockId]);
  const value = asRecord(blockEntry?.value);
  if (!value) return null;

  const type = asString(value.type) ?? "unknown";
  const properties = asRecord(value.properties) ?? undefined;
  const format = asRecord(value.format) ?? undefined;
  const title = properties?.title;
  const text = getNotionPropertyText(properties, "title");

  const childIds = Array.isArray(value.content)
    ? value.content.filter((item): item is string => typeof item === "string")
    : [];

  const children = childIds
    .map((childId) => buildTreeNode(childId, blockMap, visited))
    .filter((child): child is NotionTreeNode => child !== null);

  return {
    id: blockId,
    type,
    text,
    title,
    children,
    properties: properties ?? undefined,
    format: format ?? undefined,
  };
}

function mapNotionNodeToNfm(node: NotionTreeNode): NfmBlock | null {
  const children = node.children
    .map(mapNotionNodeToNfm)
    .filter((block): block is NfmBlock => block !== null);
  const content = notionRichTextToInlineContent(node.title) ?? textToInlineContent(node.text);
  const headingToggleable = children.length > 0;

  switch (node.type) {
    case "text":
      return {
        type: "paragraph",
        content,
        children,
      };

    case "toggle":
      return {
        type: "toggle",
        content,
        children,
      };

    case "header":
      return {
        type: "heading",
        level: 1,
        ...(headingToggleable ? { isToggleable: true } : {}),
        content,
        children,
      };

    case "sub_header":
      return {
        type: "heading",
        level: 2,
        ...(headingToggleable ? { isToggleable: true } : {}),
        content,
        children,
      };

    case "sub_sub_header":
      return {
        type: "heading",
        level: 3,
        ...(headingToggleable ? { isToggleable: true } : {}),
        content,
        children,
      };

    case "sub_sub_sub_header":
      return {
        type: "heading",
        level: 4,
        ...(headingToggleable ? { isToggleable: true } : {}),
        content,
        children,
      };

    case "bulleted_list":
      return {
        type: "bulletListItem",
        content,
        children,
      };

    case "numbered_list":
      return {
        type: "numberedListItem",
        content,
        children,
      };

    case "to_do":
      return {
        type: "checkListItem",
        checked: getNotionPropertyBoolean(node.properties, "checked"),
        content,
        children,
      };

    case "quote":
      return {
        type: "blockquote",
        content,
        children,
      };

    case "code":
      return {
        type: "codeBlock",
        language: getNotionPropertyText(node.properties, "language"),
        code: node.text,
        children,
      };

    case "callout":
      return {
        type: "callout",
        icon: asString(node.format?.page_icon) ?? undefined,
        content,
        children,
      };

    case "divider":
      return {
        type: "divider",
        children,
      };

    default:
      if (!node.text.trim() && children.length === 0) return null;
      return {
        type: "paragraph",
        content,
        children,
      };
  }
}

function getNotionPropertyText(properties: JsonRecord | undefined, key: string): string {
  if (!properties) return "";
  return richTextToPlain(properties[key]);
}

function getNotionPropertyBoolean(properties: JsonRecord | undefined, key: string): boolean {
  const text = getNotionPropertyText(properties, key).trim().toLowerCase();
  return text === "yes" || text === "true" || text === "1";
}

function richTextToPlain(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";

  const parts: string[] = [];
  for (const segment of value) {
    if (typeof segment === "string") {
      parts.push(segment);
      continue;
    }
    if (Array.isArray(segment) && typeof segment[0] === "string") {
      parts.push(segment[0]);
    }
  }
  return parts.join("");
}

function notionRichTextToInlineContent(value: unknown): NfmInlineContent[] | null {
  if (typeof value === "string") return textToInlineContent(value);
  if (!Array.isArray(value)) return null;

  const content: NfmInlineContent[] = [];

  for (const segment of value) {
    if (typeof segment === "string") {
      pushInlineContentWithLinebreaks(content, segment, {});
      continue;
    }
    if (!Array.isArray(segment)) continue;

    const text = typeof segment[0] === "string" ? segment[0] : "";
    if (!text) continue;

    const { styles, href } = parseNotionAnnotationArray(segment[1]);
    pushInlineContentWithLinebreaks(content, text, styles, href);
  }

  return content;
}

function parseNotionAnnotationArray(
  value: unknown,
): { styles: NfmStyleSet; href?: string } {
  const styles: NfmStyleSet = {};
  if (!Array.isArray(value)) return { styles };

  let href: string | undefined;
  for (const token of value) {
    if (!Array.isArray(token) || typeof token[0] !== "string") continue;
    const key = token[0];

    if (key === "b") {
      styles.bold = true;
      continue;
    }
    if (key === "i") {
      styles.italic = true;
      continue;
    }
    if (key === "s") {
      styles.strikethrough = true;
      continue;
    }
    if (key === "c") {
      styles.code = true;
      continue;
    }
    if (key === "_") {
      styles.underline = true;
      continue;
    }
    if (key === "a" && typeof token[1] === "string") {
      href = token[1];
      continue;
    }
    if (key === "h" && typeof token[1] === "string") {
      const mappedColor = mapNotionColor(token[1]);
      if (mappedColor) styles.color = mappedColor;
    }
  }

  return href ? { styles, href } : { styles };
}

function mapNotionColor(color: string): NfmColor | undefined {
  const normalized = color.toLowerCase();
  const textColorMap: Record<string, NfmColor> = {
    gray: "gray",
    brown: "brown",
    orange: "orange",
    yellow: "yellow",
    green: "green",
    teal: "green",
    blue: "blue",
    purple: "purple",
    pink: "pink",
    red: "red",
  };

  const backgroundColorMap: Record<string, NfmColor> = {
    gray_background: "gray_bg",
    brown_background: "brown_bg",
    orange_background: "orange_bg",
    yellow_background: "yellow_bg",
    green_background: "green_bg",
    teal_background: "green_bg",
    blue_background: "blue_bg",
    purple_background: "purple_bg",
    pink_background: "pink_bg",
    red_background: "red_bg",
  };

  return textColorMap[normalized] ?? backgroundColorMap[normalized];
}

function pushInlineContentWithLinebreaks(
  content: NfmInlineContent[],
  text: string,
  styles: NfmStyleSet,
  href?: string,
) {
  const parts = text.split("\n");

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.length > 0) {
      if (href) {
        content.push({
          type: "link",
          text: part,
          href,
          styles: { ...styles },
        });
      } else {
        content.push({
          type: "text",
          text: part,
          styles: { ...styles },
        });
      }
    }

    if (index < parts.length - 1) {
      content.push({ type: "linebreak" });
    }
  }
}

function textToInlineContent(text: string): NfmInlineContent[] {
  if (!text) return [];

  const parts = text.split("\n");
  const content: NfmInlineContent[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index]) {
      content.push({
        type: "text",
        text: parts[index],
        styles: {},
      });
    }

    if (index < parts.length - 1) {
      content.push({ type: "linebreak" });
    }
  }

  return content;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null;
}

function asRecord(value: unknown): JsonRecord | null {
  return isRecord(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function binaryStringToBytes(raw: string): Uint8Array {
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) {
    bytes[index] = raw.charCodeAt(index) & 0xff;
  }
  return bytes;
}

function readU32LE(bytes: Uint8Array, offset: number): number {
  if (offset + 4 > bytes.length) {
    throw new Error("Not enough bytes to read u32");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(offset, true);
}

function readU16String(
  bytes: Uint8Array,
  offset: number,
): { value: string; nextOffset: number } {
  const length = readU32LE(bytes, offset);
  const valueStart = offset + 4;
  const valueEnd = valueStart + length * 2;
  if (valueEnd > bytes.length) {
    throw new Error("UTF-16 string exceeds buffer bounds");
  }

  const decoder = new TextDecoder("utf-16le");
  const value = decoder.decode(bytes.subarray(valueStart, valueEnd));
  const paddedLength = length % 2 === 0 ? length * 2 : length * 2 + 2;
  const nextOffset = offset + 4 + paddedLength;

  return { value, nextOffset };
}

export function decodeChromiumWebCustomData(raw: Uint8Array): Map<string, string> {
  if (raw.length < 8) {
    throw new Error("Buffer is too small for Chromium web custom data");
  }

  const dataLength = readU32LE(raw, 0);
  if (raw.length - 4 !== dataLength) {
    throw new Error("Chromium web custom data length mismatch");
  }

  const data = raw.subarray(4, 4 + dataLength);
  const pairsCount = readU32LE(data, 0);
  let offset = 4;
  const pairs = new Map<string, string>();

  for (let index = 0; index < pairsCount; index += 1) {
    const keyResult = readU16String(data, offset);
    offset = keyResult.nextOffset;
    const valueResult = readU16String(data, offset);
    offset = valueResult.nextOffset;
    pairs.set(keyResult.value, valueResult.value);
  }

  return pairs;
}
