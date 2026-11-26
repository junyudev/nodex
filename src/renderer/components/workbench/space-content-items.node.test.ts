import { describe, expect, test } from "vite-plus/test";
import { parseDatabaseId } from "../../../shared/database-identities";
import type { LibraryCatalogEntry } from "../../../shared/library-module";
import type { PageSearchResult } from "../../../shared/types";
import { buildSpaceContentItems } from "./space-content-items";

const olderEdit = "2026-11-24T10:00:00.000Z";
const middleEdit = "2026-11-25T10:00:00.000Z";
const latestEdit = "2026-11-26T10:00:00.000Z";

function pageResult(pageId: string, updatedAt: string): PageSearchResult {
  return {
    pageId,
    title: pageId,
    updatedAt,
    projectId: null,
    pageKey: null,
    status: null,
    locationLabel: "Library",
    priority: null,
    tags: [],
    assignee: null,
    titleParts: [],
    excerpt: null,
    excerptParts: [],
    matches: [],
  };
}

function catalogEntry(
  target: LibraryCatalogEntry["target"],
  title: string,
  updatedAt: string,
): LibraryCatalogEntry {
  return {
    target,
    kind: target.kind,
    title,
    updatedAt,
    lifecycle: "active",
    locationLabel: "Library",
    locationRevision: 1,
    metadataRevision: 1,
  };
}

describe("Workbench Space content items", () => {
  test("interleaves recent items by edit time and retains Page metadata", () => {
    const page = {
      ...pageResult("Release notes", middleEdit),
      projectId: "project-release",
      pageKey: "REL-12",
      status: { optionId: "doing", label: "Drafting" },
    } satisfies PageSearchResult;
    const database = catalogEntry(
      { kind: "database", databaseId: parseDatabaseId("releases") },
      "Releases",
      latestEdit,
    );
    const canvas = catalogEntry({ kind: "canvas", canvasId: "roadmap" }, "Roadmap", middleEdit);

    const items = buildSpaceContentItems({
      query: "",
      pageResults: [page, pageResult("Planning", olderEdit)],
      catalogItems: [database, canvas],
    });

    expect(items.map((item) => item.title)).toEqual([
      "Releases",
      "Release notes",
      "Roadmap",
      "Planning",
    ]);
    expect(items[1]).toMatchObject({
      updatedAt: middleEdit,
      status: page.status,
      pageKey: "REL-12",
      projectId: "project-release",
    });
  });

  test("keeps Page relevance order and prefers a search hit over its catalog duplicate", () => {
    const firstHit: PageSearchResult = {
      ...pageResult("release-process", olderEdit),
      title: "Release process",
      titleParts: [
        { text: "Release", highlighted: true },
        { text: " process", highlighted: false },
      ],
      excerptParts: [
        { text: "Coordinate the ", highlighted: false },
        { text: "release", highlighted: true },
      ],
      matches: [
        {
          source: "body",
          quality: "exact",
          blockId: "release-block",
          blockType: "paragraph",
          parts: [{ text: "release", highlighted: true }],
        },
      ],
    };

    const items = buildSpaceContentItems({
      query: "release",
      pageResults: [firstHit, pageResult("Release notes", middleEdit)],
      catalogItems: [
        catalogEntry({ kind: "page", pageId: firstHit.pageId }, "Release index title", latestEdit),
        catalogEntry({ kind: "canvas", canvasId: "release-map" }, "Release map", latestEdit),
      ],
    });

    expect(items.map((item) => item.title)).toEqual([
      "Release process",
      "Release notes",
      "Release map",
    ]);
    expect(items[0]).toMatchObject({
      titleParts: firstHit.titleParts,
      excerptParts: firstHit.excerptParts,
      searchMatches: firstHit.matches,
      reveal: { kind: "page-search", blockId: "release-block", text: "release" },
    });
    expect(items[2]?.titleParts).toBeUndefined();
    expect(items[2]?.excerptParts).toBeUndefined();
  });
});
