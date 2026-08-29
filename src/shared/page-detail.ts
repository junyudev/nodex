import {
  stableStringifyBlockPropertyJson,
  type BlockPropertyJsonValue,
} from "./block-property-mutations";
import type {
  DatabaseContainerRecordV2,
  DatabasePageLayoutV2,
  DataSourcePageValueV2,
  DataSourcePropertyRecordV2,
  DataSourceRecordV2,
} from "./database-module-v2";
import { parseAuthorizedReadStamp, type AuthorizedReadStamp } from "./authorized-read-stamp";
import {
  parseDatabaseId,
  parseDatabaseViewId,
  parseDataSourceId,
  parseDataSourcePropertyId,
} from "./database-identities";
import type { DatabasePropertyValueType } from "./database-kernel";
import { parsePage, type Page } from "./page";

export interface PageIntrinsicProperty {
  readonly key: string;
  readonly valueType: "null" | "boolean" | "number" | "string" | "json";
  readonly value: BlockPropertyJsonValue;
  readonly revision: number;
}

export type PageDataSourceContext =
  | { readonly kind: "standalone" }
  | {
      readonly kind: "member";
      readonly pageKey: string | null;
      readonly membership: {
        readonly membershipId: string;
        readonly dataSourceId: string;
        readonly revision: number;
        readonly createdAt: string;
      };
      readonly database: DatabaseContainerRecordV2;
      readonly dataSource: DataSourceRecordV2;
      readonly properties: readonly DataSourcePropertyRecordV2[];
      readonly pageLayout: DatabasePageLayoutV2;
      readonly values: Readonly<Record<string, DataSourcePageValueV2>>;
    };

export interface PageDetail {
  readonly projectId: string;
  readonly libraryId: string;
  readonly storeEpoch: string;
  readonly commitSeq: number;
  readonly authorization: AuthorizedReadStamp;
  readonly page: Page;
  readonly document: {
    readonly readiness: "pending_genesis" | "ready" | "failed";
    readonly schemaKey: string;
    readonly schemaVersion: number;
  };
  readonly intrinsicProperties: readonly PageIntrinsicProperty[];
  readonly dataSourceContext: PageDataSourceContext;
}

export type PageDetailErrorCode =
  | "invalid_request"
  | "store_not_initialized"
  | "project_not_found"
  | "page_not_found"
  | "authorization_denied"
  | "page_detail_corrupt"
  | "unknown";

export interface PageDetailError {
  readonly code: PageDetailErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type PageDetailResult =
  | { readonly ok: true; readonly value: PageDetail }
  | { readonly ok: false; readonly error: PageDetailError };

export interface LibraryPageDetail extends Omit<PageDetail, "projectId"> {
  readonly accessContext: { readonly kind: "library" };
}

export type LibraryPageDetailResult =
  | { readonly ok: true; readonly value: LibraryPageDetail }
  | { readonly ok: false; readonly error: PageDetailError };

export class PageDetailContractError extends TypeError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PageDetailContractError";
  }
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const identity = (value: unknown, label: string): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim()
  ) {
    return value;
  }
  throw new PageDetailContractError(`${label} must be a canonical identity`);
};

const scopedIdentity = <T>(value: unknown, label: string, parser: (candidate: unknown) => T): T => {
  try {
    return parser(value);
  } catch (error) {
    throw new PageDetailContractError(`${label} is invalid`, { cause: error });
  }
};

const exactKeys = (
  value: Readonly<Record<string, unknown>>,
  label: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void => {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (Object.hasOwn(value, key)) continue;
    throw new PageDetailContractError(`${label}.${key} is required`);
  }
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    throw new PageDetailContractError(`${label}.${key} is not supported`);
  }
};

const boundedText = (value: unknown, label: string, allowEmpty = false): string => {
  if (typeof value === "string" && value.length <= 1_000_000 && (allowEmpty || value.length > 0)) {
    return value;
  }
  throw new PageDetailContractError(`${label} must be a bounded string`);
};

const revision = (value: unknown, label: string): number => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  throw new PageDetailContractError(`${label} must be a non-negative revision`);
};

const portableJson = (value: unknown, label: string): BlockPropertyJsonValue => {
  try {
    return JSON.parse(stableStringifyBlockPropertyJson(value)) as BlockPropertyJsonValue;
  } catch (error) {
    throw new PageDetailContractError(`${label} must be bounded portable JSON`, {
      cause: error,
    });
  }
};

const valueType = (value: unknown, label: string): DatabasePropertyValueType => {
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
  throw new PageDetailContractError(`${label} is unsupported`);
};

const parseDatabase = (value: unknown, libraryId: string): DatabaseContainerRecordV2 => {
  if (!isRecord(value)) {
    throw new PageDetailContractError("pageDetail.database must be an object");
  }
  exactKeys(value, "pageDetail.database", [
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
  const databaseLibraryId = identity(value.libraryId, "pageDetail.database.libraryId");
  if (databaseLibraryId !== libraryId) {
    throw new PageDetailContractError("Page Detail Database belongs to another Library");
  }
  if (value.lifecycle !== "active" && value.lifecycle !== "archived") {
    throw new PageDetailContractError("pageDetail.database.lifecycle is invalid");
  }
  return {
    databaseId: scopedIdentity(value.databaseId, "pageDetail.database.databaseId", parseDatabaseId),
    libraryId: databaseLibraryId,
    name: boundedText(value.name, "pageDetail.database.name"),
    lifecycle: value.lifecycle,
    defaultViewId:
      value.defaultViewId === null
        ? null
        : scopedIdentity(
            value.defaultViewId,
            "pageDetail.database.defaultViewId",
            parseDatabaseViewId,
          ),
    accessRevision: revision(value.accessRevision, "pageDetail.database.accessRevision"),
    metadataRevision: revision(value.metadataRevision, "pageDetail.database.metadataRevision"),
    createdAt: boundedText(value.createdAt, "pageDetail.database.createdAt"),
    updatedAt: boundedText(value.updatedAt, "pageDetail.database.updatedAt"),
  };
};

const parseDataSource = (
  value: unknown,
  libraryId: string,
  databaseId: string,
): DataSourceRecordV2 => {
  if (!isRecord(value)) {
    throw new PageDetailContractError("pageDetail.dataSource must be an object");
  }
  exactKeys(value, "pageDetail.dataSource", [
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
  const sourceLibraryId = identity(value.libraryId, "pageDetail.dataSource.libraryId");
  const homeDatabaseId = scopedIdentity(
    value.homeDatabaseId,
    "pageDetail.dataSource.homeDatabaseId",
    parseDatabaseId,
  );
  if (sourceLibraryId !== libraryId || homeDatabaseId !== databaseId) {
    throw new PageDetailContractError("Page Detail Data Source ownership coordinates diverge");
  }
  if (value.lifecycle !== "active" && value.lifecycle !== "archived") {
    throw new PageDetailContractError("pageDetail.dataSource.lifecycle is invalid");
  }
  return {
    dataSourceId: scopedIdentity(
      value.dataSourceId,
      "pageDetail.dataSource.dataSourceId",
      parseDataSourceId,
    ),
    libraryId: sourceLibraryId,
    homeDatabaseId,
    name: boundedText(value.name, "pageDetail.dataSource.name"),
    schemaKey: identity(value.schemaKey, "pageDetail.dataSource.schemaKey"),
    schemaRevision: revision(value.schemaRevision, "pageDetail.dataSource.schemaRevision"),
    lifecycle: value.lifecycle,
    rankKey: identity(value.rankKey, "pageDetail.dataSource.rankKey"),
    createdAt: boundedText(value.createdAt, "pageDetail.dataSource.createdAt"),
    updatedAt: boundedText(value.updatedAt, "pageDetail.dataSource.updatedAt"),
  };
};

const parseProperty = (
  value: unknown,
  index: number,
  dataSourceId: string,
): DataSourcePropertyRecordV2 => {
  const label = `pageDetail.properties[${index}]`;
  if (!isRecord(value)) {
    throw new PageDetailContractError(`${label} must be an object`);
  }
  exactKeys(value, label, [
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
  const propertyDataSourceId = scopedIdentity(
    value.dataSourceId,
    `${label}.dataSourceId`,
    parseDataSourceId,
  );
  if (propertyDataSourceId !== dataSourceId || value.lifecycle !== "active") {
    throw new PageDetailContractError(`${label} is not an active property of the Page Data Source`);
  }
  const propertyValueType = valueType(value.valueType, `${label}.valueType`);
  const schema = portableJson(value.schema, `${label}.schema`);
  const capabilities = portableJson(value.capabilities, `${label}.capabilities`);
  const managementPolicy = portableJson(value.managementPolicy, `${label}.managementPolicy`);
  if (
    !isRecord(schema) ||
    schema.kind !== propertyValueType ||
    !isRecord(capabilities) ||
    !isRecord(managementPolicy)
  ) {
    throw new PageDetailContractError(`${label} typed semantics are invalid`);
  }
  exactKeys(managementPolicy, `${label}.managementPolicy`, [
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
  const booleanPolicyFields = [
    "canRename",
    "canReorder",
    "canChangeType",
    "canDuplicate",
    "canDelete",
    "canRestore",
    "canPermanentlyDelete",
    "canManageOptions",
  ] as const;
  for (const field of booleanPolicyFields) {
    if (typeof managementPolicy[field] === "boolean") continue;
    throw new PageDetailContractError(`${label}.managementPolicy.${field} must be a boolean`);
  }
  if (!Array.isArray(managementPolicy.allowedTypes)) {
    throw new PageDetailContractError(`${label}.managementPolicy.allowedTypes must be an array`);
  }
  const allowedTypes = managementPolicy.allowedTypes.map((allowedType, allowedTypeIndex) =>
    valueType(allowedType, `${label}.managementPolicy.allowedTypes[${allowedTypeIndex}]`),
  );
  if (new Set(allowedTypes).size !== allowedTypes.length) {
    throw new PageDetailContractError(
      `${label}.managementPolicy.allowedTypes contains duplicate types`,
    );
  }
  if (
    !Array.isArray(managementPolicy.blockedReasons) ||
    managementPolicy.blockedReasons.some((reason) => typeof reason !== "string")
  ) {
    throw new PageDetailContractError(`${label}.managementPolicy.blockedReasons is invalid`);
  }
  if (
    value.systemRole !== null &&
    value.systemRole !== "status" &&
    value.systemRole !== "task_parent"
  ) {
    throw new PageDetailContractError(`${label}.systemRole is invalid`);
  }
  if (!Array.isArray(value.referencedViewIds)) {
    throw new PageDetailContractError(`${label}.referencedViewIds must be an array`);
  }
  const rawConfig = portableJson(value.config, `${label}.config`);
  if (!isRecord(rawConfig)) {
    throw new PageDetailContractError(`${label}.config must be an object`);
  }
  if (Object.keys(rawConfig).length > 0) {
    throw new PageDetailContractError(`${label}.config must not inline an option registry`);
  }
  return {
    propertyId: scopedIdentity(value.propertyId, `${label}.propertyId`, parseDataSourcePropertyId),
    dataSourceId: propertyDataSourceId,
    name: boundedText(value.name, `${label}.name`),
    schema: schema as DataSourcePropertyRecordV2["schema"],
    capabilities: capabilities as unknown as DataSourcePropertyRecordV2["capabilities"],
    systemRole: value.systemRole,
    nonEmptyValueCount: revision(value.nonEmptyValueCount, `${label}.nonEmptyValueCount`),
    referencedViewIds: value.referencedViewIds.map((viewId, viewIndex) =>
      scopedIdentity(viewId, `${label}.referencedViewIds[${viewIndex}]`, parseDatabaseViewId),
    ),
    managementPolicy: {
      canRename: managementPolicy.canRename,
      canReorder: managementPolicy.canReorder,
      canChangeType: managementPolicy.canChangeType,
      canDuplicate: managementPolicy.canDuplicate,
      canDelete: managementPolicy.canDelete,
      canRestore: managementPolicy.canRestore,
      canPermanentlyDelete: managementPolicy.canPermanentlyDelete,
      canManageOptions: managementPolicy.canManageOptions,
      allowedTypes,
      blockedReasons: managementPolicy.blockedReasons,
    } as DataSourcePropertyRecordV2["managementPolicy"],
    valueType: propertyValueType,
    config: {},
    optionCount: revision(value.optionCount, `${label}.optionCount`),
    rankKey: identity(value.rankKey, `${label}.rankKey`),
    lifecycle: "active",
    revision: revision(value.revision, `${label}.revision`),
    createdAt: boundedText(value.createdAt, `${label}.createdAt`),
    updatedAt: boundedText(value.updatedAt, `${label}.updatedAt`),
  };
};

const parseValues = (
  value: unknown,
  properties: readonly DataSourcePropertyRecordV2[],
): Readonly<Record<string, DataSourcePageValueV2>> => {
  if (!isRecord(value)) {
    throw new PageDetailContractError("pageDetail.values must be an object");
  }
  const propertiesById = new Map(properties.map((property) => [property.propertyId, property]));
  const result: Record<string, DataSourcePageValueV2> = {};
  for (const [propertyId, raw] of Object.entries(value)) {
    const parsedPropertyId = scopedIdentity(
      propertyId,
      `pageDetail.values.${propertyId}.propertyId`,
      parseDataSourcePropertyId,
    );
    const property = propertiesById.get(parsedPropertyId);
    if (!property || !isRecord(raw)) {
      throw new PageDetailContractError(`pageDetail.values.${propertyId} has no matching property`);
    }
    exactKeys(raw, `pageDetail.values.${propertyId}`, [
      "propertyId",
      "valueType",
      "value",
      "revision",
    ]);
    if (
      identity(raw.propertyId, `pageDetail.values.${propertyId}.propertyId`) !== propertyId ||
      valueType(raw.valueType, `pageDetail.values.${propertyId}.valueType`) !== property.valueType
    ) {
      throw new PageDetailContractError(`pageDetail.values.${propertyId} diverges from its schema`);
    }
    result[propertyId] = {
      propertyId: parsedPropertyId,
      valueType: property.valueType,
      value: portableJson(raw.value, `pageDetail.values.${propertyId}.value`),
      revision: revision(raw.revision, `pageDetail.values.${propertyId}.revision`),
    };
  }
  return result;
};

const parseDataSourceContext = (
  value: Readonly<Record<string, unknown>>,
  page: Page,
  libraryId: string,
): PageDataSourceContext => {
  if (value.kind === "standalone") {
    exactKeys(value, "pageDetail.dataSourceContext", ["kind"]);
    if (page.parent.kind === "data_source") {
      throw new PageDetailContractError(
        "A Data Source-parented Page cannot have standalone context",
      );
    }
    return { kind: "standalone" };
  }
  if (value.kind !== "member") {
    throw new PageDetailContractError("Page Detail Data Source context is invalid");
  }
  exactKeys(value, "pageDetail.dataSourceContext", [
    "kind",
    "pageKey",
    "membership",
    "database",
    "dataSource",
    "properties",
    "pageLayout",
    "values",
  ]);
  if (
    !isRecord(value.membership) ||
    !Array.isArray(value.properties) ||
    !isRecord(value.pageLayout)
  ) {
    throw new PageDetailContractError("Page Detail Data Source membership payload is invalid");
  }
  exactKeys(value.membership, "pageDetail.membership", [
    "membershipId",
    "dataSourceId",
    "revision",
    "createdAt",
  ]);
  const membershipDataSourceId = identity(
    value.membership.dataSourceId,
    "pageDetail.membership.dataSourceId",
  );
  if (page.parent.kind !== "data_source" || page.parent.dataSourceId !== membershipDataSourceId) {
    throw new PageDetailContractError("Page parent and Data Source membership diverge");
  }
  const database = parseDatabase(value.database, libraryId);
  const dataSource = parseDataSource(value.dataSource, libraryId, database.databaseId);
  if (dataSource.dataSourceId !== membershipDataSourceId) {
    throw new PageDetailContractError("Page membership and Data Source identity diverge");
  }
  const properties = value.properties.map((property, index) =>
    parseProperty(property, index, dataSource.dataSourceId),
  );
  if (new Set(properties.map((property) => property.propertyId)).size !== properties.length) {
    throw new PageDetailContractError(
      "Page Detail properties must have unique identities and keys",
    );
  }
  exactKeys(value.pageLayout, "pageDetail.pageLayout", ["dataSourceId", "revision", "entries"]);
  if (!Array.isArray(value.pageLayout.entries)) {
    throw new PageDetailContractError("pageDetail.pageLayout.entries must be an array");
  }
  const pageLayout: DatabasePageLayoutV2 = {
    dataSourceId: scopedIdentity(
      value.pageLayout.dataSourceId,
      "pageDetail.pageLayout.dataSourceId",
      parseDataSourceId,
    ),
    revision: revision(value.pageLayout.revision, "pageDetail.pageLayout.revision"),
    entries: value.pageLayout.entries.map((entry, index) => {
      const entryLabel = `pageDetail.pageLayout.entries[${index}]`;
      if (!isRecord(entry)) throw new PageDetailContractError(`${entryLabel} must be an object`);
      exactKeys(entry, entryLabel, ["propertyId", "rankKey", "visibility"]);
      if (
        entry.visibility !== "always_show" &&
        entry.visibility !== "hide_when_empty" &&
        entry.visibility !== "always_hide"
      ) {
        throw new PageDetailContractError(`${entryLabel}.visibility is invalid`);
      }
      return {
        propertyId: scopedIdentity(
          entry.propertyId,
          `${entryLabel}.propertyId`,
          parseDataSourcePropertyId,
        ),
        rankKey: identity(entry.rankKey, `${entryLabel}.rankKey`),
        visibility: entry.visibility,
      };
    }),
  };
  if (pageLayout.dataSourceId !== dataSource.dataSourceId) {
    throw new PageDetailContractError("Page layout belongs to another Data Source");
  }
  return {
    kind: "member",
    pageKey:
      value.pageKey === undefined || value.pageKey === null
        ? null
        : boundedText(value.pageKey, "pageDetail.dataSourceContext.pageKey"),
    membership: {
      membershipId: identity(value.membership.membershipId, "pageDetail.membership.membershipId"),
      dataSourceId: membershipDataSourceId,
      revision: revision(value.membership.revision, "pageDetail.membership.revision"),
      createdAt: boundedText(value.membership.createdAt, "pageDetail.membership.createdAt"),
    },
    database,
    dataSource,
    properties,
    pageLayout,
    values: parseValues(value.values, properties),
  };
};

const parsePageDetailBody = (
  detail: Readonly<Record<string, unknown>>,
): Omit<PageDetail, "projectId"> => {
  if (
    !isRecord(detail.document) ||
    !Array.isArray(detail.intrinsicProperties) ||
    !isRecord(detail.dataSourceContext)
  ) {
    throw new PageDetailContractError("Page Detail payload is invalid");
  }
  exactKeys(detail.document, "pageDetail.document", ["readiness", "schemaKey", "schemaVersion"]);
  const page = parsePage(detail.page);
  const libraryId = identity(detail.libraryId, "pageDetail.libraryId");
  const storeEpoch = identity(detail.storeEpoch, "pageDetail.storeEpoch");
  if (page.libraryId !== libraryId) {
    throw new PageDetailContractError("Page Detail Library coordinate diverges");
  }
  if (
    detail.document.readiness !== "pending_genesis" &&
    detail.document.readiness !== "ready" &&
    detail.document.readiness !== "failed"
  ) {
    throw new PageDetailContractError("Page Detail readiness is invalid");
  }
  const documentReadiness = detail.document.readiness as "pending_genesis" | "ready" | "failed";
  const document = {
    readiness: documentReadiness,
    schemaKey: identity(detail.document.schemaKey, "pageDetail.document.schemaKey"),
    schemaVersion: revision(detail.document.schemaVersion, "pageDetail.document.schemaVersion"),
  };
  const commitSeq = revision(detail.commitSeq, "pageDetail.commitSeq");
  const authorization = parseAuthorizedReadStamp(detail.authorization, libraryId);
  if (
    authorization.store_epoch !== storeEpoch ||
    authorization.covered_commit_seq !== commitSeq ||
    authorization.subject.kind !== "page" ||
    authorization.subject.page_id !== page.pageId
  ) {
    throw new PageDetailContractError("Page Detail authorization stamp diverges");
  }
  const intrinsicProperties: PageIntrinsicProperty[] = [];
  for (const [index, property] of detail.intrinsicProperties.entries()) {
    if (!isRecord(property)) {
      throw new PageDetailContractError(`pageDetail.intrinsicProperties[${index}] is invalid`);
    }
    const label = `pageDetail.intrinsicProperties[${index}]`;
    exactKeys(property, label, ["key", "valueType", "value", "revision"]);
    const intrinsicValueType = property.valueType;
    const intrinsicValue = portableJson(property.value, `${label}.value`);
    if (
      (intrinsicValueType === "null" && intrinsicValue !== null) ||
      (intrinsicValueType === "boolean" && typeof intrinsicValue !== "boolean") ||
      (intrinsicValueType === "number" && typeof intrinsicValue !== "number") ||
      (intrinsicValueType === "string" &&
        intrinsicValue !== null &&
        typeof intrinsicValue !== "string") ||
      (intrinsicValueType === "json" &&
        intrinsicValue !== null &&
        !Array.isArray(intrinsicValue) &&
        typeof intrinsicValue !== "object") ||
      (intrinsicValueType !== "null" &&
        intrinsicValueType !== "boolean" &&
        intrinsicValueType !== "number" &&
        intrinsicValueType !== "string" &&
        intrinsicValueType !== "json")
    ) {
      throw new PageDetailContractError(`${label}.valueType is invalid`);
    }
    intrinsicProperties.push({
      key: identity(property.key, `${label}.key`),
      valueType: intrinsicValueType,
      value: intrinsicValue,
      revision: revision(property.revision, `${label}.revision`),
    });
  }
  if (
    new Set(intrinsicProperties.map((property) => property.key)).size !== intrinsicProperties.length
  ) {
    throw new PageDetailContractError("Page Detail intrinsic property keys must be unique");
  }
  return {
    libraryId,
    storeEpoch,
    commitSeq,
    authorization,
    page,
    document,
    intrinsicProperties,
    dataSourceContext: parseDataSourceContext(detail.dataSourceContext, page, libraryId),
  };
};

const errorCodes = new Set<PageDetailErrorCode>([
  "invalid_request",
  "store_not_initialized",
  "project_not_found",
  "page_not_found",
  "authorization_denied",
  "page_detail_corrupt",
  "unknown",
]);

export const parsePageDetailResult = (value: unknown): PageDetailResult => {
  if (!isRecord(value)) {
    throw new PageDetailContractError("Page Detail result must be an object");
  }
  if (value.ok === false && isRecord(value.error)) {
    exactKeys(value, "pageDetailResult", ["ok", "error"]);
    exactKeys(value.error, "pageDetailResult.error", ["code", "message", "retryable"]);
    const code = value.error.code;
    if (
      typeof code !== "string" ||
      !errorCodes.has(code as PageDetailErrorCode) ||
      typeof value.error.message !== "string" ||
      typeof value.error.retryable !== "boolean"
    ) {
      throw new PageDetailContractError("Page Detail error is invalid");
    }
    return {
      ok: false,
      error: {
        code: code as PageDetailErrorCode,
        message: value.error.message,
        retryable: value.error.retryable,
      },
    };
  }
  if (value.ok !== true || !isRecord(value.value)) {
    throw new PageDetailContractError("Page Detail result envelope is invalid");
  }
  exactKeys(value, "pageDetailResult", ["ok", "value"]);
  const detail = value.value;
  exactKeys(detail, "pageDetail", [
    "projectId",
    "libraryId",
    "storeEpoch",
    "commitSeq",
    "authorization",
    "page",
    "document",
    "intrinsicProperties",
    "dataSourceContext",
  ]);
  const projectId = identity(detail.projectId, "pageDetail.projectId");
  return {
    ok: true,
    value: {
      ...parsePageDetailBody(detail),
      projectId,
    },
  };
};

export const parseLibraryPageDetailResult = (value: unknown): LibraryPageDetailResult => {
  if (!isRecord(value)) {
    throw new PageDetailContractError("Library Page Detail result is invalid");
  }
  if (value.ok === false) {
    const parsed = parsePageDetailResult(value);
    if (parsed.ok) {
      throw new PageDetailContractError("Library Page Detail error envelope is invalid");
    }
    return parsed;
  }
  if (value.ok !== true || !isRecord(value.value)) {
    throw new PageDetailContractError("Library Page Detail result envelope is invalid");
  }
  exactKeys(value, "libraryPageDetailResult", ["ok", "value"]);
  const detail = value.value;
  exactKeys(detail, "libraryPageDetail", [
    "accessContext",
    "libraryId",
    "storeEpoch",
    "commitSeq",
    "authorization",
    "page",
    "document",
    "intrinsicProperties",
    "dataSourceContext",
  ]);
  if (!isRecord(detail.accessContext)) {
    throw new PageDetailContractError("Library Page Detail access context is invalid");
  }
  exactKeys(detail.accessContext, "libraryPageDetail.accessContext", ["kind"]);
  if (detail.accessContext.kind !== "library") {
    throw new PageDetailContractError("Library Page Detail access context must be library");
  }
  return {
    ok: true,
    value: {
      ...parsePageDetailBody(detail),
      accessContext: { kind: "library" },
    },
  };
};
