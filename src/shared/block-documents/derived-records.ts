import { parseAssetSource } from "../assets";
import { parsePageDeepLink } from "../nodex-deeplink";
import type { MarkdownInline } from "../nodex-markdown";
import type { BlockTreeNode } from "./block-document-codec";
import { MAX_BLOCK_ID_LENGTH, MAX_REFERENCE_DISPLAY_HINT_LENGTH, type BlockId } from "./contracts";

export type BlockDocumentReference =
  | {
      readonly kind: "page";
      readonly sourceBlockId: BlockId;
      readonly targetPageId: string;
      readonly presentation: "mention" | "reference_block" | "link";
      readonly occurrenceCount: number;
    }
  | {
      readonly kind: "block";
      readonly sourceBlockId: BlockId;
      readonly targetBlockId: BlockId;
      readonly displayHint?: string;
    }
  | {
      readonly kind: "database_view";
      readonly sourceBlockId: BlockId;
      readonly databaseViewId: string;
      readonly displayHint?: string;
    }
  | {
      readonly kind: "session";
      readonly sourceBlockId: BlockId;
      readonly targetSessionId: string;
    };

export interface BlockDocumentAssetReference {
  readonly sourceBlockId: BlockId;
  readonly kind: "image" | "attachment";
  readonly source: string;
  readonly managedFileName: string | null;
}

export interface BlockDocumentDerivedRecords {
  readonly references: readonly BlockDocumentReference[];
  readonly assetRefs: readonly BlockDocumentAssetReference[];
}

export class BlockDocumentDerivedRecordsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockDocumentDerivedRecordsError";
  }
}

const assertCanonicalReferenceId = (value: string, label: string): void => {
  if (value.length === 0 || value !== value.trim() || value.length > MAX_BLOCK_ID_LENGTH) {
    throw new BlockDocumentDerivedRecordsError(
      `${label} must be a non-empty stable identity no longer than ${MAX_BLOCK_ID_LENGTH} characters`,
    );
  }
};

const readDisplayHint = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > MAX_REFERENCE_DISPLAY_HINT_LENGTH) {
    throw new BlockDocumentDerivedRecordsError(
      `Reference display hints must not exceed ${MAX_REFERENCE_DISPLAY_HINT_LENGTH} characters`,
    );
  }
  return value;
};

const appendResolvedAssetReference = (
  assetRefs: BlockDocumentAssetReference[],
  input: Omit<BlockDocumentAssetReference, "managedFileName">,
): void => {
  // BlockNote inserts file Blocks before the asynchronous upload resolves.
  // The empty source is valid collaborative content, but it does not yet
  // identify an asset and therefore must not enter the asset projection.
  if (input.source.length === 0) return;

  assetRefs.push({
    ...input,
    managedFileName: parseAssetSource(input.source)?.fileName ?? null,
  });
};

const appendPageReference = (
  references: BlockDocumentReference[],
  input: Extract<BlockDocumentReference, { readonly kind: "page" }>,
): void => {
  const existingIndex = references.findIndex(
    (reference) =>
      reference.kind === "page" &&
      reference.sourceBlockId === input.sourceBlockId &&
      reference.targetPageId === input.targetPageId &&
      reference.presentation === input.presentation,
  );
  if (existingIndex === -1) {
    references.push(input);
    return;
  }
  const existing = references[existingIndex];
  if (existing?.kind !== "page") return;
  references[existingIndex] = {
    ...existing,
    occurrenceCount: existing.occurrenceCount + input.occurrenceCount,
  };
};

const collectInlineReferences = (
  sourceBlockId: BlockId,
  content: unknown,
  references: BlockDocumentReference[],
  assetRefs: BlockDocumentAssetReference[],
): void => {
  if (!Array.isArray(content)) return;
  for (const item of content as MarkdownInline[]) {
    const props = item.props ?? {};
    if (item.type === "threadMention") {
      const targetSessionId = String(props.uuid ?? "");
      assertCanonicalReferenceId(targetSessionId, "targetSessionId");
      references.push({ kind: "session", sourceBlockId, targetSessionId });
    } else if (item.type === "pageMention") {
      const targetPageId = String(props.targetPageId ?? "");
      assertCanonicalReferenceId(targetPageId, "targetPageId");
      appendPageReference(references, {
        kind: "page",
        sourceBlockId,
        targetPageId,
        presentation: "mention",
        occurrenceCount: 1,
      });
    } else if (item.type === "link") {
      const target = parsePageDeepLink(item.href ?? "");
      if (target)
        appendPageReference(references, {
          kind: "page",
          sourceBlockId,
          targetPageId: target.pageId,
          presentation: "link",
          occurrenceCount: 1,
        });
      collectInlineReferences(sourceBlockId, item.content, references, assetRefs);
    } else if (item.type === "attachment" || item.type === "inlineImage") {
      appendResolvedAssetReference(assetRefs, {
        sourceBlockId,
        kind: item.type === "attachment" ? "attachment" : "image",
        source: String(props[item.type === "attachment" ? "source" : "url"] ?? ""),
      });
    }
  }
};

/** Derive references from canonical BlockNote JSON, including linked inline images and cells. */
export const deriveBlockDocumentRecords = (
  blockTree: readonly BlockTreeNode[],
): BlockDocumentDerivedRecords => {
  const references: BlockDocumentReference[] = [];
  const assetRefs: BlockDocumentAssetReference[] = [];
  const visit = (blocks: readonly BlockTreeNode[]): void => {
    for (const block of blocks) {
      collectInlineReferences(block.id, block.content, references, assetRefs);
      if (
        block.type === "table" &&
        block.content &&
        typeof block.content === "object" &&
        !Array.isArray(block.content)
      ) {
        const table = block.content as { rows?: { cells: { content?: unknown }[] }[] };
        for (const row of table.rows ?? [])
          for (const cell of row.cells)
            collectInlineReferences(block.id, cell.content, references, assetRefs);
      }
      if (block.type === "image")
        appendResolvedAssetReference(assetRefs, {
          sourceBlockId: block.id,
          kind: "image",
          source: String(block.props.url ?? ""),
        });
      if (block.type === "pageRef") {
        const targetPageId = String(block.props.targetBlockId ?? "");
        assertCanonicalReferenceId(targetPageId, "targetBlockId");
        appendPageReference(references, {
          kind: "page",
          sourceBlockId: block.id,
          targetPageId,
          presentation: "reference_block",
          occurrenceCount: 1,
        });
      }
      if (block.type === "databaseViewRef") {
        const databaseViewId = String(block.props.databaseViewId ?? "");
        assertCanonicalReferenceId(databaseViewId, "databaseViewId");
        const displayHint = readDisplayHint(block.props.displayHint as string | undefined);
        references.push({
          kind: "database_view",
          sourceBlockId: block.id,
          databaseViewId,
          ...(displayHint ? { displayHint } : {}),
        });
      }
      if (block.type === "syncedBlockRef" || block.type === "templateRef") {
        const targetBlockId = String(block.props.sourceBlockId ?? "");
        assertCanonicalReferenceId(targetBlockId, "sourceBlockId");
        const displayHint = readDisplayHint(block.props.displayHint as string | undefined);
        references.push({
          kind: "block",
          sourceBlockId: block.id,
          targetBlockId,
          ...(displayHint ? { displayHint } : {}),
        });
      }
      visit(block.children);
    }
  };
  visit(blockTree);
  return { references, assetRefs };
};
