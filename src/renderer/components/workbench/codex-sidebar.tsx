import type {
  ComponentPropsWithoutRef,
  CSSProperties,
  KeyboardEvent,
  MouseEvent,
  PointerEvent,
  Ref,
  ReactNode,
} from "react";
import {
  forwardRef,
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AnimatePresence, motion } from "motion/react";
import { useSortable } from "@dnd-kit/sortable";
import { useCombinedRefs, type Transform } from "@dnd-kit/utilities";
import {
  BranchStatusIcon,
  CheckmarkIcon,
  ArchiveIcon,
  CloseIcon,
  PageIcon,
  PinOffIcon,
  ProjectFolderIcon,
  ProjectFolderOpenIcon,
  ProjectActionsIcon,
  RemoteStatusIcon,
  SessionPinFilledIcon,
  SessionPinIcon,
  SettingsGeneralIcon,
  ChevronDownIcon,
  WorktreeStatusIcon,
} from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownMenu } from "@/components/ui/dropdown";
import { NodexHoverCard } from "@/components/ui/hover-card";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import { toast } from "@/components/ui/toast";
import { getGitWorkerClient } from "@/lib/api";
import { openFileLink } from "@/lib/file-system-operations";
import { CODEX_SIDEBAR_PROJECT_FOLDER_TRANSITION } from "@/lib/codex-panel-motion";
import { formatElapsedSince, getNextElapsedTimeUpdateDelay } from "@/lib/elapsed-time";
import { CODEX_SIDEBAR_PAGER_BUTTON_CLASS } from "@/lib/codex-sidebar-pagination";
import {
  isCodexSidebarRemoteLocation,
  isCodexSidebarWorktreeLocation,
  resolveCodexSidebarWorktreeLabel,
} from "@/lib/codex-sidebar-run-location";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { serializeSortableTranslation } from "@/lib/sortable-transform";
import { projectCatalogStoreFor } from "@/lib/project-catalog";
import {
  gitRepositoryIdentityQueryOptions,
  localPathPresentationContextQueryOptions,
} from "@/lib/query-options";
import type {
  CodexSidebarThreadItem,
  Project,
  ProjectActivitySummary,
  ProjectLifecycleMutationResult,
  ProjectPinnedInput,
  ProjectSession,
  ProjectUpdateInput,
} from "@/lib/types";
import { useProjectAppearanceMutation } from "@/lib/use-project-appearance-mutation";
import { useRuntimeSessionLiveState } from "@/lib/use-session-execution";
import {
  projectSidebarThreadRowLiveView,
  type SidebarThreadRowLiveView,
} from "@/lib/sidebar-thread-row-live-view";
import { runtimeSessionTarget, SESSION_LIVE_INDICATOR_LABELS } from "@/lib/session-execution";
import {
  useSessionLinkedPage,
  type SessionLinkedPage,
  type SessionLinkedPageStore,
} from "@/lib/session-linked-page";
import { StatusIcon } from "@/lib/status-presentation";
import { SidebarStatusIndicator } from "./sidebar-status-indicator";
import { resolveSidebarGroupStatus } from "@/lib/sidebar-status";
import { cn } from "@/lib/utils";
import {
  workspaceProjectCommands,
  workspaceSidebarCommands,
} from "@/lib/workspace-catalog-commands";
import {
  SIDEBAR_NEW_CHAT_ROW_CLASS,
  SIDEBAR_PROJECT_NEW_CHAT_BUTTON_CLASS,
  SidebarProjectNewChatButton,
} from "./sidebar-new-chat-controls";
import {
  getSidebarGroupDndId,
  type SidebarGroupDndController,
  type SidebarGroupDndPayload,
  useSidebarProjectDndState,
} from "./sidebar-project-group-dnd";
import { useSidebarThreadProjectDropTargets } from "./sidebar-thread-reorder";
import { StableWorktreeCreateDialog } from "./stable-worktree-create-dialog";
import { suggestStableWorktreeProjectName } from "./stable-worktree-production";
import { ProjectArchiveChatsDialog, runProjectThreadBatches } from "./project-archive-chats-dialog";
import { ProjectEditDialog } from "./project-edit-dialog";
import { ProjectHoverCard } from "./project-hover-card";
import {
  mergeRuntimeProjectActivity,
  type ProjectRuntimeSessionFacts,
} from "./project-hover-card-model";
import {
  useAgentRuntimeActivities,
  type AgentRuntimeActivityStore,
} from "@/lib/agent-runtime-session-activity";
import { ProjectMarker } from "./project-marker";
import { ProjectRemoveDialog } from "./project-remove-dialog";
import {
  PROJECT_CONTEXT_MENU_ACTION_IDS,
  buildProjectContextMenuItems,
  projectMoveToSectionActionId,
  readProjectMoveToSectionActionId,
} from "./project-context-menu-model";
import { canShowNativeContextMenu, showNativeContextMenu } from "@/lib/native-context-menu";
import type {
  NativeContextMenuItem,
  NativeContextMenuOptions,
} from "../../../shared/native-context-menu";
import type { SidebarSectionsCatalog } from "./sidebar-custom-sections";
import { SidebarSectionNameDialog } from "./sidebar-section-name-dialog";

type SidebarRowActionEvent =
  | MouseEvent<HTMLElement>
  | PointerEvent<HTMLElement>
  | KeyboardEvent<HTMLElement>;

export const CODEX_SIDEBAR_GROUP_ROW_CLASS =
  "group/folder-row group relative flex h-token-nav-row cursor-interaction items-center justify-between overflow-x-hidden rounded-lg text-sm text-token-foreground hover:bg-token-list-hover-background focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]";
export const CODEX_SIDEBAR_DISCLOSURE_CHEVRON_CLASS =
  "icon-2xs shrink-0 opacity-0 transition-transform";
export const CODEX_SIDEBAR_SECTION_ACTIONS_CLASS =
  "flex items-center gap-1 pointer-events-none opacity-0 group-focus-within/projects-section-header:pointer-events-auto group-focus-within/projects-section-header:opacity-100 group-hover/projects-section-header:pointer-events-auto group-hover/projects-section-header:opacity-100 has-[[aria-expanded=true]]:pointer-events-auto has-[[aria-expanded=true]]:opacity-100";
export const CODEX_SIDEBAR_SECTION_ACTION_BUTTON_CLASS =
  "border-token-border no-drag cursor-interaction flex items-center gap-1 border whitespace-nowrap select-none focus:outline-none disabled:cursor-not-allowed disabled:opacity-40 rounded-full electron:rounded-md enabled:hover:bg-token-list-hover-background aria-expanded:bg-token-list-hover-background border-transparent electron:p-1 electron:[&>svg]:icon-sm flex items-center justify-center p-0.5 h-6 w-6 rounded-md !p-1 text-(--color-text-secondary-ghost) hover:text-(--color-text-secondary-ghost-hover)";
export const CODEX_SIDEBAR_GROUP_ACTION_BUTTON_CLASS = SIDEBAR_PROJECT_NEW_CHAT_BUTTON_CLASS;
export const CODEX_SIDEBAR_THREAD_ROW_CLASS =
  "group relative h-token-nav-row cursor-interaction rounded-lg py-row-y text-sm hover:bg-token-list-hover-background focus-visible:outline-offset-[-2px]";
export const CODEX_SIDEBAR_THREAD_ACTION_RAIL_CLASS =
  "pointer-events-none absolute right-0 top-0 z-10 mr-0.5 flex h-full w-[52px] items-center justify-end gap-2 pr-0.5 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 [&:has(:focus-visible)]:opacity-100";
export const CODEX_SIDEBAR_THREAD_ARCHIVE_BUTTON_CLASS =
  "!h-5 !w-5 !p-0 opacity-50 hover:opacity-100 focus-visible:opacity-100 [&>svg]:!h-4 [&>svg]:!w-4 pointer-events-auto";
export const CODEX_SIDEBAR_ROW_LABEL_CLASS =
  "flex min-w-0 flex-1 cursor-interaction items-center whitespace-nowrap rounded-md py-1 pl-1 pr-0 text-left text-base text-token-foreground";
const CODEX_SIDEBAR_THREAD_PIN_BUTTON_CLASS =
  "pointer-events-auto flex h-5 w-5 items-center justify-center leading-none text-token-foreground/70 hover:text-token-foreground [&>svg]:!h-4 [&>svg]:!w-4";
const CODEX_SIDEBAR_THREAD_HOVER_CARD_FALLBACK_PROJECT_LABEL = "Chat";

export const CodexSidebarTreeRow = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div"> & {
    readonly active?: boolean;
    readonly depth?: number;
  }
>(function CodexSidebarTreeRow({ active = false, depth, className, style, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      data-active={active ? "true" : undefined}
      className={cn(
        CODEX_SIDEBAR_GROUP_ROW_CLASS,
        active && "bg-token-list-hover-background text-token-text-primary",
        className,
      )}
      style={
        depth === undefined
          ? style
          : {
              ...style,
              paddingInlineStart: `${Math.max(0, depth - 1) * 14}px`,
            }
      }
    />
  );
});

export function CodexSidebarRowLayout({
  leadingRef,
  leadingSlot,
  leadingSlotData,
  leadingSlotProps,
  actions,
  children,
}: {
  readonly leadingRef?: Ref<HTMLSpanElement>;
  readonly leadingSlot: ReactNode;
  readonly leadingSlotData?: Readonly<Record<string, string>>;
  readonly leadingSlotProps?: ComponentPropsWithoutRef<"span">;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <>
      <div className="flex min-w-0 flex-1 items-center">
        <span
          {...leadingSlotProps}
          {...leadingSlotData}
          ref={leadingRef}
          className={cn(
            "relative ml-1 flex h-6 w-6 shrink-0 items-center justify-center",
            leadingSlotProps?.className,
          )}
        >
          {leadingSlot}
        </span>
        {children}
      </div>
      {actions ? <div className="flex gap-1">{actions}</div> : null}
    </>
  );
}

export const CodexSidebarPagerButton = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button">
>(function CodexSidebarPagerButton({ className, type = "button", ...props }, ref) {
  return (
    <button
      {...props}
      ref={ref}
      type={type}
      className={cn(CODEX_SIDEBAR_PAGER_BUTTON_CLASS, className)}
    />
  );
});

const NOOP_SIDEBAR_GROUP_DND_CONTROLLER: SidebarGroupDndController = {
  handleDragEnd: () => undefined,
};

export function getCodexSidebarSortableStyle(
  transform: Transform | null,
  transition: string | undefined,
): CSSProperties {
  return {
    transform: serializeSortableTranslation(transform),
    transition,
  };
}

export function stopCodexSidebarRowActionPropagation(event: SidebarRowActionEvent) {
  event.stopPropagation();
}

function stopCodexSidebarRowActionKeyPropagation(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "Enter" && event.key !== " ") return;
  event.stopPropagation();
}

// Portals still bubble through their React owner; rows only activate for DOM-owned events.
function isEventWithinCurrentTarget(event: SidebarRowActionEvent): boolean {
  return event.target instanceof Node && event.currentTarget.contains(event.target);
}

function clearCodexSidebarTextSelection(): void {
  document.getSelection()?.removeAllRanges();
}

function isMacPlatform() {
  return typeof navigator !== "undefined" && navigator.platform.toUpperCase().includes("MAC");
}

function normalizePrimaryWorkspaceRoot(project: Project) {
  return project.primaryWorkspaceRoot?.trim() || "";
}

function normalizeProjectSources(project: Project): string[] {
  return project.sources.map((source) => source.root).filter((root) => root.trim().length > 0);
}

export function CodexSidebarTopAction({
  label,
  icon,
  shortcutLabel,
  active = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  shortcutLabel?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <div className="shrink-0 px-row-x">
      <div className="flex flex-col gap-px">
        <CodexSidebarTopActionButton
          label={label}
          icon={icon}
          shortcutLabel={shortcutLabel}
          active={active}
          onClick={onClick}
        />
      </div>
    </div>
  );
}

export function CodexSidebarTopActionButton({
  label,
  icon,
  shortcutLabel,
  active = false,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  shortcutLabel?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={cn(SIDEBAR_NEW_CHAT_ROW_CLASS, active && "bg-token-list-hover-background")}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-base text-token-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      {shortcutLabel ? (
        <span
          aria-hidden="true"
          className="opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
        >
          <ShortcutKeycaps keys={[shortcutLabel]} tone="current" />
        </span>
      ) : null}
    </button>
  );
}

export function CodexSidebarSection({
  heading,
  collapsed,
  onToggle,
  onMove,
  status,
  headingButtonRef,
  headingButtonProps,
  actions,
  children,
}: {
  heading: string;
  collapsed: boolean;
  onToggle: () => void;
  onMove?: (direction: -1 | 1) => void;
  /** Shown only while collapsed. */
  status?: ReactNode;
  headingButtonRef?: Ref<HTMLButtonElement>;
  headingButtonProps?: ComponentPropsWithoutRef<"button">;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className="px-row-x"
      data-app-action-sidebar-section=""
      data-app-action-sidebar-section-collapsed={String(collapsed)}
      data-app-action-sidebar-section-heading={heading}
    >
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-2 pr-0.5 pl-2">
          <div className="min-w-0 flex-1 text-base font-medium text-tertiary">
            <div className="group/projects-section-header flex items-center justify-between gap-2">
              <div className="flex min-w-0 flex-1">
                <button
                  {...headingButtonProps}
                  ref={headingButtonRef}
                  type="button"
                  data-app-action-sidebar-section-toggle=""
                  className="group/section-toggle flex min-w-0 flex-1 cursor-interaction items-center gap-1 rounded-md py-0.5 pr-1 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
                  aria-expanded={!collapsed}
                  onClick={(event) => {
                    headingButtonProps?.onClick?.(event);
                    if (!event.defaultPrevented) onToggle();
                  }}
                  onKeyDown={(event) => {
                    headingButtonProps?.onKeyDown?.(event);
                    if (event.defaultPrevented) return;
                    if (!event.altKey || !onMove) return;
                    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                    event.preventDefault();
                    onMove(event.key === "ArrowUp" ? -1 : 1);
                  }}
                >
                  <span className="min-w-0 truncate">{heading}</span>
                  <ChevronDownIcon
                    className={cn(
                      CODEX_SIDEBAR_DISCLOSURE_CHEVRON_CLASS,
                      "group-hover/section-toggle:opacity-100 group-focus-visible/section-toggle:opacity-100",
                      collapsed && "-rotate-90",
                    )}
                  />
                </button>
              </div>
              {actions ? (
                <div className={CODEX_SIDEBAR_SECTION_ACTIONS_CLASS}>{actions}</div>
              ) : null}
              {/* A collapsed Section summarizes its chats at the header's end. */}
              {collapsed && status ? <div className="me-0.5 shrink-0">{status}</div> : null}
            </div>
          </div>
        </div>
        <AnimatePresence initial={false}>
          {!collapsed ? (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{
                height: "auto",
                opacity: 1,
                transitionEnd: {
                  overflow: "visible",
                },
              }}
              exit={{ height: 0, opacity: 0, overflow: "hidden" }}
              transition={CODEX_SIDEBAR_PROJECT_FOLDER_TRANSITION}
              className="overflow-hidden"
              data-app-action-sidebar-section-body-motion=""
            >
              <div className="flex flex-col gap-px pt-1">{children}</div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function revealInFileManagerLabel(): string {
  if (isMacPlatform()) return "Reveal in Finder";
  const platform = typeof navigator === "undefined" ? "" : navigator.platform.toUpperCase();
  return platform.includes("WIN") ? "Open in Explorer" : "Open in File Manager";
}

const EMPTY_SIDEBAR_THREAD_ITEMS: readonly CodexSidebarThreadItem[] = [];
const EMPTY_WORKSPACE_ROOT_OPTIONS: readonly string[] = [];
const EMPTY_WORKSPACE_ROOT_LABELS: Readonly<Record<string, string | undefined>> = {};

export interface CodexProjectActionsMenuHandle {
  openNativeMenu: (options?: NativeContextMenuOptions) => Promise<boolean>;
}

interface CodexProjectActionsMenuProps {
  project: Project;
  threadItems?: readonly CodexSidebarThreadItem[];
  onUpdateProject: (projectId: string, updates: ProjectUpdateInput) => Promise<Project | null>;
  onArchiveProject: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
  onSetProjectPinned?: (projectId: string, input: ProjectPinnedInput) => Promise<Project | null>;
  onCreateStableWorktree?: (project: Project, projectName: string) => Promise<void>;
  canCreateStableWorktree?: boolean;
  stableWorktreeWorkspaceRootOptions?: readonly string[];
  stableWorktreeWorkspaceRootLabels?: Readonly<Record<string, string | undefined>>;
  onArchiveThreadItem?: (item: CodexSidebarThreadItem) => Promise<boolean>;
  onMarkThreadItemRead?: (item: CodexSidebarThreadItem) => Promise<void>;
  onThreadsChanged?: () => Promise<unknown> | void;
  onOpenChange?: (open: boolean) => void;
  sectionActions?: ReactNode;
  sectionCatalog?: SidebarSectionsCatalog;
  currentSectionId?: string | null;
}

export const CodexProjectActionsMenu = forwardRef<
  CodexProjectActionsMenuHandle,
  CodexProjectActionsMenuProps
>(function CodexProjectActionsMenu(
  {
    project,
    threadItems = EMPTY_SIDEBAR_THREAD_ITEMS,
    onUpdateProject,
    onArchiveProject,
    onSetProjectPinned,
    onCreateStableWorktree,
    canCreateStableWorktree = false,
    stableWorktreeWorkspaceRootOptions = EMPTY_WORKSPACE_ROOT_OPTIONS,
    stableWorktreeWorkspaceRootLabels = EMPTY_WORKSPACE_ROOT_LABELS,
    onArchiveThreadItem,
    onMarkThreadItemRead,
    onThreadsChanged,
    onOpenChange,
    sectionActions,
    sectionCatalog,
    currentSectionId = null,
  }: CodexProjectActionsMenuProps,
  ref,
) {
  const appHandle = useScopeHandle(appScope);
  const queryClient = useQueryClient();
  const projectCatalog = useMemo(() => projectCatalogStoreFor(queryClient), [queryClient]);
  const [open, setOpen] = useState(false);
  const [archiveChatsOpen, setArchiveChatsOpen] = useState(false);
  const [createStableWorktreeOpen, setCreateStableWorktreeOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const openEditAfterMenuCloseRef = useRef(false);
  const nativeMenuOpenRef = useRef(false);
  const primaryWorkspaceRoot = normalizePrimaryWorkspaceRoot(project);
  const sourceRoots = normalizeProjectSources(project);
  const initialStableWorktreeProjectName = suggestStableWorktreeProjectName({
    base: project.name,
    workspaceRootOptions: stableWorktreeWorkspaceRootOptions,
    workspaceRootLabels: stableWorktreeWorkspaceRootLabels,
  });
  const archiveableItems = threadItems.filter(
    (item) => !item.archived && !item.disabled && item.kind !== "pending-worktree",
  );
  const unreadItems = threadItems.filter((item) => item.unread && !item.archived);
  const setMenuOpen = (nextOpen: boolean) => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const openProjectFolder = async () => {
    if (!primaryWorkspaceRoot) return;
    await openFileLink({ path: primaryWorkspaceRoot }, "fileManager");
  };

  const markAllThreadsRead = async () => {
    if (!onMarkThreadItemRead) return;
    await runProjectThreadBatches(unreadItems, async (item) => {
      try {
        await onMarkThreadItemRead(item);
      } catch {
        // Leave the item unread; the next refresh reflects the actual state.
      }
    });
    await onThreadsChanged?.();
  };

  const openProjectEditor = async () => {
    const editableProject = await projectCatalog.waitForProjectUpdates(project);
    let expectedBindingRevision = editableProject.bindingRevision;
    openModal(appHandle, ProjectEditDialog, {
      project: editableProject,
      onSubmit: async ({ appearance, name, sources }) => {
        const updated = await onUpdateProject(editableProject.id, {
          expectedBindingRevision,
          appearance,
          name: name.trim() || editableProject.name,
          sources,
        });
        if (!updated) throw new Error(`Project ${editableProject.id} not found`);
        expectedBindingRevision = updated.bindingRevision;
      },
      onArchiveProject,
    });
  };

  const unpinBeforeSectionMove = async () => {
    if (!project.pinned) return;
    if (onSetProjectPinned) {
      await onSetProjectPinned(project.id, { pinned: false });
      return;
    }
    await workspaceProjectCommands.setPinned(project.id, { pinned: false });
  };

  const moveProjectToSection = async (sectionId: string | null) => {
    await unpinBeforeSectionMove();
    await workspaceSidebarCommands.moveItem({
      item: { kind: "project", projectId: project.id },
      sectionId,
      placement: { kind: "end" },
    });
    await sectionCatalog?.refresh();
  };

  const sectionItems: NativeContextMenuItem[] | undefined = sectionCatalog
    ? [
        ...sectionCatalog.sections.map((section) => ({
          id: projectMoveToSectionActionId(section.sectionId),
          label: `${currentSectionId === section.sectionId ? "✓ " : ""}${section.name ?? "Untitled section"}`,
        })),
        ...(sectionCatalog.sections.length > 0 ? [{ type: "separator" as const }] : []),
        {
          id: PROJECT_CONTEXT_MENU_ACTION_IDS.newSection,
          label: "New section…",
        },
      ]
    : undefined;

  const handleNativeMenuAction = async (actionId: string) => {
    const targetSectionId = readProjectMoveToSectionActionId(actionId);
    if (targetSectionId) {
      await moveProjectToSection(currentSectionId === targetSectionId ? null : targetSectionId);
      return;
    }
    if (actionId === PROJECT_CONTEXT_MENU_ACTION_IDS.newSection) {
      openModal(appHandle, SidebarSectionNameDialog, {
        title: "New section",
        description: "Create a section and move this project into it.",
        allowEmpty: true,
        onSave: async (name) => {
          await unpinBeforeSectionMove();
          await workspaceSidebarCommands.create({
            name,
            initialItem: { kind: "project", projectId: project.id },
          });
          await sectionCatalog?.refresh();
        },
      });
      return;
    }
    if (actionId === PROJECT_CONTEXT_MENU_ACTION_IDS.togglePin) {
      await onSetProjectPinned?.(project.id, { pinned: !project.pinned });
      return;
    }
    if (actionId === PROJECT_CONTEXT_MENU_ACTION_IDS.edit) {
      await openProjectEditor();
      return;
    }
    if (actionId === PROJECT_CONTEXT_MENU_ACTION_IDS.reveal) {
      await openProjectFolder();
      return;
    }
    if (actionId === PROJECT_CONTEXT_MENU_ACTION_IDS.createStableWorktree) {
      setCreateStableWorktreeOpen(true);
      return;
    }
    if (actionId === PROJECT_CONTEXT_MENU_ACTION_IDS.markAllRead) {
      await markAllThreadsRead();
      return;
    }
    if (actionId === PROJECT_CONTEXT_MENU_ACTION_IDS.archiveChats) {
      setArchiveChatsOpen(true);
      return;
    }
    if (actionId === PROJECT_CONTEXT_MENU_ACTION_IDS.remove) setRemoveOpen(true);
  };

  const openNativeMenu = async (options?: NativeContextMenuOptions): Promise<boolean> => {
    if (!canShowNativeContextMenu()) return false;
    if (nativeMenuOpenRef.current) return true;
    const items = buildProjectContextMenuItems({
      pinned: project.pinned,
      showPinAction: Boolean(onSetProjectPinned),
      sectionItems,
      revealLabel:
        primaryWorkspaceRoot && sourceRoots.length === 1 ? revealInFileManagerLabel() : undefined,
      canCreateStableWorktree: Boolean(
        primaryWorkspaceRoot && onCreateStableWorktree && canCreateStableWorktree,
      ),
      canMarkAllRead: Boolean(onMarkThreadItemRead && unreadItems.length > 0),
      canArchiveChats: Boolean(onArchiveThreadItem && archiveableItems.length > 0),
    });

    nativeMenuOpenRef.current = true;
    setMenuOpen(true);
    try {
      const actionId = await showNativeContextMenu(items, options);
      if (actionId) await handleNativeMenuAction(actionId);
      return true;
    } catch (error) {
      toast.danger("Native context menu is unavailable", {
        description: error instanceof Error ? error.message : undefined,
      });
      return false;
    } finally {
      nativeMenuOpenRef.current = false;
      setMenuOpen(false);
    }
  };

  useImperativeHandle(ref, () => ({ openNativeMenu }));

  const triggerButton = (
    <button
      type="button"
      className={CODEX_SIDEBAR_GROUP_ACTION_BUTTON_CLASS}
      aria-label={`Project actions for ${project.name}`}
      aria-expanded={open}
      data-app-action-sidebar-project-actions-menu=""
      onClick={
        canShowNativeContextMenu()
          ? (event) => {
              event.preventDefault();
              void openNativeMenu();
            }
          : undefined
      }
    >
      <ProjectActionsIcon />
    </button>
  );

  return (
    <div
      className={
        open
          ? "opacity-100"
          : "opacity-0 group-hover/folder-row:opacity-100 group-focus-within/folder-row:opacity-100"
      }
      onPointerDown={stopCodexSidebarRowActionPropagation}
      onKeyDown={stopCodexSidebarRowActionKeyPropagation}
      onClick={stopCodexSidebarRowActionPropagation}
    >
      {canShowNativeContextMenu() ? (
        triggerButton
      ) : (
        <NodexDropdownMenu
          open={open}
          onOpenChange={setMenuOpen}
          finalFocus={() => {
            if (!openEditAfterMenuCloseRef.current) return true;
            openEditAfterMenuCloseRef.current = false;
            void openProjectEditor();
            return false;
          }}
          side="bottom"
          align="start"
          contentWidth="xs"
          triggerButton={triggerButton}
        >
          {onSetProjectPinned ? (
            <NodexDropdownItem
              leftSlot={
                project.pinned ? (
                  <PinOffIcon className="icon-xs" />
                ) : (
                  <SessionPinIcon className="icon-xs" />
                )
              }
              onSelect={() => {
                void onSetProjectPinned(project.id, { pinned: !project.pinned });
              }}
            >
              {project.pinned ? "Unpin project" : "Pin project"}
            </NodexDropdownItem>
          ) : null}
          {sectionActions}
          {primaryWorkspaceRoot && sourceRoots.length === 1 ? (
            <NodexDropdownItem
              leftSlot={<ProjectFolderOpenIcon className="icon-xs" />}
              onSelect={() => {
                void openProjectFolder();
              }}
            >
              {revealInFileManagerLabel()}
            </NodexDropdownItem>
          ) : null}
          {primaryWorkspaceRoot && onCreateStableWorktree && canCreateStableWorktree ? (
            <NodexDropdownItem
              leftSlot={<WorktreeStatusIcon className="icon-xs" />}
              onSelect={() => {
                setMenuOpen(false);
                setCreateStableWorktreeOpen(true);
              }}
            >
              Create permanent worktree
            </NodexDropdownItem>
          ) : null}
          <NodexDropdownItem
            leftSlot={<SettingsGeneralIcon className="icon-xs" />}
            onSelect={() => {
              openEditAfterMenuCloseRef.current = true;
            }}
          >
            Edit project
          </NodexDropdownItem>
          {onMarkThreadItemRead && unreadItems.length > 0 ? (
            <NodexDropdownItem
              leftSlot={<CheckmarkIcon className="icon-xs" />}
              onSelect={() => {
                setMenuOpen(false);
                void markAllThreadsRead();
              }}
            >
              Mark all as read
            </NodexDropdownItem>
          ) : null}
          <NodexDropdownItem
            leftSlot={<ArchiveIcon className="icon-xs" />}
            disabled={!onArchiveThreadItem || archiveableItems.length === 0}
            onSelect={() => {
              setMenuOpen(false);
              setArchiveChatsOpen(true);
            }}
          >
            Archive chats
          </NodexDropdownItem>
          <NodexDropdownItem
            leftSlot={<CloseIcon className="icon-xs" />}
            onSelect={() => {
              setMenuOpen(false);
              setRemoveOpen(true);
            }}
          >
            Remove
          </NodexDropdownItem>
        </NodexDropdownMenu>
      )}
      {archiveChatsOpen && onArchiveThreadItem ? (
        <ProjectArchiveChatsDialog
          open={archiveChatsOpen}
          projectName={project.name}
          items={archiveableItems}
          onOpenChange={setArchiveChatsOpen}
          onArchiveItem={onArchiveThreadItem}
          onArchived={onThreadsChanged}
        />
      ) : null}
      {createStableWorktreeOpen ? (
        <StableWorktreeCreateDialog
          open
          initialProjectName={initialStableWorktreeProjectName}
          onOpenChange={setCreateStableWorktreeOpen}
          onCreate={async (projectName) => {
            if (!onCreateStableWorktree) return;
            await onCreateStableWorktree(project, projectName);
          }}
        />
      ) : null}
      {removeOpen ? (
        <ProjectRemoveDialog
          open
          project={project}
          onOpenChange={setRemoveOpen}
          onArchiveProject={onArchiveProject}
        />
      ) : null}
    </div>
  );
});

const NO_RUNTIME_SESSIONS: readonly ProjectRuntimeSessionFacts[] = [];

/** One dot or spinner for a collapsed Project: chats to read or answer outrank work in progress. */
function CollapsedProjectStatus({
  activity,
  runtimeSessions,
  activityStore,
}: {
  activity: ProjectActivitySummary | null | undefined;
  runtimeSessions: readonly ProjectRuntimeSessionFacts[];
  activityStore?: AgentRuntimeActivityStore;
}) {
  // Only Runtime Sessions need live activity; Core already summarizes native chats.
  return runtimeSessions.length > 0 ? (
    <RuntimeCollapsedProjectStatus
      activity={activity}
      runtimeSessions={runtimeSessions}
      activityStore={activityStore}
    />
  ) : (
    <CollapsedProjectStatusIndicator activity={activity} />
  );
}

function RuntimeCollapsedProjectStatus({
  activity,
  runtimeSessions,
  activityStore,
}: {
  activity: ProjectActivitySummary | null | undefined;
  runtimeSessions: readonly ProjectRuntimeSessionFacts[];
  activityStore?: AgentRuntimeActivityStore;
}) {
  return (
    <CollapsedProjectStatusIndicator
      activity={mergeRuntimeProjectActivity(
        activity,
        runtimeSessions,
        useAgentRuntimeActivities(activityStore),
      )}
    />
  );
}

function CollapsedProjectStatusIndicator({
  activity,
}: {
  activity: ProjectActivitySummary | null | undefined;
}) {
  const status = activity
    ? resolveSidebarGroupStatus({
        needsReading: activity.waitingCount + activity.unreadCount > 0,
        running: activity.activeCount > 0,
      })
    : null;
  if (!status) return null;
  return (
    <span className="pe-0.5" data-app-action-sidebar-project-status={status}>
      <SidebarStatusIndicator
        status={status}
        label={status === "unread" ? "Unread chats" : undefined}
      />
    </span>
  );
}

function CodexProjectHoverCardContent({
  project,
  activity: coreActivity,
  runtimeSessions,
  onUpdateProject,
  onArchiveProject,
  onSetProjectPinned,
  onRequestClose,
  activityStore,
}: {
  project: Project;
  activity: ProjectActivitySummary | null | undefined;
  /** Loaded Runtime-bound Sessions of this Project; their live status comes from activity. */
  runtimeSessions: readonly ProjectRuntimeSessionFacts[];
  onUpdateProject: (projectId: string, updates: ProjectUpdateInput) => Promise<Project | null>;
  onArchiveProject: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
  onSetProjectPinned?: (projectId: string, input: ProjectPinnedInput) => Promise<Project | null>;
  onRequestClose: () => void;
  activityStore?: AgentRuntimeActivityStore;
}) {
  // The hover card mounts only while open, so the aggregate subscription is short-lived.
  const activity = mergeRuntimeProjectActivity(
    coreActivity,
    runtimeSessions,
    useAgentRuntimeActivities(activityStore),
  );
  const appHandle = useScopeHandle(appScope);
  const primaryWorkspaceRoot = normalizePrimaryWorkspaceRoot(project);
  const repositoryIdentityQuery = useQuery({
    ...gitRepositoryIdentityQueryOptions(primaryWorkspaceRoot),
    enabled: primaryWorkspaceRoot.length > 0,
  });
  const pathContextQuery = useQuery(localPathPresentationContextQueryOptions());
  const [appearance, setAppearance] = useState(project.appearance);
  const appearanceMutation = useProjectAppearanceMutation(project);
  const [pinPending, setPinPending] = useState(false);

  useEffect(() => {
    if (appearanceMutation.pending) return;
    setAppearance(project.appearance);
  }, [appearanceMutation.pending, project.appearance]);

  const renameProject = async (name: string) => {
    const updated = await onUpdateProject(project.id, { name });
    if (updated) return;
    throw new Error("The project is no longer available");
  };

  const setProjectPinned = onSetProjectPinned
    ? async (pinned: boolean) => {
        if (pinPending) return;

        setPinPending(true);
        try {
          const updated = await onSetProjectPinned(project.id, { pinned });
          if (!updated) throw new Error("The project is no longer available");
        } catch (error) {
          toast.danger("Could not update project pin", {
            description: error instanceof Error ? error.message : undefined,
          });
        } finally {
          setPinPending(false);
        }
      }
    : undefined;

  const openProjectSource = (path: string) => {
    void openFileLink({ path }, "fileManager")
      .then((opened) => {
        if (opened) return;
        throw new Error("Opening local folders is unavailable in this runtime");
      })
      .catch((error) => {
        toast.danger(`Could not ${revealInFileManagerLabel().toLowerCase()}`, {
          description: error instanceof Error ? error.message : undefined,
        });
      });
  };

  const openProjectEditor = async () => {
    const settledProject = await appearanceMutation.waitForSettledProject();
    const editableProject = {
      ...settledProject,
      appearance: settledProject.appearance,
    };
    let expectedBindingRevision = editableProject.bindingRevision;
    onRequestClose();
    queueMicrotask(() => {
      openModal(appHandle, ProjectEditDialog, {
        project: editableProject,
        onSubmit: async ({ appearance: nextAppearance, name, sources }) => {
          const updated = await onUpdateProject(project.id, {
            expectedBindingRevision,
            appearance: nextAppearance,
            name: name.trim() || editableProject.name,
            sources,
          });
          if (!updated) throw new Error(`Project ${project.id} not found`);
          expectedBindingRevision = updated.bindingRevision;
        },
        onArchiveProject,
      });
    });
  };

  return (
    <ProjectHoverCard
      project={project}
      activity={activity}
      repositoryIdentity={repositoryIdentityQuery.data ?? null}
      pathContext={pathContextQuery.data ?? null}
      appearance={appearance}
      appearancePending={false}
      pinPending={pinPending}
      onAppearanceChange={(nextAppearance) => {
        setAppearance(nextAppearance);
        appearanceMutation.changeAppearance(nextAppearance);
      }}
      onRename={renameProject}
      onSetPinned={setProjectPinned}
      onOpenSource={openProjectSource}
      onEdit={openProjectEditor}
    />
  );
}

/**
 * Complete sortable handoff for the shared Project row.
 *
 * Root Project lanes resolve their order through the controller. Mixed lanes such as custom
 * Sections must additionally provide the semantic container, placement identity, canonical mixed
 * order, exact next-item boundary, and placement-based sortable ID. Supplying only a controller or
 * sortable ID can leave a row visibly draggable while resolving its indicator or commit against the
 * wrong list. Keep every Project location on `CodexProjectRow` so whole-row Chat drops and narrow
 * edge insertion targets remain one contract.
 */
export interface CodexProjectRowDndCapability {
  readonly containerId?: string;
  readonly controller: SidebarGroupDndController;
  readonly itemId?: string;
  readonly itemIds?: string[];
  readonly nextItemId?: string | null;
  readonly sortableId?: string;
}

export function CodexProjectRow({
  project,
  activity,
  runtimeSessions = NO_RUNTIME_SESSIONS,
  active,
  expanded,
  animateChildren = true,
  dnd,
  threadItems,
  onActivate,
  onSelectProject,
  onStartNewChat,
  onUpdateProject,
  onArchiveProject,
  onSetProjectPinned,
  onCreateStableWorktree,
  stableWorktreeWorkspaceRootOptions,
  stableWorktreeWorkspaceRootLabels,
  onArchiveThreadItem,
  onMarkThreadItemRead,
  onThreadsChanged,
  hoverCardOpen,
  onHoverCardOpenChange,
  sectionActions,
  sectionCatalog,
  currentSectionId = null,
  inboxCount = 0,
  activityStore,
  children,
}: {
  project: Project;
  activity?: ProjectActivitySummary | null;
  runtimeSessions?: readonly ProjectRuntimeSessionFacts[];
  active: boolean;
  expanded: boolean;
  animateChildren?: boolean;
  dnd?: CodexProjectRowDndCapability;
  threadItems?: readonly CodexSidebarThreadItem[];
  onActivate: () => void;
  onSelectProject?: () => void;
  onStartNewChat?: () => void;
  onUpdateProject: (projectId: string, updates: ProjectUpdateInput) => Promise<Project | null>;
  onArchiveProject: (projectId: string) => Promise<ProjectLifecycleMutationResult>;
  onSetProjectPinned?: (projectId: string, input: ProjectPinnedInput) => Promise<Project | null>;
  onCreateStableWorktree?: (project: Project, projectName: string) => Promise<void>;
  stableWorktreeWorkspaceRootOptions?: readonly string[];
  stableWorktreeWorkspaceRootLabels?: Readonly<Record<string, string | undefined>>;
  onArchiveThreadItem?: (item: CodexSidebarThreadItem) => Promise<boolean>;
  onMarkThreadItemRead?: (item: CodexSidebarThreadItem) => Promise<void>;
  onThreadsChanged?: () => Promise<unknown> | void;
  hoverCardOpen?: boolean;
  onHoverCardOpenChange?: (open: boolean) => void;
  sectionActions?: ReactNode;
  sectionCatalog?: SidebarSectionsCatalog;
  currentSectionId?: string | null;
  /** Messages waiting in this Project's own Inbox, which is its Home. */
  inboxCount?: number;
  /** Live Runtime activity for the hover card; the application store by default. */
  activityStore?: AgentRuntimeActivityStore;
  children?: ReactNode;
}) {
  const sortableEnabled = dnd !== undefined;
  const primaryWorkspaceRoot = normalizePrimaryWorkspaceRoot(project);
  const queryClient = useQueryClient();
  const [canCreateStableWorktree, setCanCreateStableWorktree] = useState(false);
  const [uncontrolledHoverCardOpen, setUncontrolledHoverCardOpen] = useState(false);
  const [projectActionsMenuOpen, setProjectActionsMenuOpen] = useState(false);
  const projectActionsMenuRef = useRef<CodexProjectActionsMenuHandle>(null);
  const {
    gutter: gutterThreadDropTarget,
    icon: iconThreadDropTarget,
    row: rowThreadDropTarget,
    whole: wholeThreadDropTarget,
  } = useSidebarThreadProjectDropTargets({
    projectId: project.id,
    targetProjectKind: "local",
  });
  const sortableId = dnd?.sortableId ?? getSidebarGroupDndId(project.id);
  const { activeProjectId, projectDragActive } = useSidebarProjectDndState();
  const dragOverlay = useMemo(
    () => (
      <div className="flex h-[var(--height-token-row)] max-w-80 items-center gap-2 px-2 text-base text-token-foreground">
        <ProjectMarker appearance={project.appearance} fallbackIcon={<ProjectFolderIcon />} />
        <span className="min-w-0 truncate">{project.name}</span>
      </div>
    ),
    [project.appearance, project.name],
  );
  const sortableData = useMemo<SidebarGroupDndPayload>(
    () => ({
      kind: "sidebar-group",
      containerId: dnd?.containerId,
      controller: dnd?.controller ?? NOOP_SIDEBAR_GROUP_DND_CONTROLLER,
      dragOverlay,
      itemId: dnd?.itemId,
      itemIds: dnd?.itemIds,
      nextItemId: dnd?.nextItemId,
      projectId: project.id,
    }),
    [
      dnd?.containerId,
      dnd?.controller,
      dnd?.itemId,
      dnd?.itemIds,
      dnd?.nextItemId,
      dragOverlay,
      project.id,
    ],
  );
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: sortableId,
    disabled: !sortableEnabled,
    data: sortableData,
  });
  const projectRowRef = useCombinedRefs(setNodeRef, wholeThreadDropTarget.setNodeRef);
  const activeProjectDrag = isDragging || activeProjectId === project.id;
  const projectDropActive = wholeThreadDropTarget.isProjectDropTargetOver;
  const resolvedHoverCardOpen = hoverCardOpen ?? uncontrolledHoverCardOpen;
  const hoverCardDisabled =
    activeProjectDrag ||
    projectDragActive ||
    projectActionsMenuOpen ||
    rowThreadDropTarget.isExternalThreadDropTarget ||
    wholeThreadDropTarget.isExternalThreadDropTarget;
  const sortableStyle =
    sortableEnabled && !projectDragActive && transform
      ? getCodexSidebarSortableStyle(transform, transition)
      : undefined;
  const projectChildren = children ? (
    <CodexProjectChildrenDisclosure
      animate={animateChildren}
      expanded={expanded}
      motionKey={`${project.id}-tasks`}
    >
      {children}
    </CodexProjectChildrenDisclosure>
  ) : null;
  const setProjectHoverCardOpen = (nextOpen: boolean) => {
    if (hoverCardOpen === undefined) {
      setUncontrolledHoverCardOpen(nextOpen);
    }
    onHoverCardOpenChange?.(nextOpen);
  };
  const prefetchProjectHoverCardMetadata = () => {
    void queryClient.prefetchQuery(localPathPresentationContextQueryOptions());
    if (!primaryWorkspaceRoot) return;
    void queryClient.prefetchQuery(gitRepositoryIdentityQueryOptions(primaryWorkspaceRoot));
  };

  useEffect(() => {
    if (!onCreateStableWorktree || !primaryWorkspaceRoot) {
      setCanCreateStableWorktree(false);
      return;
    }

    let disposed = false;
    setCanCreateStableWorktree(false);
    void getGitWorkerClient()
      .request({
        method: "branch-metadata",
        params: { cwd: primaryWorkspaceRoot },
      })
      .then((state) => {
        if (disposed) return;
        setCanCreateStableWorktree(
          Boolean(state.currentBranch || state.defaultBranch || state.branches.length > 0),
        );
      })
      .catch(() => {
        if (!disposed) setCanCreateStableWorktree(false);
      });

    return () => {
      disposed = true;
    };
  }, [onCreateStableWorktree, primaryWorkspaceRoot]);

  return (
    <div
      ref={projectRowRef}
      data-sidebar-drop-target={projectDropActive ? "true" : undefined}
      className={cn(
        "group/cwd relative flex flex-col",
        activeProjectDrag && "opacity-20",
        projectDropActive &&
          "cursor-grabbing rounded-[10px] bg-[color-mix(in_oklab,var(--color-text-info)_10%,transparent)] ring-2 ring-inset ring-text-info",
      )}
      style={sortableStyle}
      inert={activeProjectDrag ? true : undefined}
      onPointerDownCapture={
        sortableEnabled
          ? (event) => {
              if (!isEventWithinCurrentTarget(event)) return;
              clearCodexSidebarTextSelection();
            }
          : undefined
      }
      role="listitem"
      aria-label={project.name}
    >
      <NodexHoverCard
        ariaLabel={`Project details for ${project.name}`}
        disabled={hoverCardDisabled}
        open={resolvedHoverCardOpen}
        onOpenChange={setProjectHoverCardOpen}
        hoverCardContent={
          <CodexProjectHoverCardContent
            activityStore={activityStore}
            project={project}
            activity={activity}
            runtimeSessions={runtimeSessions}
            onUpdateProject={onUpdateProject}
            onArchiveProject={onArchiveProject}
            onSetProjectPinned={onSetProjectPinned}
            onRequestClose={() => setProjectHoverCardOpen(false)}
          />
        }
      >
        <CodexSidebarTreeRow
          ref={rowThreadDropTarget.setNodeRef}
          {...(sortableEnabled ? attributes : {})}
          data-app-action-sidebar-project-collapsed={String(!expanded)}
          data-app-action-sidebar-project-id={project.id}
          data-app-action-sidebar-project-label={project.name}
          data-app-action-sidebar-project-row=""
          active={active}
          className={cn(projectDragActive && "pointer-events-none")}
          onPointerEnter={prefetchProjectHoverCardMetadata}
          onFocusCapture={prefetchProjectHoverCardMetadata}
          onContextMenu={(event) => {
            if (!canShowNativeContextMenu()) return;
            event.preventDefault();
            event.stopPropagation();
            setProjectHoverCardOpen(false);
            void projectActionsMenuRef.current?.openNativeMenu();
          }}
        >
          <CodexSidebarRowLayout
            leadingRef={iconThreadDropTarget.setNodeRef}
            leadingSlotProps={{
              className: "group/project-leading-slot",
            }}
            leadingSlotData={{
              "data-app-action-sidebar-project-leading-slot": "",
            }}
            leadingSlot={
              <>
                <ProjectMarker
                  appearance={project.appearance}
                  className="group-hover/folder-row:invisible group-has-[:focus-visible]/project-leading-slot:invisible"
                  data-app-action-sidebar-project-marker=""
                  fallbackIcon={expanded ? <ProjectFolderOpenIcon /> : <ProjectFolderIcon />}
                />
                <button
                  type="button"
                  aria-expanded={expanded}
                  aria-label={expanded ? "Collapse project" : "Expand project"}
                  className="pointer-events-none absolute inset-0 flex h-6 w-6 cursor-interaction items-center justify-center rounded-md text-token-foreground opacity-0 group-hover/folder-row:pointer-events-auto group-hover/folder-row:opacity-100 hover:bg-token-list-hover-background focus-visible:pointer-events-auto focus-visible:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
                  data-app-action-sidebar-project-toggle-chevron=""
                  onPointerDown={stopCodexSidebarRowActionPropagation}
                  onMouseDown={stopCodexSidebarRowActionPropagation}
                  onKeyDown={stopCodexSidebarRowActionPropagation}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onActivate();
                  }}
                >
                  <ChevronDownIcon
                    className={cn(
                      "icon-2xs shrink-0 transition-transform",
                      !expanded && "-rotate-90",
                    )}
                  />
                </button>
              </>
            }
            actions={
              <div className="grid items-center">
                {inboxCount > 0 || !expanded ? (
                  <span
                    className={cn(
                      "pointer-events-none col-start-1 row-start-1 flex items-center gap-1.5 justify-self-end group-hover/folder-row:invisible group-focus-within/folder-row:invisible",
                      projectActionsMenuOpen && "invisible",
                    )}
                  >
                    {inboxCount > 0 ? (
                      <span
                        aria-label={`${inboxCount} in ${project.name}'s Inbox`}
                        className="text-xs text-token-description-foreground tabular-nums last:pr-1.5"
                      >
                        {inboxCount}
                      </span>
                    ) : null}
                    {/* Only a collapsed Project summarizes its chats; an open one shows them. */}
                    {!expanded ? (
                      <CollapsedProjectStatus
                        activity={activity}
                        runtimeSessions={runtimeSessions}
                        activityStore={activityStore}
                      />
                    ) : null}
                  </span>
                ) : null}
                <div className="col-start-1 row-start-1 flex gap-1">
                  <CodexProjectActionsMenu
                    ref={projectActionsMenuRef}
                    project={project}
                    threadItems={threadItems}
                    onUpdateProject={onUpdateProject}
                    onArchiveProject={onArchiveProject}
                    onSetProjectPinned={onSetProjectPinned}
                    onCreateStableWorktree={onCreateStableWorktree}
                    canCreateStableWorktree={canCreateStableWorktree}
                    stableWorktreeWorkspaceRootOptions={stableWorktreeWorkspaceRootOptions}
                    stableWorktreeWorkspaceRootLabels={stableWorktreeWorkspaceRootLabels}
                    onArchiveThreadItem={onArchiveThreadItem}
                    onMarkThreadItemRead={onMarkThreadItemRead}
                    onThreadsChanged={onThreadsChanged}
                    sectionActions={sectionActions}
                    sectionCatalog={sectionCatalog}
                    currentSectionId={currentSectionId}
                    onOpenChange={(open) => {
                      setProjectActionsMenuOpen(open);
                      if (open) setProjectHoverCardOpen(false);
                    }}
                  />
                  {onStartNewChat ? (
                    <SidebarProjectNewChatButton
                      label={`Start new chat in ${project.name}`}
                      onClick={onStartNewChat}
                    />
                  ) : null}
                </div>
              </div>
            }
          >
            <button
              type="button"
              ref={setActivatorNodeRef}
              className={CODEX_SIDEBAR_ROW_LABEL_CLASS}
              aria-current={active ? "page" : undefined}
              aria-label={`Open ${project.name}`}
              data-app-action-sidebar-select-project=""
              {...(sortableEnabled ? listeners : {})}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                (onSelectProject ?? onActivate)();
              }}
            >
              <span
                className="min-w-0 flex-1 truncate pr-1"
                data-app-action-sidebar-project-label-text=""
              >
                {project.name}
              </span>
            </button>
          </CodexSidebarRowLayout>
        </CodexSidebarTreeRow>
      </NodexHoverCard>
      <div
        ref={gutterThreadDropTarget.setNodeRef}
        aria-hidden
        className="absolute bottom-0 left-0 top-[var(--height-token-nav-row)] z-10 w-2"
      />
      {projectChildren}
    </div>
  );
}

function CodexProjectChildrenDisclosure({
  animate,
  expanded,
  motionKey,
  children,
}: {
  animate: boolean;
  expanded: boolean;
  motionKey: string;
  children: ReactNode;
}) {
  if (!animate) {
    if (!expanded) return null;

    return (
      <div className="mt-0.5" data-app-action-sidebar-project-list-static="">
        {children}
      </div>
    );
  }

  return (
    <AnimatePresence initial={false}>
      {expanded ? (
        <motion.div
          key={motionKey}
          initial={{ height: 0, opacity: 0 }}
          animate={{
            height: "auto",
            opacity: 1,
            transitionEnd: {
              overflow: "visible",
            },
          }}
          exit={{ height: 0, opacity: 0, overflow: "hidden" }}
          transition={CODEX_SIDEBAR_PROJECT_FOLDER_TRANSITION}
          className="overflow-hidden"
          data-app-action-sidebar-project-list-motion=""
        >
          <div className="pt-0.5">{children}</div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

export function CodexProjectSessionList({
  project,
  showAll = false,
  children,
}: {
  project: Project;
  showAll?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-app-action-sidebar-project-list-id={project.id}
      data-app-action-sidebar-project-show-all={String(showAll)}
    >
      <div className="isolate flex flex-col [contain:layout]">
        <div className="flex flex-col" role="list" aria-label={`Automations in ${project.name}`}>
          {children}
        </div>
      </div>
    </div>
  );
}

function normalizeSidebarHoverCardText(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

function basenameFromWorkspacePath(path: string | null) {
  const normalized = normalizeSidebarHoverCardText(path);
  if (!normalized) return null;

  const segments = normalized.split(/[\\/]+/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? normalized;
}

function resolveSidebarThreadHoverCardProjectLabel(
  item: CodexSidebarThreadItem,
  projectLabel?: string | null,
) {
  const explicitLabel = normalizeSidebarHoverCardText(projectLabel);
  if (explicitLabel) return explicitLabel;
  if (item.projectless) return CODEX_SIDEBAR_THREAD_HOVER_CARD_FALLBACK_PROJECT_LABEL;
  return (
    basenameFromWorkspacePath(item.cwd) ?? CODEX_SIDEBAR_THREAD_HOVER_CARD_FALLBACK_PROJECT_LABEL
  );
}

function RelativeThreadAge({ recencyAt }: { recencyAt: number }) {
  const [now, setNow] = useState(Date.now);

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setNow(Date.now()),
      getNextElapsedTimeUpdateDelay(recencyAt, Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [now, recencyAt]);

  return (
    <time dateTime={new Date(recencyAt).toJSON() ?? undefined}>
      {formatElapsedSince(recencyAt, now)}
    </time>
  );
}

function CodexSidebarThreadHoverCardMetadataRow({
  icon,
  label,
}: {
  icon: ReactNode;
  label: string | null;
}) {
  if (!label) return null;

  return (
    <div
      className="flex h-5 min-w-0 items-center gap-1.5 text-sm leading-5"
      data-app-action-sidebar-thread-hover-card-metadata=""
    >
      <span className="flex h-5 w-4 shrink-0 items-center justify-center text-token-description-foreground">
        {icon}
      </span>
      <span className="block min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap leading-5 text-token-foreground">
        {label}
      </span>
    </div>
  );
}

function CodexSidebarThreadHoverCardLinkedPage({
  page,
  onOpen,
}: {
  page: SessionLinkedPage;
  onOpen?: (page: SessionLinkedPage) => void;
}) {
  const content = (
    <>
      <span className="flex h-5 w-4 shrink-0 items-center justify-center text-token-description-foreground">
        {page.status ? (
          <StatusIcon statusId={page.status.optionId} label={page.status.label} />
        ) : (
          <PageIcon className="icon-xs" />
        )}
      </span>
      {page.pageKey ? (
        <span className="shrink-0 text-token-description-foreground">{page.pageKey}</span>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-token-foreground">
        {page.title || "Untitled"}
      </span>
      {page.status ? (
        <span className="shrink-0 text-token-description-foreground">{page.status.label}</span>
      ) : null}
    </>
  );
  const className = "-mx-1 flex h-5 min-w-0 items-center gap-1.5 rounded-md px-1 text-sm leading-5";
  if (!onOpen) {
    return (
      <div
        className={className}
        data-app-action-sidebar-thread-hover-card-linked-page={page.pageId}
      >
        {content}
      </div>
    );
  }
  return (
    <button
      type="button"
      className={cn(
        className,
        "cursor-interaction text-left hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background focus-visible:outline-none",
      )}
      data-app-action-sidebar-thread-hover-card-linked-page={page.pageId}
      onPointerDown={stopCodexSidebarRowActionPropagation}
      onMouseDown={stopCodexSidebarRowActionPropagation}
      onKeyDown={stopCodexSidebarRowActionPropagation}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpen(page);
      }}
    >
      {content}
    </button>
  );
}

function CodexSidebarThreadHoverCard({
  item,
  linkedPage,
  projectLabel,
  branchName,
  onRenameFromTitleClick,
  onOpenLinkedPage,
}: {
  item: CodexSidebarThreadItem;
  linkedPage: SessionLinkedPage | null;
  projectLabel?: string | null;
  branchName?: string | null;
  onRenameFromTitleClick?: (item: CodexSidebarThreadItem, event: MouseEvent<HTMLElement>) => void;
  onOpenLinkedPage?: (page: SessionLinkedPage) => void;
}) {
  const resolvedProjectLabel = resolveSidebarThreadHoverCardProjectLabel(item, projectLabel);
  const resolvedBranchName = normalizeSidebarHoverCardText(branchName);
  const worktreeLabel = isCodexSidebarWorktreeLocation(item.runLocation)
    ? resolveCodexSidebarWorktreeLabel(item.runLocation.path)
    : null;
  const remoteHostLabel = isCodexSidebarRemoteLocation(item.runLocation)
    ? item.runLocation.hostDisplayName?.trim() || item.runLocation.hostId
    : null;
  const recencyAt =
    typeof item.recencyAt === "number" && Number.isFinite(item.recencyAt) && item.recencyAt > 0
      ? item.recencyAt
      : null;

  return (
    <div
      className="flex w-fit max-w-[min(20rem,calc(100vw-16px))] min-w-56 flex-col gap-1 px-row-x py-1.5 text-token-foreground"
      data-app-action-sidebar-thread-hover-card=""
    >
      <div className="flex w-full min-w-0 items-center gap-3 pb-0.5">
        {onRenameFromTitleClick ? (
          <button
            type="button"
            className="w-0 min-w-0 flex-1 cursor-interaction truncate rounded-md text-left text-base leading-6 font-medium text-token-foreground hover:bg-token-list-hover-background focus-visible:bg-token-list-hover-background focus-visible:outline-none"
            aria-label="Chat title"
            onPointerDown={stopCodexSidebarRowActionPropagation}
            onMouseDown={stopCodexSidebarRowActionPropagation}
            onKeyDown={stopCodexSidebarRowActionPropagation}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRenameFromTitleClick(item, event);
            }}
          >
            {item.title}
          </button>
        ) : (
          <div className="w-0 min-w-0 flex-1 truncate text-base leading-6 font-medium text-token-foreground">
            {item.title}
          </div>
        )}
        {recencyAt !== null ? (
          <div className="flex shrink-0 items-center gap-1 text-xs leading-5 text-token-description-foreground">
            <RelativeThreadAge recencyAt={recencyAt} />
            {item.unread ? (
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 rounded-full bg-chart-blue"
                data-app-action-sidebar-thread-hover-card-unread=""
              />
            ) : null}
          </div>
        ) : null}
      </div>
      <CodexSidebarThreadHoverCardMetadataRow
        icon={<ProjectFolderIcon className="icon-xs" />}
        label={resolvedProjectLabel}
      />
      <CodexSidebarThreadHoverCardMetadataRow
        icon={<RemoteStatusIcon className="icon-xs" aria-hidden="true" />}
        label={remoteHostLabel}
      />
      {resolvedBranchName ? (
        <div className="flex min-w-0 flex-col gap-1">
          <CodexSidebarThreadHoverCardMetadataRow
            icon={<BranchStatusIcon className="icon-xs" />}
            label={resolvedBranchName}
          />
        </div>
      ) : null}
      <CodexSidebarThreadHoverCardMetadataRow
        icon={<WorktreeStatusIcon className="icon-xs" />}
        label={worktreeLabel}
      />
      {linkedPage ? (
        <CodexSidebarThreadHoverCardLinkedPage page={linkedPage} onOpen={onOpenLinkedPage} />
      ) : null}
    </div>
  );
}

const CODEX_LOCAL_WORKTREE_TOOLTIP = "This conversation is running in a local git worktree.";

function CodexSidebarThreadRunLocationGlyph({
  item,
  hideForActions,
  forceHidden,
}: {
  item: CodexSidebarThreadItem;
  hideForActions: boolean;
  forceHidden: boolean;
}) {
  const location = item.runLocation;
  const pending = isCodexSidebarWorktreeLocation(location) && location.phase === "pending";
  const remoteIconClassName = "icon-2xs text-tertiary no-drag shrink-0";
  const worktreeIconClassName = cn(
    "icon-2xs no-drag shrink-0",
    pending ? "text-info animate-pulse motion-reduce:animate-none" : "semantic-text-secondary",
  );
  const wrapperClassName = cn(
    "ml-2 inline-flex shrink-0 items-center gap-1.5",
    hideForActions &&
      "group-hover:hidden group-focus-visible:hidden group-has-[:focus-visible]:hidden",
    forceHidden && "hidden",
  );

  if (location.kind === "local-checkout") return null;
  if (location.kind === "remote-checkout") {
    return (
      <span
        className={wrapperClassName}
        data-app-action-sidebar-thread-run-location="remote-checkout"
      >
        <NodexTooltip tooltipContent={location.hostDisplayName?.trim() || location.hostId}>
          <span className="inline-flex shrink-0">
            <RemoteStatusIcon className={remoteIconClassName} />
          </span>
        </NodexTooltip>
      </span>
    );
  }

  const worktreeIcon = (
    <NodexTooltip tooltipContent={CODEX_LOCAL_WORKTREE_TOOLTIP}>
      <span
        className="inline-flex shrink-0"
        data-app-action-sidebar-thread-worktree-icon=""
        data-phase={location.phase}
      >
        <WorktreeStatusIcon className={worktreeIconClassName} />
      </span>
    </NodexTooltip>
  );
  if (location.kind === "local-worktree") {
    return (
      <span
        className={wrapperClassName}
        data-app-action-sidebar-thread-run-location="local-worktree"
      >
        {worktreeIcon}
      </span>
    );
  }

  return (
    <span
      className={wrapperClassName}
      data-app-action-sidebar-thread-run-location="remote-worktree"
    >
      <NodexTooltip tooltipContent={location.hostDisplayName?.trim() || location.hostId}>
        <span className="inline-flex shrink-0">
          <RemoteStatusIcon className={remoteIconClassName} />
        </span>
      </NodexTooltip>
      {worktreeIcon}
    </span>
  );
}

type CodexSidebarThreadRowProps = {
  item: CodexSidebarThreadItem;
  /** Runtime-bound rows read live status and location from their execution owner. */
  runtime?: { readonly sessionId: string; readonly rootThreadId: string } | null;
  /** Live Session activity; tests inject an isolated store. */
  activityStore?: AgentRuntimeActivityStore;
  /** The Session's earliest-linked live Page; tests inject an isolated store. */
  linkedPageStore?: SessionLinkedPageStore;
  active: boolean;
  /** Grouped rows are nested under a Project; root lanes and Sections stay edge-aligned. */
  grouped?: boolean;
  contextMenuOpen?: boolean;
  archivePending?: boolean;
  hoverCardProjectLabel?: string | null;
  hoverCardBranchName?: string | null;
  hoverCardOpen?: boolean;
  onHoverCardOpenChange?: (open: boolean) => void;
  onSelect: () => void;
  onPreview?: () => void;
  onArchive?: (item: CodexSidebarThreadItem) => void | Promise<void>;
  onOpenContextMenu?: (item: CodexSidebarThreadItem, event: MouseEvent<HTMLElement>) => void;
  onRenameFromTitleDoubleClick?: (
    item: CodexSidebarThreadItem,
    event: MouseEvent<HTMLElement>,
  ) => void;
  onTogglePinned?: (item: CodexSidebarThreadItem) => void | Promise<void>;
  onOpenLinkedPage?: (page: SessionLinkedPage) => void;
};

export function CodexSidebarThreadRow(props: CodexSidebarThreadRowProps) {
  return props.runtime ? (
    <RuntimeCodexSidebarThreadRow {...props} runtime={props.runtime} />
  ) : (
    <CodexSidebarThreadRowView
      {...props}
      live={projectSidebarThreadRowLiveView(props.item, null)}
    />
  );
}

/** A Runtime row subscribes only to its own Session's activity and cached location. */
function RuntimeCodexSidebarThreadRow(
  props: CodexSidebarThreadRowProps & {
    runtime: NonNullable<CodexSidebarThreadRowProps["runtime"]>;
  },
) {
  const state = useRuntimeSessionLiveState(props.runtime, props.activityStore);
  return (
    <CodexSidebarThreadRowView
      {...props}
      live={projectSidebarThreadRowLiveView(props.item, {
        indicator: state.activity?.status ?? null,
        location: state.location,
      })}
    />
  );
}

function CodexSidebarThreadRowView({
  live,
  active,
  grouped = false,
  contextMenuOpen = false,
  archivePending = false,
  hoverCardProjectLabel,
  hoverCardBranchName,
  hoverCardOpen,
  onHoverCardOpenChange,
  onSelect,
  onPreview,
  onArchive,
  onOpenContextMenu,
  onRenameFromTitleDoubleClick,
  onTogglePinned,
  linkedPageStore,
  onOpenLinkedPage,
}: CodexSidebarThreadRowProps & { live: SidebarThreadRowLiveView }) {
  const item = live.item;
  const linkedPage = useSessionLinkedPage(item.sessionId, linkedPageStore);
  const canOpenContextMenu = !item.disabled && Boolean(onOpenContextMenu);
  const showArchiveAction = !item.disabled && Boolean(onArchive);
  const showPinSlot = !item.disabled && Boolean(onTogglePinned);
  const pinButtonLabel = item.pinned ? "Unpin chat" : "Pin chat";
  const title = item.title;
  const archiveDisabled = item.disabled || archivePending;
  const { running, needsAttention, status } = live;
  // A settled chat rests on its linked Page's status; anything live about the chat outranks it.
  const pageStatus = status ? null : (linkedPage?.status ?? null);
  // The trailing slot shows one status; the description keeps unread news even under a spinner.
  const statusDescription = needsAttention
    ? SESSION_LIVE_INDICATOR_LABELS.waiting
    : item.unread
      ? "Unread"
      : pageStatus
        ? `Page status: ${pageStatus.label}`
        : null;
  const statusDescriptionId = useId();
  const titleId = useId();
  const showRestingPinnedButton = showPinSlot && item.pinned;
  const showRailPinSlot = showPinSlot && !showRestingPinnedButton;
  const showActionRail = showRailPinSlot || showArchiveAction;
  const trailingStatusClassName = cn(
    "-me-1 flex shrink-0",
    showActionRail &&
      "group-focus-visible:hidden group-has-[:focus-visible]:hidden group-hover:hidden",
    contextMenuOpen && "hidden",
  );
  const [internalHoverCardOpen, setInternalHoverCardOpen] = useState(false);
  const [lazyBranchName, setLazyBranchName] = useState<string | null>(null);
  const resolvedHoverCardOpen = hoverCardOpen ?? internalHoverCardOpen;
  const normalizedHoverCardCwd = item.cwd?.trim() ?? "";
  const resolvedHoverCardBranchName = hoverCardBranchName ?? lazyBranchName;

  useEffect(() => {
    if (hoverCardBranchName !== undefined) {
      setLazyBranchName(null);
      return;
    }

    setLazyBranchName(null);
    if (!resolvedHoverCardOpen || !normalizedHoverCardCwd) return;

    let cancelled = false;
    void getGitWorkerClient()
      .request({
        method: "branch-metadata",
        params: { cwd: normalizedHoverCardCwd },
      })
      .then((state) => {
        if (cancelled) return;
        const branch =
          typeof (state as { currentBranch?: unknown }).currentBranch === "string"
            ? (state as { currentBranch: string }).currentBranch
            : null;
        setLazyBranchName(normalizeSidebarHoverCardText(branch));
      })
      .catch(() => {
        if (!cancelled) setLazyBranchName(null);
      });

    return () => {
      cancelled = true;
    };
  }, [hoverCardBranchName, normalizedHoverCardCwd, resolvedHoverCardOpen]);

  const handleHoverCardOpenChange = (nextOpen: boolean) => {
    if (hoverCardOpen === undefined) setInternalHoverCardOpen(nextOpen);
    onHoverCardOpenChange?.(nextOpen);
  };
  const handleTogglePinnedClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    void onTogglePinned?.(item);
  };

  const row = (
    <div
      data-app-action-sidebar-thread-active={String(active)}
      data-app-action-sidebar-thread-grouped={String(grouped)}
      data-app-action-sidebar-thread-host-id={item.hostId}
      data-app-action-sidebar-thread-id={item.threadId}
      data-app-action-sidebar-thread-kind={item.kind}
      data-app-action-sidebar-thread-pinned={String(item.pinned)}
      data-app-action-sidebar-thread-running={String(running)}
      data-app-action-sidebar-thread-unread={String(item.unread)}
      data-app-action-sidebar-thread-row=""
      data-app-action-sidebar-thread-title={title}
      className={cn(
        CODEX_SIDEBAR_THREAD_ROW_CLASS,
        active && "bg-token-list-hover-background",
        contextMenuOpen && "bg-token-list-hover-background",
      )}
      role="button"
      tabIndex={0}
      aria-current={active ? "page" : undefined}
      aria-disabled={item.disabled || undefined}
      aria-labelledby={titleId}
      aria-describedby={statusDescription ? statusDescriptionId : undefined}
      onPointerEnter={() => {
        if (!item.disabled) onPreview?.();
      }}
      onFocus={() => {
        if (!item.disabled) onPreview?.();
      }}
      onClick={onSelect}
      onContextMenu={(event) => {
        if (!canOpenContextMenu) return;
        event.preventDefault();
        onOpenContextMenu?.(item, event);
      }}
      onDoubleClick={(event) => {
        onRenameFromTitleDoubleClick?.(item, event);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
    >
      {statusDescription ? (
        <span id={statusDescriptionId} className="sr-only">
          {statusDescription}
        </span>
      ) : null}
      <div className="contents">
        <div className="flex h-full w-full items-center px-row-x text-sm leading-4">
          {/* Nested rows keep the Project's leading column so titles align under its name. */}
          {grouped ? <div className="w-4 shrink-0" aria-hidden="true" /> : null}
          <div
            className={cn("flex min-w-0 flex-1 items-center", grouped && "ml-1.5 pl-0.5")}
            data-app-action-sidebar-thread-main=""
          >
            <div
              className="flex min-w-0 flex-1 self-stretch items-center gap-2 text-base leading-5 text-token-foreground"
              data-thread-title-trigger="true"
            >
              <span
                id={titleId}
                className="min-w-0 flex-1 truncate select-none"
                data-thread-title="true"
                draggable={false}
              >
                {title}
              </span>
            </div>
            <CodexSidebarThreadRunLocationGlyph
              item={item}
              hideForActions={showActionRail}
              forceHidden={contextMenuOpen}
            />
            <div
              className={cn(
                "ms-[3px] flex items-center justify-end gap-1 group-focus-visible:min-w-12 group-hover:min-w-12 group-has-[:focus-visible]:min-w-12",
                (status || pageStatus) && "min-w-[26px]",
                contextMenuOpen && "min-w-12",
                // The resting pin stays interactive beside the overlaid archive action.
                showRestingPinnedButton &&
                  showArchiveAction &&
                  "group-hover:pr-7 group-focus-visible:pr-7 group-has-[:focus-visible]:pr-7",
                showRestingPinnedButton && showArchiveAction && contextMenuOpen && "pr-7",
              )}
            >
              {showRestingPinnedButton ? (
                <button
                  type="button"
                  aria-label={pinButtonLabel}
                  className={CODEX_SIDEBAR_THREAD_PIN_BUTTON_CLASS}
                  data-state={contextMenuOpen ? "open" : "closed"}
                  data-app-action-sidebar-thread-resting-pin=""
                  data-app-action-sidebar-thread-pin-session=""
                  data-app-action-sidebar-thread-pin-slot=""
                  onPointerDown={stopCodexSidebarRowActionPropagation}
                  onMouseDown={stopCodexSidebarRowActionPropagation}
                  onKeyDown={stopCodexSidebarRowActionPropagation}
                  onClick={handleTogglePinnedClick}
                >
                  <SessionPinFilledIcon />
                </button>
              ) : null}
              {status ? (
                <span
                  className={trailingStatusClassName}
                  data-app-action-sidebar-thread-status={status}
                >
                  <SidebarStatusIndicator status={status} />
                </span>
              ) : null}
              {pageStatus ? (
                <span
                  className={trailingStatusClassName}
                  data-app-action-sidebar-thread-page-status={pageStatus.optionId}
                >
                  <span
                    role="img"
                    aria-label={`Page status: ${pageStatus.label}`}
                    className="flex size-5 shrink-0 items-center justify-center"
                  >
                    <StatusIcon
                      statusId={pageStatus.optionId}
                      label={pageStatus.label}
                      className="size-3"
                    />
                  </span>
                </span>
              ) : null}
            </div>
          </div>
        </div>
        {showActionRail ? (
          <div
            className={cn(CODEX_SIDEBAR_THREAD_ACTION_RAIL_CLASS, contextMenuOpen && "opacity-100")}
            data-state={contextMenuOpen ? "open" : "closed"}
            data-app-action-sidebar-thread-action-rail=""
          >
            {showRailPinSlot ? (
              <div
                className="flex h-5 w-5 shrink-0 items-center justify-center"
                data-app-action-sidebar-thread-pin-slot=""
              >
                <button
                  type="button"
                  aria-label={pinButtonLabel}
                  className={cn(
                    CODEX_SIDEBAR_THREAD_PIN_BUTTON_CLASS,
                    !item.pinned &&
                      "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-has-[:focus-visible]:opacity-100 data-[state=open]:opacity-100",
                  )}
                  data-state={contextMenuOpen ? "open" : "closed"}
                  data-app-action-sidebar-thread-pin-session=""
                  onPointerDown={stopCodexSidebarRowActionPropagation}
                  onMouseDown={stopCodexSidebarRowActionPropagation}
                  onKeyDown={stopCodexSidebarRowActionPropagation}
                  onClick={handleTogglePinnedClick}
                >
                  {item.pinned ? <SessionPinFilledIcon /> : <SessionPinIcon />}
                </button>
              </div>
            ) : null}
            {showArchiveAction ? (
              <button
                type="button"
                aria-label="Archive chat"
                disabled={archiveDisabled}
                className={cn(
                  CODEX_SIDEBAR_GROUP_ACTION_BUTTON_CLASS,
                  CODEX_SIDEBAR_THREAD_ARCHIVE_BUTTON_CLASS,
                )}
                data-app-action-sidebar-thread-archive=""
                onPointerDown={stopCodexSidebarRowActionPropagation}
                onMouseDown={stopCodexSidebarRowActionPropagation}
                onKeyDown={stopCodexSidebarRowActionPropagation}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void onArchive?.(item);
                }}
              >
                <ArchiveIcon />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="after:block after:h-px after:content-[''] last:after:hidden" role="listitem">
      <NodexHoverCard
        ariaLabel={`Chat details for ${item.title}`}
        hoverCardContent={
          <CodexSidebarThreadHoverCard
            item={item}
            linkedPage={linkedPage}
            projectLabel={hoverCardProjectLabel}
            branchName={resolvedHoverCardBranchName}
            onRenameFromTitleClick={onRenameFromTitleDoubleClick}
            onOpenLinkedPage={
              onOpenLinkedPage
                ? (page) => {
                    handleHoverCardOpenChange(false);
                    onOpenLinkedPage(page);
                  }
                : undefined
            }
          />
        }
        disabled={item.disabled}
        open={hoverCardOpen}
        onOpenChange={handleHoverCardOpenChange}
      >
        {row}
      </NodexHoverCard>
    </div>
  );
}

export function CodexThreadRow({
  session,
  active,
  grouped = false,
  contextMenuOpen = false,
  hoverCardProjectLabel,
  hoverCardBranchName,
  hoverCardOpen,
  onHoverCardOpenChange,
  onSelect,
  onOpenContextMenu,
  onRenameFromTitleDoubleClick,
  onTogglePinned,
}: {
  session: ProjectSession;
  active: boolean;
  grouped?: boolean;
  contextMenuOpen?: boolean;
  hoverCardProjectLabel?: string | null;
  hoverCardBranchName?: string | null;
  hoverCardOpen?: boolean;
  onHoverCardOpenChange?: (open: boolean) => void;
  onSelect: () => void;
  onOpenContextMenu?: (session: ProjectSession, event: MouseEvent<HTMLElement>) => void;
  onRenameFromTitleDoubleClick?: (session: ProjectSession, event: MouseEvent<HTMLElement>) => void;
  onTogglePinned?: (session: ProjectSession) => void | Promise<void>;
}) {
  const threadId = session.thread?.threadId ?? session.id;
  if (session.thread?.parentThreadId) return null;
  const hostId = session.thread?.executionHostId ?? "local";
  const local = hostId === "local";
  const managedWorktreePath = session.thread?.managedWorktreePath ?? null;
  const item: CodexSidebarThreadItem = {
    key: `${local ? "local" : "remote"}:${threadId}`,
    kind: local ? "local" : "remote",
    backendBinding: session.thread?.backendBinding ?? { kind: "codex" },
    runLocation: managedWorktreePath
      ? local
        ? { kind: "local-worktree", path: managedWorktreePath, phase: "ready" }
        : { kind: "remote-worktree", hostId, path: managedWorktreePath, phase: "ready" }
      : local
        ? { kind: "local-checkout" }
        : { kind: "remote-checkout", hostId },
    hostId,
    threadId,
    parentThreadId: session.thread?.parentThreadId ?? null,
    sessionId: session.id,
    projectId: session.projectId,
    title: session.displayTitle,
    preview: session.thread?.threadPreview ?? "",
    cwd: session.thread?.cwd ?? null,
    updatedAt: session.thread?.updatedAt ?? Date.parse(session.updatedAt),
    recencyAt: session.thread?.recencyAt ?? null,
    createdAt: session.thread?.createdAt ?? Date.parse(session.createdAt),
    pinned: session.pinned,
    pinnedOrder: session.pinnedOrder,
    unread: session.unread,
    archived: session.archived || session.thread?.archived === true,
    statusType: (session.thread?.statusType ?? "notLoaded") as CodexSidebarThreadItem["statusType"],
    statusActiveFlags: (session.thread?.statusActiveFlags ??
      []) as CodexSidebarThreadItem["statusActiveFlags"],
    projectless: session.projectId === null,
    disabled: false,
  };

  return (
    <CodexSidebarThreadRow
      item={item}
      runtime={runtimeSessionTarget(session)}
      active={active}
      grouped={grouped}
      contextMenuOpen={contextMenuOpen}
      hoverCardProjectLabel={hoverCardProjectLabel}
      hoverCardBranchName={hoverCardBranchName}
      hoverCardOpen={hoverCardOpen}
      onHoverCardOpenChange={onHoverCardOpenChange}
      onSelect={onSelect}
      onOpenContextMenu={
        onOpenContextMenu ? (_item, event) => onOpenContextMenu(session, event) : undefined
      }
      onRenameFromTitleDoubleClick={
        onRenameFromTitleDoubleClick
          ? (_item, event) => onRenameFromTitleDoubleClick(session, event)
          : undefined
      }
      onTogglePinned={onTogglePinned ? () => onTogglePinned(session) : undefined}
    />
  );
}

type CodexSidebarActionButtonProps = Omit<ComponentPropsWithoutRef<"button">, "children"> & {
  label: string;
  children: ReactNode;
};

export const CodexSidebarActionButton = forwardRef<
  HTMLButtonElement,
  CodexSidebarActionButtonProps
>(function CodexSidebarActionButton(
  {
    label,
    title,
    children,
    onClick,
    onPointerDown,
    onMouseDown,
    onKeyDown,
    className,
    ...buttonProps
  },
  ref,
) {
  return (
    <NodexTooltip delayOpen tooltipContent={title ?? label} side="right">
      <button
        {...buttonProps}
        ref={ref}
        type="button"
        className={cn(CODEX_SIDEBAR_SECTION_ACTION_BUTTON_CLASS, className)}
        aria-label={label}
        onPointerDown={(event) => {
          stopCodexSidebarRowActionPropagation(event);
          onPointerDown?.(event);
        }}
        onMouseDown={(event) => {
          stopCodexSidebarRowActionPropagation(event);
          onMouseDown?.(event);
        }}
        onKeyDown={(event) => {
          stopCodexSidebarRowActionPropagation(event);
          onKeyDown?.(event);
        }}
        onClick={(event) => {
          event.stopPropagation();
          onClick?.(event);
        }}
      >
        {children}
      </button>
    </NodexTooltip>
  );
});

export function resolveCodexNewChatShortcutLabel() {
  return isMacPlatform() ? "⌘N" : "Ctrl+N";
}

export function resolveCodexInboxShortcutLabel() {
  return isMacPlatform() ? "⇧⌘D" : "Ctrl+Shift+D";
}

export function resolveCodexCommandPaletteShortcutLabel() {
  return isMacPlatform() ? "⌘K" : "Ctrl+K";
}

export function resolveCodexPageSearchShortcutLabel() {
  return isMacPlatform() ? "⌘P" : "Ctrl+P";
}
