import type { Card, Estimate, Priority } from "@/lib/types";
import { CARD_STATUS_LABELS, CARD_STATUS_ORDER, compareCardStatuses, type CardStatus } from "../../shared/card-status";
import {
  TOGGLE_LIST_EMPTY_PRIORITY_LABEL,
  DEFAULT_TOGGLE_LIST_SETTINGS,
  TOGGLE_LIST_PRIORITY_CHIP_LABELS,
  TOGGLE_LIST_PRIORITY_ORDER,
  TOGGLE_LIST_RANK_FIELD_LABELS,
} from "./toggle-list/types";
import {
  normalizePriorityClauseIncludeEmpty,
  priorityClauseIncludesEmpty,
} from "./toggle-list/priority-clause";

type WorkbenchView = "kanban" | "list" | "toggle-list" | "canvas" | "calendar";

export type SupportedDbView = "kanban" | "list" | "toggle-list";

export const SUPPORTED_DB_VIEWS: SupportedDbView[] = ["kanban", "list", "toggle-list"];

export const DB_VIEW_SORT_FIELDS = [
  "board-order",
  "status",
  "priority",
  "estimate",
  "created",
  "title",
  "tags",
  "assignee",
] as const;

export type DbViewSortField = (typeof DB_VIEW_SORT_FIELDS)[number];
export type DbViewSortDirection = "asc" | "desc";

export interface DbViewSortKey {
  field: DbViewSortField;
  direction: DbViewSortDirection;
}

export const DB_VIEW_SORT_FIELD_LABELS: Record<DbViewSortField, string> = {
  "board-order": "Board Order",
  status: "Status",
  priority: "Priority",
  estimate: "Estimate",
  created: "Created",
  title: "Title",
  tags: "Tags",
  assignee: "Assignee",
};

export type DbViewFilterClause =
  | { field: "status"; op: "in"; values: CardStatus[] }
  | { field: "priority"; op: "in"; values: Priority[]; includeEmpty?: boolean }
  | { field: "tags"; op: "hasAny" | "hasAll" | "hasNone"; values: string[] };

export interface DbViewFilterGroup {
  all: DbViewFilterClause[];
}

export interface DbViewFilterSpec {
  any: DbViewFilterGroup[];
}

export interface DbViewRules {
  filter: DbViewFilterSpec;
  sort: DbViewSortKey[];
}

export const DB_VIEW_DISPLAY_PROPERTY_KEYS = [
  "priority",
  "estimate",
  "status",
  "tags",
  "assignee",
] as const;

export type DbViewDisplayPropertyKey = (typeof DB_VIEW_DISPLAY_PROPERTY_KEYS)[number];

export const DB_VIEW_DISPLAY_PROPERTY_LABELS: Record<DbViewDisplayPropertyKey, string> = {
  priority: "Priority",
  estimate: "Estimate",
  status: "Status",
  tags: "Tags",
  assignee: "Assignee",
};

export interface DbViewDisplayPrefs {
  propertyOrder: DbViewDisplayPropertyKey[];
  hiddenProperties: DbViewDisplayPropertyKey[];
  showEmptyEstimate: boolean;
  showEmptyPriority: boolean;
}

export interface DbViewPrefs {
  rules: DbViewRules;
  summaryExpanded: boolean;
  display: DbViewDisplayPrefs;
}

export interface DbViewCardRecord extends Card {
  columnId: CardStatus;
  columnName: string;
  boardIndex: number;
}

interface FilterUnion<T> {
  found: boolean;
  includeEmpty: boolean;
  values: T[];
}

const DEFAULT_FILTER: DbViewFilterSpec = {
  any: [
        {
          all: [
            { field: "status", op: "in", values: [...CARD_STATUS_ORDER] },
            { field: "priority", op: "in", values: [...TOGGLE_LIST_PRIORITY_ORDER], includeEmpty: true },
          ],
        },
      ],
};

const DB_VIEW_DISPLAY_PROPERTIES_BY_VIEW: Record<SupportedDbView, readonly DbViewDisplayPropertyKey[]> = {
  kanban: ["priority", "estimate", "tags", "assignee"],
  list: [],
  "toggle-list": ["priority", "estimate", "status", "tags"],
};

const priorityRank = new Map(TOGGLE_LIST_PRIORITY_ORDER.map((priority, index) => [priority, index]));
const estimateRank = new Map<Estimate, number>(
  (["xs", "s", "m", "l", "xl"] as Estimate[]).map((estimate, index) => [estimate, index] as const),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSupportedDbView(value: WorkbenchView): value is SupportedDbView {
  return SUPPORTED_DB_VIEWS.includes(value as SupportedDbView);
}

export function viewSupportsDbViewPrefs(view: WorkbenchView): view is SupportedDbView {
  return isSupportedDbView(view);
}

export function getDefaultDbViewRules(view: SupportedDbView): DbViewRules {
  if (view === "kanban") {
    return {
      filter: cloneFilterSpec(DEFAULT_FILTER),
      sort: [{ field: "board-order", direction: "asc" }],
    };
  }

  if (view === "list") {
    return {
      filter: cloneFilterSpec(DEFAULT_FILTER),
      sort: [{ field: "created", direction: "desc" }],
    };
  }

  return {
    filter: cloneFilterSpec(DEFAULT_FILTER),
    sort: [
      { field: "board-order", direction: "asc" },
      { field: "created", direction: "desc" },
    ],
  };
}

export function getDefaultDbViewPrefs(view: SupportedDbView): DbViewPrefs {
  return {
    rules: getDefaultDbViewRules(view),
    summaryExpanded: true,
    display: getDefaultDbViewDisplayPrefs(view),
  };
}

export function normalizeDbViewPrefs(view: SupportedDbView, value: unknown): DbViewPrefs {
  const fallback = getDefaultDbViewPrefs(view);
  if (!isRecord(value)) return fallback;

  return {
    rules: normalizeDbViewRules(view, value.rules),
    summaryExpanded: typeof value.summaryExpanded === "boolean" ? value.summaryExpanded : fallback.summaryExpanded,
    display: normalizeDbViewDisplayPrefs(view, value.display ?? value.toggleListDisplay),
  };
}

export function normalizeDbViewRules(view: SupportedDbView, value: unknown): DbViewRules {
  const fallback = getDefaultDbViewRules(view);
  if (!isRecord(value)) return fallback;

  return {
    filter: normalizeFilterSpec(value.filter, fallback.filter),
    sort: normalizeSortKeys(value.sort, fallback.sort),
  };
}

export function getAvailableDisplayProperties(view: SupportedDbView): DbViewDisplayPropertyKey[] {
  return [...DB_VIEW_DISPLAY_PROPERTIES_BY_VIEW[view]];
}

export function viewSupportsDbViewDisplay(view: SupportedDbView): boolean {
  return getAvailableDisplayProperties(view).length > 0;
}

export function getDefaultDbViewDisplayPrefs(view: SupportedDbView): DbViewDisplayPrefs {
  if (view === "toggle-list") {
    return {
      propertyOrder: [...DEFAULT_TOGGLE_LIST_SETTINGS.propertyOrder],
      hiddenProperties: [...DEFAULT_TOGGLE_LIST_SETTINGS.hiddenProperties],
      showEmptyEstimate: DEFAULT_TOGGLE_LIST_SETTINGS.showEmptyEstimate,
      showEmptyPriority: DEFAULT_TOGGLE_LIST_SETTINGS.showEmptyPriority,
    };
  }

  if (view === "kanban") {
    return {
      propertyOrder: [...DB_VIEW_DISPLAY_PROPERTIES_BY_VIEW.kanban],
      hiddenProperties: [],
      showEmptyEstimate: false,
      showEmptyPriority: false,
    };
  }

  return {
    propertyOrder: [],
    hiddenProperties: [],
    showEmptyEstimate: false,
    showEmptyPriority: false,
  };
}

function normalizeDbViewDisplayPrefs(view: SupportedDbView, value: unknown): DbViewDisplayPrefs {
  const fallback = getDefaultDbViewDisplayPrefs(view);
  const availableProperties = getAvailableDisplayProperties(view);
  if (!isRecord(value)) {
    return {
      propertyOrder: [...fallback.propertyOrder],
      hiddenProperties: [...fallback.hiddenProperties],
      showEmptyEstimate: fallback.showEmptyEstimate,
      showEmptyPriority: fallback.showEmptyPriority,
    };
  }

  const propertyOrder = Array.isArray(value.propertyOrder)
    ? value.propertyOrder.filter(
      (item): item is DbViewDisplayPropertyKey =>
        typeof item === "string" && availableProperties.includes(item as DbViewDisplayPropertyKey),
    )
    : [];
  const hiddenProperties = Array.isArray(value.hiddenProperties)
    ? value.hiddenProperties.filter(
      (item): item is DbViewDisplayPropertyKey =>
        typeof item === "string" && availableProperties.includes(item as DbViewDisplayPropertyKey),
    )
    : [];

  const orderedProperties = Array.from(new Set(propertyOrder));
  for (const property of availableProperties) {
    if (!orderedProperties.includes(property)) {
      orderedProperties.push(property);
    }
  }

  return {
    propertyOrder: orderedProperties,
    hiddenProperties: Array.from(new Set(hiddenProperties)),
    showEmptyEstimate:
      typeof value.showEmptyEstimate === "boolean"
        ? value.showEmptyEstimate
        : fallback.showEmptyEstimate,
    showEmptyPriority:
      typeof value.showEmptyPriority === "boolean"
        ? value.showEmptyPriority
        : fallback.showEmptyPriority,
  };
}

function normalizeFilterSpec(value: unknown, fallback: DbViewFilterSpec): DbViewFilterSpec {
  if (!isRecord(value) || !Array.isArray(value.any)) {
    return cloneFilterSpec(fallback);
  }

  const groups = value.any
    .map((group) => normalizeFilterGroup(group))
    .filter((group): group is DbViewFilterGroup => Boolean(group));
  if (groups.length === 0) return cloneFilterSpec(fallback);

  return { any: groups };
}

function normalizeFilterGroup(value: unknown): DbViewFilterGroup | null {
  if (!isRecord(value) || !Array.isArray(value.all)) return null;

  const clauses = value.all
    .map((clause) => normalizeFilterClause(clause))
    .filter((clause): clause is DbViewFilterClause => Boolean(clause));

  return { all: clauses };
}

function normalizeFilterClause(value: unknown): DbViewFilterClause | null {
  if (!isRecord(value) || typeof value.field !== "string" || typeof value.op !== "string" || !Array.isArray(value.values)) {
    return null;
  }

  if (value.field === "status" && value.op === "in") {
    const values = Array.from(new Set(value.values.filter((item): item is CardStatus => typeof item === "string" && CARD_STATUS_ORDER.includes(item as CardStatus))));
    return { field: "status", op: "in", values };
  }

  if (value.field === "priority" && value.op === "in") {
    const values = Array.from(new Set(value.values.filter((item): item is Priority => typeof item === "string" && TOGGLE_LIST_PRIORITY_ORDER.includes(item as Priority))));
    return {
      field: "priority",
      op: "in",
      values,
      includeEmpty: normalizePriorityClauseIncludeEmpty(value.includeEmpty, values),
    };
  }

  if (value.field === "tags" && (value.op === "hasAny" || value.op === "hasAll" || value.op === "hasNone")) {
    return {
      field: "tags",
      op: value.op,
      values: Array.from(new Set(value.values.filter((item): item is string => typeof item === "string" && item.length > 0))),
    };
  }

  return null;
}

function normalizeSortKeys(value: unknown, fallback: DbViewSortKey[]): DbViewSortKey[] {
  if (!Array.isArray(value)) return cloneSortKeys(fallback);

  const next = value
    .map((entry) => normalizeSortKey(entry))
    .filter((entry): entry is DbViewSortKey => Boolean(entry));

  return next.length > 0 ? next : cloneSortKeys(fallback);
}

function normalizeSortKey(value: unknown): DbViewSortKey | null {
  if (!isRecord(value) || typeof value.field !== "string" || typeof value.direction !== "string") {
    return null;
  }

  if (!DB_VIEW_SORT_FIELDS.includes(value.field as DbViewSortField)) return null;
  if (value.direction !== "asc" && value.direction !== "desc") return null;

  return {
    field: value.field as DbViewSortField,
    direction: value.direction,
  };
}

export function cloneDbViewPrefs(prefs: DbViewPrefs): DbViewPrefs {
  return {
    rules: {
      filter: cloneFilterSpec(prefs.rules.filter),
      sort: cloneSortKeys(prefs.rules.sort),
    },
    summaryExpanded: prefs.summaryExpanded,
    display: {
      propertyOrder: [...prefs.display.propertyOrder],
      hiddenProperties: [...prefs.display.hiddenProperties],
      showEmptyEstimate: prefs.display.showEmptyEstimate,
      showEmptyPriority: prefs.display.showEmptyPriority,
    },
  };
}

function cloneFilterSpec(filter: DbViewFilterSpec): DbViewFilterSpec {
  return {
    any: filter.any.map((group) => ({
      all: group.all.map((clause) => ({
        ...clause,
        values: [...clause.values],
      })) as DbViewFilterClause[],
    })),
  };
}

function cloneSortKeys(sort: DbViewSortKey[]): DbViewSortKey[] {
  return sort.map((entry) => ({ ...entry }));
}

export function rulesEqual(left: DbViewRules, right: DbViewRules): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function hasActiveDbViewFilters(view: SupportedDbView, rules: DbViewRules): boolean {
  return JSON.stringify(normalizeFilterSpec(rules.filter, DEFAULT_FILTER)) !== JSON.stringify(getDefaultDbViewRules(view).filter);
}

export function hasActiveDbViewSorts(view: SupportedDbView, rules: DbViewRules): boolean {
  return JSON.stringify(normalizeSortKeys(rules.sort, getDefaultDbViewRules(view).sort)) !== JSON.stringify(getDefaultDbViewRules(view).sort);
}

export function hasActiveDbViewRules(view: SupportedDbView, rules: DbViewRules): boolean {
  return hasActiveDbViewFilters(view, rules) || hasActiveDbViewSorts(view, rules);
}

export function filterDbViewCards(
  cards: DbViewCardRecord[],
  rules: DbViewRules,
): DbViewCardRecord[] {
  return cards.filter((card) => matchesFilterSpec(card, rules.filter));
}

function matchesFilterSpec(card: DbViewCardRecord, filter: DbViewFilterSpec): boolean {
  if (filter.any.length === 0) return true;
  return filter.any.some((group) => group.all.every((clause) => matchesClause(card, clause)));
}

function matchesClause(card: DbViewCardRecord, clause: DbViewFilterClause): boolean {
  if (clause.field === "status") {
    return clause.values.includes(card.columnId);
  }
  if (clause.field === "priority") {
    const includeEmpty = priorityClauseIncludesEmpty(clause);
    if (!card.priority) return includeEmpty;
    return clause.values.includes(card.priority);
  }

  const valueSet = new Set(clause.values);
  if (clause.op === "hasAll") {
    for (const value of valueSet) {
      if (!card.tags.includes(value)) return false;
    }
    return true;
  }
  if (clause.op === "hasNone") {
    return !card.tags.some((tag) => valueSet.has(tag));
  }
  return card.tags.some((tag) => valueSet.has(tag));
}

export function sortDbViewCards(
  cards: DbViewCardRecord[],
  rules: DbViewRules,
): DbViewCardRecord[] {
  const sortKeys = rules.sort.length > 0 ? rules.sort : [{ field: "board-order", direction: "asc" } satisfies DbViewSortKey];

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
  left: DbViewCardRecord,
  right: DbViewCardRecord,
  field: DbViewSortField,
  direction: DbViewSortDirection,
): number {
  const sign = direction === "asc" ? 1 : -1;

  switch (field) {
    case "board-order":
      return (left.boardIndex - right.boardIndex) * sign;
    case "status":
      return compareCardStatuses(left.columnId, right.columnId) * sign;
    case "priority":
      if (!left.priority && !right.priority) return 0;
      if (!left.priority) return 1;
      if (!right.priority) return -1;
      return ((priorityRank.get(left.priority) ?? 0) - (priorityRank.get(right.priority) ?? 0)) * sign;
    case "estimate": {
      const leftRank = left.estimate ? (estimateRank.get(left.estimate) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
      const rightRank = right.estimate ? (estimateRank.get(right.estimate) ?? Number.POSITIVE_INFINITY) : Number.POSITIVE_INFINITY;
      return (leftRank - rightRank) * sign;
    }
    case "created":
      return (new Date(left.created).getTime() - new Date(right.created).getTime()) * sign;
    case "title":
      return left.title.localeCompare(right.title) * sign;
    case "tags":
      return normalizeTagSortValue(left.tags).localeCompare(normalizeTagSortValue(right.tags)) * sign;
    case "assignee":
      return (left.assignee ?? "").localeCompare(right.assignee ?? "") * sign;
    default:
      return 0;
  }
}

function normalizeTagSortValue(tags: string[]): string {
  return [...tags].sort((left, right) => left.localeCompare(right)).join(",");
}

export function getAvailableSortFields(view: SupportedDbView): DbViewSortField[] {
  if (view === "kanban") {
    return ["board-order", "priority", "estimate", "created", "title"];
  }
  if (view === "list") {
    return ["tags", "title", "status", "priority", "estimate", "assignee", "created"];
  }
  return ["board-order", "status", "priority", "estimate", "created", "title"];
}

export function summarizeFilterClauses(rules: DbViewRules): Array<{ key: string; label: string; value: string }> {
  const statusValues = collectUnion<CardStatus>(
    rules.filter,
    "status",
    (value): value is CardStatus => CARD_STATUS_ORDER.includes(value as CardStatus),
  );
  const priorityValues = collectUnion<Priority>(
    rules.filter,
    "priority",
    (value): value is Priority => TOGGLE_LIST_PRIORITY_ORDER.includes(value as Priority),
  );
  const tagClause = resolveTagClause(rules.filter);
  const summaries: Array<{ key: string; label: string; value: string }> = [];

  if (statusValues.found && statusValues.values.length > 0 && statusValues.values.length < CARD_STATUS_ORDER.length) {
    summaries.push({
      key: "status",
      label: "Status",
      value: statusValues.values.map((status) => CARD_STATUS_LABELS[status]).join(", "),
    });
  }

  const totalPriorityCount = TOGGLE_LIST_PRIORITY_ORDER.length + 1;
  const selectedPriorityCount = priorityValues.values.length + (priorityValues.includeEmpty ? 1 : 0);
  if (priorityValues.found && selectedPriorityCount > 0 && selectedPriorityCount < totalPriorityCount) {
    summaries.push({
      key: "priority",
      label: "Priority",
      value: [
        ...priorityValues.values.map((priority) => TOGGLE_LIST_PRIORITY_CHIP_LABELS[priority]),
        ...(priorityValues.includeEmpty ? [TOGGLE_LIST_EMPTY_PRIORITY_LABEL] : []),
      ].join(", "),
    });
  }

  if (tagClause && tagClause.values.length > 0) {
    const modeLabel = tagClause.op === "hasAny" ? "any" : tagClause.op === "hasAll" ? "all" : "none";
    summaries.push({
      key: "tags",
      label: `Tags (${modeLabel})`,
      value: tagClause.values.join(", "),
    });
  }

  return summaries;
}

export function summarizeSorts(rules: DbViewRules): Array<{ key: string; label: string; value: string }> {
  return rules.sort.map((entry, index) => ({
    key: `${entry.field}:${index}`,
    label: TOGGLE_LIST_RANK_FIELD_LABELS[entry.field as keyof typeof TOGGLE_LIST_RANK_FIELD_LABELS]
      ?? DB_VIEW_SORT_FIELD_LABELS[entry.field],
    value: entry.direction === "asc" ? "Ascending" : "Descending",
  }));
}

function collectUnion<T>(
  filter: DbViewFilterSpec,
  field: DbViewFilterClause["field"],
  predicate: (value: unknown) => value is T,
): FilterUnion<T> {
  const values = new Set<T>();
  let found = false;
  let includeEmpty = false;

  for (const group of filter.any) {
    for (const clause of group.all) {
      if (clause.field !== field) continue;
      found = true;
      if (
        field === "priority"
        && clause.field === "priority"
        && priorityClauseIncludesEmpty(clause)
      ) {
        includeEmpty = true;
      }
      for (const value of clause.values) {
        if (predicate(value)) {
          values.add(value);
        }
      }
    }
  }

  return { found, includeEmpty, values: Array.from(values) };
}

function resolveTagClause(filter: DbViewFilterSpec): Extract<DbViewFilterClause, { field: "tags" }> | null {
  for (const group of filter.any) {
    for (const clause of group.all) {
      if (clause.field === "tags") {
        return clause;
      }
    }
  }

  return null;
}
