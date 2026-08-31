import type { NativeContextMenuItem } from "../../../shared/native-context-menu";
import {
  codexSidebarProjectThreadContainerId,
  type CodexSidebarThreadContainerId,
} from "../../../shared/codex-sidebar-thread-move";
import type { Project, ProjectSession } from "@/lib/types";
import type { SidebarSectionSummary } from "../../../shared/sidebar-sections";
import type { FileLinkOpenerId } from "../../../shared/file-link-openers";
import { isCodexAgentBackendBinding } from "../../../shared/agent-backend";

export const SESSION_CONTEXT_MENU_MOVE_TO_PROJECT_PREFIX = "session.moveToProject:";
export const SESSION_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX = "session.moveToSection:";
export const SESSION_CONTEXT_MENU_OPEN_IN_PREFIX = "session.openIn:";

export const SESSION_CONTEXT_MENU_ACTION_IDS = {
  togglePin: "session.togglePin",
  removeFromProject: "session.removeFromProject",
  rename: "session.rename",
  archive: "archive-thread",
  markUnread: "session.markUnread",
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
  | `${typeof SESSION_CONTEXT_MENU_OPEN_IN_PREFIX}${FileLinkOpenerId}`;

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
  const hasCodexThread =
    session.thread !== null && isCodexAgentBackendBinding(session.thread.backendBinding);
  const supportsCodexConversationActions = session.thread?.backendBinding.kind !== "acp";
  const currentProject = input.projects?.find((project) => project.id === session.projectId);
  const projectMoveItems: NativeContextMenuItem[] = hasCodexThread
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
    ...(hasCodexThread && session.projectId
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
    {
      id: "session.section",
      type: "submenu",
      label: "Section",
      iconKey: "section",
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
  ];

  const copyItems: NativeContextMenuItem[] = [
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory,
      label: "Copy working directory",
      enabled: Boolean(session.thread?.cwd),
      iconKey: "copy",
    },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink,
      label: "Copy deeplink",
      enabled: true,
      iconKey: "copy",
    },
    ...(supportsCodexConversationActions
      ? [
          {
            id: SESSION_CONTEXT_MENU_ACTION_IDS.copyConversationMarkdown,
            label: "Copy as Markdown",
            enabled: hasCodexThread,
            iconKey: "copy" as const,
          },
        ]
      : []),
  ];

  const windowItems: NativeContextMenuItem[] = [
    ...(session.thread?.cwd && (input.openInTargets?.length ?? 0) > 0
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

  return [
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.togglePin,
      label: session.pinned ? "Unpin" : "Pin",
      enabled: true,
      iconKey: session.pinned ? "unpin" : "pin",
      accelerator: "Alt+CommandOrControl+P",
    },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.rename,
      label: "Rename",
      enabled: true,
      iconKey: "rename",
      accelerator: "Alt+CommandOrControl+R",
    },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
      label: session.unread ? "Mark as read" : "Mark as unread",
      enabled: true,
      iconKey: "unread",
      accelerator: "Shift+CommandOrControl+U",
    },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.archive,
      label: "Archive",
      enabled: true,
      iconKey: "archive",
      accelerator: "Shift+CommandOrControl+A",
    },
    { type: "separator" },
    ...organizationItems,
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
