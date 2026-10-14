import { useEffect, useMemo, useState } from "react";
import {
  DatabaseIcon,
  PageIcon,
  ProjectActionsIcon,
  PlusIcon,
  CanvasIcon,
} from "@/components/shared/icons";
import type {
  LibraryNavigationNode,
  LibraryPlacedResourceTarget,
  LibraryReadValue,
  LibraryViewNavigationNode,
} from "../../../shared/library-module";
import { useInfiniteLibraryChildren } from "@/lib/use-library-navigation";
import {
  CODEX_SIDEBAR_GROUP_ACTION_BUTTON_CLASS,
  CODEX_SIDEBAR_ROW_LABEL_CLASS,
  CodexSidebarActionButton,
  CodexSidebarRowLayout,
  CodexSidebarSection,
  CodexSidebarTreeRow,
} from "./codex-sidebar";
import { LibraryNewMenu } from "../library/library-new-menu";
import {
  LibraryResourceActions,
  type LibraryProjectOption,
  type LibraryResourceTarget as ActionableLibraryResourceTarget,
} from "../library/library-resource-actions";
import {
  useSidebarLibraryResourceDnd,
  useSidebarLibraryRootDropTarget,
} from "./sidebar-library-dnd";
import { SidebarPaginatedItems } from "./sidebar-paginated-items";
import { cn } from "@/lib/utils";
import { usePresentedPageTitle } from "@/lib/page-title-projection-context";

type LibraryRootsValue = Extract<LibraryReadValue, { readonly kind: "children" }>;
type LibraryRoot = Exclude<LibraryNavigationNode, LibraryViewNavigationNode>;

interface LibraryRootsQueryState {
  readonly data?: { readonly pages: readonly LibraryRootsValue[] };
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly hasNextPage: boolean;
  readonly refetch: () => Promise<unknown>;
  readonly fetchNextPage: () => Promise<unknown>;
}

export interface SidebarPagesDataSource {
  readonly useRoots: (
    input: Readonly<{
      limit?: number;
      forceIncludeTarget?: LibraryPlacedResourceTarget;
    }>,
  ) => LibraryRootsQueryState;
}

const DEFAULT_PAGES_DATA_SOURCE: SidebarPagesDataSource = {
  useRoots: (input) => useInfiniteLibraryChildren({ kind: "library" }, input),
};

const rootKey = (root: LibraryPlacedResourceTarget): string => {
  if (root.kind === "page") return `page:${root.pageId}`;
  if (root.kind === "database") return `database:${root.databaseId}`;
  return `canvas:${root.canvasId}`;
};

const nodeTarget = (node: LibraryRoot): LibraryPlacedResourceTarget => {
  if (node.kind === "page") return { kind: "page", pageId: node.pageId };
  if (node.kind === "database") {
    return { kind: "database", databaseId: node.databaseId };
  }
  return { kind: "canvas", canvasId: node.canvasId };
};

const nodeKey = (node: LibraryRoot): string => rootKey(nodeTarget(node));

const nodeIcon = (node: LibraryRoot) => {
  if (node.kind === "page") return <PageIcon />;
  if (node.kind === "database") return <DatabaseIcon />;
  return <CanvasIcon className="icon-xs" />;
};

function SidebarPageRootRow({
  node,
  active,
  projects,
  mutationsEnabled,
  onOpen,
  onOpenInProject,
  onHoverSurfaceOpenChange,
}: {
  readonly node: LibraryRoot;
  readonly active: boolean;
  readonly projects: readonly LibraryProjectOption[];
  readonly mutationsEnabled: boolean;
  readonly onOpen: (target: LibraryPlacedResourceTarget) => void;
  readonly onOpenInProject?: (
    projectId: string,
    target: ActionableLibraryResourceTarget,
    title: string,
  ) => void | Promise<void>;
  readonly onHoverSurfaceOpenChange?: (open: boolean) => void;
}) {
  const target = nodeTarget(node);
  const key = nodeKey(node);
  const title = usePresentedPageTitle(
    node.kind === "page" ? node.pageId : null,
    node.title,
    undefined,
    node.kind === "page"
      ? {
          generation: node.documentGeneration,
          headSeq: node.documentHeadSeq,
        }
      : undefined,
  );
  const actionableTarget =
    node.kind === "canvas" ? null : (target as ActionableLibraryResourceTarget);
  const expectedLocationRevision =
    node.kind === "page" ? node.parentRevision : node.locationRevision;
  const [actionsOpen, setActionsOpen] = useState(false);
  const changeActionsOpen = (open: boolean) => {
    onHoverSurfaceOpenChange?.(open);
    setActionsOpen(open);
  };
  useEffect(() => {
    if (!actionsOpen) return;
    onHoverSurfaceOpenChange?.(true);
    return () => onHoverSurfaceOpenChange?.(false);
  }, [actionsOpen, onHoverSurfaceOpenChange]);
  const dnd = useSidebarLibraryResourceDnd({
    resource: actionableTarget
      ? {
          target: actionableTarget,
          title,
          expectedLocationRevision,
          dragOverlay: (
            <div className="flex h-token-nav-row items-center gap-2 px-2 text-sm text-token-text-primary">
              {nodeIcon(node)}
              <span className="max-w-56 truncate">{title}</span>
            </div>
          ),
        }
      : null,
    disabledKey: key,
    ownerParent: { kind: "library" },
    ...(actionableTarget
      ? {
          before: {
            blockId:
              actionableTarget.kind === "page"
                ? actionableTarget.pageId
                : actionableTarget.databaseId,
            expectedLocationRevision,
          },
        }
      : {}),
  });

  return (
    <CodexSidebarTreeRow
      ref={dnd.setNodeRef}
      {...dnd.attributes}
      {...dnd.listeners}
      role="listitem"
      aria-current={active ? "page" : undefined}
      active={active}
      className={cn(dnd.isOver && "ring-1 ring-token-border", dnd.isDragging && "opacity-40")}
      onClick={() => onOpen(target)}
      onContextMenu={
        actionableTarget && mutationsEnabled
          ? (event) => {
              event.preventDefault();
              event.stopPropagation();
              changeActionsOpen(true);
            }
          : undefined
      }
    >
      <CodexSidebarRowLayout
        leadingSlotProps={{ className: "text-token-text-secondary" }}
        leadingSlot={nodeIcon(node)}
        actions={
          actionableTarget && mutationsEnabled ? (
            <span
              className="shrink-0 opacity-0 group-hover/folder-row:opacity-100 group-focus-within/folder-row:opacity-100 has-[[data-state=open]]:opacity-100"
              onClick={(event) => event.stopPropagation()}
            >
              <LibraryResourceActions
                target={actionableTarget}
                title={title}
                expectedLocationRevision={expectedLocationRevision}
                expectedMetadataRevision={node.metadataRevision}
                projects={projects}
                onOpenInProject={onOpenInProject}
                open={actionsOpen}
                onOpenChange={changeActionsOpen}
                triggerButton={
                  <button
                    type="button"
                    aria-label={`Actions for ${title}`}
                    className={CODEX_SIDEBAR_GROUP_ACTION_BUTTON_CLASS}
                    onClick={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                  >
                    <ProjectActionsIcon className="icon-xs shrink-0" />
                  </button>
                }
              />
            </span>
          ) : null
        }
      >
        <span className={CODEX_SIDEBAR_ROW_LABEL_CLASS}>
          <span className="min-w-0 flex-1 truncate pr-1">{title}</span>
        </span>
      </CodexSidebarRowLayout>
    </CodexSidebarTreeRow>
  );
}

const EMPTY_LIBRARY_PROJECT_OPTIONS: readonly LibraryProjectOption[] = [];

export interface SidebarPagesSectionProps {
  readonly collapsed: boolean;
  readonly activeRoot: LibraryPlacedResourceTarget | null;
  readonly onToggle: () => void;
  readonly onOpenRoot: (target: LibraryPlacedResourceTarget) => void;
  readonly projects?: readonly LibraryProjectOption[];
  readonly onOpenInProject?: (
    projectId: string,
    target: ActionableLibraryResourceTarget,
    title: string,
  ) => void | Promise<void>;
  readonly dataSource?: SidebarPagesDataSource;
  readonly mutationsEnabled?: boolean;
  readonly onHoverSurfaceOpenChange?: (open: boolean) => void;
}

export function SidebarPagesSection({
  collapsed,
  activeRoot,
  onToggle,
  onOpenRoot,
  projects = EMPTY_LIBRARY_PROJECT_OPTIONS,
  onOpenInProject,
  dataSource = DEFAULT_PAGES_DATA_SOURCE,
  mutationsEnabled = dataSource === DEFAULT_PAGES_DATA_SOURCE,
  onHoverSurfaceOpenChange,
}: SidebarPagesSectionProps) {
  const query = dataSource.useRoots({
    limit: 10,
    ...(activeRoot ? { forceIncludeTarget: activeRoot } : {}),
  });
  const [expanded, setExpanded] = useState(false);
  const roots = useMemo(
    () => [
      ...new Map(
        (query.data?.pages ?? [])
          .flatMap((page) => page.items)
          .filter((node): node is LibraryRoot => node.kind !== "view")
          .map((node) => [nodeKey(node), node] as const),
      ).values(),
    ],
    [query.data?.pages],
  );
  const rootDropTarget = useSidebarLibraryRootDropTarget();

  return (
    <CodexSidebarSection
      heading="Content"
      collapsed={collapsed}
      onToggle={onToggle}
      actions={
        mutationsEnabled ? (
          <LibraryNewMenu
            onCreated={(target) => {
              if (target.kind === "view") return;
              onOpenRoot(target);
            }}
            triggerButton={
              <CodexSidebarActionButton label="New Page or Database">
                <PlusIcon className="icon-sm" />
              </CodexSidebarActionButton>
            }
          />
        ) : null
      }
    >
      <div
        ref={rootDropTarget.setNodeRef}
        className={cn(rootDropTarget.isOver && "rounded-lg ring-1 ring-token-border")}
      >
        {query.isPending ? (
          <div className="flex h-token-nav-row items-center rounded-lg px-1 text-base text-token-description-foreground">
            <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
              ·
            </span>
            <span className="min-w-0 truncate px-1">Loading…</span>
          </div>
        ) : query.isError ? (
          <button
            type="button"
            className="flex h-token-nav-row w-full items-center rounded-lg px-1 text-left text-base text-token-description-foreground hover:bg-token-list-hover-background hover:text-token-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px]"
            onClick={() => void query.refetch()}
          >
            <span className="flex size-6 shrink-0 items-center justify-center" aria-hidden>
              !
            </span>
            <span className="min-w-0 truncate px-1">Retry</span>
          </button>
        ) : roots.length === 0 ? (
          <div className="px-row-x py-row-y text-sm text-token-description-foreground">
            No content yet
          </div>
        ) : (
          <SidebarPaginatedItems
            items={roots}
            getKey={nodeKey}
            maxItems={5}
            expanded={expanded}
            onExpandedChange={setExpanded}
            forcedVisibleKey={activeRoot ? rootKey(activeRoot) : null}
            hasMoreAtSource={query.hasNextPage}
            onLoadMore={async () => {
              await query.fetchNextPage();
            }}
          >
            {(pagination, pager) => (
              <div role="list" aria-label="Content">
                {pagination.visibleItems.map((node) => (
                  <SidebarPageRootRow
                    key={nodeKey(node)}
                    node={node}
                    active={activeRoot ? nodeKey(node) === rootKey(activeRoot) : false}
                    projects={projects}
                    mutationsEnabled={mutationsEnabled}
                    onOpen={onOpenRoot}
                    onOpenInProject={onOpenInProject}
                    onHoverSurfaceOpenChange={onHoverSurfaceOpenChange}
                  />
                ))}
                {pager}
              </div>
            )}
          </SidebarPaginatedItems>
        )}
      </div>
    </CodexSidebarSection>
  );
}
