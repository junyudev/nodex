import { blockNoteToNfm, extractPlainText, serializeClipboardText, serializeNfm, type NfmBlock } from "../../../lib/nfm";

export interface ThreadSectionBlockLike {
  id?: string;
  type?: string;
  props?: Record<string, unknown>;
  content?: unknown[];
  children?: ThreadSectionBlockLike[];
}

export interface ThreadSectionParentLookup {
  getParentBlock: (id: string) => { id?: string } | undefined;
}

export interface ThreadSectionCursorLookup {
  getSelection?: () => { blocks: Array<{ id?: string }> } | undefined;
  getTextCursorPosition: () => { block?: { id?: string; type?: string } } | undefined;
}

export interface ResolvedThreadSection {
  markerBlockId: string;
  markerIndex: number;
  label: string;
  threadId: string;
  markerChildren: ThreadSectionBlockLike[];
  bodyBlocks: ThreadSectionBlockLike[];
  bodyBlockIds: string[];
  fallbackTitle: string;
}

export interface PreparedThreadSectionSendPlan {
  section: ResolvedThreadSection;
  createMarkerBeforeBlockId: string | null;
}

export interface ThreadSectionInsertBlock {
  type: "threadSection";
  props: {
    label: string;
    threadId: string;
  };
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function createEmptyThreadSectionBlock(): ThreadSectionInsertBlock {
  return {
    type: "threadSection",
    props: {
      label: "",
      threadId: "",
    },
  };
}

function hasBlockId(value: unknown): value is { id: string } {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { id?: unknown }).id === "string";
}

export function isThreadSectionBlock(block: ThreadSectionBlockLike | undefined): boolean {
  return block?.type === "threadSection";
}

export function isToggleShortcutBlock(block: { type?: string; props?: Record<string, unknown> } | undefined): boolean {
  if (!block) return false;
  if (block.type === "toggleListItem") return true;
  if (block.type === "cardToggle") return true;
  return block.type === "heading" && block.props?.isToggleable === true;
}

export function resolveTopLevelBlockId(
  editor: ThreadSectionParentLookup,
  blockId: string,
): string {
  let currentId = blockId;

  while (currentId.length > 0) {
    const parent = editor.getParentBlock(currentId);
    if (!parent || typeof parent.id !== "string" || parent.id.length === 0) {
      return currentId;
    }
    currentId = parent.id;
  }

  return blockId;
}

export function resolveThreadSections(
  siblingBlocks: ThreadSectionBlockLike[],
): ResolvedThreadSection[] {
  const sections: ResolvedThreadSection[] = [];

  for (let index = 0; index < siblingBlocks.length; index += 1) {
    const block = siblingBlocks[index];
    if (!isThreadSectionBlock(block) || typeof block.id !== "string" || block.id.length === 0) {
      continue;
    }

    const nextBoundaryIndex = siblingBlocks.findIndex(
      (candidate, candidateIndex) => candidateIndex > index && isThreadSectionBlock(candidate),
    );
    const bodyBlocks = siblingBlocks.slice(
      index + 1,
      nextBoundaryIndex >= 0 ? nextBoundaryIndex : undefined,
    );
    const bodyBlockIds = bodyBlocks
      .map((candidate) => (typeof candidate.id === "string" ? candidate.id : ""))
      .filter((candidate) => candidate.length > 0);
    const label = normalizeString(block.props?.label).trim();
    const threadId = normalizeString(block.props?.threadId).trim();
    const markerChildren = Array.isArray(block.children)
      ? block.children
      : [];
    const fallbackTitle = label.length > 0
      ? label
      : deriveThreadSectionFallbackTitle(bodyBlocks);

    sections.push({
      markerBlockId: block.id,
      markerIndex: index,
      label,
      threadId,
      markerChildren,
      bodyBlocks,
      bodyBlockIds,
      fallbackTitle,
    });
  }

  return sections;
}

function resolveThreadSectionForSiblingBlock(
  siblingBlocks: ThreadSectionBlockLike[],
  siblingBlockId: string,
): ResolvedThreadSection | null {
  const sections = resolveThreadSections(siblingBlocks);
  const explicit = sections.find((section) => section.markerBlockId === siblingBlockId);
  if (explicit) return explicit;

  return sections.find((section) =>
    section.bodyBlockIds.includes(siblingBlockId),
  ) ?? null;
}

interface BlockPathEntry {
  block: ThreadSectionBlockLike;
  siblings: ThreadSectionBlockLike[];
}

function findBlockPath(
  siblingBlocks: ThreadSectionBlockLike[],
  targetBlockId: string,
): BlockPathEntry[] | null {
  for (const block of siblingBlocks) {
    if (block.id === targetBlockId) {
      return [{ block, siblings: siblingBlocks }];
    }

    const childBlocks = Array.isArray(block.children)
      ? block.children
      : [];
    const childPath = findBlockPath(childBlocks, targetBlockId);
    if (childPath) {
      return [{ block, siblings: siblingBlocks }, ...childPath];
    }
  }

  return null;
}

export function resolveThreadSectionForBlock(
  documentBlocks: ThreadSectionBlockLike[],
  blockId: string,
): ResolvedThreadSection | null {
  const blockPath = findBlockPath(documentBlocks, blockId);
  if (!blockPath) return null;

  for (let index = blockPath.length - 1; index >= 0; index -= 1) {
    const entry = blockPath[index];
    if (!entry) continue;

    const section = resolveThreadSectionForSiblingBlock(entry.siblings, entry.block.id ?? "");
    if (section) return section;
  }

  return null;
}

export function resolveThreadSectionSendPlan(
  documentBlocks: ThreadSectionBlockLike[],
  blockId: string,
): PreparedThreadSectionSendPlan | null {
  const existingSection = resolveThreadSectionForBlock(documentBlocks, blockId);
  if (existingSection) {
    return {
      section: existingSection,
      createMarkerBeforeBlockId: null,
    };
  }

  const blockPath = findBlockPath(documentBlocks, blockId);
  const currentEntry = blockPath?.[blockPath.length - 1];
  if (!currentEntry || typeof currentEntry.block.id !== "string" || currentEntry.block.id.length === 0) {
    return null;
  }

  const markerIndex = currentEntry.siblings.findIndex((candidate) => candidate.id === currentEntry.block.id);
  if (markerIndex < 0) return null;

  const nextBoundaryIndex = currentEntry.siblings.findIndex(
    (candidate, candidateIndex) => candidateIndex > markerIndex && isThreadSectionBlock(candidate),
  );
  const bodyBlocks = currentEntry.siblings.slice(
    markerIndex,
    nextBoundaryIndex >= 0 ? nextBoundaryIndex : undefined,
  );
  const bodyBlockIds = bodyBlocks
    .map((candidate) => (typeof candidate.id === "string" ? candidate.id : ""))
    .filter((candidate) => candidate.length > 0);

  return {
    section: {
      markerBlockId: "",
      markerIndex,
      label: "",
      threadId: "",
      markerChildren: [],
      bodyBlocks,
      bodyBlockIds,
      fallbackTitle: deriveThreadSectionFallbackTitle(bodyBlocks),
    },
    createMarkerBeforeBlockId: currentEntry.block.id,
  };
}

function stripNestedThreadSectionsFromSiblingBlocks(
  siblingBlocks: ThreadSectionBlockLike[],
): ThreadSectionBlockLike[] {
  const promptBlocks: ThreadSectionBlockLike[] = [];

  for (let index = 0; index < siblingBlocks.length; index += 1) {
    const block = siblingBlocks[index];
    if (isThreadSectionBlock(block)) {
      const nextBoundaryIndex = siblingBlocks.findIndex(
        (candidate, candidateIndex) => candidateIndex > index && isThreadSectionBlock(candidate),
      );
      if (nextBoundaryIndex < 0) break;
      index = nextBoundaryIndex - 1;
      continue;
    }

    const childBlocks = Array.isArray(block.children)
      ? block.children
      : [];
    const nextChildren = childBlocks.length > 0
      ? stripNestedThreadSectionsFromSiblingBlocks(childBlocks)
      : childBlocks;

    if (nextChildren === childBlocks) {
      promptBlocks.push(block);
      continue;
    }

    promptBlocks.push({
      ...block,
      children: nextChildren,
    });
  }

  return promptBlocks;
}

export function deriveThreadSectionPromptBlocks(
  section: ResolvedThreadSection,
): ThreadSectionBlockLike[] {
  return [
    ...stripNestedThreadSectionsFromSiblingBlocks(section.markerChildren),
    ...stripNestedThreadSectionsFromSiblingBlocks(section.bodyBlocks),
  ];
}

export function serializeThreadSectionPrompt(
  promptBlocks: ThreadSectionBlockLike[],
  transformNfmBlocks?: (nfmBlocks: NfmBlock[]) => void,
): string {
  const nfmBlocks = blockNoteToNfm(promptBlocks);
  transformNfmBlocks?.(nfmBlocks);
  return serializeClipboardText(nfmBlocks).trim();
}

export function resolveShortcutBlockId(
  editor: ThreadSectionCursorLookup,
): string | null {
  const selectionBlocks = editor.getSelection?.()?.blocks ?? [];
  const selectedId = selectionBlocks.find(hasBlockId)?.id;
  if (selectedId) return selectedId;

  const cursorBlock = editor.getTextCursorPosition()?.block;
  const cursorBlockId = normalizeString(cursorBlock?.id);
  if (!cursorBlockId) return null;
  return cursorBlockId;
}

function deriveThreadSectionFallbackTitle(
  bodyBlocks: ThreadSectionBlockLike[],
): string {
  if (bodyBlocks.length === 0) return "Untitled section";

  try {
    const nfmText = serializeNfm(blockNoteToNfm(bodyBlocks));
    const plainText = extractPlainText(nfmText).trim();
    if (plainText.length > 0) {
      const firstLine = plainText.split("\n")[0]?.trim() ?? "";
      if (firstLine.length > 0) return firstLine;
    }
  } catch {
    // Fall back to block metadata below.
  }

  const firstBlock = bodyBlocks[0];
  if (firstBlock?.type === "image") return "Image section";
  if (firstBlock?.type === "codeBlock") return "Code section";
  return "Untitled section";
}
