import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { DEFAULT_PROJECT_APPEARANCE } from "../../shared/project-appearance";
import type { PageSearchResult, Project } from "./types";
import { findFixture, pageFindHit } from "../test/find-fixture";
import {
  buildRemoteDestinationSearchResult,
  useProjectPageDestinationSearch,
} from "./use-project-page-destination-search";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("./renderer-command", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./renderer-command")>()),
  invokeRendererQuery: invoke,
  invokeRendererControl: vi.fn(async () => true),
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
  status: { optionId: "doing", label: "Doing" },
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

describe("Project Page destination search", () => {
  test("keeps Library destinations without a Project or Status for empty and typed queries", () => {
    for (const query of ["", "Launch"]) {
      const hits = buildRemoteDestinationSearchResult({
        projects: [],
        query,
        results: [{ ...result, projectId: null, status: null, locationLabel: "Pages / Parent" }],
      }).pageHits;
      expect(hits).toMatchObject([
        { projectId: null, columnId: null, pageId: "page-1", projectName: "Pages / Parent" },
      ]);
    }
  });
  test("returns the live instant match while enrichment is pending", async () => {
    invoke.mockImplementation((_channel, _request, phase) =>
      phase === "instant"
        ? Promise.resolve(findFixture("instant", [pageFindHit(result)]))
        : new Promise(() => undefined),
    );
    const hook = renderHook(() =>
      useProjectPageDestinationSearch({
        projects: [project],
        query: "LAB-13",
        enabled: true,
      }),
    );

    await waitFor(() =>
      expect(hook.result.current.pageHits[0]).toMatchObject({
        pageId: "page-1",
        pageKey: "LAB-13",
        pageTitle: "Launch",
      }),
    );
    expect(hook.result.current.enrichment).toBe("loading");
    hook.unmount();
  });
});
