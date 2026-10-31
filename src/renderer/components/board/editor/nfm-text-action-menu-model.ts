export {
  TEXT_ACTION_COLOR_VALUES,
  TEXT_ACTION_NOTION_COLOR_ORDER,
  type TextActionColorValue,
} from "@/lib/text-action-color-recents";

export type TextActionBasicStyle = "bold" | "italic" | "underline" | "strike" | "code";
export type TextActionStringStyle = "textColor" | "backgroundColor";

export const TEXT_ACTION_BASIC_STYLES = [
  "bold",
  "italic",
  "underline",
  "strike",
  "code",
] as const satisfies readonly TextActionBasicStyle[];

export interface TextActionMenuEligibilityInput {
  isEditable: boolean;
  isTableCellSelection: boolean;
  isBlockSelection?: boolean;
  hasInlineContent: boolean;
  selectedTextLength: number;
  selectionFrom: number;
  selectionTo: number;
}

export function shouldUseTextActionMenu(input: TextActionMenuEligibilityInput): boolean {
  if (!input.isEditable) return false;
  if (input.isTableCellSelection) return false;
  if (input.isBlockSelection) return false;
  if (!input.hasInlineContent) return false;
  if (input.selectedTextLength <= 0) return false;
  return input.selectionFrom !== input.selectionTo;
}

export function isBlockLevelSelection(selection: unknown): boolean {
  if (typeof selection !== "object" || selection === null) return false;

  const maybeBlockSelection = selection as {
    node?: unknown;
    nodes?: unknown;
  };

  return maybeBlockSelection.node !== undefined || Array.isArray(maybeBlockSelection.nodes);
}
