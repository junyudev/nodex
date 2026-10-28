import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import {
  ArchiveIcon,
  AutomationMoreIcon,
  AutomationPauseIcon,
  AutomationResumeIcon,
  AutomationRunNowIcon,
  ChevronRightIcon,
  DeleteIcon,
  EditIcon,
  FilterIcon,
  InboxIcon,
  PlusIcon,
  SettingsSearchIcon,
} from "@/components/shared/icons";
import {
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSectionLabel,
  NodexDropdownSelectedIcon,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogFrame,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexTooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { resolveSidebarRowStatus } from "@/lib/sidebar-status";
import { SidebarStatusIndicator } from "@/components/workbench/sidebar-status-indicator";
import type { CodexScheduledAutomation } from "@/lib/types";
import {
  CODEX_SIDEBAR_THREAD_ROW_CLASS,
  CodexSidebarSection,
} from "@/components/workbench/codex-sidebar";
import {
  SIDEBAR_NEW_CHAT_ROW_CLASS,
  SIDEBAR_SCROLL_AREA_CLASS,
  WorkbenchSidebarHeader,
  useSidebarScrollChrome,
} from "@/components/workbench/sidebar-new-chat-controls";
import {
  WorkbenchSidebarFrame,
  type WorkbenchSidebarFrameProps,
} from "@/components/workbench/workbench-sidebar-frame";
import {
  ALL_SCHEDULED_STATUSES,
  buildScheduledTaskRows,
  type ScheduledRunRowModel,
  type ScheduledStatusFilter,
  type ScheduledTaskRowModel,
} from "./scheduled-task-model";
import type { ScheduledTasks } from "./use-scheduled-tasks";

/** The Scheduled sidebar's tasks and what it asks of its route. */
export interface ScheduledSidebarNavigation {
  readonly tasks: ScheduledTasks;
  readonly selectedTaskId: string | null;
  readonly activeRunSessionId: string | null;
  readonly onSelectTask: (task: CodexScheduledAutomation) => void;
  readonly onOpenRun: (task: CodexScheduledAutomation, run: ScheduledRunRowModel) => void;
  /** Opens the Inbox holding a task's waiting run: a Project's, or the Library's when null. */
  readonly onOpenInbox: (projectId: string | null) => void;
  readonly onCreateTask: () => void;
  readonly onEditTask: (task: CodexScheduledAutomation) => void;
  readonly onTaskDeleted: (task: CodexScheduledAutomation) => void;
}

const SEARCH_FIELD_ID = "scheduled-sidebar-search";
const RUN_PAGE_SIZE = 5;
const ROW_ACTION_BUTTON_CLASS =
  "no-drag flex size-6 cursor-interaction items-center justify-center rounded-md text-token-text-tertiary hover:bg-token-foreground/5 hover:text-token-foreground data-[state=open]:bg-token-foreground/5";

function TaskActionsMenu({
  task,
  tasks,
  onEditTask,
  onRequestDelete,
  onOpenChange,
}: {
  task: CodexScheduledAutomation;
  tasks: ScheduledTasks;
  onEditTask: (task: CodexScheduledAutomation) => void;
  onRequestDelete: (task: CodexScheduledAutomation) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const paused = task.status === "PAUSED";
  const busy = tasks.pendingTaskId === task.id;
  return (
    <NodexDropdownMenu
      align="start"
      contentWidth="menu"
      onOpenChange={onOpenChange}
      triggerTooltipContent="More task actions"
      triggerButton={
        <button type="button" aria-label="More task actions" className={ROW_ACTION_BUTTON_CLASS}>
          <AutomationMoreIcon className="icon-xs" />
        </button>
      }
    >
      <NodexDropdownItem
        disabled={busy}
        leftSlot={paused ? <AutomationResumeIcon /> : <AutomationPauseIcon />}
        onSelect={() => void tasks.setTaskStatus(task, paused ? "ACTIVE" : "PAUSED")}
      >
        {paused ? "Resume" : "Pause"}
      </NodexDropdownItem>
      <NodexDropdownItem
        disabled={busy}
        leftSlot={<AutomationRunNowIcon />}
        onSelect={() => void tasks.runTaskNow(task)}
      >
        Run now
      </NodexDropdownItem>
      <NodexDropdownItem leftSlot={<EditIcon />} onSelect={() => onEditTask(task)}>
        Edit
      </NodexDropdownItem>
      <NodexDropdownSeparator />
      <NodexDropdownItem
        disabled={busy}
        leftSlot={<DeleteIcon />}
        onSelect={() => onRequestDelete(task)}
      >
        Delete
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

function StatusSlot({
  running,
  unread,
  waiting = false,
}: {
  running: boolean;
  unread: boolean;
  /** A run is waiting for the user in the Inbox. */
  waiting?: boolean;
}) {
  const status = resolveSidebarRowStatus({
    unread,
    running,
    background: false,
    needsAttention: waiting,
  });
  if (!status) return null;
  return (
    <SidebarStatusIndicator
      status={status}
      label={
        status === "attention" ? "Waiting in Inbox" : status === "unread" ? "Unread" : undefined
      }
    />
  );
}

/** A folder's first row while a due run waits in the Inbox for the user. */
function WaitingRunRow({ onOpen }: { onOpen: () => void }) {
  return (
    <div role="listitem">
      <div
        role="button"
        tabIndex={0}
        className={cn(CODEX_SIDEBAR_THREAD_ROW_CLASS, "flex items-center gap-2 ps-7 pe-row-x")}
        onClick={onOpen}
        onKeyDown={(event) => activateOnKey(event, onOpen)}
      >
        <InboxIcon className="icon-xs shrink-0 text-token-description-foreground" />
        <span className="min-w-0 flex-1 truncate text-base leading-5 text-token-foreground">
          Waiting in Inbox
        </span>
        <StatusSlot running={false} unread={false} waiting />
      </div>
    </div>
  );
}

function activateOnKey(event: KeyboardEvent<HTMLElement>, action: () => void) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  action();
}

function ScheduledRunRow({
  run,
  active,
  onOpen,
  onArchive,
}: {
  run: ScheduledRunRowModel;
  active: boolean;
  onOpen: () => void;
  onArchive: () => void;
}) {
  return (
    <div role="listitem" className="group/run relative">
      <div
        role="button"
        tabIndex={run.canOpen ? 0 : -1}
        aria-disabled={!run.canOpen || undefined}
        aria-current={active ? "page" : undefined}
        className={cn(
          CODEX_SIDEBAR_THREAD_ROW_CLASS,
          "flex items-center gap-2 ps-7 pe-row-x",
          active && "bg-token-list-hover-background",
          !run.canOpen && "cursor-default hover:bg-transparent",
        )}
        onClick={run.canOpen ? onOpen : undefined}
        onKeyDown={(event) => run.canOpen && activateOnKey(event, onOpen)}
      >
        <span className="min-w-0 flex-1 truncate text-base leading-5 text-token-foreground">
          {run.title}
        </span>
        <span className="flex shrink-0 group-hover/run:hidden group-focus-within/run:hidden">
          <StatusSlot running={run.isRunning} unread={run.isUnread} />
        </span>
      </div>
      {run.isRunning ? null : (
        <button
          type="button"
          aria-label="Archive run"
          className={cn(
            ROW_ACTION_BUTTON_CLASS,
            "absolute end-1 top-1/2 hidden -translate-y-1/2 group-hover/run:flex group-focus-within/run:flex",
          )}
          onClick={onArchive}
        >
          <ArchiveIcon className="icon-xs" />
        </button>
      )}
    </div>
  );
}

function ScheduledTaskRow({
  row,
  tasks,
  selected,
  expanded,
  activeRunSessionId,
  onSelect,
  onOpenRun,
  onOpenInbox,
  onEditTask,
  onRequestDelete,
  onMenuOpenChange,
}: {
  row: ScheduledTaskRowModel;
  tasks: ScheduledTasks;
  selected: boolean;
  expanded: boolean;
  activeRunSessionId: string | null;
  onSelect: () => void;
  onOpenRun: (run: ScheduledRunRowModel) => void;
  onOpenInbox: () => void;
  onEditTask: (task: CodexScheduledAutomation) => void;
  onRequestDelete: (task: CodexScheduledAutomation) => void;
  onMenuOpenChange: (open: boolean) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [visibleRuns, setVisibleRuns] = useState(RUN_PAGE_SIZE);
  // An open folder shows status on its runs instead.
  const showUnread = row.hasUnreadRuns && !expanded;
  const highlighted = selected && (activeRunSessionId === null || !expanded);
  return (
    <div role="listitem" data-scheduled-task-id={row.automation.id}>
      <div
        role="button"
        tabIndex={0}
        aria-current={highlighted ? "page" : undefined}
        aria-expanded={row.canExpand ? expanded : undefined}
        className={cn(
          CODEX_SIDEBAR_THREAD_ROW_CLASS,
          "flex h-auto min-h-12 items-center gap-2 py-[5px] ps-row-x pe-[5px]",
          (highlighted || menuOpen) && "bg-token-list-hover-background",
        )}
        onClick={onSelect}
        onKeyDown={(event) => activateOnKey(event, onSelect)}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1 text-base leading-5 text-token-foreground">
            <span className="min-w-0 truncate">{row.title}</span>
            {row.canExpand ? (
              <ChevronRightIcon
                className={cn(
                  "icon-2xs shrink-0 text-token-description-foreground transition-transform duration-150",
                  expanded && "rotate-90",
                )}
              />
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1 text-xs leading-4 text-token-description-foreground">
            <span className="min-w-0 truncate">{row.subtitle}</span>
            {row.asksFirst && !row.waitingInInbox ? (
              <NodexTooltip tooltipContent="Asks in the Inbox before each run" side="bottom">
                <span
                  role="img"
                  aria-label="Asks in the Inbox before each run"
                  className="inline-flex shrink-0"
                >
                  <InboxIcon className="icon-2xs" />
                </span>
              </NodexTooltip>
            ) : null}
          </span>
        </span>
        <span
          className={cn(
            "flex shrink-0 items-center",
            !menuOpen && "group-hover:hidden group-focus-within:hidden",
            menuOpen && "hidden",
          )}
        >
          <StatusSlot
            running={row.isRunning && !expanded}
            unread={showUnread}
            waiting={row.waitingInInbox && !expanded}
          />
        </span>
        {/* The menu renders in a portal, but its events still bubble to this row. */}
        <span
          className={cn(
            "shrink-0",
            !menuOpen && "hidden group-hover:flex group-focus-within:flex",
            menuOpen && "flex",
          )}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <TaskActionsMenu
            task={row.automation}
            tasks={tasks}
            onEditTask={onEditTask}
            onRequestDelete={onRequestDelete}
            onOpenChange={(open) => {
              setMenuOpen(open);
              onMenuOpenChange(open);
            }}
          />
        </span>
      </div>
      {expanded ? (
        <div role="list" aria-label={`${row.title} runs`} className="flex flex-col gap-px pt-px">
          {row.waitingInInbox ? <WaitingRunRow onOpen={onOpenInbox} /> : null}
          {row.runs.slice(0, visibleRuns).map((run) => (
            <ScheduledRunRow
              key={run.runId}
              run={run}
              active={run.sessionId !== null && run.sessionId === activeRunSessionId}
              onOpen={() => onOpenRun(run)}
              onArchive={() => void tasks.archiveRun(run.runId)}
            />
          ))}
          {row.runs.length > visibleRuns ? (
            <button
              type="button"
              className="h-7 rounded-lg ps-7 text-left text-sm text-token-description-foreground hover:text-token-foreground"
              onClick={() => setVisibleRuns((current) => current + RUN_PAGE_SIZE * 2)}
            >
              Show older
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function StatusFilterMenu({
  filter,
  onChange,
  onOpenChange,
}: {
  filter: ScheduledStatusFilter;
  onChange: (filter: ScheduledStatusFilter) => void;
  onOpenChange: (open: boolean) => void;
}) {
  const choices = [
    { key: "active", label: "Active" },
    { key: "paused", label: "Paused" },
  ] as const;
  return (
    <NodexDropdownMenu
      align="start"
      contentWidth="menu"
      triggerTooltipContent="Filter tasks"
      onOpenChange={onOpenChange}
      triggerButton={
        <button type="button" aria-label="Filter tasks" className={ROW_ACTION_BUTTON_CLASS}>
          <FilterIcon className="icon-xs" />
        </button>
      }
    >
      <NodexDropdownSectionLabel>Filter by</NodexDropdownSectionLabel>
      {choices.map((choice) => {
        const checked = filter[choice.key];
        return (
          <NodexDropdownItem
            key={choice.key}
            role="menuitemcheckbox"
            aria-checked={checked}
            closeOnClick={false}
            rightSlot={checked ? <NodexDropdownSelectedIcon /> : null}
            onSelect={() => onChange({ ...filter, [choice.key]: !checked })}
          >
            {choice.label}
          </NodexDropdownItem>
        );
      })}
    </NodexDropdownMenu>
  );
}

function ScheduledSidebarSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3 px-2 py-2 motion-safe:animate-pulse">
      {[60, 44, 68, 36].map((width) => (
        <div key={width} className="flex items-center gap-2">
          <span className="size-4 rounded-full bg-token-foreground/[0.06]" />
          <span
            className="h-3 rounded-full bg-token-foreground/[0.06]"
            style={{ width: `${width}%` }}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * The Scheduled destination's sidebar: search, New task, and the task list. Cron tasks with runs
 * open as folders of their runs; selecting a run or a Heartbeat opens its chat in place.
 */
export function ScheduledSidebar({
  navigation,
  onHoverSurfaceOpenChange,
  ...frame
}: Omit<WorkbenchSidebarFrameProps, "children"> & {
  navigation: ScheduledSidebarNavigation;
  onHoverSurfaceOpenChange?: (open: boolean) => void;
}) {
  const tasks = navigation.tasks;
  // A floating sidebar stays open while one of its menus or dialogs is.
  const openSurfacesRef = useRef(new Set<string>());
  const setSurfaceOpen = (key: string, open: boolean) => {
    if (open) openSurfacesRef.current.add(key);
    else openSurfacesRef.current.delete(key);
    onHoverSurfaceOpenChange?.(openSurfacesRef.current.size > 0);
  };
  useEffect(() => () => onHoverSurfaceOpenChange?.(false), [onHoverSurfaceOpenChange]);
  const { scrollAreaRef, scrollChromeStyle, scrolledContentUnderHeader, syncScrollChrome } =
    useSidebarScrollChrome();
  const [searchQuery, setSearchQuery] = useState<string | null>(null);
  const [filter, setFilter] = useState<ScheduledStatusFilter>(ALL_SCHEDULED_STATUSES);
  const [sectionCollapsed, setSectionCollapsed] = useState(false);
  const [collapsedSelection, setCollapsedSelection] = useState<string | null>(null);
  const [deleteTarget, setDeleteTargetState] = useState<CodexScheduledAutomation | null>(null);
  const setDeleteTarget = (task: CodexScheduledAutomation | null) => {
    setDeleteTargetState(task);
    setSurfaceOpen("delete", task !== null);
  };
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputId = useId();
  const [now] = useState(() => new Date());
  const rows = buildScheduledTaskRows({
    automations: tasks.tasks,
    runItems: tasks.runItems,
    unreadAutomationIds: tasks.unreadTaskIds,
    filter,
    query: searchQuery ?? "",
    now,
  });
  const selectedTaskId = navigation.selectedTaskId;
  const isExpanded = (row: ScheduledTaskRowModel) =>
    row.canExpand && row.automation.id === selectedTaskId && collapsedSelection !== selectedTaskId;

  const selectRow = (row: ScheduledTaskRowModel) => {
    const isSelected = row.automation.id === selectedTaskId;
    if (isSelected && row.canExpand && navigation.activeRunSessionId === null) {
      setCollapsedSelection((current) => (current === selectedTaskId ? null : selectedTaskId));
      return;
    }
    setCollapsedSelection(null);
    navigation.onSelectTask(row.automation);
  };

  const closeSearch = () => {
    setSearchQuery(null);
    searchButtonRef.current?.focus();
  };

  let list;
  if (tasks.isError && tasks.tasks.length === 0) {
    list = (
      <div role="status" className="flex flex-col items-start gap-1 px-2 py-1 text-sm">
        <span className="text-token-description-foreground">
          Scheduled tasks could not be loaded
        </span>
        <button type="button" className="text-token-foreground" onClick={tasks.retry}>
          Try again
        </button>
      </div>
    );
  } else if (tasks.isLoading) {
    list = <ScheduledSidebarSkeleton />;
  } else if (rows.length === 0) {
    list = (
      <div role="status" className="px-2 py-1 text-sm text-token-description-foreground">
        {searchQuery?.trim() ? "No matching tasks" : "No scheduled tasks"}
      </div>
    );
  } else {
    list = (
      <div role="list" aria-label="Upcoming" className="flex flex-col gap-px">
        {rows.map((row) => (
          <ScheduledTaskRow
            key={row.automation.id}
            row={row}
            tasks={tasks}
            selected={row.automation.id === selectedTaskId}
            expanded={isExpanded(row)}
            activeRunSessionId={navigation.activeRunSessionId}
            onSelect={() => selectRow(row)}
            onOpenRun={(run) => {
              if (run.isUnread) void tasks.markRunRead(run.runId);
              navigation.onOpenRun(row.automation, run);
            }}
            onOpenInbox={() =>
              navigation.onOpenInbox(row.automation.heldFiring?.inboxProjectId ?? null)
            }
            onEditTask={navigation.onEditTask}
            onRequestDelete={setDeleteTarget}
            onMenuOpenChange={(open) => setSurfaceOpen(`task:${row.automation.id}`, open)}
          />
        ))}
      </div>
    );
  }

  return (
    <WorkbenchSidebarFrame {...frame} testId="scheduled-sidebar">
      <nav
        aria-label="Scheduled task folders"
        className="sidebar-foreground-muted flex h-full min-h-0 flex-col overflow-hidden [--height-token-nav-row:30px] [--padding-row-cell-x:8px] [--padding-row-x:8px] [--radius-token-row:10px]"
        style={scrollChromeStyle}
      >
        <WorkbenchSidebarHeader
          title="Scheduled"
          scrolledContentUnderHeader={scrolledContentUnderHeader}
          onSearch={() => (searchQuery === null ? setSearchQuery("") : closeSearch())}
          inlineSearch={{
            label: "Search scheduled tasks",
            expanded: searchQuery !== null,
            controlsId: SEARCH_FIELD_ID,
            buttonRef: searchButtonRef,
            field: (
              <label
                id={SEARCH_FIELD_ID}
                htmlFor={searchInputId}
                className="flex h-9 items-center gap-2 rounded-full bg-token-foreground/[0.055] px-3"
              >
                <SettingsSearchIcon className="icon-xs shrink-0 text-token-description-foreground" />
                <input
                  id={searchInputId}
                  // The field exists only because the user asked to search.
                  autoFocus
                  aria-label="Search scheduled tasks"
                  placeholder="Search scheduled tasks"
                  value={searchQuery ?? ""}
                  className="min-w-0 flex-1 bg-transparent text-base text-token-foreground outline-none placeholder:text-token-description-foreground"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key !== "Escape") return;
                    event.preventDefault();
                    event.stopPropagation();
                    closeSearch();
                  }}
                />
              </label>
            ),
          }}
        >
          <button
            type="button"
            className={SIDEBAR_NEW_CHAT_ROW_CLASS}
            onClick={() => {
              setSearchQuery(null);
              navigation.onCreateTask();
            }}
          >
            <span className="flex min-w-0 flex-1 items-center gap-2 text-base text-token-foreground">
              <PlusIcon className="icon-xs" />
              <span className="truncate">New task</span>
            </span>
          </button>
        </WorkbenchSidebarHeader>
        <div
          ref={scrollAreaRef}
          data-app-action-sidebar-scroll=""
          className={SIDEBAR_SCROLL_AREA_CLASS}
          onScroll={syncScrollChrome}
        >
          <CodexSidebarSection
            heading="Upcoming"
            collapsed={sectionCollapsed}
            onToggle={() => setSectionCollapsed((current) => !current)}
            actions={
              <StatusFilterMenu
                filter={filter}
                onChange={setFilter}
                onOpenChange={(open) => setSurfaceOpen("filter", open)}
              />
            }
          >
            {list}
          </CodexSidebarSection>
        </div>
      </nav>
      <NodexDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <NodexDialogContent size="compact">
          <NodexDialogFrame>
            <NodexDialogHeader>
              <NodexDialogTitle>Delete scheduled task?</NodexDialogTitle>
              <NodexDialogDescription>
                “{deleteTarget?.name}” will stop running. Its past runs stay in your chats.
              </NodexDialogDescription>
            </NodexDialogHeader>
            <NodexDialogFooter>
              <NodexDialogAction onClick={() => setDeleteTarget(null)}>Cancel</NodexDialogAction>
              <NodexDialogAction
                tone="danger"
                disabled={deleteTarget !== null && tasks.pendingTaskId === deleteTarget.id}
                onClick={() => {
                  const target = deleteTarget;
                  if (!target) return;
                  void tasks.deleteTask(target).then((deleted) => {
                    setDeleteTarget(null);
                    if (deleted) navigation.onTaskDeleted(target);
                  });
                }}
              >
                Delete
              </NodexDialogAction>
            </NodexDialogFooter>
          </NodexDialogFrame>
        </NodexDialogContent>
      </NodexDialog>
    </WorkbenchSidebarFrame>
  );
}
