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
export type CommandPaletteChatStatus = "searching" | "incomplete" | "failed";

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

const COMMAND_GROUP_ORDER: CommandPaletteCommandGroup[] = [
  "Suggested",
  "Chat",
  "Navigation",
  "Panels",
  "Project",
  "Configure",
  "Settings",
  "Color themes",
  "Skills",
  "App",
];

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
  showPageSearchStatus: boolean;
  chatStatus: CommandPaletteChatStatus | null;
  /** No chat search has answered since the palette opened. */
  chatsPending: boolean;
}

export function buildCommandPaletteSectionsModel({
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
}: CommandPaletteSectionsInput): CommandPaletteSectionsModel {
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
  const visibleChats: CommandPaletteChat[] =
    chatLimit === null
      ? []
      : mergeChatSearchMatches(chatSearch.matches, chatMessageSearch.matches, chatLimit).map(
          (match) => ({
            ...match,
            kind: "chat",
            id: `chat:${match.chat.sessionId}`,
            inActiveProject: activeProjectId !== null && match.chat.projectId === activeProjectId,
          }),
        );
  const chatsPending = chatLimit !== null && !chatSearch.answered;
  const chatStatus: CommandPaletteChatStatus | null =
    chatLimit === null
      ? null
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
  let showPageSearchStatus = false;
  const sections: PaletteSectionModel[] = (() => {
    if (mode === "root" || mode === "actions") {
      const quickActions = normalizedQuery.length === 0 && mode === "root";
      const commandSections = quickActions
        ? [
            {
              title: "Quick actions",
              items: ["newThread", "openFolder"].flatMap((id) => {
                const item = results.commands.find((candidate) => candidate.id === id);
                return item ? [item] : [];
              }),
            },
          ]
        : COMMAND_GROUP_ORDER.map((title) => ({
            title,
            items: results.commands.filter((item) => item.group === title),
          }));
      const sections: PaletteSectionModel[] = commandSections.filter(
        (section) => section.items.length > 0,
      );
      if (mode === "actions") return sections;
      if (visibleChats.length > 0)
        sections.push(discoverySection("Chats", visibleChats, "chats", discoveryLimits.chats));
      if (pageSearchPlan) {
        showPageSearchStatus = pageSearchPending || pageSearchError !== null;
        if (visiblePages.length > 0)
          sections.push(discoverySection("Pages", visiblePages, "pages", discoveryLimits.pages));
      }
      if (files.length > 0)
        sections.push(discoverySection("Files", [...files], "files", discoveryLimits.files));
      if (textMatches.length > 0)
        sections.push(discoverySection("Text", [...textMatches], "text", discoveryLimits.text));
      return sections;
    }

    if (mode === "chats") {
      return [{ title: "Chats", items: visibleChats }];
    }

    if (mode === "pages") {
      showPageSearchStatus = pageSearchPending || pageSearchError !== null;
      return [{ title: "Pages", items: visiblePages }];
    }

    if (mode === "files")
      return [{ title: query.trim() ? "Files" : "Opened recently", items: [...files] }];
    if (mode === "text") {
      if (query.length > 0) return [{ title: "Text", items: [...textMatches] }];
      return [
        {
          title: "Recent searches",
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
    showPageSearchStatus,
    chatStatus,
    chatsPending,
  };
}
