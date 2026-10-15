import type { BlockPropertyJsonValue } from "./block-property-mutations";
import { stableStringifyBlockPropertyJson } from "./block-property-mutations";
import { parseDatabaseModuleReadResultV2 } from "./database-module-v2-transport";
import {
  PageLifecycleV2ContractError,
  parsePageLifecycleMutationRequestV2,
  type PageLifecycleMutationCommandErrorV2,
  type PageLifecycleMutationCommandResultV2,
  type PageLifecycleMutationRequestV2,
} from "./page-lifecycle-v2";
import {
  type PageLifecyclePreflightErrorCodeV2,
  type PageLifecyclePreflightResultV2,
} from "./page-lifecycle-v2-runtime";

export interface TrustedPageLifecycleMutationIdentityV2 {
  readonly actor: Readonly<Record<string, BlockPropertyJsonValue>>;
  readonly clientSessionId?: string;
}

export type TrustedPageLifecycleMutationBindingV2 =
  | { readonly ok: true; readonly value: PageLifecycleMutationRequestV2 }
  | { readonly ok: false; readonly error: PageLifecycleMutationCommandErrorV2 };

const readRecord = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

const PREFLIGHT_ERROR_CODES_V2 = new Set<PageLifecyclePreflightErrorCodeV2>([
  "invalid_request",
  "store_not_initialized",
  "project_not_found",
  "page_not_found",
  "state_corrupt",
  "unknown",
]);

const readCanonicalIdentity = (value: unknown, label: string): string => {
  if (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value === value.trim()
  ) {
    return value;
  }
  throw new TypeError(`${label} must be a canonical identity`);
};

const readRevision = (value: unknown, label: string): number => {
  if (Number.isSafeInteger(value) && (value as number) >= 0) {
    return value as number;
  }
  throw new TypeError(`${label} must be a non-negative safe integer`);
};

const assertExactKeys = (
  value: Readonly<Record<string, unknown>>,
  label: string,
  required: readonly string[],
): void => {
  const allowed = new Set(required);
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (missing.length > 0) {
    throw new TypeError(`${label} is missing ${missing.join(", ")}`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`${label} contains unsupported fields: ${unknown.join(", ")}`);
  }
};

export const parsePageLifecyclePreflightResultV2 = (
  value: unknown,
): PageLifecyclePreflightResultV2 => {
  const result = readRecord(value);
  if (!result) throw new TypeError("Page lifecycle v2 preflight result is invalid");
  if (result.ok === false) {
    assertExactKeys(result, "Page lifecycle v2 preflight result", ["ok", "error"]);
    const error = readRecord(result.error);
    if (
      !error ||
      typeof error.code !== "string" ||
      !PREFLIGHT_ERROR_CODES_V2.has(error.code as PageLifecyclePreflightErrorCodeV2) ||
      typeof error.message !== "string" ||
      error.message.length === 0 ||
      typeof error.retryable !== "boolean"
    ) {
      throw new TypeError("Page lifecycle v2 preflight error is invalid");
    }
    assertExactKeys(error, "Page lifecycle v2 preflight error", ["code", "message", "retryable"]);
    return value as PageLifecyclePreflightResultV2;
  }
  if (result.ok !== true) {
    throw new TypeError("Page lifecycle v2 preflight result.ok is invalid");
  }
  assertExactKeys(result, "Page lifecycle v2 preflight result", ["ok", "value"]);
  const snapshot = readRecord(result.value);
  if (!snapshot) throw new TypeError("Page lifecycle v2 preflight snapshot is invalid");
  assertExactKeys(snapshot, "Page lifecycle v2 preflight snapshot", [
    "projectId",
    "libraryId",
    "storeEpoch",
    "commitSeq",
    "value",
  ]);
  const projectId =
    snapshot.projectId === null ? null : readCanonicalIdentity(snapshot.projectId, "projectId");
  const libraryId = readCanonicalIdentity(snapshot.libraryId, "libraryId");
  const storeEpoch = readCanonicalIdentity(snapshot.storeEpoch, "storeEpoch");
  const commitSeq = readRevision(snapshot.commitSeq, "commitSeq");
  const preflight = readRecord(snapshot.value);
  if (!preflight) throw new TypeError("Page lifecycle v2 preflight is invalid");
  assertExactKeys(preflight, "Page lifecycle v2 preflight", [
    "defaultView",
    "tagsProperty",
    "reservedBlockType",
    "page",
  ]);
  if (projectId === null) {
    if (preflight.defaultView !== null || preflight.tagsProperty !== null) {
      throw new TypeError("Library Page lifecycle cannot infer a default Project destination");
    }
  } else {
    const parsedQuery = parseDatabaseModuleReadResultV2({
      ok: true,
      value: {
        projectId,
        libraryId,
        storeEpoch,
        commitSeq,
        value: { kind: "query", value: preflight.defaultView },
      },
    });
    if (!parsedQuery.ok || parsedQuery.value.value.kind !== "query") {
      throw new TypeError("Page lifecycle v2 default View query is invalid");
    }
    const tags = readRecord(preflight.tagsProperty);
    if (!tags) throw new TypeError("Page lifecycle v2 tags Property is invalid");
    assertExactKeys(tags, "Page lifecycle v2 tags Property", [
      "propertyId",
      "dataSourceId",
      "valueType",
      "lifecycle",
      "revision",
      "config",
    ]);
    const canonicalTags = parsedQuery.value.value.value.properties.find(
      (property) => property.propertyId === "tags",
    );
    stableStringifyBlockPropertyJson(tags.config);
    if (
      !canonicalTags ||
      tags.propertyId !== canonicalTags.propertyId ||
      tags.dataSourceId !== canonicalTags.dataSourceId ||
      tags.valueType !== "multi_select" ||
      tags.lifecycle !== "active" ||
      tags.revision !== canonicalTags.revision
    ) {
      throw new TypeError("Page lifecycle v2 tags Property diverges from the default View query");
    }
  }
  if (preflight.reservedBlockType !== null && typeof preflight.reservedBlockType !== "string") {
    throw new TypeError("Page lifecycle v2 reserved Block type is invalid");
  }
  if (preflight.page !== null && !readRecord(preflight.page)) {
    throw new TypeError("Page lifecycle v2 Page authority is invalid");
  }
  return value as PageLifecyclePreflightResultV2;
};

const readBoundedHint = (value: unknown, key: string): string | undefined => {
  const candidate = readRecord(value)?.[key];
  if (
    typeof candidate === "string" &&
    candidate.length > 0 &&
    candidate.length <= 512 &&
    candidate === candidate.trim()
  ) {
    return candidate;
  }
  return undefined;
};

const readPageIdHint = (value: unknown): string | undefined =>
  readBoundedHint(readRecord(value)?.operation, "pageId");

export const pageLifecycleMutationFailureV2 = (
  code: PageLifecycleMutationCommandErrorV2["code"],
  message: string,
  rawRequest?: unknown,
  options: { readonly retryable?: boolean } = {},
): PageLifecycleMutationCommandErrorV2 => ({
  code,
  message,
  retryable: options.retryable ?? false,
  ...(readBoundedHint(rawRequest, "operationId") === undefined
    ? {}
    : { operationId: readBoundedHint(rawRequest, "operationId") }),
  ...(readPageIdHint(rawRequest) === undefined ? {} : { pageId: readPageIdHint(rawRequest) }),
});

/**
 * Bind a v2 request to trusted route/IPC scope and host attribution. Public
 * actor and session claims never cross this boundary unchanged.
 */
export const bindTrustedPageLifecycleMutationV2 = (
  rawRequest: unknown,
  projectId: string | null,
  identity: TrustedPageLifecycleMutationIdentityV2,
): TrustedPageLifecycleMutationBindingV2 => {
  let request: PageLifecycleMutationRequestV2;
  try {
    request = parsePageLifecycleMutationRequestV2(rawRequest);
  } catch (error) {
    return {
      ok: false,
      error: pageLifecycleMutationFailureV2(
        "invalid_page_lifecycle_request",
        error instanceof PageLifecycleV2ContractError
          ? error.message
          : "Page lifecycle mutation v2 request is invalid",
        rawRequest,
      ),
    };
  }

  if (request.projectId !== projectId) {
    return {
      ok: false,
      error: pageLifecycleMutationFailureV2(
        "invalid_page_lifecycle_request",
        "Page lifecycle mutation v2 does not match its presentation route",
        request,
      ),
    };
  }

  try {
    return {
      ok: true,
      value: parsePageLifecycleMutationRequestV2({
        ...request,
        projectId,
        actor: identity.actor,
        ...(identity.clientSessionId === undefined
          ? { clientSessionId: undefined }
          : { clientSessionId: identity.clientSessionId }),
      }),
    };
  } catch (error) {
    return {
      ok: false,
      error: pageLifecycleMutationFailureV2(
        "invalid_page_lifecycle_request",
        error instanceof PageLifecycleV2ContractError
          ? error.message
          : "Trusted Page lifecycle mutation v2 identity is invalid",
        request,
      ),
    };
  }
};

export const pageLifecycleMutationHttpStatusV2 = (
  error: PageLifecycleMutationCommandErrorV2,
): 400 | 403 | 404 | 409 | 500 => {
  if (
    error.code === "project_not_found" ||
    error.code === "page_not_found" ||
    error.code === "data_source_not_found" ||
    error.code === "tags_property_not_found" ||
    error.code === "membership_not_found" ||
    error.code === "view_not_found"
  ) {
    return 404;
  }
  if (
    error.code === "store_epoch_mismatch" ||
    error.code === "operation_id_collision" ||
    error.code === "page_identity_collision" ||
    error.code === "page_type_mismatch" ||
    error.code === "page_lifecycle_conflict" ||
    error.code === "metadata_revision_conflict" ||
    error.code === "parent_revision_conflict" ||
    error.code === "page_parent_invalid" ||
    error.code === "position_anchor_not_found" ||
    error.code === "position_anchor_group_mismatch" ||
    error.code === "tags_property_revision_conflict" ||
    error.code === "tag_option_identity_conflict" ||
    error.code === "tag_name_conflict" ||
    error.code === "delete_evidence_invalid"
  ) {
    return 409;
  }
  if (error.code === "unknown") return 500;
  return 400;
};

export const pageLifecycleTransportFailureV2 = (
  request: PageLifecycleMutationRequestV2,
  error: unknown,
): PageLifecycleMutationCommandResultV2 => ({
  ok: false,
  error: pageLifecycleMutationFailureV2(
    "unknown",
    error instanceof Error ? error.message : "The durable Page lifecycle v2 writer is unavailable",
    request,
    { retryable: true },
  ),
});
