import { CloseIcon, FilterIcon, SidebarViewOptionsIcon } from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
  NodexDropdownSectionLabel,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
  NodexDropdownSummarySubmenuItem,
} from "@/components/ui/dropdown";
import { NodexTooltip } from "@/components/ui/tooltip";
import { defineMessages, useIntl, type MessageDescriptor } from "@/lib/i18n";
import {
  SIDEBAR_OPTIONAL_SHELVES,
  type SidebarOptionalShelf,
  type SidebarOrganize,
} from "@/lib/sidebar-chat-lifecycle";
import { cn } from "@/lib/utils";
import { CodexSidebarActionButton } from "./codex-sidebar";
import { SIDEBAR_HEADER_TOOL_BUTTON_CLASS } from "./sidebar-new-chat-controls";

export interface SidebarScopeProject {
  readonly id: string;
  readonly name: string;
  /** What waits in the Project's Inbox. */
  readonly inboxCount: number;
}

const ALL_PROJECTS = "";

/**
 * Turns the arrangement by attention on and off; off, chats sit under their Projects. The button
 * stays lit while it is on.
 */
export function SidebarArrangeToggle({
  organize,
  shortcutLabel,
  onOrganizeChange,
}: {
  organize: SidebarOrganize;
  shortcutLabel?: string;
  onOrganizeChange: (organize: SidebarOrganize) => void;
}) {
  const intl = useIntl();
  const byAttention = organize === "attention";
  const label = intl.formatMessage({
    id: "workbench.sidebarViewMenu.arrangeByAttention",
    defaultMessage: "Arrange by attention",
  });
  return (
    <NodexTooltip delayOpen tooltipContent={label} shortcutLabel={shortcutLabel} side="bottom">
      <button
        type="button"
        className={cn(
          SIDEBAR_HEADER_TOOL_BUTTON_CLASS,
          byAttention &&
            "bg-token-charts-blue/10 text-token-charts-blue hover:bg-token-charts-blue/15 hover:text-token-charts-blue",
        )}
        aria-label={label}
        aria-pressed={byAttention}
        data-app-action-sidebar-organize={organize}
        onClick={() => onOrganizeChange(byAttention ? "project" : "attention")}
      >
        <FilterIcon className="icon-xs" />
      </button>
    </NodexTooltip>
  );
}

const OPTIONAL_SHELF_LABELS: Readonly<Record<SidebarOptionalShelf, MessageDescriptor>> =
  defineMessages({
    pinned: { id: "workbench.sidebarViewMenu.pinned", defaultMessage: "Pinned" },
    working: { id: "workbench.sidebarViewMenu.working", defaultMessage: "Working" },
    snoozed: { id: "workbench.sidebarViewMenu.snoozed", defaultMessage: "Snoozed" },
    projects: { id: "workbench.sidebarViewMenu.projects", defaultMessage: "Projects" },
    settled: { id: "workbench.sidebarViewMenu.settled", defaultMessage: "Settled" },
  });

/** A scope's name with what waits in its Inbox; the radio's check keeps the row's end. */
function ScopeLabel({ name, inboxCount }: { name: string; inboxCount: number }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3">
      <span className="min-w-0 truncate-fade">{name}</span>
      {inboxCount > 0 ? (
        <span className="ms-auto text-xs text-token-description-foreground tabular-nums">
          {inboxCount}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Adjusts what the attention arrangement shows: which lists beside `Active`, and whose chats,
 * every Project's or one Project's. It sits beside the arrangement's first heading.
 */
export function SidebarLaneViewMenu({
  hiddenShelves,
  onHiddenShelvesChange,
  scopeProjectId,
  projects,
  libraryInboxCount,
  onScopeChange,
}: {
  hiddenShelves: readonly SidebarOptionalShelf[];
  onHiddenShelvesChange: (shelves: readonly SidebarOptionalShelf[]) => void;
  scopeProjectId: string | null;
  projects: readonly SidebarScopeProject[];
  libraryInboxCount: number;
  onScopeChange: (projectId: string | null) => void;
}) {
  const intl = useIntl();
  const allProjects = intl.formatMessage({
    id: "workbench.sidebarViewMenu.allProjects",
    defaultMessage: "All projects",
  });
  const scopeName = projects.find((project) => project.id === scopeProjectId)?.name ?? allProjects;
  const toggleShelf = (shelf: SidebarOptionalShelf) =>
    onHiddenShelvesChange(
      hiddenShelves.includes(shelf)
        ? hiddenShelves.filter((hidden) => hidden !== shelf)
        : [...hiddenShelves, shelf],
    );
  return (
    <NodexDropdownMenu
      align="end"
      contentWidth="menuBounded"
      triggerButton={
        <CodexSidebarActionButton
          label={intl.formatMessage({
            id: "workbench.sidebarViewMenu.label",
            defaultMessage: "View options",
          })}
          data-app-action-sidebar-view-options=""
        >
          <SidebarViewOptionsIcon />
        </CodexSidebarActionButton>
      }
    >
      <NodexDropdownSectionLabel>
        {intl.formatMessage({ id: "workbench.sidebarViewMenu.show", defaultMessage: "Show" })}
      </NodexDropdownSectionLabel>
      {SIDEBAR_OPTIONAL_SHELVES.map((shelf) => {
        const shown = !hiddenShelves.includes(shelf);
        return (
          <NodexDropdownItem
            key={shelf}
            role="menuitemcheckbox"
            aria-checked={shown}
            closeOnClick={false}
            rightSlot={shown ? <NodexDropdownSelectedIcon /> : null}
            data-app-action-sidebar-show-shelf={shelf}
            onSelect={() => toggleShelf(shelf)}
          >
            {intl.formatMessage(OPTIONAL_SHELF_LABELS[shelf])}
          </NodexDropdownItem>
        );
      })}
      <NodexDropdownSeparator />
      <NodexDropdownSummarySubmenuItem
        label={intl.formatMessage({
          id: "workbench.sidebarViewMenu.chatsFrom",
          defaultMessage: "Chats from",
        })}
        value={scopeName}
      >
        <NodexDropdownRadioGroup
          value={scopeProjectId ?? ALL_PROJECTS}
          onValueChange={(value) =>
            onScopeChange(value === ALL_PROJECTS ? null : (value as string))
          }
        >
          <NodexDropdownRadioItem value={ALL_PROJECTS} data-app-action-sidebar-scope-option="">
            <ScopeLabel name={allProjects} inboxCount={libraryInboxCount} />
          </NodexDropdownRadioItem>
          {projects.map((project) => (
            <NodexDropdownRadioItem
              key={project.id}
              value={project.id}
              data-app-action-sidebar-scope-option={project.id}
            >
              <ScopeLabel name={project.name} inboxCount={project.inboxCount} />
            </NodexDropdownRadioItem>
          ))}
        </NodexDropdownRadioGroup>
      </NodexDropdownSummarySubmenuItem>
      {hiddenShelves.length > 0 || scopeProjectId ? (
        <NodexDropdownItem
          data-app-action-sidebar-view-reset=""
          onSelect={() => {
            onHiddenShelvesChange([]);
            onScopeChange(null);
          }}
        >
          {intl.formatMessage({
            id: "workbench.sidebarViewMenu.reset",
            defaultMessage: "Show everything",
          })}
        </NodexDropdownItem>
      ) : null}
    </NodexDropdownMenu>
  );
}

/**
 * Names the one Project the lanes show and returns to every Project. It sits in the title row so
 * showing or clearing it never moves the rows below.
 */
export function SidebarScopeChip({
  projectName,
  onClear,
}: {
  projectName: string;
  onClear: () => void;
}) {
  const intl = useIntl();
  return (
    <button
      type="button"
      className="inline-flex h-6 max-w-28 min-w-0 items-center gap-1 rounded-md bg-token-charts-blue/10 ps-2 pe-1 text-xs text-token-charts-blue hover:bg-token-charts-blue/15"
      aria-label={intl.formatMessage(
        {
          id: "workbench.sidebarViewMenu.clearScope",
          defaultMessage: "Showing {project}. Show all projects",
        },
        { project: projectName },
      )}
      data-app-action-sidebar-scope=""
      onClick={onClear}
    >
      <span className="min-w-0 truncate-fade">{projectName}</span>
      <CloseIcon className="size-3 shrink-0 opacity-70" />
    </button>
  );
}
