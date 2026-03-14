import { matchesSearchTokens, tokenizeSearchQuery } from "./card-search";
import {
  createCommandPaletteCardSearchIndex,
  normalizeCommandPaletteSearchText,
  type CommandPaletteCardSearchIndex,
} from "./command-palette-card-search";
import type { Card } from "./types";

export interface CommandPaletteCommand {
  kind: "command";
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  priority: number;
}

export interface CommandPaletteCard {
  kind: "card";
  id: string;
  projectId: string;
  projectName: string;
  projectIcon: string;
  columnName: string;
  card: Card;
  inActiveProject: boolean;
  recentIndex: number | null;
  boardIndex: number;
  searchPreview?: CommandPaletteCardSearchPreview | null;
  searchDecorations?: CommandPaletteCardSearchDecorations | null;
}

export interface CommandPaletteCardSearchPreviewSegment {
  text: string;
  highlight: boolean;
}

export interface CommandPaletteCardSearchBadge {
  id: string;
  label: string;
  segments: CommandPaletteCardSearchPreviewSegment[];
  tone?: "default" | "monospace";
}

export interface CommandPaletteCardSearchPreview {
  excerpt: string;
  segments: CommandPaletteCardSearchPreviewSegment[];
}

export interface CommandPaletteCardSearchDecorations {
  titleSegments?: CommandPaletteCardSearchPreviewSegment[] | null;
  projectNameSegments?: CommandPaletteCardSearchPreviewSegment[] | null;
  columnNameSegments?: CommandPaletteCardSearchPreviewSegment[] | null;
  badges: CommandPaletteCardSearchBadge[];
}

export interface CommandPaletteResults {
  commandMode: boolean;
  query: string;
  commands: CommandPaletteCommand[];
  cards: CommandPaletteCard[];
}

interface ScoredCommand {
  item: CommandPaletteCommand;
  score: number;
}

interface ScoredCard {
  item: CommandPaletteCard;
  score: number;
}

const DEFAULT_COMMAND_LIMIT = 8;
const DEFAULT_CARD_LIMIT = 12;

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
  return normalizeCommandPaletteSearchText([
    item.title,
    item.subtitle,
    item.keywords.join(" "),
  ].join(" "));
}

function rankCommand(
  item: CommandPaletteCommand,
  query: string,
  tokens: string[],
): ScoredCommand | null {
  const searchText = buildCommandSearchText(item);
  if (tokens.length > 0 && !matchesSearchTokens(searchText, tokens)) {
    return null;
  }

  const normalizedTitle = normalizeCommandPaletteSearchText(item.title);
  const normalizedSubtitle = normalizeCommandPaletteSearchText(item.subtitle);
  const titleScore = scoreNormalizedText(normalizedTitle, query);
  const subtitleScore = scoreNormalizedText(normalizedSubtitle, query);
  const searchScore = scoreNormalizedText(searchText, query);

  let score = item.priority;
  if (query) {
    score += Number.isFinite(titleScore) ? titleScore * 5 : 0;
    score += Number.isFinite(subtitleScore) ? subtitleScore * 2 : 0;
    score += Number.isFinite(searchScore) ? searchScore : 0;
  }
  if (item.active) {
    score += 30;
  }

  return { item, score };
}

function compareScoredCommands(left: ScoredCommand, right: ScoredCommand): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.item.title.localeCompare(right.item.title);
}

function compareDefaultCards(left: CommandPaletteCard, right: CommandPaletteCard): number {
  if (left.inActiveProject !== right.inActiveProject) {
    return left.inActiveProject ? -1 : 1;
  }

  if (left.recentIndex !== right.recentIndex) {
    if (left.recentIndex === null) return 1;
    if (right.recentIndex === null) return -1;
    return left.recentIndex - right.recentIndex;
  }

  if (left.boardIndex !== right.boardIndex) {
    return left.boardIndex - right.boardIndex;
  }

  return left.card.title.localeCompare(right.card.title);
}

function compareScoredCards(left: ScoredCard, right: ScoredCard): number {
  if (right.score !== left.score) return right.score - left.score;
  return compareDefaultCards(left.item, right.item);
}

export function filterCommandPaletteItems(input: {
  query: string;
  commands: CommandPaletteCommand[];
  cards: CommandPaletteCard[];
  cardSearchIndex?: CommandPaletteCardSearchIndex | null;
  commandLimit?: number;
  cardLimit?: number;
}): CommandPaletteResults {
  const rawQuery = input.query.trimStart();
  const commandMode = rawQuery.startsWith(">");
  const query = normalizeCommandPaletteSearchText(commandMode ? rawQuery.slice(1) : rawQuery);
  const tokens = tokenizeSearchQuery(query);

  const commands = commandMode
    ? input.commands
        .map((item) => rankCommand(item, query, tokens))
        .filter((item): item is ScoredCommand => item !== null)
        .sort(compareScoredCommands)
        .slice(0, input.commandLimit ?? DEFAULT_COMMAND_LIMIT)
        .map(({ item }) => item)
    : [];

  if (commandMode) {
    return {
      commandMode,
      query,
      commands,
      cards: [],
    };
  }

  const cards = query
    ? (
        input.cardSearchIndex === undefined
          ? createCommandPaletteCardSearchIndex(input.cards).search(query)
          : input.cardSearchIndex?.search(query) ?? []
      )
        .sort(compareScoredCards)
        .slice(0, input.cardLimit ?? DEFAULT_CARD_LIMIT)
        .map(({ item }) => item)
    : input.cards
        .slice()
        .sort(compareDefaultCards)
        .slice(0, input.cardLimit ?? DEFAULT_CARD_LIMIT);

  return {
    commandMode,
    query,
    commands,
    cards,
  };
}
