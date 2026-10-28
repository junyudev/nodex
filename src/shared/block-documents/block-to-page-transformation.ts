import type { BlockId } from "./contracts";
import { createCanonicalEmptyParagraphBlock, type BlockTreeNode } from "./block-document-codec";
import {
  assessBlockSemanticContentForPage,
  type BlockSemanticContentAssessment,
} from "./block-semantic-content";
import {
  canonicalizePortableRichText,
  plainTextToPortableRichText,
  portableRichTextPlainText,
  type PortableRichText,
} from "./portable-rich-text";
import { blockNoteInlineToPortableRichText } from "./blocknote-rich-text";

export type BlockToPageTransformation =
  | {
      readonly kind: "promote";
      readonly pageId: BlockId;
      readonly richTitle: PortableRichText;
      readonly bodyRoots: readonly BlockTreeNode[];
      readonly consumedType: string;
      readonly consumedProps: Readonly<Record<string, unknown>>;
      readonly placeholderBlockId: BlockId | null;
    }
  | {
      readonly kind: "wrap";
      readonly pageId: BlockId;
      readonly wrappedRoot: BlockTreeNode;
      readonly richTitle: PortableRichText;
      readonly reason: Extract<BlockSemanticContentAssessment, { kind: "wrap" }>["reason"];
      readonly detail: string;
    }
  | {
      readonly kind: "already_page";
      readonly pageId: BlockId;
    };

export const planBlockToPageTransformation = (input: {
  readonly root: BlockTreeNode;
  readonly resultRootId: BlockId;
  readonly wrapperPageId: BlockId;
  readonly allocateEmptyBodyBlockId: () => BlockId;
}): BlockToPageTransformation => {
  const assessment = assessBlockSemanticContentForPage(input.root);
  if (assessment.kind === "already_page") {
    return { kind: "already_page", pageId: input.resultRootId };
  }
  if (assessment.kind === "wrap") {
    let richTitle: PortableRichText = plainTextToPortableRichText(input.root.type);
    try {
      const candidate = canonicalizePortableRichText(
        blockNoteInlineToPortableRichText(input.root.content),
      );
      if (portableRichTextPlainText(candidate).trim().length > 0) {
        richTitle = candidate;
      }
    } catch {
      // The complete wrapped root remains authority; a type label is lossless.
    }
    return {
      kind: "wrap",
      pageId: input.wrapperPageId,
      wrappedRoot: input.root,
      richTitle,
      reason: assessment.reason,
      detail: assessment.detail,
    };
  }
  if (assessment.children.length > 0) {
    return {
      kind: "promote",
      pageId: input.resultRootId,
      richTitle: assessment.primary,
      bodyRoots: assessment.children,
      consumedType: assessment.consumedType,
      consumedProps: assessment.consumedProps,
      placeholderBlockId: null,
    };
  }
  const placeholderBlockId = input.allocateEmptyBodyBlockId();
  return {
    kind: "promote",
    pageId: input.resultRootId,
    richTitle: assessment.primary,
    bodyRoots: [createCanonicalEmptyParagraphBlock(placeholderBlockId)],
    consumedType: assessment.consumedType,
    consumedProps: assessment.consumedProps,
    placeholderBlockId,
  };
};
