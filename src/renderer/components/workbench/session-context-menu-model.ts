import { getIntl } from "@/lib/i18n";
import { commandTitleMessage } from "../../../shared/command-keybindings";
import {
  joinNativeContextMenuGroups,
  type NativeContextMenuItem,
} from "../../../shared/native-context-menu";
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
import { chatSnoozePresets, describeChatSnooze } from "@/lib/chat-snooze";
import { isHostedChat } from "@/lib/hosted-chat";

export const SESSION_CONTEXT_MENU_MOVE_TO_PROJECT_PREFIX = "session.moveToProject:";
export const SESSION_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX = "session.moveToSection:";
export const SESSION_CONTEXT_MENU_OPEN_IN_PREFIX = "session.openIn:";
export const SESSION_CONTEXT_MENU_SNOOZED_UNTIL_PREFIX = "session.snoozedUntil:";

export const SESSION_CONTEXT_MENU_ACTION_IDS = {
  togglePin: "session.togglePin",
  removeFromProject: "session.removeFromProject",
  rename: "session.rename",
  archive: "archive-thread",
  fork: "session.fork",
  forkInNewWorktree: "session.forkInNewWorktree",
  markUnread: "session.markUnread",
  toggleSettled: "session.toggleSettled",
  wake: "session.wake",
  copySessionId: "session.copySessionId",
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
  | `${typeof SESSION_CONTEXT_MENU_SNOOZED_UNTIL_PREFIX}${string}`;

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
  /** Snooze presets and descriptions are relative to when the menu opens. */
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

/** A snooze preset carries its instant, so the chosen time is the one the menu showed. */
export function sessionSnoozedUntilActionId(snoozedUntil: string): SessionContextMenuActionId {
  return `${SESSION_CONTEXT_MENU_SNOOZED_UNTIL_PREFIX}${snoozedUntil}`;
}

export function readSessionSnoozedUntilActionId(actionId: string): string | null {
  if (!actionId.startsWith(SESSION_CONTEXT_MENU_SNOOZED_UNTIL_PREFIX)) return null;
  const snoozedUntil = actionId.slice(SESSION_CONTEXT_MENU_SNOOZED_UNTIL_PREFIX.length).trim();
  return snoozedUntil && Number.isFinite(Date.parse(snoozedUntil)) ? snoozedUntil : null;
}

/** A pending snooze shows its return time and Wake before the presets. */
function buildSessionSnoozeSubmenu(snoozedUntil: string | null, now: Date): NativeContextMenuItem {
  const intl = getIntl();
  const presets: NativeContextMenuItem[] = chatSnoozePresets(now).map((preset) => ({
    id: sessionSnoozedUntilActionId(preset.snoozedUntil),
    label: preset.label,
    enabled: true,
  }));
  return {
    id: "session.snooze",
    type: "submenu",
    label: intl.formatMessage({
      id: "workbench.sessionContextMenuModel.snooze",
      defaultMessage: "Snooze",
    }),
    iconKey: "snooze",
    commandId: "snoozeThread",
    submenu: snoozedUntil
      ? [
          {
            id: "session.snoozeStatus",
            label: describeChatSnooze(snoozedUntil, now),
            enabled: false,
          },
          {
            id: SESSION_CONTEXT_MENU_ACTION_IDS.wake,
            label: intl.formatMessage({
              id: "workbench.sessionContextMenuModel.wake",
              defaultMessage: "Wake",
            }),
            iconKey: "play",
          },
          { type: "separator" },
          ...presets,
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
  const intl = getIntl();
  const { session } = input;
  const hosted = isHostedChat();
  const execution = resolveSessionExecution(session);
  const canMoveProject = resolveSessionProjectMove(session) !== null;
  const markdownExport = resolveSessionMarkdownExport(execution);
  const location =
    input.location === undefined
      ? resolveSessionExecutionLocation(execution, null)
      : input.location;
  const cwd = location?.cwd ?? null;
  const forkDestinations = resolveSessionForkAvailability(execution).available
    ? (input.forkDestinations ??
      sessionForkDestinations({
        isWorktree: Boolean(location?.managedWorktreePath),
        canCreateWorktree: false,
      }))
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
            label: currentProject
              ? intl.formatMessage(
                  {
                    id: "workbench.sessionContextMenuModel.removeFromNamedProject",
                    defaultMessage: "Remove from {project}",
                  },
                  { project: currentProject.name },
                )
              : intl.formatMessage({
                  id: "workbench.sessionContextMenuModel.removeFromProject",
                  defaultMessage: "Remove from project",
                }),
            enabled: true,
            iconKey: "remove" as const,
          },
        ]
      : []),
  ];

  const sectionName = (section: SidebarSectionSummary) =>
    section.name ??
    intl.formatMessage({
      id: "workbench.sessionContextMenuModel.untitledSection",
      defaultMessage: "Untitled section",
    });
  const sections = input.sections ?? [];
  const currentSection = sections.find((section) => section.sectionId === input.directSectionId);
  const sectionDestinations: NativeContextMenuItem[] = sections
    .filter((section) => section !== currentSection)
    .map((section) => ({
      id: sessionMoveToSectionActionId(section.sectionId),
      label: sectionName(section),
      iconKey: "section",
    }));

  const organizationItems: NativeContextMenuItem[] = [
    ...(projectSubmenuItems.length > 0
      ? [
          {
            id: "session.moveToProject",
            type: "submenu" as const,
            label: intl.formatMessage({
              id: "workbench.sessionContextMenuModel.project",
              defaultMessage: "Project",
            }),
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
            label: intl.formatMessage({
              id: "workbench.sessionContextMenuModel.section",
              defaultMessage: "Section",
            }),
            iconKey: "section" as const,
            submenu: joinNativeContextMenuGroups(
              sectionDestinations,
              [
                {
                  id: SESSION_CONTEXT_MENU_ACTION_IDS.newSection,
                  label: intl.formatMessage({
                    id: "workbench.sessionContextMenuModel.newSection",
                    defaultMessage: "New section",
                  }),
                  iconKey: "newTab",
                },
              ],
              currentSection
                ? [
                    {
                      id: SESSION_CONTEXT_MENU_ACTION_IDS.removeFromSection,
                      label: intl.formatMessage(
                        {
                          id: "workbench.sessionContextMenuModel.removeFromSection",
                          defaultMessage: "Remove from {section}",
                        },
                        { section: sectionName(currentSection) },
                      ),
                      iconKey: "remove",
                    },
                  ]
                : [],
            ),
          },
        ]),
  ];

  const windowItems: NativeContextMenuItem[] = [
    ...(cwd && (input.openInTargets?.length ?? 0) > 0
      ? [
          {
            id: "session.openIn",
            type: "submenu" as const,
            label: intl.formatMessage({
              id: "workbench.sessionContextMenuModel.openIn",
              defaultMessage: "Open in",
            }),
            iconKey: "openIn" as const,
            submenu: (input.openInTargets ?? []).map<NativeContextMenuItem>((target) => ({
              id: sessionOpenInActionId(target.id),
              label: target.label,
              iconUrl: target.iconUrl,
              iconKey: "openIn",
            })),
          },
        ]
      : []),
  ];

  return joinNativeContextMenuGroups(
    ...buildChatActionGroups({
      canRename: session.canManage,
      pinned: session.pinned,
      unread: session.unread,
      settled: session.archived ? undefined : session.settledAt != null,
      canSnooze: true,
      snoozedUntil: session.snoozedUntil,
      now: input.now ?? new Date(),
      forkDestinations,
      organizationItems,
      canCopyWorkingDirectory: Boolean(cwd),
      canCopyLink: true,
      canCopyMarkdown: markdownExport !== null,
      windowItems,
      canOpenInNewWindow: true,
      canArchive: session.canManage,
    }),
  );
}

interface ChatActionGroupsInput {
  readonly canRename: boolean;
  readonly pinned?: boolean;
  readonly unread?: boolean;
  readonly settled?: boolean;
  readonly canSnooze: boolean;
  readonly snoozedUntil?: string | null;
  readonly now: Date;
  readonly forkDestinations: readonly SessionForkDestination[];
  readonly newSideChat?: NativeContextMenuItem;
  readonly clearContext?: NativeContextMenuItem;
  readonly organizationItems?: readonly NativeContextMenuItem[];
  readonly canCopyWorkingDirectory: boolean;
  readonly canCopySessionId?: boolean;
  readonly canCopyLink: boolean;
  readonly canCopyMarkdown: boolean;
  readonly windowItems?: readonly NativeContextMenuItem[];
  readonly canOpenInNewWindow?: boolean;
  readonly canArchive: boolean;
}

/** The sidebar and chat header project the same ordered actions for the capabilities they have. */
export function buildChatActionGroups(input: ChatActionGroupsInput) {
  const intl = getIntl();
  const identity: NativeContextMenuItem[] = [];
  if (input.canRename)
    identity.push({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.rename,
      label: intl.formatMessage({
        id: "workbench.sessionContextMenuModel.rename",
        defaultMessage: "Rename",
      }),
      iconKey: "rename",
      commandId: "renameThread",
    });
  if (input.pinned !== undefined)
    identity.push({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.togglePin,
      label: input.pinned
        ? intl.formatMessage({
            id: "workbench.sessionContextMenuModel.unpin",
            defaultMessage: "Unpin",
          })
        : intl.formatMessage({
            id: "workbench.sessionContextMenuModel.pin",
            defaultMessage: "Pin",
          }),
      iconKey: input.pinned ? "unpin" : "pin",
      commandId: "toggleThreadPin",
    });
  if (input.unread !== undefined)
    identity.push({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
      label: input.unread
        ? intl.formatMessage({
            id: "workbench.sessionContextMenuModel.markRead",
            defaultMessage: "Mark as read",
          })
        : intl.formatMessage({
            id: "workbench.sessionContextMenuModel.markUnread",
            defaultMessage: "Mark as unread",
          }),
      iconKey: input.unread ? "markRead" : "unread",
      commandId: "toggleThreadUnread",
    });
  if (input.settled !== undefined)
    identity.push({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.toggleSettled,
      label: input.settled
        ? intl.formatMessage({
            id: "workbench.sessionContextMenuModel.reopen",
            defaultMessage: "Reopen",
          })
        : intl.formatMessage({
            id: "workbench.sessionContextMenuModel.settle",
            defaultMessage: "Settle",
          }),
      iconKey: input.settled ? "undo" : "markRead",
      commandId: "settleThread",
    });
  if (input.canSnooze)
    identity.push(buildSessionSnoozeSubmenu(input.snoozedUntil ?? null, input.now));

  const newWork: NativeContextMenuItem[] = [];
  if (input.newSideChat) newWork.push(input.newSideChat);
  if (input.forkDestinations.length > 0)
    newWork.push({
      id: "session.forkMenu",
      type: "submenu",
      label: intl.formatMessage({
        id: "workbench.sessionContextMenuModel.fork",
        defaultMessage: "Fork",
      }),
      iconKey: "fork",
      submenu: input.forkDestinations.map((destination) => ({
        id:
          destination.target === "newWorktree"
            ? SESSION_CONTEXT_MENU_ACTION_IDS.forkInNewWorktree
            : SESSION_CONTEXT_MENU_ACTION_IDS.fork,
        label: destination.label,
        iconKey: destination.iconKey,
      })),
    });
  if (input.clearContext) newWork.push(input.clearContext);

  const copyItems: NativeContextMenuItem[] = [];
  if (input.canCopyWorkingDirectory)
    copyItems.push({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory,
      label: intl.formatMessage({
        id: "workbench.sessionContextMenuModel.copyWorkingDirectory",
        defaultMessage: "Copy working directory",
      }),
      iconKey: "copy",
    });
  if (input.canCopySessionId)
    copyItems.push({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.copySessionId,
      label: intl.formatMessage({
        id: "conversation.stageHeader.copySessionId",
        defaultMessage: "Copy session ID",
      }),
      iconKey: "copy",
    });
  if (input.canCopyLink)
    copyItems.push({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink,
      label: intl.formatMessage({
        id: "workbench.sessionContextMenuModel.copyDeeplink",
        defaultMessage: "Copy link",
      }),
      iconKey: "link",
    });
  if (input.canCopyMarkdown)
    copyItems.push({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.copyConversationMarkdown,
      label: intl.formatMessage(
        commandTitleMessage({ id: "copyConversationMarkdown", title: "Copy as Markdown" }),
      ),
      iconKey: "copy",
      commandId: "copyConversationMarkdown",
    });

  const copy: NativeContextMenuItem[] =
    copyItems.length > 0
      ? [
          {
            id: "session.copy",
            type: "submenu",
            label: intl.formatMessage({
              id: "workbench.sessionContextMenuModel.copy",
              defaultMessage: "Copy",
            }),
            iconKey: "copy",
            submenu: copyItems,
          },
        ]
      : [];
  const windows = [...(input.windowItems ?? [])];
  if (input.canOpenInNewWindow) {
    windows.push({
      id: SESSION_CONTEXT_MENU_ACTION_IDS.openInNewWindow,
      label: intl.formatMessage({
        id: "workbench.sessionContextMenuModel.openInNewWindow",
        defaultMessage: "Open in new window",
      }),
      iconKey: "window",
      commandId: "openThreadInNewWindow",
    });
  }
  const archive: NativeContextMenuItem[] = input.canArchive
    ? [
        {
          id: SESSION_CONTEXT_MENU_ACTION_IDS.archive,
          label: intl.formatMessage({
            id: "workbench.sessionContextMenuModel.archive",
            defaultMessage: "Archive",
          }),
          iconKey: "archive",
          commandId: "archiveThread",
        },
      ]
    : [];

  return [identity, newWork, input.organizationItems ?? [], copy, windows, archive] as const;
}
