import { describe, expect, test } from "vite-plus/test";
import type { Project } from "./types";
import { buildRemoteDestinationSearchResult } from "./use-project-page-destination-search";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";

const TEST_DATE = new Date("2026-07-25T00:00:00.000Z");

function makeProject(id: string, name: string): Project {
  return {
    id,
    libraryId: "library:test",
    databaseId: `database:${id}`,
    defaultDatabaseViewId: `view:${id}`,
    lifecycle: "active",
    bindingRevision: 1,
    name,
    description: "",
    appearance: DEFAULT_PROJECT_APPEARANCE,
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: TEST_DATE,
    updated: TEST_DATE,
  };
}

describe("Project Page destination search", () => {
  test("maps bounded Core search hits without hydrating every Project board", () => {
    const result = buildRemoteDestinationSearchResult({
      projects: [makeProject("alpha", "Alpha"), makeProject("beta", "Beta")],
      query: "release notes",
      results: [
        {
          projectId: "beta",
          pageId: "page:release",
          pageKey: "BETA-7",
          title: "Release notes",
          status: { optionId: "review", label: "Awaiting approval" },
          priority: null,
          tags: [],
          assignee: null,
          locationLabel: "Beta / Review",
          titleParts: [],
          excerpt: "Review release notes before shipping.",
          excerptParts: [],
          matches: [
            {
              source: "page_key",
              quality: "exact",
              pageKey: "BETA-7",
              isCurrent: true,
              parts: [],
            },
          ],
          updatedAt: "2026-08-17T00:00:00.000Z",
        },
      ],
    });

    expect(result.pageHits).toEqual([
      {
        id: "page:beta:page:release",
        projectId: "beta",
        projectName: "Beta",
        projectAppearance: DEFAULT_PROJECT_APPEARANCE,
        columnId: "review",
        columnName: "Awaiting approval",
        pageId: "page:release",
        pageKey: "BETA-7",
        matchedPageKey: "BETA-7",
        matchedPageKeyIsCurrent: true,
        pageTitle: "Release notes",
      },
    ]);
  });
});
