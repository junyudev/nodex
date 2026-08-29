import type {
  DatabaseViewCompletedRange,
  DatabaseViewConfigV2,
  DatabaseViewConfigV6,
  DatabaseViewField,
  DatabaseViewLayout,
  DatabaseViewLayoutDisplayConfig,
  DatabaseViewPresentationConfig,
  DatabaseViewPresentationOverride,
  DatabaseViewPreferencesOverride,
  DatabaseViewRules,
  DatabaseViewRulesOverride,
  DatabaseViewSort,
  EffectiveDatabaseView,
} from "./database-kernel";

const MAX_SORT_RULES = 128;
const MAX_DISPLAY_FIELDS = 64;

const COMPLETED_RANGES: readonly DatabaseViewCompletedRange[] = [
  "all",
  "past_month",
  "past_week",
  "past_day",
  "none",
];

export interface DatabaseViewPropertyCapability {
  readonly propertyId: string;
  readonly sortable: boolean;
  readonly groupable: boolean;
  /** Finite properties can enumerate meaningful empty groups. */
  readonly finite: boolean;
}

export interface DatabaseViewCapabilities {
  readonly properties: readonly DatabaseViewPropertyCapability[];
  readonly intrinsicFields?: readonly Extract<
    DatabaseViewField,
    { readonly kind: "intrinsic" }
  >["field"][];
  /** The Source has a canonical workflow status whose completed state is `ship`. */
  readonly taskStatusPropertyId?: string;
}

const fieldKey = (field: DatabaseViewField): string =>
  field.kind === "property" ? `property:${field.propertyId}` : `intrinsic:${field.field}`;

const normalizedFields = (
  fields: readonly DatabaseViewField[],
  propertyCapabilities: ReadonlyMap<string, DatabaseViewPropertyCapability>,
  intrinsicFields: ReadonlySet<string>,
): readonly DatabaseViewField[] => {
  const seen = new Set<string>();
  const normalized: DatabaseViewField[] = [];
  for (const field of fields) {
    if (normalized.length >= MAX_DISPLAY_FIELDS) break;
    if (field.kind === "property" && !propertyCapabilities.has(field.propertyId)) {
      continue;
    }
    if (field.kind === "intrinsic" && !intrinsicFields.has(field.field)) {
      continue;
    }
    const key = fieldKey(field);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(field);
  }
  return normalized;
};

const normalizedSort = (
  sort: readonly DatabaseViewSort[],
  properties: ReadonlyMap<string, DatabaseViewPropertyCapability>,
): readonly DatabaseViewSort[] => {
  const normalized: DatabaseViewSort[] = [];
  const seen = new Set<string>();
  for (const rule of sort) {
    if (normalized.length >= MAX_SORT_RULES) break;
    if (rule.field.kind === "property") {
      const capability = properties.get(rule.field.propertyId);
      if (!capability?.sortable) continue;
    }
    const key =
      rule.field.kind === "property" ? `property:${rule.field.propertyId}` : rule.field.kind;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(rule);
  }
  return normalized;
};

/** The direction used when manual order is the primary presentation rule. */
export const databaseViewPrimaryManualOrderDirection = (
  sort: readonly DatabaseViewSort[],
): DatabaseViewSort["direction"] | null => {
  const primary = sort[0];
  if (!primary) return "asc";
  return primary.field.kind === "manual" ? primary.direction : null;
};

/**
 * The View-global fractional rank is the final stable order after writable
 * Property sorts. An explicit manual rule chooses its direction; a Property-
 * only tuple gets an implicit ascending tie-break. Intrinsic sorts do not
 * imply a writable position.
 */
export const databaseViewFractionalOrderDirection = (
  sort: readonly DatabaseViewSort[],
): DatabaseViewSort["direction"] | null => {
  const manual = sort.find((rule) => rule.field.kind === "manual");
  if (manual) return manual.direction;
  return sort.every((rule) => rule.field.kind === "property") ? "asc" : null;
};

const normalizedGroup = (
  group: null | { readonly propertyId: string },
  properties: ReadonlyMap<string, DatabaseViewPropertyCapability>,
): null | { readonly propertyId: string } => {
  if (!group) return null;
  if (!properties.get(group.propertyId)?.groupable) return null;
  return group;
};

const normalizedCompletedRange = (range: DatabaseViewCompletedRange): DatabaseViewCompletedRange =>
  COMPLETED_RANGES.includes(range) ? range : "all";

const normalizedLayout = (
  layout: DatabaseViewLayoutDisplayConfig,
  group: DatabaseViewPresentationConfig["group"],
  properties: ReadonlyMap<string, DatabaseViewPropertyCapability>,
  intrinsicFields: ReadonlySet<string>,
): DatabaseViewLayoutDisplayConfig => {
  const normalizedDisplayFields = normalizedFields(layout.fields, properties, intrinsicFields);
  const propertyOrder: string[] = [];
  const seenProperties = new Set<string>();
  for (const propertyId of layout.propertyOrder ?? []) {
    if (!properties.has(propertyId) || seenProperties.has(propertyId)) continue;
    seenProperties.add(propertyId);
    propertyOrder.push(propertyId);
  }
  for (const field of normalizedDisplayFields) {
    if (field.kind !== "property" || seenProperties.has(field.propertyId)) continue;
    seenProperties.add(field.propertyId);
    propertyOrder.push(field.propertyId);
  }
  for (const propertyId of properties.keys()) {
    if (seenProperties.has(propertyId)) continue;
    propertyOrder.push(propertyId);
  }
  return {
    fields: normalizedDisplayFields,
    propertyOrder,
    showEmptyGroups:
      layout.showEmptyGroups && group !== null && properties.get(group.propertyId)?.finite === true,
    showDescription: layout.showDescription !== false,
  };
};

const overlayPresentation = (
  durable: DatabaseViewPresentationConfig,
  override: DatabaseViewPresentationOverride | undefined,
): DatabaseViewPresentationConfig => ({
  group: override && "group" in override ? (override.group ?? null) : durable.group,
  subgroup: override && "subgroup" in override ? (override.subgroup ?? null) : durable.subgroup,
  groupDirection: override?.groupDirection ?? durable.groupDirection,
  completion: {
    range: override?.completion?.range ?? durable.completion.range,
    orderByRecency: override?.completion?.orderByRecency ?? durable.completion.orderByRecency,
  },
  hierarchy: {
    showSubPages: override?.hierarchy?.showSubPages ?? durable.hierarchy.showSubPages,
    nestedSubPages: override?.hierarchy?.nestedSubPages ?? durable.hierarchy.nestedSubPages,
  },
  display: {
    fields: override?.display?.fields ?? durable.display.fields,
    propertyOrder: override?.display?.propertyOrder ?? durable.display.propertyOrder,
    showEmptyGroups: override?.display?.showEmptyGroups ?? durable.display.showEmptyGroups,
    showDescription: override?.display?.showDescription ?? durable.display.showDescription,
  },
  conditionalColors: durable.conditionalColors,
});

const EMPTY_DATABASE_VIEW_RULES: DatabaseViewRules = {
  propertyFilters: [],
  advancedFilter: null,
  sorts: [],
};

const overlayRules = (
  durable: DatabaseViewRules,
  override: DatabaseViewRulesOverride | undefined,
): DatabaseViewRules => ({
  propertyFilters: override?.propertyFilters ?? durable.propertyFilters,
  advancedFilter:
    override && "advancedFilter" in override
      ? (override.advancedFilter ?? null)
      : durable.advancedFilter,
  sorts: override?.sorts ?? durable.sorts,
});

/**
 * Resolves the one presentation consumed by Core reads and renderer layouts.
 * Invalid or stale Profile fields fail closed to the durable Source contract.
 */
export const resolveEffectiveDatabaseView = (
  layout: DatabaseViewLayout,
  durable: DatabaseViewPresentationConfig,
  override: DatabaseViewPresentationOverride | undefined,
  capabilities: DatabaseViewCapabilities,
  durableRules: DatabaseViewRules = EMPTY_DATABASE_VIEW_RULES,
  rulesOverride?: DatabaseViewRulesOverride,
): EffectiveDatabaseView => {
  const properties = new Map(
    capabilities.properties.map((property) => [property.propertyId, property]),
  );
  const intrinsicFields = new Set(
    capabilities.intrinsicFields ?? ["page_key", "created_at", "updated_at"],
  );
  const overlaid = overlayPresentation(durable, override);
  const overlaidRules = overlayRules(durableRules, rulesOverride);
  const group = normalizedGroup(overlaid.group, properties);
  const candidateSubgroup = normalizedGroup(overlaid.subgroup, properties);
  const subgroup =
    !group || candidateSubgroup?.propertyId === group.propertyId ? null : candidateSubgroup;
  const taskStatusAvailable =
    capabilities.taskStatusPropertyId !== undefined &&
    properties.has(capabilities.taskStatusPropertyId);

  return {
    layout,
    rules: {
      propertyFilters: overlaidRules.propertyFilters.filter((filter) =>
        properties.has(filter.clause.propertyId),
      ),
      advancedFilter: overlaidRules.advancedFilter,
      sorts: normalizedSort(overlaidRules.sorts, properties),
    },
    presentation: {
      group,
      subgroup,
      groupDirection: overlaid.groupDirection,
      completion: taskStatusAvailable
        ? {
            range: normalizedCompletedRange(overlaid.completion.range),
            orderByRecency: overlaid.completion.orderByRecency,
          }
        : { range: "all", orderByRecency: false },
      hierarchy: {
        showSubPages: overlaid.hierarchy.showSubPages,
        nestedSubPages: overlaid.hierarchy.showSubPages && overlaid.hierarchy.nestedSubPages,
      },
      display: normalizedLayout(
        overlaid.display,
        group && (!subgroup || properties.get(subgroup.propertyId)?.finite) ? group : null,
        properties,
        intrinsicFields,
      ),
      conditionalColors: overlaid.conditionalColors.filter((rule) =>
        properties.has(rule.propertyId),
      ),
    },
  };
};

const equal = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

/** Produces the minimal Profile-local patch relative to the durable default. */
export const compactDatabaseViewPresentationOverride = (
  durable: EffectiveDatabaseView,
  effective: EffectiveDatabaseView,
): DatabaseViewPresentationOverride | null => {
  const completion: {
    range?: DatabaseViewCompletedRange;
    orderByRecency?: boolean;
  } = {};
  if (durable.presentation.completion.range !== effective.presentation.completion.range) {
    completion.range = effective.presentation.completion.range;
  }
  if (
    durable.presentation.completion.orderByRecency !==
    effective.presentation.completion.orderByRecency
  ) {
    completion.orderByRecency = effective.presentation.completion.orderByRecency;
  }

  const compactLayout = (
    baseline: DatabaseViewLayoutDisplayConfig,
    current: DatabaseViewLayoutDisplayConfig,
  ): Partial<DatabaseViewLayoutDisplayConfig> | undefined => {
    const result: {
      fields?: readonly DatabaseViewField[];
      propertyOrder?: readonly string[];
      showEmptyGroups?: boolean;
      showDescription?: boolean;
    } = {};
    if (!equal(baseline.fields, current.fields)) result.fields = current.fields;
    if (!equal(baseline.propertyOrder, current.propertyOrder)) {
      result.propertyOrder = current.propertyOrder;
    }
    if (baseline.showEmptyGroups !== current.showEmptyGroups) {
      result.showEmptyGroups = current.showEmptyGroups;
    }
    if (baseline.showDescription !== current.showDescription) {
      result.showDescription = current.showDescription !== false;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  };

  const display = compactLayout(durable.presentation.display, effective.presentation.display);
  const override: {
    group?: DatabaseViewPresentationConfig["group"];
    subgroup?: DatabaseViewPresentationConfig["subgroup"];
    groupDirection?: DatabaseViewPresentationConfig["groupDirection"];
    completion?: DatabaseViewPresentationOverride["completion"];
    hierarchy?: DatabaseViewPresentationOverride["hierarchy"];
    display?: DatabaseViewPresentationOverride["display"];
  } = {};

  if (!equal(durable.presentation.group, effective.presentation.group)) {
    override.group = effective.presentation.group;
  }
  if (!equal(durable.presentation.subgroup, effective.presentation.subgroup)) {
    override.subgroup = effective.presentation.subgroup;
  }
  if (durable.presentation.groupDirection !== effective.presentation.groupDirection) {
    override.groupDirection = effective.presentation.groupDirection;
  }
  if (Object.keys(completion).length > 0) override.completion = completion;
  const hierarchy: {
    showSubPages?: boolean;
    nestedSubPages?: boolean;
  } = {};
  if (
    durable.presentation.hierarchy.showSubPages !== effective.presentation.hierarchy.showSubPages
  ) {
    hierarchy.showSubPages = effective.presentation.hierarchy.showSubPages;
  }
  if (
    durable.presentation.hierarchy.nestedSubPages !==
    effective.presentation.hierarchy.nestedSubPages
  ) {
    hierarchy.nestedSubPages = effective.presentation.hierarchy.nestedSubPages;
  }
  if (Object.keys(hierarchy).length > 0) override.hierarchy = hierarchy;
  if (display) override.display = display;
  return Object.keys(override).length > 0 ? override : null;
};

/**
 * Freezes the complete presentation that gave a pointer gesture its meaning.
 * Semantic mutations use this rather than reinterpreting a drop against the
 * durable View after Profile-local presentation has changed its axes or sort.
 */
export const databaseViewGesturePresentationOverride = (
  effective: EffectiveDatabaseView,
): DatabaseViewPresentationOverride => ({
  group: effective.presentation.group,
  subgroup: effective.presentation.subgroup,
  groupDirection: effective.presentation.groupDirection,
  completion: { ...effective.presentation.completion },
  hierarchy: { ...effective.presentation.hierarchy },
  display: { ...effective.presentation.display },
});

/** Freezes every personal preference that gave a pointer gesture its meaning. */
export const databaseViewGesturePreferencesOverride = (
  effective: EffectiveDatabaseView,
): DatabaseViewPreferencesOverride => ({
  rulesOverride: {
    propertyFilters: effective.rules.propertyFilters,
    advancedFilter: effective.rules.advancedFilter,
    sorts: effective.rules.sorts,
  },
  presentationOverride: databaseViewGesturePresentationOverride(effective),
});

/** Produces the minimal Profile-local query patch relative to the durable View rules. */
export const compactDatabaseViewRulesOverride = (
  durable: DatabaseViewRules,
  effective: DatabaseViewRules,
): DatabaseViewRulesOverride | null => {
  const override: {
    propertyFilters?: DatabaseViewRulesOverride["propertyFilters"];
    advancedFilter?: DatabaseViewRulesOverride["advancedFilter"];
    sorts?: DatabaseViewRulesOverride["sorts"];
  } = {};
  if (!equal(durable.propertyFilters, effective.propertyFilters)) {
    override.propertyFilters = effective.propertyFilters;
  }
  if (!equal(durable.advancedFilter, effective.advancedFilter)) {
    override.advancedFilter = effective.advancedFilter;
  }
  if (!equal(durable.sorts, effective.sorts)) override.sorts = effective.sorts;
  return Object.keys(override).length > 0 ? override : null;
};

/** Deterministically upgrades the durable v2 presentation shape. */
export const upgradeDatabaseViewConfigV2 = (config: DatabaseViewConfigV2): DatabaseViewConfigV6 => {
  const fields = config.display.propertyIds.map((propertyId): DatabaseViewField => ({
    kind: "property",
    propertyId,
  }));
  return {
    schemaKey: "nodex.database-view",
    schemaVersion: 6,
    rules: {
      propertyFilters: [],
      advancedFilter:
        config.filter.kind === "group" && config.filter.children.length === 0
          ? null
          : config.filter.kind === "group"
            ? config.filter
            : { kind: "group", operator: "and", children: [config.filter] },
      sorts: config.sort,
    },
    presentation: {
      group: config.group,
      subgroup: null,
      groupDirection: "asc",
      completion: { range: "all", orderByRecency: false },
      hierarchy: { showSubPages: true, nestedSubPages: false },
      display: {
        fields,
        propertyOrder: [...config.display.propertyIds],
        showEmptyGroups: false,
        showDescription: true,
      },
      conditionalColors: [],
    },
  };
};
