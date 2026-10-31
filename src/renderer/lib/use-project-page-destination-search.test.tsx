import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";
import type { PageSearchResult, Project } from "./types";
import { __testing } from "./interactive-page-search";
import { useProjectPageDestinationSearch } from "./use-project-page-destination-search";

vi.mock("./api", () => ({
  invoke: vi.fn(() => new Promise(() => undefined)),
  subscribeLibraryChanges: () => () => undefined,
}));

const project: Project = {
  id: "project-1",
  libraryId: "library-1",
  databaseId: "database-1",
  defaultDatabaseViewId: "view-1",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Lab",
  description: "",
  appearance: DEFAULT_PROJECT_APPEARANCE,
  sources: [],
  primaryWorkspaceRoot: null,
  pinned: false,
  pinnedOrder: null,
  created: new Date("2026-08-14T00:00:00.000Z"),
  updated: new Date("2026-08-14T00:00:00.000Z"),
};

const result: PageSearchResult = {
  projectId: "project-1",
  pageId: "page-1",
  pageKey: "LAB-13",
  title: "Launch",
  status: "doing",
  priority: null,
  tags: [],
  assignee: null,
  locationLabel: "Lab",
  titleParts: [],
  excerpt: null,
  excerptParts: [],
  matches: [],
  updatedAt: "2026-08-14T00:00:00.000Z",
};

afterEach(() => __testing.reset());

describe("Project Page destination search", () => {
  test("returns the live-query WASM metadata row without awaiting Core enrichment", () => {
    __testing.installIndex([project.id], {
      replace: () => undefined,
      applyDelta: () => undefined,
      search: (request: { query?: string }) => (request.query === "lab-13" ? [result] : []),
    });
    const hook = renderHook(() =>
      useProjectPageDestinationSearch({
        projects: [project],
        query: "LAB-13",
        enabled: true,
      }),
    );

    expect(hook.result.current.pageHits[0]).toMatchObject({
      pageId: "page-1",
      pageKey: "LAB-13",
      pageTitle: "Launch",
    });
    expect(hook.result.current.enrichment).toBe("loading");
    hook.unmount();
  });
});
