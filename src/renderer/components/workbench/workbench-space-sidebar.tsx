import { SettingsSearchIcon } from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import { LeftSidebarFooter } from "./left-sidebar-footer";
import { SIDEBAR_SCROLL_AREA_CLASS, useSidebarScrollChrome } from "./sidebar-new-chat-controls";
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
  const { scrollAreaRef, scrollChromeStyle, syncScrollChrome } = useSidebarScrollChrome();

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
        <div className="flex h-13 shrink-0 items-center justify-between px-4">
          <span className="text-base font-medium text-default">Space</span>
          <NodexTooltip tooltipContent="Search" side="right">
            <button
              type="button"
              aria-label="Search"
              onClick={body.onOpenCommandPalette}
              className="no-drag flex size-7 items-center justify-center rounded-md text-token-text-secondary hover:bg-token-list-hover-background hover:text-token-foreground"
            >
              <SettingsSearchIcon className="icon-xs" />
            </button>
          </NodexTooltip>
        </div>
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
        <LeftSidebarFooter
          onOpenSettings={body.onOpenSettings}
          account={body.account}
          connection={body.connection}
          onRefreshAccount={body.onRefreshAccount}
          onConsumeRateLimitReset={body.onConsumeRateLimitReset}
          onStartChatGptLogin={body.onStartChatGptLogin}
          onStartApiKeyLogin={body.onStartApiKeyLogin}
          onCancelLogin={body.onCancelLogin}
          onLogout={body.onLogout}
          onErrorMessage={body.onAccountErrorMessage}
        />
      </nav>
    </WorkbenchSidebarFrame>
  );
}
