import type { PasteResourceSettings } from "../../../lib/paste-resource-settings";
import { DEFAULT_PASTE_RESOURCE_SETTINGS } from "../../../lib/paste-resource-settings";
import { readNodexClipboardFragment } from "../../../../shared/clipboard-paste";

export interface PasteResourceTarget {
  selectedBlockIds: string[];
  selectedBlockTypes?: string[];
  currentBlockId: string | null;
  currentBlockType?: string | null;
  canInsertInline: boolean;
  replaceCurrentEmptyParagraph: boolean;
}

export interface PasteResourceDraftItem {
  kind: "text" | "file" | "folder";
  name: string;
  path?: string;
  file?: File;
  mimeType?: string;
  bytes?: number;
}

export interface PasteResourceDialogState {
  target: PasteResourceTarget;
  items: PasteResourceDraftItem[];
  textPayload?: string;
  htmlPayload?: string;
  markdownPayload?: string;
  blocknoteHtmlPayload?: string;
  allowLink: boolean;
}

interface ClipboardFileSource {
  readonly files?: ArrayLike<File> | null;
  readonly items?: ArrayLike<{
    readonly kind: string;
    getAsFile(): File | null;
  }> | null;
}

/** Chromium may expose screenshot clipboard bytes only through DataTransferItem.getAsFile(). */
export function clipboardFilesFromDataTransfer(source: ClipboardFileSource): File[] {
  const files = Array.from(source.files ?? []);
  if (files.length > 0) return files;
  return Array.from(source.items ?? []).flatMap((item) => {
    if (item.kind !== "file") return [];
    const file = item.getAsFile();
    return file ? [file] : [];
  });
}

export function canMaterializePasteResourceItems(items: PasteResourceDraftItem[]): boolean {
  return items.every((item) => item.kind !== "folder");
}

type SelectionBlockLike = {
  id: string;
  type?: string;
  content?: unknown;
  children?: SelectionBlockLike[];
};
type PasteTargetSelectionEditor = {
  schema?: {
    blockSchema?: Record<string, { content?: string }>;
  };
  getSelection: () => { blocks: SelectionBlockLike[] } | undefined;
  getTextCursorPosition: () => { block: SelectionBlockLike };
};

export interface PasteAttachmentInlineContent {
  type: "attachment";
  props: {
    kind: "text" | "file" | "folder";
    mode: "materialized" | "link";
    source: string;
    name: string;
    mimeType?: string;
    bytes?: number;
    origin?: string;
  };
}

type PasteTargetMutationEditor = {
  document?: Array<{ id?: string }>;
  insertInlineContent: unknown;
  replaceBlocks: unknown;
  insertBlocks: unknown;
};

/** Insert already-materialized blocks at the position captured before asynchronous work began. */
export function insertBlocksAtPasteTarget(
  editor: PasteTargetMutationEditor,
  target: PasteResourceTarget,
  blocks: unknown[],
): boolean {
  if (blocks.length === 0) return false;

  const replaceBlocks = editor.replaceBlocks as (
    blockIds: string[],
    blocksToInsert: unknown[],
  ) => unknown;
  const insertBlocks = editor.insertBlocks as (
    blocksToInsert: unknown[],
    referenceBlockId: string,
    placement: "before" | "after",
  ) => unknown;

  if (target.selectedBlockIds.length > 0) {
    replaceBlocks.call(editor, target.selectedBlockIds, blocks);
    return true;
  }

  if (target.currentBlockId && target.replaceCurrentEmptyParagraph) {
    replaceBlocks.call(editor, [target.currentBlockId], blocks);
    return true;
  }

  if (target.currentBlockId) {
    insertBlocks.call(editor, blocks, target.currentBlockId, "after");
    return true;
  }

  const lastBlockId = editor.document?.[editor.document.length - 1]?.id;
  if (typeof lastBlockId === "string" && lastBlockId.length > 0) {
    insertBlocks.call(editor, blocks, lastBlockId, "after");
    return true;
  }

  replaceBlocks.call(editor, [], blocks);
  return true;
}

function isEmptyParagraphBlock(block: SelectionBlockLike | null): boolean {
  if (!block || block.type !== "paragraph") return false;
  if (!Array.isArray(block.children) || block.children.length > 0) return false;
  return Array.isArray(block.content) ? block.content.length === 0 : true;
}

function canBlockAcceptInlineContent(
  editor: PasteTargetSelectionEditor,
  block: SelectionBlockLike | undefined,
): boolean {
  if (!block?.type) return false;
  return editor.schema?.blockSchema?.[block.type]?.content === "inline";
}

function collectBlockTypes(block: SelectionBlockLike): string[] {
  return [
    ...(typeof block.type === "string" ? [block.type] : []),
    ...(block.children ?? []).flatMap(collectBlockTypes),
  ];
}

export function capturePasteResourceTarget(
  editor: PasteTargetSelectionEditor,
): PasteResourceTarget {
  let selectedBlockIds: string[] = [];
  let selectedBlockTypes: string[] = [];
  try {
    const selection = editor.getSelection();
    if (selection?.blocks?.length) {
      selectedBlockIds = selection.blocks.map((block) => block.id);
      selectedBlockTypes = selection.blocks.flatMap(collectBlockTypes);
    }
  } catch {
    selectedBlockIds = [];
  }

  try {
    const currentBlock = editor.getTextCursorPosition().block as SelectionBlockLike | undefined;
    return {
      selectedBlockIds,
      selectedBlockTypes,
      currentBlockId: currentBlock?.id ?? null,
      currentBlockType: currentBlock?.type ?? null,
      canInsertInline: canBlockAcceptInlineContent(editor, currentBlock),
      replaceCurrentEmptyParagraph: isEmptyParagraphBlock(currentBlock ?? null),
    };
  } catch {
    return {
      selectedBlockIds,
      selectedBlockTypes,
      currentBlockId: null,
      currentBlockType: null,
      canInsertInline: false,
      replaceCurrentEmptyParagraph: false,
    };
  }
}

function createAttachmentInlineSequence(attachments: PasteAttachmentInlineContent[]): unknown[] {
  return attachments.flatMap((attachment, index) => {
    if (index === 0) return [attachment];
    return [{ type: "text", text: " ", styles: {} }, attachment];
  });
}

function createAttachmentParagraph(attachments: PasteAttachmentInlineContent[]) {
  return {
    type: "paragraph" as const,
    content: createAttachmentInlineSequence(attachments),
    children: [],
  };
}

export function insertAttachmentsAtPasteTarget(
  editor: PasteTargetMutationEditor,
  target: PasteResourceTarget,
  attachments: PasteAttachmentInlineContent[],
): boolean {
  if (attachments.length === 0) return false;

  const insertInlineContent = editor.insertInlineContent as (
    content: unknown[],
    options?: { updateSelection?: boolean },
  ) => unknown;
  if (target.canInsertInline) {
    insertInlineContent.call(editor, createAttachmentInlineSequence(attachments), {
      updateSelection: true,
    });
    return true;
  }

  const paragraph = createAttachmentParagraph(attachments);
  return insertBlocksAtPasteTarget(editor, target, [paragraph]);
}

function slugifyFileName(value: string): string {
  const normalized = value
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "pasted-text";

  const compact = normalized
    .slice(0, 48)
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return compact || "pasted-text";
}

export function derivePastedTextAttachmentName(text: string): string {
  const firstLine = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return "Pasted text";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80).trimEnd()}...` : firstLine;
}

export function createPastedTextUploadFile(text: string): File {
  const attachmentName = derivePastedTextAttachmentName(text);
  const fileName = `${slugifyFileName(attachmentName)}.txt`;
  return new File([text], fileName, { type: "text/plain" });
}

export function shouldPromptForOversizedText(
  text: string,
  currentDocumentLength: number,
  settings: PasteResourceSettings = DEFAULT_PASTE_RESOURCE_SETTINGS,
): boolean {
  if (!text.trim()) return false;
  return (
    text.length >= settings.textPromptCharThreshold ||
    currentDocumentLength + text.length >= settings.descriptionSoftLimit
  );
}

function hasMarkdownTableRow(src: string): boolean {
  return src.split(/\r?\n/u).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 2 && trimmed.startsWith("|") && trimmed.endsWith("|");
  });
}

export function looksLikeMarkdown(src: string): boolean {
  const h1 = /(^|\n) {0,3}#{1,6} {1,8}[^\n]{1,64}\r?\n\r?\n\s{0,32}\S/;
  const bold = /(_|__|\*|\*\*|~~|==|\+\+)(?!\s)(?:[^\s](?:.{0,62}[^\s])?|\S)(?=\1)/;
  const link = /\[[^\]]{1,128}\]\(https?:\/\/\S{1,999}\)/;
  const code = /(?:\s|^)`(?!\s)(?:[^\s`](?:[^`]{0,46}[^\s`])?|[^\s`])`([^\w]|$)/;
  const ul = /(?:^|\n)\s{0,5}-\s{1}[^\n]+\n\s{0,15}-\s/;
  const ol = /(?:^|\n)\s{0,5}\d+\.\s{1}[^\n]+\n\s{0,15}\d+\.\s/;
  const hr = /\n{2} {0,3}-{2,48}\n{2}/;
  const fences =
    /(?:\n|^)(```|~~~|\$\$)(?!`|~)[^\s]{0,64} {0,64}[^\n]{0,64}\n[\s\S]{0,9999}?\s*\1 {0,64}(?:\n+|$)/;
  const title = /(?:\n|^)(?!\s)\w[^\n]{0,64}\r?\n(-|=)\1{0,64}\n\n\s{0,64}(\w|$)/;
  const blockquote = /(?:^|(\r?\n\r?\n))( {0,3}>[^\n]{1,333}\n){1,999}($|(\r?\n))/;
  const tableRow = hasMarkdownTableRow(src);

  return (
    h1.test(src) ||
    bold.test(src) ||
    link.test(src) ||
    code.test(src) ||
    ul.test(src) ||
    ol.test(src) ||
    hr.test(src) ||
    fences.test(src) ||
    title.test(src) ||
    blockquote.test(src) ||
    tableRow
  );
}

interface ContinueInlinePasteEditor {
  pasteHTML: (html: string, raw?: boolean) => void;
  pasteMarkdown: (markdown: string) => void;
  pasteText: (text: string) => boolean | undefined;
}

export function continueInlinePaste(
  editor: ContinueInlinePasteEditor,
  dialogState: Pick<
    PasteResourceDialogState,
    "textPayload" | "htmlPayload" | "markdownPayload" | "blocknoteHtmlPayload"
  >,
): boolean {
  const plainText = dialogState.textPayload ?? "";
  const blocknoteHtml =
    dialogState.blocknoteHtmlPayload?.trim() ||
    readNodexClipboardFragment(dialogState.htmlPayload ?? "") ||
    "";
  const markdown = dialogState.markdownPayload?.trim() ?? "";
  const html = dialogState.htmlPayload?.trim() ?? "";

  if (blocknoteHtml.length > 0) {
    editor.pasteHTML(blocknoteHtml, true);
    return true;
  }

  if (markdown.length > 0) {
    editor.pasteMarkdown(markdown);
    return true;
  }

  if (html.length > 0) {
    if (plainText && looksLikeMarkdown(plainText)) {
      editor.pasteMarkdown(plainText);
      return true;
    }
    editor.pasteHTML(html);
    return true;
  }

  if (plainText.length > 0) {
    if (looksLikeMarkdown(plainText)) {
      editor.pasteMarkdown(plainText);
      return true;
    }
    return editor.pasteText(plainText) ?? false;
  }

  return false;
}

export function normalizeClipboardFileDraftItems(files: File[]): PasteResourceDraftItem[] {
  return files.map((file) => ({
    ...(typeof window !== "undefined" && window.api?.getPathInfoForFile
      ? (() => {
          const pathInfo = window.api.getPathInfoForFile?.(file);
          if (!pathInfo) {
            return {
              kind: "file" as const,
              name: file.name || "Untitled file",
              file,
              mimeType: file.type || undefined,
              bytes: file.size,
            };
          }

          return {
            kind: pathInfo.kind,
            name: pathInfo.name || file.name || "Untitled file",
            path: pathInfo.path,
            file,
            mimeType: file.type || undefined,
            ...(pathInfo.kind === "file"
              ? { bytes: typeof pathInfo.bytes === "number" ? pathInfo.bytes : file.size }
              : {}),
          };
        })()
      : {
          kind: "file" as const,
          name: file.name || "Untitled file",
          file,
          mimeType: file.type || undefined,
          bytes: file.size,
        }),
  }));
}
