import type { NativeContextMenuItem } from "../../../shared/native-context-menu";

export const PROJECT_CONTEXT_MENU_ACTION_IDS = {
  togglePin: "project.togglePin",
  edit: "project.edit",
  reveal: "project.reveal",
  createStableWorktree: "project.createStableWorktree",
  markAllRead: "project.markAllRead",
  archiveChats: "project.archiveChats",
  remove: "project.remove",
  newSection: "project.newSection",
} as const;

export const PROJECT_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX = "project.moveToSection:";

export function projectMoveToSectionActionId(sectionId: string): string {
  return `${PROJECT_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX}${sectionId}`;
}

export function readProjectMoveToSectionActionId(actionId: string): string | null {
  if (!actionId.startsWith(PROJECT_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX)) return null;
  return actionId.slice(PROJECT_CONTEXT_MENU_MOVE_TO_SECTION_PREFIX.length).trim() || null;
}

export interface ProjectContextMenuInput {
  readonly pinned: boolean;
  readonly showPinAction: boolean;
  readonly sectionItems?: readonly NativeContextMenuItem[];
  readonly revealLabel?: string;
  readonly canCreateStableWorktree: boolean;
  readonly canMarkAllRead: boolean;
  readonly canArchiveChats: boolean;
}

/** Builds the same grouped native menu for both row right-click and the overflow trigger. */
export function buildProjectContextMenuItems(
  input: ProjectContextMenuInput,
): NativeContextMenuItem[] {
  const organizationItems: NativeContextMenuItem[] = [];
  if (input.sectionItems) {
    organizationItems.push({
      id: "project.section",
      type: "submenu",
      label: "Section",
      iconKey: "section",
      submenu: [...input.sectionItems],
    });
  }
  if (input.revealLabel) {
    organizationItems.push({
      id: PROJECT_CONTEXT_MENU_ACTION_IDS.reveal,
      label: input.revealLabel,
      iconKey: "folderOpen",
    });
  }
  if (input.canCreateStableWorktree) {
    organizationItems.push({
      id: PROJECT_CONTEXT_MENU_ACTION_IDS.createStableWorktree,
      label: "Create permanent worktree",
      iconKey: "worktree",
    });
  }

  const chatItems: NativeContextMenuItem[] = [];
  if (input.canMarkAllRead) {
    chatItems.push({
      id: PROJECT_CONTEXT_MENU_ACTION_IDS.markAllRead,
      label: "Mark all as read",
      iconKey: "markRead",
    });
  }
  chatItems.push({
    id: PROJECT_CONTEXT_MENU_ACTION_IDS.archiveChats,
    label: "Archive chats",
    enabled: input.canArchiveChats,
    iconKey: "archive",
  });

  return [
    ...(input.showPinAction
      ? [
          {
            id: PROJECT_CONTEXT_MENU_ACTION_IDS.togglePin,
            label: input.pinned ? "Unpin" : "Pin",
            iconKey: input.pinned ? ("unpin" as const) : ("pin" as const),
          },
        ]
      : []),
    {
      id: PROJECT_CONTEXT_MENU_ACTION_IDS.edit,
      label: "Edit",
      iconKey: "edit",
    },
    ...(organizationItems.length > 0 ? [{ type: "separator" as const }, ...organizationItems] : []),
    { type: "separator" },
    ...chatItems,
    { type: "separator" },
    {
      id: PROJECT_CONTEXT_MENU_ACTION_IDS.remove,
      label: "Remove project",
      iconKey: "remove",
    },
  ];
}
