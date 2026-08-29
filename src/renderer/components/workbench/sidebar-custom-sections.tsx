import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import {
  ArchiveIcon,
  ActivitySpinnerIcon,
  CloseIcon,
  NewChatIcon,
  PlusIcon,
  ProjectActionsIcon,
  ProjectFolderIcon,
  SettingsGeneralIcon,
  ThreadIcon,
} from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownRadioGroup,
  NodexDropdownRadioItem,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import {
  invoke,
  invokeCoreResult,
  subscribeProjectChanges,
  subscribeProjectSessionChanges,
} from "@/lib/api";
import { listAllSidebarSectionItems, listAllSidebarSections } from "@/lib/sidebar-sections-api";
import { cn } from "@/lib/utils";
import type { ProjectSession } from "@/lib/types";
import {
  sidebarSectionContainerId,
  type SidebarSectionItem,
  type SidebarSectionSummary,
} from "../../../shared/sidebar-sections";
import {
  CODEX_SIDEBAR_GROUP_ACTION_BUTTON_CLASS,
  CODEX_SIDEBAR_ROW_LABEL_CLASS,
  CodexSidebarActionButton,
  CodexSidebarPagerButton,
  CodexSidebarRowLayout,
  CodexSidebarSection,
  CodexSidebarTreeRow,
} from "./codex-sidebar";
import type { SidebarGroupDndController } from "./sidebar-project-group-dnd";
import {
  getSidebarSectionRootDndId,
  SidebarSectionRootSortableContext,
  useSidebarSectionRootReorderController,
  type SidebarSectionRootDndController,
  type SidebarSectionRootDndPayload,
} from "./sidebar-section-root-dnd";
import { SidebarDropIndicator } from "./sidebar-drop-indicator";
import { SidebarSectionNameDialog } from "./sidebar-section-name-dialog";
import {
  isSidebarSectionSessionDragDisabled,
  resolveSidebarSectionItemPlacement,
  sidebarSectionItemRef,
} from "./sidebar-section-item-dnd";
import {
  SidebarThreadSortableItem,
  useSidebarThreadDropContainer,
  useSidebarThreadReorderController,
  type SidebarThreadReorderController,
} from "./sidebar-thread-reorder";

export const SIDEBAR_SECTIONS_QUERY_KEY = ["sidebar-sections"] as const;

const sectionItemsQueryKey = (sectionId: string) => [
  ...SIDEBAR_SECTIONS_QUERY_KEY,
  sectionId,
  "items",
];

function SectionRootSortable({
  section,
  controller,
  children,
}: {
  readonly section: SidebarSectionSummary;
  readonly controller: SidebarSectionRootDndController;
  readonly children: (input: {
    readonly headingButtonRef: (node: HTMLButtonElement | null) => void;
    readonly headingButtonProps: ComponentPropsWithoutRef<"button">;
  }) => ReactNode;
}) {
  const dragOverlay = useMemo(
    () => (
      <div className="max-w-80 truncate px-3 py-1 text-base text-token-foreground">
        {section.name ?? "Untitled section"}
      </div>
    ),
    [section.name],
  );
  const payload = useMemo<SidebarSectionRootDndPayload>(
    () => ({
      kind: "sidebar-section-root",
      controller,
      dragOverlay,
      sectionId: section.sectionId,
    }),
    [controller, dragOverlay, section.sectionId],
  );
  const {
    attributes,
    isDragging,
    listeners,
    setActivatorNodeRef,
    setNodeRef,
    transform,
    transition,
  } = useSortable({
    id: getSidebarSectionRootDndId(section.sectionId),
    data: payload,
  });

  return (
    <div
      ref={setNodeRef}
      className={cn(isDragging && "opacity-20")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      {children({
        headingButtonRef: setActivatorNodeRef,
        headingButtonProps: { ...attributes, ...listeners },
      })}
    </div>
  );
}

function SectionSessionDraggable({
  controller,
  itemId,
  itemIds,
  nextItemId,
  sectionId,
  threadId,
  threadKey,
  children,
}: {
  readonly controller: SidebarThreadReorderController;
  readonly itemId?: string;
  readonly itemIds?: string[];
  readonly nextItemId?: string | null;
  readonly sectionId: string;
  readonly threadId: string | null;
  readonly threadKey: string;
  readonly children: ReactNode;
}) {
  return (
    <SidebarThreadSortableItem
      containerId={sidebarSectionContainerId(sectionId)}
      controller={controller}
      disabled={isSidebarSectionSessionDragDisabled({ placementId: itemId, threadId })}
      itemId={itemId}
      itemIds={itemIds}
      nextItemId={nextItemId}
      threadId={threadId}
      threadKey={threadKey}
      sortableId={itemId}
      sourceProjectKind="local"
      targetProjectKind="local"
    >
      {children}
    </SidebarThreadSortableItem>
  );
}

function SectionDropTarget({
  children,
  containerId,
  itemIds,
}: {
  readonly children: (dropIndicator: ReactNode) => ReactNode;
  readonly containerId: string;
  readonly itemIds: string[];
}) {
  const target = useSidebarThreadDropContainer({
    acceptProjectDrop: true,
    beforeItemId: itemIds[0],
    containerId,
    itemIds: itemIds.length > 0 ? itemIds : undefined,
    targetProjectKind: "local",
  });
  const active = target.isOver && (target.projectDragActive || target.threadDragActive);

  return <div ref={target.setNodeRef}>{children(active ? <SidebarDropIndicator /> : null)}</div>;
}

export function useSidebarSectionsCatalog() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const invalidateCatalog = () => {
      void queryClient.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
    };
    const unsubscribeProjects = subscribeProjectChanges(invalidateCatalog);
    const unsubscribeSessions = subscribeProjectSessionChanges(invalidateCatalog);
    return () => {
      unsubscribeProjects();
      unsubscribeSessions();
    };
  }, [queryClient]);
  const sectionsQuery = useQuery({
    queryKey: SIDEBAR_SECTIONS_QUERY_KEY,
    queryFn: listAllSidebarSections,
  });
  const sections = (sectionsQuery.data ?? []).filter(
    (section) => section.kind === "custom" && section.lifecycle === "active",
  );
  const itemQueries = useQueries({
    queries: sections.map((section) => ({
      queryKey: sectionItemsQueryKey(section.sectionId),
      queryFn: () => listAllSidebarSectionItems(section.sectionId),
    })),
  });
  const itemsBySectionId = new Map(
    sections.map((section, index) => [section.sectionId, itemQueries[index]?.data ?? []]),
  );
  const directSessionIds = new Set(
    [...itemsBySectionId.values()].flatMap((items) =>
      items.flatMap((item) => (item.kind === "session" ? [item.session.sessionId] : [])),
    ),
  );
  const directProjectIds = new Set(
    [...itemsBySectionId.values()].flatMap((items) =>
      items.flatMap((item) => (item.kind === "project" ? [item.project.projectId] : [])),
    ),
  );
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: SIDEBAR_SECTIONS_QUERY_KEY });
  };
  return {
    sections,
    sectionsQuery,
    itemQueries,
    itemsBySectionId,
    directSessionIds,
    directProjectIds,
    refresh,
  };
}

export type SidebarSectionsCatalog = ReturnType<typeof useSidebarSectionsCatalog>;

export interface SidebarSectionProjectRowRenderInput {
  readonly controller: SidebarGroupDndController;
  readonly item: Extract<SidebarSectionItem, { kind: "project" }>;
  readonly itemIds: string[];
  readonly nextItemId: string | null;
  readonly sectionId: string;
}

function SectionDirectItems({
  catalog,
  getThreadKey,
  items,
  loading,
  onThreadsChanged,
  renderProject,
  renderSession,
  section,
}: {
  readonly catalog: SidebarSectionsCatalog;
  readonly getThreadKey: (sessionId: string) => string;
  readonly items: readonly SidebarSectionItem[];
  readonly loading: boolean;
  readonly onThreadsChanged?: () => Promise<unknown> | void;
  readonly renderProject: (input: SidebarSectionProjectRowRenderInput) => ReactNode;
  readonly renderSession: (sessionId: string) => ReactNode;
  readonly section: SidebarSectionSummary;
}) {
  const [visibleItemCount, setVisibleItemCount] = useState(50);
  const visibleItems = items.slice(0, visibleItemCount);
  const allItemIds = items.map((item) => item.placementId);
  const visibleItemIds = visibleItems.map((item) => item.placementId);
  const itemById = new Map(items.map((item) => [item.placementId, item]));
  const reorder = useSidebarThreadReorderController({
    visibleThreadKeys: visibleItemIds,
    onVisibleThreadOrderChange: async ({ activeThreadKey, nextVisibleThreadKeys }) => {
      const activeItem = itemById.get(activeThreadKey);
      if (!activeItem) return;
      const activeIndex = nextVisibleThreadKeys.indexOf(activeThreadKey);
      if (activeIndex < 0) return;
      const firstHiddenItemId = items[visibleItems.length]?.placementId ?? null;
      const beforeItemId = nextVisibleThreadKeys[activeIndex + 1] ?? firstHiddenItemId;
      await invokeCoreResult("sidebar-sections:item:move", {
        item: sidebarSectionItemRef(activeItem),
        sectionId: section.sectionId,
        placement: resolveSidebarSectionItemPlacement(items, beforeItemId),
      });
      await catalog.refresh();
      await onThreadsChanged?.();
    },
  });
  const displayedItems = reorder.displayedVisibleThreadKeys.flatMap((itemId) => {
    const item = itemById.get(itemId);
    return item ? [item] : [];
  });

  return (
    <SortableContext
      items={reorder.displayedVisibleThreadKeys}
      strategy={verticalListSortingStrategy}
    >
      <div role="list" aria-label={`${section.name ?? "Section"} items`}>
        {displayedItems.length > 0 ? (
          displayedItems.map((item) => {
            const nextItemId = allItemIds[items.indexOf(item) + 1] ?? null;
            return (
              <Fragment key={item.placementId}>
                {reorder.dropIndicatorTarget?.beforeThreadKey === item.placementId ? (
                  <SidebarDropIndicator />
                ) : null}
                {item.kind === "project" ? (
                  renderProject({
                    controller: reorder.controller,
                    item,
                    itemIds: allItemIds,
                    nextItemId,
                    sectionId: section.sectionId,
                  })
                ) : (
                  <SectionSessionDraggable
                    controller={reorder.controller}
                    itemId={item.placementId}
                    itemIds={allItemIds}
                    nextItemId={nextItemId}
                    sectionId={section.sectionId}
                    threadId={item.session.threadId}
                    threadKey={getThreadKey(item.session.sessionId)}
                  >
                    {renderSession(item.session.sessionId) ?? (
                      <CodexSidebarTreeRow
                        aria-label={item.session.displayTitle}
                        data-app-action-sidebar-thread-id={item.session.threadId ?? ""}
                        data-app-action-sidebar-thread-row=""
                        data-app-action-sidebar-thread-title={item.session.displayTitle}
                        role="listitem"
                      >
                        <CodexSidebarRowLayout leadingSlot={<ThreadIcon className="icon-xs" />}>
                          <span className={cn(CODEX_SIDEBAR_ROW_LABEL_CLASS, "truncate")}>
                            {item.session.displayTitle}
                          </span>
                        </CodexSidebarRowLayout>
                      </CodexSidebarTreeRow>
                    )}
                  </SectionSessionDraggable>
                )}
              </Fragment>
            );
          })
        ) : (
          <div className="px-row-x py-row-y text-sm text-token-description-foreground">
            {loading ? "Loading section…" : "Drop projects or chats here"}
          </div>
        )}
        {reorder.dropIndicatorTarget?.beforeThreadKey === null ? <SidebarDropIndicator /> : null}
        {items.length > 50 ? (
          <div className="flex items-center gap-2 px-row-x py-1" role="listitem">
            {visibleItemCount < items.length ? (
              <CodexSidebarPagerButton
                onClick={() => setVisibleItemCount((current) => current + 50)}
              >
                Show more
              </CodexSidebarPagerButton>
            ) : null}
            {visibleItemCount > 50 ? (
              <CodexSidebarPagerButton onClick={() => setVisibleItemCount(50)}>
                Show less
              </CodexSidebarPagerButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </SortableContext>
  );
}

function SectionActions({
  section,
  onRename,
  onArchiveAll,
  onDelete,
  archiveDisabled,
}: {
  readonly section: SidebarSectionSummary;
  readonly onRename: () => void;
  readonly onArchiveAll: () => void;
  readonly onDelete: () => void;
  readonly archiveDisabled: boolean;
}) {
  return (
    <NodexDropdownMenu
      side="bottom"
      align="end"
      contentWidth="xs"
      triggerButton={
        <button
          type="button"
          className={CODEX_SIDEBAR_GROUP_ACTION_BUTTON_CLASS}
          aria-label={`Section actions for ${section.name ?? "Section"}`}
        >
          <ProjectActionsIcon />
        </button>
      }
    >
      <NodexDropdownItem leftSlot={<SettingsGeneralIcon className="icon-xs" />} onSelect={onRename}>
        Edit section
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<ArchiveIcon className="icon-xs" />}
        disabled={archiveDisabled || section.effectiveSessionCount === 0}
        onSelect={onArchiveAll}
      >
        Archive all chats
      </NodexDropdownItem>
      <NodexDropdownItem
        className="text-token-error-foreground"
        leftSlot={<CloseIcon className="icon-xs" />}
        onSelect={onDelete}
      >
        Delete section
      </NodexDropdownItem>
    </NodexDropdownMenu>
  );
}

export function SidebarCustomSections({
  sessionsByProject,
  renderProject,
  renderSession,
  onThreadsChanged,
  catalog,
  getThreadKey,
  activeSessionId,
  collapsedSections,
  onSetCollapsed,
  onSelectSession,
}: {
  readonly sessionsByProject: Readonly<Record<string, readonly ProjectSession[]>>;
  readonly renderProject: (input: SidebarSectionProjectRowRenderInput) => ReactNode;
  readonly renderSession: (sessionId: string) => ReactNode;
  readonly onThreadsChanged?: () => Promise<unknown> | void;
  readonly catalog: SidebarSectionsCatalog;
  readonly getThreadKey: (sessionId: string) => string;
  readonly activeSessionId: string | null;
  readonly collapsedSections: Readonly<Record<string, boolean>>;
  readonly onSetCollapsed: (sectionId: `custom:${string}`, collapsed: boolean) => void;
  readonly onSelectSession: (session: ProjectSession) => void;
}) {
  const [archiveSection, setArchiveSection] = useState<SidebarSectionSummary | null>(null);
  const [renameSection, setRenameSection] = useState<SidebarSectionSummary | null>(null);
  const { itemQueries, refresh, sections, sectionsQuery } = catalog;
  const commitSectionOrder = useCallback(
    async (sectionIds: readonly string[]) => {
      await invokeCoreResult("sidebar-sections:reorder", [...sectionIds]);
      await refresh();
    },
    [refresh],
  );
  const rootReorder = useSidebarSectionRootReorderController({
    sectionIds: sections.map((section) => section.sectionId),
    reorderSections: commitSectionOrder,
  });
  const sectionById = new Map(sections.map((section) => [section.sectionId, section]));
  const orderedSections = rootReorder.sectionIds.flatMap((sectionId) => {
    const section = sectionById.get(sectionId);
    return section ? [section] : [];
  });
  const reorder = async (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= orderedSections.length) return;
    const ordered = orderedSections.map((section) => section.sectionId);
    [ordered[index], ordered[target]] = [ordered[target] as string, ordered[index] as string];
    await commitSectionOrder(ordered);
  };

  return (
    <>
      <SidebarSectionRootSortableContext sectionIds={rootReorder.sectionIds}>
        {orderedSections.map((section, index) => {
          const items = catalog.itemsBySectionId.get(section.sectionId) ?? [];
          const itemQuery =
            itemQueries[
              sections.findIndex((candidate) => candidate.sectionId === section.sectionId)
            ];
          const disclosureId = `custom:${section.sectionId}` as const;
          const collapsed = collapsedSections[disclosureId] ?? false;
          return (
            <Fragment key={section.sectionId}>
              {rootReorder.dropIndicatorIndex === index ? <SidebarDropIndicator /> : null}
              <SectionRootSortable section={section} controller={rootReorder.controller}>
                {({ headingButtonProps, headingButtonRef }) => (
                  <SectionDropTarget
                    containerId={sidebarSectionContainerId(section.sectionId)}
                    itemIds={items.map((item) => item.placementId)}
                  >
                    {(dropIndicator) => (
                      <CodexSidebarSection
                        heading={section.name ?? "Untitled section"}
                        collapsed={collapsed}
                        onToggle={() => onSetCollapsed(disclosureId, !collapsed)}
                        onMove={(direction) => void reorder(index, direction)}
                        headingButtonRef={headingButtonRef}
                        headingButtonProps={headingButtonProps}
                        dropIndicator={dropIndicator}
                        status={
                          section.hasRunning ? (
                            <ActivitySpinnerIcon
                              className="icon-2xs shrink-0 text-token-foreground/70"
                              animationDurationMs={2_000}
                            />
                          ) : section.hasUnread ? (
                            <span
                              className="size-1.5 shrink-0 rounded-full bg-token-foreground/55"
                              aria-label="Has unread chats"
                              data-sidebar-section-unread="true"
                            />
                          ) : null
                        }
                        actions={
                          <>
                            <CodexSidebarActionButton
                              label={`New chat in ${section.name ?? "section"}`}
                              onClick={() => {
                                void invokeCoreResult("sidebar-sections:sessions:create", {
                                  sectionId: section.sectionId,
                                })
                                  .then(async (session) => {
                                    await refresh();
                                    await onThreadsChanged?.();
                                    onSelectSession(session);
                                  })
                                  .catch(() => toast.danger("Couldn’t create chat in section"));
                              }}
                            >
                              <NewChatIcon />
                            </CodexSidebarActionButton>
                            <SectionActions
                              section={section}
                              onRename={() => setRenameSection(section)}
                              onArchiveAll={() => setArchiveSection(section)}
                              archiveDisabled={itemQuery?.isPending ?? true}
                              onDelete={() => {
                                void invokeCoreResult(
                                  "sidebar-sections:delete",
                                  section.sectionId,
                                  {
                                    expectedRevision: section.revision,
                                  },
                                )
                                  .then(async () => {
                                    await refresh();
                                    toast.info("Section deleted", {
                                      action: {
                                        label: "Undo",
                                        onClick: () => {
                                          void invokeCoreResult(
                                            "sidebar-sections:restore",
                                            section.sectionId,
                                            { expectedRevision: section.revision + 1 },
                                          ).then(refresh);
                                        },
                                      },
                                    });
                                  })
                                  .catch(() => toast.danger("Couldn’t delete section"));
                              }}
                            />
                          </>
                        }
                      >
                        <SectionDirectItems
                          catalog={catalog}
                          getThreadKey={getThreadKey}
                          items={items}
                          loading={itemQuery?.isPending ?? false}
                          onThreadsChanged={onThreadsChanged}
                          renderProject={renderProject}
                          renderSession={renderSession}
                          section={section}
                        />
                      </CodexSidebarSection>
                    )}
                  </SectionDropTarget>
                )}
              </SectionRootSortable>
            </Fragment>
          );
        })}
        {rootReorder.dropIndicatorIndex === orderedSections.length ? (
          <SidebarDropIndicator />
        ) : null}
      </SidebarSectionRootSortableContext>
      {sectionsQuery.isError ? (
        <button
          type="button"
          className="px-row-x py-row-y text-left text-sm text-token-description-foreground hover:text-token-foreground"
          onClick={() => void sectionsQuery.refetch()}
        >
          Retry sections
        </button>
      ) : null}
      {renameSection ? (
        <SidebarSectionNameDialog
          title="Edit section"
          description="Group projects and chats without changing where they belong."
          initialValue={renameSection.name ?? ""}
          onClose={() => setRenameSection(null)}
          onSave={async (name) => {
            await invokeCoreResult("sidebar-sections:rename", renameSection.sectionId, {
              name,
              expectedRevision: renameSection.revision,
            });
            await refresh();
          }}
        />
      ) : null}
      {archiveSection ? (
        <NodexDialog open onOpenChange={(open) => !open && setArchiveSection(null)}>
          <NodexDialogContent size="compact">
            <NodexDialogForm
              onSubmit={(event) => {
                event.preventDefault();
                const items = catalog.itemsBySectionId.get(archiveSection.sectionId) ?? [];
                const directSessionIds = new Set(
                  items.flatMap((item) =>
                    item.kind === "session" ? [item.session.sessionId] : [],
                  ),
                );
                const projectIds = new Set(
                  items.flatMap((item) =>
                    item.kind === "project" ? [item.project.projectId] : [],
                  ),
                );
                const activeWillBeArchived =
                  activeSessionId !== null &&
                  (directSessionIds.has(activeSessionId) ||
                    [...projectIds].some((projectId) =>
                      (sessionsByProject[projectId] ?? []).some(
                        (session) =>
                          session.id === activeSessionId && !directSessionIds.has(session.id),
                      ),
                    ));
                void invokeCoreResult(
                  "sidebar-sections:sessions:archive-all",
                  archiveSection.sectionId,
                  { createReplacement: activeWillBeArchived },
                )
                  .then(async (replacement) => {
                    if (replacement) onSelectSession(replacement);
                    setArchiveSection(null);
                    await refresh();
                    await onThreadsChanged?.();
                  })
                  .catch(() => toast.danger("Couldn’t archive section chats"));
              }}
            >
              <NodexDialogHeader>
                <NodexDialogTitle>
                  Archive {archiveSection.effectiveSessionCount} chats?
                </NodexDialogTitle>
                <NodexDialogDescription>
                  This archives every active chat in {archiveSection.name ?? "this section"},
                  including chats inherited from its projects.
                </NodexDialogDescription>
              </NodexDialogHeader>
              <NodexDialogFooter>
                <NodexDialogAction type="button" onClick={() => setArchiveSection(null)}>
                  Cancel
                </NodexDialogAction>
                <NodexDialogAction tone="danger" type="submit">
                  Archive all
                </NodexDialogAction>
              </NodexDialogFooter>
            </NodexDialogForm>
          </NodexDialogContent>
        </NodexDialog>
      ) : null}
    </>
  );
}

export function SidebarProjectSectionMenu({
  projectId,
  catalog,
  currentSectionId = null,
  pinned = false,
}: {
  readonly projectId: string;
  readonly catalog: SidebarSectionsCatalog;
  readonly currentSectionId?: string | null;
  readonly pinned?: boolean;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const move = async (sectionId: string) => {
    await invokeCoreResult("sidebar-sections:item:move", {
      item: { kind: "project", projectId },
      sectionId,
      placement: { kind: "end" },
    });
    await catalog.refresh();
  };

  return (
    <>
      <NodexDropdownFlyoutSubmenuItem
        label="Section"
        leftSlot={<ProjectFolderIcon className="icon-xs" />}
      >
        <NodexDropdownRadioGroup
          value={pinned ? "pinned" : (currentSectionId ?? "default")}
          onValueChange={(value) => {
            if (value === "default") {
              void Promise.resolve()
                .then(() => invoke("projects:set-pinned", projectId, { pinned: false }))
                .then(() =>
                  invokeCoreResult("sidebar-sections:item:move", {
                    item: { kind: "project", projectId },
                    sectionId: null,
                    placement: { kind: "end" },
                  }),
                )
                .then(catalog.refresh);
              return;
            }
            if (value === "pinned") {
              void invoke("projects:set-pinned", projectId, { pinned: true }).then(catalog.refresh);
              return;
            }
            void move(value);
          }}
        >
          <NodexDropdownRadioItem value="default">Projects</NodexDropdownRadioItem>
          <NodexDropdownRadioItem value="pinned">Pinned</NodexDropdownRadioItem>
          {catalog.sections.map((section) => (
            <NodexDropdownRadioItem key={section.sectionId} value={section.sectionId}>
              {section.name ?? "Untitled section"}
            </NodexDropdownRadioItem>
          ))}
        </NodexDropdownRadioGroup>
        <NodexDropdownItem
          leftSlot={<PlusIcon className="icon-xs" />}
          onSelect={() => setCreateOpen(true)}
        >
          New section…
        </NodexDropdownItem>
      </NodexDropdownFlyoutSubmenuItem>
      {createOpen ? (
        <SidebarSectionNameDialog
          title="New section"
          description="Create a section and move this project into it."
          onClose={() => setCreateOpen(false)}
          allowEmpty
          onSave={async (name) => {
            await invokeCoreResult("sidebar-sections:create", {
              name,
              initialItem: { kind: "project", projectId },
            });
            await catalog.refresh();
          }}
        />
      ) : null}
    </>
  );
}
