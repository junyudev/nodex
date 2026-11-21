import { useIntl, type IntlShape } from "@/lib/i18n";
import { SkillCubeIcon } from "@/components/shared/icons/customize-action-icons";
import {
  createContext,
  useContext,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  CanvasIcon,
  ClockIcon,
  ChevronDownIcon,
  BoardIcon,
  PageIcon,
  PluginsIcon,
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
import { resolveFileResourceIcon } from "@/components/shared/file-resource-icon";
import { getPanelNewTabAction } from "@/lib/workbench-panel-actions";
import { presentWorkbenchPanelTabTitle } from "@/lib/workbench-panel-tab-title";
import { presentSessionTitle } from "@/lib/session-title-presentation";
import { presentPageTitle } from "@/lib/page-title-projection-store";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import { NodexOverflowTooltip } from "@/components/ui/tooltip";
import { formatNewTabRecentTime, resolveNewTabRecentsHeight } from "@/lib/workbench-new-tab-model";
import { useNewTabShortcutPreference } from "@/lib/workbench-new-tab-shortcuts";
import { useWorkbenchNewTabPort, type WorkbenchNewTabIntent } from "@/lib/workbench-new-tab-port";
import {
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import type { PanelId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatCommandShortcutLabel } from "../../../shared/command-keybindings";
import type { LibraryRouteTarget } from "../../../shared/library-module";
import type { WorkbenchSceneOwner } from "../../../shared/workbench-scene";
import {
  NEW_TAB_SECTION_HEADING_CLASS,
  NewTabOpenSection,
  type NewTabOpenSectionProps,
} from "./new-tab-open-section";
import {
  DEFAULT_SPACE_CONTENT_DATA_SOURCE,
  presentSpaceContentLocation,
  useSpaceContentResults,
  type SpaceContentDataSource,
  type SpaceContentItem,
} from "./space-content";

export interface WorkbenchNewTabPageProps extends NewTabOpenSectionProps {
  /** The page's search field: the Browser's address bar, which also finds tools, tabs and Pages. */
  readonly search?: ReactNode;
  readonly onOpenRecent: (item: SpaceContentItem) => void;
  readonly recentsDataSource?: SpaceContentDataSource;
  /** Sections between Open and Recents, such as local servers. */
  readonly children?: ReactNode;
}

/**
 * The page a New tab shows: a search field, the tools pinned under `Open`, whatever else the
 * tab can open, then recent Space content. Every choice takes the New tab's place.
 */
export function WorkbenchNewTabPage({
  search,
  onOpenRecent,
  recentsDataSource = DEFAULT_SPACE_CONTENT_DATA_SOURCE,
  children,
  ...openSection
}: WorkbenchNewTabPageProps) {
  return (
    <NewTabPageColumn search={search}>
      <NewTabOpenSection {...openSection} />
      {children}
      <NewTabRecents dataSource={recentsDataSource} onOpen={onOpenRecent} />
    </NewTabPageColumn>
  );
}

/**
 * One narrow column, centered in the tab, that every New tab section shares. The search sits a
 * quarter of the way down; when the sections need the room, that space gives way first, down
 * to its minimum, so Recents keeps its rows. The Browser panel hosting the page already ends
 * above a floating composer, so the page needs no clearance of its own.
 */
function NewTabPageColumn({
  search,
  children,
}: {
  readonly search?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div
      data-new-tab-scroll-root=""
      className="@container-size flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-token-main-surface-primary px-panel pb-8 select-none [scrollbar-gutter:stable_both-edges]"
    >
      <div aria-hidden data-new-tab-top-space="" className="min-h-8 shrink basis-[25cqh]" />
      <div data-new-tab-column="" className="mx-auto flex w-full max-w-xl shrink-0 flex-col gap-8">
        {search}
        {children}
      </div>
    </div>
  );
}

export function NewTabSectionHeading({ children }: { readonly children: ReactNode }) {
  return <h3 className={NEW_TAB_SECTION_HEADING_CLASS}>{children}</h3>;
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
  const intl = useIntl();
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

  // The list takes the room below the sections above it, counting the space above the search
  // as room it may claim down to that space's minimum.
  const attachList = (list: HTMLUListElement | null) => {
    listRef.current = list;
    const root = list?.closest<HTMLElement>("[data-new-tab-scroll-root]");
    const column = list?.closest<HTMLElement>("[data-new-tab-column]");
    const topSpace = root?.querySelector<HTMLElement>("[data-new-tab-top-space]");
    if (!list || !root || !column || !topSpace || typeof ResizeObserver === "undefined") {
      return undefined;
    }
    const observer = new ResizeObserver(() => {
      const row = list.firstElementChild;
      if (!(row instanceof HTMLElement) || row.offsetHeight === 0) return;
      const rowHeight = row.offsetHeight;
      const scale =
        root.offsetHeight > 0 ? root.getBoundingClientRect().height / root.offsetHeight : 1;
      const sectionsAbove =
        (list.getBoundingClientRect().top - column.getBoundingClientRect().top) / (scale || 1);
      const rootStyle = getComputedStyle(root);
      const available =
        root.clientHeight -
        (Number.parseFloat(rootStyle.paddingTop) || 0) -
        (Number.parseFloat(rootStyle.paddingBottom) || 0) -
        (Number.parseFloat(getComputedStyle(topSpace).minHeight) || 0) -
        sectionsAbove;
      list.style.maxHeight = `${resolveNewTabRecentsHeight(available, rowHeight)}px`;
      list.style.setProperty("--recent-row-height", `${rowHeight}px`);
      measureEdges(list);
    });
    observer.observe(root);
    observer.observe(column);
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
        <NewTabSectionHeading>
          {intl.formatMessage({
            id: "workbench.workbenchNewTabPage.recents",
            defaultMessage: "Recents",
          })}
        </NewTabSectionHeading>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: "workbench.workbenchNewTabPage.scrollRecentsUp",
              defaultMessage: "Scroll recents up",
            })}
            disabled={edges.top}
            className={cn(TOOLBAR_BUTTON_BASE_CLASS, TOOLBAR_BUTTON_GHOST_CLASS)}
            onClick={() => scrollByRows(-1)}
          >
            <ChevronDownIcon className="icon-xs rotate-180" />
          </button>
          <button
            type="button"
            aria-label={intl.formatMessage({
              id: "workbench.workbenchNewTabPage.scrollRecentsDown",
              defaultMessage: "Scroll recents down",
            })}
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
        aria-label={intl.formatMessage({
          id: "workbench.workbenchNewTabPage.recentPages",
          defaultMessage: "Recent pages",
        })}
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
            <NodexOverflowTooltip
              content={
                item.title.trim() ||
                intl.formatMessage({
                  id: "workbench.workbenchNewTabPage.untitled",
                  defaultMessage: "Untitled",
                })
              }
            >
              <button
                type="button"
                aria-label={
                  item.title.trim() ||
                  intl.formatMessage({
                    id: "workbench.workbenchNewTabPage.untitled",
                    defaultMessage: "Untitled",
                  })
                }
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
                    {item.title.trim() ||
                      intl.formatMessage({
                        id: "workbench.workbenchNewTabPage.untitled",
                        defaultMessage: "Untitled",
                      })}
                  </span>
                  <span className="block truncate text-xs text-token-text-secondary">
                    {recentSubtitle(item, intl)}
                  </span>
                </span>
                {item.updatedAt ? (
                  <time
                    className="shrink-0 text-xs whitespace-nowrap text-token-text-secondary tabular-nums"
                    dateTime={item.updatedAt}
                  >
                    {formatNewTabRecentTime(new Date(item.updatedAt), now, intl.locale)}
                  </time>
                ) : null}
              </button>
            </NodexOverflowTooltip>
          </li>
        ))}
      </ul>
    </section>
  );
}

function recentItemKey(target: LibraryRouteTarget): string {
  return `${target.kind}:${JSON.stringify(target)}`;
}

function recentSubtitle(item: SpaceContentItem, intl: IntlShape): string {
  const kind =
    item.target.kind === "page"
      ? intl.formatMessage({ id: "workbench.workbenchNewTabPage.page", defaultMessage: "Page" })
      : item.target.kind === "canvas"
        ? intl.formatMessage({
            id: "workbench.workbenchNewTabPage.canvas",
            defaultMessage: "Canvas",
          })
        : intl.formatMessage({
            id: "workbench.workbenchNewTabPage.database",
            defaultMessage: "Database",
          });
  return item.locationLabel
    ? intl.formatMessage(
        {
          id: "workbench.workbenchNewTabPage.locationSubtitle",
          defaultMessage: "{kind} · {location}",
        },
        { kind, location: presentSpaceContentLocation(item, intl) },
      )
    : kind;
}

function RecentGlyph({ target }: { readonly target: LibraryRouteTarget }) {
  if (target.kind === "page") return <PageIcon className="icon-sm text-token-charts-blue" />;
  if (target.kind === "canvas") return <CanvasIcon className="icon-xs text-token-charts-orange" />;
  return <BoardIcon className="icon-xs text-token-charts-green" />;
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
        renderNewTabPage={({ search, localServers }) => (
          <WorkbenchNewTabSurface
            owner={owner}
            surfaceId={surfaceId}
            panelId={panelId}
            search={search}
          >
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
  const intl = useIntl();
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
        tab.surface?.kind === "plugin_app"
          ? PluginsIcon
          : tab.surface?.kind === "skill"
            ? SkillCubeIcon
            : tab.surface?.kind === "page_file"
              ? resolveFileResourceIcon(tab.surface.config.logicalPath ?? tab.surface.titleSnapshot)
              : tab.surface &&
                  tab.surface.kind !== "conversation" &&
                  tab.surface.kind !== "inbox" &&
                  tab.surface.kind !== "image_editor"
                ? getPanelNewTabAction(tab.surface.kind).Icon
                : SidePanelSideChatIcon;
      return {
        id: `tab:${tab.tabId}`,
        kind: "switch-tab",
        title:
          tab.surface?.kind === "page_stage"
            ? presentPageTitle(tab.surface.titleSnapshot, intl)
            : tab.surface
              ? presentWorkbenchPanelTabTitle(tab.surface, tab.surface.titleSnapshot, intl, {
                  standardDatabaseTitle: owner.kind === "project",
                })
              : tab.auxiliary?.kind === "side_chat"
                ? presentSessionTitle(tab.auxiliary.title, intl)
                : (tab.auxiliary?.title ?? ""),
        icon: <Icon className="icon-xs" />,
        trailing: intl.formatMessage({
          id: "workbench.workbenchNewTabPage.switchToTab",
          defaultMessage: "Switch to tab",
        }),
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
    if (item.target.kind !== "page" || !item.searchMatches || openPageIds.has(item.target.pageId))
      return [];
    const updatedAt = Date.parse(item.updatedAt ?? catalogEditTimes.get(item.target.pageId) ?? "");
    return [
      {
        id: `page:${item.target.pageId}`,
        kind: "page",
        title: presentPageTitle(item.title, intl),
        pageMatches: item.searchMatches,
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
  search,
  children,
}: {
  readonly owner: WorkbenchSceneOwner;
  readonly surfaceId: string;
  readonly panelId: PanelId;
  readonly search?: ReactNode;
  readonly children?: ReactNode;
}) {
  const port = useWorkbenchNewTabPort();
  const shortcuts = useNewTabShortcutPreference(panelId);
  const context = port?.resolveOwnerContext(owner, panelId) ?? null;
  if (!port || !context) {
    return <NewTabPageColumn search={search}>{children}</NewTabPageColumn>;
  }
  const open = (intent: WorkbenchNewTabIntent) => {
    void port.open({ owner, surfaceId, intent });
  };
  return (
    <WorkbenchNewTabPage
      search={search}
      tools={context.actions}
      shortcuts={shortcuts}
      isMac={port.isMac}
      commandKeymapState={port.commandKeymapState}
      projects={port.projects}
      currentProjectId={context.currentProjectId}
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
