import { stableStringifyBlockPropertyJson } from "./block-property-mutations";
import { parseAuthorizedReadStamp } from "./authorized-read-stamp";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourceOptionId,
  parseDataSourcePropertyId,
  isBuiltInDataSourcePropertyId,
  TASK_PARENT_PROPERTY_ID,
  type DatabaseId,
  type DatabaseViewId,
  type DataSourceId,
  type DataSourceOptionId,
  type DataSourcePropertyId,
  type BuiltInDataSourcePropertyId,
} from "./database-identities";
import { BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS } from "./data-source-built-ins";
import {
  MAX_DATA_SOURCE_OPTION_COLOR_LENGTH,
  MAX_DATA_SOURCE_OPTION_NAME_LENGTH,
  MAX_DATA_SOURCE_PROPERTY_OPTIONS,
} from "./data-source-option-registry";
import {
  MAX_DATABASE_MODULE_V2_BULK_ENTRIES,
  MAX_DATABASE_MODULE_V2_OPERATIONS,
  type DatabaseApplyOperationV2,
  type DatabaseApplyReceiptV2,
  type DatabaseListMoveUndoRecipeV2,
  type DatabaseListMoveTargetV2,
  type DatabaseListProjectionExpectationV2,
  type DatabaseOperationOutcomeV2,
  type DatabasePropertyValueInputV2,
  type DatabaseApplyResultV2,
  type DatabaseApplyV2,
  type DatabaseContainerDescriptorV2,
  type DatabaseContainerRecordV2,
  type DatabaseModuleErrorCodeV2,
  type DatabaseModuleErrorV2,
  type DatabaseModuleReadRequestV2,
  type DatabaseModuleReadResultV2,
  type DatabaseModuleReadSnapshotV2,
  type LibraryDatabaseModuleReadRequestV2,
  type LibraryDatabaseModuleReadResultV2,
  type LibraryDatabaseApplyV2,
  type LibraryDatabaseApplyResultV2,
  type DatabaseReadV2,
  type DatabaseReadValueV2,
  type DatabaseViewQueryResultV2,
  type DatabaseViewDisclosureTargetV2,
  type DatabaseViewRecordV2,
  type DataSourceDescriptorV2,
  type DataSourcePageRowV2,
  type DataSourcePageValueV2,
  type PageIntrinsicPropertyValueV2,
  type DataSourcePropertyRecordV2,
  type DataSourceQueryResultV2,
  type DataSourceRecordV2,
} from "./database-module-v2";
import { parseLocalCommitApply } from "./local-commit-delivery";
import {
  parseDatabaseViewConfigV6,
  parseDatabaseViewPreferencesOverride,
  parseDatabaseViewPresentationOverride,
  parseDatabaseViewRulesOverride,
  databaseViewFilterOperatorsForValueType,
  isDatabaseViewFilterOperator,
  type DatabaseJsonValue,
  type DatabasePropertyValueType,
  type DatabaseViewLayout,
} from "./database-kernel";
import { parsePage } from "./page";
import { MAX_PAGE_DESCRIPTION_LENGTH } from "./page-limits";

const MAX_ID_LENGTH = 512;
const MAX_NAME_LENGTH = 256;
const MAX_DATABASE_LIST_MOVE_PAGES = 4_096;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (isRecord(value)) return value;
  throw new TypeError(`${label} must be an object`);
};

const assertExactKeys = (
  value: Readonly<Record<string, unknown>>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (Object.prototype.hasOwnProperty.call(value, key)) continue;
    throw new TypeError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    throw new TypeError(`${label}.${key} is not supported`);
  }
};

const readString = (value: unknown, label: string, maximumLength = MAX_ID_LENGTH): string => {
  if (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  ) {
    return value;
  }
  throw new TypeError(`${label} must be a canonical non-empty string`);
};

const readOptionalString = (
  value: unknown,
  label: string,
  maximumLength = MAX_ID_LENGTH,
): string | undefined =>
  value === undefined ? undefined : readString(value, label, maximumLength);

const readNullableString = (
  value: unknown,
  label: string,
  maximumLength = MAX_ID_LENGTH,
): string | null => (value === null ? null : readString(value, label, maximumLength));

const readUtf8String = (value: unknown, label: string, maximumBytes: number): string => {
  const parsed = readString(value, label, maximumBytes);
  if (new TextEncoder().encode(parsed).byteLength <= maximumBytes) return parsed;
  throw new TypeError(`${label} must be at most ${maximumBytes} UTF-8 bytes`);
};

const readRevision = (value: unknown, label: string): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new TypeError(`${label} must be a safe non-negative revision`);
};

const readPositiveRevision = (value: unknown, label: string): number => {
  const parsed = readRevision(value, label);
  if (parsed >= 1) return parsed;
  throw new TypeError(`${label} must be a positive revision`);
};

const readBoolean = (value: unknown, label: string): boolean => {
  if (typeof value === "boolean") return value;
  throw new TypeError(`${label} must be a boolean`);
};

const readTimestamp = (value: unknown, label: string): string => {
  const timestamp = readString(value, label);
  const milliseconds = Date.parse(timestamp);
  if (Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === timestamp) {
    return timestamp;
  }
  throw new TypeError(`${label} must be a canonical UTC ISO-8601 timestamp`);
};

const readJsonValue = (value: unknown, label: string): DatabaseJsonValue => {
  try {
    return JSON.parse(stableStringifyBlockPropertyJson(value)) as DatabaseJsonValue;
  } catch (error) {
    throw new TypeError(`${label} must be bounded plain JSON`, { cause: error });
  }
};

const readJsonRecord = (
  value: unknown,
  label: string,
): Readonly<Record<string, DatabaseJsonValue>> => {
  const parsed = readJsonValue(value, label);
  if (isRecord(parsed)) {
    return parsed as Readonly<Record<string, DatabaseJsonValue>>;
  }
  throw new TypeError(`${label} must be a JSON object`);
};

const readDatabaseId = (value: unknown, label: string): DatabaseId => {
  try {
    return parseDatabaseId(value);
  } catch (error) {
    throw new TypeError(`${label} is invalid`, { cause: error });
  }
};

const readDataSourceId = (value: unknown, label: string): DataSourceId => {
  try {
    return parseDataSourceId(value);
  } catch (error) {
    throw new TypeError(`${label} is invalid`, { cause: error });
  }
};

const readViewId = (value: unknown, label: string): DatabaseViewId => {
  try {
    return parseDatabaseViewId(value);
  } catch (error) {
    throw new TypeError(`${label} is invalid`, { cause: error });
  }
};

const readPropertyId = (value: unknown, label: string): DataSourcePropertyId => {
  try {
    return parseDataSourcePropertyId(value);
  } catch (error) {
    throw new TypeError(`${label} is invalid`, { cause: error });
  }
};

const readOptionId = (
  propertyId: DataSourcePropertyId,
  value: unknown,
  label: string,
): DataSourceOptionId => {
  try {
    return parseDataSourceOptionId({ propertyId, value });
  } catch (error) {
    throw new TypeError(`${label} is invalid for Property ${propertyId}`, {
      cause: error,
    });
  }
};

const readPropertyValueType = (value: unknown, label: string): DatabasePropertyValueType => {
  if (
    value === "text" ||
    value === "number" ||
    value === "checkbox" ||
    value === "select" ||
    value === "multi_select" ||
    value === "date" ||
    value === "datetime" ||
    value === "relation"
  ) {
    return value;
  }
  throw new TypeError(`${label} is unsupported`);
};

const readViewLayout = (value: unknown, label: string): DatabaseViewLayout => {
  if (value === "board" || value === "list") {
    return value;
  }
  throw new TypeError(`${label} is unsupported`);
};

const readPagePropertyVisibility = (
  value: unknown,
  label: string,
): "always_show" | "hide_when_empty" | "always_hide" => {
  if (value === "always_show" || value === "hide_when_empty" || value === "always_hide") {
    return value;
  }
  throw new TypeError(`${label} is unsupported`);
};

const validateBuiltInPropertyValueType = (
  propertyId: DataSourcePropertyId,
  valueType: DatabasePropertyValueType,
  label: string,
): void => {
  if (!isBuiltInDataSourcePropertyId(propertyId)) return;
  const builtInPropertyId = propertyId as BuiltInDataSourcePropertyId;
  const expected = BUILT_IN_DATA_SOURCE_PROPERTY_DEFINITIONS[builtInPropertyId].valueType;
  if (expected === valueType) return;
  throw new TypeError(`${label} reserved Property ${propertyId} must use ${expected}`);
};

const parseStoredPropertyConfig = (
  _propertyId: DataSourcePropertyId,
  _valueType: DatabasePropertyValueType,
  value: unknown,
  label: string,
): Readonly<Record<string, DatabaseJsonValue>> => {
  const parsed = readJsonRecord(value, label);
  assertExactKeys(parsed, label, []);
  return {};
};

const readOptionIdArray = (
  value: unknown,
  propertyId: DataSourcePropertyId,
  label: string,
): readonly DataSourceOptionId[] => {
  if (!Array.isArray(value) || value.length > MAX_DATABASE_MODULE_V2_BULK_ENTRIES) {
    throw new TypeError(
      `${label} must be an array of at most ${MAX_DATABASE_MODULE_V2_BULK_ENTRIES} option identities`,
    );
  }
  const parsed = value.map((entry, index) => readOptionId(propertyId, entry, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length) {
    throw new TypeError(`${label} must contain unique option identities`);
  }
  return parsed;
};

const parsePropertySchema = (
  value: unknown,
  label: string,
): NonNullable<DataSourcePropertyRecordV2["schema"]> => {
  const schema = readRecord(value, label);
  const kind = schema.kind;
  if (kind === "relation") {
    assertExactKeys(schema, label, ["kind", "targetDataSourceId", "cardinality"]);
    if (schema.cardinality !== "one" && schema.cardinality !== "many") {
      throw new TypeError(`${label}.cardinality is invalid`);
    }
    return {
      kind,
      targetDataSourceId: readDataSourceId(
        schema.targetDataSourceId,
        `${label}.targetDataSourceId`,
      ),
      cardinality: schema.cardinality,
    };
  }
  if (kind === "number") {
    assertExactKeys(schema, label, ["kind"], ["format"]);
    if (schema.format === undefined) return { kind, format: { kind: "plain" } };
    const format = readRecord(schema.format, `${label}.format`);
    if (format.kind === "plain" || format.kind === "percent") {
      assertExactKeys(format, `${label}.format`, ["kind"]);
      return { kind, format: { kind: format.kind } };
    }
    if (format.kind === "currency") {
      assertExactKeys(format, `${label}.format`, ["kind", "currencyCode"]);
      if (
        format.currencyCode !== "usd" &&
        format.currencyCode !== "eur" &&
        format.currencyCode !== "gbp" &&
        format.currencyCode !== "jpy" &&
        format.currencyCode !== "cny"
      ) {
        throw new TypeError(`${label}.format.currencyCode is unsupported`);
      }
      return { kind, format: { kind: "currency", currencyCode: format.currencyCode } };
    }
    throw new TypeError(`${label}.format.kind is unsupported`);
  }
  if (kind === "date") {
    assertExactKeys(schema, label, ["kind"], ["dateFormat"]);
    const dateFormat = schema.dateFormat ?? "full";
    if (
      dateFormat !== "full" &&
      dateFormat !== "month_day_year" &&
      dateFormat !== "day_month_year" &&
      dateFormat !== "year_month_day" &&
      dateFormat !== "relative"
    ) {
      throw new TypeError(`${label}.dateFormat is unsupported`);
    }
    return { kind, dateFormat };
  }
  if (kind === "datetime") {
    assertExactKeys(schema, label, ["kind"], ["dateFormat", "timeFormat"]);
    const dateFormat = schema.dateFormat ?? "full";
    const timeFormat = schema.timeFormat ?? "twelve_hour";
    if (
      dateFormat !== "full" &&
      dateFormat !== "month_day_year" &&
      dateFormat !== "day_month_year" &&
      dateFormat !== "year_month_day" &&
      dateFormat !== "relative"
    ) {
      throw new TypeError(`${label}.dateFormat is unsupported`);
    }
    if (timeFormat !== "twelve_hour" && timeFormat !== "twenty_four_hour") {
      throw new TypeError(`${label}.timeFormat is unsupported`);
    }
    return { kind, dateFormat, timeFormat };
  }
  if (kind === "text" || kind === "checkbox" || kind === "select" || kind === "multi_select") {
    assertExactKeys(schema, label, ["kind"]);
    return { kind };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

const readIdentityArray = (value: unknown, label: string, maximum: number): readonly string[] => {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must contain at most ${maximum} identities`);
  }
  const ids = value.map((entry, index) => readString(entry, `${label}[${index}]`));
  if (new Set(ids).size !== ids.length) {
    throw new TypeError(`${label} must contain unique identities`);
  }
  return ids;
};

const readRelationEdgeIdArray = (value: unknown, label: string): readonly string[] => {
  const edgeIds = readIdentityArray(value, label, MAX_DATABASE_MODULE_V2_BULK_ENTRIES);
  if (edgeIds.some((edgeId) => !/^[0-9a-f]{64}$/.test(edgeId))) {
    throw new TypeError(`${label} must contain opaque Relation edge handles`);
  }
  return edgeIds;
};

const readRelationEdgeId = (value: unknown, label: string): string => {
  const edgeId = readString(value, label, 64);
  if (/^[0-9a-f]{64}$/.test(edgeId)) return edgeId;
  throw new TypeError(`${label} must be an opaque Relation edge handle`);
};

export const parseDatabaseListProjectionExpectationV2 = (
  value: unknown,
  label = "databaseListProjectionExpectation",
): DatabaseListProjectionExpectationV2 => {
  const expectation = readRecord(value, label);
  assertExactKeys(expectation, label, [
    "scopeKey",
    "schemaVersion",
    "revision",
    "coveredCommitSeq",
    "effectHash",
  ]);
  return {
    scopeKey: readString(expectation.scopeKey, `${label}.scopeKey`, 1_024),
    schemaVersion: readRevision(expectation.schemaVersion, `${label}.schemaVersion`),
    revision: readRevision(expectation.revision, `${label}.revision`),
    coveredCommitSeq: readRevision(expectation.coveredCommitSeq, `${label}.coveredCommitSeq`),
    effectHash: readNullableString(expectation.effectHash, `${label}.effectHash`, 256),
  };
};

export const parseDatabaseListMoveTargetV2 = (
  value: unknown,
  label = "databaseListMoveTarget",
): DatabaseListMoveTargetV2 => {
  const target = readRecord(value, label);
  if (target.kind === "page") {
    assertExactKeys(target, label, ["kind", "occurrenceKey", "edge"]);
    if (target.edge !== "before" && target.edge !== "after" && target.edge !== "inside") {
      throw new TypeError(`${label}.edge is unsupported`);
    }
    return {
      kind: target.kind,
      occurrenceKey: readString(target.occurrenceKey, `${label}.occurrenceKey`, 1_024),
      edge: target.edge,
    };
  }
  if (target.kind === "group") {
    assertExactKeys(target, label, ["kind", "occurrenceKey"]);
    return {
      kind: target.kind,
      occurrenceKey: readString(target.occurrenceKey, `${label}.occurrenceKey`, 1_024),
    };
  }
  if (target.kind === "root") {
    assertExactKeys(target, label, ["kind"]);
    return { kind: target.kind };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

const parseViewDisclosureTarget = (
  value: unknown,
  label: string,
): DatabaseViewDisclosureTargetV2 => {
  const target = readRecord(value, label);
  assertExactKeys(target, label, ["kind", "occurrenceKey"]);
  const occurrenceKey = readString(target.occurrenceKey, `${label}.occurrenceKey`, 1_024);
  if (target.kind === "group" && occurrenceKey.startsWith("GROUP_")) {
    return { kind: target.kind, occurrenceKey };
  }
  if (target.kind === "page" && occurrenceKey.startsWith("ITEM_")) {
    return { kind: target.kind, occurrenceKey };
  }
  throw new TypeError(`${label} does not match its occurrence kind`);
};

const parsePropertyValueInput = (
  value: unknown,
  propertyId: DataSourcePropertyId,
  label: string,
): DatabasePropertyValueInputV2 => {
  const input = readRecord(value, label);
  const kind = input.kind;
  if (kind === "empty") {
    assertExactKeys(input, label, ["kind"]);
    return { kind };
  }
  if (kind === "text" || kind === "date" || kind === "datetime") {
    assertExactKeys(input, label, ["kind", "value"]);
    return { kind, value: readString(input.value, `${label}.value`, 64 * 1024) };
  }
  if (kind === "number") {
    assertExactKeys(input, label, ["kind", "value"]);
    if (typeof input.value !== "number" || !Number.isFinite(input.value)) {
      throw new TypeError(`${label}.value must be finite`);
    }
    return { kind, value: input.value };
  }
  if (kind === "checkbox") {
    assertExactKeys(input, label, ["kind", "value"]);
    return { kind, value: readBoolean(input.value, `${label}.value`) };
  }
  if (kind === "select") {
    assertExactKeys(input, label, ["kind", "optionId"]);
    return { kind, optionId: readOptionId(propertyId, input.optionId, `${label}.optionId`) };
  }
  if (kind === "multi_select") {
    assertExactKeys(input, label, ["kind", "optionIds"]);
    return {
      kind,
      optionIds: readOptionIdArray(input.optionIds, propertyId, `${label}.optionIds`),
    };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

const readBoundedUniqueStrings = (
  value: unknown,
  label: string,
  options: { readonly allowEmpty: boolean; readonly maximum?: number },
): readonly string[] => {
  const maximum = options.maximum ?? MAX_DATABASE_LIST_MOVE_PAGES;
  if (
    !Array.isArray(value) ||
    (!options.allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} has an invalid bounded length`);
  }
  const entries = value.map((entry, index) => readString(entry, `${label}[${index}]`, 1_024));
  if (new Set(entries).size !== entries.length) {
    throw new TypeError(`${label} must contain unique identities`);
  }
  return entries;
};

const parseDatabaseListMoveUndoRecipe = (
  value: unknown,
  label: string,
): DatabaseListMoveUndoRecipeV2 => {
  const recipe = readRecord(value, label);
  assertExactKeys(recipe, label, [
    "viewId",
    "dataSourceId",
    "propertyStates",
    "postParentGuards",
    "postBeforePageId",
    "postOrderGuard",
    "restoreRuns",
  ]);
  if (
    !Array.isArray(recipe.propertyStates) ||
    recipe.propertyStates.length > MAX_DATABASE_LIST_MOVE_PAGES ||
    !Array.isArray(recipe.postParentGuards) ||
    recipe.postParentGuards.length < 1 ||
    recipe.postParentGuards.length > MAX_DATABASE_LIST_MOVE_PAGES ||
    !Array.isArray(recipe.restoreRuns) ||
    recipe.restoreRuns.length < 1 ||
    recipe.restoreRuns.length > MAX_DATABASE_LIST_MOVE_PAGES
  ) {
    throw new TypeError(`${label} has an invalid bounded shape`);
  }
  const propertyStates = recipe.propertyStates.map((entry, index) => {
    const entryLabel = `${label}.propertyStates[${index}]`;
    const state = readRecord(entry, entryLabel);
    assertExactKeys(state, entryLabel, ["pageId", "propertyId", "beforeValue", "afterValue"]);
    const propertyId = readPropertyId(state.propertyId, `${entryLabel}.propertyId`);
    return {
      pageId: readString(state.pageId, `${entryLabel}.pageId`),
      propertyId,
      beforeValue: parsePropertyValueInput(
        state.beforeValue,
        propertyId,
        `${entryLabel}.beforeValue`,
      ),
      afterValue: parsePropertyValueInput(state.afterValue, propertyId, `${entryLabel}.afterValue`),
    };
  });
  const postParentGuards = recipe.postParentGuards.map((entry, index) => {
    const entryLabel = `${label}.postParentGuards[${index}]`;
    const guard = readRecord(entry, entryLabel);
    assertExactKeys(guard, entryLabel, ["pageId", "parentPageId"]);
    return {
      pageId: readString(guard.pageId, `${entryLabel}.pageId`),
      parentPageId: readNullableString(guard.parentPageId, `${entryLabel}.parentPageId`),
    };
  });
  if (new Set(postParentGuards.map((guard) => guard.pageId)).size !== postParentGuards.length) {
    throw new TypeError(`${label}.postParentGuards repeats a Page identity`);
  }
  const restoreRuns = recipe.restoreRuns.map((entry, index) => {
    const entryLabel = `${label}.restoreRuns[${index}]`;
    const run = readRecord(entry, entryLabel);
    assertExactKeys(run, entryLabel, ["pageIds", "parentPageId", "beforePageId"]);
    return {
      pageIds: readBoundedUniqueStrings(run.pageIds, `${entryLabel}.pageIds`, {
        allowEmpty: false,
      }),
      parentPageId: readNullableString(run.parentPageId, `${entryLabel}.parentPageId`),
      beforePageId: readNullableString(run.beforePageId, `${entryLabel}.beforePageId`),
    };
  });
  const restored = restoreRuns.flatMap((run) => run.pageIds);
  if (
    new Set(restored).size !== restored.length ||
    restored.length !== postParentGuards.length ||
    restored.some((pageId) => !postParentGuards.some((guard) => guard.pageId === pageId))
  ) {
    throw new TypeError(`${label}.restoreRuns do not match its guarded roots`);
  }
  return {
    viewId: readViewId(recipe.viewId, `${label}.viewId`),
    dataSourceId: readDataSourceId(recipe.dataSourceId, `${label}.dataSourceId`),
    propertyStates,
    postParentGuards,
    postBeforePageId: readNullableString(recipe.postBeforePageId, `${label}.postBeforePageId`),
    postOrderGuard: readBoolean(recipe.postOrderGuard, `${label}.postOrderGuard`),
    restoreRuns,
  };
};

const parseApplyOperation = (value: unknown, index: number): DatabaseApplyOperationV2 => {
  const operation = readRecord(value, `databaseApplyV2.operations[${index}]`);
  const label = `databaseApplyV2.operations[${index}]`;

  if (operation.kind === "rename_page_key_prefix") {
    assertExactKeys(operation, label, ["kind", "databaseId", "expectedRevision", "prefix"]);
    return {
      kind: "rename_page_key_prefix",
      databaseId: readDatabaseId(operation.databaseId, `${label}.databaseId`),
      expectedRevision: readPositiveRevision(
        operation.expectedRevision,
        `${label}.expectedRevision`,
      ),
      prefix: readString(operation.prefix, `${label}.prefix`, 8),
    };
  }

  if (operation.kind === "put_property") {
    assertExactKeys(
      operation,
      label,
      [
        "kind",
        "dataSourceId",
        "propertyId",
        "expectedDataSourceRevision",
        "expectedPropertyRevision",
        "name",
        "schema",
      ],
      ["beforePropertyId"],
    );
    const dataSourceId = readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`);
    const propertyId = readPropertyId(operation.propertyId, `${label}.propertyId`);
    const schema = parsePropertySchema(operation.schema, `${label}.schema`);
    validateBuiltInPropertyValueType(propertyId, schema.kind, label);
    if (
      propertyId === TASK_PARENT_PROPERTY_ID &&
      (schema.kind !== "relation" ||
        schema.targetDataSourceId !== dataSourceId ||
        schema.cardinality !== "one")
    ) {
      throw new TypeError(
        `${label} reserved Property task_parent must be a cardinality-one self Relation`,
      );
    }
    const beforePropertyId =
      operation.beforePropertyId === undefined
        ? undefined
        : readPropertyId(operation.beforePropertyId, `${label}.beforePropertyId`);
    return {
      kind: "put_property",
      dataSourceId,
      propertyId,
      expectedDataSourceRevision: readRevision(
        operation.expectedDataSourceRevision,
        `${label}.expectedDataSourceRevision`,
      ),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
      name: readString(operation.name, `${label}.name`, MAX_NAME_LENGTH),
      schema,
      ...(beforePropertyId === undefined ? {} : { beforePropertyId }),
    };
  }

  if (operation.kind === "move_property") {
    assertExactKeys(operation, label, [
      "kind",
      "dataSourceId",
      "propertyId",
      "expectedDataSourceRevision",
      "expectedPropertyRevision",
      "placement",
    ]);
    const placement = readRecord(operation.placement, `${label}.placement`);
    if (placement.kind !== "before" && placement.kind !== "end") {
      throw new TypeError(`${label}.placement.kind is unsupported`);
    }
    assertExactKeys(
      placement,
      `${label}.placement`,
      placement.kind === "before" ? ["kind", "propertyId"] : ["kind"],
    );
    return {
      kind: operation.kind,
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      propertyId: readPropertyId(operation.propertyId, `${label}.propertyId`),
      expectedDataSourceRevision: readRevision(
        operation.expectedDataSourceRevision,
        `${label}.expectedDataSourceRevision`,
      ),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
      placement:
        placement.kind === "end"
          ? { kind: "end" }
          : {
              kind: "before",
              propertyId: readPropertyId(placement.propertyId, `${label}.placement.propertyId`),
            },
    };
  }

  if (operation.kind === "change_property_type") {
    assertExactKeys(operation, label, [
      "kind",
      "dataSourceId",
      "propertyId",
      "expectedDataSourceRevision",
      "expectedPropertyRevision",
      "schema",
    ]);
    return {
      kind: operation.kind,
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      propertyId: readPropertyId(operation.propertyId, `${label}.propertyId`),
      expectedDataSourceRevision: readRevision(
        operation.expectedDataSourceRevision,
        `${label}.expectedDataSourceRevision`,
      ),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
      schema: parsePropertySchema(operation.schema, `${label}.schema`),
    };
  }

  if (operation.kind === "duplicate_property") {
    assertExactKeys(operation, label, [
      "kind",
      "dataSourceId",
      "propertyId",
      "expectedDataSourceRevision",
      "expectedPropertyRevision",
      "newPropertyId",
      "name",
      "optionIds",
    ]);
    const propertyId = readPropertyId(operation.propertyId, `${label}.propertyId`);
    const newPropertyId = readPropertyId(operation.newPropertyId, `${label}.newPropertyId`);
    if (!Array.isArray(operation.optionIds)) {
      throw new TypeError(`${label}.optionIds must be an array`);
    }
    return {
      kind: operation.kind,
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      propertyId,
      expectedDataSourceRevision: readRevision(
        operation.expectedDataSourceRevision,
        `${label}.expectedDataSourceRevision`,
      ),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
      newPropertyId,
      name: readString(operation.name, `${label}.name`, MAX_NAME_LENGTH),
      optionIds: operation.optionIds.map((entry, optionIndex) => {
        const optionLabel = `${label}.optionIds[${optionIndex}]`;
        const mapping = readRecord(entry, optionLabel);
        assertExactKeys(mapping, optionLabel, ["sourceOptionId", "newOptionId"]);
        return {
          sourceOptionId: readOptionId(
            propertyId,
            mapping.sourceOptionId,
            `${optionLabel}.sourceOptionId`,
          ),
          newOptionId: readOptionId(
            newPropertyId,
            mapping.newOptionId,
            `${optionLabel}.newOptionId`,
          ),
        };
      }),
    };
  }

  if (operation.kind === "restore_property" || operation.kind === "permanently_delete_property") {
    assertExactKeys(operation, label, [
      "kind",
      "dataSourceId",
      "propertyId",
      "expectedDataSourceRevision",
      "expectedPropertyRevision",
    ]);
    return {
      kind: operation.kind,
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      propertyId: readPropertyId(operation.propertyId, `${label}.propertyId`),
      expectedDataSourceRevision: readRevision(
        operation.expectedDataSourceRevision,
        `${label}.expectedDataSourceRevision`,
      ),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
    };
  }

  if (operation.kind === "delete_property") {
    assertExactKeys(operation, label, [
      "kind",
      "dataSourceId",
      "propertyId",
      "expectedDataSourceRevision",
      "expectedPropertyRevision",
    ]);
    return {
      kind: "delete_property",
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      propertyId: readPropertyId(operation.propertyId, `${label}.propertyId`),
      expectedDataSourceRevision: readRevision(
        operation.expectedDataSourceRevision,
        `${label}.expectedDataSourceRevision`,
      ),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
    };
  }

  if (operation.kind === "put_option") {
    assertExactKeys(
      operation,
      label,
      ["kind", "dataSourceId", "propertyId", "optionId", "name", "expectedPropertyRevision"],
      ["color"],
    );
    const propertyId = readPropertyId(operation.propertyId, `${label}.propertyId`);
    const color = readOptionalString(operation.color, `${label}.color`, MAX_NAME_LENGTH);
    return {
      kind: "put_option",
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      propertyId,
      optionId: readOptionId(propertyId, operation.optionId, `${label}.optionId`),
      name: readString(operation.name, `${label}.name`, MAX_NAME_LENGTH),
      ...(color === undefined ? {} : { color }),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
    };
  }

  if (operation.kind === "delete_option") {
    assertExactKeys(operation, label, [
      "kind",
      "dataSourceId",
      "propertyId",
      "optionId",
      "expectedPropertyRevision",
    ]);
    const propertyId = readPropertyId(operation.propertyId, `${label}.propertyId`);
    return {
      kind: "delete_option",
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      propertyId,
      optionId: readOptionId(propertyId, operation.optionId, `${label}.optionId`),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
    };
  }

  if (operation.kind === "move_option") {
    assertExactKeys(operation, label, [
      "kind",
      "dataSourceId",
      "propertyId",
      "optionId",
      "expectedPropertyRevision",
      "placement",
    ]);
    const propertyId = readPropertyId(operation.propertyId, `${label}.propertyId`);
    const placement = readRecord(operation.placement, `${label}.placement`);
    const parsedPlacement = (() => {
      if (placement.kind === "end") {
        assertExactKeys(placement, `${label}.placement`, ["kind"]);
        return { kind: "end" as const };
      }
      if (placement.kind === "before") {
        assertExactKeys(placement, `${label}.placement`, ["kind", "optionId"]);
        return {
          kind: "before" as const,
          optionId: readOptionId(propertyId, placement.optionId, `${label}.placement.optionId`),
        };
      }
      throw new TypeError(`${label}.placement.kind is unsupported`);
    })();
    return {
      kind: operation.kind,
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      propertyId,
      optionId: readOptionId(propertyId, operation.optionId, `${label}.optionId`),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
      placement: parsedPlacement,
    };
  }

  if (operation.kind === "delete_option_and_clear_values") {
    assertExactKeys(operation, label, [
      "kind",
      "dataSourceId",
      "propertyId",
      "optionId",
      "expectedPropertyRevision",
    ]);
    const propertyId = readPropertyId(operation.propertyId, `${label}.propertyId`);
    return {
      kind: operation.kind,
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      propertyId,
      optionId: readOptionId(propertyId, operation.optionId, `${label}.optionId`),
      expectedPropertyRevision: readRevision(
        operation.expectedPropertyRevision,
        `${label}.expectedPropertyRevision`,
      ),
    };
  }

  if (operation.kind === "put_page_layout_entry") {
    assertExactKeys(
      operation,
      label,
      ["kind", "dataSourceId", "expectedRevision", "propertyId", "visibility"],
      ["placement"],
    );
    const placement = (() => {
      if (operation.placement === undefined) return undefined;
      const rawPlacement = readRecord(operation.placement, `${label}.placement`);
      if (rawPlacement.kind === "end") {
        assertExactKeys(rawPlacement, `${label}.placement`, ["kind"]);
        return { kind: "end" as const };
      }
      if (rawPlacement.kind === "before") {
        assertExactKeys(rawPlacement, `${label}.placement`, ["kind", "propertyId"]);
        return {
          kind: "before" as const,
          propertyId: readPropertyId(rawPlacement.propertyId, `${label}.placement.propertyId`),
        };
      }
      throw new TypeError(`${label}.placement.kind is unsupported`);
    })();
    return {
      kind: operation.kind,
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      expectedRevision: readRevision(operation.expectedRevision, `${label}.expectedRevision`),
      propertyId: readPropertyId(operation.propertyId, `${label}.propertyId`),
      visibility: readPagePropertyVisibility(operation.visibility, `${label}.visibility`),
      ...(placement === undefined ? {} : { placement }),
    };
  }

  if (operation.kind === "edit_property_values") {
    assertExactKeys(operation, label, ["kind", "edits"]);
    if (
      !Array.isArray(operation.edits) ||
      operation.edits.length < 1 ||
      operation.edits.length > MAX_DATABASE_MODULE_V2_BULK_ENTRIES
    ) {
      throw new TypeError(`${label}.edits must be a non-empty bounded array`);
    }
    const edits = operation.edits.map((rawEdit, editIndex) => {
      const editLabel = `${label}.edits[${editIndex}]`;
      const mutation = readRecord(rawEdit, editLabel);
      assertExactKeys(mutation, editLabel, ["pageId", "dataSourceId", "propertyId", "edit"]);
      const propertyId = readPropertyId(mutation.propertyId, `${editLabel}.propertyId`);
      const edit = readRecord(mutation.edit, `${editLabel}.edit`);
      if (edit.kind === "replace") {
        assertExactKeys(edit, `${editLabel}.edit`, ["kind", "expectedValueRevision", "value"]);
        return {
          pageId: readString(mutation.pageId, `${editLabel}.pageId`),
          dataSourceId: readDataSourceId(mutation.dataSourceId, `${editLabel}.dataSourceId`),
          propertyId,
          edit: {
            kind: "replace" as const,
            expectedValueRevision: readRevision(
              edit.expectedValueRevision,
              `${editLabel}.edit.expectedValueRevision`,
            ),
            value: parsePropertyValueInput(edit.value, propertyId, `${editLabel}.edit.value`),
          },
        };
      }
      if (edit.kind === "replace_one_relation") {
        assertExactKeys(
          edit,
          `${editLabel}.edit`,
          ["kind", "expectedValueRevision"],
          ["targetPageId"],
        );
        return {
          pageId: readString(mutation.pageId, `${editLabel}.pageId`),
          dataSourceId: readDataSourceId(mutation.dataSourceId, `${editLabel}.dataSourceId`),
          propertyId,
          edit: {
            kind: "replace_one_relation" as const,
            expectedValueRevision: readRevision(
              edit.expectedValueRevision,
              `${editLabel}.edit.expectedValueRevision`,
            ),
            ...(edit.targetPageId === undefined
              ? {}
              : {
                  targetPageId: readString(edit.targetPageId, `${editLabel}.edit.targetPageId`),
                }),
          },
        };
      }
      if (edit.kind === "clear_many_relation") {
        assertExactKeys(edit, `${editLabel}.edit`, ["kind", "expectedValueRevision"]);
        return {
          pageId: readString(mutation.pageId, `${editLabel}.pageId`),
          dataSourceId: readDataSourceId(mutation.dataSourceId, `${editLabel}.dataSourceId`),
          propertyId,
          edit: {
            kind: "clear_many_relation" as const,
            expectedValueRevision: readRevision(
              edit.expectedValueRevision,
              `${editLabel}.edit.expectedValueRevision`,
            ),
          },
        };
      }
      if (edit.kind !== "patch_set") {
        throw new TypeError(`${editLabel}.edit.kind is unsupported`);
      }
      assertExactKeys(edit, `${editLabel}.edit`, ["kind", "delta"]);
      const delta = readRecord(edit.delta, `${editLabel}.edit.delta`);
      let parsedDelta;
      if (delta.kind === "multi_select") {
        assertExactKeys(delta, `${editLabel}.edit.delta`, [
          "kind",
          "addOptionIds",
          "removeOptionIds",
        ]);
        parsedDelta = {
          kind: "multi_select" as const,
          addOptionIds: readOptionIdArray(
            delta.addOptionIds,
            propertyId,
            `${editLabel}.edit.delta.addOptionIds`,
          ),
          removeOptionIds: readOptionIdArray(
            delta.removeOptionIds,
            propertyId,
            `${editLabel}.edit.delta.removeOptionIds`,
          ),
        };
      } else if (delta.kind === "relation") {
        assertExactKeys(delta, `${editLabel}.edit.delta`, ["kind", "addPageIds", "removeEdgeIds"]);
        parsedDelta = {
          kind: "relation" as const,
          addPageIds: readIdentityArray(
            delta.addPageIds,
            `${editLabel}.edit.delta.addPageIds`,
            MAX_DATABASE_MODULE_V2_BULK_ENTRIES,
          ),
          removeEdgeIds: readRelationEdgeIdArray(
            delta.removeEdgeIds,
            `${editLabel}.edit.delta.removeEdgeIds`,
          ),
        };
      } else {
        throw new TypeError(`${editLabel}.edit.delta.kind is unsupported`);
      }
      const add =
        parsedDelta.kind === "multi_select" ? parsedDelta.addOptionIds : parsedDelta.addPageIds;
      const remove =
        parsedDelta.kind === "multi_select"
          ? parsedDelta.removeOptionIds
          : parsedDelta.removeEdgeIds;
      if (parsedDelta.kind === "multi_select" && add.some((entry) => remove.includes(entry))) {
        throw new TypeError(`${editLabel}.edit.delta add/remove sets must be disjoint`);
      }
      if (
        parsedDelta.kind === "relation" &&
        parsedDelta.addPageIds.length + parsedDelta.removeEdgeIds.length >
          MAX_DATABASE_MODULE_V2_BULK_ENTRIES
      ) {
        throw new TypeError(
          `${editLabel}.edit.delta may change at most ${MAX_DATABASE_MODULE_V2_BULK_ENTRIES} Relation targets`,
        );
      }
      return {
        pageId: readString(mutation.pageId, `${editLabel}.pageId`),
        dataSourceId: readDataSourceId(mutation.dataSourceId, `${editLabel}.dataSourceId`),
        propertyId,
        edit: { kind: "patch_set" as const, delta: parsedDelta },
      };
    });
    const addresses = edits.map(
      (entry) => `${entry.dataSourceId}\u0000${entry.pageId}\u0000${entry.propertyId}`,
    );
    if (new Set(addresses).size !== addresses.length) {
      throw new TypeError(`${label}.edits repeats a Page Property address`);
    }
    return { kind: "edit_property_values", edits };
  }

  if (operation.kind === "transfer_page") {
    assertExactKeys(operation, label, [
      "kind",
      "pageId",
      "expectedParentRevision",
      "expectedActiveMembershipRevision",
      "target",
    ]);
    const target = readRecord(operation.target, `${label}.target`);
    let parsedTarget: Extract<
      DatabaseApplyOperationV2,
      { readonly kind: "transfer_page" }
    >["target"];
    if (target.kind === "library") {
      assertExactKeys(target, `${label}.target`, ["kind", "libraryId"]);
      parsedTarget = {
        kind: "library",
        libraryId: readString(target.libraryId, `${label}.target.libraryId`),
      };
    } else if (target.kind === "page") {
      assertExactKeys(target, `${label}.target`, ["kind", "pageId"]);
      parsedTarget = {
        kind: "page",
        pageId: readString(target.pageId, `${label}.target.pageId`),
      };
    } else if (target.kind === "data_source") {
      assertExactKeys(target, `${label}.target`, ["kind", "dataSourceId"]);
      parsedTarget = {
        kind: "data_source",
        dataSourceId: readDataSourceId(target.dataSourceId, `${label}.target.dataSourceId`),
      };
    } else {
      throw new TypeError(`${label}.target.kind is unsupported`);
    }
    return {
      kind: "transfer_page",
      pageId: readString(operation.pageId, `${label}.pageId`),
      expectedParentRevision: readRevision(
        operation.expectedParentRevision,
        `${label}.expectedParentRevision`,
      ),
      expectedActiveMembershipRevision: readRevision(
        operation.expectedActiveMembershipRevision,
        `${label}.expectedActiveMembershipRevision`,
      ),
      target: parsedTarget,
    };
  }

  if (operation.kind === "put_view") {
    assertExactKeys(
      operation,
      label,
      [
        "kind",
        "databaseId",
        "dataSourceId",
        "viewId",
        "expectedRevision",
        "name",
        "layout",
        "config",
        "isDefault",
      ],
      ["beforeViewId"],
    );
    const beforeViewId =
      operation.beforeViewId === null
        ? null
        : operation.beforeViewId === undefined
          ? undefined
          : readViewId(operation.beforeViewId, `${label}.beforeViewId`);
    return {
      kind: "put_view",
      databaseId: readDatabaseId(operation.databaseId, `${label}.databaseId`),
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      viewId: readViewId(operation.viewId, `${label}.viewId`),
      expectedRevision: readRevision(operation.expectedRevision, `${label}.expectedRevision`),
      name: readString(operation.name, `${label}.name`, MAX_NAME_LENGTH),
      layout: readViewLayout(operation.layout, `${label}.layout`),
      config: parseDatabaseViewConfigV6(operation.config),
      isDefault: readBoolean(operation.isDefault, `${label}.isDefault`),
      ...(beforeViewId === undefined ? {} : { beforeViewId }),
    };
  }

  if (operation.kind === "duplicate_view") {
    assertExactKeys(operation, label, [
      "kind",
      "databaseId",
      "sourceViewId",
      "expectedRevision",
      "newViewId",
    ]);
    return {
      kind: "duplicate_view",
      databaseId: readDatabaseId(operation.databaseId, `${label}.databaseId`),
      sourceViewId: readViewId(operation.sourceViewId, `${label}.sourceViewId`),
      expectedRevision: readRevision(operation.expectedRevision, `${label}.expectedRevision`),
      newViewId: readViewId(operation.newViewId, `${label}.newViewId`),
    };
  }

  if (operation.kind === "change_view_layout") {
    assertExactKeys(operation, label, [
      "kind",
      "databaseId",
      "viewId",
      "expectedRevision",
      "layout",
    ]);
    return {
      kind: "change_view_layout",
      databaseId: readDatabaseId(operation.databaseId, `${label}.databaseId`),
      viewId: readViewId(operation.viewId, `${label}.viewId`),
      expectedRevision: readRevision(operation.expectedRevision, `${label}.expectedRevision`),
      layout: readViewLayout(operation.layout, `${label}.layout`),
    };
  }

  if (operation.kind === "move_view") {
    assertExactKeys(operation, label, [
      "kind",
      "databaseId",
      "viewId",
      "expectedRevision",
      "placement",
    ]);
    const placement = readRecord(operation.placement, `${label}.placement`);
    if (placement.kind !== "before" && placement.kind !== "end") {
      throw new TypeError(`${label}.placement.kind is unsupported`);
    }
    assertExactKeys(
      placement,
      `${label}.placement`,
      placement.kind === "before" ? ["kind", "viewId"] : ["kind"],
    );
    return {
      kind: operation.kind,
      databaseId: readDatabaseId(operation.databaseId, `${label}.databaseId`),
      viewId: readViewId(operation.viewId, `${label}.viewId`),
      expectedRevision: readRevision(operation.expectedRevision, `${label}.expectedRevision`),
      placement:
        placement.kind === "end"
          ? { kind: "end" }
          : {
              kind: "before",
              viewId: readViewId(placement.viewId, `${label}.placement.viewId`),
            },
    };
  }

  if (operation.kind === "delete_view") {
    assertExactKeys(operation, label, ["kind", "databaseId", "viewId", "expectedRevision"]);
    return {
      kind: "delete_view",
      databaseId: readDatabaseId(operation.databaseId, `${label}.databaseId`),
      viewId: readViewId(operation.viewId, `${label}.viewId`),
      expectedRevision: readRevision(operation.expectedRevision, `${label}.expectedRevision`),
    };
  }

  if (operation.kind === "position_page") {
    assertExactKeys(
      operation,
      label,
      ["kind", "viewId", "pageId", "expectedPositionRevision"],
      ["beforePageId"],
    );
    const beforePageId = readOptionalString(operation.beforePageId, `${label}.beforePageId`);
    return {
      kind: "position_page",
      viewId: readViewId(operation.viewId, `${label}.viewId`),
      pageId: readString(operation.pageId, `${label}.pageId`),
      expectedPositionRevision: readRevision(
        operation.expectedPositionRevision,
        `${label}.expectedPositionRevision`,
      ),
      ...(beforePageId === undefined ? {} : { beforePageId }),
    };
  }

  if (operation.kind === "position_pages") {
    assertExactKeys(operation, label, ["kind", "viewId", "pages"], ["beforePageId"]);
    if (
      !Array.isArray(operation.pages) ||
      operation.pages.length < 1 ||
      operation.pages.length > MAX_DATABASE_MODULE_V2_BULK_ENTRIES
    ) {
      throw new TypeError(
        `${label}.pages must contain between 1 and ${MAX_DATABASE_MODULE_V2_BULK_ENTRIES} entries`,
      );
    }
    const pages = operation.pages.map((entry, pageIndex) => {
      const pageLabel = `${label}.pages[${pageIndex}]`;
      const record = readRecord(entry, pageLabel);
      assertExactKeys(record, pageLabel, ["pageId", "expectedPositionRevision"]);
      return {
        pageId: readString(record.pageId, `${pageLabel}.pageId`),
        expectedPositionRevision: readRevision(
          record.expectedPositionRevision,
          `${pageLabel}.expectedPositionRevision`,
        ),
      };
    });
    if (new Set(pages.map((entry) => entry.pageId)).size !== pages.length) {
      throw new TypeError(`${label}.pages repeats a Page identity`);
    }
    const beforePageId = readOptionalString(operation.beforePageId, `${label}.beforePageId`);
    if (beforePageId && pages.some((entry) => entry.pageId === beforePageId)) {
      throw new TypeError(`${label}.beforePageId must be outside the moved Page set`);
    }
    return {
      kind: "position_pages",
      viewId: readViewId(operation.viewId, `${label}.viewId`),
      pages,
      ...(beforePageId === undefined ? {} : { beforePageId }),
    };
  }

  if (operation.kind === "set_task_parent") {
    assertExactKeys(
      operation,
      label,
      ["kind", "dataSourceId", "pages"],
      ["parentPageId", "beforePageId"],
    );
    if (
      !Array.isArray(operation.pages) ||
      operation.pages.length < 1 ||
      operation.pages.length > MAX_DATABASE_MODULE_V2_BULK_ENTRIES
    ) {
      throw new TypeError(
        `${label}.pages must contain between 1 and ${MAX_DATABASE_MODULE_V2_BULK_ENTRIES} entries`,
      );
    }
    const pages = operation.pages.map((entry, pageIndex) => {
      const pageLabel = `${label}.pages[${pageIndex}]`;
      const record = readRecord(entry, pageLabel);
      assertExactKeys(record, pageLabel, ["pageId", "expectedValueRevision"]);
      return {
        pageId: readString(record.pageId, `${pageLabel}.pageId`),
        expectedValueRevision: readRevision(
          record.expectedValueRevision,
          `${pageLabel}.expectedValueRevision`,
        ),
      };
    });
    const pageIds = new Set(pages.map((entry) => entry.pageId));
    if (pageIds.size !== pages.length) {
      throw new TypeError(`${label}.pages repeats a Page identity`);
    }
    const parentPageId = readOptionalString(operation.parentPageId, `${label}.parentPageId`);
    const beforePageId = readOptionalString(operation.beforePageId, `${label}.beforePageId`);
    if (parentPageId && pageIds.has(parentPageId)) {
      throw new TypeError(`${label}.parentPageId must be outside the moved Page set`);
    }
    if (beforePageId && pageIds.has(beforePageId)) {
      throw new TypeError(`${label}.beforePageId must be outside the moved Page set`);
    }
    if (parentPageId === undefined && beforePageId !== undefined) {
      throw new TypeError(`${label}.beforePageId requires parentPageId`);
    }
    return {
      kind: "set_task_parent",
      dataSourceId: readDataSourceId(operation.dataSourceId, `${label}.dataSourceId`),
      pages,
      ...(parentPageId === undefined ? {} : { parentPageId }),
      ...(beforePageId === undefined ? {} : { beforePageId }),
    };
  }

  if (operation.kind === "move_list_occurrences") {
    assertExactKeys(operation, label, [
      "kind",
      "viewId",
      "preferencesOverride",
      "expectedProjection",
      "initiatorOccurrenceKey",
      "selection",
      "target",
    ]);
    const expectedProjectionLabel = `${label}.expectedProjection`;
    const selectionLabel = `${label}.selection`;
    const selection = readRecord(operation.selection, selectionLabel);
    let parsedSelection: Extract<
      DatabaseApplyOperationV2,
      { readonly kind: "move_list_occurrences" }
    >["selection"];
    if (selection.kind === "explicit") {
      assertExactKeys(selection, selectionLabel, ["kind", "occurrenceKeys"]);
      parsedSelection = {
        kind: selection.kind,
        occurrenceKeys: readBoundedUniqueStrings(
          selection.occurrenceKeys,
          `${selectionLabel}.occurrenceKeys`,
          { allowEmpty: false },
        ),
      };
    } else if (selection.kind === "all_matching") {
      assertExactKeys(selection, selectionLabel, ["kind", "excludedOccurrenceKeys"]);
      parsedSelection = {
        kind: selection.kind,
        excludedOccurrenceKeys: readBoundedUniqueStrings(
          selection.excludedOccurrenceKeys,
          `${selectionLabel}.excludedOccurrenceKeys`,
          { allowEmpty: true },
        ),
      };
    } else {
      throw new TypeError(`${selectionLabel}.kind is unsupported`);
    }
    const parsedTarget = parseDatabaseListMoveTargetV2(operation.target, `${label}.target`);
    return {
      kind: operation.kind,
      viewId: readViewId(operation.viewId, `${label}.viewId`),
      preferencesOverride: parseDatabaseViewPreferencesOverride(operation.preferencesOverride),
      expectedProjection: parseDatabaseListProjectionExpectationV2(
        operation.expectedProjection,
        expectedProjectionLabel,
      ),
      initiatorOccurrenceKey: readString(
        operation.initiatorOccurrenceKey,
        `${label}.initiatorOccurrenceKey`,
        1_024,
      ),
      selection: parsedSelection,
      target: parsedTarget,
    };
  }

  if (operation.kind === "undo_list_occurrence_move") {
    assertExactKeys(operation, label, ["kind", "recipe"]);
    return {
      kind: operation.kind,
      recipe: parseDatabaseListMoveUndoRecipe(operation.recipe, `${label}.recipe`),
    };
  }

  if (operation.kind === "put_view_personal_preferences") {
    assertExactKeys(operation, label, [
      "kind",
      "viewId",
      "expectedRevision",
      "rulesOverride",
      "presentationOverride",
    ]);
    return {
      kind: "put_view_personal_preferences",
      viewId: readViewId(operation.viewId, `${label}.viewId`),
      expectedRevision: readRevision(operation.expectedRevision, `${label}.expectedRevision`),
      rulesOverride: parseDatabaseViewRulesOverride(operation.rulesOverride),
      presentationOverride: parseDatabaseViewPresentationOverride(operation.presentationOverride),
    };
  }

  if (operation.kind === "set_view_occurrence_disclosure") {
    assertExactKeys(operation, label, ["kind", "viewId", "target", "collapsed"]);
    return {
      kind: "set_view_occurrence_disclosure",
      viewId: readViewId(operation.viewId, `${label}.viewId`),
      target: parseViewDisclosureTarget(operation.target, `${label}.target`),
      collapsed: readBoolean(operation.collapsed, `${label}.collapsed`),
    };
  }

  throw new TypeError(`${label}.kind is unsupported`);
};

export interface TrustedDatabaseModuleIdentityV2 {
  readonly actor: Readonly<Record<string, DatabaseJsonValue>>;
}

const parseDatabaseApplyRequestBody = (
  request: Readonly<Record<string, unknown>>,
  label: string,
): Omit<DatabaseApplyV2, "projectId" | "actor"> => {
  if (
    !Array.isArray(request.operations) ||
    request.operations.length < 1 ||
    request.operations.length > MAX_DATABASE_MODULE_V2_OPERATIONS
  ) {
    throw new TypeError(
      `${label}.operations must contain between 1 and ${MAX_DATABASE_MODULE_V2_OPERATIONS} operations`,
    );
  }
  return {
    operationId: readString(request.operationId, `${label}.operationId`),
    storeEpoch: readString(request.storeEpoch, `${label}.storeEpoch`),
    operations: request.operations.map(parseApplyOperation),
  };
};

export const bindDatabaseApplyV2 = (
  raw: unknown,
  routeProjectId: unknown,
  trusted: TrustedDatabaseModuleIdentityV2,
): DatabaseApplyV2 => {
  const request = readRecord(raw, "databaseApplyV2");
  assertExactKeys(request, "databaseApplyV2", [
    "operationId",
    "projectId",
    "storeEpoch",
    "actor",
    "operations",
  ]);
  const projectId = readString(routeProjectId, "projectId");
  if (readString(request.projectId, "databaseApplyV2.projectId") !== projectId) {
    throw new TypeError("Database apply v2 does not match its Project route scope");
  }
  return {
    ...parseDatabaseApplyRequestBody(request, "databaseApplyV2"),
    projectId,
    actor: readJsonRecord(trusted.actor, "trusted.actor"),
  };
};

export const bindLibraryDatabaseApplyV2 = (raw: unknown): LibraryDatabaseApplyV2 => {
  const request = readRecord(raw, "libraryDatabaseApplyV2");
  assertExactKeys(request, "libraryDatabaseApplyV2", ["operationId", "storeEpoch", "operations"]);
  return parseDatabaseApplyRequestBody(request, "libraryDatabaseApplyV2");
};

const parseDatabaseReadV2 = (value: unknown): DatabaseReadV2 => {
  const read = readRecord(value, "databaseModuleReadV2.read");
  const target = readRecord(read.target, "databaseModuleReadV2.read.target");
  const mode = read.mode;
  const minimumCommitSeq =
    read.minimumCommitSeq === undefined
      ? undefined
      : readRevision(read.minimumCommitSeq, "databaseModuleReadV2.read.minimumCommitSeq");
  const readBarrier = minimumCommitSeq === undefined ? {} : { minimumCommitSeq };

  if (target.kind === "project_default") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", ["kind"]);
    if (mode === "database") {
      assertExactKeys(read, "databaseModuleReadV2.read", ["target", "mode"], ["minimumCommitSeq"]);
      return {
        target: { kind: "project_default" },
        mode,
        ...readBarrier,
      };
    }
    if (mode !== "catalog_window") {
      throw new TypeError("Project-default Database read v2 mode is unsupported");
    }
    assertExactKeys(
      read,
      "databaseModuleReadV2.read",
      ["target", "mode"],
      ["window", "minimumCommitSeq"],
    );
    const window = parseReadWindow(read.window, "Database catalog");
    return {
      target: { kind: "project_default" },
      mode,
      ...(window === undefined ? {} : { window }),
      ...readBarrier,
    };
  }

  if (target.kind === "database" && mode === "database") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", ["kind", "databaseId"]);
    assertExactKeys(read, "databaseModuleReadV2.read", ["target", "mode"], ["minimumCommitSeq"]);
    return {
      target: {
        kind: "database",
        databaseId: readDatabaseId(target.databaseId, "databaseModuleReadV2.databaseId"),
      },
      mode,
      ...readBarrier,
    };
  }

  if (target.kind === "page_key_namespace" && mode === "page_key_prefix_preview") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", ["kind"], ["databaseId"]);
    assertExactKeys(
      read,
      "databaseModuleReadV2.read",
      ["target", "mode", "nameHint"],
      ["requestedPrefix", "minimumCommitSeq"],
    );
    const databaseId =
      target.databaseId === undefined
        ? undefined
        : readDatabaseId(target.databaseId, "databaseModuleReadV2.databaseId");
    const requestedPrefix =
      read.requestedPrefix === undefined
        ? undefined
        : readString(read.requestedPrefix, "databaseModuleReadV2.requestedPrefix", 8);
    return {
      target: {
        kind: "page_key_namespace",
        ...(databaseId === undefined ? {} : { databaseId }),
      },
      mode,
      nameHint: readUtf8String(read.nameHint, "databaseModuleReadV2.nameHint", 256),
      ...(requestedPrefix === undefined ? {} : { requestedPrefix }),
      ...readBarrier,
    };
  }

  if (target.kind === "database" && mode === "page_key_namespace") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", ["kind", "databaseId"]);
    assertExactKeys(read, "databaseModuleReadV2.read", ["target", "mode"], ["minimumCommitSeq"]);
    return {
      target: {
        kind: "database",
        databaseId: readDatabaseId(target.databaseId, "databaseModuleReadV2.databaseId"),
      },
      mode,
      ...readBarrier,
    };
  }

  if (target.kind === "data_source" && mode === "data_source") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", ["kind", "dataSourceId"]);
    assertExactKeys(read, "databaseModuleReadV2.read", ["target", "mode"], ["minimumCommitSeq"]);
    return {
      target: {
        kind: "data_source",
        dataSourceId: readDataSourceId(target.dataSourceId, "databaseModuleReadV2.dataSourceId"),
      },
      mode,
      ...readBarrier,
    };
  }

  if (target.kind === "data_source" && mode === "page_layout") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", ["kind", "dataSourceId"]);
    assertExactKeys(read, "databaseModuleReadV2.read", ["target", "mode"], ["minimumCommitSeq"]);
    return {
      target: {
        kind: "data_source",
        dataSourceId: readDataSourceId(target.dataSourceId, "databaseModuleReadV2.dataSourceId"),
      },
      mode,
      ...readBarrier,
    };
  }

  if (target.kind === "data_source" && mode === "relation_candidate_window") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", ["kind", "dataSourceId"]);
    assertExactKeys(
      read,
      "databaseModuleReadV2.read",
      ["target", "mode"],
      ["query", "window", "minimumCommitSeq"],
    );
    const query =
      read.query === undefined
        ? undefined
        : readUtf8String(read.query, "databaseModuleReadV2.read.query", 512);
    const window = parseReadWindow(read.window, "Relation candidate");
    return {
      target: {
        kind: "data_source",
        dataSourceId: readDataSourceId(target.dataSourceId, "databaseModuleReadV2.dataSourceId"),
      },
      mode,
      ...(query === undefined ? {} : { query }),
      ...(window === undefined ? {} : { window }),
      ...readBarrier,
    };
  }

  if (target.kind === "view" && mode === "view") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", ["kind", "viewId"]);
    assertExactKeys(read, "databaseModuleReadV2.read", ["target", "mode"], ["minimumCommitSeq"]);
    return {
      target: {
        kind: "view",
        viewId: readViewId(target.viewId, "databaseModuleReadV2.viewId"),
      },
      mode,
      ...readBarrier,
    };
  }

  if (
    target.kind === "view" &&
    (mode === "view_personal_preferences" || mode === "view_collapsed_occurrences")
  ) {
    assertExactKeys(target, "databaseModuleReadV2.read.target", ["kind", "viewId"]);
    assertExactKeys(read, "databaseModuleReadV2.read", ["target", "mode"], ["minimumCommitSeq"]);
    return {
      target: {
        kind: "view",
        viewId: readViewId(target.viewId, "databaseModuleReadV2.viewId"),
      },
      mode,
      ...readBarrier,
    };
  }

  if (target.kind === "page_property" && mode === "relation_target_window") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", [
      "kind",
      "pageId",
      "dataSourceId",
      "propertyId",
    ]);
    assertExactKeys(
      read,
      "databaseModuleReadV2.read",
      ["target", "mode"],
      ["window", "minimumCommitSeq"],
    );
    const window = parseReadWindow(read.window, "Relation target");
    return {
      target: {
        kind: "page_property",
        pageId: readString(target.pageId, "databaseModuleReadV2.pageId"),
        dataSourceId: readDataSourceId(target.dataSourceId, "databaseModuleReadV2.dataSourceId"),
        propertyId: readPropertyId(target.propertyId, "databaseModuleReadV2.propertyId"),
      },
      mode,
      ...(window === undefined ? {} : { window }),
      ...readBarrier,
    };
  }

  if (target.kind === "property" && mode === "option_window") {
    assertExactKeys(target, "databaseModuleReadV2.read.target", [
      "kind",
      "dataSourceId",
      "propertyId",
    ]);
    assertExactKeys(
      read,
      "databaseModuleReadV2.read",
      ["target", "mode"],
      ["window", "minimumCommitSeq"],
    );
    const window = parseReadWindow(read.window, "Property option");
    return {
      target: {
        kind: "property",
        dataSourceId: readDataSourceId(target.dataSourceId, "databaseModuleReadV2.dataSourceId"),
        propertyId: readPropertyId(target.propertyId, "databaseModuleReadV2.propertyId"),
      },
      mode,
      ...(window === undefined ? {} : { window }),
      ...readBarrier,
    };
  }

  throw new TypeError("Database Module v2 read target and mode are incompatible");
};

export const bindDatabaseModuleReadV2 = (
  raw: unknown,
  routeProjectId: unknown,
): DatabaseModuleReadRequestV2 => {
  const request = readRecord(raw, "databaseModuleReadV2");
  assertExactKeys(request, "databaseModuleReadV2", ["projectId", "read"]);
  const projectId = readString(routeProjectId, "projectId");
  if (readString(request.projectId, "databaseModuleReadV2.projectId") !== projectId) {
    throw new TypeError("Database read v2 does not match its Project route scope");
  }
  return {
    projectId,
    read: parseDatabaseReadV2(request.read),
  };
};

const isProjectDefaultDatabaseRead = (
  read: DatabaseReadV2,
): read is Extract<DatabaseReadV2, { readonly target: { readonly kind: "project_default" } }> =>
  read.target.kind === "project_default";

const parseReadWindow = (
  value: unknown,
  label: string,
): { readonly after?: string | null; readonly first?: number } | undefined => {
  if (value === undefined) return undefined;
  const window = readRecord(value, "databaseModuleReadV2.read.window");
  assertExactKeys(window, "databaseModuleReadV2.read.window", [], ["after", "first"]);
  const first =
    window.first === undefined
      ? undefined
      : readRevision(window.first, "databaseModuleReadV2.read.window.first");
  if (first !== undefined && (first < 1 || first > 100)) {
    throw new TypeError(`${label} window first must be between 1 and 100`);
  }
  const after =
    window.after === undefined || window.after === null
      ? window.after
      : readString(window.after, "databaseModuleReadV2.read.window.after", 4096);
  return {
    ...(after === undefined ? {} : { after }),
    ...(first === undefined ? {} : { first }),
  };
};

export const bindLibraryDatabaseModuleReadV2 = (
  raw: unknown,
): LibraryDatabaseModuleReadRequestV2 => {
  const request = readRecord(raw, "libraryDatabaseModuleReadV2");
  assertExactKeys(request, "libraryDatabaseModuleReadV2", ["read"]);
  const read = parseDatabaseReadV2(request.read);
  if (isProjectDefaultDatabaseRead(read)) {
    throw new TypeError("Library Database reads require a concrete Database, Data Source, or View");
  }
  return {
    read,
  };
};

const DATABASE_MODULE_ERROR_CODES = new Set<DatabaseModuleErrorCodeV2>([
  "invalid_request",
  "store_not_initialized",
  "project_not_found",
  "resource_not_found",
  "authorization_denied",
  "revision_conflict",
  "operation_id_collision",
  "resource_exhausted",
  "identity_conflict",
  "state_corrupt",
  "unsupported_operation",
  "unknown",
]);

const parseDatabaseModuleErrorV2 = (value: unknown): DatabaseModuleErrorV2 => {
  const error = readRecord(value, "databaseModuleErrorV2");
  assertExactKeys(
    error,
    "databaseModuleErrorV2",
    ["code", "message", "retryable"],
    ["operationId", "expectedRevision", "actualRevision"],
  );
  if (
    typeof error.code !== "string" ||
    !DATABASE_MODULE_ERROR_CODES.has(error.code as DatabaseModuleErrorCodeV2)
  ) {
    throw new TypeError("Database Module v2 error code is unsupported");
  }
  const operationId = readOptionalString(error.operationId, "databaseModuleErrorV2.operationId");
  const expectedRevision =
    error.expectedRevision === undefined
      ? undefined
      : readRevision(error.expectedRevision, "databaseModuleErrorV2.expectedRevision");
  const actualRevision =
    error.actualRevision === undefined
      ? undefined
      : readRevision(error.actualRevision, "databaseModuleErrorV2.actualRevision");
  return {
    code: error.code as DatabaseModuleErrorCodeV2,
    message: readString(error.message, "databaseModuleErrorV2.message", 4_096),
    retryable: readBoolean(error.retryable, "databaseModuleErrorV2.retryable"),
    ...(operationId === undefined ? {} : { operationId }),
    ...(expectedRevision === undefined ? {} : { expectedRevision }),
    ...(actualRevision === undefined ? {} : { actualRevision }),
  };
};

export const databaseModuleFailureV2 = (
  code: DatabaseModuleErrorCodeV2,
  message: string,
  operationId?: string,
): DatabaseModuleErrorV2 => ({
  code,
  message,
  retryable: code === "unknown" || code === "store_not_initialized",
  ...(operationId === undefined ? {} : { operationId }),
});

export const databaseModuleHttpStatusV2 = (
  error: DatabaseModuleErrorV2,
): 400 | 403 | 404 | 409 | 500 | 503 => {
  if (error.code === "authorization_denied") return 403;
  if (error.code === "project_not_found" || error.code === "resource_not_found") {
    return 404;
  }
  if (
    error.code === "revision_conflict" ||
    error.code === "operation_id_collision" ||
    error.code === "identity_conflict"
  ) {
    return 409;
  }
  if (error.code === "store_not_initialized") return 503;
  if (error.code === "state_corrupt" || error.code === "unknown") return 500;
  return 400;
};

const readLifecycle = <Value extends string>(
  value: unknown,
  label: string,
  allowed: readonly Value[],
): Value => {
  if (typeof value === "string" && allowed.includes(value as Value)) {
    return value as Value;
  }
  throw new TypeError(`${label} is unsupported`);
};

const parseContainerRecord = (value: unknown, label: string): DatabaseContainerRecordV2 => {
  const record = readRecord(value, label);
  assertExactKeys(record, label, [
    "databaseId",
    "libraryId",
    "name",
    "lifecycle",
    "defaultViewId",
    "accessRevision",
    "metadataRevision",
    "createdAt",
    "updatedAt",
  ]);
  return {
    databaseId: readDatabaseId(record.databaseId, `${label}.databaseId`),
    libraryId: readString(record.libraryId, `${label}.libraryId`),
    name: readString(record.name, `${label}.name`, MAX_NAME_LENGTH),
    lifecycle: readLifecycle(record.lifecycle, `${label}.lifecycle`, [
      "active",
      "archived",
      "deleted",
    ] as const),
    defaultViewId:
      record.defaultViewId === null
        ? null
        : readViewId(record.defaultViewId, `${label}.defaultViewId`),
    accessRevision: readPositiveRevision(record.accessRevision, `${label}.accessRevision`),
    metadataRevision: readPositiveRevision(record.metadataRevision, `${label}.metadataRevision`),
    createdAt: readTimestamp(record.createdAt, `${label}.createdAt`),
    updatedAt: readTimestamp(record.updatedAt, `${label}.updatedAt`),
  };
};

const parseDataSourceRecord = (value: unknown, label: string): DataSourceRecordV2 => {
  const record = readRecord(value, label);
  assertExactKeys(record, label, [
    "dataSourceId",
    "libraryId",
    "homeDatabaseId",
    "name",
    "schemaKey",
    "schemaRevision",
    "lifecycle",
    "rankKey",
    "createdAt",
    "updatedAt",
  ]);
  return {
    dataSourceId: readDataSourceId(record.dataSourceId, `${label}.dataSourceId`),
    libraryId: readString(record.libraryId, `${label}.libraryId`),
    homeDatabaseId: readDatabaseId(record.homeDatabaseId, `${label}.homeDatabaseId`),
    name: readString(record.name, `${label}.name`, MAX_NAME_LENGTH),
    schemaKey: readString(record.schemaKey, `${label}.schemaKey`),
    schemaRevision: readPositiveRevision(record.schemaRevision, `${label}.schemaRevision`),
    lifecycle: readLifecycle(record.lifecycle, `${label}.lifecycle`, [
      "active",
      "archived",
      "deleted",
    ] as const),
    rankKey: readString(record.rankKey, `${label}.rankKey`),
    createdAt: readTimestamp(record.createdAt, `${label}.createdAt`),
    updatedAt: readTimestamp(record.updatedAt, `${label}.updatedAt`),
  };
};

const parsePropertyRecord = (value: unknown, label: string): DataSourcePropertyRecordV2 => {
  const record = readRecord(value, label);
  assertExactKeys(record, label, [
    "propertyId",
    "dataSourceId",
    "name",
    "schema",
    "capabilities",
    "systemRole",
    "nonEmptyValueCount",
    "referencedViewIds",
    "managementPolicy",
    "valueType",
    "config",
    "optionCount",
    "rankKey",
    "lifecycle",
    "revision",
    "createdAt",
    "updatedAt",
  ]);
  const propertyId = readPropertyId(record.propertyId, `${label}.propertyId`);
  const dataSourceId = readDataSourceId(record.dataSourceId, `${label}.dataSourceId`);
  const valueType = readPropertyValueType(record.valueType, `${label}.valueType`);
  const schema = parsePropertySchema(record.schema, `${label}.schema`);
  if (schema.kind !== valueType) {
    throw new TypeError(`${label}.schema diverges from its derived valueType`);
  }
  const capabilities = readRecord(record.capabilities, `${label}.capabilities`);
  assertExactKeys(capabilities, `${label}.capabilities`, [
    "filterOperators",
    "sortable",
    "groupable",
  ]);
  if (
    !Array.isArray(capabilities.filterOperators) ||
    capabilities.filterOperators.some((operator) => !isDatabaseViewFilterOperator(operator))
  ) {
    throw new TypeError(`${label}.capabilities.filterOperators is invalid`);
  }
  const expectedFilterOperators = databaseViewFilterOperatorsForValueType(valueType);
  if (
    capabilities.filterOperators.length !== expectedFilterOperators.length ||
    capabilities.filterOperators.some(
      (operator, index) => operator !== expectedFilterOperators[index],
    )
  ) {
    throw new TypeError(`${label}.capabilities.filterOperators diverges from its Property schema`);
  }
  const optionCount = readRevision(record.optionCount, `${label}.optionCount`);
  if (
    record.systemRole !== null &&
    record.systemRole !== "status" &&
    record.systemRole !== "task_parent"
  ) {
    throw new TypeError(`${label}.systemRole is unsupported`);
  }
  if (!Array.isArray(record.referencedViewIds)) {
    throw new TypeError(`${label}.referencedViewIds must be an array`);
  }
  const referencedViewIds = record.referencedViewIds.map((viewId, index) =>
    readViewId(viewId, `${label}.referencedViewIds[${index}]`),
  );
  const managementPolicy = readRecord(record.managementPolicy, `${label}.managementPolicy`);
  assertExactKeys(managementPolicy, `${label}.managementPolicy`, [
    "canRename",
    "canReorder",
    "canChangeType",
    "canDuplicate",
    "canDelete",
    "canRestore",
    "canPermanentlyDelete",
    "canManageOptions",
    "allowedTypes",
    "blockedReasons",
  ]);
  if (!Array.isArray(managementPolicy.allowedTypes)) {
    throw new TypeError(`${label}.managementPolicy.allowedTypes must be an array`);
  }
  const allowedTypes = managementPolicy.allowedTypes.map((allowedType, index) =>
    readPropertyValueType(allowedType, `${label}.managementPolicy.allowedTypes[${index}]`),
  );
  if (new Set(allowedTypes).size !== allowedTypes.length) {
    throw new TypeError(`${label}.managementPolicy.allowedTypes contains duplicate types`);
  }
  const blockedReasons = readIdentityArray(
    managementPolicy.blockedReasons,
    `${label}.managementPolicy.blockedReasons`,
    32,
  );
  validateBuiltInPropertyValueType(propertyId, valueType, label);
  const isOptionBacked = valueType === "select" || valueType === "multi_select";
  if (
    (isOptionBacked && optionCount > MAX_DATA_SOURCE_PROPERTY_OPTIONS) ||
    (!isOptionBacked && optionCount !== 0)
  ) {
    throw new TypeError(`${label}.optionCount diverges from its Property schema`);
  }
  if (
    propertyId === TASK_PARENT_PROPERTY_ID &&
    (schema.kind !== "relation" ||
      schema.targetDataSourceId !== dataSourceId ||
      schema.cardinality !== "one")
  ) {
    throw new TypeError(
      `${label} reserved Property task_parent must be a cardinality-one self Relation`,
    );
  }
  return {
    propertyId,
    dataSourceId,
    name: readString(record.name, `${label}.name`, MAX_NAME_LENGTH),
    schema,
    capabilities: {
      filterOperators: capabilities.filterOperators as NonNullable<
        DataSourcePropertyRecordV2["capabilities"]
      >["filterOperators"],
      sortable: readBoolean(capabilities.sortable, `${label}.capabilities.sortable`),
      groupable: readBoolean(capabilities.groupable, `${label}.capabilities.groupable`),
    },
    systemRole: record.systemRole,
    nonEmptyValueCount: readRevision(record.nonEmptyValueCount, `${label}.nonEmptyValueCount`),
    referencedViewIds,
    managementPolicy: {
      canRename: readBoolean(managementPolicy.canRename, `${label}.managementPolicy.canRename`),
      canReorder: readBoolean(managementPolicy.canReorder, `${label}.managementPolicy.canReorder`),
      canChangeType: readBoolean(
        managementPolicy.canChangeType,
        `${label}.managementPolicy.canChangeType`,
      ),
      canDuplicate: readBoolean(
        managementPolicy.canDuplicate,
        `${label}.managementPolicy.canDuplicate`,
      ),
      canDelete: readBoolean(managementPolicy.canDelete, `${label}.managementPolicy.canDelete`),
      canRestore: readBoolean(managementPolicy.canRestore, `${label}.managementPolicy.canRestore`),
      canPermanentlyDelete: readBoolean(
        managementPolicy.canPermanentlyDelete,
        `${label}.managementPolicy.canPermanentlyDelete`,
      ),
      canManageOptions: readBoolean(
        managementPolicy.canManageOptions,
        `${label}.managementPolicy.canManageOptions`,
      ),
      allowedTypes,
      blockedReasons,
    },
    valueType,
    config: parseStoredPropertyConfig(propertyId, valueType, record.config, `${label}.config`),
    optionCount,
    rankKey: readString(record.rankKey, `${label}.rankKey`),
    lifecycle: readLifecycle(record.lifecycle, `${label}.lifecycle`, [
      "active",
      "deleted",
    ] as const),
    revision: readPositiveRevision(record.revision, `${label}.revision`),
    createdAt: readTimestamp(record.createdAt, `${label}.createdAt`),
    updatedAt: readTimestamp(record.updatedAt, `${label}.updatedAt`),
  };
};

/** Validates one renderer-facing Property projection at its transport boundary. */
export const parseDataSourcePropertyRecordV2 = (value: unknown): DataSourcePropertyRecordV2 =>
  parsePropertyRecord(value, "Data Source Property");

const parseViewRecord = (value: unknown, label: string): DatabaseViewRecordV2 => {
  const record = readRecord(value, label);
  assertExactKeys(record, label, [
    "viewId",
    "databaseId",
    "dataSourceId",
    "name",
    "layout",
    "config",
    "isDefault",
    "revision",
    "rankKey",
    "lifecycle",
    "createdAt",
    "updatedAt",
  ]);
  return {
    viewId: readViewId(record.viewId, `${label}.viewId`),
    databaseId: readDatabaseId(record.databaseId, `${label}.databaseId`),
    dataSourceId: readDataSourceId(record.dataSourceId, `${label}.dataSourceId`),
    name: readString(record.name, `${label}.name`, MAX_NAME_LENGTH),
    layout: readViewLayout(record.layout, `${label}.layout`),
    config: parseDatabaseViewConfigV6(record.config),
    isDefault: readBoolean(record.isDefault, `${label}.isDefault`),
    revision: readPositiveRevision(record.revision, `${label}.revision`),
    rankKey: readString(record.rankKey, `${label}.rankKey`),
    lifecycle: readLifecycle(record.lifecycle, `${label}.lifecycle`, [
      "active",
      "deleted",
    ] as const),
    createdAt: readTimestamp(record.createdAt, `${label}.createdAt`),
    updatedAt: readTimestamp(record.updatedAt, `${label}.updatedAt`),
  };
};

const parseContainerDescriptor = (value: unknown, label: string): DatabaseContainerDescriptorV2 => {
  const descriptor = readRecord(value, label);
  assertExactKeys(descriptor, label, ["database", "dataSources", "views"]);
  if (!Array.isArray(descriptor.dataSources) || !Array.isArray(descriptor.views)) {
    throw new TypeError(`${label} collections must be arrays`);
  }
  const database = parseContainerRecord(descriptor.database, `${label}.database`);
  const dataSources = descriptor.dataSources.map((entry, index) =>
    parseDataSourceRecord(entry, `${label}.dataSources[${index}]`),
  );
  const views = descriptor.views.map((entry, index) =>
    parseViewRecord(entry, `${label}.views[${index}]`),
  );
  if (dataSources.some((entry) => entry.homeDatabaseId !== database.databaseId)) {
    throw new TypeError(`${label} contains a Data Source owned by another Database`);
  }
  if (views.some((entry) => entry.databaseId !== database.databaseId)) {
    throw new TypeError(`${label} contains a View owned by another Database`);
  }
  return { database, dataSources, views };
};

const parseDataSourceDescriptor = (value: unknown, label: string): DataSourceDescriptorV2 => {
  const descriptor = readRecord(value, label);
  assertExactKeys(descriptor, label, ["dataSource", "properties"]);
  if (!Array.isArray(descriptor.properties)) {
    throw new TypeError(`${label}.properties must be an array`);
  }
  const dataSource = parseDataSourceRecord(descriptor.dataSource, `${label}.dataSource`);
  const properties = descriptor.properties.map((entry, index) =>
    parsePropertyRecord(entry, `${label}.properties[${index}]`),
  );
  if (properties.some((entry) => entry.dataSourceId !== dataSource.dataSourceId)) {
    throw new TypeError(`${label} contains a Property owned by another Data Source`);
  }
  return { dataSource, properties };
};

const parsePageValue = (value: unknown, label: string): DataSourcePageValueV2 => {
  const record = readRecord(value, label);
  assertExactKeys(record, label, ["propertyId", "valueType", "value", "revision"]);
  return {
    propertyId: readPropertyId(record.propertyId, `${label}.propertyId`),
    valueType: readPropertyValueType(record.valueType, `${label}.valueType`),
    value: readJsonValue(record.value, `${label}.value`),
    revision: readPositiveRevision(record.revision, `${label}.revision`),
  };
};

const parseIntrinsicProperty = (value: unknown, label: string): PageIntrinsicPropertyValueV2 => {
  const property = readRecord(value, label);
  assertExactKeys(property, label, ["key", "valueType", "value", "revision"]);
  return {
    key: readString(property.key, `${label}.key`),
    valueType: readString(property.valueType, `${label}.valueType`),
    value: readJsonValue(property.value, `${label}.value`),
    revision: readPositiveRevision(property.revision, `${label}.revision`),
  };
};

const readPageBodyNfm = (value: unknown, label: string): string => {
  if (typeof value === "string" && value.length <= MAX_PAGE_DESCRIPTION_LENGTH) return value;
  throw new TypeError(`${label} must be a bounded string`);
};

const parseIntrinsicProperties = (
  value: unknown,
  label: string,
): readonly PageIntrinsicPropertyValueV2[] => {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value.map((entry, index) => parseIntrinsicProperty(entry, `${label}[${index}]`));
};

const parsePageRow = (value: unknown, label: string): DataSourcePageRowV2 => {
  const row = readRecord(value, label);
  assertExactKeys(
    row,
    label,
    [
      "pageKey",
      "page",
      "membership",
      "values",
      "position",
      "effectiveGroupKey",
      "effectiveSubgroupKey",
      "taskParent",
    ],
    ["bodyNfm", "intrinsicProperties"],
  );
  const page = parsePage(row.page);
  const membership = readRecord(row.membership, `${label}.membership`);
  assertExactKeys(membership, `${label}.membership`, [
    "membershipId",
    "dataSourceId",
    "revision",
    "createdAt",
  ]);
  const rawValues = readRecord(row.values, `${label}.values`);
  const values = Object.fromEntries(
    Object.entries(rawValues).map(([key, entry]) => {
      const propertyId = readPropertyId(key, `${label}.values key`);
      const parsed = parsePageValue(entry, `${label}.values.${key}`);
      if (parsed.propertyId !== propertyId) {
        throw new TypeError(`${label}.values.${key} has a mismatched propertyId`);
      }
      return [propertyId, parsed] as const;
    }),
  );
  const bodyNfm =
    row.bodyNfm === undefined ? undefined : readPageBodyNfm(row.bodyNfm, `${label}.bodyNfm`);
  const intrinsicProperties =
    row.intrinsicProperties === undefined
      ? undefined
      : parseIntrinsicProperties(row.intrinsicProperties, `${label}.intrinsicProperties`);
  let position: DataSourcePageRowV2["position"] = null;
  if (row.position !== null) {
    const candidate = readRecord(row.position, `${label}.position`);
    assertExactKeys(candidate, `${label}.position`, ["rankKey", "revision"], ["order"]);
    position = {
      rankKey: readString(candidate.rankKey, `${label}.position.rankKey`),
      revision: readPositiveRevision(candidate.revision, `${label}.position.revision`),
      ...(candidate.order === undefined
        ? {}
        : { order: readRevision(candidate.order, `${label}.position.order`) }),
    };
  }
  const parent = readRecord(row.taskParent, `${label}.taskParent`);
  assertExactKeys(parent, `${label}.taskParent`, ["parentPageId", "siblingRank", "valueRevision"]);
  const taskParent: DataSourcePageRowV2["taskParent"] = {
    parentPageId:
      parent.parentPageId === null
        ? null
        : readString(parent.parentPageId, `${label}.taskParent.parentPageId`),
    siblingRank:
      parent.siblingRank === null
        ? null
        : readString(parent.siblingRank, `${label}.taskParent.siblingRank`, 512),
    valueRevision: readPositiveRevision(parent.valueRevision, `${label}.taskParent.valueRevision`),
  };
  return {
    pageKey: row.pageKey === null ? null : readString(row.pageKey, `${label}.pageKey`),
    page,
    membership: {
      membershipId: readString(membership.membershipId, `${label}.membership.membershipId`),
      dataSourceId: readDataSourceId(membership.dataSourceId, `${label}.membership.dataSourceId`),
      revision: readPositiveRevision(membership.revision, `${label}.membership.revision`),
      createdAt: readTimestamp(membership.createdAt, `${label}.membership.createdAt`),
    },
    values,
    ...(bodyNfm === undefined ? {} : { bodyNfm }),
    ...(intrinsicProperties === undefined ? {} : { intrinsicProperties }),
    taskParent,
    position,
    effectiveGroupKey:
      row.effectiveGroupKey === null
        ? null
        : readString(row.effectiveGroupKey, `${label}.effectiveGroupKey`),
    effectiveSubgroupKey:
      row.effectiveSubgroupKey === null
        ? null
        : readString(row.effectiveSubgroupKey, `${label}.effectiveSubgroupKey`),
  };
};

const parseQueryCollections = (
  value: Readonly<Record<string, unknown>>,
  label: string,
): {
  readonly database: DatabaseContainerRecordV2;
  readonly dataSource: DataSourceRecordV2;
  readonly properties: readonly DataSourcePropertyRecordV2[];
  readonly rows: readonly DataSourcePageRowV2[];
} => {
  if (!Array.isArray(value.properties) || !Array.isArray(value.rows)) {
    throw new TypeError(`${label} properties and rows must be arrays`);
  }
  const database = parseContainerRecord(value.database, `${label}.database`);
  const dataSource = parseDataSourceRecord(value.dataSource, `${label}.dataSource`);
  const properties = value.properties.map((entry, index) =>
    parsePropertyRecord(entry, `${label}.properties[${index}]`),
  );
  const rows = value.rows.map((entry, index) => parsePageRow(entry, `${label}.rows[${index}]`));
  if (dataSource.homeDatabaseId !== database.databaseId) {
    throw new TypeError(`${label} Data Source belongs to another Database`);
  }
  if (properties.some((entry) => entry.dataSourceId !== dataSource.dataSourceId)) {
    throw new TypeError(`${label} contains a Property owned by another Data Source`);
  }
  if (rows.some((entry) => entry.membership.dataSourceId !== dataSource.dataSourceId)) {
    throw new TypeError(`${label} contains a row owned by another Data Source`);
  }
  return { database, dataSource, properties, rows };
};

const parseViewQueryResult = (value: unknown, label: string): DatabaseViewQueryResultV2 => {
  const result = readRecord(value, label);
  assertExactKeys(result, label, ["database", "dataSource", "view", "properties", "rows"]);
  const common = parseQueryCollections(result, label);
  const view = parseViewRecord(result.view, `${label}.view`);
  if (
    view.databaseId !== common.database.databaseId ||
    view.dataSourceId !== common.dataSource.dataSourceId
  ) {
    throw new TypeError(`${label} View has inconsistent ownership`);
  }
  return { ...common, view };
};

const parseDataSourceQueryResult = (value: unknown, label: string): DataSourceQueryResultV2 => {
  const result = readRecord(value, label);
  assertExactKeys(result, label, ["database", "dataSource", "properties", "rows"]);
  return parseQueryCollections(result, label);
};

const parseReadValue = (value: unknown): DatabaseReadValueV2 => {
  const result = readRecord(value, "databaseModuleReadV2.value");
  assertExactKeys(result, "databaseModuleReadV2.value", ["kind", "value"]);
  if (result.kind === "catalog_window") {
    const window = readRecord(result.value, "databaseModuleReadV2.value.value");
    assertExactKeys(window, "databaseModuleReadV2.value.value", [
      "databases",
      "nextCursor",
      "projectionRevision",
    ]);
    if (!Array.isArray(window.databases) || window.databases.length > 100) {
      throw new TypeError("Database catalog must be a bounded array");
    }
    return {
      kind: "catalog_window",
      value: {
        databases: window.databases.map((database, index) =>
          parseContainerDescriptor(database, `databaseCatalog.databases[${index}]`),
        ),
        nextCursor:
          window.nextCursor === null
            ? null
            : readString(window.nextCursor, "databaseCatalog.nextCursor", 4096),
        projectionRevision: readRevision(
          window.projectionRevision,
          "databaseCatalog.projectionRevision",
        ),
      },
    };
  }
  if (result.kind === "database") {
    return {
      kind: "database",
      value: parseContainerDescriptor(result.value, "databaseModuleReadV2.value.value"),
    };
  }
  if (result.kind === "page_key_prefix_preview") {
    const preview = readRecord(result.value, "databaseModuleReadV2.value.value");
    assertExactKeys(preview, "databaseModuleReadV2.value.value", [
      "prefix",
      "availability",
      "alternativePrefix",
      "nextNumber",
      "exampleKeys",
    ]);
    if (!["available", "current", "reserved"].includes(String(preview.availability))) {
      throw new TypeError("Page-key prefix availability is invalid");
    }
    if (!Array.isArray(preview.exampleKeys) || preview.exampleKeys.length > 3) {
      throw new TypeError("Page-key examples must be a bounded array");
    }
    return {
      kind: "page_key_prefix_preview",
      value: {
        prefix: readString(preview.prefix, "pageKeyPrefixPreview.prefix", 8),
        availability: preview.availability as "available" | "current" | "reserved",
        alternativePrefix:
          preview.alternativePrefix === null
            ? null
            : readString(preview.alternativePrefix, "pageKeyPrefixPreview.alternativePrefix", 8),
        nextNumber: readPositiveRevision(preview.nextNumber, "pageKeyPrefixPreview.nextNumber"),
        exampleKeys: preview.exampleKeys.map((key, index) =>
          readString(key, `pageKeyPrefixPreview.exampleKeys[${index}]`, 32),
        ),
      },
    };
  }
  if (result.kind === "page_key_namespace") {
    const namespace = readRecord(result.value, "databaseModuleReadV2.value.value");
    assertExactKeys(namespace, "databaseModuleReadV2.value.value", [
      "databaseId",
      "currentPrefix",
      "nextNumber",
      "assignedPageCount",
      "revision",
      "retiredPrefixes",
    ]);
    if (!Array.isArray(namespace.retiredPrefixes) || namespace.retiredPrefixes.length > 1_000) {
      throw new TypeError("Retired Page-key prefixes must be a bounded array");
    }
    return {
      kind: "page_key_namespace",
      value: {
        databaseId: readDatabaseId(namespace.databaseId, "pageKeyNamespace.databaseId"),
        currentPrefix: readString(namespace.currentPrefix, "pageKeyNamespace.currentPrefix", 8),
        nextNumber: readPositiveRevision(namespace.nextNumber, "pageKeyNamespace.nextNumber"),
        assignedPageCount: readRevision(
          namespace.assignedPageCount,
          "pageKeyNamespace.assignedPageCount",
        ),
        revision: readPositiveRevision(namespace.revision, "pageKeyNamespace.revision"),
        retiredPrefixes: namespace.retiredPrefixes.map((entry, index) => {
          const retired = readRecord(entry, `pageKeyNamespace.retiredPrefixes[${index}]`);
          assertExactKeys(retired, `pageKeyNamespace.retiredPrefixes[${index}]`, [
            "prefix",
            "lastNumber",
          ]);
          return {
            prefix: readString(
              retired.prefix,
              `pageKeyNamespace.retiredPrefixes[${index}].prefix`,
              8,
            ),
            lastNumber: readPositiveRevision(
              retired.lastNumber,
              `pageKeyNamespace.retiredPrefixes[${index}].lastNumber`,
            ),
          };
        }),
      },
    };
  }
  if (result.kind === "data_source") {
    return {
      kind: "data_source",
      value: parseDataSourceDescriptor(result.value, "databaseModuleReadV2.value.value"),
    };
  }
  if (result.kind === "page_layout") {
    const layout = readRecord(result.value, "databaseModuleReadV2.value.value");
    assertExactKeys(layout, "databaseModuleReadV2.value.value", [
      "dataSourceId",
      "revision",
      "entries",
    ]);
    if (!Array.isArray(layout.entries) || layout.entries.length > 2_000) {
      throw new TypeError("Page layout entries must be a bounded array");
    }
    const entries = layout.entries.map((entry, index) => {
      const entryLabel = `pageLayout.entries[${index}]`;
      const record = readRecord(entry, entryLabel);
      assertExactKeys(record, entryLabel, ["propertyId", "rankKey", "visibility"]);
      return {
        propertyId: readPropertyId(record.propertyId, `${entryLabel}.propertyId`),
        rankKey: readString(record.rankKey, `${entryLabel}.rankKey`),
        visibility: readPagePropertyVisibility(record.visibility, `${entryLabel}.visibility`),
      };
    });
    return {
      kind: result.kind,
      value: {
        dataSourceId: readDataSourceId(layout.dataSourceId, "pageLayout.dataSourceId"),
        revision: readPositiveRevision(layout.revision, "pageLayout.revision"),
        entries,
      },
    };
  }
  if (result.kind === "view") {
    return {
      kind: "view",
      value: parseViewRecord(result.value, "databaseModuleReadV2.value.value"),
    };
  }
  if (result.kind === "view_personal_preferences") {
    const presentation = readRecord(result.value, "databaseModuleReadV2.value.value");
    assertExactKeys(presentation, "databaseModuleReadV2.value.value", [
      "rulesOverride",
      "presentationOverride",
      "revision",
    ]);
    return {
      kind: "view_personal_preferences",
      value: {
        rulesOverride: parseDatabaseViewRulesOverride(presentation.rulesOverride),
        presentationOverride: parseDatabaseViewPresentationOverride(
          presentation.presentationOverride,
        ),
        revision: readRevision(presentation.revision, "databaseViewPersonalPreferences.revision"),
      },
    };
  }
  if (result.kind === "view_collapsed_occurrences") {
    const disclosure = readRecord(result.value, "databaseModuleReadV2.value.value");
    assertExactKeys(disclosure, "databaseModuleReadV2.value.value", ["targets"]);
    if (!Array.isArray(disclosure.targets) || disclosure.targets.length > 2_000) {
      throw new TypeError("View collapsed occurrences must be a bounded array");
    }
    const targets = disclosure.targets.map((target, index) =>
      parseViewDisclosureTarget(target, `databaseViewCollapsedOccurrences.targets[${index}]`),
    );
    const keys = targets.map((target) => JSON.stringify(target));
    if (new Set(keys).size !== keys.length) {
      throw new TypeError("View collapsed occurrences must contain unique targets");
    }
    return { kind: "view_collapsed_occurrences", value: { targets } };
  }
  if (result.kind === "query") {
    return {
      kind: "query",
      value: parseViewQueryResult(result.value, "databaseModuleReadV2.value.value"),
    };
  }
  if (result.kind === "data_source_query") {
    return {
      kind: "data_source_query",
      value: parseDataSourceQueryResult(result.value, "databaseModuleReadV2.value.value"),
    };
  }
  if (result.kind === "relation_target_window") {
    const window = readRecord(result.value, "databaseModuleReadV2.value.value");
    assertExactKeys(window, "databaseModuleReadV2.value.value", [
      "valueRevision",
      "totalCount",
      "targets",
      "nextCursor",
      "projectionRevision",
    ]);
    if (
      !Array.isArray(window.targets) ||
      window.targets.length > MAX_DATABASE_MODULE_V2_BULK_ENTRIES
    ) {
      throw new TypeError("Relation target window targets must be a bounded array");
    }
    const edgeIds = new Set<string>();
    const targets = window.targets.map((rawTarget, index) => {
      const target = readRecord(rawTarget, `relationTargetWindow.targets[${index}]`);
      const edgeId = readRelationEdgeId(
        target.edgeId,
        `relationTargetWindow.targets[${index}].edgeId`,
      );
      if (edgeIds.has(edgeId)) {
        throw new TypeError("Relation target window contains duplicate edge handles");
      }
      edgeIds.add(edgeId);
      if (target.kind === "restricted") {
        assertExactKeys(target, `relationTargetWindow.targets[${index}]`, ["kind", "edgeId"]);
        return {
          kind: "restricted" as const,
          edgeId,
        };
      }
      assertExactKeys(target, `relationTargetWindow.targets[${index}]`, [
        "kind",
        "edgeId",
        "pageId",
        "title",
        "lifecycle",
        "membershipState",
      ]);
      if (target.kind !== "visible") {
        throw new TypeError("Relation target kind is unsupported");
      }
      return {
        kind: "visible" as const,
        edgeId,
        pageId: readString(target.pageId, `relationTargetWindow.targets[${index}].pageId`),
        title: typeof target.title === "string" ? target.title : "",
        lifecycle: readString(target.lifecycle, `relationTargetWindow.targets[${index}].lifecycle`),
        membershipState: readString(
          target.membershipState,
          `relationTargetWindow.targets[${index}].membershipState`,
        ),
      };
    });
    return {
      kind: "relation_target_window",
      value: {
        valueRevision: readRevision(window.valueRevision, "relationTargetWindow.valueRevision"),
        totalCount: readRevision(window.totalCount, "relationTargetWindow.totalCount"),
        targets,
        nextCursor:
          window.nextCursor === null
            ? null
            : readString(window.nextCursor, "relationTargetWindow.nextCursor", 4096),
        projectionRevision: readRevision(
          window.projectionRevision,
          "relationTargetWindow.projectionRevision",
        ),
      },
    };
  }
  if (result.kind === "option_window") {
    const window = readRecord(result.value, "databaseModuleReadV2.value.value");
    assertExactKeys(window, "databaseModuleReadV2.value.value", [
      "options",
      "nextCursor",
      "projectionRevision",
    ]);
    if (
      !Array.isArray(window.options) ||
      window.options.length > MAX_DATA_SOURCE_PROPERTY_OPTIONS
    ) {
      throw new TypeError("Property option window options must be a bounded array");
    }
    const options = window.options.map((rawOption, index) => {
      const option = readRecord(rawOption, `optionWindow.options[${index}]`);
      assertExactKeys(
        option,
        `optionWindow.options[${index}]`,
        ["id", "name", "selectedPageCount"],
        ["color"],
      );
      const color =
        option.color === undefined
          ? undefined
          : readUtf8String(
              option.color,
              `optionWindow.options[${index}].color`,
              MAX_DATA_SOURCE_OPTION_COLOR_LENGTH,
            );
      return {
        id: readString(option.id, `optionWindow.options[${index}].id`),
        name: readUtf8String(
          option.name,
          `optionWindow.options[${index}].name`,
          MAX_DATA_SOURCE_OPTION_NAME_LENGTH,
        ),
        selectedPageCount: readRevision(
          option.selectedPageCount,
          `optionWindow.options[${index}].selectedPageCount`,
        ),
        ...(color === undefined ? {} : { color }),
      };
    });
    if (new Set(options.map((option) => option.id)).size !== options.length) {
      throw new TypeError("Property option window contains duplicate identities");
    }
    return {
      kind: "option_window",
      value: {
        options,
        nextCursor:
          window.nextCursor === null
            ? null
            : readString(window.nextCursor, "optionWindow.nextCursor", 4096),
        projectionRevision: readRevision(
          window.projectionRevision,
          "optionWindow.projectionRevision",
        ),
      },
    };
  }
  if (result.kind === "relation_candidate_window") {
    const window = readRecord(result.value, "databaseModuleReadV2.value.value");
    assertExactKeys(window, "databaseModuleReadV2.value.value", [
      "candidates",
      "nextCursor",
      "projectionRevision",
    ]);
    if (!Array.isArray(window.candidates) || window.candidates.length > 100) {
      throw new TypeError("Relation candidate window must be a bounded array");
    }
    const candidates = window.candidates.map((rawCandidate, index) => {
      const candidate = readRecord(rawCandidate, `relationCandidateWindow.candidates[${index}]`);
      assertExactKeys(candidate, `relationCandidateWindow.candidates[${index}]`, [
        "pageId",
        "title",
      ]);
      return {
        pageId: readString(candidate.pageId, `relationCandidateWindow.candidates[${index}].pageId`),
        title: typeof candidate.title === "string" ? candidate.title : "",
      };
    });
    if (new Set(candidates.map((candidate) => candidate.pageId)).size !== candidates.length) {
      throw new TypeError("Relation candidate window contains duplicate Page identities");
    }
    return {
      kind: "relation_candidate_window",
      value: {
        candidates,
        nextCursor:
          window.nextCursor === null
            ? null
            : readString(window.nextCursor, "relationCandidateWindow.nextCursor", 4096),
        projectionRevision: readRevision(
          window.projectionRevision,
          "relationCandidateWindow.projectionRevision",
        ),
      },
    };
  }
  throw new TypeError("Database Module v2 read value kind is unsupported");
};

const parseResultEnvelope = (
  value: unknown,
  label: string,
  allowLocalCommit = false,
): Readonly<Record<string, unknown>> => {
  const result = readRecord(value, label);
  const keys = Object.keys(result);
  if (
    keys.length !== (allowLocalCommit && result.ok === true ? 3 : 2) ||
    !Object.prototype.hasOwnProperty.call(result, "ok") ||
    (!Object.prototype.hasOwnProperty.call(result, "value") &&
      !Object.prototype.hasOwnProperty.call(result, "error")) ||
    (allowLocalCommit &&
      result.ok === true &&
      !Object.prototype.hasOwnProperty.call(result, "localCommit"))
  ) {
    throw new TypeError(`${label} envelope is invalid`);
  }
  return result;
};

const parseDatabaseModuleReadSnapshotBody = (
  snapshot: Readonly<Record<string, unknown>>,
  label: string,
): Omit<DatabaseModuleReadSnapshotV2, "projectId"> => {
  return {
    libraryId: readString(snapshot.libraryId, `${label}.libraryId`),
    storeEpoch: readString(snapshot.storeEpoch, `${label}.storeEpoch`),
    commitSeq: readRevision(snapshot.commitSeq, `${label}.commitSeq`),
    authorization:
      snapshot.authorization === null ? null : parseAuthorizedReadStamp(snapshot.authorization),
    value: parseReadValue(snapshot.value),
  };
};

export const parseDatabaseModuleReadResultV2 = (value: unknown): DatabaseModuleReadResultV2 => {
  const result = parseResultEnvelope(value, "Database Module v2 read result");
  if (result.ok === false && Object.prototype.hasOwnProperty.call(result, "error")) {
    return { ok: false, error: parseDatabaseModuleErrorV2(result.error) };
  }
  if (result.ok !== true || !Object.prototype.hasOwnProperty.call(result, "value")) {
    throw new TypeError("Database Module v2 read result envelope is invalid");
  }
  const snapshot = readRecord(result.value, "databaseModuleReadV2.snapshot");
  assertExactKeys(snapshot, "databaseModuleReadV2.snapshot", [
    "projectId",
    "libraryId",
    "storeEpoch",
    "commitSeq",
    "authorization",
    "value",
  ]);
  return {
    ok: true,
    value: {
      ...parseDatabaseModuleReadSnapshotBody(snapshot, "databaseModuleReadV2.snapshot"),
      projectId: readString(snapshot.projectId, "databaseModuleReadV2.snapshot.projectId"),
    },
  };
};

const readUniqueIdentityArray = <Identity extends string>(
  value: unknown,
  label: string,
  parse: (entry: unknown, entryLabel: string) => Identity,
): readonly Identity[] => {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const entries = value.map((entry, index) => parse(entry, `${label}[${index}]`));
  if (new Set(entries).size !== entries.length) {
    throw new TypeError(`${label} must contain unique identities`);
  }
  return entries;
};

const OPERATION_KINDS = new Set<DatabaseApplyOperationV2["kind"]>([
  "rename_page_key_prefix",
  "put_property",
  "move_property",
  "change_property_type",
  "duplicate_property",
  "restore_property",
  "permanently_delete_property",
  "delete_property",
  "put_option",
  "move_option",
  "delete_option",
  "delete_option_and_clear_values",
  "put_page_layout_entry",
  "edit_property_values",
  "transfer_page",
  "put_view",
  "duplicate_view",
  "change_view_layout",
  "move_view",
  "delete_view",
  "position_page",
  "position_pages",
  "set_task_parent",
  "move_list_occurrences",
  "undo_list_occurrence_move",
  "put_view_personal_preferences",
  "set_view_occurrence_disclosure",
]);

const parseDatabaseOperationOutcome = (
  value: unknown,
  index: number,
): DatabaseOperationOutcomeV2 => {
  const label = `databaseApplyV2.receipt.operationOutcomes[${index}]`;
  const outcome = readRecord(value, label);
  if (outcome.kind === "list_occurrence_move") {
    assertExactKeys(outcome, label, [
      "kind",
      "operationIndex",
      "movedPageIds",
      "moveRootPageIds",
      "normalizedTarget",
      "undoRecipe",
    ]);
    const targetLabel = `${label}.normalizedTarget`;
    const target = readRecord(outcome.normalizedTarget, targetLabel);
    assertExactKeys(target, targetLabel, [
      "targetOccurrenceKey",
      "targetPageId",
      "parentPageId",
      "beforePageId",
      "groupKey",
      "subgroupKey",
      "depth",
      "edge",
    ]);
    if (target.edge !== "before" && target.edge !== "after" && target.edge !== "inside") {
      throw new TypeError(`${targetLabel}.edge is unsupported`);
    }
    return {
      kind: outcome.kind,
      operationIndex: readRevision(outcome.operationIndex, `${label}.operationIndex`),
      movedPageIds: readBoundedUniqueStrings(outcome.movedPageIds, `${label}.movedPageIds`, {
        allowEmpty: false,
      }),
      moveRootPageIds: readBoundedUniqueStrings(
        outcome.moveRootPageIds,
        `${label}.moveRootPageIds`,
        { allowEmpty: false },
      ),
      normalizedTarget: {
        targetOccurrenceKey: readString(
          target.targetOccurrenceKey,
          `${targetLabel}.targetOccurrenceKey`,
          1_024,
        ),
        targetPageId: readNullableString(target.targetPageId, `${targetLabel}.targetPageId`),
        parentPageId: readNullableString(target.parentPageId, `${targetLabel}.parentPageId`),
        beforePageId: readNullableString(target.beforePageId, `${targetLabel}.beforePageId`),
        groupKey: readNullableString(target.groupKey, `${targetLabel}.groupKey`, 1_024),
        subgroupKey: readNullableString(target.subgroupKey, `${targetLabel}.subgroupKey`, 1_024),
        depth: readRevision(target.depth, `${targetLabel}.depth`),
        edge: target.edge,
      },
      undoRecipe: parseDatabaseListMoveUndoRecipe(outcome.undoRecipe, `${label}.undoRecipe`),
    };
  }
  if (outcome.kind === "list_occurrence_move_undo") {
    assertExactKeys(outcome, label, ["kind", "operationIndex", "restoredPageIds"]);
    return {
      kind: outcome.kind,
      operationIndex: readRevision(outcome.operationIndex, `${label}.operationIndex`),
      restoredPageIds: readBoundedUniqueStrings(
        outcome.restoredPageIds,
        `${label}.restoredPageIds`,
        { allowEmpty: false },
      ),
    };
  }
  throw new TypeError(`${label}.kind is unsupported`);
};

const parseDatabaseApplyReceiptBody = (
  receipt: Readonly<Record<string, unknown>>,
  label: string,
): Omit<DatabaseApplyReceiptV2, "projectId"> => {
  if (!Array.isArray(receipt.operationKinds)) {
    throw new TypeError(`${label}.operationKinds must be an array`);
  }
  const operationKinds = receipt.operationKinds.map((entry) => {
    if (
      typeof entry === "string" &&
      OPERATION_KINDS.has(entry as DatabaseApplyOperationV2["kind"])
    ) {
      return entry as DatabaseApplyOperationV2["kind"];
    }
    throw new TypeError(`${label} contains an unsupported operation kind`);
  });
  if (!Array.isArray(receipt.operationOutcomes)) {
    throw new TypeError(`${label}.operationOutcomes must be an array`);
  }
  const operationOutcomes = receipt.operationOutcomes.map(parseDatabaseOperationOutcome);
  const committedRevisionRecord = readRecord(
    receipt.committedRevisions,
    `${label}.committedRevisions`,
  );
  const committedRevisions = Object.fromEntries(
    Object.entries(committedRevisionRecord).map(([key, entry]) => [
      readString(key, `${label}.committedRevisions key`, 4_096),
      readRevision(entry, `${label}.committedRevisions.${key}`),
    ]),
  );
  return {
    operationId: readString(receipt.operationId, `${label}.operationId`),
    libraryId: readString(receipt.libraryId, `${label}.libraryId`),
    storeEpoch: readString(receipt.storeEpoch, `${label}.storeEpoch`),
    duplicate: readBoolean(receipt.duplicate, `${label}.duplicate`),
    operationKinds,
    operationOutcomes,
    affectedDatabaseIds: readUniqueIdentityArray(
      receipt.affectedDatabaseIds,
      `${label}.affectedDatabaseIds`,
      readDatabaseId,
    ),
    affectedDataSourceIds: readUniqueIdentityArray(
      receipt.affectedDataSourceIds,
      `${label}.affectedDataSourceIds`,
      readDataSourceId,
    ),
    affectedPageIds: readUniqueIdentityArray(
      receipt.affectedPageIds,
      `${label}.affectedPageIds`,
      (entry, entryLabel) => readString(entry, entryLabel),
    ),
    affectedViewIds: readUniqueIdentityArray(
      receipt.affectedViewIds,
      `${label}.affectedViewIds`,
      readViewId,
    ),
    committedRevisions,
    commitSeq: readRevision(receipt.commitSeq, `${label}.commitSeq`),
    committedAt: readTimestamp(receipt.committedAt, `${label}.committedAt`),
  };
};

export const parseDatabaseApplyResultV2 = (value: unknown): DatabaseApplyResultV2 => {
  const result = parseResultEnvelope(value, "Database Module v2 apply result", true);
  if (result.ok === false && Object.prototype.hasOwnProperty.call(result, "error")) {
    return { ok: false, error: parseDatabaseModuleErrorV2(result.error) };
  }
  if (result.ok !== true || !Object.prototype.hasOwnProperty.call(result, "value")) {
    throw new TypeError("Database Module v2 apply result envelope is invalid");
  }
  const receipt = readRecord(result.value, "databaseApplyV2.receipt");
  assertExactKeys(receipt, "databaseApplyV2.receipt", [
    "operationId",
    "projectId",
    "libraryId",
    "storeEpoch",
    "duplicate",
    "operationKinds",
    "operationOutcomes",
    "affectedDatabaseIds",
    "affectedDataSourceIds",
    "affectedPageIds",
    "affectedViewIds",
    "committedRevisions",
    "commitSeq",
    "committedAt",
  ]);
  return {
    ok: true,
    localCommit: parseLocalCommitApply(result.localCommit),
    value: {
      ...parseDatabaseApplyReceiptBody(receipt, "databaseApplyV2.receipt"),
      projectId: readString(receipt.projectId, "databaseApplyV2.receipt.projectId"),
    },
  };
};

const assertLibraryAccessContext = (value: unknown, label: string): void => {
  const context = readRecord(value, label);
  assertExactKeys(context, label, ["kind"]);
  if (context.kind !== "library") {
    throw new TypeError(`${label}.kind must be library`);
  }
};

export const parseLibraryDatabaseModuleReadResultV2 = (
  value: unknown,
): LibraryDatabaseModuleReadResultV2 => {
  const result = parseResultEnvelope(value, "Library Database Module v2 read result");
  if (result.ok === false && Object.prototype.hasOwnProperty.call(result, "error")) {
    return { ok: false, error: parseDatabaseModuleErrorV2(result.error) };
  }
  if (result.ok !== true || !Object.prototype.hasOwnProperty.call(result, "value")) {
    throw new TypeError("Library Database Module v2 read result envelope is invalid");
  }
  const snapshot = readRecord(result.value, "libraryDatabaseModuleReadV2.snapshot");
  assertExactKeys(snapshot, "libraryDatabaseModuleReadV2.snapshot", [
    "accessContext",
    "libraryId",
    "storeEpoch",
    "commitSeq",
    "authorization",
    "value",
  ]);
  assertLibraryAccessContext(
    snapshot.accessContext,
    "libraryDatabaseModuleReadV2.snapshot.accessContext",
  );
  return {
    ok: true,
    value: {
      ...parseDatabaseModuleReadSnapshotBody(snapshot, "libraryDatabaseModuleReadV2.snapshot"),
      accessContext: { kind: "library" },
    },
  };
};

export const parseLibraryDatabaseApplyResultV2 = (value: unknown): LibraryDatabaseApplyResultV2 => {
  const result = parseResultEnvelope(value, "Library Database Module v2 apply result", true);
  if (result.ok === false && Object.prototype.hasOwnProperty.call(result, "error")) {
    return { ok: false, error: parseDatabaseModuleErrorV2(result.error) };
  }
  if (result.ok !== true || !Object.prototype.hasOwnProperty.call(result, "value")) {
    throw new TypeError("Library Database Module v2 apply result envelope is invalid");
  }
  const receipt = readRecord(result.value, "libraryDatabaseApplyV2.receipt");
  assertExactKeys(receipt, "libraryDatabaseApplyV2.receipt", [
    "operationId",
    "accessContext",
    "libraryId",
    "storeEpoch",
    "duplicate",
    "operationKinds",
    "operationOutcomes",
    "affectedDatabaseIds",
    "affectedDataSourceIds",
    "affectedPageIds",
    "affectedViewIds",
    "committedRevisions",
    "commitSeq",
    "committedAt",
  ]);
  assertLibraryAccessContext(receipt.accessContext, "libraryDatabaseApplyV2.receipt.accessContext");
  return {
    ok: true,
    localCommit: parseLocalCommitApply(result.localCommit),
    value: {
      ...parseDatabaseApplyReceiptBody(receipt, "libraryDatabaseApplyV2.receipt"),
      accessContext: { kind: "library" },
    },
  };
};
