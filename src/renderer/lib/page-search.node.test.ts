import { describe, expect, test } from "vite-plus/test";
import { filterDatabasePageRows } from "./page-search";

const row = (title: string, pageKey: string | null = null, plainText = "", properties = "") => ({
  title,
  pageKey,
  plainText,
  properties,
  preview: "",
});
const filter = (query: string, rows: ReturnType<typeof row>[]) =>
  filterDatabasePageRows(
    rows,
    query,
    (page) => page,
    (page) => page.properties,
  );

describe("Database View row search", () => {
  test.each([
    { query: "LAB-13", pageKey: "LAB-13", title: "Polish launch", expected: true },
    { query: "lab13", pageKey: "LAB-13", title: "Polish launch", expected: true },
    { query: "lab-1", pageKey: "LAB-13", title: "Polish launch", expected: true },
    { query: "b-1", pageKey: "LAB-13", title: "Polish launch", expected: false },
    { query: "#LAB-13", pageKey: "RND-9", title: "Discuss #LAB-13", expected: false },
    { query: "#", pageKey: "LAB-13", title: "Hash", expected: false },
    { query: "##LAB-13", pageKey: "LAB-13", title: "Hash", expected: false },
    { query: "LAB-13 polish", pageKey: "RND-9", title: "LAB-13 polish", expected: true },
    { query: "#LAB-13 polish", pageKey: "LAB-13", title: "Polish", expected: false },
  ])("applies one Page-key query policy to '$query'", ({ query, pageKey, title, expected }) => {
    const page = row(title, pageKey);
    expect(filter(query, [page])).toEqual(expected ? [page] : []);
  });

  test("matches across projected title, Property and body fields", () => {
    const page = row("PageSearchKernel", "LAB-13", "我们正在研究数据库迁移方案", "Café");
    expect(filter("Ｐａｇｅ＿ｓｅａｒｃｈ cafe 迁移", [page])).toEqual([page]);
    expect(filter("kernle", [page])).toEqual([page]);
    expect(filter("search absent", [page])).toEqual([]);
  });

  test("uses all loaded rows to decide whether typo fallback is needed", () => {
    const typo = row("QueryMigartion");
    const exact = row("QueryMigration");
    expect(filter("migration", [typo, exact])).toEqual([exact]);
  });
});
