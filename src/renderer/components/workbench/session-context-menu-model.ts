import type { NativeContextMenuItem } from "../../../shared/native-context-menu";
import {
  codexSidebarProjectThreadContainerId,
  type CodexSidebarThreadContainerId,
} from "../../../shared/codex-sidebar-thread-move";
import type { Project, ProjectSession } from "@/lib/types";
import type { SidebarSectionSummary } from "../../../shared/sidebar-sections";
import type { FileLinkOpenerId } from "../../../shared/file-link-openers";
import {
  resolveSessionExecution,
  resolveSessionExecutionLocation,
  resolveSessionForkAvailability,
  resolveSessionMarkdownExport,
  resolveSessionProjectMove,
  type SessionExecutionLocation,
} from "@/lib/session-execution";
import { sessionForkDestinations, type SessionForkDestination } from "@/lib/session-fork";
import { chatReminderPresets, describeChatReminder } from "@/lib/chat-reminder";
import { isHostedChat } from "@/lib/hosted-chat";

export const SESSION_CONTEXT_MENU_MOVE_TO_PROJECT_PREFIX = "session.moveToProject:";
export const SESSION_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX = "session.moveToSection:";
export const SESSION_CONTEXT_MENU_OPEN_IN_PREFIX = "session.openIn:";
export const SESSION_CONTEXT_MENU_REMIND_AT_PREFIX = "session.remindAt:";

export const SESSION_CONTEXT_MENU_ACTION_IDS = {
  togglePin: "session.togglePin",
  toggleManaged: "session.toggleManaged",
  removeFromProject: "session.removeFromProject",
  rename: "session.rename",
  archive: "archive-thread",
  fork: "session.fork",
  forkInNewWorktree: "session.forkInNewWorktree",
  markUnread: "session.markUnread",
  clearReminder: "session.clearReminder",
  copyWorkingDirectory: "session.copyWorkingDirectory",
  copyDeeplink: "session.copyDeeplink",
  copyConversationMarkdown: "session.copyConversationMarkdown",
  openInNewWindow: "session.openInNewWindow",
  newSection: "session.newSection",
  removeFromSection: "session.removeFromSection",
} as const;

export type SessionContextMenuActionId =
  | (typeof SESSION_CONTEXT_MENU_ACTION_IDS)[keyof typeof SESSION_CONTEXT_MENU_ACTION_IDS]
  | `${typeof SESSION_CONTEXT_MENU_MOVE_TO_PROJECT_PREFIX}${string}`
  | `${typeof SESSION_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX}${string}`
  | `${typeof SESSION_CONTEXT_MENU_OPEN_IN_PREFIX}${FileLinkOpenerId}`
  | `${typeof SESSION_CONTEXT_MENU_REMIND_AT_PREFIX}${string}`;

export interface SessionContextMenuOpenInTarget {
  readonly id: FileLinkOpenerId;
  readonly label: string;
  readonly iconUrl?: string;
}

export interface SessionContextMenuInput {
  session: ProjectSession;
  projects?: readonly Project[];
  sections?: readonly SidebarSectionSummary[];
  directSectionId?: string | null;
  openInTargets?: readonly SessionContextMenuOpenInTarget[];
  /** Runtime location comes from its execution owner; native location defaults to Core metadata. */
  location?: SessionExecutionLocation | null;
  forkDestinations?: readonly SessionForkDestination[];
  /** Reminder presets and descriptions are relative to when the menu opens. */
  now?: Date;
}

export function sessionMoveToProjectActionId(projectId: string): SessionContextMenuActionId {
  return `${SESSION_CONTEXT_MENU_MOVE_TO_PROJECT_PREFIX}${projectId}`;
}

export function readSessionMoveToProjectActionId(actionId: string): string | null {
  if (!actionId.startsWith(SESSION_CONTEXT_MENU_MOVE_TO_PROJECT_PREFIX)) return null;
  return actionId.slice(SESSION_CONTEXT_MENU_MOVE_TO_PROJECT_PREFIX.length).trim() || null;
}

export function sessionMoveToSectionActionId(sectionId: string): SessionContextMenuActionId {
  return `${SESSION_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX}${sectionId}`;
}

export function readSessionMoveToSectionActionId(actionId: string): string | null {
  if (!actionId.startsWith(SESSION_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX)) return null;
  return actionId.slice(SESSION_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX.length).trim() || null;
}

export function sessionOpenInActionId(openerId: FileLinkOpenerId): SessionContextMenuActionId {
  return `${SESSION_CONTEXT_MENU_OPEN_IN_PREFIX}${openerId}`;
}

/** A reminder preset carries its instant, so the chosen time is the one the menu showed. */
export function sessionRemindAtActionId(remindAt: string): SessionContextMenuActionId {
  return `${SESSION_CONTEXT_MENU_REMIND_AT_PREFIX}${remindAt}`;
}

export function readSessionRemindAtActionId(actionId: string): string | null {
  if (!actionId.startsWith(SESSION_CONTEXT_MENU_REMIND_AT_PREFIX)) return null;
  const remindAt = actionId.slice(SESSION_CONTEXT_MENU_REMIND_AT_PREFIX.length).trim();
  return remindAt && Number.isFinite(Date.parse(remindAt)) ? remindAt : null;
}

/** "Remind me" offers the presets; a pending reminder first says when, and can be cancelled. */
function buildSessionReminderSubmenu(remindAt: string | null, now: Date): NativeContextMenuItem {
  const presets: NativeContextMenuItem[] = chatReminderPresets(now).map((preset) => ({
    id: sessionRemindAtActionId(preset.remindAt),
    label: preset.label,
    enabled: true,
  }));
  return {
    id: "session.remind",
    type: "submenu",
    label: "Remind me",
    iconKey: "reminder",
    submenu: remindAt
      ? [
          {
            id: "session.reminderStatus",
            label: describeChatReminder(remindAt, now),
            enabled: false,
          },
          { type: "separator" },
          ...presets,
          { type: "separator" },
          {
            id: SESSION_CONTEXT_MENU_ACTION_IDS.clearReminder,
            label: "Cancel reminder",
            enabled: true,
          },
        ]
      : presets,
  };
}

export function readSessionOpenInActionId(actionId: string): FileLinkOpenerId | null {
  if (!actionId.startsWith(SESSION_CONTEXT_MENU_OPEN_IN_PREFIX)) return null;
  const openerId = actionId.slice(SESSION_CONTEXT_MENU_OPEN_IN_PREFIX.length).trim();
  return openerId ? (openerId as FileLinkOpenerId) : null;
}

export function resolveSessionProjectMoveContainers(
  session: Pick<ProjectSession, "pinned" | "projectId">,
  targetProjectId: string | null,
): {
  sourceContainerId: CodexSidebarThreadContainerId;
  targetContainerId: CodexSidebarThreadContainerId;
} {
  const sourceContainerId =
    session.projectId === null
      ? session.pinned
        ? "pinned"
        : "chats"
      : codexSidebarProjectThreadContainerId(session.projectId, session.pinned);
  const targetContainerId =
    targetProjectId === null
      ? session.pinned
        ? "pinned"
        : "chats"
      : codexSidebarProjectThreadContainerId(targetProjectId, session.pinned);
  return { sourceContainerId, targetContainerId };
}

export function buildSessionContextMenuItems(
  input: SessionContextMenuInput,
): NativeContextMenuItem[] {
  const { session } = input;
  const hosted = isHostedChat();
  const execution = resolveSessionExecution(session);
  const canMoveProject = resolveSessionProjectMove(session) !== null;
  const markdownExport = resolveSessionMarkdownExport(execution);
  // Native non-Codex history exports from its open conversation, not from the Session menu.
  const offersMarkdownExport = execution.kind !== "native" || markdownExport !== null;
  const location =
    input.location === undefined
      ? resolveSessionExecutionLocation(execution, null)
      : input.location;
  const cwd = location?.cwd ?? null;
  const forkItems: NativeContextMenuItem[] = resolveSessionForkAvailability(execution).available
    ? [
        {
          id: "session.forkMenu",
          type: "submenu",
          label: "Fork",
          iconKey: "fork",
          submenu: (
            input.forkDestinations ??
            sessionForkDestinations({
              isWorktree: Boolean(location?.managedWorktreePath),
              canCreateWorktree: false,
            })
          ).map((destination) => ({
            id:
              destination.target === "newWorktree"
                ? SESSION_CONTEXT_MENU_ACTION_IDS.forkInNewWorktree
                : SESSION_CONTEXT_MENU_ACTION_IDS.fork,
            label: destination.label,
            enabled: true,
            iconKey: destination.target === "newWorktree" ? "worktree" : "fork",
          })),
        },
      ]
    : [];
  const currentProject = input.projects?.find((project) => project.id === session.projectId);
  const projectMoveItems: NativeContextMenuItem[] = canMoveProject
    ? (input.projects ?? [])
        .filter((project) => project.lifecycle === "active" && project.id !== session.projectId)
        .map((project) => ({
          id: sessionMoveToProjectActionId(project.id),
          label: project.name,
          enabled: true,
          iconKey: "folder" as const,
        }))
    : [];
  const projectSubmenuItems: NativeContextMenuItem[] = [
    ...projectMoveItems,
    ...(canMoveProject && session.projectId
      ? [
          ...(projectMoveItems.length > 0 ? [{ type: "separator" as const }] : []),
          {
            id: SESSION_CONTEXT_MENU_ACTION_IDS.removeFromProject,
            label: `Remove from ${currentProject?.name ?? "project"}`,
            enabled: true,
            iconKey: "folder" as const,
          },
        ]
      : []),
  ];

  const organizationItems: NativeContextMenuItem[] = [
    ...(projectSubmenuItems.length > 0
      ? [
          {
            id: "session.moveToProject",
            type: "submenu" as const,
            label: "Project",
            iconKey: "project" as const,
            submenu: projectSubmenuItems,
          },
        ]
      : []),
    ...(hosted
      ? []
      : [
          {
            id: "session.section",
            type: "submenu" as const,
            label: "Section",
            iconKey: "section" as const,
            submenu: [
              ...(input.sections ?? []).map((section) => ({
                id:
                  input.directSectionId === section.sectionId
                    ? SESSION_CONTEXT_MENU_ACTION_IDS.removeFromSection
                    : sessionMoveToSectionActionId(section.sectionId),
                label: `${input.directSectionId === section.sectionId ? "✓ " : ""}${section.name ?? "Untitled section"}`,
                enabled: true,
              })),
              ...((input.sections?.length ?? 0) > 0 ? [{ type: "separator" as const }] : []),
              {
                id: SESSION_CONTEXT_MENU_ACTION_IDS.newSection,
                label: "New section…",
                enabled: true,
              },
            ],
          },
        ]),
  ];

  const copyItems: NativeContextMenuItem[] = [
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory,
      label: "Copy working directory",
      enabled: cwd !== null,
      iconKey: "copy",
    },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink,
      label: "Copy deeplink",
      enabled: true,
      iconKey: "copy",
    },
    ...(offersMarkdownExport
      ? [
          {
            id: SESSION_CONTEXT_MENU_ACTION_IDS.copyConversationMarkdown,
            label: "Copy as Markdown",
            enabled: markdownExport !== null,
            iconKey: "copy" as const,
          },
        ]
      : []),
  ];

  const windowItems: NativeContextMenuItem[] = [
    ...(cwd && (input.openInTargets?.length ?? 0) > 0
      ? [
          {
            id: "session.openIn",
            type: "submenu" as const,
            label: "Open in",
            iconKey: "openIn" as const,
            submenu: (input.openInTargets ?? []).map((target) => ({
              id: sessionOpenInActionId(target.id),
              label: target.label,
              iconUrl: target.iconUrl,
            })),
          },
        ]
      : []),
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.openInNewWindow,
      label: "Open in new window",
      enabled: true,
      iconKey: "window",
    },
  ];

  const markUnread: NativeContextMenuItem = {
    id: SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
    label: session.unread ? "Mark as read" : "Mark as unread",
    enabled: true,
    iconKey: "unread",
    accelerator: "Shift+CommandOrControl+U",
  };
  // Pins and reminders are each Member's own. The chat's owner or a Space Owner renames and
  // archives a chat every Member shares; Nodex management stays out of a team Space's chats.
  const lifecycleItems: NativeContextMenuItem[] = [
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.togglePin,
      label: session.pinned ? "Unpin" : "Pin",
      enabled: true,
      iconKey: session.pinned ? "unpin" : "pin",
      accelerator: "Alt+CommandOrControl+P",
    },
    ...(session.canManage
      ? [
          {
            id: SESSION_CONTEXT_MENU_ACTION_IDS.rename,
            label: "Rename",
            enabled: true,
            iconKey: "rename" as const,
            accelerator: "Alt+CommandOrControl+R",
          },
        ]
      : []),
    markUnread,
    buildSessionReminderSubmenu(session.remindAt, input.now ?? new Date()),
    ...(!hosted && !session.archived
      ? [
          {
            id: SESSION_CONTEXT_MENU_ACTION_IDS.toggleManaged,
            type: "checkbox" as const,
            label: "Managed by Nodex",
            checked: session.managed,
            enabled: true,
          },
        ]
      : []),
    ...(session.canManage
      ? [
          {
            id: SESSION_CONTEXT_MENU_ACTION_IDS.archive,
            label: "Archive",
            enabled: true,
            iconKey: "archive" as const,
            accelerator: "Shift+CommandOrControl+A",
          },
        ]
      : []),
  ];

  return [
    ...lifecycleItems,
    ...(forkItems.length > 0 ? [{ type: "separator" as const }, ...forkItems] : []),
    ...(organizationItems.length > 0 ? [{ type: "separator" as const }, ...organizationItems] : []),
    { type: "separator" },
    {
      id: "session.copy",
      type: "submenu",
      label: "Copy",
      iconKey: "copy",
      submenu: copyItems,
    },
    { type: "separator" },
    ...windowItems,
  ];
}
