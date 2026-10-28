import type { BlockTreeNode } from "./block-document-codec";
import { blockNoteInlineToPortableRichText } from "./blocknote-rich-text";
import {
  canonicalizePortableRichText,
  PortableRichTextError,
  type PortableRichText,
} from "./portable-rich-text";

export type BlockToPageTypeCapability = "promote_primary" | "wrap_subtree" | "already_page";

export const BLOCK_TO_PAGE_TYPE_CAPABILITIES = {
  paragraph: "promote_primary",
  heading: "promote_primary",
  bulletListItem: "promote_primary",
  numberedListItem: "promote_primary",
  checkListItem: "wrap_subtree",
  toggleListItem: "promote_primary",
  codeBlock: "wrap_subtree",
  mathBlock: "wrap_subtree",
  table: "wrap_subtree",
  quote: "promote_primary",
  divider: "wrap_subtree",
  image: "wrap_subtree",
  callout: "wrap_subtree",
  page: "already_page",
  canvas: "wrap_subtree",
  database: "wrap_subtree",
  pageRef: "wrap_subtree",
  databaseViewRef: "wrap_subtree",
  syncedBlockRef: "wrap_subtree",
  templateRef: "wrap_subtree",
} as const satisfies Readonly<Record<string, BlockToPageTypeCapability>>;

export type BlockToPageRegisteredType = keyof typeof BLOCK_TO_PAGE_TYPE_CAPABILITIES;

export type BlockSemanticContentAssessment =
  | {
      readonly kind: "promote";
      readonly primary: PortableRichText;
      readonly children: readonly BlockTreeNode[];
      readonly consumedType: string;
      readonly consumedProps: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "wrap";
      readonly reason:
        | "type_requires_wrapper"
        | "unsupported_primary_content"
        | "unmapped_type_state";
      readonly detail: string;
    }
  | {
      readonly kind: "already_page";
    };

export class BlockSemanticContentError extends TypeError {
  constructor(
    readonly code: "unknown_block_type",
    message: string,
  ) {
    super(message);
    this.name = "BlockSemanticContentError";
  }
}

const typeCapability = (blockType: string): BlockToPageTypeCapability => {
  if (Object.hasOwn(BLOCK_TO_PAGE_TYPE_CAPABILITIES, blockType)) {
    return BLOCK_TO_PAGE_TYPE_CAPABILITIES[blockType as BlockToPageRegisteredType];
  }
  throw new BlockSemanticContentError(
    "unknown_block_type",
    `Block type ${blockType} has no Page transformation capability`,
  );
};

const presentationPropsForPromotion = (root: BlockTreeNode): Readonly<Record<string, unknown>> => {
  const props: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root.props)) {
    if (
      key === "backgroundColor" ||
      key === "textColor" ||
      key === "textAlignment" ||
      key === "level" ||
      key === "isToggleable" ||
      key === "start"
    ) {
      props[key] = value;
      continue;
    }
    return { unsupportedProperty: key };
  }
  return props;
};

export const assessBlockSemanticContentForPage = (
  root: BlockTreeNode,
): BlockSemanticContentAssessment => {
  const capability = typeCapability(root.type);
  if (capability === "already_page") return { kind: "already_page" };
  if (capability === "wrap_subtree") {
    return {
      kind: "wrap",
      reason: "type_requires_wrapper",
      detail: `${root.type} preserves its complete subtree under a wrapper Page`,
    };
  }
  const consumedProps = presentationPropsForPromotion(root);
  if ("unsupportedProperty" in consumedProps) {
    return {
      kind: "wrap",
      reason: "unmapped_type_state",
      detail: `${root.type} property ${String(consumedProps.unsupportedProperty)} has no Page mapping`,
    };
  }
  try {
    const primary = canonicalizePortableRichText(blockNoteInlineToPortableRichText(root.content));
    return {
      kind: "promote",
      primary,
      children: root.children,
      consumedType: root.type,
      consumedProps,
    };
  } catch (error) {
    if (!(error instanceof PortableRichTextError)) throw error;
    return {
      kind: "wrap",
      reason: "unsupported_primary_content",
      detail: error.message,
    };
  }
};
