import { buildCardSearchText, matchesSearchTokens, tokenizeSearchQuery } from "./card-search";
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

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

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
  return normalize([
    item.title,
    item.subtitle,
    item.keywords.join(" "),
  ].join(" "));
}

function buildPaletteCardSearchText(item: CommandPaletteCard): string {
  return normalize([
    buildCardSearchText(item.card),
    item.projectId,
    item.projectName,
    item.columnName,
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

  const normalizedTitle = normalize(item.title);
  const normalizedSubtitle = normalize(item.subtitle);
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

function rankCard(
  item: CommandPaletteCard,
  query: string,
  tokens: string[],
): ScoredCard | null {
  const searchText = buildPaletteCardSearchText(item);
  if (tokens.length > 0 && !matchesSearchTokens(searchText, tokens)) {
    return null;
  }

  const normalizedTitle = normalize(item.card.title || "untitled");
  const normalizedProject = normalize(item.projectName);
  const titleScore = scoreNormalizedText(normalizedTitle, query);
  const projectScore = scoreNormalizedText(normalizedProject, query);
  const searchScore = scoreNormalizedText(searchText, query);

  let score = 0;
  if (query) {
    score += Number.isFinite(titleScore) ? titleScore * 5 : 0;
    score += Number.isFinite(projectScore) ? projectScore * 2 : 0;
    score += Number.isFinite(searchScore) ? searchScore : 0;
  }

  if (item.inActiveProject) {
    score += 120;
  }

  if (item.recentIndex !== null) {
    score += Math.max(0, 140 - item.recentIndex * 16);
  }

  score += Math.max(0, 48 - Math.min(item.boardIndex, 48));

  return { item, score };
}

function compareScoredCommands(left: ScoredCommand, right: ScoredCommand): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.item.title.localeCompare(right.item.title);
}

function compareScoredCards(left: ScoredCard, right: ScoredCard): number {
  if (right.score !== left.score) return right.score - left.score;
  if (left.item.inActiveProject !== right.item.inActiveProject) {
    return left.item.inActiveProject ? -1 : 1;
  }
  if (left.item.boardIndex !== right.item.boardIndex) {
    return left.item.boardIndex - right.item.boardIndex;
  }
  return left.item.card.title.localeCompare(right.item.card.title);
}

export function filterCommandPaletteItems(input: {
  query: string;
  commands: CommandPaletteCommand[];
  cards: CommandPaletteCard[];
  commandLimit?: number;
  cardLimit?: number;
}): CommandPaletteResults {
  const rawQuery = input.query.trimStart();
  const commandMode = rawQuery.startsWith(">");
  const query = normalize(commandMode ? rawQuery.slice(1) : rawQuery);
  const tokens = tokenizeSearchQuery(query);

  const commands = input.commands
    .map((item) => rankCommand(item, query, tokens))
    .filter((item): item is ScoredCommand => item !== null)
    .sort(compareScoredCommands)
    .slice(0, input.commandLimit ?? DEFAULT_COMMAND_LIMIT)
    .map(({ item }) => item);

  if (commandMode) {
    return {
      commandMode,
      query,
      commands,
      cards: [],
    };
  }

  const cards = input.cards
    .map((item) => rankCard(item, query, tokens))
    .filter((item): item is ScoredCard => item !== null)
    .sort(compareScoredCards)
    .slice(0, input.cardLimit ?? DEFAULT_CARD_LIMIT)
    .map(({ item }) => item);

  return {
    commandMode,
    query,
    commands,
    cards,
  };
}
