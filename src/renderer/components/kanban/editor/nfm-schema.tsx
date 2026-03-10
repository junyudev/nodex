import {
  BlockNoteSchema,
  createCodeBlockSpec,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from "@blocknote/core";
import { dualThemeCodeBlockOptions } from "./code-block-options";
import { createAttachmentInlineContentSpec } from "./attachment-chip";
import { createCalloutBlock } from "./callout-block";
import { createCardToggleBlockSpec } from "./card-toggle-block";
import { createCardRefBlockSpec } from "./card-ref-block";
import { imageBlockSpec } from "./image-block";
import { createToggleListInlineViewBlockSpec } from "./toggle-list-inline-view-block";

export const nfmSchema = BlockNoteSchema.create({
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    checkListItem: defaultBlockSpecs.checkListItem,
    toggleListItem: defaultBlockSpecs.toggleListItem,
    codeBlock: createCodeBlockSpec(dualThemeCodeBlockOptions),
    quote: defaultBlockSpecs.quote,
    divider: defaultBlockSpecs.divider,
    image: imageBlockSpec,
    callout: createCalloutBlock(),
    cardToggle: createCardToggleBlockSpec(),
    toggleListInlineView: createToggleListInlineViewBlockSpec(),
    cardRef: createCardRefBlockSpec(),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    attachment: createAttachmentInlineContentSpec(),
  },
  styleSpecs: defaultStyleSpecs,
});

export type NfmSchemaType = typeof nfmSchema;
