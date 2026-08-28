import {
  useCallback,
  useDeferredValue,
  useEffect,
  forwardRef,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  FilterIcon,
  DatabaseIcon,
  SidePanelSideChatIcon,
  SidebarVisibleIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  areCommandPalettePageFiltersEqual,
  cloneCommandPalettePageFilters,
  filterCommandPaletteItems,
  hasActiveCommandPalettePageFilters,
  normalizeCommandPalettePageFilters,
  readCommandPalettePageFilters,
  type CommandMenuMode,
  type CommandPalettePage,
  type CommandPalettePageFilters,
  type CommandPaletteCommandGroup,
  type CommandPaletteCommand,
  type CommandPaletteThread,
  writeCommandPalettePageFilters,
} from "../../lib/command-palette";
import { type CommandPaletteHighlightSegment } from "../../lib/command-palette-highlight";
import type { CommandPaletteThreadSearchIndex } from "../../lib/command-palette-thread-search";
import {
  selectCommandPaletteChatResults,
  getCommandPaletteThreadSearchPlan,
  type CommandPaletteThreadSearchBatch,
  useCommandPaletteThreadSearch,
} from "../../lib/command-palette-chat-search";
import {
  buildCommandPalettePageSearchScopeKey,
  getCommandPalettePageSearchError,
  getCommandPalettePageSearchPlan,
  isCommandPalettePageSearchPending,
  normalizeCommandPaletteSearchText,
  pageSearchFacetOptions,
  selectCommandPalettePageResults,
  toCorePageSearchFilters,
  type CommandPalettePageSearchBatch,
  useCommandPalettePageSearch,
  useCommandPalettePageSearchFacets,
} from "../../lib/command-palette-page-results";
import { resolveQueryFreshAccept } from "../../lib/query-fresh-picker";
import { cn } from "../../lib/utils";
import { ProjectMarker } from "./project-marker";
import { CommandMenuReferenceIcon } from "./command-menu-reference-icons";
import {
  CommandPalettePageFilterPopover,
  CommandPalettePageFiltersSummaryRow,
} from "./command-palette-filters";
import { ThreadsIcon } from "./threads-icon";
import { NodexIconButton } from "@/components/ui/button";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import {
  NAVIGATE_BACK_COMMAND_ID,
  NAVIGATE_FORWARD_COMMAND_ID,
  RENAME_THREAD_COMMAND_ID,
  TOGGLE_SIDEBAR_COMMAND_ID,
} from "../../../shared/window-navigation";
import { OPEN_DB_VIEW_TAB_COMMAND_ID } from "@/lib/command-palette-commands";
import type { Project } from "@/lib/types";

type PaletteItem = CommandPaletteCommand | CommandPalettePage | CommandPaletteThread;
type PaletteSectionModel = { title: string; items: PaletteItem[] };

interface CommandPaletteSurfaceProps {
  open: boolean;
  openTriggerTick: number;
  mode: CommandMenuMode;
  initialQuery?: string;
  commands: readonly CommandPaletteCommand[];
  pages?: readonly CommandPalettePage[];
  projects?: readonly Project[];
  activeProjectId?: string | null;
  recentPageIds?: readonly string[];
  threads?: readonly CommandPaletteThread[];
  threadSearchIndex?: CommandPaletteThreadSearchIndex | null;
  pageSearchBatch?: CommandPalettePageSearchBatch;
  loading: boolean;
  pagesLoading: boolean;
  chatsLoading: boolean;
  threadSearchBatch?: CommandPaletteThreadSearchBatch;
  onChangeMode: (mode: CommandMenuMode) => void;
  onRequestClose: () => void;
  onExecute: (item: PaletteItem) => void;
}

export interface CommandPaletteSurfaceHandle {
  /** Clears the active query and reports whether this Escape should keep the palette open. */
  consumeEscape: () => boolean;
}

const EMPTY_PALETTE_PAGES: readonly CommandPalettePage[] = [];
const EMPTY_PALETTE_PROJECTS: readonly Project[] = [];
const EMPTY_RECENT_PAGE_IDS: readonly string[] = [];
const EMPTY_PALETTE_THREADS: readonly CommandPaletteThread[] = [];

const COMMAND_GROUP_ORDER: CommandPaletteCommandGroup[] = [
  "Suggested",
  "Chat",
  "Navigation",
  "Panels",
  "Project",
  "Configure",
  "Skills",
  "App",
];
const ROOT_DISCOVERY_ROW_BUDGET = 7;

function getPaletteItemDomId(listId: string, index: number): string {
  return `${listId}-item-${index}`;
}

function isPaletteItemDisabled(item: PaletteItem | undefined): boolean {
  return item?.kind === "command" && item.disabled === true;
}

function getModePlaceholder(mode: CommandMenuMode): string {
  if (mode === "chats") return "Search chats";
  if (mode === "pages") return "Search pages";
  if (mode === "files") return "Search files";
  return "Search chats and Pages, or run a command";
}

function getEmptyMessage(mode: CommandMenuMode, query: string, loading: boolean): string {
  if (loading) {
    if (mode === "chats") return "Loading chats...";
    if (mode === "pages") return "Loading pages...";
    if (mode === "files") return "Loading files...";
    return "Loading commands...";
  }

  if (mode === "chats") return query.length > 0 ? "No matching chats." : "No chats.";
  if (mode === "pages") return query.length > 0 ? "No matching pages." : "No pages.";
  if (mode === "files") return "File search is not available in Nodex yet.";
  return "No matching results.";
}

function resolveSelectableIndex(
  items: readonly PaletteItem[],
  preferredIndex: number,
  direction: -1 | 1,
): number {
  if (items.length === 0) return -1;

  const startIndex = ((preferredIndex % items.length) + items.length) % items.length;
  for (let step = 0; step < items.length; step += 1) {
    const nextIndex = (startIndex + direction * step + items.length) % items.length;
    if (!isPaletteItemDisabled(items[nextIndex])) {
      return nextIndex;
    }
  }

  return -1;
}

interface CommandPaletteSectionsInput {
  query: string;
  mode: CommandMenuMode;
  commands: readonly CommandPaletteCommand[];
  pages: readonly CommandPalettePage[];
  projects: readonly Project[];
  activeProjectId: string | null;
  recentPageIds: readonly string[];
  threads: readonly CommandPaletteThread[];
  threadSearchIndex?: CommandPaletteThreadSearchIndex | null;
  pageSearchBatch?: CommandPalettePageSearchBatch | null;
  pageSearchScopeKey?: string | null;
  threadSearchBatch?: CommandPaletteThreadSearchBatch | null;
}

interface CommandPaletteSectionsModel {
  query: string;
  sections: PaletteSectionModel[];
  flatItems: PaletteItem[];
  pageSearchError: string | null;
  pageSearchPending: boolean;
  showPageSearchStatus: boolean;
  showThreadSearchStatus: boolean;
  threadSearchError: string | null;
  threadSearchPending: boolean;
}

function buildCommandPaletteSectionsModel({
  query,
  mode,
  commands,
  pages,
  projects,
  activeProjectId,
  recentPageIds,
  threads,
  threadSearchIndex,
  pageSearchBatch,
  pageSearchScopeKey,
  threadSearchBatch,
}: CommandPaletteSectionsInput): CommandPaletteSectionsModel {
  const results = filterCommandPaletteItems({
    query,
    mode,
    commands,
    pages,
    threads,
    threadSearchIndex,
  });

  const visiblePages = selectCommandPalettePageResults({
    query,
    projects,
    activeProjectId,
    recentPageIds,
    pages,
    pageSearchBatch,
    pageSearchScopeKey,
    mergedPageLimit: mode === "root" ? ROOT_DISCOVERY_ROW_BUDGET : undefined,
  });
  const threadSearchPlan = getCommandPaletteThreadSearchPlan(mode, query);
  const normalizedQuery = normalizeCommandPaletteSearchText(query);
  const currentThreadSearchBatch =
    threadSearchBatch &&
    normalizeCommandPaletteSearchText(threadSearchBatch.query) === normalizedQuery
      ? threadSearchBatch
      : null;
  const threadSearchPending = Boolean(
    threadSearchPlan?.includeContentResults &&
    (!currentThreadSearchBatch || currentThreadSearchBatch.loading),
  );
  const threadSearchError = threadSearchPlan?.includeContentResults
    ? (currentThreadSearchBatch?.error ?? null)
    : null;
  const visibleThreads = threadSearchPlan
    ? selectCommandPaletteChatResults({
        query,
        threads,
        threadSearchIndex,
        threadSearchBatch,
        threadLimit: Math.max(threadSearchPlan.maxResults - (threadSearchPending ? 1 : 0), 0),
      })
    : [];
  const pageSearchPlan = getCommandPalettePageSearchPlan(mode, query);
  const pageSearchPending = isCommandPalettePageSearchPending({
    batch: pageSearchBatch,
    enabled: pageSearchPlan !== null,
    query,
    scopeKey: pageSearchScopeKey ?? "",
  });
  const pageSearchError = getCommandPalettePageSearchError({
    batch: pageSearchBatch,
    query,
    scopeKey: pageSearchScopeKey ?? "",
  });
  let showPageSearchStatus = false;
  const sections: PaletteSectionModel[] = (() => {
    if (mode === "root") {
      const commandSections = COMMAND_GROUP_ORDER.map((title) => ({
        title,
        items: results.commands.filter((item) => item.group === title),
      })).filter((section) => section.items.length > 0);
      const sectionsWithChats =
        visibleThreads.length > 0
          ? [...commandSections, { title: "Chats", items: visibleThreads }]
          : commandSections;
      if (!pageSearchPlan || threadSearchPending) return sectionsWithChats;

      const threadStatusRows = threadSearchPending || threadSearchError ? 1 : 0;
      const remainingRows = Math.max(
        ROOT_DISCOVERY_ROW_BUDGET -
          results.commands.length -
          visibleThreads.length -
          threadStatusRows,
        0,
      );
      showPageSearchStatus = remainingRows > 0 && (pageSearchPending || pageSearchError !== null);
      const pageCapacity = Math.max(remainingRows - (showPageSearchStatus ? 1 : 0), 0);
      const rootPages = visiblePages.slice(0, pageCapacity);
      if (rootPages.length === 0) return sectionsWithChats;
      return [...sectionsWithChats, { title: "Pages", items: rootPages }];
    }

    if (mode === "chats") {
      return [{ title: "Chats", items: visibleThreads }];
    }

    if (mode === "pages") {
      showPageSearchStatus = pageSearchPending || pageSearchError !== null;
      return [{ title: "Pages", items: visiblePages }];
    }

    return [];
  })();

  return {
    query: results.query,
    sections,
    flatItems: sections.flatMap((section) => section.items),
    pageSearchError,
    pageSearchPending,
    showPageSearchStatus,
    showThreadSearchStatus: Boolean(
      threadSearchPlan?.includeContentResults && (threadSearchPending || threadSearchError),
    ),
    threadSearchError,
    threadSearchPending,
  };
}

function getCommandGlyph(id: string) {
  if (id === NAVIGATE_BACK_COMMAND_ID)
    return (props: { className?: string }) => <CommandMenuReferenceIcon name="search" {...props} />;
  if (id === NAVIGATE_FORWARD_COMMAND_ID)
    return (props: { className?: string }) => <CommandMenuReferenceIcon name="search" {...props} />;
  if (id === "newThread" || id === "newThreadInProject" || id === "quickChat")
    return (props: { className?: string }) => (
      <CommandMenuReferenceIcon name="compose" {...props} />
    );
  if (id === TOGGLE_SIDEBAR_COMMAND_ID) return SidebarVisibleIcon;
  if (id === RENAME_THREAD_COMMAND_ID)
    return (props: { className?: string }) => (
      <CommandMenuReferenceIcon name="compose" {...props} />
    );
  if (id === "archiveThread")
    return (props: { className?: string }) => (
      <CommandMenuReferenceIcon name="archive" {...props} />
    );
  if (id === "toggleThreadPin")
    return (props: { className?: string }) => <CommandMenuReferenceIcon name="pin" {...props} />;
  if (id === "openThreadInNewWindow")
    return (props: { className?: string }) => <CommandMenuReferenceIcon name="search" {...props} />;
  if (id === "toggleFileTreePanel" || id === "openFolder" || id === "searchFiles")
    return (props: { className?: string }) => <CommandMenuReferenceIcon name="folder" {...props} />;
  if (id === "openBrowserTab" || id === "focusBrowserAddressBar")
    return (props: { className?: string }) => <CommandMenuReferenceIcon name="globe" {...props} />;
  if (id === "toggleTerminal" || id === "installPrimaryRuntime")
    return (props: { className?: string }) => (
      <CommandMenuReferenceIcon name="terminal" {...props} />
    );
  if (id === "searchChats" || id === "searchPages" || id === "findInThread")
    return (props: { className?: string }) => <CommandMenuReferenceIcon name="search" {...props} />;
  if (id === OPEN_DB_VIEW_TAB_COMMAND_ID) return DatabaseIcon;
  if (id === "openSideChat") return SidePanelSideChatIcon;
  if (id === "settings" || id === "showKeyboardShortcuts" || id.endsWith("Settings"))
    return (props: { className?: string }) => (
      <CommandMenuReferenceIcon name="settings" {...props} />
    );
  if (id === "openAvatarOverlay" || id === "tuckAwayPetOverlay" || id === "personalitySettings")
    return (props: { className?: string }) => <CommandMenuReferenceIcon name="avatar" {...props} />;
  return (props: { className?: string }) => <CommandMenuReferenceIcon name="search" {...props} />;
}

function CommandRow({
  item,
  selected,
  showSubtitle,
}: {
  item: CommandPaletteCommand;
  selected: boolean;
  showSubtitle: boolean;
}) {
  const Glyph = getCommandGlyph(item.id);
  const subtitle = item.disabledReason ?? item.mockReason ?? item.subtitle;
  const isMock = Boolean(item.mockReason);
  const displaySubtitle = showSubtitle || Boolean(item.disabledReason);

  return (
    <div className={cn("flex w-full gap-2", displaySubtitle ? "items-start" : "items-center")}>
      <Glyph
        className={cn(
          "size-4 shrink-0 text-token-description-foreground",
          selected && "text-token-foreground",
          displaySubtitle && "mt-0.5",
        )}
      />
      <div className="min-w-0 flex-1 leading-tight">
        <div className="flex min-w-0 items-center gap-1.5">
          <div className="min-w-0 truncate text-token-foreground">
            {item.searchTitleSegments
              ? renderSegments(item.searchTitleSegments, `${item.id}:title`)
              : item.title}
          </div>
          {isMock ? (
            <NodexTooltip tooltipContent={item.mockReason}>
              <span className="inline-flex h-4 shrink-0 items-center rounded-sm bg-token-foreground/5 px-1 text-[10px] font-medium uppercase leading-none text-token-description-foreground">
                Mock
              </span>
            </NodexTooltip>
          ) : null}
        </div>
        {displaySubtitle ? (
          <div className="mt-0.5 truncate text-xs text-token-description-foreground">
            {subtitle}
          </div>
        ) : null}
      </div>
      {item.shortcut ? <ShortcutKeycaps keys={[item.shortcut]} density="compact" /> : null}
    </div>
  );
}

function formatThreadDate(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "";
  }

  const ms = timestamp > 10_000_000_000 ? timestamp : timestamp * 1000;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
  }).format(new Date(ms));
}

function getCwdLabel(cwd: string | null): string {
  if (!cwd) return "";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? cwd;
}

function renderSegments(segments: Array<CommandPaletteHighlightSegment>, keyPrefix: string) {
  return segments.map((segment, index) => (
    <span
      key={`${keyPrefix}:${index}`}
      className={
        segment.highlight
          ? "font-medium text-token-foreground"
          : "text-token-description-foreground/75"
      }
    >
      {segment.text}
    </span>
  ));
}

function PageRow({
  compact,
  item,
  selected,
  showSubtitle,
}: {
  compact: boolean;
  item: CommandPalettePage;
  selected: boolean;
  showSubtitle: boolean;
}) {
  const hasPreview = Boolean(item.searchPreview);
  const decorations = item.searchDecorations;
  return (
    <div className={cn("flex w-full gap-2", hasPreview ? "items-start" : "items-center")}>
      <div
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-lg bg-token-foreground/5",
          selected && "bg-token-foreground/10 text-token-foreground",
          hasPreview && "mt-0.5",
        )}
      >
        <ProjectMarker appearance={item.projectAppearance} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2 text-token-foreground">
          {item.page.pageKey ? (
            <span className="shrink-0 text-xs font-medium tabular-nums text-token-description-foreground">
              {decorations?.pageKeySegments
                ? renderSegments(decorations.pageKeySegments, `${item.id}:page-key`)
                : item.page.pageKey}
            </span>
          ) : null}
          <span className="min-w-0 truncate">
            {decorations?.titleSegments
              ? renderSegments(decorations.titleSegments, `${item.id}:title`)
              : item.page.title || "Untitled"}
          </span>
          {item.pageKeyMatch && !item.pageKeyMatch.isCurrent ? (
            <span className="shrink-0 text-[11px] tabular-nums text-token-description-foreground">
              Matched {item.pageKeyMatch.matchedPageKey}
            </span>
          ) : null}
        </div>
        {showSubtitle ? (
          <div className="truncate text-xs text-token-description-foreground">
            {decorations?.projectNameSegments
              ? renderSegments(decorations.projectNameSegments, `${item.id}:project`)
              : item.projectName}
            {" / "}
            {decorations?.columnNameSegments
              ? renderSegments(decorations.columnNameSegments, `${item.id}:column`)
              : item.columnName}
            {item.recentIndex !== null ? " / Recent" : ""}
          </div>
        ) : null}
        {!compact && decorations && decorations.badges.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {decorations.badges.map((badge) => (
              <span
                key={`${item.id}:badge:${badge.id}`}
                className={cn(
                  "inline-flex items-center gap-1 rounded-md bg-token-foreground/5 px-1.5 py-0.5 text-[11px] leading-none text-token-description-foreground",
                  badge.tone === "monospace" && "font-mono",
                )}
              >
                <span className="text-token-description-foreground/80">{badge.label}</span>
                <span className={badge.tone === "monospace" ? "font-mono" : undefined}>
                  {renderSegments(badge.segments, `${item.id}:badge:${badge.id}`)}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        {item.searchPreview ? (
          <div
            className={cn(
              "mt-1 text-xs/relaxed wrap-break-word text-token-description-foreground/90",
              compact ? "line-clamp-1" : "line-clamp-3",
            )}
          >
            {renderSegments(item.searchPreview.segments, `${item.id}:preview`)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThreadRow({ item, selected }: { item: CommandPaletteThread; selected: boolean }) {
  const hasPreview = Boolean(item.searchPreview);
  const decorations = item.searchDecorations;
  const cwdLabel = getCwdLabel(item.cwd);
  const updatedLabel = formatThreadDate(item.updatedAt);
  const projectLabel = item.projectName ?? "Chats";

  return (
    <div className={cn("flex w-full gap-2", hasPreview ? "items-start" : "items-center")}>
      <div
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-lg bg-token-foreground/5 text-token-description-foreground",
          selected && "bg-token-foreground/10 text-token-foreground",
          hasPreview && "mt-0.5",
        )}
      >
        <ThreadsIcon className="size-3.5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-token-foreground">
          {decorations?.titleSegments
            ? renderSegments(decorations.titleSegments, `${item.id}:title`)
            : item.title || "New chat"}
        </div>
        <div className="truncate text-xs text-token-description-foreground">
          {decorations?.projectNameSegments
            ? renderSegments(decorations.projectNameSegments, `${item.id}:project`)
            : projectLabel}
          {cwdLabel ? (
            <>
              {" / "}
              {decorations?.cwdSegments
                ? renderSegments(decorations.cwdSegments, `${item.id}:cwd`)
                : cwdLabel}
            </>
          ) : null}
          {item.gitBranch ? (
            <>
              {" / "}
              {decorations?.gitBranchSegments
                ? renderSegments(decorations.gitBranchSegments, `${item.id}:branch`)
                : item.gitBranch}
            </>
          ) : null}
          {updatedLabel ? ` / ${updatedLabel}` : ""}
        </div>
        {item.searchPreview ? (
          <div className="mt-1 line-clamp-2 text-xs/relaxed wrap-break-word text-token-description-foreground/90">
            {renderSegments(item.searchPreview.segments, `${item.id}:preview`)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PaletteSection({
  compactPages,
  title,
  items,
  listId,
  selectedIndex,
  startIndex,
  onSelectIndex,
  onExecute,
  showSubtitle,
}: {
  compactPages: boolean;
  title: string;
  items: PaletteItem[];
  listId: string;
  selectedIndex: number;
  startIndex: number;
  onSelectIndex: (index: number) => void;
  onExecute: (item: PaletteItem) => void;
  showSubtitle: boolean;
}) {
  if (items.length === 0) return null;

  return (
    <section
      cmdk-group=""
      role="presentation"
      className="flex flex-col gap-[var(--spacing)]"
      data-value={title}
    >
      <div cmdk-group-heading="" aria-hidden="true">
        <span className="block px-2 pt-2 text-sm text-token-description-foreground">{title}</span>
      </div>
      <div cmdk-group-items="" role="group" aria-label={title}>
        {items.map((item, offset) => {
          const index = startIndex + offset;
          const selected = index === selectedIndex;
          return (
            <button
              id={getPaletteItemDomId(listId, index)}
              key={item.id}
              type="button"
              role="option"
              cmdk-item=""
              data-palette-index={index}
              data-selected={selected}
              aria-selected={selected}
              aria-disabled={item.kind === "command" && item.disabled ? "true" : undefined}
              onMouseMove={() => onSelectIndex(index)}
              onClick={() => onExecute(item)}
              disabled={item.kind === "command" && item.disabled}
              className={cn(
                "flex min-h-[calc(var(--spacing)*6)] w-full cursor-interaction rounded-lg px-[var(--padding-row-x)] py-[var(--padding-row-y)] text-left text-sm text-token-foreground opacity-75 outline-none",
                (item.kind === "page" || item.kind === "thread") &&
                  item.searchPreview &&
                  "py-[calc(var(--padding-row-y)+2px)]",
                item.kind === "command" && item.disabled
                  ? "cursor-not-allowed opacity-40 hover:bg-transparent hover:opacity-40"
                  : selected
                    ? "bg-token-list-hover-background opacity-100"
                    : "hover:bg-token-list-hover-background hover:opacity-100",
              )}
            >
              {item.kind === "command" ? (
                <CommandRow item={item} selected={selected} showSubtitle={showSubtitle} />
              ) : item.kind === "page" ? (
                <PageRow
                  compact={compactPages}
                  item={item}
                  selected={selected}
                  showSubtitle={showSubtitle}
                />
              ) : (
                <ThreadRow item={item} selected={selected} />
              )}
            </button>
          );
        })}
      </div>
    </section>
  );
}

function SearchStatusRow({ children }: { children: string }) {
  return (
    <div
      className="flex min-h-[calc(var(--spacing)*8)] items-center px-[calc(var(--spacing)*2.5)] py-[calc(var(--spacing)*1.5)] text-sm text-token-description-foreground"
      role="status"
    >
      {children}
    </div>
  );
}

export const CommandPaletteSurface = forwardRef<
  CommandPaletteSurfaceHandle,
  CommandPaletteSurfaceProps
>(function CommandPaletteSurface(
  {
    open,
    openTriggerTick,
    mode,
    initialQuery,
    commands,
    pages = EMPTY_PALETTE_PAGES,
    projects = EMPTY_PALETTE_PROJECTS,
    activeProjectId = null,
    recentPageIds = EMPTY_RECENT_PAGE_IDS,
    threads = EMPTY_PALETTE_THREADS,
    threadSearchIndex,
    pageSearchBatch: injectedPageSearchBatch,
    loading,
    pagesLoading,
    chatsLoading,
    threadSearchBatch: injectedThreadSearchBatch,
    onChangeMode,
    onRequestClose,
    onExecute,
  },
  forwardedRef,
) {
  const inputId = useId();
  const labelId = useId();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const previousModeRef = useRef<CommandMenuMode>(mode);
  const [query, setQuery] = useState("");
  const [pageFilters, setPageFilters] = useState<CommandPalettePageFilters>(() =>
    readCommandPalettePageFilters(),
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);

  useImperativeHandle(
    forwardedRef,
    () => ({
      consumeEscape: () => {
        if (query.trim().length === 0) return false;
        setQuery("");
        return true;
      },
    }),
    [query],
  );

  const threadSearchPlan = getCommandPaletteThreadSearchPlan(mode, deferredQuery);
  const fetchedThreadSearchBatch = useCommandPaletteThreadSearch({
    enabled: open && threadSearchPlan?.includeContentResults === true,
    query: deferredQuery,
    limit: threadSearchPlan?.maxResults ?? 9,
  });
  const threadSearchBatch = injectedThreadSearchBatch ?? fetchedThreadSearchBatch;
  const availableProjects = useMemo(
    () =>
      projects.length > 0
        ? projects.map((project) => ({ id: project.id, label: project.name || "Untitled" }))
        : Array.from(
            new Map(
              pages.map(
                (item) =>
                  [item.projectId, { id: item.projectId, label: item.projectName }] as const,
              ),
            ).values(),
          ),
    [pages, projects],
  );
  const allProjectIdsForSearch = useMemo(
    () => availableProjects.map((project) => project.id),
    [availableProjects],
  );
  const facetBatch = useCommandPalettePageSearchFacets({
    enabled: open && projects.length > 0,
    projectIds: allProjectIdsForSearch,
  });
  const availableTags = useMemo(() => {
    if (projects.length > 0) return pageSearchFacetOptions(facetBatch.facets);
    return Array.from(new Set(pages.flatMap((item) => item.tagLabels)))
      .sort((left, right) => left.localeCompare(right))
      .map((label) => ({ id: label, label, option: null }));
  }, [facetBatch.facets, pages, projects.length]);
  const availableAssignees = useMemo(
    () =>
      projects.length > 0
        ? [...facetBatch.facets.assignees]
        : Array.from(
            new Set(
              pages
                .map((item) => item.page.assignee?.trim() ?? "")
                .filter((value) => value.length > 0),
            ),
          ).sort((left, right) => left.localeCompare(right)),
    [facetBatch.facets.assignees, pages, projects.length],
  );
  const projectNameById = useMemo(
    () => new Map(availableProjects.map((project) => [project.id, project.label] as const)),
    [availableProjects],
  );
  const tagNameById = useMemo(
    () => new Map(availableTags.map((tag) => [tag.id, tag.label] as const)),
    [availableTags],
  );
  const normalizedPageFilters = useMemo(
    () =>
      normalizeCommandPalettePageFilters(pageFilters, {
        allowedTags:
          projects.length === 0 || facetBatch.status === "success"
            ? availableTags.map((tag) => tag.id)
            : undefined,
        allowedAssignees:
          projects.length === 0 || facetBatch.status === "success" ? availableAssignees : undefined,
        allowedProjectIds: availableProjects.map((project) => project.id),
      }),
    [
      availableAssignees,
      availableProjects,
      availableTags,
      facetBatch.status,
      pageFilters,
      projects.length,
    ],
  );
  const filteredProjectIdsForSearch = useMemo(() => {
    const allProjectIds = availableProjects.map((project) => project.id);
    if (normalizedPageFilters.projectIds.length === 0) {
      return allProjectIds;
    }

    const selectedProjectIds = new Set(normalizedPageFilters.projectIds);
    return allProjectIds.filter((projectId) => selectedProjectIds.has(projectId));
  }, [availableProjects, normalizedPageFilters.projectIds]);
  const pageSearchPlan = getCommandPalettePageSearchPlan(mode, query);
  const projectIdsForSearch =
    mode === "pages" ? filteredProjectIdsForSearch : allProjectIdsForSearch;
  const pageSearchScopeKey = useMemo(
    () => buildCommandPalettePageSearchScopeKey(projectIdsForSearch),
    [projectIdsForSearch],
  );
  const fetchedPageSearchBatch = useCommandPalettePageSearch({
    enabled: open && pageSearchPlan !== null,
    query,
    projectIds: projectIdsForSearch,
    filters: mode === "pages" ? toCorePageSearchFilters(normalizedPageFilters) : undefined,
    preferredProjectId: activeProjectId,
    recentPageIds,
    limit: pageSearchPlan?.searchLimit,
  });
  const pageSearchBatch = injectedPageSearchBatch ?? fetchedPageSearchBatch;
  const visibleModel = useMemo(
    () =>
      buildCommandPaletteSectionsModel({
        query,
        mode,
        commands,
        projects,
        activeProjectId,
        recentPageIds,
        pages,
        threads,
        threadSearchIndex,
        pageSearchBatch: pageSearchBatch,
        pageSearchScopeKey,
        threadSearchBatch,
      }),
    [
      pageSearchScopeKey,
      activeProjectId,
      pages,
      commands,
      query,
      pageSearchBatch,
      mode,
      projects,
      recentPageIds,
      threadSearchBatch,
      threadSearchIndex,
      threads,
    ],
  );
  const sections = visibleModel.sections;
  const flatItems = visibleModel.flatItems;
  const filterActive = hasActiveCommandPalettePageFilters(normalizedPageFilters);
  const showSubtitle = visibleModel.query.length > 0 || mode !== "root";
  const [selectedIndex, setSelectedIndex] = useState(0);

  useEffect(() => {
    if (!open) return;

    const nextQuery = initialQuery ?? "";
    setQuery(nextQuery);
    setFilterOpen(false);

    const rafId = window.requestAnimationFrame(() => {
      const input = inputRef.current;
      input?.focus();
      if (!input) {
        return;
      }

      if (nextQuery.length > 0) {
        input.setSelectionRange(nextQuery.length, nextQuery.length);
        return;
      }

      input.select();
    });

    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [initialQuery, open, openTriggerTick]);

  useEffect(() => {
    if (!open) {
      previousModeRef.current = mode;
      return;
    }

    if (previousModeRef.current === mode) return;
    previousModeRef.current = mode;
    setQuery(initialQuery ?? "");
    setSelectedIndex(0);
    setFilterOpen(false);
  }, [initialQuery, mode, open]);

  useEffect(() => {
    if (open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSelectedIndex(0);
  }, [mode, open, visibleModel.query]);

  useEffect(() => {
    if (mode === "pages") return;
    setFilterOpen(false);
  }, [mode]);

  useEffect(() => {
    if (areCommandPalettePageFiltersEqual(pageFilters, normalizedPageFilters)) {
      return;
    }

    setPageFilters(normalizedPageFilters);
  }, [pageFilters, normalizedPageFilters]);

  useEffect(() => {
    writeCommandPalettePageFilters(
      areCommandPalettePageFiltersEqual(pageFilters, normalizedPageFilters)
        ? pageFilters
        : normalizedPageFilters,
    );
  }, [pageFilters, normalizedPageFilters]);

  const buildFlatItemsForQuery = useCallback(
    (nextQuery: string): readonly PaletteItem[] =>
      buildCommandPaletteSectionsModel({
        query: nextQuery,
        mode,
        commands,
        projects,
        activeProjectId,
        recentPageIds,
        pages,
        threads,
        threadSearchIndex,
        pageSearchBatch: pageSearchBatch,
        pageSearchScopeKey,
        threadSearchBatch,
      }).flatItems,
    [
      pageSearchScopeKey,
      activeProjectId,
      pages,
      commands,
      pageSearchBatch,
      mode,
      projects,
      recentPageIds,
      threadSearchBatch,
      threadSearchIndex,
      threads,
    ],
  );
  const visibleRowsLoading =
    mode === "pages"
      ? pagesLoading || visibleModel.pageSearchPending
      : mode === "chats"
        ? chatsLoading || visibleModel.threadSearchPending
        : mode === "root"
          ? loading || visibleModel.threadSearchPending || visibleModel.pageSearchPending
          : loading;

  useEffect(() => {
    if (flatItems.length === 0) {
      if (selectedIndex === -1) return;
      setSelectedIndex(-1);
      return;
    }

    const preferredIndex = selectedIndex < 0 ? 0 : selectedIndex;
    const nextIndex = resolveSelectableIndex(flatItems, preferredIndex, 1);
    if (selectedIndex === nextIndex) return;
    setSelectedIndex(nextIndex);
  }, [flatItems, selectedIndex]);

  useEffect(() => {
    if (selectedIndex < 0) return;
    const next = scrollViewportRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${selectedIndex}"]`,
    );
    next?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  useEffect(() => {
    const list = scrollViewportRef.current;
    if (!list || typeof ResizeObserver === "undefined") return;

    const updateHeight = () => {
      list.style.setProperty("--cmdk-list-height", `${list.scrollHeight.toFixed(1)}px`);
    };
    updateHeight();

    const observer = new ResizeObserver(updateHeight);
    observer.observe(list);
    Array.from(list.children).forEach((child) => observer.observe(child));
    return () => observer.disconnect();
  }, [sections]);

  const handleExecute = useCallback(
    (item: PaletteItem) => {
      if (isPaletteItemDisabled(item)) return;
      if (item.kind === "command" && item.id === "searchChats") {
        onChangeMode("chats");
        return;
      }

      if (item.kind === "command" && item.id === "searchPages") {
        onChangeMode("pages");
        return;
      }

      if (item.kind === "command" && item.id === "searchFiles") {
        onChangeMode("files");
        return;
      }

      onRequestClose();
      onExecute(item);
    },
    [onChangeMode, onExecute, onRequestClose],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    const moveSelection = (direction: -1 | 1) => {
      if (flatItems.length === 0) return;
      const currentIndex = selectedIndex < 0 ? (direction > 0 ? -1 : 0) : selectedIndex;
      const nextIndex = resolveSelectableIndex(flatItems, currentIndex + direction, direction);
      if (nextIndex < 0) return;
      setSelectedIndex(nextIndex);
    };

    if (event.key === "ArrowDown" || (event.ctrlKey && (event.key === "j" || event.key === "n"))) {
      event.preventDefault();
      moveSelection(1);
      return;
    }

    if (event.key === "ArrowUp" || (event.ctrlKey && (event.key === "k" || event.key === "p"))) {
      event.preventDefault();
      moveSelection(-1);
      return;
    }

    if (event.key === "Home") {
      event.preventDefault();
      if (flatItems.length === 0) return;
      setSelectedIndex(resolveSelectableIndex(flatItems, 0, 1));
      return;
    }

    if (event.key === "End") {
      event.preventDefault();
      if (flatItems.length === 0) return;
      setSelectedIndex(resolveSelectableIndex(flatItems, flatItems.length - 1, -1));
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      const result = resolveQueryFreshAccept({
        liveQuery: query,
        rowsQuery: query,
        rows: flatItems,
        focusedIndex: selectedIndex,
        buildFreshRows: buildFlatItemsForQuery,
        getRowId: (item) => item.id,
        isRowAcceptable: (item) => !isPaletteItemDisabled(item),
        normalizeQuery: normalizeCommandPaletteSearchText,
      });
      if (result.status === "accepted") {
        handleExecute(result.row);
      }
      return;
    }

    if (event.key !== "Escape" || event.defaultPrevented || query.trim().length === 0) return;
    event.preventDefault();
    setQuery("");
  };
  const activeDescendantId =
    selectedIndex >= 0 && selectedIndex < flatItems.length
      ? getPaletteItemDomId(listId, selectedIndex)
      : undefined;
  const showThreadSearchStatus = visibleModel.showThreadSearchStatus;
  const showPageSearchStatus = visibleModel.showPageSearchStatus;
  const hasVisibleSearchStatus = showThreadSearchStatus || showPageSearchStatus;

  return (
    <div
      cmdk-root=""
      data-cmdk-root
      className="flex min-w-full select-none flex-col gap-1.25 overflow-hidden rounded-2xl border border-transparent bg-token-dropdown-background px-1.25 py-[calc(var(--spacing)*1.15)] text-sm text-token-foreground shadow-2xl"
    >
      <label
        cmdk-label=""
        htmlFor={inputId}
        id={labelId}
        style={{
          position: "absolute",
          width: "1px",
          height: "1px",
          padding: 0,
          margin: "-1px",
          overflow: "hidden",
          clip: "rect(0px, 0px, 0px, 0px)",
          whiteSpace: "nowrap",
          borderWidth: 0,
        }}
      >
        Command menu
      </label>
      <div className="flex items-center gap-1.5 px-[calc(var(--spacing)*2.2)]">
        <input
          ref={inputRef}
          cmdk-input=""
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          aria-autocomplete="list"
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={activeDescendantId}
          aria-labelledby={labelId}
          id={inputId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={getModePlaceholder(mode)}
          aria-label="Command palette search"
          className="w-full border-none bg-transparent px-[calc(var(--spacing)*0.55)] py-[calc(var(--spacing)*1.75)] text-base text-token-foreground outline-none placeholder:text-token-description-foreground"
        />

        {mode === "pages" ? (
          <CommandPalettePageFilterPopover
            open={filterOpen}
            onOpenChange={setFilterOpen}
            finalFocus={inputRef}
            filters={pageFilters}
            availableTags={availableTags}
            availableAssignees={availableAssignees}
            availableProjects={availableProjects}
            disabled={false}
            onChange={(update) =>
              setPageFilters((prev) => update(cloneCommandPalettePageFilters(prev)))
            }
          >
            <NodexIconButton
              icon={FilterIcon}
              size="sm"
              active={filterActive}
              ariaLabel="Filter pages"
              title="Filter pages"
            />
          </CommandPalettePageFilterPopover>
        ) : null}
      </div>

      {mode === "pages" && filterActive ? (
        <div className="px-[calc(var(--spacing)*2.75)] pb-[calc(var(--spacing)*0.5)]">
          <CommandPalettePageFiltersSummaryRow
            filters={pageFilters}
            projectNameById={projectNameById}
            tagNameById={tagNameById}
            onOpenFilter={() => setFilterOpen(true)}
          />
        </div>
      ) : null}

      <div
        ref={scrollViewportRef}
        cmdk-list=""
        role="listbox"
        tabIndex={-1}
        aria-label="Suggestions"
        id={listId}
        aria-busy={visibleRowsLoading}
        className="scrollbar-token flex max-h-[min(440px,var(--cmdk-list-height,440px),75vh)] flex-col gap-[var(--spacing)] overflow-y-auto overscroll-contain transition-[max-height] duration-100"
      >
        {sections.map((section) => {
          const startIndex = sections
            .slice(0, sections.indexOf(section))
            .reduce((sum, candidate) => sum + candidate.items.length, 0);
          return (
            <PaletteSection
              key={section.title}
              compactPages={mode === "root"}
              title={section.title}
              items={section.items}
              listId={listId}
              selectedIndex={selectedIndex}
              startIndex={startIndex}
              onSelectIndex={setSelectedIndex}
              onExecute={handleExecute}
              showSubtitle={showSubtitle}
            />
          );
        })}
        {showThreadSearchStatus && visibleModel.threadSearchPending ? (
          <SearchStatusRow>Loading chats…</SearchStatusRow>
        ) : null}
        {showThreadSearchStatus && visibleModel.threadSearchError ? (
          <SearchStatusRow>
            Chat content search is unavailable. Local matches are still shown.
          </SearchStatusRow>
        ) : null}
        {showPageSearchStatus && visibleModel.pageSearchPending ? (
          <SearchStatusRow>Loading more Pages…</SearchStatusRow>
        ) : null}
        {showPageSearchStatus && visibleModel.pageSearchError ? (
          <SearchStatusRow>Full Page search is unavailable</SearchStatusRow>
        ) : null}
        {flatItems.length === 0 && !hasVisibleSearchStatus ? (
          <div
            data-cmdk-empty
            className="flex min-h-[calc(var(--spacing)*8)] items-center justify-center px-[calc(var(--spacing)*2.5)] py-[calc(var(--spacing)*1.5)] text-center text-sm text-token-description-foreground"
          >
            {getEmptyMessage(
              mode,
              visibleModel.query,
              mode === "chats" ? chatsLoading : mode === "pages" ? pagesLoading : loading,
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
});
