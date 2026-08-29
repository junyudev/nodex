import { describe, expect, test } from "vite-plus/test";
import type { Project, ProjectSession } from "@/lib/types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../shared/project-appearance";
import {
  SESSION_CONTEXT_MENU_ACTION_IDS,
  buildSessionContextMenuItems,
  readSessionMoveToProjectActionId,
  readSessionOpenInActionId,
  resolveSessionProjectMoveContainers,
  sessionMoveToProjectActionId,
} from "./session-context-menu-model";

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  const now = "2026-06-08T00:00:00.000Z";
  return {
    id: "session-1",
    projectId: "project-1",
    noThreadFallbackTitle: "Session one",
    displayTitle: "Session one",
    order: 1,
    pinned: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    unread: false,
    thread: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeAttachedSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  return makeSession({
    thread: {
      sessionId: "session-1",
      projectId: "project-1",
      threadId: "thread-1",
      threadPreview: "",
      modelProvider: "openai",
      executionHostId: "local",
      cwd: "/tmp/project",
      statusType: "idle",
      statusActiveFlags: [],
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      linkedAt: "2026-06-08T00:00:00.000Z",
    },
    ...overrides,
  });
}

function makeProject(id: string, name: string): Project {
  return {
    id,
    libraryId: "library:test",
    databaseId: `database:${id}`,
    defaultDatabaseViewId: null,
    lifecycle: "active",
    bindingRevision: 1,
    name,
    description: "",
    appearance: DEFAULT_PROJECT_APPEARANCE,
    sources: [],
    primaryWorkspaceRoot: null,
    pinned: false,
    pinnedOrder: null,
    created: new Date(0),
    updated: new Date(0),
  };
}

function flattenActionIds(items: ReturnType<typeof buildSessionContextMenuItems>): string[] {
  return items.flatMap((item) => {
    if (item.type === "separator") return ["separator"];
    if (item.type === "submenu") return [item.id, ...flattenActionIds(item.submenu)];
    return [item.id];
  });
}

describe("session context menu model", () => {
  test("matches the sidebar-native menu grouping and action order", () => {
    const items = buildSessionContextMenuItems({
      session: makeAttachedSession(),
      projects: [makeProject("project-1", "Current"), makeProject("project-2", "Destination")],
      openInTargets: [
        { id: "vscode", label: "VS Code", iconUrl: "file:///apps/vscode.png" },
        { id: "fileManager", label: "Finder" },
      ],
    });

    expect(flattenActionIds(items)).toEqual([
      SESSION_CONTEXT_MENU_ACTION_IDS.togglePin,
      SESSION_CONTEXT_MENU_ACTION_IDS.rename,
      SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
      SESSION_CONTEXT_MENU_ACTION_IDS.archive,
      "separator",
      "session.moveToProject",
      sessionMoveToProjectActionId("project-2"),
      "separator",
      SESSION_CONTEXT_MENU_ACTION_IDS.removeFromProject,
      "session.section",
      SESSION_CONTEXT_MENU_ACTION_IDS.newSection,
      "separator",
      "session.copy",
      SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory,
      SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink,
      SESSION_CONTEXT_MENU_ACTION_IDS.copyConversationMarkdown,
      "separator",
      "session.openIn",
      "session.openIn:vscode",
      "session.openIn:fileManager",
      SESSION_CONTEXT_MENU_ACTION_IDS.openInNewWindow,
    ]);
    expect(flattenActionIds(items)).not.toContain("session.reveal");
    expect(flattenActionIds(items)).not.toContain("session.fork");
    expect(flattenActionIds(items)).not.toContain("session.copySessionId");
    const openIn = items.find((item) => item.type === "submenu" && item.id === "session.openIn");
    expect(openIn?.type === "submenu" ? openIn.submenu[0] : null).toMatchObject({
      iconUrl: "file:///apps/vscode.png",
    });
  });

  test("shows the exact command accelerators without registering global shortcuts", () => {
    const items = buildSessionContextMenuItems({ session: makeSession() });
    const accelerators = items
      .slice(0, 4)
      .map((item) => (item.type === "separator" ? null : item.accelerator));
    expect(accelerators).toEqual([
      "Alt+CommandOrControl+P",
      "Alt+CommandOrControl+R",
      "Shift+CommandOrControl+U",
      "Shift+CommandOrControl+A",
    ]);
    const copy = items.find((item) => item.type === "submenu" && item.id === "session.copy");
    expect(copy?.type).toBe("submenu");
    if (copy?.type !== "submenu") return;
    expect(copy.submenu).toMatchObject([
      { enabled: false, iconKey: "copy", label: "Copy working directory" },
      { enabled: true, iconKey: "copy", label: "Copy deeplink" },
      { enabled: false, iconKey: "copy", label: "Copy as Markdown" },
    ]);
  });

  test("marks the current Section in-label and separates New section", () => {
    const items = buildSessionContextMenuItems({
      session: makeSession(),
      directSectionId: "section-alpha",
      sections: [
        {
          sectionId: "section-alpha",
          kind: "custom",
          name: "Alpha",
          rankKey: 1,
          revision: 1,
          lifecycle: "active",
          directItemCount: 1,
          effectiveSessionCount: 1,
          hasRunning: false,
          hasUnread: false,
        },
      ],
    });
    const section = items.find((item) => item.type === "submenu" && item.id === "session.section");
    expect(section?.type).toBe("submenu");
    if (section?.type !== "submenu") return;
    expect(
      section.submenu.map((item) => (item.type === "separator" ? "separator" : item.label)),
    ).toEqual(["✓ Alpha", "separator", "New section…"]);
    expect(section.submenu[0]?.type === "separator" ? null : section.submenu[0]?.id).toBe(
      SESSION_CONTEXT_MENU_ACTION_IDS.removeFromSection,
    );
  });

  test("keeps Remove from Project inside the Project submenu", () => {
    const items = buildSessionContextMenuItems({
      session: makeAttachedSession(),
      projects: [makeProject("project-1", "Current"), makeProject("project-2", "Destination")],
    });
    const project = items.find(
      (item) => item.type === "submenu" && item.id === "session.moveToProject",
    );
    expect(project?.type).toBe("submenu");
    if (project?.type !== "submenu") return;
    expect(
      project.submenu.map((item) => (item.type === "separator" ? "separator" : item.label)),
    ).toEqual(["Destination", "separator", "Remove from Current"]);
    const destination = project.submenu[0];
    expect(
      destination?.type === "separator" ? null : readSessionMoveToProjectActionId(destination.id),
    ).toBe("project-2");
    expect(destination?.type === "separator" ? null : destination?.iconKey).toBe("folder");
    const removeFromProject = project.submenu.at(-1);
    expect(removeFromProject?.type === "separator" ? null : removeFromProject?.iconKey).toBe(
      "folder",
    );
  });

  test("parses Open in targets and preserves pin state across Project moves", () => {
    expect(readSessionOpenInActionId("session.openIn:cursor")).toBe("cursor");
    expect(
      resolveSessionProjectMoveContainers(
        makeSession({ projectId: "project-1", pinned: true, pinnedOrder: 0 }),
        "project-2",
      ),
    ).toEqual({
      sourceContainerId: "project-pinned:project-1",
      targetContainerId: "project-pinned:project-2",
    });
    expect(
      resolveSessionProjectMoveContainers(
        makeSession({ projectId: "project-1", pinned: true, pinnedOrder: 0 }),
        null,
      ),
    ).toEqual({
      sourceContainerId: "project-pinned:project-1",
      targetContainerId: "pinned",
    });
  });

  test("switches pin and read-state labels", () => {
    const items = buildSessionContextMenuItems({
      session: makeSession({ pinned: true, pinnedOrder: 0, unread: true }),
    });
    expect(items[0]?.type === "separator" ? null : items[0]?.label).toBe("Unpin");
    expect(items[2]?.type === "separator" ? null : items[2]?.label).toBe("Mark as read");
  });
});
