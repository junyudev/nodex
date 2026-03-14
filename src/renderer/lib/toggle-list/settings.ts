import type { Priority } from "@/lib/types";
import type {
  ToggleListClause,
  ToggleListFilterGroup,
  ToggleListFilterRule,
  ToggleListFilterSpec,
  ToggleListPropertyKey,
  ToggleListRankDirection,
  ToggleListRankField,
  ToggleListRulesV2,
  ToggleListSettings,
  ToggleListSortKey,
  ToggleListStatusId,
} from "./types";
import {
  DEFAULT_TOGGLE_LIST_SETTINGS,
  TOGGLE_LIST_PRIORITY_ORDER,
  TOGGLE_LIST_PROPERTY_KEYS,
  TOGGLE_LIST_RANK_FIELDS,
  TOGGLE_LIST_STATUS_ORDER,
} from "./types";
import {
  normalizePriorityClauseIncludeEmpty,
  priorityClauseIncludesEmpty,
} from "./priority-clause";

const DEFAULT_FILTER_RULE: ToggleListFilterRule = {
  statuses: [...TOGGLE_LIST_STATUS_ORDER],
  priorities: [...TOGGLE_LIST_PRIORITY_ORDER],
  includeEmptyPriority: true,
  tags: [],
  tagMode: "any",
  includeHostCard: false,
};

const DEFAULT_SORT: ToggleListSortKey[] = [
  { field: "board-order", direction: "asc" },
  { field: "created", direction: "desc" },
];

export function getDefaultToggleListSettings(): ToggleListSettings {
  return {
    rulesV2: cloneRulesV2(DEFAULT_TOGGLE_LIST_SETTINGS.rulesV2),
    propertyOrder: [...DEFAULT_TOGGLE_LIST_SETTINGS.propertyOrder],
    hiddenProperties: [...DEFAULT_TOGGLE_LIST_SETTINGS.hiddenProperties],
    showEmptyEstimate: DEFAULT_TOGGLE_LIST_SETTINGS.showEmptyEstimate,
    showEmptyPriority: DEFAULT_TOGGLE_LIST_SETTINGS.showEmptyPriority,
  };
}

export function normalizeToggleListSettings(value: unknown): ToggleListSettings {
  const fallback = getDefaultToggleListSettings();
  if (!isRecord(value)) return fallback;

  const propertyOrder = normalizePropertyOrder(value.propertyOrder);
  const hiddenProperties = Array.isArray(value.hiddenProperties)
    ? value.hiddenProperties.filter((property): property is ToggleListPropertyKey =>
      typeof property === "string" && TOGGLE_LIST_PROPERTY_KEYS.includes(property as ToggleListPropertyKey),
    )
    : [];

  return {
    rulesV2: normalizeToggleListRulesV2(value.rulesV2, fallback.rulesV2),
    propertyOrder,
    hiddenProperties,
    showEmptyEstimate: typeof value.showEmptyEstimate === "boolean"
      ? value.showEmptyEstimate
      : fallback.showEmptyEstimate,
    showEmptyPriority: typeof value.showEmptyPriority === "boolean"
      ? value.showEmptyPriority
      : fallback.showEmptyPriority,
  };
}

export function setToggleListRulesV2(
  settings: ToggleListSettings,
  nextRules: ToggleListRulesV2,
): ToggleListSettings {
  return {
    ...settings,
    rulesV2: normalizeToggleListRulesV2(nextRules, settings.rulesV2),
  };
}

export function toggleIncludeHostCard(settings: ToggleListSettings): ToggleListSettings {
  return {
    ...settings,
    rulesV2: {
      ...settings.rulesV2,
      includeHostCard: !settings.rulesV2.includeHostCard,
    },
  };
}

export function toggleToggleListHiddenProperty(
  settings: ToggleListSettings,
  property: ToggleListPropertyKey,
): ToggleListSettings {
  const exists = settings.hiddenProperties.includes(property);
  return {
    ...settings,
    hiddenProperties: exists
      ? settings.hiddenProperties.filter((item) => item !== property)
      : [...settings.hiddenProperties, property],
  };
}

export function moveToggleListProperty(
  settings: ToggleListSettings,
  property: ToggleListPropertyKey,
  direction: -1 | 1,
): ToggleListSettings {
  const index = settings.propertyOrder.indexOf(property);
  if (index < 0) return settings;

  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= settings.propertyOrder.length) return settings;

  const nextOrder = [...settings.propertyOrder];
  nextOrder[index] = nextOrder[nextIndex];
  nextOrder[nextIndex] = property;

  return {
    ...settings,
    propertyOrder: nextOrder,
  };
}

export function toggleShowEmptyEstimate(
  settings: ToggleListSettings,
): ToggleListSettings {
  return {
    ...settings,
    showEmptyEstimate: !settings.showEmptyEstimate,
  };
}

export function toggleShowEmptyPriority(
  settings: ToggleListSettings,
): ToggleListSettings {
  return {
    ...settings,
    showEmptyPriority: !settings.showEmptyPriority,
  };
}

export function normalizeToggleListRulesV2(
  value: unknown,
  fallback: ToggleListRulesV2 = DEFAULT_TOGGLE_LIST_SETTINGS.rulesV2,
): ToggleListRulesV2 {
  if (!isRecord(value)) return cloneRulesV2(fallback);

  const mode = value.mode === "advanced" || value.mode === "basic"
    ? value.mode
    : fallback.mode;
  const includeHostCard = typeof value.includeHostCard === "boolean"
    ? value.includeHostCard
    : fallback.includeHostCard;
  const filter = normalizeFilterSpec(value.filter, fallback.filter);
  const sort = normalizeSortKeys(value.sort, fallback.sort);

  return {
    mode,
    includeHostCard,
    filter,
    sort,
  };
}

export function deriveToggleListFilterRule(
  rules: ToggleListRulesV2,
  fallback: ToggleListFilterRule = DEFAULT_FILTER_RULE,
): ToggleListFilterRule {
  const statuses = collectClauseUnion<ToggleListStatusId>(
    rules.filter,
    "status",
    (value): value is ToggleListStatusId =>
      TOGGLE_LIST_STATUS_ORDER.includes(value as ToggleListStatusId),
  );
  const priorities = collectClauseUnion<Priority>(
    rules.filter,
    "priority",
    (value): value is Priority =>
      TOGGLE_LIST_PRIORITY_ORDER.includes(value as Priority),
  );
  const tagClause = resolveProjectableTagClause(rules.filter);

  return {
    statuses: statuses.found ? statuses.values : [...fallback.statuses],
    priorities: priorities.found ? priorities.values : [...fallback.priorities],
    includeEmptyPriority: priorities.found ? priorities.includeEmpty : fallback.includeEmptyPriority,
    tags: tagClause?.values ?? [...fallback.tags],
    tagMode: tagClause
      ? tagClause.op === "hasAny"
        ? "any"
        : tagClause.op === "hasAll"
          ? "all"
          : "none"
      : fallback.tagMode,
    includeHostCard: rules.includeHostCard,
  };
}

export function resolveToggleListPrimarySort(
  rules: ToggleListRulesV2,
): ToggleListSortKey {
  return rules.sort[0] ?? DEFAULT_SORT[0];
}

export function resolveToggleListSecondarySort(
  rules: ToggleListRulesV2,
): ToggleListSortKey {
  return rules.sort[1] ?? DEFAULT_SORT[1];
}

export function toggleListSortIncludesField(
  rules: ToggleListRulesV2,
  field: ToggleListRankField,
): boolean {
  return rules.sort.some((entry) => entry.field === field);
}

export function replaceToggleListFieldClause(
  group: ToggleListFilterGroup,
  clause: ToggleListClause,
): ToggleListFilterGroup {
  return {
    ...group,
    all: [...group.all.filter((candidate) => candidate.field !== clause.field), clause],
  };
}

export function removeToggleListFieldClause(
  group: ToggleListFilterGroup,
  field: ToggleListClause["field"],
): ToggleListFilterGroup {
  return {
    ...group,
    all: group.all.filter((candidate) => candidate.field !== field),
  };
}

function cloneRulesV2(rules: ToggleListRulesV2): ToggleListRulesV2 {
  return {
    mode: rules.mode,
    includeHostCard: rules.includeHostCard,
    filter: {
      any: rules.filter.any.map((group) => ({
        all: group.all.map(cloneClause),
      })),
    },
    sort: rules.sort.map((entry) => ({ ...entry })),
  };
}

function normalizePropertyOrder(value: unknown): ToggleListPropertyKey[] {
  const fallback = [...TOGGLE_LIST_PROPERTY_KEYS];
  if (!Array.isArray(value)) return fallback;

  const existing = value.filter((property): property is ToggleListPropertyKey =>
    typeof property === "string" && TOGGLE_LIST_PROPERTY_KEYS.includes(property as ToggleListPropertyKey),
  );

  const deduped = Array.from(new Set(existing));
  for (const property of TOGGLE_LIST_PROPERTY_KEYS) {
    if (!deduped.includes(property)) {
      deduped.push(property);
    }
  }

  return deduped;
}

function isRankField(value: unknown): value is ToggleListRankField {
  return typeof value === "string" && TOGGLE_LIST_RANK_FIELDS.includes(value as ToggleListRankField);
}

function isRankDirection(value: unknown): value is ToggleListRankDirection {
  return value === "asc" || value === "desc";
}

function normalizeFilterSpec(
  value: unknown,
  fallback: ToggleListFilterSpec,
): ToggleListFilterSpec {
  if (!isRecord(value)) return cloneFilterSpec(fallback);
  if (!Array.isArray(value.any)) return cloneFilterSpec(fallback);

  const groups = value.any
    .map((group) => normalizeFilterGroup(group))
    .filter((group): group is ToggleListFilterGroup => group !== null);

  if (groups.length === 0) return cloneFilterSpec(fallback);
  return { any: groups };
}

function cloneFilterSpec(filter: ToggleListFilterSpec): ToggleListFilterSpec {
  return {
    any: filter.any.map((group) => ({
      all: group.all.map(cloneClause),
    })),
  };
}

function cloneClause(clause: ToggleListClause): ToggleListClause {
  if (clause.field === "status") {
    return { field: "status", op: "in", values: [...clause.values] };
  }
  if (clause.field === "priority") {
    return {
      field: "priority",
      op: "in",
      values: [...clause.values],
      ...(clause.includeEmpty !== undefined ? { includeEmpty: clause.includeEmpty } : {}),
    };
  }
  return { field: "tags", op: clause.op, values: [...clause.values] };
}

function normalizeFilterGroup(value: unknown): ToggleListFilterGroup | null {
  if (!isRecord(value)) return null;
  const rawClauses = Array.isArray(value.all) ? value.all : [];
  const clauses = rawClauses
    .map((clause) => normalizeClause(clause))
    .filter((clause): clause is ToggleListClause => clause !== null);
  return { all: clauses };
}

function normalizeClause(value: unknown): ToggleListClause | null {
  if (!isRecord(value)) return null;
  if (value.field === "status" && value.op === "in") {
    return { field: "status", op: "in", values: normalizeStatusList(value.values) };
  }
  if (value.field === "priority" && value.op === "in") {
    const values = normalizePriorityList(value.values);
    return {
      field: "priority",
      op: "in",
      values,
      includeEmpty: normalizePriorityClauseIncludeEmpty(value.includeEmpty, values),
    };
  }
  if (
    value.field === "tags"
    && (value.op === "hasAny" || value.op === "hasAll" || value.op === "hasNone")
  ) {
    const values = normalizeStringList(value.values);
    if (values.length === 0) return null;
    return { field: "tags", op: value.op, values };
  }
  return null;
}

function normalizeSortKeys(
  value: unknown,
  fallback: ToggleListSortKey[],
): ToggleListSortKey[] {
  if (!Array.isArray(value)) return [...fallback];
  const parsed = value
    .map((item) => {
      if (!isRecord(item)) return null;
      if (!isRankField(item.field)) return null;
      if (!isRankDirection(item.direction)) return null;
      return { field: item.field, direction: item.direction };
    })
    .filter((item): item is ToggleListSortKey => item !== null);
  const deduped = dedupeSortKeys(parsed);
  if (deduped.length === 0) return [...fallback];
  return deduped;
}

function dedupeSortKeys(sort: ToggleListSortKey[]): ToggleListSortKey[] {
  const seen = new Set<ToggleListRankField>();
  const deduped: ToggleListSortKey[] = [];
  for (const key of sort) {
    if (seen.has(key.field)) continue;
    seen.add(key.field);
    deduped.push({ ...key });
  }
  return deduped;
}

function normalizeStatusList(value: unknown): ToggleListStatusId[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is ToggleListStatusId =>
    typeof item === "string" && TOGGLE_LIST_STATUS_ORDER.includes(item as ToggleListStatusId),
  );
}

function normalizePriorityList(value: unknown): Priority[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Priority =>
    typeof item === "string" && TOGGLE_LIST_PRIORITY_ORDER.includes(item as Priority),
  );
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value.filter((item): item is string => typeof item === "string" && item.length > 0),
    ),
  );
}

function collectClauseUnion<T extends string>(
  filter: ToggleListFilterSpec,
  field: "status" | "priority",
  guard: (value: string) => value is T,
): { values: T[]; found: boolean; includeEmpty: boolean } {
  const values: T[] = [];
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
        if (!guard(value)) continue;
        if (values.includes(value)) continue;
        values.push(value);
      }
    }
  }
  return { values, found, includeEmpty };
}

function resolveProjectableTagClause(
  filter: ToggleListFilterSpec,
): Extract<ToggleListClause, { field: "tags" }> | null {
  const clauses: Extract<ToggleListClause, { field: "tags" }>[] = [];
  for (const group of filter.any) {
    for (const clause of group.all) {
      if (clause.field !== "tags") continue;
      clauses.push(clause);
    }
  }
  if (clauses.length !== 1) return null;
  return clauses[0];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
