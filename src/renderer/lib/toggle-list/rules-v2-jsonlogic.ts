import type {
  ToggleListClause,
  ToggleListFilterGroup,
  ToggleListFilterSpec,
  ToggleListRankDirection,
  ToggleListRankField,
  ToggleListRuleMode,
  ToggleListRulesV2,
  ToggleListSortKey,
} from "./types";
import {
  TOGGLE_LIST_PRIORITY_ORDER,
  TOGGLE_LIST_RANK_FIELDS,
  TOGGLE_LIST_STATUS_ORDER,
} from "./types";

const JSONLOGIC_SCHEMA = "nodex.toggle-list-rules-v2.jsonlogic/v1";

type JsonLogicValue = boolean | number | string | JsonLogicArray | JsonLogicObject;
type JsonLogicArray = JsonLogicValue[];
type JsonLogicObject = { [key: string]: JsonLogicValue };

interface JsonLogicDocument {
  $schema: string;
  mode: ToggleListRuleMode;
  includeHostCard: boolean;
  filter: JsonLogicValue;
  sort: ToggleListSortKey[];
}

export function formatRulesV2AsJsonLogic(rules: ToggleListRulesV2): string {
  return JSON.stringify(toJsonLogicDocument(rules), null, 2);
}

export function parseRulesV2FromJsonLogic(input: string): {
  rules: ToggleListRulesV2 | null;
  error: string | null;
} {
  try {
    const parsed = JSON.parse(input);
    if (!isRecord(parsed)) {
      return { rules: null, error: "JSON root must be an object." };
    }

    const mode = parsed.mode === "advanced" || parsed.mode === "basic"
      ? parsed.mode
      : "advanced";
    const filter = parseFilterSpec(parsed.filter);
    if (!filter) {
      return { rules: null, error: "Unsupported filter expression." };
    }
    const sort = parseSortArray(parsed.sort);
    if (sort.length === 0) {
      return { rules: null, error: "Sort must contain at least one valid key." };
    }

    return {
      rules: {
        mode,
        includeHostCard: typeof parsed.includeHostCard === "boolean" ? parsed.includeHostCard : false,
        filter,
        sort,
      },
      error: null,
    };
  } catch {
    return { rules: null, error: "Invalid JSON." };
  }
}

function toJsonLogicDocument(rules: ToggleListRulesV2): JsonLogicDocument {
  return {
    $schema: JSONLOGIC_SCHEMA,
    mode: rules.mode,
    includeHostCard: rules.includeHostCard,
    filter: filterSpecToLogic(rules.filter),
    sort: rules.sort.map((entry) => ({ ...entry })),
  };
}

function filterSpecToLogic(spec: ToggleListFilterSpec): JsonLogicValue {
  if (spec.any.length === 0) return false;
  const groupExpressions = spec.any.map((group) => filterGroupToLogic(group));
  if (groupExpressions.length === 1) return groupExpressions[0];
  return { or: groupExpressions };
}

function filterGroupToLogic(group: ToggleListFilterGroup): JsonLogicValue {
  if (group.all.length === 0) return true;
  const clauseExpressions = group.all.map((clause) => clauseToLogic(clause));
  if (clauseExpressions.length === 1) return clauseExpressions[0];
  return { and: clauseExpressions };
}

function clauseToLogic(clause: ToggleListClause): JsonLogicValue {
  if (clause.field === "status") {
    return { in: [{ var: "status" }, clause.values] };
  }
  if (clause.field === "priority") {
    const expressions: JsonLogicValue[] = [];

    if (clause.values.length > 0) {
      expressions.push({ in: [{ var: "priority" }, clause.values] });
    }
    if (clause.includeEmpty) {
      expressions.push({ missing: ["priority"] });
    }

    if (expressions.length === 0) {
      return { in: [{ var: "priority" }, []] };
    }
    if (expressions.length === 1) {
      return expressions[0];
    }
    return { or: expressions };
  }

  const anyExpression = tagsAnyToLogic(clause.values);
  if (clause.op === "hasAny") return anyExpression;
  if (clause.op === "hasAll") return tagsAllToLogic(clause.values);
  return { "!": anyExpression };
}

function tagsAnyToLogic(tags: string[]): JsonLogicValue {
  const checks = tags.map((tag) => ({ in: [tag, { var: "tags" }] }));
  if (checks.length === 1) return checks[0];
  return { or: checks };
}

function tagsAllToLogic(tags: string[]): JsonLogicValue {
  const checks = tags.map((tag) => ({ in: [tag, { var: "tags" }] }));
  if (checks.length === 1) return checks[0];
  return { and: checks };
}

function parseFilterSpec(value: unknown): ToggleListFilterSpec | null {
  if (typeof value === "boolean") {
    if (value) return { any: [{ all: [] }] };
    return { any: [{ all: [{ field: "status", op: "in", values: [] }] }] };
  }
  if (!isRecord(value)) return null;

  const disjunction = value.or;
  if (Array.isArray(disjunction)) {
    const groups = disjunction
      .map((group) => parseFilterGroup(group))
      .filter((group): group is ToggleListFilterGroup => group !== null);
    if (groups.length === 0) return null;
    return { any: groups };
  }

  const group = parseFilterGroup(value);
  if (!group) return null;
  return { any: [group] };
}

function parseFilterGroup(value: unknown): ToggleListFilterGroup | null {
  if (typeof value === "boolean") {
    return value ? { all: [] } : { all: [{ field: "status", op: "in", values: [] }] };
  }
  if (!isRecord(value)) return null;

  const conjunction = value.and;
  if (Array.isArray(conjunction)) {
    const clauses = conjunction
      .map((entry) => parseClause(entry))
      .filter((clause): clause is ToggleListClause => clause !== null);
    if (clauses.length !== conjunction.length) return null;
    return { all: clauses };
  }

  const clause = parseClause(value);
  if (!clause) return null;
  return { all: [clause] };
}

function parseClause(value: unknown): ToggleListClause | null {
  if (!isRecord(value)) return null;

  const status = parseStatusInClause(value);
  if (status) return { field: "status", op: "in", values: status };
  const priority = parsePriorityClause(value);
  if (priority) return priority;

  const tagAny = parseTagAnyExpression(value);
  if (tagAny) return { field: "tags", op: "hasAny", values: tagAny };

  const tagAll = parseTagAllExpression(value);
  if (tagAll) return { field: "tags", op: "hasAll", values: tagAll };

  const negated = value["!"];
  if (negated !== undefined) {
    const tags = parseTagAnyExpression(negated);
    if (tags) return { field: "tags", op: "hasNone", values: tags };
  }

  return null;
}

function parseStatusInClause(
  value: Record<string, unknown>,
): Array<(typeof TOGGLE_LIST_STATUS_ORDER)[number]> | null {
  const operation = value.in;
  if (!Array.isArray(operation) || operation.length !== 2) return null;
  const [left, right] = operation;
  if (!isVarRef(left, "status")) return null;
  if (!Array.isArray(right)) return null;

  return right.filter((item): item is (typeof TOGGLE_LIST_STATUS_ORDER)[number] =>
    typeof item === "string" && TOGGLE_LIST_STATUS_ORDER.includes(item as (typeof TOGGLE_LIST_STATUS_ORDER)[number]),
  );
}

function parsePriorityClause(
  value: Record<string, unknown>,
): Extract<ToggleListClause, { field: "priority" }> | null {
  const direct = parsePriorityInClause(value);
  if (direct) return direct;
  if (isPriorityEmptyExpression(value)) {
    return { field: "priority", op: "in", values: [], includeEmpty: true };
  }
  if (!Array.isArray(value.or) || value.or.length === 0) return null;

  const priorities: Array<(typeof TOGGLE_LIST_PRIORITY_ORDER)[number]> = [];
  let includeEmpty = false;

  for (const entry of value.or) {
    if (isPriorityEmptyExpression(entry)) {
      includeEmpty = true;
      continue;
    }

    if (!isRecord(entry)) return null;
    const clause = parsePriorityInClause(entry);
    if (!clause) return null;
    for (const priority of clause.values) {
      if (!priorities.includes(priority)) {
        priorities.push(priority);
      }
    }
    includeEmpty = includeEmpty || clause.includeEmpty === true;
  }

  return { field: "priority", op: "in", values: priorities, includeEmpty };
}

function parsePriorityInClause(
  value: Record<string, unknown>,
): Extract<ToggleListClause, { field: "priority" }> | null {
  const operation = value.in;
  if (!Array.isArray(operation) || operation.length !== 2) return null;
  const [left, right] = operation;
  if (!isVarRef(left, "priority")) return null;
  if (!Array.isArray(right)) return null;

  const values = right.filter((item): item is (typeof TOGGLE_LIST_PRIORITY_ORDER)[number] =>
    typeof item === "string" && TOGGLE_LIST_PRIORITY_ORDER.includes(item as (typeof TOGGLE_LIST_PRIORITY_ORDER)[number]),
  );
  return { field: "priority", op: "in", values, includeEmpty: false };
}

function isPriorityEmptyExpression(value: unknown): boolean {
  if (!isRecord(value)) return false;

  if (Array.isArray(value.missing) && value.missing.length === 1 && value.missing[0] === "priority") {
    return true;
  }

  return isNullEqualityVarRef(value, "priority");
}

function isNullEqualityVarRef(
  value: Record<string, unknown>,
  key: string,
): boolean {
  return ["==", "==="].some((operator) => {
    const expression = value[operator];
    if (!Array.isArray(expression) || expression.length !== 2) return false;
    const [left, right] = expression;
    return (isVarRef(left, key) && right === null) || (isVarRef(right, key) && left === null);
  });
}

function parseTagAnyExpression(value: unknown): string[] | null {
  if (!isRecord(value)) return null;

  const singleTag = parseSingleTagMembership(value);
  if (singleTag) return [singleTag];

  if (!Array.isArray(value.or)) return null;
  const tags = value.or
    .map((entry) => parseSingleTagMembership(entry))
    .filter((tag): tag is string => tag !== null);
  if (tags.length !== value.or.length) return null;
  return dedupeStrings(tags);
}

function parseTagAllExpression(value: unknown): string[] | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.and)) return null;
  const tags = value.and
    .map((entry) => parseSingleTagMembership(entry))
    .filter((tag): tag is string => tag !== null);
  if (tags.length !== value.and.length) return null;
  return dedupeStrings(tags);
}

function parseSingleTagMembership(value: unknown): string | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.in) || value.in.length !== 2) return null;
  const [left, right] = value.in;
  if (typeof left !== "string" || left.length === 0) return null;
  if (!isVarRef(right, "tags")) return null;
  return left;
}

function parseSortArray(value: unknown): ToggleListSortKey[] {
  if (!Array.isArray(value)) return [];
  const parsed = value
    .map((entry) => {
      if (!isRecord(entry)) return null;
      if (!isRankField(entry.field)) return null;
      if (!isRankDirection(entry.direction)) return null;
      return { field: entry.field, direction: entry.direction };
    })
    .filter((entry): entry is ToggleListSortKey => entry !== null);
  return dedupeSort(parsed);
}

function dedupeSort(sort: ToggleListSortKey[]): ToggleListSortKey[] {
  const seen = new Set<ToggleListRankField>();
  const deduped: ToggleListSortKey[] = [];
  for (const entry of sort) {
    if (seen.has(entry.field)) continue;
    seen.add(entry.field);
    deduped.push({ ...entry });
  }
  return deduped;
}

function dedupeStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter((value) => value.length > 0)));
}

function isVarRef(value: unknown, name: string): boolean {
  if (!isRecord(value)) return false;
  return value.var === name;
}

function isRankField(value: unknown): value is ToggleListRankField {
  return typeof value === "string" && TOGGLE_LIST_RANK_FIELDS.includes(value as ToggleListRankField);
}

function isRankDirection(value: unknown): value is ToggleListRankDirection {
  return value === "asc" || value === "desc";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
