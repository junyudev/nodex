import { defineMessages, getIntl, type IntlShape, type MessageDescriptor } from "@/lib/i18n";
import { chatSearchReveal } from "./chat-search-reveal";
import type { Project } from "./types";
import {
  filterCommandPaletteItems,
  type CommandMenuMode,
  type CommandPaletteCommand,
  type CommandPaletteCommandGroup,
  type CommandPaletteFile,
  type CommandPalettePage,
  type CommandPaletteChat,
  type CommandPaletteText,
} from "./command-palette";
import {
  mergeChatSearchMatches,
  type ChatMessageSearchState,
  type ChatSearchState,
} from "./chat-search";
import {
  getCommandPalettePageSearchPlan,
  getCommandPalettePageSearchError,
  isCommandPalettePageSearchPending,
  normalizeCommandPaletteSearchText,
  selectCommandPalettePageResults,
  type CommandPalettePageSearchBatch,
} from "./command-palette-page-results";

export type ExecutablePaletteItem =
  | CommandPaletteCommand
  | CommandPalettePage
  | CommandPaletteChat
  | CommandPaletteFile
  | CommandPaletteText;
type DiscoveryScope = "chats" | "pages" | "files" | "text";
export type PaletteItem =
  | ExecutablePaletteItem
  | { kind: "more"; id: string; scope: DiscoveryScope }
  | { kind: "text-query"; id: string; query: string };
type PaletteSectionModel = { title: string; items: PaletteItem[] };
export type DiscoveryLimits = Readonly<Record<DiscoveryScope, number>>;
export const MAX_DISCOVERY_RESULTS = 60;
export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = { chats: 5, pages: 5, files: 5, text: 5 };
export const getDiscoveryResultLimit = (scope: DiscoveryScope): number =>
  scope === "text" ? 100 : MAX_DISCOVERY_RESULTS;
const CHATS_SCOPE_LIMIT = 25;

/** How many chats a scope requests for a query: All lists them from two characters. */
export function getCommandPaletteChatLimit(
  mode: CommandMenuMode,
  query: string,
  discoveryLimits: DiscoveryLimits,
): number | null {
  if (mode === "chats") return CHATS_SCOPE_LIMIT;
  if (mode !== "root" || Array.from(query.trim()).length === 1) return null;
  return Math.min(MAX_DISCOVERY_RESULTS, discoveryLimits.chats + 1);
}

/** Message history is still being searched, could not all be searched, or chats are unavailable. */
export type CommandPaletteChatStatus = "searching" | "incomplete" | "failed" | "truncated";

function discoverySection(
  title: string,
  items: ExecutablePaletteItem[],
  scope: DiscoveryScope,
  limit: number,
): PaletteSectionModel {
  return {
    title,
    items:
      items.length > limit && limit < getDiscoveryResultLimit(scope)
        ? [...items.slice(0, limit), { kind: "more", id: `more:${scope}`, scope }]
        : items.slice(0, limit),
  };
}

const COMMAND_GROUP_TITLES = defineMessages({
  Suggested: { id: "lib.commandPaletteSections.group.suggested", defaultMessage: "Suggested" },
  Chat: { id: "lib.commandPaletteSections.group.chat", defaultMessage: "Chat" },
  Navigation: { id: "lib.commandPaletteSections.group.navigation", defaultMessage: "Navigation" },
  Panels: { id: "lib.commandPaletteSections.group.panels", defaultMessage: "Panels" },
  Project: { id: "lib.commandPaletteSections.group.project", defaultMessage: "Project" },
  Configure: { id: "lib.commandPaletteSections.group.configure", defaultMessage: "Configure" },
  Settings: { id: "lib.commandPaletteSections.group.settings", defaultMessage: "Settings" },
  "Color themes": {
    id: "lib.commandPaletteSections.group.colorThemes",
    defaultMessage: "Color themes",
  },
  Skills: { id: "lib.commandPaletteSections.group.skills", defaultMessage: "Skills" },
  App: { id: "lib.commandPaletteSections.group.app", defaultMessage: "App" },
}) satisfies Record<CommandPaletteCommandGroup, MessageDescriptor>;

const DISCOVERY_TITLES = defineMessages({
  chats: { id: "lib.commandPaletteSections.chats", defaultMessage: "Chats" },
  pages: { id: "lib.commandPaletteSections.pages", defaultMessage: "Pages" },
  text: { id: "lib.commandPaletteSections.text", defaultMessage: "Text" },
  files: { id: "lib.commandPaletteSections.files", defaultMessage: "Files" },
});

interface CommandPaletteSectionsInput {
  discoveryLimits?: DiscoveryLimits;
  files?: readonly CommandPaletteFile[];
  textMatches?: readonly CommandPaletteText[];
  textQueries?: readonly string[];
  query: string;
  mode: CommandMenuMode;
  commands: readonly CommandPaletteCommand[];
  pages: readonly CommandPalettePage[];
  projects: readonly Project[];
  activeProjectId: string | null;
  recentPageIds: readonly string[];
  chatSearch: ChatSearchState;
  chatMessageSearch: ChatMessageSearchState;
  pageSearchBatch?: CommandPalettePageSearchBatch | null;
  pageSearchScopeKey?: string | null;
}

interface CommandPaletteSectionsModel {
  query: string;
  sections: PaletteSectionModel[];
  flatItems: PaletteItem[];
  pageSearchError: string | null;
  pageSearchPending: boolean;
  pageSearchTruncated: boolean;
  pageSearchIndexing: boolean;
  showPageSearchStatus: boolean;
  chatStatus: CommandPaletteChatStatus | null;
  /** No chat search has answered since the palette opened. */
  chatsPending: boolean;
}

export function buildCommandPaletteSectionsModel(
  {
    query,
    mode,
    commands,
    pages,
    projects,
    activeProjectId,
    recentPageIds,
    chatSearch,
    chatMessageSearch,
    pageSearchBatch,
    pageSearchScopeKey,
    files = [],
    textMatches = [],
    textQueries = [],
    discoveryLimits = DEFAULT_DISCOVERY_LIMITS,
  }: CommandPaletteSectionsInput,
  intl: IntlShape = getIntl(),
): CommandPaletteSectionsModel {
  const results = filterCommandPaletteItems({
    query,
    mode,
    commands,
    pages,
  });

  const visiblePages = selectCommandPalettePageResults({
    query,
    projects,
    activeProjectId,
    recentPageIds,
    pages,
    pageSearchBatch,
    pageSearchScopeKey,
    mergedPageLimit: mode === "root" ? discoveryLimits.pages + 1 : undefined,
  });
  const normalizedQuery = normalizeCommandPaletteSearchText(query);
  const chatLimit = getCommandPaletteChatLimit(mode, query, discoveryLimits);
  const historyMatches = new Set(chatMessageSearch.matches);
  const visibleChats: CommandPaletteChat[] =
    chatLimit === null
      ? []
      : mergeChatSearchMatches(chatSearch.matches, chatMessageSearch.matches, chatLimit).map(
          (match) => ({
            ...match,
            kind: "chat",
            reveal: historyMatches.has(match) ? chatSearchReveal(match) : undefined,
            id: `chat:${match.chat.sessionId}`,
            inActiveProject: activeProjectId !== null && match.chat.projectId === activeProjectId,
          }),
        );
  const chatsPending = chatLimit !== null && !chatSearch.answered;
  const chatStatus: CommandPaletteChatStatus | null =
    chatLimit === null
      ? null
      : chatMessageSearch.truncated
        ? "truncated"
        : chatSearch.failed
          ? "failed"
          : chatMessageSearch.pending
            ? "searching"
            : chatMessageSearch.incomplete
              ? "incomplete"
              : null;
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
  const freshPageSearch =
    pageSearchBatch?.status === "success" &&
    pageSearchBatch.query === query.trim() &&
    pageSearchBatch.scopeKey === pageSearchScopeKey;
  const pageSearchTruncated = freshPageSearch && pageSearchBatch?.truncated === true;
  const pageSearchIndexing = freshPageSearch && pageSearchBatch?.coverage === "indexing";
  let showPageSearchStatus = false;
  const sections: PaletteSectionModel[] = (() => {
    if (mode === "root" || mode === "actions") {
      const quickActions = normalizedQuery.length === 0 && mode === "root";
      const commandSections = quickActions
        ? [
            {
              title: intl.formatMessage({
                id: "lib.commandPaletteSections.quickActions",
                defaultMessage: "Quick actions",
              }),
              items: ["newThread", "openFolder"].flatMap((id) => {
                const item = results.commands.find((candidate) => candidate.id === id);
                return item ? [item] : [];
              }),
            },
          ]
        : Object.entries(COMMAND_GROUP_TITLES).map(([group, title]) => ({
            title: intl.formatMessage(title),
            items: results.commands.filter((item) => item.group === group),
          }));
      const sections: PaletteSectionModel[] = commandSections.filter(
        (section) => section.items.length > 0,
      );
      if (mode === "actions") return sections;
      if (visibleChats.length > 0)
        sections.push(
          discoverySection(
            intl.formatMessage(DISCOVERY_TITLES.chats),
            visibleChats,
            "chats",
            discoveryLimits.chats,
          ),
        );
      if (pageSearchPlan) {
        showPageSearchStatus =
          pageSearchPending ||
          pageSearchIndexing ||
          pageSearchError !== null ||
          pageSearchTruncated;
        if (visiblePages.length > 0)
          sections.push(
            discoverySection(
              intl.formatMessage(DISCOVERY_TITLES.pages),
              visiblePages,
              "pages",
              discoveryLimits.pages,
            ),
          );
      }
      if (files.length > 0)
        sections.push(
          discoverySection(
            intl.formatMessage(DISCOVERY_TITLES.files),
            [...files],
            "files",
            discoveryLimits.files,
          ),
        );
      if (textMatches.length > 0)
        sections.push(
          discoverySection(
            intl.formatMessage(DISCOVERY_TITLES.text),
            [...textMatches],
            "text",
            discoveryLimits.text,
          ),
        );
      return sections;
    }

    if (mode === "chats") {
      return [
        {
          title: intl.formatMessage(DISCOVERY_TITLES.chats),
          items: visibleChats,
        },
      ];
    }

    if (mode === "pages") {
      showPageSearchStatus =
        pageSearchPending || pageSearchIndexing || pageSearchError !== null || pageSearchTruncated;
      return [
        {
          title: intl.formatMessage(DISCOVERY_TITLES.pages),
          items: visiblePages,
        },
      ];
    }

    if (mode === "files")
      return [
        {
          title: query.trim()
            ? intl.formatMessage(DISCOVERY_TITLES.files)
            : intl.formatMessage({
                id: "lib.commandPaletteSections.openedRecently",
                defaultMessage: "Opened recently",
              }),
          items: [...files],
        },
      ];
    if (mode === "text") {
      if (query.length > 0)
        return [
          {
            title: intl.formatMessage(DISCOVERY_TITLES.text),
            items: [...textMatches],
          },
        ];
      return [
        {
          title: intl.formatMessage({
            id: "lib.commandPaletteSections.recentSearches",
            defaultMessage: "Recent searches",
          }),
          items: textQueries.map((value) => ({
            kind: "text-query" as const,
            id: `text-query:${value}`,
            query: value,
          })),
        },
      ];
    }
    return [];
  })();

  return {
    query: results.query,
    sections,
    flatItems: sections.flatMap((section) => section.items),
    pageSearchError,
    pageSearchPending,
    pageSearchTruncated,
    pageSearchIndexing,
    showPageSearchStatus,
    chatStatus,
    chatsPending,
  };
}
