import { PageIcon, PlusIcon } from "@/components/shared/icons";
import { LibraryNewMenu, useLibraryCreateCommands } from "@/components/library/library-new-menu";
import type {
  LibraryPlacedResourceTarget,
  LibraryRouteTarget,
} from "../../../shared/library-module";
import {
  SIDEBAR_NEW_CHAT_ROW_CLASS,
  SIDEBAR_SCROLL_AREA_CLASS,
  WorkbenchSidebarHeader,
  useSidebarScrollChrome,
} from "./sidebar-new-chat-controls";
import { WorkbenchSidebarFrame, type WorkbenchSidebarFrameProps } from "./workbench-sidebar-frame";
import { WorkbenchSpaceSidebarContent } from "./workbench-space-sidebar-content";
import type { WorkbenchSidebarBodyProps } from "./workbench-sidebar";

export function WorkbenchSpaceSidebar({
  body,
  onHoverSurfaceOpenChange,
  ...placement
}: Omit<WorkbenchSidebarFrameProps, "children" | "width" | "onResizeWidth" | "getWindowZoom"> & {
  body: WorkbenchSidebarBodyProps;
  onHoverSurfaceOpenChange?: (open: boolean) => void;
}) {
  const { scrollAreaRef, scrollChromeStyle, scrolledContentUnderHeader, syncScrollChrome } =
    useSidebarScrollChrome();

  return (
    <WorkbenchSidebarFrame
      {...placement}
      testId="space-sidebar"
      width={body.width}
      getWindowZoom={body.getWindowZoom}
      onResizeWidth={body.onResizeWidth}
    >
      <nav
        aria-label="Space"
        className="sidebar-foreground-muted flex h-full min-h-0 flex-col overflow-hidden [--height-token-nav-row:30px] [--padding-row-cell-x:8px] [--padding-row-x:8px] [--radius-token-row:10px]"
        style={scrollChromeStyle}
      >
        <WorkbenchSidebarHeader
          title="Space"
          scrolledContentUnderHeader={scrolledContentUnderHeader}
          onSearch={body.onOpenCommandPalette}
        >
          <SpaceNewPageRow onCreated={body.onOpenResourceTarget} />
        </WorkbenchSidebarHeader>
        <div
          ref={scrollAreaRef}
          data-app-action-sidebar-scroll=""
          className={SIDEBAR_SCROLL_AREA_CLASS}
          onScroll={syncScrollChrome}
        >
          <WorkbenchSpaceSidebarContent
            collapsed={body.pagesSectionCollapsed}
            activeRoot={body.activeResourceTarget ?? null}
            onToggle={body.onTogglePagesSectionCollapsed}
            onOpenRoot={body.onOpenResourceTarget}
            projects={body.sidebarThreadModel.projectGroups.map(({ project }) => ({
              id: project.id,
              name: project.name,
            }))}
            onOpenInProject={body.onOpenResourceTargetInProject}
            onHoverSurfaceOpenChange={onHoverSurfaceOpenChange}
          />
        </div>
      </nav>
    </WorkbenchSidebarFrame>
  );
}

/**
 * Space's primary row creates a root Page directly; its trailing menu offers every
 * Library root kind. It occupies the same first-row slot as Home's Inbox.
 */
function SpaceNewPageRow({
  onCreated,
}: {
  onCreated: (target: LibraryPlacedResourceTarget) => void;
}) {
  const openRoot = (target: LibraryRouteTarget) => {
    if (target.kind === "view") return;
    onCreated(target);
  };
  const commands = useLibraryCreateCommands({ onCreated: openRoot });

  return (
    <div className="group/new-page relative shrink-0">
      <button
        type="button"
        className={SIDEBAR_NEW_CHAT_ROW_CLASS}
        disabled={commands.isPending}
        onClick={() => void commands.createPage()}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2 text-base text-token-foreground">
          <PageIcon className="icon-xs" />
          <span className="truncate">New page</span>
        </div>
      </button>
      <div className="absolute end-2 top-1/2 flex -translate-y-1/2 items-center opacity-0 group-focus-within/new-page:opacity-100 group-hover/new-page:opacity-100 has-[[data-state=open]]:opacity-100">
        <LibraryNewMenu
          onCreated={openRoot}
          triggerButton={
            <button
              type="button"
              aria-label="New Page or Database"
              className="no-drag flex size-5 cursor-interaction items-center justify-center rounded-md text-token-text-tertiary hover:bg-token-list-hover-background hover:text-token-foreground"
            >
              <PlusIcon className="icon-2xs" />
            </button>
          }
        />
      </div>
    </div>
  );
}
