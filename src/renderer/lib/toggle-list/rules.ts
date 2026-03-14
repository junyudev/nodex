import { buildCardSearchText, matchesSearchTokens, tokenizeSearchQuery } from "../card-search";
import type {
  ToggleListCard,
  ToggleListClause,
  ToggleListFilterGroup,
  ToggleListFilterSpec,
  ToggleListRankField,
  ToggleListSettings,
  ToggleListSortKey,
  ToggleListTagFilterMode,
} from "./types";
import {
  TOGGLE_LIST_PRIORITY_ORDER,
  TOGGLE_LIST_STATUS_ORDER,
} from "./types";
import { priorityClauseIncludesEmpty } from "./priority-clause";

const priorityRank = new Map(TOGGLE_LIST_PRIORITY_ORDER.map((priority, index) => [priority, index]));
const statusRank = new Map(TOGGLE_LIST_STATUS_ORDER.map((status, index) => [status, index]));
const estimateRank = new Map(
  ["xs", "s", "m", "l", "xl"].map((estimate, index) => [estimate, index]),
);

export function filterCards(
  cards: ToggleListCard[],
  settings: ToggleListSettings,
  searchQuery: string,
  options?: {
    excludedCardIds?: ReadonlySet<string>;
  },
): ToggleListCard[] {
  const searchTokens = tokenizeSearchQuery(searchQuery);
  const rulesV2 = settings.rulesV2;
  const excludedCardIds = options?.excludedCardIds;

  return cards.filter((card) => {
    if (excludedCardIds?.has(card.id)) return false;
    if (!matchesFilterSpec(card, rulesV2.filter)) return false;
    if (searchTokens.length === 0) return true;

    const searchable = `${buildCardSearchText(card)} ${card.columnName.toLowerCase()}`;
    return matchesSearchTokens(searchable, searchTokens);
  });
}

function matchesFilterSpec(
  card: ToggleListCard,
  filter: ToggleListFilterSpec,
): boolean {
  if (filter.any.length === 0) return true;
  return filter.any.some((group) => matchesFilterGroup(card, group));
}

function matchesFilterGroup(
  card: ToggleListCard,
  group: ToggleListFilterGroup,
): boolean {
  for (const clause of group.all) {
    if (!matchesClause(card, clause)) return false;
  }
  return true;
}

function matchesClause(
  card: ToggleListCard,
  clause: ToggleListClause,
): boolean {
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

export function rankCards(
  cards: ToggleListCard[],
  settings: ToggleListSettings,
): ToggleListCard[] {
  const rulesV2 = settings.rulesV2;
  const fallbackSort: ToggleListSortKey[] = [
    { field: "board-order", direction: "asc" },
    { field: "created", direction: "desc" },
  ];
  const sortKeys = rulesV2.sort.length > 0 ? rulesV2.sort : fallbackSort;

  return [...cards].sort((left, right) => {
    for (const key of sortKeys) {
      const result = compareByField(left, right, key.field, key.direction);
      if (result !== 0) return result;
    }

    const fallback = compareByField(left, right, "board-order", "asc");
    if (fallback !== 0) return fallback;

    return left.id.localeCompare(right.id);
  });
}

function compareByField(
  left: ToggleListCard,
  right: ToggleListCard,
  field: ToggleListRankField,
  direction: "asc" | "desc",
): number {
  const sign = direction === "asc" ? 1 : -1;

  switch (field) {
    case "board-order":
      return (left.boardIndex - right.boardIndex) * sign;
    case "status":
      return ((statusRank.get(left.columnId) ?? 0) - (statusRank.get(right.columnId) ?? 0)) * sign;
    case "priority":
      if (!left.priority && !right.priority) return 0;
      if (!left.priority) return 1;
      if (!right.priority) return -1;
      return ((priorityRank.get(left.priority) ?? 0) - (priorityRank.get(right.priority) ?? 0)) * sign;
    case "estimate": {
      const leftRank = estimateRank.get(left.estimate ?? "") ?? Number.POSITIVE_INFINITY;
      const rightRank = estimateRank.get(right.estimate ?? "") ?? Number.POSITIVE_INFINITY;
      return (leftRank - rightRank) * sign;
    }
    case "created":
      return (new Date(left.created).getTime() - new Date(right.created).getTime()) * sign;
    case "title":
      return left.title.localeCompare(right.title) * sign;
    default:
      return 0;
  }
}
