import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultInlineContentSpecs,
  defaultStyleSpecs,
} from "@blocknote/core";
import { createReactInlineMathSpec, createReactMathBlockSpec } from "@blocknote/math-block";
import { editorCodeBlockOptions } from "./code-block-options";
import { createNfmCodeBlockSpec } from "./nfm-code-block-spec";
import { createAgentConfigInlineContentSpec } from "./agent-config-chip";
import { inlineImageInlineContentSpec } from "./inline-image-inline-content";
import { createAttachmentInlineContentSpec } from "./attachment-chip";
import { createCalloutBlock } from "./callout-block";
import { createCanvasBlockSpec } from "./canvas-block";
import { createPageBlockSpec, createPageRefBlockSpec } from "./page-outliner-block";
import { createDateMentionInlineContentSpec } from "./date-mention-inline-content-spec";
import { createDatabaseViewRefBlockSpec } from "./database-view-ref-block";
import { createDatabaseBlockSpec } from "./database-block";
import { imageBlockSpec } from "./image-block";
import { createThreadMentionInlineContentSpec } from "./thread-mention-chip";
import { createPageMentionInlineContentSpec } from "./page-mention-inline-content";
import { createSyncedBlockRefBlockSpec } from "./synced-block-ref-block";
import { createReusableTemplateRefBlockSpec } from "./document-bearing-shell-block";
import { BLOCK_CHILDREN_RULES } from "../../../../shared/block-documents/block-children-policy";
import {
  mathBlockConfig,
  mathInlineContentConfig,
} from "../../../../shared/block-documents/blocknote-schema-config";

export const nfmSchema = BlockNoteSchema.create({
  blockChildrenRules: BLOCK_CHILDREN_RULES,
  blockSpecs: {
    paragraph: defaultBlockSpecs.paragraph,
    heading: defaultBlockSpecs.heading,
    bulletListItem: defaultBlockSpecs.bulletListItem,
    numberedListItem: defaultBlockSpecs.numberedListItem,
    checkListItem: defaultBlockSpecs.checkListItem,
    toggleListItem: defaultBlockSpecs.toggleListItem,
    codeBlock: createNfmCodeBlockSpec(editorCodeBlockOptions),
    table: defaultBlockSpecs.table,
    quote: defaultBlockSpecs.quote,
    divider: defaultBlockSpecs.divider,
    image: imageBlockSpec(),
    callout: createCalloutBlock(),
    page: createPageBlockSpec(),
    database: createDatabaseBlockSpec(),
    canvas: createCanvasBlockSpec(),
    databaseViewRef: createDatabaseViewRefBlockSpec(),
    pageRef: createPageRefBlockSpec(),
    syncedBlockRef: createSyncedBlockRefBlockSpec(),
    templateRef: createReusableTemplateRefBlockSpec(),
    mathBlock: createReactMathBlockSpec(mathBlockConfig),
  },
  inlineContentSpecs: {
    ...defaultInlineContentSpecs,
    inlineImage: inlineImageInlineContentSpec,
    agentConfig: createAgentConfigInlineContentSpec(),
    attachment: createAttachmentInlineContentSpec(),
    dateMention: createDateMentionInlineContentSpec(),
    pageMention: createPageMentionInlineContentSpec(),
    threadMention: createThreadMentionInlineContentSpec(),
    math: createReactInlineMathSpec(mathInlineContentConfig),
  },
  styleSpecs: defaultStyleSpecs,
});

export type NfmSchemaType = typeof nfmSchema;
