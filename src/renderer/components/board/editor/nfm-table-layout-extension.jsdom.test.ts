import { BlockNoteEditor, getNodeById } from "@blocknote/core";
import { describe, expect, test } from "vite-plus/test";
import { nfmTableLayoutExtension } from "./nfm-table-layout-extension";

function tableBlock(id: string, cells: string[], columnWidths?: (number | undefined)[]) {
  return {
    id,
    type: "table" as const,
    content: {
      type: "tableContent" as const,
      rows: [{ cells: cells.map((text) => [text]) }],
      columnWidths,
      headerRows: 1,
    },
  };
}

describe("NFM table editor layout", () => {
  test("decorates the actual table wrapper and header cells, then updates them after edits", () => {
    const editor = BlockNoteEditor.create({
      tables: { headers: true },
      extensions: [nfmTableLayoutExtension],
      initialContent: [
        { id: "intro", type: "paragraph", content: "Intro" },
        tableBlock("measurements", ["小", ""]),
        tableBlock("second-table", ["Kept"], [120]),
      ],
    });
    const mount = document.createElement("div");
    editor.mount(mount);
    try {
      const wrappers = mount.querySelectorAll<HTMLElement>(
        '.bn-block-content[data-content-type="table"]',
      );
      const [first, second] = wrappers;
      expect(first?.dataset.nfmTableLayout).toBe("auto");
      expect(first?.querySelector("th:first-child")?.getAttribute("data-nfm-cell-fit")).toBe(
        "short",
      );
      expect(first?.querySelector("th:last-child")?.getAttribute("data-nfm-cell-fit")).toBe(
        "blank",
      );
      expect(second?.dataset.nfmTableLayout).toBe("pinned");
      expect(second?.querySelector("th")?.hasAttribute("data-nfm-cell-fit")).toBe(false);

      const view = editor.prosemirrorView;
      if (!view) throw new Error("Expected a mounted editor view");
      const { state } = view;
      const firstTable = getNodeById("measurements", state.doc);
      const intro = getNodeById("intro", state.doc);
      if (!firstTable || !intro) throw new Error("Missing test blocks");
      const firstCell = firstTable.posBeforeNode + 3;
      view.dispatch(
        state.tr
          .setNodeAttribute(firstCell, "colwidth", [90])
          .insertText("Before ", intro.posBeforeNode + 2),
      );

      expect(first?.dataset.nfmTableLayout).toBe("mixed");
      expect(first?.querySelector("th:first-child")?.hasAttribute("data-nfm-cell-fit")).toBe(false);
      expect(second?.dataset.nfmTableLayout).toBe("pinned");

      editor.updateBlock("measurements", {
        content: tableBlock("measurements", ["漢".repeat(11), "OK"]).content,
      });
      expect(first?.dataset.nfmTableLayout).toBe("auto");
      expect(first?.querySelector("th:first-child")?.getAttribute("data-nfm-cell-fit")).toBe(
        "long",
      );
      expect(first?.querySelector("th:last-child")?.getAttribute("data-nfm-cell-fit")).toBe(
        "short",
      );
      expect(second?.dataset.nfmTableLayout).toBe("pinned");
    } finally {
      editor._tiptapEditor.destroy();
    }
  });
});
