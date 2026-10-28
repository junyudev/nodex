import { describe, expect, test } from "vite-plus/test";
import {
  resolveNfmFormattingToolbarPresentation,
  shouldSuppressNfmFormattingToolbarForSelection,
  shouldUseNfmLegacyFormattingToolbar,
} from "./nfm-formatting-toolbar-controller";
import { shouldRenderNfmLegacyFormattingToolbarItem } from "./nfm-formatting-toolbar";
import type { TextActionMenuEligibilityInput } from "./nfm-text-action-menu-model";

const SELECTION_RANGE = { from: 4, to: 10 };

function makeTextActionEligibility(
  input: Partial<TextActionMenuEligibilityInput> = {},
): TextActionMenuEligibilityInput {
  return {
    isEditable: true,
    isTableCellSelection: false,
    isBlockSelection: false,
    hasInlineContent: true,
    selectedTextLength: 6,
    selectionFrom: SELECTION_RANGE.from,
    selectionTo: SELECTION_RANGE.to,
    ...input,
  };
}

describe("markdown formatting toolbar", () => {
  test("opens the text-action menu for expanded rich-text selections", () => {
    const presentation = resolveNfmFormattingToolbarPresentation({
      show: true,
      selectionRange: SELECTION_RANGE,
      suppressionRange: null,
      textActionEligibility: makeTextActionEligibility(),
      legacyEligibility: true,
    });

    expect(presentation.open).toBe(true);
    if (!presentation.open) return;
    expect(presentation.mode).toBe("text-action");
    expect(presentation.position.from).toBe(SELECTION_RANGE.from);
    expect(presentation.position.to).toBe(SELECTION_RANGE.to);
  });

  test("closes collapsed rich-text selections even when BlockNote still reports show", () => {
    const presentation = resolveNfmFormattingToolbarPresentation({
      show: true,
      selectionRange: { from: 6, to: 6 },
      suppressionRange: null,
      textActionEligibility: makeTextActionEligibility({
        selectedTextLength: 0,
        selectionFrom: 6,
        selectionTo: 6,
      }),
      legacyEligibility: false,
    });

    expect(presentation.open).toBe(false);
  });

  test("keeps the toolbar closed when legacy eligibility is stale for a collapsed selection", () => {
    const presentation = resolveNfmFormattingToolbarPresentation({
      show: true,
      selectionRange: { from: 6, to: 6 },
      suppressionRange: null,
      textActionEligibility: makeTextActionEligibility({
        selectedTextLength: 0,
        selectionFrom: 6,
        selectionTo: 6,
      }),
      legacyEligibility: true,
    });

    expect(presentation.open).toBe(false);
  });

  test("opens the legacy toolbar only for non-text node action selections", () => {
    const presentation = resolveNfmFormattingToolbarPresentation({
      show: true,
      selectionRange: SELECTION_RANGE,
      suppressionRange: null,
      textActionEligibility: makeTextActionEligibility({
        hasInlineContent: false,
        selectedTextLength: 0,
      }),
      legacyEligibility: true,
    });

    expect(presentation.open).toBe(true);
    if (!presentation.open) return;
    expect(presentation.mode).toBe("legacy");
  });

  test("suppresses only the dismissed side-menu selection range", () => {
    expect(
      shouldSuppressNfmFormattingToolbarForSelection({
        show: true,
        selectionRange: { from: 4, to: 10 },
        suppressionRange: { from: 4, to: 10 },
      }),
    ).toBe(true);

    expect(
      shouldSuppressNfmFormattingToolbarForSelection({
        show: true,
        selectionRange: { from: 4, to: 11 },
        suppressionRange: { from: 4, to: 10 },
      }),
    ).toBe(false);

    expect(
      shouldSuppressNfmFormattingToolbarForSelection({
        show: false,
        selectionRange: { from: 4, to: 10 },
        suppressionRange: { from: 4, to: 10 },
      }),
    ).toBe(false);

    expect(
      resolveNfmFormattingToolbarPresentation({
        show: true,
        selectionRange: SELECTION_RANGE,
        suppressionRange: SELECTION_RANGE,
        textActionEligibility: makeTextActionEligibility(),
        legacyEligibility: false,
      }).open,
    ).toBe(false);
  });

  test("keeps legacy eligibility scoped to table, block, and media selections", () => {
    expect(
      shouldUseNfmLegacyFormattingToolbar({
        isEditable: true,
        isSelectionEmpty: true,
        isTableCellSelection: false,
        isBlockSelection: false,
        selectedBlocks: [{ type: "paragraph", content: [] }],
      }),
    ).toBe(false);

    expect(
      shouldUseNfmLegacyFormattingToolbar({
        isEditable: true,
        isSelectionEmpty: false,
        isTableCellSelection: false,
        isBlockSelection: false,
        selectedBlocks: [{ type: "image", props: { url: "nodex://assets/image.png" } }],
      }),
    ).toBe(true);

    expect(
      shouldUseNfmLegacyFormattingToolbar({
        isEditable: true,
        isSelectionEmpty: false,
        isTableCellSelection: true,
        isBlockSelection: false,
        selectedBlocks: [{ type: "table", content: [] }],
      }),
    ).toBe(true);

    expect(
      shouldUseNfmLegacyFormattingToolbar({
        isEditable: true,
        isSelectionEmpty: false,
        isTableCellSelection: false,
        isBlockSelection: true,
        selectedBlocks: [{ type: "paragraph", content: [] }],
      }),
    ).toBe(false);

    expect(
      shouldUseNfmLegacyFormattingToolbar({
        isEditable: true,
        isSelectionEmpty: false,
        isTableCellSelection: false,
        isBlockSelection: true,
        selectedBlocks: [{ type: "image", props: { url: "nodex://assets/image.png" } }],
      }),
    ).toBe(true);

    expect(
      shouldUseNfmLegacyFormattingToolbar({
        isEditable: false,
        isSelectionEmpty: false,
        isTableCellSelection: false,
        isBlockSelection: true,
        selectedBlocks: [{ type: "image", props: { url: "nodex://assets/image.png" } }],
      }),
    ).toBe(false);
  });

  test("omits unsupported actions from the legacy image/file toolbar", () => {
    expect(shouldRenderNfmLegacyFormattingToolbarItem("fileRenameButton")).toBe(false);
    expect(shouldRenderNfmLegacyFormattingToolbarItem("textAlignLeftButton")).toBe(false);
    expect(shouldRenderNfmLegacyFormattingToolbarItem("textAlignCenterButton")).toBe(false);
    expect(shouldRenderNfmLegacyFormattingToolbarItem("textAlignRightButton")).toBe(false);
    expect(shouldRenderNfmLegacyFormattingToolbarItem("fileDownloadButton")).toBe(true);
    expect(shouldRenderNfmLegacyFormattingToolbarItem("replaceFileButton")).toBe(true);
  });
});
