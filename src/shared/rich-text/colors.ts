export type RichTextTextColor =
  | "gray"
  | "brown"
  | "orange"
  | "yellow"
  | "green"
  | "blue"
  | "purple"
  | "pink"
  | "red";

export type RichTextBackgroundColor =
  | "gray_bg"
  | "brown_bg"
  | "orange_bg"
  | "yellow_bg"
  | "green_bg"
  | "blue_bg"
  | "purple_bg"
  | "pink_bg"
  | "red_bg";

export type RichTextColor = RichTextTextColor | RichTextBackgroundColor;

export const RICH_TEXT_COLORS: RichTextTextColor[] = [
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

export const RICH_TEXT_BACKGROUND_COLORS: RichTextBackgroundColor[] = [
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

export const RICH_TEXT_ALL_COLORS: RichTextColor[] = [
  ...RICH_TEXT_COLORS,
  ...RICH_TEXT_BACKGROUND_COLORS,
];
