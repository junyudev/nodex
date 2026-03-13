// Notion-flavored Markdown types

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

export const NFM_COLORS: NfmColor[] = [
  ...NFM_TEXT_COLORS,
  ...NFM_BG_COLORS,
];

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

export type NfmInlineContent =
  | NfmTextSpan
  | NfmLinkSpan
  | NfmLineBreak
  | NfmAttachmentInlineContent;

export type NfmBlockType =
  | "paragraph"
  | "heading"
  | "bulletListItem"
  | "numberedListItem"
  | "checkListItem"
  | "toggle"
  | "blockquote"
  | "codeBlock"
  | "callout"
  | "image"
  | "toggleListInlineView"
  | "threadSection"
  | "cardToggle"
  | "cardRef"
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
}

export interface NfmToggleListInlineView extends NfmBlockBase {
  type: "toggleListInlineView";
  sourceProjectId: string;
  rulesV2B64?: string;
  propertyOrder?: Array<"priority" | "estimate" | "status" | "tags">;
  hiddenProperties?: Array<"priority" | "estimate" | "status" | "tags">;
  showEmptyEstimate?: boolean;
  showEmptyPriority?: boolean;
}

export interface NfmThreadSection extends NfmBlockBase {
  type: "threadSection";
  label?: string;
  threadId?: string;
}

export interface NfmCardRef extends NfmBlockBase {
  type: "cardRef";
  sourceProjectId: string;
  cardId: string;
}

export interface NfmCardToggle extends NfmBlockBase {
  type: "cardToggle";
  cardId: string;
  meta: string;
  snapshot?: string;
  sourceProjectId?: string;
  sourceStatus?: string;
  sourceStatusName?: string;
  content: NfmInlineContent[];
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
  | NfmCallout
  | NfmImage
  | NfmToggleListInlineView
  | NfmThreadSection
  | NfmCardToggle
  | NfmCardRef
  | NfmDivider
  | NfmEmptyBlock;

export function hasContent(
  block: NfmBlock,
): block is Extract<NfmBlock, { content: NfmInlineContent[] }> {
  return "content" in block && Array.isArray(block.content);
}
