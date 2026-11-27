import { getIntl } from "@/lib/i18n";
import {
  joinNativeContextMenuGroups,
  type NativeContextMenuItem,
} from "../../../shared/native-context-menu";

export const PROJECT_CONTEXT_MENU_ACTION_IDS = {
  togglePause: "project.togglePause",
  togglePin: "project.togglePin",
  edit: "project.edit",
  reveal: "project.reveal",
  createStableWorktree: "project.createStableWorktree",
  markAllRead: "project.markAllRead",
  archiveChats: "project.archiveChats",
  remove: "project.remove",
  newSection: "project.newSection",
  moveToProjects: "project.moveToProjects",
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
  readonly paused?: boolean;
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
  const intl = getIntl();
  const revealItems: NativeContextMenuItem[] = input.revealLabel
    ? [
        {
          id: PROJECT_CONTEXT_MENU_ACTION_IDS.reveal,
          label: input.revealLabel,
          iconKey: "folder",
        },
      ]
    : [];
  const organizationItems: NativeContextMenuItem[] = [];
  if (input.sectionItems?.length) {
    organizationItems.push({
      id: "project.section",
      type: "submenu",
      label: intl.formatMessage({
        id: "workbench.projectContextMenuModel.section",
        defaultMessage: "Section",
      }),
      iconKey: "section",
      submenu: [...input.sectionItems],
    });
  }
  if (input.canCreateStableWorktree) {
    organizationItems.push({
      id: PROJECT_CONTEXT_MENU_ACTION_IDS.createStableWorktree,
      label: intl.formatMessage({
        id: "workbench.projectContextMenuModel.createPermanentWorktree",
        defaultMessage: "Create permanent worktree",
      }),
      iconKey: "worktree",
    });
  }

  const chatItems: NativeContextMenuItem[] = [];
  if (input.canMarkAllRead) {
    chatItems.push({
      id: PROJECT_CONTEXT_MENU_ACTION_IDS.markAllRead,
      label: intl.formatMessage({
        id: "workbench.projectContextMenuModel.markAllAsRead",
        defaultMessage: "Mark all as read",
      }),
      iconKey: "markRead",
    });
  }
  if (input.canArchiveChats)
    chatItems.push({
      id: PROJECT_CONTEXT_MENU_ACTION_IDS.archiveChats,
      label: intl.formatMessage({
        id: "workbench.projectContextMenuModel.archiveChats",
        defaultMessage: "Archive chats",
      }),
      iconKey: "archive",
    });

  return joinNativeContextMenuGroups(
    revealItems,
    [
      {
        id: PROJECT_CONTEXT_MENU_ACTION_IDS.togglePause,
        iconKey: input.paused ? "play" : "pause",
        label: input.paused
          ? intl.formatMessage({
              id: "workbench.projectContextMenuModel.resumeAllWork",
              defaultMessage: "Resume all work",
            })
          : intl.formatMessage({
              id: "workbench.projectContextMenuModel.pauseAllWork",
              defaultMessage: "Pause all work",
            }),
      },
      ...(input.showPinAction
        ? [
            {
              id: PROJECT_CONTEXT_MENU_ACTION_IDS.togglePin,
              label: input.pinned
                ? intl.formatMessage({
                    id: "workbench.projectContextMenuModel.unpin",
                    defaultMessage: "Unpin",
                  })
                : intl.formatMessage({
                    id: "workbench.projectContextMenuModel.pin",
                    defaultMessage: "Pin",
                  }),
              iconKey: input.pinned ? ("unpin" as const) : ("pin" as const),
            },
          ]
        : []),
      {
        id: PROJECT_CONTEXT_MENU_ACTION_IDS.edit,
        label: intl.formatMessage({
          id: "workbench.projectContextMenuModel.edit",
          defaultMessage: "Edit",
        }),
        iconKey: "edit",
      },
      ...organizationItems,
    ],
    chatItems,
    [
      {
        id: PROJECT_CONTEXT_MENU_ACTION_IDS.remove,
        label: intl.formatMessage({
          id: "workbench.projectContextMenuModel.removeProject",
          defaultMessage: "Remove project",
        }),
        iconKey: "remove",
      },
    ],
  );
}
