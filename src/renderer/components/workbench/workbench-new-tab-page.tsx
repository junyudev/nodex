import {
  createContext,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  CanvasIcon,
  ChatActionsIcon,
  ChatBubbleIcon,
  ClockIcon,
  ChevronDownIcon,
  DatabaseIcon,
  MoreToolsIcon,
  PageIcon,
  SidePanelSideChatIcon,
} from "@/components/shared/icons";
import {
  BrowserSidebarPanel,
  type BrowserAddressSuggestionsSource,
  type BrowserAddressWorkspaceOption,
} from "@/features/browser-sidebar/browser-sidebar-panel";
import { readBrowserAddressWorkspaceQuery } from "@/features/browser-sidebar/browser-address-suggestions";
import { formatCompactRelativeTime } from "@/lib/compact-relative-time";
import { readWorkbenchAgentContext } from "@/lib/workbench-agent-context";
import { getPanelNewTabAction } from "@/lib/workbench-panel-actions";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownMenu,
  NodexDropdownSectionLabel,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  formatNewTabRecentTime,
  resolveNewTabToolLayout,
  type NewTabToolLayout,
} from "@/lib/workbench-new-tab-model";
import { useWorkbenchNewTabPort, type WorkbenchNewTabIntent } from "@/lib/workbench-new-tab-port";
import {
  resolvePanelActionShortcutLabel,
  type PanelNewTabAction,
  type PanelNewTabActionKind,
} from "@/lib/workbench-panel-actions";
import {
  PANEL_TOOL_KEYCAP_CLASS,
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import type { PanelId, Project } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  RIGHT_PANEL_COMPOSER_OVERLAY_HEIGHT_PX,
  RIGHT_PANEL_COMPOSER_OVERLAY_HEIGHT_VAR,
  RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_PX,
} from "@/lib/right-panel-composer-overlay-reserve";
import {
  formatCommandShortcutLabel,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";
import type { LibraryRouteTarget } from "../../../shared/library-module";
import type { WorkbenchSceneOwner } from "../../../shared/workbench-scene";
import { PanelDestinationPicker } from "./panel-destination-picker";
import type { PanelDestination } from "./panel-destination-picker-model";
import {
  DEFAULT_SPACE_CONTENT_DATA_SOURCE,
  useSpaceContentResults,
  type SpaceContentDataSource,
  type SpaceContentItem,
} from "./space-content";

export interface WorkbenchNewTabPageProps {
  readonly layout: NewTabToolLayout;
  readonly isMac: boolean;
  readonly commandKeymapState?: CommandKeymapState | null;
  readonly projects: readonly Project[];
  readonly currentProjectId: string | null;
  /** Present when the owner's Chat is hidden behind a full-width panel. */
  readonly onSelectChat: (() => void) | null;
  readonly onSelectAction: (kind: PanelNewTabActionKind) => void;
  readonly onOpenDestination: (destination: PanelDestination) => void;
  /** Present when Terminal can also open in the bottom panel. */
  readonly bottomTerminal: { readonly shortcut: string | null; readonly onOpen: () => void } | null;
  readonly onOpenRecent: (item: SpaceContentItem) => void;
  readonly recentsDataSource?: SpaceContentDataSource;
  /** Sections between Tools and Recents, such as local servers. */
  readonly children?: ReactNode;
}

/**
 * The page a New tab shows: the tools it can become, then whatever else the tab can
 * open, then recent Space content. Every choice takes the New tab's place.
 */
export function WorkbenchNewTabPage({
  layout,
  isMac,
  commandKeymapState,
  projects,
  currentProjectId,
  onSelectChat,
  onSelectAction,
  onOpenDestination,
  bottomTerminal,
  onOpenRecent,
  recentsDataSource = DEFAULT_SPACE_CONTENT_DATA_SOURCE,
  children,
}: WorkbenchNewTabPageProps) {
  return (
    <div
      data-new-tab-scroll-root=""
      className="@container flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-token-main-surface-primary px-panel py-8 select-none"
      style={NEW_TAB_SCROLL_CLEARANCE_STYLE}
    >
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">
        <NewTabTools
          layout={layout}
          isMac={isMac}
          commandKeymapState={commandKeymapState}
          projects={projects}
          currentProjectId={currentProjectId}
          onSelectChat={onSelectChat}
          onSelectAction={onSelectAction}
          onOpenDestination={onOpenDestination}
          bottomTerminal={bottomTerminal}
        />
        {children}
        <NewTabRecents dataSource={recentsDataSource} onOpen={onOpenRecent} />
      </div>
    </div>
  );
}

/** A floating composer over the tab covers its last rows; the page scrolls them clear of it. */
const NEW_TAB_COMPOSER_CLEARANCE = `max(calc(var(--spacing) * 8), calc(var(${RIGHT_PANEL_COMPOSER_OVERLAY_HEIGHT_VAR}, 0px) + ${RIGHT_PANEL_COMPOSER_OVERLAY_RESERVE_PX - RIGHT_PANEL_COMPOSER_OVERLAY_HEIGHT_PX}px))`;
const NEW_TAB_SCROLL_CLEARANCE_STYLE = {
  paddingBottom: NEW_TAB_COMPOSER_CLEARANCE,
  scrollPaddingBottom: NEW_TAB_COMPOSER_CLEARANCE,
} as const;

export function NewTabSectionHeading({ children }: { readonly children: ReactNode }) {
  return <h3 className="text-sm font-medium text-token-text-primary">{children}</h3>;
}

const TOOL_TILE_CLASS =
  "flex w-full min-w-0 items-center rounded-md bg-[var(--color-background-primary-soft-alpha)] hover:bg-token-list-hover-background has-[[aria-expanded=true]]:bg-token-list-hover-background";
const TOOL_TILE_BUTTON_CLASS =
  "cursor-interaction flex min-h-10 w-full min-w-0 flex-1 items-center gap-2 rounded-md px-2.5 py-2 text-start outline-none select-none focus-visible:outline-2 focus-visible:outline-token-border-xstrong";

type NewTabToolTileProps = ComponentPropsWithoutRef<"button"> & {
  readonly icon: ReactNode;
  readonly label: ReactNode;
  readonly shortcut?: string | null;
  readonly trailingContent?: ReactNode;
  readonly trailingAction?: ReactNode;
};

function NewTabToolTile({
  icon,
  label,
  shortcut,
  trailingContent,
  trailingAction,
  className,
  ...buttonProps
}: NewTabToolTileProps) {
  return (
    <div className={TOOL_TILE_CLASS}>
      <button type="button" className={cn(TOOL_TILE_BUTTON_CLASS, className)} {...buttonProps}>
        <span className="flex shrink-0 items-center justify-center text-token-text-secondary">
          {icon}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-normal text-token-text-primary">
          {label}
        </span>
        {shortcut ? (
          <span className="ms-auto shrink-0 ps-2 text-token-text-secondary">
            <ShortcutKeycaps keys={[shortcut]} tone="current" className={PANEL_TOOL_KEYCAP_CLASS} />
          </span>
        ) : null}
        {trailingContent}
      </button>
      {trailingAction}
    </div>
  );
}

function NewTabTools({
  layout,
  isMac,
  commandKeymapState,
  projects,
  currentProjectId,
  onSelectChat,
  onSelectAction,
  onOpenDestination,
  bottomTerminal,
}: Pick<
  WorkbenchNewTabPageProps,
  | "layout"
  | "isMac"
  | "commandKeymapState"
  | "projects"
  | "currentProjectId"
  | "onSelectChat"
  | "onSelectAction"
  | "onOpenDestination"
  | "bottomTerminal"
>) {
  const shortcutFor = (action: PanelNewTabAction) =>
    resolvePanelActionShortcutLabel(action, isMac, commandKeymapState);
  const hasMore = layout.moreTools.length > 0 || layout.projectContent.length > 0;
  if (layout.tiles.length === 0 && !hasMore && !onSelectChat) return null;

  return (
    <section className="flex flex-col gap-4">
      <NewTabSectionHeading>Tools</NewTabSectionHeading>
      <div className="grid grid-cols-1 gap-x-4 gap-y-1 @md:grid-cols-2">
        {onSelectChat ? (
          <NewTabToolTile
            icon={<ChatBubbleIcon className="icon-xs" />}
            label="Chat"
            onClick={onSelectChat}
          />
        ) : null}
        {layout.tiles.map((action) => (
          <NewTabToolTile
            key={action.kind}
            icon={<action.Icon className="icon-xs" />}
            label={action.label}
            shortcut={shortcutFor(action)}
            onClick={() => onSelectAction(action.kind)}
            trailingAction={
              action.kind === "terminal" && bottomTerminal ? (
                <TerminalOptionsMenu action={action} bottomTerminal={bottomTerminal} />
              ) : null
            }
          />
        ))}
        {hasMore ? (
          <MoreToolsMenu
            layout={layout}
            shortcutFor={shortcutFor}
            projects={projects}
            currentProjectId={currentProjectId}
            onSelectAction={onSelectAction}
            onOpenDestination={onOpenDestination}
          />
        ) : null}
      </div>
    </section>
  );
}

function TerminalOptionsMenu({
  action,
  bottomTerminal,
}: {
  readonly action: PanelNewTabAction;
  readonly bottomTerminal: NonNullable<WorkbenchNewTabPageProps["bottomTerminal"]>;
}) {
  return (
    <div className="shrink-0 pe-2.5">
      <NodexDropdownMenu
        align="end"
        triggerButton={
          <button
            type="button"
            aria-label="Terminal options"
            className={cn(TOOLBAR_BUTTON_BASE_CLASS, TOOLBAR_BUTTON_GHOST_CLASS)}
          >
            <ChatActionsIcon className="icon-xs" />
          </button>
        }
      >
        <NodexDropdownItem
          leftSlot={<action.Icon className="icon-xs" />}
          keyboardShortcut={bottomTerminal.shortcut ?? undefined}
          onSelect={bottomTerminal.onOpen}
        >
          Open bottom terminal
        </NodexDropdownItem>
      </NodexDropdownMenu>
    </div>
  );
}

function MoreToolsMenu({
  layout,
  shortcutFor,
  projects,
  currentProjectId,
  onSelectAction,
  onOpenDestination,
}: {
  readonly layout: NewTabToolLayout;
  readonly shortcutFor: (action: PanelNewTabAction) => string | null;
  readonly projects: readonly Project[];
  readonly currentProjectId: string | null;
  readonly onSelectAction: (kind: PanelNewTabActionKind) => void;
  readonly onOpenDestination: (destination: PanelDestination) => void;
}) {
  const [open, setOpen] = useState(false);
  const renderItem = (action: PanelNewTabAction) =>
    action.kind === "page_stage" ? (
      <NodexDropdownFlyoutSubmenuItem
        key={action.kind}
        label={action.label}
        leftSlot={<action.Icon className="icon-xs" />}
        contentClassName="w-[330px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
      >
        <PanelDestinationPicker
          projects={projects}
          scope="page-only"
          ariaLabel="Open Page"
          placeholder="Open Page…"
          currentProjectId={currentProjectId}
          onClose={() => setOpen(false)}
          onAccept={(destination) => {
            setOpen(false);
            onOpenDestination(destination);
          }}
        />
      </NodexDropdownFlyoutSubmenuItem>
    ) : (
      <NodexDropdownItem
        key={action.kind}
        leftSlot={<action.Icon className="icon-xs" />}
        keyboardShortcut={shortcutFor(action) ?? undefined}
        onSelect={() => onSelectAction(action.kind)}
      >
        {action.label}
      </NodexDropdownItem>
    );

  return (
    <NodexDropdownMenu
      open={open}
      onOpenChange={setOpen}
      align="end"
      contentWidth="menuWide"
      triggerButton={
        <NewTabToolTile
          icon={<MoreToolsIcon className="icon-xs" />}
          label="More tools…"
          trailingContent={<ChevronDownIcon className="icon-xs shrink-0 text-token-text-primary" />}
        />
      }
    >
      {layout.moreTools.length > 0 ? (
        <>
          <NodexDropdownSectionLabel>More tools</NodexDropdownSectionLabel>
          {layout.moreTools.map(renderItem)}
        </>
      ) : null}
      {layout.moreTools.length > 0 && layout.projectContent.length > 0 ? (
        <NodexDropdownSeparator />
      ) : null}
      {layout.projectContent.length > 0 ? (
        <>
          <NodexDropdownSectionLabel>Project</NodexDropdownSectionLabel>
          {layout.projectContent.map(renderItem)}
        </>
      ) : null}
    </NodexDropdownMenu>
  );
}

const RECENT_ROW_CLASS =
  "snap-start rounded-xl border-b border-token-border-light hover:border-transparent hover:bg-token-list-hover-background focus-within:border-transparent focus-within:bg-token-list-hover-background [&:has(+li:hover)]:border-transparent [&:has(+li:focus-within)]:border-transparent";

function NewTabRecents({
  dataSource,
  onOpen,
}: {
  readonly dataSource: SpaceContentDataSource;
  readonly onOpen: (item: SpaceContentItem) => void;
}) {
  const { items } = useSpaceContentResults({ query: "", dataSource });
  const listRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ top: true, bottom: true });
  const [interacted, setInteracted] = useState(false);
  // Edit times are relative to when the page appeared.
  const [now] = useState(() => new Date());

  const measureEdges = (list: HTMLElement) => {
    const top = list.scrollTop < 1;
    const bottom = list.scrollTop + list.clientHeight >= list.scrollHeight - 1;
    setEdges((current) =>
      current.top === top && current.bottom === bottom ? current : { top, bottom },
    );
  };

  // The list shows as many whole rows as the page has room for, at most six, and lets half
  // of the next row peek out so it reads as scrollable.
  const attachList = (list: HTMLUListElement | null) => {
    listRef.current = list;
    const root = list?.closest<HTMLElement>("[data-new-tab-scroll-root]");
    if (!list || !root || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      const row = list.firstElementChild;
      if (!(row instanceof HTMLElement) || row.offsetHeight === 0) return;
      const rowHeight = row.offsetHeight;
      const rootRect = root.getBoundingClientRect();
      const scale = root.offsetHeight > 0 ? rootRect.height / root.offsetHeight : 1;
      const listTop =
        (list.getBoundingClientRect().top - rootRect.top) / (scale || 1) + root.scrollTop;
      const paddingBottom = Number.parseFloat(getComputedStyle(root).paddingBottom) || 0;
      const rows = Math.max(
        2,
        Math.floor((root.clientHeight - listTop - paddingBottom - rowHeight / 2) / rowHeight),
      );
      list.style.maxHeight = `${Math.min(6, rows + 0.5) * rowHeight}px`;
      list.style.setProperty("--recent-row-height", `${rowHeight}px`);
      measureEdges(list);
    });
    observer.observe(root);
    if (root.firstElementChild) observer.observe(root.firstElementChild);
    observer.observe(list);
    return () => observer.disconnect();
  };

  if (items.length === 0) return null;

  const scrollByRows = (direction: 1 | -1) => {
    setInteracted(true);
    const list = listRef.current;
    const row = list?.firstElementChild;
    if (!list || !(row instanceof HTMLElement)) return;
    const rowHeight = row.offsetHeight || list.clientHeight;
    const rows = Math.max(1, Math.floor((list.clientHeight - rowHeight / 2) / rowHeight));
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    list.scrollBy({
      top: direction * rows * rowHeight,
      behavior: reduceMotion ? "instant" : "smooth",
    });
  };

  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <NewTabSectionHeading>Recents</NewTabSectionHeading>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Scroll recents up"
            disabled={edges.top}
            className={cn(TOOLBAR_BUTTON_BASE_CLASS, TOOLBAR_BUTTON_GHOST_CLASS)}
            onClick={() => scrollByRows(-1)}
          >
            <ChevronDownIcon className="icon-xs rotate-180" />
          </button>
          <button
            type="button"
            aria-label="Scroll recents down"
            disabled={edges.bottom}
            className={cn(TOOLBAR_BUTTON_BASE_CLASS, TOOLBAR_BUTTON_GHOST_CLASS)}
            onClick={() => scrollByRows(1)}
          >
            <ChevronDownIcon className="icon-xs" />
          </button>
        </div>
      </div>
      <ul
        ref={attachList}
        aria-label="Recent pages"
        data-at-bottom={edges.bottom}
        data-interacted={interacted}
        className={cn(
          "overflow-y-auto overscroll-y-contain [overflow-anchor:none] [scrollbar-width:none]",
          "[mask-image:linear-gradient(to_bottom,black_calc(100%-var(--recent-row-height,0px)/2),transparent)]",
          "data-[at-bottom=true]:[mask-image:none] data-[interacted=true]:snap-y data-[interacted=true]:snap-mandatory",
        )}
        onScroll={(event) => measureEdges(event.currentTarget)}
        onWheel={() => setInteracted(true)}
        onTouchStart={() => setInteracted(true)}
        onKeyDown={() => setInteracted(true)}
      >
        {items.map((item) => (
          <li key={recentItemKey(item.target)} className={RECENT_ROW_CLASS}>
            <OverflowTooltip content={item.title.trim() || "Untitled"}>
              <button
                type="button"
                aria-label={item.title.trim() || "Untitled"}
                className="cursor-interaction flex min-h-14 w-full min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-start text-token-text-primary outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:ring-inset"
                onClick={() => onOpen(item)}
              >
                <span className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-[var(--color-surface-elevated)]">
                  <RecentGlyph target={item.target} />
                </span>
                <span className="min-w-0 flex-1">
                  <span
                    data-tooltip-overflow-target=""
                    className="block truncate text-sm text-token-text-primary"
                  >
                    {item.title.trim() || "Untitled"}
                  </span>
                  <span className="block truncate text-xs text-token-text-secondary">
                    {recentSubtitle(item)}
                  </span>
                </span>
                {item.updatedAt ? (
                  <time
                    className="shrink-0 text-xs whitespace-nowrap text-token-text-secondary tabular-nums"
                    dateTime={item.updatedAt}
                  >
                    {formatNewTabRecentTime(new Date(item.updatedAt), now)}
                  </time>
                ) : null}
              </button>
            </OverflowTooltip>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Shows the full text only when the trigger's `data-tooltip-overflow-target` is truncated. */
function OverflowTooltip({
  content,
  children,
}: {
  readonly content: ReactNode;
  readonly children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement | null>(null);
  return (
    <NodexTooltip
      tooltipContent={content}
      triggerRef={triggerRef}
      open={open}
      delayOpen
      onOpenChange={(next) => {
        const target =
          triggerRef.current?.querySelector<HTMLElement>("[data-tooltip-overflow-target]") ??
          triggerRef.current;
        setOpen(next && target !== null && target.scrollWidth > target.clientWidth);
      }}
    >
      {children}
    </NodexTooltip>
  );
}

function recentItemKey(target: LibraryRouteTarget): string {
  return `${target.kind}:${JSON.stringify(target)}`;
}

function recentSubtitle(item: SpaceContentItem): string {
  const kind =
    item.target.kind === "page" ? "Page" : item.target.kind === "canvas" ? "Canvas" : "Database";
  return item.locationLabel ? `${kind} · ${item.locationLabel}` : kind;
}

function RecentGlyph({ target }: { readonly target: LibraryRouteTarget }) {
  if (target.kind === "page") return <PageIcon className="icon-sm text-token-charts-blue" />;
  if (target.kind === "canvas") return <CanvasIcon className="icon-xs text-token-charts-orange" />;
  return <DatabaseIcon className="icon-xs text-token-charts-green" />;
}

/** Binds Browser chrome and its blank page to the same Scene and New tab port. */
export function WorkbenchBrowserSidebarPanel(
  binding: Omit<
    ComponentProps<typeof BrowserSidebarPanel>,
    "addressSuggestions" | "renderNewTabPage"
  > & {
    readonly owner: WorkbenchSceneOwner;
    readonly surfaceId: string;
    readonly panelId: PanelId;
  },
) {
  const { owner, surfaceId, panelId, ...props } = binding;
  return (
    <WorkbenchNewTabAddressContext.Provider value={binding}>
      <BrowserSidebarPanel
        {...props}
        addressSuggestions={WORKBENCH_ADDRESS_SUGGESTIONS}
        renderNewTabPage={({ localServers }) => (
          <WorkbenchNewTabSurface owner={owner} surfaceId={surfaceId} panelId={panelId}>
            {localServers}
          </WorkbenchNewTabSurface>
        )}
      />
    </WorkbenchNewTabAddressContext.Provider>
  );
}

const WorkbenchNewTabAddressContext = createContext<{
  readonly owner: WorkbenchSceneOwner;
  readonly surfaceId: string;
  readonly panelId: PanelId;
} | null>(null);

const WORKBENCH_ADDRESS_SUGGESTIONS: BrowserAddressSuggestionsSource = {
  useWorkspaceSuggestions: useWorkbenchNewTabAddressSuggestions,
};

const subscribeToNothing = () => () => undefined;

/** Workspace candidates remain presentation data; the port owns every accepted intent. */
export function useWorkbenchNewTabAddressSuggestions(
  query: string,
): readonly BrowserAddressWorkspaceOption[] {
  const binding = useContext(WorkbenchNewTabAddressContext);
  const port = useWorkbenchNewTabPort();
  const windowOwner = useWorkbenchWindowOwner();
  const workspaceQuery = readBrowserAddressWorkspaceQuery(query);
  // Every Browser tab mounts this hook; only a New tab with a typed query observes the Scene
  // and reads Pages, so loaded pages never rerender for unrelated window changes.
  const active = binding !== null && workspaceQuery !== null;
  const state = useSyncExternalStore(
    active ? windowOwner.subscribe : subscribeToNothing,
    windowOwner.read,
  );
  const observation = active ? readWorkbenchAgentContext(state, binding.owner) : null;
  const results = useSpaceContentResults({
    query: workspaceQuery ?? "",
    kinds: ["page"],
    enabled: active,
  });
  if (!port || !binding || !workspaceQuery) return [];
  const { owner, surfaceId, panelId } = binding;

  const open = (intent: WorkbenchNewTabIntent) => {
    void port.open({ owner, surfaceId, intent });
  };
  // A suggestion runs directly, so picker-only destinations such as Open page stay out.
  const tools = (port.resolveOwnerContext(owner, panelId)?.actions ?? [])
    .filter((action) => action.kind !== "browser" && action.kind !== "page_stage")
    .map((action): BrowserAddressWorkspaceOption => ({
      id: `action:${action.kind}`,
      kind: "launch-action",
      title: action.label,
      icon: <action.Icon className="icon-xs" />,
      onSelect: () => open({ kind: "action", action: action.kind }),
    }));
  const tabs = (observation?.tabs ?? [])
    .filter((tab) => tab.tabId !== surfaceId)
    .map((tab): BrowserAddressWorkspaceOption => {
      const Icon =
        tab.surface &&
        tab.surface.kind !== "conversation" &&
        tab.surface.kind !== "inbox" &&
        tab.surface.kind !== "image_editor"
          ? getPanelNewTabAction(tab.surface.kind).Icon
          : SidePanelSideChatIcon;
      return {
        id: `tab:${tab.tabId}`,
        kind: "switch-tab",
        title: tab.surface?.titleSnapshot ?? tab.auxiliary?.title ?? "",
        icon: <Icon className="icon-xs" />,
        trailing: "Switch to tab",
        onSelect: () => open({ kind: "tab", tabId: tab.tabId }),
      };
    });
  const openPageIds = new Set(
    observation?.tabs.flatMap((tab) =>
      tab.surface?.kind === "page_stage" ? [tab.surface.config.pageId] : [],
    ),
  );
  // Content-search hits can omit edit times; the title catalog retains their metadata.
  const catalogEditTimes = new Map(
    results.catalog.data?.pages.flatMap((page) =>
      page.items.map(
        (item) => [item.target.kind === "page" ? item.target.pageId : "", item.updatedAt] as const,
      ),
    ),
  );
  const pages = results.items.flatMap((item): BrowserAddressWorkspaceOption[] => {
    if (item.target.kind !== "page" || openPageIds.has(item.target.pageId)) return [];
    const updatedAt = Date.parse(item.updatedAt ?? catalogEditTimes.get(item.target.pageId) ?? "");
    return [
      {
        id: `page:${item.target.pageId}`,
        kind: "page",
        title: item.title,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : undefined,
        icon: <PageIcon className="icon-xs" />,
        trailing: Number.isFinite(updatedAt) ? (
          <span className="flex items-center gap-1">
            <ClockIcon className="icon-2xs" />
            {formatCompactRelativeTime(updatedAt)}
          </span>
        ) : undefined,
        onSelect: () => open({ kind: "library-target", target: item.target, title: item.title }),
      },
    ];
  });
  return [...tools, ...tabs, ...pages];
}

/**
 * A New tab bound to its owner Scene: it reads the owner's tools from the window's New tab
 * port and lets each choice replace this surface.
 */
export function WorkbenchNewTabSurface({
  owner,
  surfaceId,
  panelId,
  children,
}: {
  readonly owner: WorkbenchSceneOwner;
  readonly surfaceId: string;
  readonly panelId: PanelId;
  readonly children?: ReactNode;
}) {
  const port = useWorkbenchNewTabPort();
  const context = port?.resolveOwnerContext(owner, panelId) ?? null;
  if (!port || !context) {
    return (
      <div className="@container h-full overflow-y-auto px-panel py-8 select-none">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-10">{children}</div>
      </div>
    );
  }
  const open = (intent: WorkbenchNewTabIntent) => {
    void port.open({ owner, surfaceId, intent });
  };
  const layout = resolveNewTabToolLayout(context.actions, {
    hasChat: context.canReturnToChat,
    hasShortcut: (action) =>
      resolvePanelActionShortcutLabel(action, port.isMac, port.commandKeymapState) !== null,
  });
  return (
    <WorkbenchNewTabPage
      layout={layout}
      isMac={port.isMac}
      commandKeymapState={port.commandKeymapState}
      projects={port.projects}
      currentProjectId={context.currentProjectId}
      onSelectChat={context.canReturnToChat ? () => open({ kind: "chat" }) : null}
      onSelectAction={(action) => open({ kind: "action", action })}
      onOpenDestination={(destination) => open({ kind: "destination", destination })}
      bottomTerminal={
        context.canOpenBottomTerminal
          ? {
              shortcut:
                formatCommandShortcutLabel(port.commandKeymapState, "toggleBottomPanel") ?? null,
              onOpen: () => void port.openBottomTerminal(owner),
            }
          : null
      }
      onOpenRecent={(item) =>
        open({ kind: "library-target", target: item.target, title: item.title })
      }
    >
      {children}
    </WorkbenchNewTabPage>
  );
}
