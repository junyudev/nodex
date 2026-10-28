import { describe, expect, test } from "vite-plus/test";

import {
  clearNfmTableTarget,
  duplicateNfmTableTarget,
  type NfmTableCell,
  type NfmTableContent,
} from "./nfm-table-operations";

function textCell(text: string, backgroundColor = "default"): NfmTableCell {
  return {
    type: "tableCell",
    props: {
      backgroundColor,
      textColor: "default",
      textAlignment: "left",
      colspan: 1,
      rowspan: 1,
    },
    content: [{ type: "text", text, styles: {} }],
  };
}

function tableContent(): NfmTableContent {
  return {
    type: "tableContent",
    columnWidths: [120, 180],
    headerRows: 1,
    rows: [
      { cells: [textCell("A1", "blue"), textCell("B1")] },
      { cells: [textCell("A2"), textCell("B2", "yellow")] },
    ],
  };
}

function cellText(content: NfmTableContent, row: number, column: number) {
  const cell = content.rows[row]?.cells[column];
  if (!cell || Array.isArray(cell)) return "";

  return cell.content.map((item) => (item.type === "text" ? item.text : "")).join("");
}

function cellBackground(content: NfmTableContent, row: number, column: number) {
  const cell = content.rows[row]?.cells[column];
  if (!cell || Array.isArray(cell)) return "";

  return cell.props.backgroundColor;
}

describe("markdown table operations", () => {
  test("duplicates a row after the selected row", () => {
    const nextContent = duplicateNfmTableTarget(tableContent(), {
      kind: "row",
      index: 0,
    });

    expect(nextContent.rows.length).toBe(3);
    expect(cellText(nextContent, 1, 0)).toBe("A1");
    expect(cellText(nextContent, 1, 1)).toBe("B1");
    expect(cellBackground(nextContent, 1, 0)).toBe("blue");
    expect(nextContent.headerRows).toBe(1);
  });

  test("duplicates a column after the selected column with width and cell props", () => {
    const nextContent = duplicateNfmTableTarget(tableContent(), {
      kind: "column",
      index: 1,
    });

    expect(nextContent.columnWidths.length).toBe(3);
    expect(nextContent.columnWidths[2]).toBe(180);
    expect(nextContent.rows[0]?.cells.length).toBe(3);
    expect(cellText(nextContent, 0, 2)).toBe("B1");
    expect(cellText(nextContent, 1, 2)).toBe("B2");
    expect(cellBackground(nextContent, 1, 2)).toBe("yellow");
  });

  test("clears row contents while preserving cell styling", () => {
    const nextContent = clearNfmTableTarget(tableContent(), {
      kind: "row",
      index: 0,
    });

    expect(cellText(nextContent, 0, 0)).toBe("");
    expect(cellText(nextContent, 0, 1)).toBe("");
    expect(cellText(nextContent, 1, 0)).toBe("A2");
    expect(cellBackground(nextContent, 0, 0)).toBe("blue");
  });

  test("clears column contents while preserving other columns", () => {
    const nextContent = clearNfmTableTarget(tableContent(), {
      kind: "column",
      index: 1,
    });

    expect(cellText(nextContent, 0, 0)).toBe("A1");
    expect(cellText(nextContent, 0, 1)).toBe("");
    expect(cellText(nextContent, 1, 1)).toBe("");
    expect(cellBackground(nextContent, 1, 1)).toBe("yellow");
  });

  test("clears a single cell only", () => {
    const nextContent = clearNfmTableTarget(tableContent(), {
      kind: "cell",
      rowIndex: 1,
      colIndex: 0,
    });

    expect(cellText(nextContent, 0, 0)).toBe("A1");
    expect(cellText(nextContent, 1, 0)).toBe("");
    expect(cellText(nextContent, 1, 1)).toBe("B2");
  });

  test("returns original content for invalid targets", () => {
    const content = tableContent();

    expect(duplicateNfmTableTarget(content, { kind: "row", index: 9 })).toBe(content);
    expect(duplicateNfmTableTarget(content, { kind: "column", index: 9 })).toBe(content);
    expect(clearNfmTableTarget(content, { kind: "cell", rowIndex: 9, colIndex: 0 })).toBe(content);
  });
});
