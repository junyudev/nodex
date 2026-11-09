import {
  buildPageSearchText,
  compilePageCollectionSearchQuery,
  matchesPageCollectionSearchQuery,
} from "../page-search";
import type {
  ToggleListCard,
  ToggleListClause,
  ToggleListFilterGroup,
  ToggleListFilterSpec,
  ToggleListSettings,
  ToggleListSortKey,
  ToggleListTagFilterMode,
} from "./types";
import { TOGGLE_LIST_PRIORITY_ORDER, TOGGLE_LIST_STATUS_ORDER } from "./types";
import { priorityClauseIncludesEmpty } from "./priority-clause";
import { compareNullableRanks } from "../sort-empty-placement";
import type { DatabasePageSummary } from "../types";
import type { Member } from "../../../shared/work-graph";

const priorityRank = new Map(
  TOGGLE_LIST_PRIORITY_ORDER.map((priority, index) => [priority, index]),
);
const statusRank = new Map(TOGGLE_LIST_STATUS_ORDER.map((status, index) => [status, index]));
const estimateRank = new Map(
  ["xs", "s", "m", "l", "xl"].map((estimate, index) => [estimate, index]),
);

type ToggleListFilterableCard = Pick<
  DatabasePageSummary,
  "id" | "pageKey" | "title" | "priority" | "estimate" | "tags" | "created" | "assignee"
> & {
  descriptionPreview?: string;
  status?: DatabasePageSummary["status"];
  archived?: boolean;
  order?: number;
  columnId: ToggleListCard["columnId"];
  columnName: string;
  boardIndex: number;
};

export function filterCards<T extends ToggleListFilterableCard>(
  cards: T[],
  settings: ToggleListSettings,
  searchQuery: string,
  options?: {
    excludedPageIds?: ReadonlySet<string>;
    members?: readonly Member[];
  },
): T[] {
  const compiledSearch = compilePageCollectionSearchQuery(searchQuery);
  const rulesV2 = settings.rulesV2;
  const excludedPageIds = options?.excludedPageIds;

  return cards.filter((card) => {
    if (excludedPageIds?.has(card.id)) return false;
    if (!matchesFilterSpec(card, rulesV2.filter)) return false;
    if (!compiledSearch.normalizedQuery) return true;

    const searchable = `${buildPageSearchText(
      {
        id: card.id,
        pageKey: card.pageKey,
        title: card.title,
        descriptionPreview: card.descriptionPreview ?? "",
        assignee: card.assignee,
      },
      [],
      options?.members,
    )} ${card.columnName.toLowerCase()}`;
    return matchesPageCollectionSearchQuery(card.pageKey, searchable, compiledSearch);
  });
}

function matchesFilterSpec(card: ToggleListFilterableCard, filter: ToggleListFilterSpec): boolean {
  if (filter.any.length === 0) return true;
  return filter.any.some((group) => matchesFilterGroup(card, group));
}

function matchesFilterGroup(card: ToggleListFilterableCard, group: ToggleListFilterGroup): boolean {
  for (const clause of group.all) {
    if (!matchesClause(card, clause)) return false;
  }
  return true;
}

function matchesClause(card: ToggleListFilterableCard, clause: ToggleListClause): boolean {
  if (clause.field === "status") {
    return clause.values.includes(card.columnId);
  }
  if (clause.field === "priority") {
    const includeEmpty = priorityClauseIncludesEmpty(clause);
    if (!card.priority) return includeEmpty;
    return clause.values.includes(card.priority);
  }

  const tagSet = new Set(clause.values);
  return matchesTagFilter(card.tags, tagSet, clause.op);
}

function matchesTagFilter(
  cardTags: string[],
  selectedTags: ReadonlySet<string>,
  mode: ToggleListTagFilterMode | "hasAny" | "hasAll" | "hasNone",
): boolean {
  if (mode === "hasAny" || mode === "any") {
    return cardTags.some((tag) => selectedTags.has(tag));
  }
  if (mode === "hasAll" || mode === "all") {
    for (const tag of selectedTags) {
      if (!cardTags.includes(tag)) return false;
    }
    return true;
  }
  return !cardTags.some((tag) => selectedTags.has(tag));
}

export function rankCards<T extends ToggleListFilterableCard>(
  cards: T[],
  settings: ToggleListSettings,
): T[] {
  const rulesV2 = settings.rulesV2;
  const fallbackSort: ToggleListSortKey[] = [
    { field: "board-order", direction: "asc" },
    { field: "created", direction: "desc" },
  ];
  const sortKeys = rulesV2.sort.length > 0 ? rulesV2.sort : fallbackSort;

  return [...cards].sort((left, right) => {
    for (const key of sortKeys) {
      const result = compareBySortKey(left, right, key);
      if (result !== 0) return result;
    }

    const fallback = compareBySortKey(left, right, { field: "board-order", direction: "asc" });
    if (fallback !== 0) return fallback;

    return left.id.localeCompare(right.id);
  });
}

function compareBySortKey(
  left: ToggleListFilterableCard,
  right: ToggleListFilterableCard,
  sortKey: ToggleListSortKey,
): number {
  const sign = sortKey.direction === "asc" ? 1 : -1;

  switch (sortKey.field) {
    case "board-order":
      return (left.boardIndex - right.boardIndex) * sign;
    case "status":
      return ((statusRank.get(left.columnId) ?? 0) - (statusRank.get(right.columnId) ?? 0)) * sign;
    case "priority":
      return compareNullableRanks({
        leftRank: left.priority ? (priorityRank.get(left.priority) ?? null) : null,
        rightRank: right.priority ? (priorityRank.get(right.priority) ?? null) : null,
        direction: sortKey.direction,
        emptyPlacement: sortKey.emptyPlacement,
      });
    case "estimate": {
      return compareNullableRanks({
        leftRank: left.estimate ? (estimateRank.get(left.estimate) ?? null) : null,
        rightRank: right.estimate ? (estimateRank.get(right.estimate) ?? null) : null,
        direction: sortKey.direction,
        emptyPlacement: sortKey.emptyPlacement,
      });
    }
    case "created":
      return (new Date(left.created).getTime() - new Date(right.created).getTime()) * sign;
    case "title":
      return left.title.localeCompare(right.title) * sign;
    default:
      return 0;
  }
}
