import { beforeAll, describe, expect, test } from "vite-plus/test";
import { bindRendererSpace } from "@/lib/renderer-space";
import { buildCommandPaletteCommands } from "@/lib/command-palette-commands";
import type { Project, ProjectSession } from "@/lib/types";
import {
  buildSessionContextMenuItems,
  SESSION_CONTEXT_MENU_ACTION_IDS,
  sessionMoveToProjectActionId,
} from "./session-context-menu-model";

const now = "2026-06-08T00:00:00.000Z";
const hosted: ProjectSession = {
  id: "session-1",
  projectId: "project-1",
  noThreadFallbackTitle: "Hosted work",
  displayTitle: "Hosted work",
  activityAt: 0,
  pinned: false,
  managed: true,
  pinnedOrder: null,
  archived: false,
  archivedAt: null,
  remindAt: null,
  canManage: true,
  canStop: true,
  unread: false,
  thread: null,
  executionRef: { runtimeId: "host-runtime", threadId: "root-1" },
  createdAt: now,
  updatedAt: now,
};
const projects = [
  { id: "project-1", name: "Platform", lifecycle: "active" },
  { id: "project-2", name: "Website", lifecycle: "active" },
] as unknown as readonly Project[];

type MenuItem = ReturnType<typeof buildSessionContextMenuItems>[number];
const ids = (items: readonly MenuItem[]): string[] =>
  items.flatMap((item) =>
    item.type === "separator"
      ? []
      : item.type === "submenu"
        ? [item.id, ...ids(item.submenu)]
        : [item.id],
  );
const palette = (activeSessionCanManage: boolean) =>
  buildCommandPaletteCommands({
    canGoBack: false,
    canGoForward: false,
    canStartNewChat: false,
    canStartNewChatInProject: false,
    canCreatePage: false,
    hasActiveSession: true,
    activeSessionPinned: false,
    activeSessionUnread: false,
    activeSessionCanManage,
    activeSessionReminded: true,
    hasAttachedThread: true,
    canExportConversationMarkdown: true,
    panelActionAvailability: {} as never,
    canOpenSessionInNewWindow: true,
    isMac: true,
  }).map((command) => command.id);

beforeAll(() => {
  bindRendererSpace({
    spaceId: "team",
    kind: "team",
    memberId: "alice",
    deviceId: "desktop",
    name: "Crew",
    availability: "ready",
  });
});

describe("a hosted chat's lifecycle", () => {
  test("is renamed, archived and moved from the sidebar menu by its owner or a Space Owner", () => {
    const offered = ids(buildSessionContextMenuItems({ session: hosted, projects }));
    for (const id of [
      SESSION_CONTEXT_MENU_ACTION_IDS.rename,
      SESSION_CONTEXT_MENU_ACTION_IDS.archive,
      "session.moveToProject",
      sessionMoveToProjectActionId("project-2"),
      SESSION_CONTEXT_MENU_ACTION_IDS.removeFromProject,
      SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
    ])
      expect(offered).toContain(id);
    for (const id of [SESSION_CONTEXT_MENU_ACTION_IDS.toggleManaged, "session.section"])
      expect(offered).not.toContain(id);
    expect(offered).toContain(SESSION_CONTEXT_MENU_ACTION_IDS.fork);
  });

  test("leaves another Member's chat as it is, while its pin and reminder stay this reader's", () => {
    const offered = ids(
      buildSessionContextMenuItems({ session: { ...hosted, canManage: false }, projects }),
    );
    for (const id of [
      SESSION_CONTEXT_MENU_ACTION_IDS.rename,
      SESSION_CONTEXT_MENU_ACTION_IDS.archive,
      "session.moveToProject",
    ])
      expect(offered).not.toContain(id);
    for (const id of [
      SESSION_CONTEXT_MENU_ACTION_IDS.togglePin,
      SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
      SESSION_CONTEXT_MENU_ACTION_IDS.fork,
      SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink,
      "session.remind",
    ])
      expect(offered).toContain(id);
    expect(offered.some((id) => id.startsWith("session.remindAt:"))).toBe(true);
  });

  test("follows the same rule in the command palette", () => {
    expect(palette(true)).toEqual(expect.arrayContaining(["renameThread", "archiveThread"]));
    const elsewhere = palette(false);
    expect(elsewhere).not.toContain("renameThread");
    expect(elsewhere).not.toContain("archiveThread");
    expect(elsewhere).toEqual(
      expect.arrayContaining([
        "toggleThreadPin",
        "toggleThreadUnread",
        "remindThreadInOneHour",
        "clearThreadReminder",
        "copyConversationMarkdown",
      ]),
    );
  });
});
