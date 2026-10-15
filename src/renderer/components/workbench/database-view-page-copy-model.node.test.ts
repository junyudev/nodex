import { describe, expect, test } from "vite-plus/test";
import type { DatabaseViewPageTarget } from "./database-view-page-actions";
import { resolveDatabaseViewPageCopyRequest } from "./database-view-page-copy-model";

const page: DatabaseViewPageTarget = {
  libraryId: "library-1",
  routingContext: { kind: "project", projectId: "project-1" },
  projectId: "project-1",
  pageId: "page-1",
  pageKey: "LAB-13",
  titleSnapshot: "Release plan",
};

describe("resolveDatabaseViewPageCopyRequest", () => {
  test("resolves identity, deeplink, title, and canonical Markdown ownership", () => {
    expect(
      resolveDatabaseViewPageCopyRequest({
        actionId: "copy-id",
        page,
        presentedTitle: "Release plan",
      }),
    ).toMatchObject({ kind: "value", value: "LAB-13" });
    expect(
      resolveDatabaseViewPageCopyRequest({
        actionId: "copy-deeplink",
        page,
        presentedTitle: "Release plan",
      }),
    ).toMatchObject({ kind: "value", value: "nodex://pages/page-1" });
    expect(
      resolveDatabaseViewPageCopyRequest({
        actionId: "copy-title",
        page,
        presentedTitle: "  ",
      }),
    ).toMatchObject({ kind: "value", value: "Untitled Page" });
    expect(
      resolveDatabaseViewPageCopyRequest({
        actionId: "copy-markdown",
        page,
        presentedTitle: "Release plan",
      }),
    ).toMatchObject({
      kind: "materialized-markdown",
      routingContext: { kind: "project", projectId: "project-1" },
      pageId: "page-1",
    });
  });

  test("does not invent an identity for a Page without a Page key", () => {
    expect(
      resolveDatabaseViewPageCopyRequest({
        actionId: "copy-id",
        page: { ...page, pageKey: null },
        presentedTitle: "Release plan",
      }),
    ).toBeNull();
  });
});
