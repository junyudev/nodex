import type { NativeContextMenuItem } from "../../../shared/native-context-menu";
import {
  codexSidebarProjectThreadContainerId,
  type CodexSidebarThreadContainerId,
} from "../../../shared/codex-sidebar-thread-move";
import type { Project, ProjectSession } from "@/lib/types";
import type { SidebarSectionSummary } from "../../../shared/sidebar-sections";

export const SESSION_CONTEXT_MENU_MOVE_TO_PROJECT_PREFIX = "session.moveToProject:";
export const SESSION_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX = "session.moveToSection:";

export const SESSION_CONTEXT_MENU_ACTION_IDS = {
  togglePin: "session.togglePin",
  removeFromProject: "session.removeFromProject",
  rename: "session.rename",
  archive: "archive-thread",
  markUnread: "session.markUnread",
  reveal: "session.reveal",
  copyWorkingDirectory: "session.copyWorkingDirectory",
  copySessionId: "session.copySessionId",
  copyDeeplink: "session.copyDeeplink",
  forkLocal: "session.forkLocal",
  forkNewWorktree: "session.forkNewWorktree",
  openInNewWindow: "session.openInNewWindow",
  newSection: "session.newSection",
  removeFromSection: "session.removeFromSection",
} as const;

export type SessionContextMenuActionId =
  | (typeof SESSION_CONTEXT_MENU_ACTION_IDS)[keyof typeof SESSION_CONTEXT_MENU_ACTION_IDS]
  | `${typeof SESSION_CONTEXT_MENU_MOVE_TO_PROJECT_PREFIX}${string}`
  | `${typeof SESSION_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX}${string}`;

export interface SessionContextMenuInput {
  session: ProjectSession;
  projects?: readonly Project[];
  projectWorkspacePath?: string | null;
  platform?: NodeJS.Platform | "browser";
  isGitRepository?: boolean;
  sections?: readonly SidebarSectionSummary[];
  directSectionId?: string | null;
}

export function resolveSessionRevealPath(input: {
  session: ProjectSession;
  projectWorkspacePath?: string | null;
}): string | null {
  return input.session.thread?.cwd?.trim() || input.projectWorkspacePath?.trim() || null;
}

export function resolveRevealInFileManagerLabel(
  platform: NodeJS.Platform | "browser" | undefined,
): string {
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Reveal in File Explorer";
  return "Reveal in File Manager";
}

export function canForkSessionLocally(session: ProjectSession): boolean {
  return Boolean(session.thread?.threadId && session.thread.cwd);
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
  const revealPath = resolveSessionRevealPath(input);
  const forkLocalEnabled = canForkSessionLocally(session);
  const forkNewWorktreeEnabled = forkLocalEnabled && input.isGitRepository === true;
  const currentProject = input.projects?.find((project) => project.id === session.projectId);
  const projectMoveItems: NativeContextMenuItem[] = session.thread
    ? (input.projects ?? [])
        .filter((project) => project.lifecycle === "active" && project.id !== session.projectId)
        .map((project) => ({
          id: sessionMoveToProjectActionId(project.id),
          label: project.name,
          enabled: true,
        }))
    : [];
  const projectMoveActions: NativeContextMenuItem[] = [
    ...(projectMoveItems.length === 0
      ? []
      : [
          {
            id: "session.moveToProject",
            type: "submenu" as const,
            label: "Project",
            iconKey: "project" as const,
            submenu: projectMoveItems,
          },
        ]),
    ...(session.thread && session.projectId
      ? [
          {
            id: SESSION_CONTEXT_MENU_ACTION_IDS.removeFromProject,
            label: `Remove from ${currentProject?.name ?? "project"}`,
            enabled: true,
            iconKey: "folder" as const,
          },
        ]
      : []),
  ];

  return [
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.togglePin,
      label: session.pinned ? "Unpin" : "Pin",
      enabled: true,
      iconKey: session.pinned ? "unpin" : "pin",
    },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.rename,
      label: "Rename",
      enabled: true,
      iconKey: "rename",
    },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.markUnread,
      label: session.unread ? "Mark as read" : "Mark as unread",
      enabled: true,
      iconKey: "unread",
    },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.archive,
      label: "Archive",
      enabled: true,
      iconKey: "archive",
    },
    { type: "separator" },
    ...projectMoveActions,
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
          type: "checkbox" as const,
          label: section.name ?? "Untitled section",
          enabled: true,
          checked: input.directSectionId === section.sectionId,
        })),
        {
          id: SESSION_CONTEXT_MENU_ACTION_IDS.newSection,
          label: "New section…",
          enabled: true,
        },
      ],
    },
    { type: "separator" },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.reveal,
      label: resolveRevealInFileManagerLabel(input.platform),
      enabled: Boolean(revealPath),
      iconKey: "folder",
    },
    {
      id: "session.copy",
      type: "submenu",
      label: "Copy",
      iconKey: "copy",
      submenu: [
        {
          id: SESSION_CONTEXT_MENU_ACTION_IDS.copyWorkingDirectory,
          label: "Copy working directory",
          enabled: Boolean(session.thread?.cwd),
        },
        {
          id: SESSION_CONTEXT_MENU_ACTION_IDS.copySessionId,
          label: "Copy session ID",
          enabled: true,
        },
        {
          id: SESSION_CONTEXT_MENU_ACTION_IDS.copyDeeplink,
          label: "Copy deeplink",
          enabled: true,
        },
      ],
    },
    {
      id: "session.fork",
      type: "submenu",
      label: "Fork",
      iconKey: "fork",
      submenu: [
        {
          id: SESSION_CONTEXT_MENU_ACTION_IDS.forkLocal,
          label: "Fork into local",
          enabled: forkLocalEnabled,
        },
        {
          id: SESSION_CONTEXT_MENU_ACTION_IDS.forkNewWorktree,
          label: "Fork into new worktree",
          enabled: forkNewWorktreeEnabled,
        },
      ],
    },
    { type: "separator" },
    {
      id: SESSION_CONTEXT_MENU_ACTION_IDS.openInNewWindow,
      label: "Open in new window",
      enabled: true,
      iconKey: "window",
    },
  ];
}
