import { describe, expect, test } from "vite-plus/test";
import { getDefaultCommandPalettePageFilters } from "./command-palette";
import {
  buildCommandPalettePagesFromSearchResults,
  getCommandPalettePageSearchPlan,
  isCommandPalettePageSearchPending,
  pageSearchOptionIdentityKey,
  selectCommandPalettePageResults,
  toCorePageSearchFilters,
} from "./command-palette-page-results";
import type { PageSearchResult, Project } from "./types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";

const project = {
  id: "project:one",
  name: "Product",
  appearance: DEFAULT_PROJECT_APPEARANCE,
} as Project;

const result = (overrides: Partial<PageSearchResult> = {}): PageSearchResult => ({
  projectId: "project:one",
  pageId: "page:one",
  pageKey: "NDX-42",
  title: "Search authority",
  status: "build",
  priority: "p1-high",
  tags: [
    {
      dataSourceId: "source:one",
      propertyId: "tags",
      optionId: "tag:core",
      label: "Core",
    },
  ],
  assignee: "Ada",
  locationLabel: "Product / Build",
  titleParts: [
    { text: "Search", highlighted: true },
    { text: " authority", highlighted: false },
  ],
  excerpt: "Search evidence from Core",
  excerptParts: [
    { text: "Search", highlighted: true },
    { text: " evidence from Core", highlighted: false },
  ],
  matches: [
    {
      source: "title",
      quality: "exact",
      parts: [
        { text: "Search", highlighted: true },
        { text: " authority", highlighted: false },
      ],
    },
  ],
  updatedAt: "2026-08-17T00:00:00.000Z",
  ...overrides,
});

describe("Core-authoritative command palette Page results", () => {
  test("requests root suggestions while preserving non-empty query thresholds", () => {
    expect(getCommandPalettePageSearchPlan("root", "  ")).toEqual({ searchLimit: 60 });
    expect(getCommandPalettePageSearchPlan("root", "🦊")).toBeNull();
    expect(getCommandPalettePageSearchPlan("root", "🦊猫")).toEqual({ searchLimit: 60 });
    expect(getCommandPalettePageSearchPlan("pages", "")).toEqual({ searchLimit: 60 });
    expect(getCommandPalettePageSearchPlan("actions", "search")).toBeNull();
  });

  test("preserves Core order and consumes typed highlight evidence", () => {
    const pages = buildCommandPalettePagesFromSearchResults({
      results: [result(), result({ pageId: "page:two", title: "Second", pageKey: null })],
      projects: [project],
      activeProjectId: project.id,
      recentPageIds: ["page:two"],
    });

    expect(pages.map((page) => page.page.id)).toEqual(["page:one", "page:two"]);
    expect(pages[0]?.searchDecorations?.titleSegments).toEqual([
      { text: "Search", highlight: true },
      { text: " authority", highlight: false },
    ]);
    expect(pages[1]?.recentIndex).toBe(0);
  });

  test("encodes scoped tag identities before sending filters to Core", () => {
    const filters = getDefaultCommandPalettePageFilters();
    filters.tags = [
      pageSearchOptionIdentityKey({
        dataSourceId: "source:one",
        propertyId: "tags",
        optionId: "tag:core",
      }),
    ];
    filters.tagMode = "all";

    expect(toCorePageSearchFilters(filters)).toMatchObject({
      tags: [
        {
          dataSourceId: "source:one",
          propertyId: "tags",
          optionId: "tag:core",
        },
      ],
      tagMode: "all",
    });
  });

  test("treats an empty-query Core request as pending until its batch arrives", () => {
    expect(
      isCommandPalettePageSearchPending({
        batch: null,
        enabled: true,
        query: "",
        scopeKey: "project:one",
      }),
    ).toBe(true);
  });

  test("shows synchronous metadata rows while complete search is still pending", () => {
    const pages = selectCommandPalettePageResults({
      query: "search",
      projects: [project],
      activeProjectId: project.id,
      recentPageIds: [],
      pageSearchScopeKey: project.id,
      pageSearchBatch: {
        query: "search",
        scopeKey: project.id,
        results: [result()],
        status: "pending",
        error: null,
      },
    });

    expect(pages.map((page) => page.page.title)).toEqual(["Search authority"]);
  });
});
