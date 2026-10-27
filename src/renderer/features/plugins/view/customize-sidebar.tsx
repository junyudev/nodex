import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { PluginsIcon, SettingsSearchIcon } from "@/components/shared/icons";
import { SkillsGlyphIcon } from "@/components/shared/icons/customize-icons";
import { NodexButton } from "@/components/ui/button";
import {
  SIDEBAR_SCROLL_AREA_CLASS,
  WorkbenchSidebarHeader,
  useSidebarScrollChrome,
} from "@/components/workbench/sidebar-new-chat-controls";
import {
  WorkbenchSidebarFrame,
  type WorkbenchSidebarFrameProps,
} from "@/components/workbench/workbench-sidebar-frame";
import { cn } from "@/lib/utils";
import type { CustomizeNavigation } from "../customize-navigation";
import { useInstalledPlugins, type PluginRow } from "../plugin-management";
import { buildPluginDirectoryPath, buildSkillsPath } from "../plugins-routes";
import {
  isPluginRowSelected,
  resolveCustomizeSelection,
  type CustomizeSelection,
} from "../model/customize-selection";
import { InstalledPluginActionsMenu } from "./installed-plugin-actions-menu";
import { useOpenPluginDetail } from "./plugin-browse-context";
import { pluginLogoSource, PluginLogoImage } from "./plugin-logo";

const SEARCH_FIELD_ID = "customize-installed-search";
const SEARCH_LABEL = "Search installed plugins";

/** One row: a 30px pill whose leading 16px icon and label sit 8px apart. */
const CUSTOMIZE_ROW_CLASS =
  "relative flex h-(--height-token-nav-row) w-full shrink-0 cursor-interaction items-center overflow-hidden rounded-lg text-start text-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-solid focus-visible:outline-token-focus-border";
const CUSTOMIZE_ROW_CONTENT_CLASS = "flex min-w-0 flex-1 items-center gap-2 text-base";

function CustomizeNavRow({
  icon,
  label,
  active,
  onSelect,
}: {
  readonly icon: (className: string) => ReactNode;
  readonly label: string;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      className={cn(
        CUSTOMIZE_ROW_CLASS,
        "gap-2 px-row-x py-row-y",
        active ? "bg-token-list-hover-background" : "hover:bg-token-list-hover-background",
      )}
      onClick={onSelect}
    >
      <span
        className={cn(
          CUSTOMIZE_ROW_CONTENT_CLASS,
          active ? "text-(--color-text-emphasis)" : "text-token-foreground",
        )}
      >
        <span className="flex min-w-4 shrink-0 items-center justify-center">
          {icon(cn("size-4", active && "text-(--color-codex-icon-active)"))}
        </span>
        <span className="truncate">{label}</span>
      </span>
    </button>
  );
}

function InstalledPluginRow({
  row,
  active,
  context,
  onOpen,
  onMenuOpenChange,
}: {
  readonly row: PluginRow;
  readonly active: boolean;
  readonly context: CustomizeNavigation;
  readonly onOpen: () => void;
  readonly onMenuOpenChange: (open: boolean) => void;
}) {
  const label = row.summary.interface?.displayName ?? row.summary.name;
  return (
    <div
      role="listitem"
      className={cn(
        CUSTOMIZE_ROW_CLASS,
        "group pe-row-x",
        active ? "bg-token-list-hover-background" : "hover:bg-token-list-hover-background",
        "has-[[data-state=open]]:bg-token-list-hover-background",
      )}
    >
      <button
        type="button"
        aria-current={active ? "page" : undefined}
        className="flex h-full min-w-0 flex-1 cursor-interaction items-center ps-row-x pe-2 text-start outline-none"
        onClick={onOpen}
      >
        <span
          className={cn(
            CUSTOMIZE_ROW_CONTENT_CLASS,
            active ? "text-(--color-text-emphasis)" : "text-token-foreground",
          )}
        >
          <span className="flex min-w-4 shrink-0 items-center justify-center">
            <PluginLogoImage source={pluginLogoSource(row)} className="size-4 rounded-2xs" />
          </span>
          <span className="truncate">{label}</span>
        </span>
      </button>
      <span className="pointer-events-none flex w-0 items-center gap-1 overflow-hidden opacity-0 group-focus-within:pointer-events-auto group-focus-within:w-auto group-focus-within:overflow-visible group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:w-auto group-hover:overflow-visible group-hover:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:w-auto has-[[data-state=open]]:overflow-visible has-[[data-state=open]]:opacity-100">
        <InstalledPluginActionsMenu
          row={row}
          context={{ hostId: "local", projectId: context.projectId }}
          navigation={context}
          variant="sidebar"
          onOpenChange={onMenuOpenChange}
        />
      </span>
    </div>
  );
}

function InstalledPluginsList({
  navigation,
  searchQuery,
  selection,
  onMenuOpenChange,
}: {
  readonly navigation: CustomizeNavigation;
  readonly searchQuery: string;
  readonly selection: CustomizeSelection;
  readonly onMenuOpenChange: (key: string, open: boolean) => void;
}) {
  const installed = useInstalledPlugins(
    { hostId: "local", projectId: navigation.projectId },
    { search: searchQuery },
  );
  const openPluginDetail = useOpenPluginDetail(navigation);
  if (installed.data === undefined && installed.error == null) {
    return <CustomizeSidebarSkeleton />;
  }
  if (installed.error != null) {
    return (
      <div role="alert" className="flex flex-col gap-2 p-2 text-sm text-token-text-secondary">
        Failed to load plugins
        <NodexButton
          variant="secondary"
          size="sm"
          disabled={installed.isFetching}
          onClick={() => void installed.refetch()}
        >
          Retry
        </NodexButton>
      </div>
    );
  }
  const rows = installed.data;
  if (rows.length === 0) {
    return (
      <div role="status" className="p-2 text-sm text-token-text-secondary">
        {searchQuery.trim().length > 0 ? "No matching plugins" : "No installed plugins"}
      </div>
    );
  }
  return (
    <div role="list" aria-label="Installed" className="flex flex-col gap-px">
      {rows.map((row) => (
        <InstalledPluginRow
          key={row.stableIdentity}
          row={row}
          active={isPluginRowSelected(row, selection)}
          context={navigation}
          onOpen={() => openPluginDetail(row)}
          onMenuOpenChange={(open) => onMenuOpenChange(`plugin:${row.stableIdentity}`, open)}
        />
      ))}
    </div>
  );
}

/** Four placeholder rows while the installed list loads. */
function CustomizeSidebarSkeleton() {
  return (
    <div role="status" className="flex flex-col gap-px">
      <span className="sr-only">Loading plugins…</span>
      {["w-2/3", "w-1/2", "w-3/4", "w-5/12"].map((width) => (
        <div key={width} className="flex h-(--height-token-nav-row) items-center gap-2 px-row-x">
          <div className="size-4 shrink-0 rounded-full bg-text/10" />
          <div className={cn("h-4 max-w-full rounded bg-text/10", width)} />
        </div>
      ))}
    </div>
  );
}

/** Customize's sidebar: Plugins, Skills, and every installed plugin. */
export function CustomizeSidebar({
  navigation,
  onHoverSurfaceOpenChange,
  ...frame
}: Omit<WorkbenchSidebarFrameProps, "children"> & {
  navigation: CustomizeNavigation;
  onHoverSurfaceOpenChange?: (open: boolean) => void;
}) {
  // A floating sidebar stays open while one of its menus is.
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
  const searchButtonRef = useRef<HTMLButtonElement>(null);
  const searchInputId = useId();
  const selection = resolveCustomizeSelection(navigation.path);

  const closeSearch = () => {
    setSearchQuery(null);
    searchButtonRef.current?.focus();
  };

  return (
    <WorkbenchSidebarFrame {...frame} testId="customize-sidebar">
      <nav
        aria-label="Customize"
        className="sidebar-foreground-muted flex h-full min-h-0 flex-col overflow-hidden [--height-token-nav-row:30px] [--padding-row-cell-x:8px] [--padding-row-x:8px] [--radius-token-row:10px]"
        style={scrollChromeStyle}
      >
        <WorkbenchSidebarHeader
          title="Customize"
          scrolledContentUnderHeader={scrolledContentUnderHeader}
          onSearch={() => (searchQuery === null ? setSearchQuery("") : closeSearch())}
          inlineSearch={{
            label: SEARCH_LABEL,
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
                  aria-label={SEARCH_LABEL}
                  placeholder={SEARCH_LABEL}
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
        />
        <div
          ref={scrollAreaRef}
          data-app-action-sidebar-scroll=""
          className={cn(SIDEBAR_SCROLL_AREA_CLASS, "px-row-x pt-0 pb-row-x")}
          onScroll={syncScrollChrome}
        >
          <div className="flex flex-col gap-px">
            <CustomizeNavRow
              label="Plugins"
              active={selection.kind === "plugins"}
              icon={(className) => <PluginsIcon className={className} />}
              onSelect={() => navigation.onNavigate(buildPluginDirectoryPath())}
            />
            <CustomizeNavRow
              label="Skills"
              active={selection.kind === "skills"}
              icon={(className) => <SkillsGlyphIcon size={16} className={className} />}
              onSelect={() => navigation.onNavigate(buildSkillsPath())}
            />
          </div>
          <div className="flex flex-col gap-1">
            <div className="flex min-h-(--height-token-nav-row) items-center justify-between gap-2 ps-2 pe-1.5">
              <div className="min-w-0 flex-1 text-base font-medium text-tertiary">Installed</div>
            </div>
            <InstalledPluginsList
              navigation={navigation}
              searchQuery={searchQuery ?? ""}
              selection={selection}
              onMenuOpenChange={setSurfaceOpen}
            />
          </div>
        </div>
      </nav>
    </WorkbenchSidebarFrame>
  );
}
