import { defineMessages, FormattedMessage, useIntl, type MessageDescriptor } from "@/lib/i18n";
import { useState } from "react";
import type { Project, ProjectCreateInput } from "@/lib/types";
import {
  ArchiveIcon,
  MoonIcon,
  ProjectActionsIcon,
  ProjectCollapseAllIcon,
  ProjectRemovedIcon,
  ProjectReopenPreviousIcon,
  SidebarManualOrderIcon,
  ClockIcon,
  SidebarUpdatedIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import type { SidebarProjectGroupCollapseAction } from "@/lib/sidebar-project-group-collapse-action";
import {
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  type SidebarAutoSettleDays,
  type SidebarOrganize,
} from "@/lib/sidebar-chat-lifecycle";
import { normalizeSidebarChatOrder, type SidebarChatOrder } from "@/lib/sidebar-section-prefs";
import { CodexSidebarActionButton } from "./codex-sidebar";
import { SidebarProjectAddButton } from "./sidebar-project-add-button";
import { RemovedProjectsDialog } from "./removed-projects-dialog";

const PROJECT_SIDEBAR_OPTIONS_SUBMENU_CLASS = "min-w-[180px]";
const PROJECT_SIDEBAR_MENU_ICON_CLASS = "icon-xs";
export function SidebarProjectsSectionActions({
  chatOrder,
  onChatOrderChange,
  organize,
  autoSettleDays,
  onAutoSettleDaysChange,
  projectGroupCollapseAction,
  onProjectGroupCollapseAction,
  onCreateProject,
  openCreateDialogTick,
}: {
  chatOrder: SidebarChatOrder;
  onChatOrderChange: (chatOrder: SidebarChatOrder) => void;
  organize: SidebarOrganize;
  autoSettleDays: SidebarAutoSettleDays;
  onAutoSettleDaysChange: (days: SidebarAutoSettleDays) => void;
  projectGroupCollapseAction?: SidebarProjectGroupCollapseAction | null;
  onProjectGroupCollapseAction?: (action: SidebarProjectGroupCollapseAction) => void;
  onCreateProject: (input: ProjectCreateInput) => Promise<Project | null>;
  openCreateDialogTick: number;
}) {
  const intl = useIntl();
  const [removedProjectsOpen, setRemovedProjectsOpen] = useState(false);
  const collapseActionLabel =
    projectGroupCollapseAction === "collapse-all"
      ? intl.formatMessage({
          id: "workbench.sidebarProjectsSectionActions.collapseAll",
          defaultMessage: "Collapse all",
        })
      : projectGroupCollapseAction === "reopen-previous"
        ? intl.formatMessage({
            id: "workbench.sidebarProjectsSectionActions.reopenPrevious",
            defaultMessage: "Reopen previous",
          })
        : null;

  return (
    <>
      {projectGroupCollapseAction && collapseActionLabel ? (
        <CodexSidebarActionButton
          label={collapseActionLabel}
          data-app-action-sidebar-projects-collapse-action={projectGroupCollapseAction}
          onClick={() => onProjectGroupCollapseAction?.(projectGroupCollapseAction)}
        >
          {projectGroupCollapseAction === "collapse-all" ? (
            <ProjectCollapseAllIcon />
          ) : (
            <ProjectReopenPreviousIcon />
          )}
        </CodexSidebarActionButton>
      ) : null}
      <SidebarProjectOptionsMenu
        chatOrder={chatOrder}
        onChatOrderChange={onChatOrderChange}
        organize={organize}
        autoSettleDays={autoSettleDays}
        onAutoSettleDaysChange={onAutoSettleDaysChange}
        onOpenRemovedProjects={() => setRemovedProjectsOpen(true)}
      />
      <SidebarProjectAddButton
        onCreateProject={onCreateProject}
        openDialogTick={openCreateDialogTick}
      />
      <RemovedProjectsDialog open={removedProjectsOpen} onOpenChange={setRemovedProjectsOpen} />
    </>
  );
}

const sidebarChatOrderMessages = defineMessages({
  activity: {
    id: "workbench.sidebarProjectsSectionActions.lastUpdated",
    defaultMessage: "Last updated",
  },
  manual: {
    id: "workbench.sidebarProjectsSectionActions.manualOrder",
    defaultMessage: "Manual order",
  },
});

const SIDEBAR_CHAT_ORDER_OPTIONS = [
  { order: "activity", label: sidebarChatOrderMessages.activity, Icon: SidebarUpdatedIcon },
  { order: "manual", label: sidebarChatOrderMessages.manual, Icon: SidebarManualOrderIcon },
] as const satisfies readonly {
  order: SidebarChatOrder;
  label: MessageDescriptor;
  Icon: typeof SidebarUpdatedIcon;
}[];

/** Radio values are strings; "never" stands for leaving idle chats open. */
const AUTO_SETTLE_NEVER = "never";

function SidebarProjectOptionsMenu({
  chatOrder,
  onChatOrderChange,
  organize,
  autoSettleDays,
  onAutoSettleDaysChange,
  onOpenRemovedProjects,
}: {
  chatOrder: SidebarChatOrder;
  onChatOrderChange: (chatOrder: SidebarChatOrder) => void;
  organize: SidebarOrganize;
  autoSettleDays: SidebarAutoSettleDays;
  onAutoSettleDaysChange: (days: SidebarAutoSettleDays) => void;
  onOpenRemovedProjects: () => void;
}) {
  const intl = useIntl();
  const [open, setOpen] = useState(false);

  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      triggerButton={
        <CodexSidebarActionButton
          label={intl.formatMessage({
            id: "workbench.sidebarProjectsSectionActions.options",
            defaultMessage: "Project sidebar options",
          })}
          data-app-action-sidebar-project-options-menu=""
        >
          <ProjectActionsIcon />
        </CodexSidebarActionButton>
      }
    >
      <NodexDropdownItem
        disabled
        leftSlot={<ArchiveIcon className={PROJECT_SIDEBAR_MENU_ICON_CLASS} />}
        data-app-action-sidebar-project-options-archive-all=""
      >
        <FormattedMessage
          id="workbench.sidebarProjectsSectionActions.archiveAll"
          defaultMessage="Archive all chats"
        />
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<ProjectRemovedIcon className={PROJECT_SIDEBAR_MENU_ICON_CLASS} />}
        onSelect={() => {
          setOpen(false);
          onOpenRemovedProjects();
        }}
      >
        <FormattedMessage
          id="workbench.sidebarProjectsSectionActions.removed"
          defaultMessage="Removed projects…"
        />
      </NodexDropdownItem>
      <NodexDropdownSeparator paddingClassName="pt-1 pb-2" />
      {/* Arranged by attention, chats order themselves by when each came back. */}
      {organize === "project" ? (
        <NodexDropdownFlyoutSubmenuItem
          label={intl.formatMessage({
            id: "workbench.sidebarProjectsSectionActions.sort",
            defaultMessage: "Sort chats by",
          })}
          contentClassName={PROJECT_SIDEBAR_OPTIONS_SUBMENU_CLASS}
          leftSlot={<ClockIcon className={PROJECT_SIDEBAR_MENU_ICON_CLASS} />}
        >
          <NodexDropdownRadioGroup
            value={chatOrder}
            onValueChange={(value) => onChatOrderChange(normalizeSidebarChatOrder(value))}
          >
            {SIDEBAR_CHAT_ORDER_OPTIONS.map(({ order, label, Icon }) => (
              <NodexDropdownRadioItem
                key={order}
                value={order}
                leftSlot={<Icon className={PROJECT_SIDEBAR_MENU_ICON_CLASS} />}
                data-app-action-sidebar-chat-order={order}
              >
                {intl.formatMessage(label)}
              </NodexDropdownRadioItem>
            ))}
          </NodexDropdownRadioGroup>
        </NodexDropdownFlyoutSubmenuItem>
      ) : null}
      <NodexDropdownFlyoutSubmenuItem
        label={intl.formatMessage({
          id: "workbench.sidebarProjectsSectionActions.autoSettle",
          defaultMessage: "Settle idle chats",
        })}
        contentClassName={PROJECT_SIDEBAR_OPTIONS_SUBMENU_CLASS}
        leftSlot={<MoonIcon className={PROJECT_SIDEBAR_MENU_ICON_CLASS} />}
      >
        <NodexDropdownRadioGroup
          value={autoSettleDays === null ? AUTO_SETTLE_NEVER : String(autoSettleDays)}
          onValueChange={(value) =>
            onAutoSettleDaysChange(value === AUTO_SETTLE_NEVER ? null : Number(value))
          }
        >
          {SIDEBAR_AUTO_SETTLE_DAY_OPTIONS.map((days) => (
            <NodexDropdownRadioItem
              key={days}
              value={String(days)}
              data-app-action-sidebar-auto-settle={days}
            >
              <FormattedMessage
                id="workbench.sidebarProjectsSectionActions.autoSettleAfter"
                defaultMessage="{days, plural, one {After # day} other {After # days}}"
                values={{ days }}
              />
            </NodexDropdownRadioItem>
          ))}
          <NodexDropdownRadioItem
            value={AUTO_SETTLE_NEVER}
            data-app-action-sidebar-auto-settle="never"
          >
            <FormattedMessage
              id="workbench.sidebarProjectsSectionActions.autoSettleNever"
              defaultMessage="Never"
            />
          </NodexDropdownRadioItem>
        </NodexDropdownRadioGroup>
      </NodexDropdownFlyoutSubmenuItem>
    </NodexDropdownMenu>
  );
}
