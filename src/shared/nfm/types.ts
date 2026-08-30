// Notion-flavored Markdown types
import type { NfmDateMentionDateFormat, NfmDateMentionTimeFormat } from "./date-mention";

export type NfmTextColor =
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red";

export type NfmBgColor =
  | "gray_bg"
  | "brown_bg"
  | "orange_bg"
  | "yellow_bg"
  | "green_bg"
  | "blue_bg"
  | "purple_bg"
  | "pink_bg"
  | "red_bg";

export type NfmColor = NfmTextColor | NfmBgColor;

export const NFM_TEXT_COLORS: NfmTextColor[] = [
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
];

export const NFM_BG_COLORS: NfmBgColor[] = [
  "gray_bg",
  "brown_bg",
  "orange_bg",
  "yellow_bg",
  "green_bg",
  "blue_bg",
  "purple_bg",
  "pink_bg",
  "red_bg",
];

export const NFM_COLORS: NfmColor[] = [...NFM_TEXT_COLORS, ...NFM_BG_COLORS];

export interface NfmStyleSet {
  bold?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  underline?: boolean;
  code?: boolean;
  color?: NfmColor;
}

export interface NfmTextSpan {
  type: "text";
  text: string;
  styles: NfmStyleSet;
}

export interface NfmLinkSpan {
  type: "link";
  text: string;
  href: string;
  styles: NfmStyleSet;
}

export interface NfmLineBreak {
  type: "linebreak";
}

export interface NfmMathInlineContent {
  type: "math";
  source: string;
}

export interface NfmAttachmentInlineContent {
  type: "attachment";
  kind: "text" | "file" | "folder";
  mode: "materialized" | "link";
  source: string;
  name: string;
  mimeType?: string;
  bytes?: number;
  origin?: string;
}

export interface NfmAgentConfigInlineContent {
  type: "agentConfig";
  mode?: string;
  model?: string;
  reasoning?: string;
  unknownAttributes?: string[];
  rawAttributes?: string;
}

export interface NfmThreadMentionInlineContent {
  type: "threadMention";
  uuid: string;
}

export interface NfmPageMentionInlineContent {
  type: "pageMention";
  targetPageId: string;
}

export interface NfmDateMentionInlineContent {
  type: "dateMention";
  start: string;
  end?: string;
  tz?: string;
  format?: NfmDateMentionDateFormat;
  timeFormat?: NfmDateMentionTimeFormat;
  reminder?: string;
}

export type NfmInlineContent =
  | NfmTextSpan
  | NfmLinkSpan
  | NfmLineBreak
  | NfmMathInlineContent
  | NfmAttachmentInlineContent
  | NfmAgentConfigInlineContent
  | NfmThreadMentionInlineContent
  | NfmPageMentionInlineContent
  | NfmDateMentionInlineContent;

export type NfmBlockType =
  | "paragraph"
  | "heading"
  | "bulletListItem"
  | "numberedListItem"
  | "checkListItem"
  | "toggle"
  | "blockquote"
  | "codeBlock"
  | "mathBlock"
  | "table"
  | "callout"
  | "image"
  | "canvas"
  | "database"
  | "databaseViewRef"
  | "syncedBlockRef"
  | "templateRef"
  | "threadSection"
  | "page"
  | "pageRef"
  | "divider"
  | "emptyBlock";

interface NfmBlockBase {
  type: NfmBlockType;
  color?: NfmColor;
  children: NfmBlock[];
}

export interface NfmParagraph extends NfmBlockBase {
  type: "paragraph";
  content: NfmInlineContent[];
}

export interface NfmHeading extends NfmBlockBase {
  type: "heading";
  level: 1 | 2 | 3 | 4;
  isToggleable?: boolean;
  isOpen?: boolean;
  content: NfmInlineContent[];
}

export interface NfmBulletListItem extends NfmBlockBase {
  type: "bulletListItem";
  content: NfmInlineContent[];
}

export interface NfmNumberedListItem extends NfmBlockBase {
  type: "numberedListItem";
  start?: number;
  content: NfmInlineContent[];
}

export interface NfmCheckListItem extends NfmBlockBase {
  type: "checkListItem";
  checked: boolean;
  content: NfmInlineContent[];
}

export interface NfmToggle extends NfmBlockBase {
  type: "toggle";
  isOpen?: boolean;
  content: NfmInlineContent[];
}

export interface NfmBlockquote extends NfmBlockBase {
  type: "blockquote";
  content: NfmInlineContent[];
}

export interface NfmCodeBlock extends NfmBlockBase {
  type: "codeBlock";
  language: string;
  code: string;
}

export interface NfmMathBlock extends NfmBlockBase {
  type: "mathBlock";
  source: string;
}

export type NfmTableAlignment = "left" | "center" | "right";

export interface NfmTableColumn {
  width?: number;
  color?: NfmColor;
  align?: NfmTableAlignment;
}

export interface NfmTableCell {
  content: NfmInlineContent[];
  color?: NfmColor;
  colspan?: number;
  rowspan?: number;
}

export interface NfmTableRow {
  cells: NfmTableCell[];
  color?: NfmColor;
}

export interface NfmTable extends NfmBlockBase {
  type: "table";
  rows: NfmTableRow[];
  columns: NfmTableColumn[];
  headerRow?: boolean;
  headerColumn?: boolean;
  fitPageWidth?: boolean;
  sourceSyntax?: "gfm" | "nfmTable";
}

export interface NfmCallout extends NfmBlockBase {
  type: "callout";
  icon?: string;
  content: NfmInlineContent[];
}

export interface NfmImage extends NfmBlockBase {
  type: "image";
  source: string;
  caption: NfmInlineContent[];
  previewWidth?: number;
  sourceWidth?: number;
  sourceHeight?: number;
}

export interface NfmDatabaseViewRef extends NfmBlockBase {
  type: "databaseViewRef";
  databaseViewId: string;
  displayHint?: string;
}

export interface NfmDatabase extends NfmBlockBase {
  type: "database";
  /** Owning Database Container shell identity. */
  uuid: string;
}

export interface NfmCanvas extends NfmBlockBase {
  type: "canvas";
  /** Owning Canvas shell identity. */
  uuid: string;
}

export interface NfmSyncedBlockRef extends NfmBlockBase {
  type: "syncedBlockRef";
  sourceBlockId: string;
}

export interface NfmReusableTemplateRef extends NfmBlockBase {
  type: "templateRef";
  sourceBlockId: string;
  displayHint?: string;
}

export interface NfmThreadSection extends NfmBlockBase {
  type: "threadSection";
  label?: string;
  threadId?: string;
}

export interface NfmPage extends NfmBlockBase {
  type: "page";
  /** Owning Page shell identity. */
  uuid: string;
}

export interface NfmPageRef extends NfmBlockBase {
  type: "pageRef";
  targetBlockId: string;
}

export interface NfmDivider extends NfmBlockBase {
  type: "divider";
}

export interface NfmEmptyBlock extends NfmBlockBase {
  type: "emptyBlock";
}

export type NfmBlock =
  | NfmParagraph
  | NfmHeading
  | NfmBulletListItem
  | NfmNumberedListItem
  | NfmCheckListItem
  | NfmToggle
  | NfmBlockquote
  | NfmCodeBlock
  | NfmMathBlock
  | NfmTable
  | NfmCallout
  | NfmImage
  | NfmCanvas
  | NfmDatabase
  | NfmDatabaseViewRef
  | NfmSyncedBlockRef
  | NfmReusableTemplateRef
  | NfmThreadSection
  | NfmPage
  | NfmPageRef
  | NfmDivider
  | NfmEmptyBlock;

export function hasContent(
  block: NfmBlock,
): block is Extract<NfmBlock, { content: NfmInlineContent[] }> {
  return "content" in block && Array.isArray(block.content);
}
