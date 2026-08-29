import { describe, expect, test } from "vite-plus/test";
import type { ProjectSession } from "@/lib/types";
import {
  SESSION_CONTEXT_MENU_ACTION_IDS,
  buildSessionContextMenuItems,
  readSessionMoveToProjectActionId,
  resolveSessionProjectMoveContainers,
  sessionMoveToProjectActionId,
} from "./session-context-menu-model";
import type { Project } from "@/lib/types";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../shared/project-appearance";

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
  test("uses the Codex archive action id", () => {
    expect(SESSION_CONTEXT_MENU_ACTION_IDS.archive).toBe("archive-thread");
  });

  test("matches Codex action order", () => {
    const items = buildSessionContextMenuItems({
      session: makeSession({
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
      }),
      projectWorkspacePath: "/tmp/project",
      platform: "darwin",
      isGitRepository: true,
      projects: [makeProject("project-1", "Current"), makeProject("project-2", "Destination")],
    });

    expect(JSON.stringify(flattenActionIds(items))).toBe(
      JSON.stringify([
        SESSION_CONTEXT_MENU_ACTION_IDS.togglePin,
        SESSION_CONTEXT_MENU_ACTION_IDS.rename,
        SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
        SESSION_CONTEXT_MENU_ACTION_IDS.archive,
        "separator",
        "session.moveToProject",
        sessionMoveToProjectActionId("project-2"),
        SESSION_CONTEXT_MENU_ACTION_IDS.removeFromProject,
        "session.section",
        SESSION_CONTEXT_MENU_ACTION_IDS.newSection,
        "separator",
        SESSION_CONTEXT_MENU_ACTION_IDS.reveal,
        "session.copy",
        SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory,
        SESSION_CONTEXT_MENU_ACTION_IDS.copySessionId,
        SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink,
        "session.fork",
        SESSION_CONTEXT_MENU_ACTION_IDS.forkLocal,
        SESSION_CONTEXT_MENU_ACTION_IDS.forkNewWorktree,
        "separator",
        SESSION_CONTEXT_MENU_ACTION_IDS.openInNewWindow,
      ]),
    );
  });

  test("marks the direct Section and turns selecting it into removal", () => {
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
    const sectionMenu = items.find(
      (item) => item.type === "submenu" && item.id === "session.section",
    );

    expect(sectionMenu?.type).toBe("submenu");
    if (sectionMenu?.type !== "submenu") return;
    const current = sectionMenu.submenu[0];
    expect(current?.type).toBe("checkbox");
    expect(current?.id).toBe(SESSION_CONTEXT_MENU_ACTION_IDS.removeFromSection);
    if (current?.type === "checkbox") expect(current.checked).toBe(true);
  });

  test("offers every other active Project and parses the selected destination", () => {
    const archived = {
      ...makeProject("project-archived", "Archived"),
      lifecycle: "archived" as const,
    };
    const items = buildSessionContextMenuItems({
      session: makeSession({
        projectId: "project-1",
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
      }),
      projects: [
        makeProject("project-1", "Current"),
        makeProject("project-2", "Destination"),
        archived,
      ],
    });
    const move = items.find(
      (item) => item.type === "submenu" && item.id === "session.moveToProject",
    );

    expect(move?.type).toBe("submenu");
    if (move?.type === "submenu") {
      expect(move.submenu.map((item) => (item.type === "separator" ? null : item.label))).toEqual([
        "Destination",
      ]);
      const destinationId =
        move.submenu[0]?.type === "separator" ? null : (move.submenu[0]?.id ?? "");
      expect(readSessionMoveToProjectActionId(destinationId ?? "")).toBe("project-2");
    }
    const remove = items.find(
      (item) =>
        item.type !== "separator" && item.id === SESSION_CONTEXT_MENU_ACTION_IDS.removeFromProject,
    );
    expect(remove?.type === "separator" ? null : remove?.label).toBe("Remove from Current");
  });

  test("preserves pin state when moving to another Project or back to Chats", () => {
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

  test("switches pin label and platform reveal label", () => {
    const items = buildSessionContextMenuItems({
      session: makeSession({ pinned: true, pinnedOrder: 0 }),
      projectWorkspacePath: "/tmp/project",
      platform: "win32",
    });

    expect(items[0]?.type).toBe(undefined);
    if (items[0]?.type !== "separator") {
      expect(items[0]?.label).toBe("Unpin");
    }
    const reveal = items.find(
      (item) => item.type !== "separator" && item.id === SESSION_CONTEXT_MENU_ACTION_IDS.reveal,
    );
    if (reveal?.type !== "separator") {
      expect(reveal?.label).toBe("Reveal in File Explorer");
    }
  });

  test("switches the explicit read-state action label in both directions", () => {
    const labelFor = (unread: boolean): string | null => {
      const item = buildSessionContextMenuItems({
        session: makeSession({ unread }),
      }).find(
        (candidate) =>
          candidate.type !== "separator" &&
          candidate.id === SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
      );
      return item?.type === "separator" ? null : (item?.label ?? null);
    };

    expect(labelFor(false)).toBe("Mark as unread");
    expect(labelFor(true)).toBe("Mark as read");
  });

  test("disables fork without an attached cwd and enables new worktree only for git repos", () => {
    const blankItems = buildSessionContextMenuItems({
      session: makeSession(),
      isGitRepository: true,
    });
    const blankFork = blankItems.find(
      (item) => item.type === "submenu" && item.id === "session.fork",
    );
    if (blankFork?.type === "submenu") {
      const localFork = blankFork.submenu[0];
      const worktreeFork = blankFork.submenu[1];
      if (localFork?.type !== "separator" && worktreeFork?.type !== "separator") {
        expect(localFork?.enabled).toBe(false);
        expect(worktreeFork?.enabled).toBe(false);
      }
    }

    const attached = makeSession({
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
    });
    const nonGitItems = buildSessionContextMenuItems({ session: attached, isGitRepository: false });
    const nonGitFork = nonGitItems.find(
      (item) => item.type === "submenu" && item.id === "session.fork",
    );
    if (nonGitFork?.type === "submenu") {
      const localFork = nonGitFork.submenu[0];
      const worktreeFork = nonGitFork.submenu[1];
      if (localFork?.type !== "separator" && worktreeFork?.type !== "separator") {
        expect(localFork?.enabled).toBe(true);
        expect(worktreeFork?.enabled).toBe(false);
      }
    }
  });
});
