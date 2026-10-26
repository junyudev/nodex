import { describe, expect, test } from "vite-plus/test";
import { parseDatabaseId, parseDatabaseViewId } from "../../shared/database-identities";
import { areLibraryResourceTargetsEqual, resolveLibraryPathRoot } from "./library-resource-routing";

describe("library resource routing", () => {
  test("resolves nested Pages and Views to their canonical root", () => {
    expect(
      resolveLibraryPathRoot({ kind: "page", pageId: "page:child" }, [
        {
          kind: "database",
          databaseId: parseDatabaseId("database:tasks"),
          title: "Tasks",
          defaultViewId: parseDatabaseViewId("view:board"),
          hasMultipleViews: true,
          isPrimary: false,
          metadataRevision: 1,
          locationRevision: 1,
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
      ]),
    ).toEqual({ kind: "database", databaseId: "database:tasks" });
    expect(
      resolveLibraryPathRoot({ kind: "view", viewId: parseDatabaseViewId("view:board") }, [
        {
          kind: "database",
          databaseId: parseDatabaseId("database:tasks"),
          title: "Tasks",
          defaultViewId: parseDatabaseViewId("view:board"),
          hasMultipleViews: true,
          isPrimary: false,
          metadataRevision: 1,
          locationRevision: 1,
          updatedAt: "2026-08-03T00:00:00.000Z",
        },
      ]),
    ).toEqual({ kind: "database", databaseId: "database:tasks" });
  });

  test("compares exact resource identities without coercion", () => {
    expect(
      areLibraryResourceTargetsEqual(
        { kind: "page", pageId: "page:one" },
        { kind: "page", pageId: "page:one" },
      ),
    ).toBe(true);
    expect(
      areLibraryResourceTargetsEqual(
        { kind: "page", pageId: "page:one" },
        { kind: "canvas", canvasId: "page:one" },
      ),
    ).toBe(false);
  });
});
