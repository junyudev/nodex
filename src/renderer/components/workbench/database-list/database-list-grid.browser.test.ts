import { describe, expect, test } from "vite-plus/test";
import {
  databaseListGridTemplate,
  DATABASE_LIST_FIELD_GAP,
  type DatabaseListColumnVisibility,
} from "./database-list-grid";

const hiddenIdentifierLayouts = [
  { identifier: false, priority: true, status: true },
  { identifier: false, priority: false, status: true },
  { identifier: false, priority: true, status: false },
  { identifier: false, priority: false, status: false },
] as const satisfies readonly DatabaseListColumnVisibility[];

describe("Database List named grid in Chromium", () => {
  test.each(hiddenIdentifierLayouts)(
    "keeps hidden ID headers aligned when priority=$priority and status=$status",
    (columns) => {
      const template = databaseListGridTemplate(
        [{ kind: "intrinsic", field: "updated_at" }],
        columns,
      );
      const grid = document.createElement("div");
      grid.style.display = "grid";
      grid.style.gridTemplateColumns = template;
      grid.style.columnGap = `${DATABASE_LIST_FIELD_GAP}px`;
      grid.style.width = "500px";

      const names = [
        "indent",
        "checkbox",
        ...(columns.priority ? ["priority"] : []),
        ...(columns.status ? ["status"] : []),
        "title",
        "updated_at",
        "end-padding",
      ];
      const cells = names.map((name) => {
        const cell = document.createElement("div");
        cell.style.gridColumn = name;
        cell.style.gridRow = "1";
        cell.style.height = "20px";
        grid.append(cell);
        return cell;
      });
      const groupHeader = document.createElement("div");
      groupHeader.style.gridColumn = "identifier / list-end";
      groupHeader.style.gridRow = "2";
      groupHeader.style.height = "20px";
      grid.append(groupHeader);
      document.body.append(grid);

      try {
        expect(CSS.supports("grid-template-columns", template)).toBe(true);
        expect(getComputedStyle(grid).gridTemplateColumns).not.toBe("none");
        for (const [index, cell] of cells.entries()) {
          expect(getComputedStyle(cell).gridColumnStart).toBe(names[index]);
          expect(cell.getBoundingClientRect().width).toBeGreaterThan(0);
          if (index === 0) continue;
          expect(cell.getBoundingClientRect().left).toBeGreaterThan(
            cells[index - 1]!.getBoundingClientRect().right,
          );
        }
        const identityCell = cells[names.indexOf(columns.status ? "status" : "title")]!;
        expect(groupHeader.getBoundingClientRect().left).toBe(
          identityCell.getBoundingClientRect().left,
        );
        expect(groupHeader.getBoundingClientRect().right).toBe(
          cells.at(-1)!.getBoundingClientRect().right,
        );
      } finally {
        grid.remove();
      }
    },
  );
});
