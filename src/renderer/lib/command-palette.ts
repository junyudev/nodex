import type { FileSearchMatch } from "../../shared/file-search";
import { matchesSearchTokens, tokenizeSearchQuery } from "./page-search";
import { buildCommandPaletteCharacterHighlightSegments } from "./command-palette-highlight";
import { normalizeSearchText } from "./search-text";
import {
  createCommandPaletteThreadSearchIndex,
  type CommandPaletteThreadSearchIndex,
} from "./command-palette-thread-search";
import { WORKFLOW_STATUS_LABELS, WORKFLOW_STATUS_ORDER } from "../../shared/workflow-status";
import type { WorkflowStatus } from "../../shared/workflow-status";
import {
  TOGGLE_LIST_EMPTY_PRIORITY_LABEL,
  TOGGLE_LIST_PRIORITY_CHIP_LABELS,
  TOGGLE_LIST_PRIORITY_ORDER,
  type ToggleListTagFilterMode,
} from "./toggle-list/types";
import { isPriority } from "../../shared/priority";
import { upgradeLegacyPriority } from "../../shared/priority-cutover";
import type {
  DatabasePageSummary,
  CodexThreadActiveFlag,
  CodexThreadStatusType,
  Priority,
} from "./types";
import type { ProjectAppearance } from "../../shared/project-appearance";

export interface CommandPaletteCommand {
  kind: "command";
  id: string;
  title: string;
  subtitle: string;
  keywords: string[];
  group: CommandPaletteCommandGroup;
  shortcut?: string;
  active?: boolean;
  disabled?: boolean;
  disabledReason?: string;
  mockReason?: string;
  priority: number;
  searchTitleSegments?: CommandPalettePageSearchPreviewSegment[] | null;
}

export type CommandMenuMode = "root" | "chats" | "pages" | "files";

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
  | "Skills"
  | "App";

export interface CommandPalettePage {
  kind: "page";
  id: string;
  projectId: string;
  projectName: string;
  projectAppearance: ProjectAppearance;
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
        assignee: string | null;
      };
  /** Registry-resolved display labels; canonical option IDs stay on page.tags. */
  tagLabels: string[];
  inActiveProject: boolean;
  recentIndex: number | null;
  boardIndex: number;
  searchPreview?: CommandPalettePageSearchPreview | null;
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

export interface CommandPaletteThreadSearchPreview {
  excerpt: string;
  segments: CommandPalettePageSearchPreviewSegment[];
  source: "metadata" | "content";
}

export interface CommandPaletteThreadSearchDecorations {
  titleSegments?: CommandPalettePageSearchPreviewSegment[] | null;
  projectNameSegments?: CommandPalettePageSearchPreviewSegment[] | null;
  cwdSegments?: CommandPalettePageSearchPreviewSegment[] | null;
  gitBranchSegments?: CommandPalettePageSearchPreviewSegment[] | null;
}

export interface CommandPaletteThread {
  kind: "thread";
  id: string;
  threadId: string;
  sessionId: string | null;
  projectId: string | null;
  projectName: string | null;
  title: string;
  preview: string;
  cwd: string | null;
  gitBranch: string | null;
  projectless: boolean;
  pinned: boolean;
  pinnedOrder: number | null;
  statusType: CodexThreadStatusType;
  statusActiveFlags: CodexThreadActiveFlag[];
  createdAt: number;
  updatedAt: number;
  inActiveProject: boolean;
  searchPreview?: CommandPaletteThreadSearchPreview | null;
  searchDecorations?: CommandPaletteThreadSearchDecorations | null;
}

export interface CommandPaletteResults {
  mode: CommandMenuMode;
  query: string;
  commands: CommandPaletteCommand[];
  pages: CommandPalettePage[];
  threads: CommandPaletteThread[];
}

interface ScoredCommand {
  item: CommandPaletteCommand;
  score: number;
}

const normalizeCommandPaletteSearchText = normalizeSearchText;

interface ScoredThread {
  item: CommandPaletteThread;
  score: number;
}

export interface CommandPalettePageFilters {
  statuses: DatabasePageSummary["status"][];
  priorities: Priority[];
  includeEmptyPriority: boolean;
  tags: string[];
  tagMode: ToggleListTagFilterMode;
  assignees: string[];
  projectIds: string[];
}

const DEFAULT_THREAD_LIMIT = 8;
export const COMMAND_PALETTE_PAGE_FILTERS_STORAGE_KEY = "nodex-command-palette-page-filters-v2";
export const LEGACY_COMMAND_PALETTE_PAGE_FILTERS_STORAGE_KEY =
  "nodex-command-palette-page-filters-v1";
const TAG_FILTER_MODES = new Set<ToggleListTagFilterMode>(["any", "all", "none"]);

function dedupeArray<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function readRawFilterStorageValue(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeRawFilterStorageValue(value: string): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(COMMAND_PALETTE_PAGE_FILTERS_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

function removeLegacyRawFilterStorageValue(): void {
  try {
    localStorage.removeItem(LEGACY_COMMAND_PALETTE_PAGE_FILTERS_STORAGE_KEY);
  } catch {
    // A retained v1 value is safe and can be retried on the next load.
  }
}

export function getDefaultCommandPalettePageFilters(): CommandPalettePageFilters {
  return {
    statuses: [...WORKFLOW_STATUS_ORDER],
    priorities: [...TOGGLE_LIST_PRIORITY_ORDER],
    includeEmptyPriority: true,
    tags: [],
    tagMode: "any",
    assignees: [],
    projectIds: [],
  };
}

export function cloneCommandPalettePageFilters(
  filters: CommandPalettePageFilters,
): CommandPalettePageFilters {
  return {
    statuses: [...filters.statuses],
    priorities: [...filters.priorities],
    includeEmptyPriority: filters.includeEmptyPriority,
    tags: [...filters.tags],
    tagMode: filters.tagMode,
    assignees: [...filters.assignees],
    projectIds: [...filters.projectIds],
  };
}

export function areCommandPalettePageFiltersEqual(
  left: CommandPalettePageFilters,
  right: CommandPalettePageFilters,
): boolean {
  return (
    left.includeEmptyPriority === right.includeEmptyPriority &&
    left.tagMode === right.tagMode &&
    left.statuses.length === right.statuses.length &&
    left.statuses.every((value, index) => value === right.statuses[index]) &&
    left.priorities.length === right.priorities.length &&
    left.priorities.every((value, index) => value === right.priorities[index]) &&
    left.tags.length === right.tags.length &&
    left.tags.every((value, index) => value === right.tags[index]) &&
    left.assignees.length === right.assignees.length &&
    left.assignees.every((value, index) => value === right.assignees[index]) &&
    left.projectIds.length === right.projectIds.length &&
    left.projectIds.every((value, index) => value === right.projectIds[index])
  );
}

function normalizeSelectableStrings(
  value: unknown,
  fallback: string[],
  allowedValues?: ReadonlySet<string>,
): string[] {
  if (!Array.isArray(value)) {
    return [...fallback];
  }

  const filteredValues = value
    .filter((item): item is string => typeof item === "string")
    .filter((item) => !allowedValues || allowedValues.has(item));
  return dedupeArray(filteredValues);
}

export function normalizeCommandPalettePageFilters(
  value: unknown,
  options?: {
    allowedTags?: readonly string[];
    allowedAssignees?: readonly string[];
    allowedProjectIds?: readonly string[];
  },
): CommandPalettePageFilters {
  const fallback = getDefaultCommandPalettePageFilters();
  if (!value || typeof value !== "object") {
    return fallback;
  }

  const candidate = value as Record<string, unknown>;
  const allowedTags = options?.allowedTags ? new Set(options.allowedTags) : undefined;
  const allowedAssignees = options?.allowedAssignees
    ? new Set(options.allowedAssignees)
    : undefined;
  const allowedProjectIds = options?.allowedProjectIds
    ? new Set(options.allowedProjectIds)
    : undefined;

  return {
    statuses: normalizeSelectableStrings(candidate.statuses, fallback.statuses).filter(
      (status): status is DatabasePageSummary["status"] =>
        WORKFLOW_STATUS_ORDER.includes(status as DatabasePageSummary["status"]),
    ),
    priorities: normalizeSelectableStrings(candidate.priorities, fallback.priorities).filter(
      isPriority,
    ),
    includeEmptyPriority:
      typeof candidate.includeEmptyPriority === "boolean"
        ? candidate.includeEmptyPriority
        : fallback.includeEmptyPriority,
    tags: normalizeSelectableStrings(candidate.tags, fallback.tags, allowedTags),
    tagMode:
      typeof candidate.tagMode === "string" &&
      TAG_FILTER_MODES.has(candidate.tagMode as ToggleListTagFilterMode)
        ? (candidate.tagMode as ToggleListTagFilterMode)
        : fallback.tagMode,
    assignees: normalizeSelectableStrings(
      candidate.assignees,
      fallback.assignees,
      allowedAssignees,
    ),
    projectIds: normalizeSelectableStrings(
      candidate.projectIds,
      fallback.projectIds,
      allowedProjectIds,
    ),
  };
}

export function normalizeLegacyCommandPalettePageFilters(
  value: unknown,
  options?: Parameters<typeof normalizeCommandPalettePageFilters>[1],
): CommandPalettePageFilters {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return normalizeCommandPalettePageFilters(value, options);
  }
  const candidate = value as Record<string, unknown>;
  const priorities = Array.isArray(candidate.priorities)
    ? candidate.priorities.flatMap((value) => {
        const priority = upgradeLegacyPriority(value);
        return priority ? [priority] : [];
      })
    : candidate.priorities;
  return normalizeCommandPalettePageFilters(
    {
      ...candidate,
      priorities,
    },
    options,
  );
}

export function readCommandPalettePageFilters(
  options?: Parameters<typeof normalizeCommandPalettePageFilters>[1],
): CommandPalettePageFilters {
  try {
    const raw = readRawFilterStorageValue(COMMAND_PALETTE_PAGE_FILTERS_STORAGE_KEY);
    if (raw) {
      return normalizeCommandPalettePageFilters(JSON.parse(raw) as unknown, options);
    }

    const legacyRaw = readRawFilterStorageValue(LEGACY_COMMAND_PALETTE_PAGE_FILTERS_STORAGE_KEY);
    if (!legacyRaw) return normalizeCommandPalettePageFilters(null, options);
    const migrated = normalizeLegacyCommandPalettePageFilters(
      JSON.parse(legacyRaw) as unknown,
      options,
    );
    if (writeRawFilterStorageValue(JSON.stringify(migrated))) {
      removeLegacyRawFilterStorageValue();
    }
    return migrated;
  } catch {
    return normalizeCommandPalettePageFilters(null, options);
  }
}

export function writeCommandPalettePageFilters(
  filters: CommandPalettePageFilters,
): CommandPalettePageFilters {
  const normalized = normalizeCommandPalettePageFilters(filters);
  writeRawFilterStorageValue(JSON.stringify(normalized));
  return normalized;
}

export function hasActiveCommandPalettePageFilters(filters: CommandPalettePageFilters): boolean {
  if (filters.statuses.length !== WORKFLOW_STATUS_ORDER.length) {
    return true;
  }

  if (
    filters.priorities.length !== TOGGLE_LIST_PRIORITY_ORDER.length ||
    !filters.includeEmptyPriority
  ) {
    return true;
  }

  return filters.tags.length > 0 || filters.assignees.length > 0 || filters.projectIds.length > 0;
}

export function summarizeCommandPalettePageFilters(
  filters: CommandPalettePageFilters,
  projectNameById: ReadonlyMap<string, string>,
  tagNameById: ReadonlyMap<string, string> = new Map(),
): Array<{ key: string; label: string; value: string }> {
  const summaries: Array<{ key: string; label: string; value: string }> = [];

  if (filters.statuses.length > 0 && filters.statuses.length < WORKFLOW_STATUS_ORDER.length) {
    summaries.push({
      key: "status",
      label: "Status",
      value: filters.statuses.map((status) => WORKFLOW_STATUS_LABELS[status]).join(", "),
    });
  }

  const selectedPriorityCount = filters.priorities.length + (filters.includeEmptyPriority ? 1 : 0);
  const totalPriorityCount = TOGGLE_LIST_PRIORITY_ORDER.length + 1;
  if (selectedPriorityCount > 0 && selectedPriorityCount < totalPriorityCount) {
    summaries.push({
      key: "priority",
      label: "Priority",
      value: [
        ...filters.priorities.map((priority) => TOGGLE_LIST_PRIORITY_CHIP_LABELS[priority]),
        ...(filters.includeEmptyPriority ? [TOGGLE_LIST_EMPTY_PRIORITY_LABEL] : []),
      ].join(", "),
    });
  }

  if (filters.tags.length > 0) {
    const modeLabel =
      filters.tagMode === "any" ? "any" : filters.tagMode === "all" ? "all" : "none";
    summaries.push({
      key: "tags",
      label: `Tags (${modeLabel})`,
      value: filters.tags.map((tag) => tagNameById.get(tag) ?? tag).join(", "),
    });
  }

  if (filters.assignees.length > 0) {
    summaries.push({
      key: "assignees",
      label: "Assignee",
      value: filters.assignees.join(", "),
    });
  }

  if (filters.projectIds.length > 0) {
    summaries.push({
      key: "projects",
      label: "Project",
      value: filters.projectIds
        .map((projectId) => projectNameById.get(projectId) ?? projectId)
        .join(", "),
    });
  }

  return summaries;
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
  return normalizeCommandPaletteSearchText(
    [item.title, item.subtitle, item.keywords.join(" ")].join(" "),
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

function compareActiveProjectItems(
  left: { inActiveProject: boolean },
  right: { inActiveProject: boolean },
): number {
  if (left.inActiveProject === right.inActiveProject) return 0;
  return left.inActiveProject ? -1 : 1;
}

export function prioritizeActiveProjectItems<T extends { inActiveProject: boolean }>(
  items: readonly T[],
): T[] {
  const activeItems: T[] = [];
  const otherItems: T[] = [];
  items.forEach((item) => {
    if (item.inActiveProject) {
      activeItems.push(item);
      return;
    }

    otherItems.push(item);
  });

  return [...activeItems, ...otherItems];
}

function compareDefaultThreads(left: CommandPaletteThread, right: CommandPaletteThread): number {
  if (left.pinned !== right.pinned) {
    return left.pinned ? -1 : 1;
  }

  if (left.pinned && right.pinned) {
    const leftPinnedOrder = left.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
    const rightPinnedOrder = right.pinnedOrder ?? Number.MAX_SAFE_INTEGER;
    if (leftPinnedOrder !== rightPinnedOrder) {
      return leftPinnedOrder - rightPinnedOrder;
    }
  }

  if (right.updatedAt !== left.updatedAt) {
    return right.updatedAt - left.updatedAt;
  }

  return left.title.localeCompare(right.title);
}

function compareScoredThreads(left: ScoredThread, right: ScoredThread): number {
  if (right.score !== left.score) return right.score - left.score;
  return compareDefaultThreads(left.item, right.item);
}

function compareScoredThreadsWithActiveProjectPriority(
  left: ScoredThread,
  right: ScoredThread,
): number {
  return compareActiveProjectItems(left.item, right.item) || compareScoredThreads(left, right);
}

export function filterCommandPaletteItems(input: {
  query: string;
  mode: CommandMenuMode;
  commands: readonly CommandPaletteCommand[];
  pages: readonly CommandPalettePage[];
  threads?: readonly CommandPaletteThread[];
  threadSearchIndex?: CommandPaletteThreadSearchIndex | null;
  commandLimit?: number;
  threadLimit?: number;
  preferActiveProject?: boolean;
}): CommandPaletteResults {
  const query = normalizeCommandPaletteSearchText(input.query.trimStart());
  const tokens = tokenizeSearchQuery(query);
  const preferActiveProject = input.preferActiveProject ?? false;

  if (input.mode === "root") {
    const commands = input.commands
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
      threads: [],
    };
  }

  if (input.mode === "chats") {
    const threadItems = input.threads ?? [];
    const threads = query
      ? (input.threadSearchIndex === undefined
          ? createCommandPaletteThreadSearchIndex(threadItems).search(query)
          : (input.threadSearchIndex?.search(query) ?? [])
        )
          .sort(
            preferActiveProject
              ? compareScoredThreadsWithActiveProjectPriority
              : compareScoredThreads,
          )
          .slice(0, input.threadLimit ?? DEFAULT_THREAD_LIMIT)
          .map(({ item }) => item)
      : (preferActiveProject
          ? prioritizeActiveProjectItems(threadItems)
          : threadItems.slice()
        ).slice(0, input.threadLimit ?? DEFAULT_THREAD_LIMIT);

    return {
      mode: input.mode,
      query,
      commands: [],
      pages: [],
      threads,
    };
  }

  if (input.mode === "files") {
    return {
      mode: input.mode,
      query,
      commands: [],
      pages: [],
      threads: [],
    };
  }

  return {
    mode: input.mode,
    query,
    commands: [],
    pages: [],
    threads: [],
  };
}

export interface CommandPaletteFile {
  readonly kind: "file";
  readonly id: string;
  readonly file: FileSearchMatch;
}
