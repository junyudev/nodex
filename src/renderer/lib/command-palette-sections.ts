import type { Project } from "./types";
import {
  filterCommandPaletteItems,
  type CommandMenuMode,
  type CommandPaletteCommand,
  type CommandPaletteCommandGroup,
  type CommandPaletteFile,
  type CommandPalettePage,
  type CommandPaletteThread,
} from "./command-palette";
import type { CommandPaletteThreadSearchIndex } from "./command-palette-thread-search";
import {
  getCommandPaletteThreadSearchPlan,
  selectCommandPaletteChatResults,
  type CommandPaletteThreadSearchBatch,
} from "./command-palette-chat-search";
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
  | CommandPaletteThread
  | CommandPaletteFile;
type DiscoveryScope = "chats" | "pages" | "files";
export type PaletteItem =
  | ExecutablePaletteItem
  | { kind: "more"; id: string; scope: DiscoveryScope };
type PaletteSectionModel = { title: string; items: PaletteItem[] };
export type DiscoveryLimits = Readonly<Record<DiscoveryScope, number>>;
export const MAX_DISCOVERY_RESULTS = 60;
export const DEFAULT_DISCOVERY_LIMITS: DiscoveryLimits = { chats: 5, pages: 5, files: 5 };

function discoverySection(
  title: string,
  items: ExecutablePaletteItem[],
  scope: DiscoveryScope,
  limit: number,
): PaletteSectionModel {
  return {
    title,
    items:
      items.length > limit && limit < MAX_DISCOVERY_RESULTS
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
  "Skills",
  "App",
];

interface CommandPaletteSectionsInput {
  discoveryLimits?: DiscoveryLimits;
  files?: readonly CommandPaletteFile[];
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

export function buildCommandPaletteSectionsModel({
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
  files = [],
  discoveryLimits = DEFAULT_DISCOVERY_LIMITS,
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
    mergedPageLimit: mode === "root" ? discoveryLimits.pages + 1 : undefined,
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
        threadLimit: mode === "root" ? discoveryLimits.chats + 1 : threadSearchPlan.maxResults,
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
    if (mode === "root" || mode === "actions") {
      const quickActions = normalizedQuery.length === 0 && mode === "root";
      const commandSections = quickActions
        ? [
            {
              title: "Quick actions",
              items: ["newThread", "createPage", "openFolder"].flatMap((id) => {
                const item = results.commands.find(
                  (candidate) => candidate.id === id && !candidate.mockReason,
                );
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
      if (visibleThreads.length > 0)
        sections.push(discoverySection("Chats", visibleThreads, "chats", discoveryLimits.chats));
      if (pageSearchPlan) {
        showPageSearchStatus = pageSearchPending || pageSearchError !== null;
        if (visiblePages.length > 0)
          sections.push(discoverySection("Pages", visiblePages, "pages", discoveryLimits.pages));
      }
      if (files.length > 0)
        sections.push(discoverySection("Files", [...files], "files", discoveryLimits.files));
      return sections;
    }

    if (mode === "chats") {
      return [{ title: "Chats", items: visibleThreads }];
    }

    if (mode === "pages") {
      showPageSearchStatus = pageSearchPending || pageSearchError !== null;
      return [{ title: "Pages", items: visiblePages }];
    }

    if (mode === "files") return [{ title: "Files", items: [...files] }];
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
