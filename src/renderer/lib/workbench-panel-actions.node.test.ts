import { describe, expect, test } from "vite-plus/test";
import { BoardIcon, CanvasIcon, PageIcon } from "@/components/shared/icons";
import { getPanelNewTabAction } from "./workbench-panel-actions";

describe("workbench panel action icons", () => {
  test("keeps resource actions paired with their semantic icons", () => {
    expect(getPanelNewTabAction("page_stage").Icon).toBe(PageIcon);
    expect(getPanelNewTabAction("canvas_stage").Icon).toBe(CanvasIcon);
    expect(getPanelNewTabAction("db_view").Icon).toBe(BoardIcon);
    expect(getPanelNewTabAction("page_stage").Icon).not.toBe(BoardIcon);
  });
});
