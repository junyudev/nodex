import { expect, test } from "vite-plus/test";
import { filterCanvasCards } from "./canvas-card-search";

test("finds cards by title segments, folding, and typo fallback in board order", () => {
  const cards = ["PageSearchKernel", "数据库迁移方案", "Café Migration"].map((title) => ({
    card: { title },
  }));
  expect(filterCanvasCards(cards, "ｐａｇｅ＿ｓｅａｒｃｈ")).toEqual([cards[0]]);
  expect(filterCanvasCards(cards, "迁移")).toEqual([cards[1]]);
  expect(filterCanvasCards(cards, "cafe migartion")).toEqual([cards[2]]);
});
