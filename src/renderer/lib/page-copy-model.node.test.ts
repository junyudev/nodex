import { describe, expect, test } from "vite-plus/test";
import {
  listPageCopyActions,
  resolvePageCopyRequest,
  type PageCopyTarget,
} from "./page-copy-model";

const page: PageCopyTarget = {
  routingContext: { kind: "project", projectId: "project-1" },
  pageId: "page-1",
  pageKey: "LAB-13",
};

describe("resolvePageCopyRequest", () => {
  test("resolves identity, deeplink, title, and canonical Markdown ownership", () => {
    expect(
      resolvePageCopyRequest({
        actionId: "copy-id",
        page,
        presentedTitle: "Release plan",
      }),
    ).toMatchObject({ kind: "value", value: "LAB-13" });
    expect(
      resolvePageCopyRequest({
        actionId: "copy-deeplink",
        page,
        presentedTitle: "Release plan",
      }),
    ).toMatchObject({ kind: "value", value: "nodex://pages/page-1?spaceId=test-space" });
    expect(
      resolvePageCopyRequest({
        actionId: "copy-title",
        page,
        presentedTitle: "  ",
      }),
    ).toMatchObject({ kind: "value", value: "Untitled Page" });
    expect(
      resolvePageCopyRequest({
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
      resolvePageCopyRequest({
        actionId: "copy-id",
        page: { ...page, pageKey: null },
        presentedTitle: "Release plan",
      }),
    ).toBeNull();
  });

  test("offers the ID only for a Page with a key, and Markdown only when it can be read", () => {
    expect(
      listPageCopyActions({ hasPageKey: true, canCopyMarkdown: true }).map((a) => a.id),
    ).toEqual(["copy-id", "copy-deeplink", "copy-title", "copy-markdown"]);
    const withoutKey = listPageCopyActions({ hasPageKey: false, canCopyMarkdown: false });
    expect(withoutKey.map((action) => action.id)).toEqual([
      "copy-deeplink",
      "copy-title",
      "copy-markdown",
    ]);
    expect(withoutKey.find((action) => action.id === "copy-markdown")?.disabled).toBe(true);
  });
});
