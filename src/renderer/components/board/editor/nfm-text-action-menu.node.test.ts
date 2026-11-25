import { describe, expect, test } from "vite-plus/test";
import {
  applyTextActionBlockType,
  applyTextActionClearFormat,
  applyTextActionStringStyle,
  applyTextActionToggleStyle,
  buildTextActionClearFormatStyles,
  type TextActionEditorAdapter,
} from "./nfm-text-action-menu-actions";
import {
  TEXT_ACTION_BASIC_STYLES,
  isBlockLevelSelection,
  shouldUseTextActionMenu,
} from "./nfm-text-action-menu-model";

describe("nfm text action menu actions", () => {
  function createFakeEditor() {
    const calls: string[] = [];
    const editor: TextActionEditorAdapter = {
      schema: {
        styleSchema: {
          bold: { propSchema: "boolean" },
          italic: { propSchema: "boolean" },
          textColor: { propSchema: "string" },
          backgroundColor: { propSchema: "string" },
        },
      },
      focus: () => {
        calls.push("focus");
      },
      transact: (callback) => {
        calls.push("transact:start");
        callback();
        calls.push("transact:end");
      },
      updateBlock: (block, update) => {
        const blockId =
          typeof block === "object" && block !== null && "id" in block
            ? String(block.id)
            : "unknown";
        calls.push(`updateBlock:${blockId}:${update.type}:${JSON.stringify(update.props ?? {})}`);
      },
      toggleStyles: (styles) => {
        calls.push(`toggleStyles:${Object.keys(styles).sort().join(",")}`);
      },
      addStyles: (styles) => {
        calls.push(
          `addStyles:${Object.entries(styles)
            .map(([key, value]) => `${key}=${value}`)
            .join(",")}`,
        );
      },
      removeStyles: (styles) => {
        calls.push(`removeStyles:${Object.keys(styles).sort().join(",")}`);
      },
    };

    return { calls, editor };
  }

  describe("markdown text action menu actions", () => {
    test("converts selected blocks inside the editor transaction boundary", () => {
      const { calls, editor } = createFakeEditor();

      const didApply = applyTextActionBlockType(editor, [{ id: "a" }, { id: "b" }], {
        type: "heading",
        props: { level: 1, isToggleable: false },
      });

      expect(didApply).toBe(true);
      expect(calls.join("|")).toBe(
        'focus|transact:start|updateBlock:a:heading:{"level":1,"isToggleable":false}|updateBlock:b:heading:{"level":1,"isToggleable":false}|transact:end',
      );
    });

    test("toggles only schema-supported boolean styles", () => {
      const { calls, editor } = createFakeEditor();

      expect(applyTextActionToggleStyle(editor, "bold")).toBe(true);
      expect(applyTextActionToggleStyle(editor, "code")).toBe(false);
      expect(calls.join("|")).toBe("focus|toggleStyles:bold");
    });

    test("sets and removes string styles through BlockNote style helpers", () => {
      const { calls, editor } = createFakeEditor();

      expect(
        applyTextActionStringStyle(editor, "textColor", "blue", true, () => {
          calls.push("refocus");
        }),
      ).toBe(true);
      expect(
        applyTextActionStringStyle(editor, "backgroundColor", "default", true, () => {
          calls.push("refocus");
        }),
      ).toBe(true);
      expect(
        applyTextActionStringStyle(editor, "textColor", "red", false, () => {
          calls.push("blocked-refocus");
        }),
      ).toBe(false);
      expect(calls.join("|")).toBe(
        "addStyles:textColor=blue|refocus|removeStyles:backgroundColor|refocus",
      );
    });

    test("builds and applies schema-filtered clear-format operations", () => {
      const { calls, editor } = createFakeEditor();

      const styles = buildTextActionClearFormatStyles(editor, TEXT_ACTION_BASIC_STYLES, {
        canUseTextColor: true,
        canUseBackgroundColor: true,
      });

      expect(Object.keys(styles).sort().join(",")).toBe("backgroundColor,bold,italic,textColor");
      expect(
        applyTextActionClearFormat(editor, TEXT_ACTION_BASIC_STYLES, {
          canUseTextColor: true,
          canUseBackgroundColor: true,
        }),
      ).toBe(true);
      expect(calls.join("|")).toBe("focus|removeStyles:backgroundColor,bold,italic,textColor");
    });

    test("does not clear format when no supported style exists", () => {
      const { calls, editor } = createFakeEditor();
      editor.schema.styleSchema = {};

      expect(
        applyTextActionClearFormat(editor, TEXT_ACTION_BASIC_STYLES, {
          canUseTextColor: false,
          canUseBackgroundColor: false,
        }),
      ).toBe(false);
      expect(calls.length).toBe(0);
    });
  });
});

describe("markdown text action menu model", () => {
  test("uses the Notion-style menu only for editable expanded rich-text selections", () => {
    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: false,
        hasInlineContent: true,
        selectedTextLength: 5,
        selectionFrom: 3,
        selectionTo: 8,
      }),
    ).toBe(true);

    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: false,
        hasInlineContent: true,
        selectedTextLength: 0,
        selectionFrom: 3,
        selectionTo: 3,
      }),
    ).toBe(false);

    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: false,
        hasInlineContent: true,
        selectedTextLength: 0,
        selectionFrom: 3,
        selectionTo: 8,
      }),
    ).toBe(false);

    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: true,
        hasInlineContent: true,
        selectedTextLength: 5,
        selectionFrom: 3,
        selectionTo: 8,
      }),
    ).toBe(false);

    expect(
      shouldUseTextActionMenu({
        isEditable: true,
        isTableCellSelection: false,
        isBlockSelection: true,
        hasInlineContent: true,
        selectedTextLength: 5,
        selectionFrom: 3,
        selectionTo: 8,
      }),
    ).toBe(false);
  });

  test("recognizes ProseMirror block-level selections", () => {
    expect(isBlockLevelSelection({ node: { attrs: { id: "single" } } })).toBe(true);
    expect(isBlockLevelSelection({ nodes: [{ attrs: { id: "a" } }] })).toBe(true);
    expect(isBlockLevelSelection({ from: 1, to: 2 })).toBe(false);
  });
});
