import { waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import { render } from "@/test/dom";
import { TestQueryProvider } from "@/test/query";
import { ProjectionInvalidationRegistry } from "@/lib/projection-invalidation-registry";
import type { Project } from "@/lib/types";
import { libraryContentRoute, projectContentRoute } from "../../../shared/content-routing-context";
import { resolveContentTabLocation, type LocatedTabSurface } from "./content-tab-location";

const mocks = vi.hoisted(() => ({ resolvePageOwnershipPath: vi.fn() }));

vi.mock("@/lib/api", () => ({
  readLibraryModule: vi.fn(async () => ({
    ok: true,
    value: { libraryId: "library-1", storeEpoch: "epoch-1", commitSeq: 0, value: {} },
  })),
  resolvePageOwnershipPath: mocks.resolvePageOwnershipPath,
  readDatabaseViewReference: vi.fn(),
}));

vi.mock("@/lib/renderer-transport", () => ({
  resolveRendererTransport: () => ({
    subscribeBoardChanges: () => () => undefined,
    subscribePageOwnershipPathChanges: () => () => undefined,
  }),
}));

const projects = [{ id: "beta", name: "Beta" }] as unknown as Project[];

const page = (
  routingContext: ReturnType<typeof projectContentRoute> | typeof libraryContentRoute,
) =>
  ({
    kind: "page_stage",
    config: { routingContext, pageId: "weekly", titleSnapshot: "Weekly" },
  }) as LocatedTabSurface;

describe("content tab location", () => {
  test("a file is located by its folders below the workspace root", () => {
    const file = (path: string) =>
      resolveContentTabLocation(
        {
          kind: "files",
          config: { projectId: null, hostId: "local", workspaceRoot: "/repo/app", cwd: null, path },
        } as LocatedTabSurface,
        { projects, home: null },
      ).location;
    expect(file("/repo/app/src/lib/index.ts")).toEqual(["src", "lib"]);
    expect(file("/repo/app/README.md")).toBeUndefined();
    expect(file("/elsewhere/notes.md")).toEqual(["elsewhere"]);
  });

  test("content outside the Scene's home names its Library or Project to assistive technology", () => {
    const home = projectContentRoute("alpha");
    const library = resolveContentTabLocation(page(libraryContentRoute), { projects, home });
    expect(library.location).toEqual(["Library"]);
    expect(typeof library.titleLabel === "function" && library.titleLabel("Weekly")).toBe(
      "Weekly, Library",
    );
    const beta = resolveContentTabLocation(page(projectContentRoute("beta")), { projects, home });
    expect(beta.location).toEqual(["Beta"]);
    expect(typeof beta.titleLabel === "function" && beta.titleLabel("Weekly")).toBe(
      "Weekly, Beta project",
    );
    const own = resolveContentTabLocation(page(projectContentRoute("alpha")), { projects, home });
    expect(own.location).toEqual(["alpha"]);
    expect(own.titleLabel).toBeUndefined();
  });

  test("a Page tab's tooltip follows its Library with the Page's parents", async () => {
    mocks.resolvePageOwnershipPath.mockResolvedValue({
      libraryId: "library-1",
      storeEpoch: "epoch-1",
      commitSeq: 1,
      status: "available",
      targetPageId: "weekly",
      ancestors: [
        { pageId: "notes", title: "Notes", lifecycle: "active" },
        { pageId: "untitled", title: " ", lifecycle: "active" },
      ],
    });
    const { renderTooltip } = resolveContentTabLocation(page(libraryContentRoute), {
      projects,
      home: libraryContentRoute,
    });
    const view = render(
      <TestQueryProvider
        projectionRegistry={
          new ProjectionInvalidationRegistry({ subscribeProjection: () => () => undefined })
        }
      >
        {renderTooltip?.("Weekly")}
      </TestQueryProvider>,
    );
    expect(view.getByText("Weekly")).toBeTruthy();
    await waitFor(() => expect(view.getByText("Library / Notes / Untitled")).toBeTruthy());
  });
});
