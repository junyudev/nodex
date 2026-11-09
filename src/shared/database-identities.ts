import { WORKFLOW_STATUS_ORDER } from "./workflow-status";
import { PRIORITY_VALUES } from "./priority";
import { assertUuidV7, createUuidV7 } from "./uuid-v7";

const MAX_OPAQUE_ID_LENGTH = 512;
const CUSTOM_ID_BYTE_LENGTH = 6;
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const CUSTOM_PROPERTY_ID_PATTERN = /^p_[A-Za-z0-9_-]{8}$/u;
const CUSTOM_OPTION_ID_PATTERN = /^o_[A-Za-z0-9_-]{8}$/u;
const LEADING_UNICODE_WHITESPACE = /^\p{White_Space}+/u;
const TRAILING_UNICODE_WHITESPACE = /\p{White_Space}+$/u;

declare const databaseIdentityBrand: unique symbol;

type BrandedDatabaseIdentity<Kind extends string> = string & {
  readonly [databaseIdentityBrand]: Kind;
};

export type DatabaseId = BrandedDatabaseIdentity<"DatabaseId">;
export type DataSourceId = BrandedDatabaseIdentity<"DataSourceId">;
export type DatabaseViewId = BrandedDatabaseIdentity<"DatabaseViewId">;
export type DataSourcePropertyId = BrandedDatabaseIdentity<"DataSourcePropertyId">;
export type DataSourceOptionId = BrandedDatabaseIdentity<"DataSourceOptionId">;

export interface DataSourcePropertyRef {
  readonly dataSourceId: DataSourceId;
  readonly propertyId: DataSourcePropertyId;
}

export interface DataSourceOptionRef extends DataSourcePropertyRef {
  readonly optionId: DataSourceOptionId;
}

export interface InitialDatabaseIdentities {
  readonly databaseId: DatabaseId;
  readonly dataSourceId: DataSourceId;
  readonly viewId: DatabaseViewId;
}

export type DatabaseIdentityByteSource = (length: number) => Uint8Array;
export type DatabaseUuidV7Source = () => string;

export const BLOCKED_BY_PROPERTY_ID = "blocked_by" as const;

export const TASK_PARENT_PROPERTY_ID = "task_parent" as const;

export const BUILT_IN_DATA_SOURCE_PROPERTY_IDS = [
  "status",
  "priority",
  "estimate",
  "tags",
  "due_date",
  "scheduled_start",
  "scheduled_end",
  "assignee",
  "owner",
  TASK_PARENT_PROPERTY_ID,
  BLOCKED_BY_PROPERTY_ID,
] as const;

export type BuiltInDataSourcePropertyId = (typeof BUILT_IN_DATA_SOURCE_PROPERTY_IDS)[number];

const ESTIMATE_OPTION_IDS = ["xs", "s", "m", "l", "xl"] as const;

/** Built-in option identity is meaningful only under its owning Property. */
export const BUILT_IN_DATA_SOURCE_OPTION_IDS = {
  status: WORKFLOW_STATUS_ORDER,
  priority: PRIORITY_VALUES,
  estimate: ESTIMATE_OPTION_IDS,
} as const;

export type BuiltInDataSourceOptionOwnerId = keyof typeof BUILT_IN_DATA_SOURCE_OPTION_IDS;

export type BuiltInDataSourceOptionId =
  (typeof BUILT_IN_DATA_SOURCE_OPTION_IDS)[BuiltInDataSourceOptionOwnerId][number];

const BUILT_IN_PROPERTY_ID_SET = new Set<string>(BUILT_IN_DATA_SOURCE_PROPERTY_IDS);

const parseOpaqueIdentity = <Kind extends string>(
  value: unknown,
  label: string,
): BrandedDatabaseIdentity<Kind> => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_OPAQUE_ID_LENGTH ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(
      `${label} must be a canonical non-empty identity of at most ${MAX_OPAQUE_ID_LENGTH} characters`,
    );
  }
  return value as BrandedDatabaseIdentity<Kind>;
};

/**
 * Existing global identities remain opaque during migration, so these parsers
 * validate their transport form rather than requiring newly allocated UUID-v7.
 */
export const parseDatabaseId = (value: unknown): DatabaseId =>
  parseOpaqueIdentity<"DatabaseId">(value, "databaseId");

export const parseDataSourceId = (value: unknown): DataSourceId =>
  parseOpaqueIdentity<"DataSourceId">(value, "dataSourceId");

export const parseDatabaseViewId = (value: unknown): DatabaseViewId =>
  parseOpaqueIdentity<"DatabaseViewId">(value, "viewId");

export const isBuiltInDataSourcePropertyId = (
  value: unknown,
): value is BuiltInDataSourcePropertyId =>
  typeof value === "string" && BUILT_IN_PROPERTY_ID_SET.has(value);

export const isReservedDataSourcePropertyId = isBuiltInDataSourcePropertyId;

export const isCustomDataSourcePropertyId = (value: unknown): value is DataSourcePropertyId =>
  typeof value === "string" && CUSTOM_PROPERTY_ID_PATTERN.test(value);

export const isCustomDataSourceOptionId = (value: unknown): value is DataSourceOptionId =>
  typeof value === "string" && CUSTOM_OPTION_ID_PATTERN.test(value);

export const parseDataSourcePropertyId = (value: unknown): DataSourcePropertyId => {
  if (isBuiltInDataSourcePropertyId(value) || isCustomDataSourcePropertyId(value)) {
    return value as DataSourcePropertyId;
  }
  throw new TypeError(
    "propertyId must be a reserved built-in ID or p_ followed by exactly 8 base64url characters",
  );
};

const acceptsCustomOptionId = (propertyId: DataSourcePropertyId): boolean =>
  propertyId === "tags" || isCustomDataSourcePropertyId(propertyId);

export const isBuiltInDataSourceOptionId = (
  propertyId: unknown,
  value: unknown,
): value is BuiltInDataSourceOptionId => {
  if (
    typeof propertyId !== "string" ||
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(BUILT_IN_DATA_SOURCE_OPTION_IDS, propertyId)
  ) {
    return false;
  }
  const optionIds = BUILT_IN_DATA_SOURCE_OPTION_IDS[
    propertyId as BuiltInDataSourceOptionOwnerId
  ] as readonly string[];
  return optionIds.includes(value);
};

export const parseDataSourceOptionId = (input: {
  readonly propertyId: unknown;
  readonly value: unknown;
}): DataSourceOptionId => {
  const propertyId = parseDataSourcePropertyId(input.propertyId);
  if (isBuiltInDataSourceOptionId(propertyId, input.value)) {
    return input.value as DataSourceOptionId;
  }
  if (acceptsCustomOptionId(propertyId) && isCustomDataSourceOptionId(input.value)) {
    return input.value;
  }
  throw new TypeError(`optionId is not valid for Data Source Property ${propertyId}`);
};

const secureRandomBytes: DatabaseIdentityByteSource = (length) => {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

const encodeSixBytesAsBase64Url = (bytes: Uint8Array): string => {
  if (bytes.length !== CUSTOM_ID_BYTE_LENGTH) {
    throw new TypeError(
      `Database identity byte source must return exactly ${CUSTOM_ID_BYTE_LENGTH} bytes`,
    );
  }
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const chunk =
      ((bytes[index] ?? 0) << 16) | ((bytes[index + 1] ?? 0) << 8) | (bytes[index + 2] ?? 0);
    encoded += BASE64URL_ALPHABET[(chunk >>> 18) & 63];
    encoded += BASE64URL_ALPHABET[(chunk >>> 12) & 63];
    encoded += BASE64URL_ALPHABET[(chunk >>> 6) & 63];
    encoded += BASE64URL_ALPHABET[chunk & 63];
  }
  return encoded;
};

const createCompactId = (prefix: "p_" | "o_", byteSource: DatabaseIdentityByteSource): string => {
  const bytes = byteSource(CUSTOM_ID_BYTE_LENGTH);
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("Database identity byte source must return Uint8Array");
  }
  return `${prefix}${encodeSixBytesAsBase64Url(bytes)}`;
};

export const createCustomPropertyId = (
  byteSource: DatabaseIdentityByteSource = secureRandomBytes,
): DataSourcePropertyId => parseDataSourcePropertyId(createCompactId("p_", byteSource));

export const createCustomOptionId = (
  byteSource: DatabaseIdentityByteSource = secureRandomBytes,
): DataSourceOptionId => createCompactId("o_", byteSource) as DataSourceOptionId;

export const createInitialDatabaseIdentities = (
  uuidSource: DatabaseUuidV7Source = createUuidV7,
): InitialDatabaseIdentities => {
  const databaseId = assertUuidV7(uuidSource(), "databaseId");
  const dataSourceId = assertUuidV7(uuidSource(), "dataSourceId");
  const viewId = assertUuidV7(uuidSource(), "viewId");
  if (new Set([databaseId, dataSourceId, viewId]).size !== 3) {
    throw new Error("Initial Database identities must be independently allocated");
  }
  return {
    databaseId: parseDatabaseId(databaseId),
    dataSourceId: parseDataSourceId(dataSourceId),
    viewId: parseDatabaseViewId(viewId),
  };
};

export const canonicalizeTagName = (
  value: unknown,
  options: { readonly maxLength?: number } = {},
): string => {
  if (typeof value !== "string") {
    throw new TypeError("Tag name must be a string");
  }
  const { maxLength } = options;
  if (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 1)) {
    throw new TypeError("Tag name maxLength must be a positive safe integer");
  }
  const canonical = value
    .replace(LEADING_UNICODE_WHITESPACE, "")
    .replace(TRAILING_UNICODE_WHITESPACE, "")
    .normalize("NFC");
  if (!canonical) {
    throw new TypeError("Tag name must not be empty");
  }
  if (maxLength !== undefined && canonical.length > maxLength) {
    throw new RangeError(`Tag name must contain at most ${maxLength} characters`);
  }
  return canonical;
};
