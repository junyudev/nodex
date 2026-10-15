import { describe, expect, test } from "vite-plus/test";
import type { Project } from "./types";
import type { PageCreateTarget } from "./page-create-target-registry";
import { resolveProjectDefaultPageCreateCapability } from "./use-project-page-create-target";

const project = (defaultDatabaseViewId: string | null): Project => ({
  id: "project:alpha",
  libraryId: "library:alpha",
  databaseId: "database:alpha",
  defaultDatabaseViewId,
  lifecycle: "active",
  bindingRevision: 1,
  name: "Alpha",
  description: "",
  appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
  sources: [],
  primaryWorkspaceRoot: null,
  pinned: false,
  pinnedOrder: null,
  created: new Date(0),
  updated: new Date(0),
});

const target: PageCreateTarget = {
  surfaceId: "project-default:alpha",
  panelTabId: "project-scene:alpha",
  project: {
    id: "project:alpha",
    name: "Alpha",
    appearance: { color: "blue", marker: { kind: "icon", icon: "terminal" } },
  },
  databaseViewId: "view:alpha",
  clientSessionId: "session:test",
  routingContext: { kind: "project", projectId: "project:alpha" },
  properties: [],
  columns: [{ id: "triage", name: "Triage" }],
};

describe("active Project Page-create capability", () => {
  test("distinguishes missing configuration, read failure, loading, and ready", () => {
    expect(
      resolveProjectDefaultPageCreateCapability({
        project: project(null),
        target: null,
        error: null,
      }),
    ).toEqual({
      status: "unavailable",
      reason: "This Project has no active default Database View.",
    });

    expect(
      resolveProjectDefaultPageCreateCapability({
        project: project("view:alpha"),
        target: null,
        error: "read failed",
      }),
    ).toEqual({
      status: "unavailable",
      reason: "Couldn’t prepare this Project’s default Database View.",
    });

    expect(
      resolveProjectDefaultPageCreateCapability({
        project: project("view:alpha"),
        target: null,
        error: null,
      }),
    ).toEqual({
      status: "loading",
      reason: "Preparing this Project’s default Database View…",
    });

    expect(
      resolveProjectDefaultPageCreateCapability({
        project: project("view:alpha"),
        target,
        error: null,
      }),
    ).toEqual({ status: "ready", target });
  });
});
