import { GitHubThreadTabChrome } from "./workbench-github-thread-tab";
import { gitHubThreadLabel } from "../../../shared/github-thread";
import { useIntl, type IntlShape } from "@/lib/i18n";
import { SkillCubeIcon } from "@/components/shared/icons/customize-action-icons";
import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from "react";
import {
  CanvasIcon,
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
import {
  BrowserNewTabList,
  type BrowserNewTabSuggestions,
} from "@/features/browser-sidebar/browser-new-tab-list";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import { StatusIcon } from "@/lib/status-presentation";
import type { PageSearchTextPart } from "@/lib/types";
import { readWorkbenchAgentContext } from "@/lib/workbench-agent-context";
import { resolveFileResourceIcon } from "@/components/shared/file-resource-icon";
import {
  getPanelNewTabAction,
  resolvePanelActionShortcutLabel,
} from "@/lib/workbench-panel-actions";
import { presentWorkbenchPanelTabTitle } from "@/lib/workbench-panel-tab-title";
import { presentSessionTitle } from "@/lib/session-title-presentation";
import { presentPageTitle } from "@/lib/page-title-projection-store";
import { useWorkbenchWindowOwner } from "@/lib/use-workbench-window-state";
import {
  formatNewTabRecentTime,
  isNewTabToolKind,
  resolveNewTabRecentsHeight,
} from "@/lib/workbench-new-tab-model";
import { useNewTabShortcutPreference } from "@/lib/workbench-new-tab-shortcuts";
import { useWorkbenchNewTabPort, type WorkbenchNewTabIntent } from "@/lib/workbench-new-tab-port";
import {
  PANEL_TOOL_KEYCAP_CLASS,
  TOOLBAR_BUTTON_BASE_CLASS,
  TOOLBAR_BUTTON_GHOST_CLASS,
} from "@/lib/workbench-toolbar-control-styles";
import type { PanelId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatCommandShortcutLabel } from "../../../shared/command-keybindings";
import type { LibraryRouteTarget } from "../../../shared/library-module";
import type { WorkbenchSurfaceReference } from "../../../shared/nodex-app-tools/workbench";
import type { WorkbenchSceneOwner } from "../../../shared/workbench-scene";
import { NEW_TAB_SECTION_HEADING_CLASS, NewTabOpenSection } from "./new-tab-open-section";
import {
  presentSpaceContentLocation,
  useSpaceContentResults,
  type SpaceContentItem,
} from "./space-content";

export interface WorkbenchNewTabPageProps {
  /** The page's search field: the Browser's address bar, which also finds tools, tabs and Space content. */
  readonly search: ReactNode;
  /** The search field's list: Recents before typing, matches while typing. */
  readonly suggestions: BrowserNewTabSuggestions;
  /** The `Open` section, when the New tab's Scene offers tools. */
  readonly open?: ReactNode;
  /** Sections between Open and Recents, such as local servers. */
  readonly children?: ReactNode;
}

/**
 * The page a New tab shows. The list under its search field is the field's own: before typing,
 * the tools pinned under `Open`, whatever else the tab can open, then Recents; while typing,
 * only what the query matches, in their place. Every choice takes the New tab's place.
 */
export function WorkbenchNewTabPage({
  search,
  suggestions,
  open,
  children,
}: WorkbenchNewTabPageProps) {
  const intl = useIntl();
  if (suggestions.query) {
    return (
      <NewTabPageColumn search={search} typing>
        <BrowserNewTabList
          suggestions={suggestions}
          aria-label={intl.formatMessage({
            id: "workbench.workbenchNewTabPage.results",
            defaultMessage: "Results",
          })}
        />
      </NewTabPageColumn>
    );
  }
  return (
    <NewTabPageColumn search={search}>
      {open}
      {children}
      <NewTabRecents suggestions={suggestions} />
    </NewTabPageColumn>
  );
}

/**
 * One narrow column, centered in the tab, that every New tab section shares. The search sits a
 * quarter of the way down; when the sections need the room, that space gives way first, down
 * to its minimum, so Recents keeps its rows. While typing, results sit right under the search.
 * The Browser panel hosting the page already ends above a floating composer, so the page needs
 * no clearance of its own.
 */
function NewTabPageColumn({
  search,
  typing = false,
  children,
}: {
  readonly search: ReactNode;
  readonly typing?: boolean;
  readonly children: ReactNode;
}) {
  const topSpaceRef = useRef<HTMLDivElement>(null);
  const typingRef = useRef(typing);
  const settledTopRef = useRef<number | null>(null);
  // The search stays where it was when typing began, however few results follow it: the space
  // above it keeps the height it settled at before typing, still giving way if the tab shrinks,
  // until the search is cleared.
  useLayoutEffect(() => {
    typingRef.current = typing;
    const topSpace = topSpaceRef.current;
    if (!topSpace) return undefined;
    if (typing && settledTopRef.current !== null) {
      topSpace.style.flex = `0 1 ${settledTopRef.current}px`;
      return undefined;
    }
    topSpace.style.removeProperty("flex");
    settledTopRef.current = topSpace.offsetHeight;
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(() => {
      if (!typingRef.current) settledTopRef.current = topSpace.offsetHeight;
    });
    observer.observe(topSpace);
    return () => observer.disconnect();
  }, [typing]);
  return (
    <div
      data-new-tab-scroll-root=""
      className="@container-size flex h-full min-h-0 flex-col overflow-x-hidden overflow-y-auto bg-token-main-surface-primary px-panel pb-8 select-none [scrollbar-gutter:stable_both-edges]"
    >
      <div
        ref={topSpaceRef}
        aria-hidden
        data-new-tab-top-space=""
        className="min-h-8 shrink basis-[25cqh]"
      />
      <div
        data-new-tab-column=""
        className={cn("mx-auto flex w-full max-w-xl shrink-0 flex-col", typing ? "gap-2" : "gap-8")}
      >
        {search}
        {children}
      </div>
    </div>
  );
}

export function NewTabSectionHeading({ children }: { readonly children: ReactNode }) {
  return <h3 className={NEW_TAB_SECTION_HEADING_CLASS}>{children}</h3>;
}

function NewTabRecents({ suggestions }: { readonly suggestions: BrowserNewTabSuggestions }) {
  const intl = useIntl();
  const listRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ top: true, bottom: true });
  const [interacted, setInteracted] = useState(false);

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

  if (suggestions.rows.length === 0) return null;

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

  const heading = intl.formatMessage({
    id: "workbench.workbenchNewTabPage.recents",
    defaultMessage: "Recents",
  });
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <NewTabSectionHeading>{heading}</NewTabSectionHeading>
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
      <BrowserNewTabList
        ref={attachList}
        suggestions={suggestions}
        aria-label={heading}
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
      />
    </section>
  );
}

function contentItemKey(target: LibraryRouteTarget): string {
  return `${target.kind}:${JSON.stringify(target)}`;
}

/** The Space content a tab shows, keyed the way search results name it. */
function openContentTarget(surface: WorkbenchSurfaceReference): LibraryRouteTarget | null {
  if (surface.kind === "page_stage") return { kind: "page", pageId: surface.config.pageId };
  if (surface.kind === "canvas_stage") {
    return { kind: "canvas", canvasId: surface.config.canvasBlockId };
  }
  if (surface.kind === "db_view" && surface.config.target.kind === "database-default") {
    return { kind: "database", databaseId: surface.config.target.databaseId };
  }
  return null;
}

/** A workflow Page shows its Status; other content shows its kind. */
function ContentGlyph({ item }: { readonly item: SpaceContentItem }) {
  if (item.target.kind === "page") {
    return item.status ? (
      <StatusIcon statusId={item.status.optionId} className="size-4" />
    ) : (
      <PageIcon className="icon-sm text-token-charts-blue" />
    );
  }
  if (item.target.kind === "canvas") {
    return <CanvasIcon className="icon-xs text-token-charts-orange" />;
  }
  return <BoardIcon className="icon-xs text-token-charts-green" />;
}

/** Matched text gains weight and full contrast; the rest keeps its line's colour. */
function MatchText({ parts }: { readonly parts: readonly PageSearchTextPart[] }) {
  let offset = 0;
  return parts.map(({ text, highlighted }) => {
    const start = offset;
    offset += text.length;
    return highlighted ? (
      <span key={start} className="font-medium text-token-text-primary">
        {text}
      </span>
    ) : (
      text
    );
  });
}

const hasHighlight = (parts: readonly PageSearchTextPart[] | undefined) =>
  parts?.some((part) => part.highlighted) === true;

/**
 * One Space content row. Its glyph and the first word of its second line always agree: a
 * Status for a workflow Page, otherwise Page, Database or Canvas. The rest of the line says
 * where it lives, or, when a query matched its content rather than its title, what matched.
 * A Page key appears only when the query matched it.
 */
function toContentOption(
  item: SpaceContentItem,
  { intl, now, onSelect }: { intl: IntlShape; now: Date; onSelect: () => void },
): BrowserAddressWorkspaceOption {
  const title = item.title.trim()
    ? item.title
    : intl.formatMessage({
        id: "workbench.workbenchNewTabPage.untitled",
        defaultMessage: "Untitled",
      });
  const matches = item.searchMatches ?? [];
  const keyMatch = matches.find((match) => match.source === "page_key");
  const titleParts =
    hasHighlight(item.titleParts) && item.titleParts?.map((part) => part.text).join("") === title
      ? item.titleParts
      : null;
  // An excerpt explains a match the title cannot.
  const excerptParts =
    hasHighlight(item.excerptParts) &&
    !matches.some(
      ({ source }) => source === "title" || source === "identity" || source === "page_key",
    )
      ? item.excerptParts
      : null;
  const lead =
    item.status?.label ??
    (item.target.kind === "page"
      ? intl.formatMessage({ id: "workbench.workbenchNewTabPage.page", defaultMessage: "Page" })
      : item.target.kind === "canvas"
        ? intl.formatMessage({
            id: "workbench.workbenchNewTabPage.canvas",
            defaultMessage: "Canvas",
          })
        : intl.formatMessage({
            id: "workbench.workbenchNewTabPage.database",
            defaultMessage: "Database",
          }));
  // Every Space resource names where it lives; the top level reads as Space.
  const context = excerptParts ? (
    <MatchText parts={excerptParts} />
  ) : (
    presentSpaceContentLocation(item, intl)
  );
  const updatedAt = item.updatedAt ? new Date(item.updatedAt) : null;
  return {
    id: `content:${contentItemKey(item.target)}`,
    kind: "content",
    title,
    pageMatches: item.searchMatches,
    icon: <ContentGlyph item={item} />,
    label:
      keyMatch || titleParts ? (
        <>
          {keyMatch ? (
            <>
              <span className="text-token-text-secondary tabular-nums">
                <MatchText parts={keyMatch.parts} />
              </span>{" "}
            </>
          ) : null}
          {titleParts ? <MatchText parts={titleParts} /> : title}
        </>
      ) : undefined,
    detail: intl.formatMessage(
      {
        id: "workbench.workbenchNewTabPage.locationSubtitle",
        defaultMessage: "{kind} · {location}",
      },
      { kind: lead, location: context },
    ),
    trailing:
      updatedAt && Number.isFinite(updatedAt.getTime()) ? (
        <time dateTime={item.updatedAt}>{formatNewTabRecentTime(updatedAt, now, intl.locale)}</time>
      ) : undefined,
    onSelect,
  };
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
        renderNewTabPage={({ search, suggestions, localServers }) => (
          <WorkbenchNewTabSurface
            owner={owner}
            surfaceId={surfaceId}
            panelId={panelId}
            search={search}
            suggestions={suggestions}
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

/**
 * What a New tab's search lists. An empty field suggests recent Space content. A draft matches
 * tools, other tabs in the Scene, and Space content that is not already open, with the current
 * Project's Pages ranked first. Candidates remain presentation data; the port owns every
 * accepted intent.
 */
export function useWorkbenchNewTabAddressSuggestions(
  query: string | null,
): readonly BrowserAddressWorkspaceOption[] {
  const intl = useIntl();
  const binding = useContext(WorkbenchNewTabAddressContext);
  const port = useWorkbenchNewTabPort();
  const windowOwner = useWorkbenchWindowOwner();
  // Edit times are relative to when the page appeared.
  const [now] = useState(() => new Date());
  const draft = query?.trim() ?? "";
  // Explicit web addresses do not compete with workspace destinations.
  const workspaceQuery = draft ? readBrowserAddressWorkspaceQuery(draft) : "";
  const active = binding !== null && query !== null && workspaceQuery !== null;
  // Every Browser tab mounts this hook; only a shown New tab reads Space content, and only a
  // draft observes the Scene for tabs, so loaded pages never rerender for window changes.
  const matchesTabs = active && draft !== "";
  const state = useSyncExternalStore(
    matchesTabs ? windowOwner.subscribe : subscribeToNothing,
    windowOwner.read,
  );
  const context = binding && port ? port.resolveOwnerContext(binding.owner, binding.panelId) : null;
  const results = useSpaceContentResults({
    query: workspaceQuery ?? "",
    preferredProjectId: context?.currentProjectId ?? null,
    enabled: active,
  });
  if (!port || !binding || !active) return [];
  const { owner, surfaceId } = binding;

  const open = (intent: WorkbenchNewTabIntent) => {
    void port.open({ owner, surfaceId, intent });
  };
  const contentOption = (item: SpaceContentItem) =>
    toContentOption(item, {
      intl,
      now,
      onSelect: () => open({ kind: "library-target", target: item.target, title: item.title }),
    });
  if (!draft) return results.items.map(contentOption);

  // The New tab's own tools; each runs directly when chosen.
  const tools = (context?.actions ?? [])
    .filter((action) => isNewTabToolKind(action.kind))
    .map((action): BrowserAddressWorkspaceOption => {
      const shortcut = resolvePanelActionShortcutLabel(action, port.isMac, port.commandKeymapState);
      return {
        id: `action:${action.kind}`,
        kind: "launch-action",
        title: action.label,
        icon: <action.Icon className="icon-xs" />,
        detail: intl.formatMessage({
          id: "workbench.workbenchNewTabPage.tool",
          defaultMessage: "Tool",
        }),
        trailing: shortcut ? (
          <ShortcutKeycaps aria-hidden keys={[shortcut]} className={PANEL_TOOL_KEYCAP_CLASS} />
        ) : undefined,
        onSelect: () => open({ kind: "action", action: action.kind }),
      };
    });
  const observation = readWorkbenchAgentContext(state, owner);
  const tabs = (observation?.tabs ?? [])
    .filter((tab) => tab.tabId !== surfaceId)
    .map((tab): BrowserAddressWorkspaceOption => {
      if (tab.surface?.kind === "github_thread") {
        const { config, titleSnapshot } = tab.surface;
        const location = gitHubThreadLabel(config.thread);
        return {
          id: `tab:${tab.tabId}`,
          kind: "switch-tab",
          title: titleSnapshot || location,
          label: (
            <GitHubThreadTabChrome
              config={config}
              titleSnapshot={titleSnapshot}
              render={(chrome) => chrome.title}
            />
          ),
          icon: (
            <GitHubThreadTabChrome
              config={config}
              titleSnapshot={titleSnapshot}
              render={(chrome) => chrome.iconElement}
            />
          ),
          detail: location,
          onSelect: () => open({ kind: "tab", tabId: tab.tabId }),
        };
      }
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
        detail: intl.formatMessage({
          id: "workbench.workbenchNewTabPage.switchToTab",
          defaultMessage: "Switch to tab",
        }),
        onSelect: () => open({ kind: "tab", tabId: tab.tabId }),
      };
    });
  // Content open in a tab is already offered as that tab.
  const openContent = new Set(
    observation?.tabs.flatMap((tab) => {
      const target = tab.surface ? openContentTarget(tab.surface) : null;
      return target ? [contentItemKey(target)] : [];
    }),
  );
  const content = results.items
    .filter((item) => !openContent.has(contentItemKey(item.target)))
    .map(contentOption);
  return [...tools, ...tabs, ...content];
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
  suggestions,
  children,
}: {
  readonly owner: WorkbenchSceneOwner;
  readonly surfaceId: string;
  readonly panelId: PanelId;
  readonly search: ReactNode;
  readonly suggestions: BrowserNewTabSuggestions;
  readonly children?: ReactNode;
}) {
  const port = useWorkbenchNewTabPort();
  const shortcuts = useNewTabShortcutPreference(panelId);
  const context = port?.resolveOwnerContext(owner, panelId) ?? null;
  const open = (intent: WorkbenchNewTabIntent) => {
    if (port) void port.open({ owner, surfaceId, intent });
  };
  return (
    <WorkbenchNewTabPage
      search={search}
      suggestions={suggestions}
      open={
        port && context ? (
          <NewTabOpenSection
            tools={context.actions}
            shortcuts={shortcuts}
            isMac={port.isMac}
            commandKeymapState={port.commandKeymapState}
            onSelectAction={(action) => open({ kind: "action", action })}
            bottomTerminal={
              context.canOpenBottomTerminal
                ? {
                    shortcut:
                      formatCommandShortcutLabel(port.commandKeymapState, "toggleBottomPanel") ??
                      null,
                    onOpen: () => void port.openBottomTerminal(owner),
                  }
                : null
            }
          />
        ) : null
      }
    >
      {children}
    </WorkbenchNewTabPage>
  );
}
