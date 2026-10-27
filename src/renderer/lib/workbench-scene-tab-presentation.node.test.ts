import { BoardIcon, InboxIcon } from "@/components/shared/icons";
import { describe, expect, test } from "vite-plus/test";

import { LIBRARY_INBOX, projectInbox } from "../../shared/inbox";
import { inboxSurface, type WorkbenchSurfaceDescriptor } from "../../shared/workbench-scene";
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
  test("presents every Inbox Home as Inbox", () => {
    for (const scope of [projectInbox("alpha"), LIBRARY_INBOX]) {
      expect(resolveWorkbenchSceneTabPresentation(inboxSurface("home", scope))).toEqual({
        title: "Inbox",
        icon: InboxIcon,
      });
    }
  });

  test("presents the Project's Database like a standard DB View tab", () => {
    expect(resolveWorkbenchSceneTabPresentation(databaseSurface)).toEqual({
      title: "DB View",
      icon: BoardIcon,
    });
  });
});
