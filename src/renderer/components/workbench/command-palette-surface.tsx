import type { FileSearchScope } from "../../../shared/file-search";
import { useFileSearch } from "@/lib/use-file-search";
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
  PageIcon,
  FileIcon,
  FolderIcon,
  DatabaseIcon,
  SidePanelSideChatIcon,
  SidebarVisibleIcon,
} from "@/components/shared/icons";
import { NodexTooltip } from "@/components/ui/tooltip";
import {
  areCommandPalettePageFiltersEqual,
  cloneCommandPalettePageFilters,
  getCommandPaletteScopes,
  cycleCommandPaletteMode,
  hasActiveCommandPalettePageFilters,
  normalizeCommandPalettePageFilters,
  readCommandPalettePageFilters,
  type CommandMenuMode,
  type CommandPalettePage,
  type CommandPalettePageFilters,
  type CommandPaletteCommand,
  type CommandPaletteThread,
  type CommandPaletteFile,
  writeCommandPalettePageFilters,
} from "../../lib/command-palette";
import { type CommandPaletteHighlightSegment } from "../../lib/command-palette-highlight";
import type { CommandPaletteThreadSearchIndex } from "../../lib/command-palette-thread-search";
import {
  getCommandPaletteThreadSearchPlan,
  type CommandPaletteThreadSearchBatch,
  useCommandPaletteThreadSearch,
} from "../../lib/command-palette-chat-search";
import {
  buildCommandPalettePageSearchScopeKey,
  getCommandPalettePageSearchPlan,
  normalizeCommandPaletteSearchText,
  pageSearchFacetOptions,
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
import { NodexTabsRoot, NodexTabsList, NodexTabsTab, NodexTabsPanel } from "@/components/ui/tabs";
import { ShortcutKeycaps } from "@/components/ui/shortcut-keycaps";
import {
  NAVIGATE_BACK_COMMAND_ID,
  NAVIGATE_FORWARD_COMMAND_ID,
  RENAME_THREAD_COMMAND_ID,
  TOGGLE_SIDEBAR_COMMAND_ID,
} from "../../../shared/window-navigation";
import { OPEN_DB_VIEW_TAB_COMMAND_ID } from "@/lib/command-palette-commands";
import type { Project } from "@/lib/types";
import {
  buildCommandPaletteSectionsModel,
  DEFAULT_DISCOVERY_LIMITS,
  MAX_DISCOVERY_RESULTS,
  type DiscoveryLimits,
  type ExecutablePaletteItem,
  type PaletteItem,
} from "@/lib/command-palette-sections";

interface CommandPaletteSurfaceProps {
  fileSearchScope?: FileSearchScope | null;
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
  onExecute: (item: ExecutablePaletteItem) => void;
}

export interface CommandPaletteSurfaceHandle {
  /** A composing input retains Escape until its composition has finished. */
  isComposing: () => boolean;
}

const EMPTY_PALETTE_PAGES: readonly CommandPalettePage[] = [];
const EMPTY_PALETTE_PROJECTS: readonly Project[] = [];
const EMPTY_RECENT_PAGE_IDS: readonly string[] = [];
const EMPTY_PALETTE_THREADS: readonly CommandPaletteThread[] = [];

function getPaletteItemDomId(listId: string, index: number): string {
  return `${listId}-item-${index}`;
}

function isPaletteItemDisabled(item: PaletteItem | undefined): boolean {
  return item?.kind === "command" && item.disabled === true;
}

function getModePlaceholder(mode: CommandMenuMode): string {
  if (mode === "actions") return "Search actions";
  if (mode === "chats") return "Search chats";
  if (mode === "pages") return "Search pages";
  if (mode === "files") return "Search files";
  return "Search Nodex";
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
  if (mode === "files") return query ? "No files found." : "Type to search files.";
  return "No matching results.";
}

function resolveSelectableIndex(
  items: readonly PaletteItem[],
  preferredIndex: number,
  direction: -1 | 1,
): number {
  if (items.length === 0) return -1;

  const startIndex = Math.max(0, Math.min(preferredIndex, items.length - 1));
  for (
    let nextIndex = startIndex;
    nextIndex >= 0 && nextIndex < items.length;
    nextIndex += direction
  ) {
    if (!isPaletteItemDisabled(items[nextIndex])) {
      return nextIndex;
    }
  }

  return -1;
}

function getCommandGlyph(id: string) {
  if (id === "createPage") return PageIcon;
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

function CommandRow({ item, selected }: { item: CommandPaletteCommand; selected: boolean }) {
  const Glyph = getCommandGlyph(item.id);
  const subtitle = item.disabledReason ?? item.mockReason ?? item.subtitle;
  const isMock = Boolean(item.mockReason);
  const displaySubtitle = Boolean(item.disabledReason);

  return (
    <div className={cn("flex w-full gap-2", displaySubtitle ? "items-start" : "items-center")}>
      <Glyph
        className={cn(
          "size-4 shrink-0 text-token-description-foreground",
          selected && "text-token-foreground",
          displaySubtitle && "mt-0.5",
        )}
      />
      <div className="min-w-0 flex-1">
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
      {item.shortcut ? (
        <ShortcutKeycaps
          keys={[item.shortcut]}
          density="compact"
          className="h-4 min-w-0 rounded-full px-1.5 font-normal tracking-normal"
        />
      ) : null}
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
          "flex size-4 shrink-0 items-center justify-center",
          selected && "text-token-foreground",
          hasPreview && "mt-0.5",
        )}
      >
        {compact ? (
          <PageIcon className="size-4" />
        ) : (
          <ProjectMarker appearance={item.projectAppearance} />
        )}
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

function ThreadRow({
  item,
  selected,
  compact,
}: {
  item: CommandPaletteThread;
  selected: boolean;
  compact: boolean;
}) {
  const hasPreview = Boolean(item.searchPreview);
  const decorations = item.searchDecorations;
  const cwdLabel = getCwdLabel(item.cwd);
  const updatedLabel = formatThreadDate(item.updatedAt);
  const projectLabel = item.projectName ?? "Chats";

  return (
    <div className={cn("flex w-full gap-2", hasPreview ? "items-start" : "items-center")}>
      <div
        className={cn(
          "flex size-4 shrink-0 items-center justify-center text-token-description-foreground",
          selected && "text-token-foreground",
          hasPreview && "mt-0.5",
        )}
      >
        <ThreadsIcon className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-token-foreground">
          {decorations?.titleSegments
            ? renderSegments(decorations.titleSegments, `${item.id}:title`)
            : item.title || "New chat"}
        </div>
        {!compact ? (
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
        ) : null}
        {item.searchPreview ? (
          <div className="mt-1 line-clamp-2 text-xs/relaxed wrap-break-word text-token-description-foreground/90">
            {renderSegments(item.searchPreview.segments, `${item.id}:preview`)}
          </div>
        ) : null}
      </div>
      {compact && item.projectName ? (
        <span className="max-w-[30%] truncate text-sm text-token-description-foreground">
          {item.projectName}
        </span>
      ) : null}
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
        <span className="block px-[11px] pt-2 text-sm text-token-description-foreground">
          {title}
        </span>
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
              tabIndex={-1}
              cmdk-item=""
              data-palette-index={index}
              data-selected={selected}
              aria-selected={selected}
              aria-disabled={item.kind === "command" && item.disabled ? "true" : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onMouseMove={() => onSelectIndex(index)}
              onClick={() => onExecute(item)}
              disabled={item.kind === "command" && item.disabled}
              className={cn(
                "flex min-h-[calc(var(--spacing)*6)] w-full cursor-interaction rounded-lg px-[calc(var(--padding-row-x)+var(--spacing)*0.5)] py-[calc(var(--padding-row-y)+var(--spacing)*0.5)] text-left text-base text-token-foreground opacity-75 outline-none",
                (item.kind === "page" || item.kind === "thread") &&
                  item.searchPreview &&
                  "py-[calc(var(--padding-row-y)+2px)]",
                item.kind === "command" && item.disabled
                  ? "cursor-not-allowed opacity-40 hover:bg-transparent hover:opacity-40"
                  : selected
                    ? "bg-background-primary-ghost-hover opacity-100"
                    : "hover:bg-background-primary-ghost-hover hover:opacity-100",
              )}
            >
              {item.kind === "more" ? (
                <span className="pl-6 text-token-description-foreground">Show more</span>
              ) : item.kind === "command" ? (
                <CommandRow item={item} selected={selected} />
              ) : item.kind === "page" ? (
                <PageRow
                  compact={compactPages}
                  item={item}
                  selected={selected}
                  showSubtitle={showSubtitle}
                />
              ) : item.kind === "file" ? (
                <div className="flex min-w-0 items-center gap-2">
                  {item.file.kind === "directory" ? (
                    <FolderIcon className="size-4 shrink-0" />
                  ) : (
                    <FileIcon className="size-4 shrink-0" />
                  )}
                  <span className="shrink-0">{item.file.label}</span>
                  <span className="min-w-0 truncate text-token-description-foreground">
                    {item.file.directoryPath}
                  </span>
                </div>
              ) : (
                <ThreadRow item={item} selected={selected} compact={!showSubtitle} />
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
    fileSearchScope = null,
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
  const scopeControlsRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);
  const pointerSelectionRef = useRef(false);
  const canSearchFiles = Boolean(fileSearchScope?.roots.length);
  const scopes = getCommandPaletteScopes(canSearchFiles);
  const [query, setQuery] = useState("");
  const selectionScopeKey = JSON.stringify([mode, fileSearchScope?.hostId, fileSearchScope?.roots]);
  const discoveryKey = `${openTriggerTick}:${selectionScopeKey}:${normalizeCommandPaletteSearchText(query)}`;
  const [expandedDiscovery, setExpandedDiscovery] = useState<{
    key: string;
    limits: DiscoveryLimits;
  } | null>(null);
  const discoveryLimits =
    expandedDiscovery?.key === discoveryKey ? expandedDiscovery.limits : DEFAULT_DISCOVERY_LIMITS;
  const fileSearch = useFileSearch({
    enabled:
      open && (mode === "files" || (mode === "root" && Array.from(query.trim()).length >= 2)),
    query,
    scope: fileSearchScope,
  });
  const files = useMemo<CommandPaletteFile[]>(
    () => fileSearch.matches.map((file) => ({ kind: "file", id: file.fsPath, file })),
    [fileSearch.matches],
  );
  const [pageFilters, setPageFilters] = useState<CommandPalettePageFilters>(() =>
    readCommandPalettePageFilters(),
  );
  const [filterOpen, setFilterOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);

  useImperativeHandle(
    forwardedRef,
    () => ({
      isComposing: () => composingRef.current,
    }),
    [],
  );

  const threadSearchPlan = getCommandPaletteThreadSearchPlan(mode, deferredQuery);
  const fetchedThreadSearchBatch = useCommandPaletteThreadSearch({
    enabled: open && threadSearchPlan?.includeContentResults === true,
    query: deferredQuery,
    limit:
      mode === "root"
        ? Math.min(
            MAX_DISCOVERY_RESULTS,
            Math.max(threadSearchPlan?.maxResults ?? 9, discoveryLimits.chats + 1),
          )
        : (threadSearchPlan?.maxResults ?? 25),
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
        files,
        discoveryLimits,
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
      files,
      discoveryLimits,
    ],
  );
  const sections = visibleModel.sections;
  const flatItems = visibleModel.flatItems;
  const filterActive = hasActiveCommandPalettePageFilters(normalizedPageFilters);
  const showSubtitle = visibleModel.query.length > 0;
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
    if (open) return;
    setQuery("");
    setSelectedIndex(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    pointerSelectionRef.current = false;
    setSelectedIndex(0);
    if (scrollViewportRef.current) scrollViewportRef.current.scrollTop = 0;
  }, [selectionScopeKey, open, openTriggerTick, visibleModel.query]);

  useEffect(() => {
    if (mode === "files" && !canSearchFiles) onChangeMode("root");
    if (mode === "pages") return;
    setFilterOpen(false);
  }, [mode, canSearchFiles, onChangeMode]);

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
        files: nextQuery === query ? files : [],
        discoveryLimits: nextQuery === query ? discoveryLimits : DEFAULT_DISCOVERY_LIMITS,
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
      query,
      files,
      discoveryLimits,
    ],
  );
  const visibleRowsLoading =
    mode === "pages"
      ? pagesLoading || visibleModel.pageSearchPending
      : mode === "chats"
        ? chatsLoading || visibleModel.threadSearchPending
        : mode === "root"
          ? loading || visibleModel.threadSearchPending || visibleModel.pageSearchPending
          : mode === "files"
            ? fileSearch.loading
            : false;

  useEffect(() => {
    if (flatItems.length === 0) {
      if (selectedIndex === -1) return;
      setSelectedIndex(-1);
      return;
    }

    const preferredIndex = selectedIndex < 0 ? 0 : selectedIndex;
    const forwardIndex = resolveSelectableIndex(flatItems, preferredIndex, 1);
    const nextIndex =
      forwardIndex < 0 ? resolveSelectableIndex(flatItems, preferredIndex, -1) : forwardIndex;
    if (selectedIndex === nextIndex) return;
    setSelectedIndex(nextIndex);
  }, [flatItems, selectedIndex]);

  useEffect(() => {
    if (pointerSelectionRef.current) {
      pointerSelectionRef.current = false;
      return;
    }
    if (selectedIndex < 0) return;
    const next = scrollViewportRef.current?.querySelector<HTMLElement>(
      `[data-palette-index="${selectedIndex}"]`,
    );
    next?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const changeScope = (nextMode: CommandMenuMode, focusInput = true) => {
    setSelectedIndex(0);
    setFilterOpen(false);
    setExpandedDiscovery(null);
    onChangeMode(nextMode);
    if (focusInput) inputRef.current?.focus();
  };

  const handleExecute = useCallback(
    (item: PaletteItem) => {
      if (isPaletteItemDisabled(item)) return;
      if (item.kind === "more") {
        setSelectedIndex(flatItems.findIndex((candidate) => candidate.id === item.id));
        setExpandedDiscovery({
          key: discoveryKey,
          limits: {
            ...discoveryLimits,
            [item.scope]: Math.min(MAX_DISCOVERY_RESULTS, discoveryLimits[item.scope] + 5),
          },
        });
        inputRef.current?.focus();
        return;
      }
      if (item.kind === "command" && item.id === "searchChats") {
        setQuery("");
        onChangeMode("chats");
        return;
      }

      if (item.kind === "command" && item.id === "searchPages") {
        setQuery("");
        onChangeMode("pages");
        return;
      }

      if (item.kind === "command" && item.id === "searchFiles") {
        setQuery("");
        onChangeMode("files");
        return;
      }

      if (item.kind === "file" && item.file.kind === "directory") {
        setQuery(`${item.file.path.replace(/\/$/u, "")}/`);
        inputRef.current?.focus();
        return;
      }
      onRequestClose();
      onExecute(item);
    },
    [discoveryKey, discoveryLimits, flatItems, onChangeMode, onExecute, onRequestClose, setQuery],
  );

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    pointerSelectionRef.current = false;
    if (
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229 ||
      composingRef.current
    ) {
      event.stopPropagation();
      return;
    }
    if (event.key === "F6") {
      event.preventDefault();
      const control =
        filterButtonRef.current ??
        scopeControlsRef.current?.querySelector<HTMLButtonElement>('[aria-selected="true"]');
      control?.focus();
      return;
    }
    const moveSelection = (direction: -1 | 1) => {
      if (flatItems.length === 0) return;
      const currentIndex = selectedIndex < 0 ? (direction > 0 ? -1 : 0) : selectedIndex;
      const nextIndex = resolveSelectableIndex(flatItems, currentIndex + direction, direction);
      if (nextIndex < 0) return;
      setSelectedIndex(nextIndex);
    };

    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && (event.metaKey || event.altKey)) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (event.metaKey) {
        setSelectedIndex(
          resolveSelectableIndex(
            flatItems,
            direction > 0 ? flatItems.length - 1 : 0,
            direction > 0 ? -1 : 1,
          ),
        );
        return;
      }
      const groupStarts = sections.map((_, index) =>
        sections.slice(0, index).reduce((total, section) => total + section.items.length, 0),
      );
      const currentGroup = groupStarts.findLastIndex((start) => start <= selectedIndex);
      const targetGroup = Math.max(0, Math.min(groupStarts.length - 1, currentGroup + direction));
      const nextIndex = resolveSelectableIndex(flatItems, groupStarts[targetGroup] ?? 0, 1);
      if (nextIndex >= 0) setSelectedIndex(nextIndex);
      return;
    }

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

    if (event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      changeScope(cycleCommandPaletteMode(mode, event.shiftKey ? -1 : 1, canSearchFiles));
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

    if (event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onRequestClose();
  };
  const activeDescendantId =
    selectedIndex >= 0 && selectedIndex < flatItems.length
      ? getPaletteItemDomId(listId, selectedIndex)
      : undefined;
  const showThreadSearchStatus = visibleModel.showThreadSearchStatus;
  const showPageSearchStatus = visibleModel.showPageSearchStatus;
  const showFileSearchStatus =
    (mode === "files" || mode === "root") && (fileSearch.loading || fileSearch.error !== null);
  const hasVisibleSearchStatus =
    showThreadSearchStatus || showPageSearchStatus || showFileSearchStatus;

  return (
    <NodexTabsRoot
      value={mode}
      onValueChange={(value, details) => {
        const scope = scopes.find((candidate) => candidate.mode === value);
        if (!scope) return;
        changeScope(
          scope.mode,
          details.event.type !== "keydown" && details.event.type !== "focusin",
        );
      }}
      cmdk-root=""
      data-cmdk-root
      data-command-palette-surface
      className="flex h-[min(504px,90vh)] min-w-full select-none flex-col gap-1 overflow-hidden rounded-2xl bg-surface/65 p-1 pb-0 text-base text-token-foreground shadow-2xl ring-[0.5px] ring-token-border backdrop-blur-[24px]"
    >
      <label cmdk-label="" htmlFor={inputId} id={labelId} className="sr-only">
        Command palette search
      </label>
      <div
        ref={scopeControlsRef}
        className="flex shrink-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]"
        onKeyDown={(event) => {
          if (event.key !== "F6") return;
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <NodexTabsList
          activateOnFocus
          aria-label="Search scope"
          className="flex items-center gap-px"
        >
          {scopes.map((scope) => (
            <NodexTabsTab
              key={scope.mode}
              value={scope.mode}
              onMouseDown={(event) => event.preventDefault()}
              className={cn(
                "flex h-8 shrink-0 items-center rounded-[calc(var(--radius-2xl)-var(--spacing)-1px)] px-3 text-base font-medium outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-token-focus-border",
                mode === scope.mode
                  ? "bg-background-primary-ghost-hover text-token-foreground"
                  : "text-token-description-foreground hover:bg-background-primary-ghost-hover hover:text-token-foreground",
              )}
            >
              {scope.label}
            </NodexTabsTab>
          ))}
        </NodexTabsList>
        <ShortcutKeycaps
          aria-hidden="true"
          keys={["Tab"]}
          density="compact"
          className="ml-1 h-4 min-w-0 rounded-full px-1.5 font-normal tracking-normal"
        />
      </div>
      <div className="-mx-1 flex shrink-0 items-center border-b-[0.5px] border-token-border px-4">
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
          onChange={(event) => {
            setExpandedDiscovery(null);
            setQuery(event.target.value);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          placeholder={getModePlaceholder(mode)}
          aria-label="Command palette search"
          className="h-11.5 min-w-0 flex-1 rounded-none border-none bg-transparent pb-1.5 text-lg text-token-foreground outline-none placeholder:text-token-description-foreground"
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
              ref={filterButtonRef}
              onKeyDown={(event) => {
                if (event.key !== "F6") return;
                event.preventDefault();
                inputRef.current?.focus();
              }}
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

      <NodexTabsPanel
        value={mode}
        tabIndex={-1}
        className="-mt-1 flex min-h-0 flex-1 flex-col outline-none"
      >
        <div
          ref={scrollViewportRef}
          cmdk-list=""
          role="listbox"
          tabIndex={-1}
          aria-label="Suggestions"
          id={listId}
          aria-busy={visibleRowsLoading}
          className="relative flex min-h-0 flex-1 scroll-pt-8 flex-col gap-1 overflow-y-auto overscroll-contain pb-1 [scrollbar-width:none]"
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
                onSelectIndex={(index) => {
                  pointerSelectionRef.current = true;
                  setSelectedIndex(index);
                }}
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
          {showFileSearchStatus ? (
            <SearchStatusRow>
              {fileSearch.error ? "File search is unavailable" : "Searching files…"}
            </SearchStatusRow>
          ) : null}
          {flatItems.length === 0 && !hasVisibleSearchStatus ? (
            <div
              data-cmdk-empty
              className="absolute inset-0 flex items-center justify-center px-4 text-center text-lg text-token-description-foreground"
            >
              {getEmptyMessage(
                mode,
                visibleModel.query,
                mode === "chats" ? chatsLoading : mode === "pages" ? pagesLoading : loading,
              )}
            </div>
          ) : null}
        </div>
      </NodexTabsPanel>
    </NodexTabsRoot>
  );
});
