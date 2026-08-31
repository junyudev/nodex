import { useMemo, useState } from "react";
import {
  DatabaseIcon,
  PageIcon,
  ProjectActionsIcon,
  PlusIcon,
  CanvasIcon,
} from "@/components/shared/icons";
import type { LibraryResourceTarget, LibraryReadValue } from "../../../shared/library-module";
import { useInfiniteLibraryStandaloneRoots } from "@/lib/use-library-navigation";
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

type StandaloneRootsValue = Extract<LibraryReadValue, { readonly kind: "standalone_roots" }>;
type StandaloneRoot = StandaloneRootsValue["items"][number];

interface StandaloneRootsQueryState {
  readonly data?: { readonly pages: readonly StandaloneRootsValue[] };
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly hasNextPage: boolean;
  readonly refetch: () => Promise<unknown>;
  readonly fetchNextPage: () => Promise<unknown>;
}

export interface SidebarPagesDataSource {
  readonly useStandaloneRoots: (
    input: Readonly<{
      limit?: number;
      forceIncludeTarget?: LibraryResourceTarget;
    }>,
  ) => StandaloneRootsQueryState;
}

const DEFAULT_PAGES_DATA_SOURCE: SidebarPagesDataSource = {
  useStandaloneRoots: (input) => useInfiniteLibraryStandaloneRoots(input),
};

const rootKey = (root: LibraryResourceTarget): string => {
  if (root.kind === "page") return `page:${root.pageId}`;
  if (root.kind === "database") return `database:${root.databaseId}`;
  return `canvas:${root.canvasId}`;
};

const nodeTarget = (node: StandaloneRoot): LibraryResourceTarget => {
  if (node.kind === "page") return { kind: "page", pageId: node.pageId };
  if (node.kind === "database") {
    return { kind: "database", databaseId: node.databaseId };
  }
  return { kind: "canvas", canvasId: node.canvasId };
};

const nodeKey = (node: StandaloneRoot): string => rootKey(nodeTarget(node));

const nodeIcon = (node: StandaloneRoot) => {
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
}: {
  readonly node: StandaloneRoot;
  readonly active: boolean;
  readonly projects: readonly LibraryProjectOption[];
  readonly mutationsEnabled: boolean;
  readonly onOpen: (target: LibraryResourceTarget) => void;
  readonly onOpenInProject?: (
    projectId: string,
    target: ActionableLibraryResourceTarget,
    title: string,
  ) => void | Promise<void>;
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
              setActionsOpen(true);
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
                onOpenChange={setActionsOpen}
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

export function SidebarPagesSection({
  collapsed,
  activeRoot,
  onToggle,
  onOpenRoot,
  projects = EMPTY_LIBRARY_PROJECT_OPTIONS,
  onOpenInProject,
  dataSource = DEFAULT_PAGES_DATA_SOURCE,
  mutationsEnabled = dataSource === DEFAULT_PAGES_DATA_SOURCE,
}: {
  readonly collapsed: boolean;
  readonly activeRoot: LibraryResourceTarget | null;
  readonly onToggle: () => void;
  readonly onOpenRoot: (target: LibraryResourceTarget) => void;
  readonly projects?: readonly LibraryProjectOption[];
  readonly onOpenInProject?: (
    projectId: string,
    target: ActionableLibraryResourceTarget,
    title: string,
  ) => void | Promise<void>;
  readonly dataSource?: SidebarPagesDataSource;
  readonly mutationsEnabled?: boolean;
}) {
  const query = dataSource.useStandaloneRoots({
    limit: 10,
    ...(activeRoot ? { forceIncludeTarget: activeRoot } : {}),
  });
  const [expanded, setExpanded] = useState(false);
  const roots = useMemo(
    () => [
      ...new Map(
        (query.data?.pages ?? [])
          .flatMap((page) => page.items)
          .map((node) => [nodeKey(node), node] as const),
      ).values(),
    ],
    [query.data?.pages],
  );
  const rootDropTarget = useSidebarLibraryRootDropTarget();

  return (
    <CodexSidebarSection
      heading="Pages"
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
            <span className="min-w-0 truncate px-1">Loading Pages…</span>
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
            <span className="min-w-0 truncate px-1">Retry Pages</span>
          </button>
        ) : roots.length === 0 ? (
          <div className="px-row-x py-row-y text-sm text-token-description-foreground">
            No standalone pages
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
              <div role="list" aria-label="Pages">
                {pagination.visibleItems.map((node) => (
                  <SidebarPageRootRow
                    key={nodeKey(node)}
                    node={node}
                    active={activeRoot ? nodeKey(node) === rootKey(activeRoot) : false}
                    projects={projects}
                    mutationsEnabled={mutationsEnabled}
                    onOpen={onOpenRoot}
                    onOpenInProject={onOpenInProject}
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
