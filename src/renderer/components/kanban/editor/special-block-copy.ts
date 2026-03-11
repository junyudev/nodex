import { invoke } from "../../../lib/api";
import { parseAssetSource } from "../../../../shared/assets";
import { blockNoteToNfm, serializeClipboardText } from "../../../lib/nfm";
import { TextSelection } from "@tiptap/pm/state";

const NODEX_ASSET_SOURCE_PATTERN = /nodex:\/\/assets\/[A-Za-z0-9._%-]+/g;
const NFM_IMAGE_LINE_PATTERN = /^([ \t]*)<image(?:\s+([^>]*))?>([\s\S]*?)<\/image>$/;
const NFM_IMAGE_SOURCE_ATTRIBUTE_PATTERN = /\bsource="([^"]*)"/;

type ClipboardItemCtor = typeof ClipboardItem;

interface ClipboardTarget {
  write?: (data: ClipboardItem[]) => Promise<void>;
  writeText?: (text: string) => Promise<void>;
}

export interface CopiedSelectionPayload {
  clipboardHTML: string;
  externalHTML: string;
  structuredText: string;
}

interface ClipboardWriteOptions {
  clipboard?: ClipboardTarget;
  clipboardItemCtor?: ClipboardItemCtor;
}

interface SelectionBlockLike {
  id: string;
  type?: string;
  content?: unknown[];
  children?: SelectionBlockLike[];
  [key: string]: unknown;
}

interface SelectionLike {
  blocks: SelectionBlockLike[];
}

interface SelectionCutBlocksLike {
  blocks: SelectionBlockLike[];
  blockCutAtStart?: string;
  blockCutAtEnd?: string;
}

interface SelectionSnapshot {
  blocks: SelectionBlockLike[];
  fromCutSelection: boolean;
  blockCutAtStart?: string;
  blockCutAtEnd?: string;
}

type StructuredSelectionPayloadFallback = {
  clipboardHTML: string;
  externalHTML: string;
  markdown: string;
};

export interface SelectionEditorLike {
  prosemirrorView?: {
    state?: {
      selection?: unknown;
      doc?: {
        textBetween?: (
          from: number,
          to: number,
          blockSeparator?: string,
          leafText?: string,
        ) => string;
      };
    };
  };
  tryParseHTMLToBlocks?: (html: string) => SelectionBlockLike[];
  getSelectionCutBlocks?: (expandToWords?: boolean) => SelectionCutBlocksLike;
  getSelection?: () => SelectionLike | undefined;
  getParentBlock?: (id: string) => SelectionBlockLike | undefined;
  blocksToFullHTML?: (blocks: SelectionBlockLike[]) => string;
  blocksToHTMLLossy?: (blocks: SelectionBlockLike[]) => string;
}

function getClipboardItemCtor(
  clipboardItemCtor?: ClipboardItemCtor,
): ClipboardItemCtor | null {
  if (clipboardItemCtor) return clipboardItemCtor;
  if (typeof ClipboardItem === "undefined") return null;
  return ClipboardItem;
}

function resolveAssetPathPrefixSource(source: string, assetPathPrefix: string): string {
  const parsed = parseAssetSource(source);
  if (!parsed) return source;
  if (assetPathPrefix.length === 0) return source;
  return `${assetPathPrefix}${parsed.fileName}`;
}

function getAssetPathPrefix(): string {
  const assetPathPrefix = typeof window !== "undefined"
    ? window.api?.assetPathPrefix?.trim() ?? ""
    : "";
  return assetPathPrefix;
}

function resolveAssetSourceToAbsolutePathSync(source: string): string {
  return resolveAssetPathPrefixSource(source, getAssetPathPrefix());
}

async function resolveAssetSourceToAbsolutePath(source: string): Promise<string> {
  const syncResolved = resolveAssetSourceToAbsolutePathSync(source);
  if (syncResolved !== source) return syncResolved;

  try {
    const resolved = await invoke("asset:resolve-path", source);
    if (typeof resolved !== "string") return source;
    if (resolved.trim().length === 0) return source;
    return resolved;
  } catch {
    return source;
  }
}

function collectAssetSources(value: string): string[] {
  const matches = value.match(NODEX_ASSET_SOURCE_PATTERN);
  if (!matches) return [];
  return Array.from(new Set(matches));
}

function applySourceReplacements(
  value: string,
  replacements: Map<string, string>,
): string {
  let next = value;
  for (const [source, replacement] of replacements) {
    if (source === replacement) continue;
    next = next.split(source).join(replacement);
  }
  return next;
}

function decodeXmlAttributeValue(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function escapeMarkdownImageAltText(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

function toMarkdownImageDestination(source: string): string {
  const normalized = source.trim();
  if (normalized.length === 0) return "";

  if (/\s/.test(normalized)) {
    return `<${normalized.replaceAll(">", "\\>")}>`;
  }

  return normalized
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
}

function resolveMarkdownImageAltText(caption: string): string {
  const normalizedCaption = caption.replace(/\s+/g, " ").trim();
  if (normalizedCaption.length > 0) return normalizedCaption;

  return "image";
}

function convertNfmImageLineToMarkdown(line: string): string {
  const match = NFM_IMAGE_LINE_PATTERN.exec(line);
  if (!match) return line;

  const indentation = match[1] ?? "";
  const attributes = match[2] ?? "";
  const caption = match[3] ?? "";

  const sourceMatch = NFM_IMAGE_SOURCE_ATTRIBUTE_PATTERN.exec(attributes);
  if (!sourceMatch) return line;

  const source = decodeXmlAttributeValue(sourceMatch[1] ?? "").trim();
  if (source.length === 0) return line;

  const destination = toMarkdownImageDestination(source);
  if (destination.length === 0) return line;

  const altText = escapeMarkdownImageAltText(resolveMarkdownImageAltText(caption));
  return `${indentation}![${altText}](${destination})`;
}

function convertNfmImageTagsToMarkdown(value: string): string {
  if (!value.includes("<image")) return value;
  return value
    .split("\n")
    .map(convertNfmImageLineToMarkdown)
    .join("\n");
}

export async function rewriteAssetSources(
  value: string,
  resolveSource: (source: string) => Promise<string>,
): Promise<string> {
  const sources = collectAssetSources(value);
  if (sources.length === 0) return value;

  const replacements = new Map<string, string>();
  await Promise.all(sources.map(async (source) => {
    const resolved = await resolveSource(source);
    replacements.set(source, resolved);
  }));

  return applySourceReplacements(value, replacements);
}

export async function rewriteCopiedSelectionAssetSources(
  payload: CopiedSelectionPayload,
  resolveSource: (source: string) => Promise<string> = resolveAssetSourceToAbsolutePath,
): Promise<CopiedSelectionPayload> {
  const replacements = new Map<string, string>();
  const sources = new Set<string>(collectAssetSources(payload.structuredText));

  await Promise.all(Array.from(sources).map(async (source) => {
    replacements.set(source, await resolveSource(source));
  }));

  const structuredText = convertNfmImageTagsToMarkdown(
    applySourceReplacements(payload.structuredText, replacements),
  );

  return {
    clipboardHTML: payload.clipboardHTML,
    externalHTML: payload.externalHTML,
    structuredText,
  };
}

export function rewriteCopiedSelectionAssetSourcesSync(
  payload: CopiedSelectionPayload,
  resolveSource: (source: string) => string = resolveAssetSourceToAbsolutePathSync,
): CopiedSelectionPayload {
  const replacements = new Map<string, string>();
  const sources = new Set<string>(collectAssetSources(payload.structuredText));

  for (const source of sources) {
    replacements.set(source, resolveSource(source));
  }

  const structuredText = convertNfmImageTagsToMarkdown(
    applySourceReplacements(payload.structuredText, replacements),
  );

  return {
    clipboardHTML: payload.clipboardHTML,
    externalHTML: payload.externalHTML,
    structuredText,
  };
}

export async function writeCopiedSelectionToClipboard(
  payload: CopiedSelectionPayload,
  options: ClipboardWriteOptions = {},
): Promise<void> {
  const clipboard =
    options.clipboard ??
    (typeof navigator !== "undefined" ? navigator.clipboard : undefined);
  if (!clipboard) {
    throw new Error("Clipboard API is unavailable");
  }

  const clipboardItemCtor = getClipboardItemCtor(options.clipboardItemCtor);
  if (clipboardItemCtor && typeof clipboard.write === "function") {
    try {
      const richItem = new clipboardItemCtor({
        "blocknote/html": new Blob([payload.clipboardHTML], { type: "text/html" }),
        "text/html": new Blob([payload.externalHTML], { type: "text/html" }),
        "text/plain": new Blob([payload.structuredText], { type: "text/plain" }),
      });
      await clipboard.write([richItem]);
      return;
    } catch {
      // Fall back to plain text/html clipboard payloads below.
    }
  }

  if (clipboardItemCtor && typeof clipboard.write === "function") {
    try {
      const fallbackItem = new clipboardItemCtor({
        "text/html": new Blob([payload.externalHTML], { type: "text/html" }),
        "text/plain": new Blob([payload.structuredText], { type: "text/plain" }),
      });
      await clipboard.write([fallbackItem]);
      return;
    } catch {
      // Fall back to text-only clipboard write below.
    }
  }

  if (typeof clipboard.writeText === "function") {
    await clipboard.writeText(payload.structuredText);
    return;
  }

  throw new Error("Clipboard write is unavailable");
}

function getSelectionBlocks(
  editor: SelectionEditorLike,
): SelectionSnapshot {
  try {
    const cutSelection = editor.getSelectionCutBlocks?.(false);
    if (cutSelection && Array.isArray(cutSelection.blocks) && cutSelection.blocks.length > 0) {
      const blocks = cutSelection.blocks.filter((block): block is SelectionBlockLike => {
        return typeof block?.id === "string" && block.id.length > 0;
      });
      return {
        blocks,
        fromCutSelection: true,
        blockCutAtStart: cutSelection.blockCutAtStart,
        blockCutAtEnd: cutSelection.blockCutAtEnd,
      };
    }
  } catch {
    // Fall back to full-block selection snapshot.
  }

  try {
    const selection = editor.getSelection?.();
    if (!selection || !Array.isArray(selection.blocks)) {
      return { blocks: [], fromCutSelection: false };
    }
    const blocks = selection.blocks.filter((block): block is SelectionBlockLike => {
      return typeof block?.id === "string" && block.id.length > 0;
    });
    return { blocks, fromCutSelection: false };
  } catch {
    return { blocks: [], fromCutSelection: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function pickParagraphProps(props: unknown): Record<string, unknown> {
  if (!isRecord(props)) return {};

  const nextProps: Record<string, unknown> = {};
  for (const key of ["backgroundColor", "textColor", "textAlignment"]) {
    if (key in props) {
      nextProps[key] = props[key];
    }
  }
  return nextProps;
}

function shouldUnwrapStartCutBlock(type: unknown): boolean {
  return type === "bulletListItem"
    || type === "numberedListItem"
    || type === "checkListItem"
    || type === "toggleListItem"
    || type === "heading"
    || type === "quote";
}

function rewriteStartCutBlock(
  blocks: SelectionBlockLike[],
  blockCutAtStart: string | undefined,
): SelectionBlockLike[] {
  if (!blockCutAtStart) return blocks;

  let didRewrite = false;

  const rewriteNode = (block: SelectionBlockLike): SelectionBlockLike => {
    const children = Array.isArray(block.children)
      ? block.children.map(rewriteNode)
      : [];
    const nextBlock = children === block.children
      ? block
      : { ...block, children };

    if (didRewrite || block.id !== blockCutAtStart || !shouldUnwrapStartCutBlock(block.type)) {
      return nextBlock;
    }

    didRewrite = true;
    return {
      ...nextBlock,
      type: "paragraph",
      props: pickParagraphProps(block.props),
    };
  };

  return blocks.map(rewriteNode);
}

function scoreSelectionBlock(block: SelectionBlockLike): number {
  const childCount = Array.isArray(block.children) ? block.children.length : 0;
  return Object.keys(block).length + (childCount * 100);
}

function collectSelectionBlocks(
  selectedBlocks: SelectionBlockLike[],
): { blockById: Map<string, SelectionBlockLike>; orderById: Map<string, number> } {
  const blockById = new Map<string, SelectionBlockLike>();
  const orderById = new Map<string, number>();
  let traversalIndex = 0;

  const visit = (block: SelectionBlockLike): void => {
    if (!orderById.has(block.id)) {
      orderById.set(block.id, traversalIndex);
      traversalIndex += 1;
    }

    const existing = blockById.get(block.id);
    if (!existing || scoreSelectionBlock(block) > scoreSelectionBlock(existing)) {
      blockById.set(block.id, block);
    }

    if (!Array.isArray(block.children)) return;
    block.children.forEach(visit);
  };

  selectedBlocks.forEach(visit);

  return { blockById, orderById };
}

function addChildRelation(
  childrenByParent: Map<string, string[]>,
  parentId: string,
  childId: string,
): void {
  if (parentId === childId) return;
  const existing = childrenByParent.get(parentId);
  if (!existing) {
    childrenByParent.set(parentId, [childId]);
    return;
  }
  if (existing.includes(childId)) return;
  existing.push(childId);
}

function resolveSelectedParentId(
  editor: SelectionEditorLike,
  selectedIds: Set<string>,
  blockId: string,
): string | undefined {
  if (typeof editor.getParentBlock !== "function") return undefined;

  let parent = editor.getParentBlock(blockId);
  let depth = 0;
  while (parent && depth < 1000) {
    if (selectedIds.has(parent.id)) return parent.id;
    parent = editor.getParentBlock(parent.id);
    depth += 1;
  }
  return undefined;
}

function buildSelectionTree(
  editor: SelectionEditorLike,
  selectedBlocks: SelectionBlockLike[],
): SelectionBlockLike[] {
  if (selectedBlocks.length === 0) return [];

  const { blockById, orderById } = collectSelectionBlocks(selectedBlocks);
  const selectedIds = new Set(blockById.keys());
  if (selectedIds.size === 0) return [];

  const childIds = new Set<string>();
  const childrenByParent = new Map<string, string[]>();

  for (const block of blockById.values()) {
    if (!Array.isArray(block.children)) continue;
    for (const child of block.children) {
      if (!selectedIds.has(child.id)) continue;
      addChildRelation(childrenByParent, block.id, child.id);
      childIds.add(child.id);
    }
  }

  for (const blockId of selectedIds) {
    const selectedParentId = resolveSelectedParentId(editor, selectedIds, blockId);
    if (!selectedParentId) continue;
    addChildRelation(childrenByParent, selectedParentId, blockId);
    childIds.add(blockId);
  }

  const bySelectionOrder = (left: string, right: string): number => {
    return (orderById.get(left) ?? Number.MAX_SAFE_INTEGER)
      - (orderById.get(right) ?? Number.MAX_SAFE_INTEGER);
  };
  const rootIds = Array.from(selectedIds)
    .filter((id) => !childIds.has(id))
    .sort(bySelectionOrder);
  if (rootIds.length === 0) return selectedBlocks;

  const buildNode = (id: string, seen: Set<string>): SelectionBlockLike => {
    const base = blockById.get(id);
    if (!base) return { id, children: [] };
    if (seen.has(id)) return { ...base, children: [] };

    const nextSeen = new Set(seen);
    nextSeen.add(id);
    const explicitChildIds = Array.isArray(base.children)
      ? base.children
        .map((child) => child.id)
        .filter((childId) => selectedIds.has(childId))
      : [];
    const inferredChildIds = childrenByParent.get(id) ?? [];
    const orderedChildIds = Array.from(new Set([...explicitChildIds, ...inferredChildIds]))
      .filter((childId) => childId !== id)
      .sort(bySelectionOrder);

    return {
      ...base,
      children: orderedChildIds.map((childId) => buildNode(childId, nextSeen)),
    };
  };

  return rootIds.map((id) => buildNode(id, new Set()));
}

function serializeSelectionToStructuredPlainText(
  selectedBlocks: SelectionBlockLike[],
): string {
  if (selectedBlocks.length === 0) return "";
  return serializeClipboardText(blockNoteToNfm(selectedBlocks));
}

function extractInlineSelectionText(content: unknown[] | undefined): string {
  if (!Array.isArray(content) || content.length === 0) return "";

  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (item.type === "linebreak") return "\n";
      return typeof item.text === "string" ? item.text : "";
    })
    .join("");
}

function getProsemirrorSelectionText(editor: SelectionEditorLike): string {
  const selection = editor.prosemirrorView?.state?.selection;
  const doc = editor.prosemirrorView?.state?.doc;
  if (!(selection instanceof TextSelection) || selection.empty) return "";
  if (typeof doc?.textBetween !== "function") return "";
  return doc.textBetween(selection.from, selection.to, "\n");
}

function resolveLiteralTextSelectionInsideCodeBlock(
  editor: SelectionEditorLike,
  selectionBlocks: SelectionBlockLike[],
): string | null {
  const selection = editor.prosemirrorView?.state?.selection;
  if (!(selection instanceof TextSelection) || selection.empty) return null;
  if (selectionBlocks.length !== 1) return null;

  const [selectedBlock] = selectionBlocks;
  if (selectedBlock?.type !== "codeBlock") return null;

  const literalSelectionText = extractInlineSelectionText(selectedBlock.content);
  if (literalSelectionText.length > 0) return literalSelectionText;

  const fallbackSelectionText = getProsemirrorSelectionText(editor);
  if (fallbackSelectionText.length > 0) return fallbackSelectionText;

  return "";
}

export function resolveNormalizedSelectionBlocks(
  editor: SelectionEditorLike,
): SelectionBlockLike[] {
  const selectionSnapshot = getSelectionBlocks(editor);
  if (selectionSnapshot.blocks.length === 0) return [];

  const selectionTree = buildSelectionTree(editor, selectionSnapshot.blocks);
  if (selectionTree.length === 0) return [];

  if (!selectionSnapshot.fromCutSelection) {
    return selectionTree;
  }

  return rewriteStartCutBlock(selectionTree, selectionSnapshot.blockCutAtStart);
}

function serializeStructuredPlainTextFromHtml(
  editor: SelectionEditorLike,
  html: string | undefined,
): string {
  if (!html || html.trim().length === 0) return "";
  if (typeof editor.tryParseHTMLToBlocks !== "function") return "";

  const parsedBlocks = editor.tryParseHTMLToBlocks(html);
  if (!Array.isArray(parsedBlocks) || parsedBlocks.length === 0) return "";

  return serializeClipboardText(blockNoteToNfm(parsedBlocks));
}

function scoreStructuredPlainText(value: string): number {
  const lines = value.split("\n");
  const indentationMarkers = (value.match(/\t/g) ?? []).length;
  const blankLines = lines.filter((line) => line.trim().length === 0).length;
  return (indentationMarkers * 100) + (blankLines * 10) + lines.length;
}

function preferRicherStructuredPlainText(current: string, candidate: string): string {
  if (candidate.length === 0) return current;
  if (current.length === 0) return candidate;
  if (scoreStructuredPlainText(candidate) > scoreStructuredPlainText(current)) {
    return candidate;
  }
  return current;
}

function resolveStructuredPlainTextFromHtmlPayloads(
  editor: SelectionEditorLike,
  externalHTML: string | undefined,
  clipboardHTML: string | undefined,
): string {
  let result = "";
  try {
    result = preferRicherStructuredPlainText(
      result,
      serializeStructuredPlainTextFromHtml(editor, clipboardHTML),
    );
  } catch {
    // try next payload
  }

  try {
    result = preferRicherStructuredPlainText(
      result,
      serializeStructuredPlainTextFromHtml(editor, externalHTML),
    );
  } catch {
    // leave the best result collected so far
  }

  return result;
}

export function resolveStructuredPlainTextForSelection(
  editor: SelectionEditorLike,
  fallbackStructuredText: string,
  externalHTML?: string,
  clipboardHTML?: string,
): string {
  const selectionBlocks = resolveNormalizedSelectionBlocks(editor);
  const literalCodeSelection = resolveLiteralTextSelectionInsideCodeBlock(editor, selectionBlocks);
  if (literalCodeSelection !== null) return literalCodeSelection;

  if (selectionBlocks.length === 0) {
    const structuredFromHtml = resolveStructuredPlainTextFromHtmlPayloads(
      editor,
      externalHTML,
      clipboardHTML,
    );
    if (structuredFromHtml.length > 0) return structuredFromHtml;
    return fallbackStructuredText;
  }

  try {
    const structuredPlainText = serializeSelectionToStructuredPlainText(selectionBlocks);
    const structuredFromHtml = resolveStructuredPlainTextFromHtmlPayloads(
      editor,
      externalHTML,
      clipboardHTML,
    );
    const preferred = preferRicherStructuredPlainText(structuredPlainText, structuredFromHtml);
    if (preferred.length > 0) return preferred;
    return fallbackStructuredText;
  } catch {
    const structuredFromHtml = resolveStructuredPlainTextFromHtmlPayloads(
      editor,
      externalHTML,
      clipboardHTML,
    );
    if (structuredFromHtml.length > 0) return structuredFromHtml;
    return fallbackStructuredText;
  }
}

function canSerializeSelectionHtml(
  editor: SelectionEditorLike,
): editor is SelectionEditorLike & Required<Pick<SelectionEditorLike, "blocksToFullHTML" | "blocksToHTMLLossy">> {
  return typeof editor.blocksToFullHTML === "function"
    && typeof editor.blocksToHTMLLossy === "function";
}

export function createCopiedSelectionPayloadFromSelection(
  editor: SelectionEditorLike,
  fallbackPayload?: StructuredSelectionPayloadFallback,
): CopiedSelectionPayload {
  try {
    const normalizedBlocks = resolveNormalizedSelectionBlocks(editor);
    if (normalizedBlocks.length > 0 && canSerializeSelectionHtml(editor)) {
      const literalCodeSelection = resolveLiteralTextSelectionInsideCodeBlock(
        editor,
        normalizedBlocks,
      );
      return {
        clipboardHTML: editor.blocksToFullHTML(normalizedBlocks),
        externalHTML: editor.blocksToHTMLLossy(normalizedBlocks),
        structuredText: literalCodeSelection
          ?? serializeSelectionToStructuredPlainText(normalizedBlocks),
      };
    }
  } catch {
    // Fall back to BlockNote's selection-content serializers below.
  }

  if (fallbackPayload) {
    return createStructuredPlainTextPayload(fallbackPayload, editor);
  }

  throw new Error("Failed to create copied selection payload");
}

export function createStructuredPlainTextPayload(
  payload: {
    clipboardHTML: string;
    externalHTML: string;
    markdown: string;
  },
  editor: SelectionEditorLike,
): CopiedSelectionPayload {
  return {
    clipboardHTML: payload.clipboardHTML,
    externalHTML: payload.externalHTML,
    structuredText: resolveStructuredPlainTextForSelection(
      editor,
      payload.markdown,
      payload.externalHTML,
      payload.clipboardHTML,
    ),
  };
}
