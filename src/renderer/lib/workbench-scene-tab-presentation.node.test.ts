import { DatabaseIcon, InboxIcon } from "@/components/shared/icons";
import { describe, expect, test } from "vite-plus/test";

import { projectInboxSurface, type WorkbenchSurfaceDescriptor } from "../../shared/workbench-scene";
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
  test("presents a Project's Home as its Inbox", () => {
    expect(resolveWorkbenchSceneTabPresentation(projectInboxSurface("home", "alpha"))).toEqual({
      title: "Inbox",
      icon: InboxIcon,
    });
  });

  test("presents the Project's Database like a standard DB View tab", () => {
    expect(resolveWorkbenchSceneTabPresentation(databaseSurface)).toEqual({
      title: "DB View",
      icon: DatabaseIcon,
    });
  });
});
