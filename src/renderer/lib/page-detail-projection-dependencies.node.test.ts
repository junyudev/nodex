import { describe, expect, test } from "vite-plus/test";

import { buildPageDetailFixtureResult } from "@/test/page-detail-fixture";
import { buildPageStageFixturePage } from "@/test/page-stage-fixture";
import {
  pageDetailDataDependencies,
  pageDetailDocumentDependencies,
} from "./page-detail-projection-dependencies";

const detail = () => {
  const result = buildPageDetailFixtureResult("project-1", buildPageStageFixturePage());
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("Page Detail projection dependencies", () => {
  test("tracks the owning Database and Data Source for schema invalidation", () => {
    const value = detail();
    expect(pageDetailDataDependencies(value, value.page.pageId)).toEqual({
      pageIds: [value.page.pageId],
      databaseIds: [
        value.dataSourceContext.kind === "member"
          ? value.dataSourceContext.database.databaseId
          : "",
      ],
      dataSourceIds: [
        value.dataSourceContext.kind === "member"
          ? value.dataSourceContext.dataSource.dataSourceId
          : "",
      ],
    });
  });

  test("keeps Document invalidation independent from schema invalidation", () => {
    const value = detail();
    expect(pageDetailDocumentDependencies(value, value.page.pageId)).toEqual({
      pageIds: [value.page.pageId],
      documentIds: [value.page.documentId],
    });
  });
});
