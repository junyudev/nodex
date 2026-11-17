import { getIntl } from "@/lib/i18n";
import type { ChatSearchReveal } from "./chat-search-reveal";
import type { PageSearchReveal } from "./page-search-reveal";
import type { CodexAccentPreset } from "./codex-theme-variant";
import type { FileSearchMatch } from "../../shared/file-search";
import { matchesSearchTokens, tokenizeSearchQuery } from "./search-text";
import { buildCommandPaletteCharacterHighlightSegments } from "./command-palette-highlight";
import { normalizeSearchText } from "./search-text";
import type { ChatSearchMatch } from "../../shared/chat-search";
import type { WorkflowStatus } from "../../shared/workflow-status";
import type { DatabasePageSummary, Priority } from "./types";
import type { ProjectAppearance } from "../../shared/project-appearance";

export interface CommandPaletteCommand {
  kind: "command";
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  /** Longer searchable text, such as a skill's description, matched only in the Actions scope. */
  description?: string;
  group: CommandPaletteCommandGroup;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  priority: number;
  themePreview?: { surface: string; ink: string; accent: string };
  themeAction?: "open" | "light" | "dark" | CodexAccentPreset;
  searchTitleSegments?: CommandPalettePageSearchPreviewSegment[] | null;
}

export type CommandMenuMode = "root" | "actions" | "chats" | "pages" | "files" | "text";

const COMMAND_PALETTE_SCOPES: readonly {
  readonly mode: CommandMenuMode;
  readonly label: string;
}[] = [
  {
    mode: "root",
    get label() {
      return getIntl().formatMessage({ id: "lib.commandPalette.mode.all", defaultMessage: "All" });
    },
  },
  {
    mode: "actions",
    get label() {
      return getIntl().formatMessage({
        id: "lib.commandPalette.mode.actions",
        defaultMessage: "Actions",
      });
    },
  },
  {
    mode: "chats",
    get label() {
      return getIntl().formatMessage({
        id: "lib.commandPalette.mode.chats",
        defaultMessage: "Chats",
      });
    },
  },
  {
    mode: "pages",
    get label() {
      return getIntl().formatMessage({
        id: "lib.commandPalette.mode.pages",
        defaultMessage: "Pages",
      });
    },
  },
  {
    mode: "files",
    get label() {
      return getIntl().formatMessage({
        id: "lib.commandPalette.mode.files",
        defaultMessage: "Files",
      });
    },
  },
  {
    mode: "text",
    get label() {
      return getIntl().formatMessage({
        id: "lib.commandPalette.mode.text",
        defaultMessage: "Text",
      });
    },
  },
];

/** Workspace scopes remain discoverable before a folder has been selected. */
export function getCommandPaletteScopes() {
  return COMMAND_PALETTE_SCOPES;
}

export function cycleCommandPaletteMode(mode: CommandMenuMode, direction: -1 | 1): CommandMenuMode {
  const scopes = getCommandPaletteScopes();
  const currentIndex = scopes.findIndex((scope) => scope.mode === mode);
  return scopes[(currentIndex + direction + scopes.length) % scopes.length]!.mode;
}

export interface CommandMenuOpenRequest {
  mode: CommandMenuMode;
  query?: string;
}

export type CommandPaletteCommandGroup =
  | "Suggested"
  | "Chat"
  | "Navigation"
  | "Panels"
  | "Project"
  | "Configure"
  | "Color themes"
  | "Settings"
  | "Skills"
  | "App";

export interface CommandPalettePage {
  archived?: boolean;
  kind: "page";
  id: string;
  projectId: string | null;
  projectName: string;
  projectAppearance: ProjectAppearance | null;
  columnName: string;
  page:
    | DatabasePageSummary
    | {
        id: string;
        title: string;
        pageKey: string | null;
        status: WorkflowStatus | null;
        priority: Priority | null;
        tags: string[];
        assignee: import("../../shared/work-graph").PageAssignee | null;
        owner?: string | null;
      };
  /** Registry-resolved display labels; canonical option IDs stay on page.tags. */
  tagLabels: string[];
  inActiveProject: boolean;
  recentIndex: number | null;
  boardIndex: number;
  searchPreview?: CommandPalettePageSearchPreview | null;
  reveal?: PageSearchReveal;
  searchDecorations?: CommandPalettePageSearchDecorations | null;
  pageKeyMatch?: CommandPalettePageKeyMatch | null;
}

export interface CommandPalettePageKeyMatch {
  matchedPageKey: string;
  isCurrent: boolean;
}

export interface CommandPalettePageSearchPreviewSegment {
  text: string;
  highlight: boolean;
}

export interface CommandPalettePageSearchBadge {
  id: string;
  label: string;
  segments: CommandPalettePageSearchPreviewSegment[];
  tone?: "default" | "monospace";
}

export interface CommandPalettePageSearchPreview {
  excerpt: string;
  segments: CommandPalettePageSearchPreviewSegment[];
}

export interface CommandPalettePageSearchDecorations {
  pageKeySegments?: CommandPalettePageSearchPreviewSegment[] | null;
  titleSegments?: CommandPalettePageSearchPreviewSegment[] | null;
  projectNameSegments?: CommandPalettePageSearchPreviewSegment[] | null;
  columnNameSegments?: CommandPalettePageSearchPreviewSegment[] | null;
  badges: CommandPalettePageSearchBadge[];
}

/** A chat result: a Main-ranked chat search match. */
export interface CommandPaletteChat extends ChatSearchMatch {
  readonly reveal?: ChatSearchReveal;
  readonly kind: "chat";
  readonly id: string;
  readonly inActiveProject: boolean;
}

export interface CommandPaletteResults {
  mode: CommandMenuMode;
  query: string;
  commands: CommandPaletteCommand[];
  pages: CommandPalettePage[];
}

interface ScoredCommand {
  item: CommandPaletteCommand;
  score: number;
}

const normalizeCommandPaletteSearchText = normalizeSearchText;

function scoreNormalizedText(text: string, query: string): number {
  if (!query) return 0;
  if (!text) return Number.NEGATIVE_INFINITY;
  if (text === query) return 400;
  if (text.startsWith(query)) return 280;

  const wordMatch = text.indexOf(` ${query}`);
  if (wordMatch >= 0) {
    return Math.max(210 - wordMatch, 140);
  }

  const containsIndex = text.indexOf(query);
  if (containsIndex >= 0) {
    return Math.max(130 - containsIndex, 40);
  }

  return Number.NEGATIVE_INFINITY;
}

function buildCommandSearchText(item: CommandPaletteCommand): string {
  return normalizeCommandPaletteSearchText(
    [item.title, item.subtitle, item.keywords.join(" "), item.description ?? ""].join(" "),
  );
}

function scoreFuzzySubsequence(text: string, query: string): number {
  if (!text || !query) return Number.NEGATIVE_INFINITY;
  const textCharacters = Array.from(text);
  const queryCharacters = Array.from(query);
  let queryIndex = 0;
  let firstMatch = -1;
  let previousMatch = -1;
  let gapCost = 0;

  for (
    let index = 0;
    index < textCharacters.length && queryIndex < queryCharacters.length;
    index += 1
  ) {
    if (textCharacters[index] !== queryCharacters[queryIndex]) continue;
    if (firstMatch < 0) firstMatch = index;
    if (previousMatch >= 0) gapCost += index - previousMatch - 1;
    previousMatch = index;
    queryIndex += 1;
  }

  if (queryIndex !== queryCharacters.length) return Number.NEGATIVE_INFINITY;
  const score = 80 - firstMatch * 2 - gapCost * 3;
  return score >= 40 ? score : Number.NEGATIVE_INFINITY;
}

/**
 * In All, an action earns a row only by its own name or a keyword that starts with a query word:
 * a loose match in a path or description would push the content a person is looking for down.
 */
function matchesActionByName(
  item: CommandPaletteCommand,
  query: string,
  tokens: string[],
): boolean {
  const title = normalizeCommandPaletteSearchText(item.title);
  if (Number.isFinite(scoreNormalizedText(title, query))) return true;
  if (Number.isFinite(scoreFuzzySubsequence(title, query))) return true;
  const keywords = item.keywords.map(normalizeCommandPaletteSearchText);
  return tokens.every((token) =>
    keywords.some((keyword) => keyword.split(/\s+/).some((word) => word.startsWith(token))),
  );
}

function rankCommand(
  item: CommandPaletteCommand,
  query: string,
  tokens: string[],
): ScoredCommand | null {
  const searchText = buildCommandSearchText(item);
  const tokenMatch = tokens.length === 0 || matchesSearchTokens(searchText, tokens);

  const normalizedTitle = normalizeCommandPaletteSearchText(item.title);
  const normalizedSubtitle = normalizeCommandPaletteSearchText(item.subtitle);
  const titleScore = scoreNormalizedText(normalizedTitle, query);
  const subtitleScore = scoreNormalizedText(normalizedSubtitle, query);
  const searchScore = scoreNormalizedText(searchText, query);
  const fuzzyTitleScore = scoreFuzzySubsequence(normalizedTitle, query);
  const fuzzySearchScore = scoreFuzzySubsequence(searchText, query);
  if (
    query &&
    !tokenMatch &&
    !Number.isFinite(fuzzyTitleScore) &&
    !Number.isFinite(fuzzySearchScore)
  )
    return null;

  let score = item.priority;
  if (query) {
    score += Number.isFinite(titleScore) ? titleScore * 5 : 0;
    score += Number.isFinite(subtitleScore) ? subtitleScore * 2 : 0;
    score += Number.isFinite(searchScore) ? searchScore : 0;
    score += Number.isFinite(fuzzyTitleScore) ? fuzzyTitleScore * 4 : 0;
    score += Number.isFinite(fuzzySearchScore) ? fuzzySearchScore : 0;
  }
  if (item.active) {
    score += 30;
  }
  const searchTitleSegments = query
    ? buildCommandPaletteCharacterHighlightSegments(item.title, query, "fuzzy")
    : null;

  return {
    item: {
      ...item,
      searchTitleSegments: searchTitleSegments?.some((segment) => segment.highlight)
        ? searchTitleSegments
        : null,
    },
    score,
  };
}

function compareScoredCommands(left: ScoredCommand, right: ScoredCommand): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.item.title.localeCompare(right.item.title);
}

export function filterCommandPaletteItems(input: {
  query: string;
  mode: CommandMenuMode;
  commands: readonly CommandPaletteCommand[];
  pages: readonly CommandPalettePage[];
  commandLimit?: number;
}): CommandPaletteResults {
  const query = normalizeCommandPaletteSearchText(input.query.trimStart());
  const tokens = tokenizeSearchQuery(query);

  if (input.mode === "root" || input.mode === "actions") {
    const commands = input.commands
      .filter((item) => input.mode !== "root" || !query || matchesActionByName(item, query, tokens))
      .map((item) => rankCommand(item, query, tokens))
      .filter((item): item is ScoredCommand => item !== null)
      .sort(compareScoredCommands)
      .slice(0, input.commandLimit ?? 100)
      .map(({ item }) => item);

    return {
      mode: input.mode,
      query,
      commands,
      pages: [],
    };
  }

  return {
    mode: input.mode,
    query,
    commands: [],
    pages: [],
  };
}

export interface CommandPaletteFile {
  readonly kind: "file";
  readonly id: string;
  readonly file: FileSearchMatch;
  readonly hostId: string;
}

export interface CommandPaletteText {
  readonly kind: "text";
  readonly id: string;
  readonly match: import("../../shared/workspace-text-search").WorkspaceTextSearchMatch;
  readonly disabled: boolean;
  readonly hostId: string;
}
