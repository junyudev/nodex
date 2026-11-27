import { describe, expect, test } from "vite-plus/test";
import type { Project, ProjectSession } from "@/lib/types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../shared/project-appearance";
import { chatSnoozePresets } from "@/lib/chat-snooze";
import {
  SESSION_CONTEXT_MENU_ACTION_IDS,
  buildSessionContextMenuItems,
  readSessionMoveToProjectActionId,
  readSessionOpenInActionId,
  readSessionSnoozedUntilActionId,
  resolveSessionProjectMoveContainers,
  sessionMoveToProjectActionId,
  sessionSnoozedUntilActionId,
} from "./session-context-menu-model";

/** Wednesday afternoon, local time. */
const MENU_OPENED_AT = new Date(2026, 10, 4, 14, 0);

function makeSession(overrides: Partial<ProjectSession> = {}): ProjectSession {
  const now = "2026-06-08T00:00:00.000Z";
  return {
    id: "session-1",
    projectId: "project-1",
    noThreadFallbackTitle: "Session one",
    displayTitle: "Session one",
    activityAt: 0,
    pinned: false,
    managed: false,
    pinnedOrder: null,
    archived: false,
    archivedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    wokeAt: null,
    pageTurn: null,
    canManage: true,
    canStop: true,
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
      backendBinding: { driver: "codex", instanceId: "codex" },
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
  test("offers an enabled Fork chat action for a Runtime Session", () => {
    const items = buildSessionContextMenuItems({
      session: makeSession({
        executionRef: { runtimeId: "runtime-1", threadId: "root-1" },
      }),
    });

    const fork = items.find((item) => item.type === "submenu" && item.label === "Fork");
    expect(fork).toMatchObject({ type: "submenu", label: "Fork" });
    expect(fork?.type === "submenu" ? fork.submenu : []).toContainEqual(
      expect.objectContaining({ label: "Fork chat" }),
    );
  });

  test("offers the supplied worktree destinations for a Runtime Session", () => {
    const items = buildSessionContextMenuItems({
      session: makeSession({
        executionRef: { runtimeId: "runtime-1", threadId: "root-1" },
      }),
      forkDestinations: [
        { target: "local", label: "Fork chat in same worktree", iconKey: "fork" },
        { target: "newWorktree", label: "Fork chat in new worktree", iconKey: "worktree" },
      ],
    });
    const fork = items.find((item) => item.type === "submenu" && item.label === "Fork");
    expect(fork?.type === "submenu" ? fork.submenu : []).toMatchObject([
      { id: "session.fork", label: "Fork chat in same worktree", iconKey: "fork" },
      {
        id: "session.forkInNewWorktree",
        label: "Fork chat in new worktree",
        iconKey: "worktree",
      },
    ]);
  });

  test("matches the sidebar-native menu grouping and action order", () => {
    const items = buildSessionContextMenuItems({
      session: makeAttachedSession(),
      projects: [makeProject("project-1", "Current"), makeProject("project-2", "Destination")],
      openInTargets: [
        { id: "vscode", label: "VS Code", iconUrl: "file:///apps/vscode.png" },
        { id: "fileManager", label: "Finder" },
      ],
      now: MENU_OPENED_AT,
    });

    expect(flattenActionIds(items)).toEqual([
      SESSION_CONTEXT_MENU_ACTION_IDS.rename,
      SESSION_CONTEXT_MENU_ACTION_IDS.togglePin,
      SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
      SESSION_CONTEXT_MENU_ACTION_IDS.toggleSettled,
      "session.snooze",
      ...chatSnoozePresets(MENU_OPENED_AT).map((preset) =>
        sessionSnoozedUntilActionId(preset.snoozedUntil),
      ),
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
      "separator",
      SESSION_CONTEXT_MENU_ACTION_IDS.archive,
    ]);
    expect(flattenActionIds(items)).not.toContain("session.reveal");
    expect(flattenActionIds(items)).not.toContain("session.fork");
    expect(flattenActionIds(items)).not.toContain("session.copySessionId");
    const openIn = items.find((item) => item.type === "submenu" && item.id === "session.openIn");
    expect(openIn?.type === "submenu" ? openIn.submenu[0] : null).toMatchObject({
      iconUrl: "file:///apps/vscode.png",
    });
  });

  test("omits copy actions that have no current value", () => {
    const items = buildSessionContextMenuItems({ session: makeSession() });
    const ids = flattenActionIds(items);
    expect(ids).toContain(SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink);
    expect(ids).not.toContain(SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory);
    expect(ids).not.toContain(SESSION_CONTEXT_MENU_ACTION_IDS.copyConversationMarkdown);
  });

  test("offers removal from the current Section in a final group", () => {
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
          hasWaiting: false,
          hasRunning: false,
          hasUnread: false,
        },
      ],
    });
    const section = items.find((item) => item.type === "submenu" && item.id === "session.section");
    expect(section?.type).toBe("submenu");
    if (section?.type !== "submenu") return;
    expect(flattenActionIds(section.submenu)).toEqual([
      SESSION_CONTEXT_MENU_ACTION_IDS.newSection,
      "separator",
      SESSION_CONTEXT_MENU_ACTION_IDS.removeFromSection,
    ]);
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
    const removeFromProject = project.submenu.at(-1);
    expect(removeFromProject?.id).toBe(SESSION_CONTEXT_MENU_ACTION_IDS.removeFromProject);
  });

  test("omits Codex-only movement and transcript export for ACP sessions", () => {
    const items = buildSessionContextMenuItems({
      session: makeAttachedSession({
        thread: {
          ...makeAttachedSession().thread!,
          backendBinding: { driver: "acpRegistry", instanceId: "claude-main" },
        },
      }),
      projects: [makeProject("project-1", "Current"), makeProject("project-2", "Destination")],
    });

    expect(flattenActionIds(items)).not.toContain("session.moveToProject");
    expect(flattenActionIds(items)).not.toContain(
      SESSION_CONTEXT_MENU_ACTION_IDS.copyConversationMarkdown,
    );
    expect(flattenActionIds(items)).toContain(SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory);
    expect(flattenActionIds(items)).toContain(SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink);
  });

  test("offers Runtime Sessions every conversation action from their execution owner", () => {
    const runtimeSession = makeSession({
      executionRef: { runtimeId: "runtime-1", threadId: "root-1" },
    });
    const projects = [makeProject("project-1", "Current"), makeProject("project-2", "Destination")];
    const located = buildSessionContextMenuItems({
      session: runtimeSession,
      projects,
      openInTargets: [{ id: "vscode", label: "VS Code" }],
      location: { cwd: "/repo/worktree", managedWorktreePath: "/repo/worktree" },
    });
    const ids = flattenActionIds(located);
    expect(ids).toContain(sessionMoveToProjectActionId("project-2"));
    expect(ids).toContain(SESSION_CONTEXT_MENU_ACTION_IDS.removeFromProject);
    expect(ids).toContain("session.openIn:vscode");
    const copy = located.find((item) => item.type === "submenu" && item.id === "session.copy");
    expect(copy?.type === "submenu" ? copy.submenu : []).toMatchObject([
      { label: "Copy working directory" },
      { label: "Copy link" },
      { label: "Copy as Markdown" },
    ]);

    // An unknown Runtime location never borrows another source's working directory.
    const unlocated = buildSessionContextMenuItems({
      session: runtimeSession,
      projects,
      openInTargets: [{ id: "vscode", label: "VS Code" }],
      location: null,
    });
    expect(flattenActionIds(unlocated)).not.toContain("session.openIn");
    const unlocatedCopy = unlocated.find(
      (item) => item.type === "submenu" && item.id === "session.copy",
    );
    expect(
      unlocatedCopy?.type === "submenu" &&
        unlocatedCopy.submenu.some(
          (item) => item.id === SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory,
        ),
    ).toBe(false);
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
    expect(items[1]?.type === "separator" ? null : items[1]?.label).toBe("Unpin");
    expect(items[2]?.type === "separator" ? null : items[2]?.label).toBe("Mark as read");
  });

  test("offers snooze presets, and for a pending snooze says when and offers to cancel", () => {
    const snoozeMenu = (snoozedUntil: string | null) => {
      const item = buildSessionContextMenuItems({
        session: makeSession({ snoozedUntil }),
        now: MENU_OPENED_AT,
      }).find((candidate) => candidate.type === "submenu" && candidate.id === "session.snooze");
      if (item?.type !== "submenu") throw new Error("Snooze submenu missing");
      return item;
    };

    const fresh = snoozeMenu(null);
    expect(fresh).toMatchObject({ label: "Snooze", iconKey: "snooze" });
    expect(fresh.submenu.map((item) => (item.type === "separator" ? "—" : item.label))).toEqual([
      "In 1 hour",
      "In 3 hours",
      "Tomorrow, 9:00 AM",
      "Next week, Mon 9:00 AM",
    ]);
    const tomorrow = fresh.submenu[2];
    expect(
      tomorrow?.type === "separator" ? null : readSessionSnoozedUntilActionId(tomorrow!.id),
    ).toBe(new Date(2026, 10, 5, 9).toISOString());

    const pending = snoozeMenu(new Date(2026, 10, 5, 9).toISOString());
    expect(pending.submenu.map((item) => (item.type === "separator" ? "—" : item.label))).toEqual([
      "Snoozed until tomorrow at 9:00 AM",
      "Wake",
      "—",
      "In 1 hour",
      "In 3 hours",
      "Tomorrow, 9:00 AM",
      "Next week, Mon 9:00 AM",
    ]);
    expect(pending.submenu[0]).toMatchObject({ enabled: false });
    expect(pending.submenu[1]).toMatchObject({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.wake,
    });
    expect(readSessionSnoozedUntilActionId("session.snoozedUntil:not-a-time")).toBeNull();
    expect(readSessionSnoozedUntilActionId(SESSION_CONTEXT_MENU_ACTION_IDS.markUnread)).toBeNull();
  });
});
