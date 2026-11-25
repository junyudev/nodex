import { describe, expect, test } from "vite-plus/test";
import {
  classifyNfmTable,
  fitNfmTableColumnsToWidth,
  measureNfmTableDisplayUnits,
} from "./nfm-table-layout";

describe("table display units", () => {
  test("trims outer whitespace and measures wide and fullwidth code points", () => {
    expect(measureNfmTableDisplayUnits("  A漢𠀀かな한Ａ、ｶ é𝄞  ")).toBe(19);
    expect(measureNfmTableDisplayUnits("\t \n")).toBe(0);
  });

  test("classifies only auto cells and distinguishes empty cells from blank columns", () => {
    expect(
      classifyNfmTable(
        [
          ["pinned", "abcdefghijklmnopqrst", "  ", ""],
          ["", "𠀀".repeat(10) + "a", "", "か"],
        ],
        [120, undefined, null],
      ),
    ).toEqual({
      layout: "mixed",
      columns: [120, undefined, undefined, undefined],
      cellFits: [
        [undefined, "short", "blank", undefined],
        [undefined, "long", "blank", "short"],
      ],
    });
  });

  test("recognizes auto and fully pinned layouts", () => {
    expect(classifyNfmTable([["x", ""]]).layout).toBe("auto");
    expect(classifyNfmTable([["x", ""]], [100, 50])).toEqual({
      layout: "pinned",
      columns: [100, 50],
      cellFits: [[undefined, undefined]],
    });
  });
});

describe("fitting table columns to the page", () => {
  test("preserves proportions when expanding and shrinking", () => {
    expect(fitNfmTableColumnsToWidth([50, 100, 150], 600.9)).toEqual([100, 200, 300]);
    expect(fitNfmTableColumnsToWidth([150, 300, 450], 300)).toEqual([50, 100, 150]);
  });

  test("clamps narrow columns and redistributes the remainder proportionally", () => {
    expect(fitNfmTableColumnsToWidth([150, 10, 2, 75], 220)).toEqual([100, 35, 35, 50]);
  });

  test("uses column order to break rounding ties", () => {
    expect(fitNfmTableColumnsToWidth([50, 50, 50], 107.9)).toEqual([36, 36, 35]);
    expect(fitNfmTableColumnsToWidth([50, 100, 150], 121, 1)).toEqual([20, 40, 61]);
  });

  test("retains usable minimum widths when a table cannot fit the page", () => {
    expect(fitNfmTableColumnsToWidth([50, 100, 150], 100)).toEqual([35, 35, 35]);
  });
});
