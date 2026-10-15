import { DatabaseIcon } from "@/components/shared/icons";
import { describe, expect, test } from "vite-plus/test";

import type { WorkbenchSurfaceDescriptor } from "../../shared/workbench-scene";
import { resolveWorkbenchSceneTabPresentation } from "./workbench-scene-tab-presentation";

const databaseSurface: WorkbenchSurfaceDescriptor = {
  id: "surface:database",
  kind: "db_view",
  titleSnapshot: "Database",
  config: {
    routingContext: { kind: "project", projectId: "alpha" },
    target: { kind: "project-default" },
  },
  stateKey: 0,
  state: null,
};

describe("resolveWorkbenchSceneTabPresentation", () => {
  test("reserves Project Home chrome for the protected root", () => {
    expect(resolveWorkbenchSceneTabPresentation(databaseSurface, true)).toEqual({
      title: "Project Home",
    });
  });

  test("presents every other DB surface like a standard Session DB View tab", () => {
    expect(resolveWorkbenchSceneTabPresentation(databaseSurface, false)).toEqual({
      title: "DB View",
      icon: DatabaseIcon,
    });
  });
});
