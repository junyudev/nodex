import type { components } from "@nodex/core-protocol";

import { deliveryAddressKey, type DeliveryAddress } from "./recipient-delivery";

export type AuthorizedReadStamp = components["schemas"]["AuthorizedReadStamp"];
export type AuthorizationScope = components["schemas"]["DeliveryAuthorizationScope"];
export type AuthorityResource = components["schemas"]["ResourceKey"];

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length && actual.every((key, index) => key === canonical[index])
  );
};

const isIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim();

const RESOURCE_KIND_ORDER: Readonly<Record<AuthorityResource["kind"], number>> = {
  library: 0,
  project: 1,
  page: 2,
  document: 3,
  database: 4,
  data_source: 5,
  view: 6,
  canvas: 7,
  file: 8,
};
const UTF8_ENCODER = new TextEncoder();

const authorityResourceId = (resource: AuthorityResource): string => {
  switch (resource.kind) {
    case "library":
      return resource.library_id;
    case "project":
      return resource.project_id;
    case "page":
      return resource.page_id;
    case "document":
      return resource.document_id;
    case "database":
      return resource.database_id;
    case "data_source":
      return resource.data_source_id;
    case "view":
      return resource.view_id;
    case "canvas":
      return resource.canvas_id;
    case "file":
      return resource.file_id;
  }
};

export const authorityResourceKey = (resource: AuthorityResource): string => {
  switch (resource.kind) {
    case "library":
      return JSON.stringify([resource.kind, resource.library_id]);
    case "project":
      return JSON.stringify([resource.kind, resource.project_id]);
    case "page":
      return JSON.stringify([resource.kind, resource.page_id]);
    case "document":
      return JSON.stringify([resource.kind, resource.document_id]);
    case "database":
      return JSON.stringify([resource.kind, resource.database_id]);
    case "data_source":
      return JSON.stringify([resource.kind, resource.data_source_id]);
    case "view":
      return JSON.stringify([resource.kind, resource.view_id]);
    case "canvas":
      return JSON.stringify([resource.kind, resource.canvas_id]);
    case "file":
      return JSON.stringify([resource.kind, resource.file_id]);
  }
};

export const isAuthorityResource = (value: unknown): value is AuthorityResource => {
  if (!isRecord(value) || !isIdentity(value.kind)) return false;
  switch (value.kind) {
    case "library":
      return hasExactKeys(value, ["kind", "library_id"]) && isIdentity(value.library_id);
    case "project":
      return hasExactKeys(value, ["kind", "project_id"]) && isIdentity(value.project_id);
    case "page":
      return hasExactKeys(value, ["kind", "page_id"]) && isIdentity(value.page_id);
    case "document":
      return hasExactKeys(value, ["kind", "document_id"]) && isIdentity(value.document_id);
    case "database":
      return hasExactKeys(value, ["kind", "database_id"]) && isIdentity(value.database_id);
    case "data_source":
      return hasExactKeys(value, ["kind", "data_source_id"]) && isIdentity(value.data_source_id);
    case "view":
      return hasExactKeys(value, ["kind", "view_id"]) && isIdentity(value.view_id);
    case "canvas":
      return hasExactKeys(value, ["kind", "canvas_id"]) && isIdentity(value.canvas_id);
    case "file":
      return hasExactKeys(value, ["kind", "file_id"]) && isIdentity(value.file_id);
    default:
      return false;
  }
};

const compareUtf8 = (left: string, right: string): number => {
  const leftBytes = UTF8_ENCODER.encode(left);
  const rightBytes = UTF8_ENCODER.encode(right);
  const sharedLength = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = leftBytes[index] - rightBytes[index];
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
};

export const compareAuthorityResources = (
  left: AuthorityResource,
  right: AuthorityResource,
): number => {
  const kindDifference = RESOURCE_KIND_ORDER[left.kind] - RESOURCE_KIND_ORDER[right.kind];
  if (kindDifference !== 0) return kindDifference;
  return compareUtf8(authorityResourceId(left), authorityResourceId(right));
};

export const canonicalizeAuthorityResources = (
  resources: readonly AuthorityResource[],
): readonly AuthorityResource[] => {
  const byKey = new Map(resources.map((resource) => [authorityResourceKey(resource), resource]));
  return [...byKey.values()].sort(compareAuthorityResources);
};

const isAddress = (value: unknown): value is DeliveryAddress => {
  if (!isRecord(value) || !isIdentity(value.kind) || !isIdentity(value.library_id)) {
    return false;
  }
  if (value.kind === "library") {
    return hasExactKeys(value, ["kind", "library_id"]);
  }
  if (value.kind === "project") {
    return (
      hasExactKeys(value, ["kind", "library_id", "project_id"]) && isIdentity(value.project_id)
    );
  }
  if (value.kind !== "document") return false;
  return (
    hasExactKeys(value, ["kind", "library_id", "project_id", "document_id"]) &&
    (value.project_id === null || isIdentity(value.project_id)) &&
    isIdentity(value.document_id)
  );
};

const isSortedUniqueResources = (resources: readonly AuthorityResource[]): boolean => {
  for (let index = 1; index < resources.length; index += 1) {
    if (compareAuthorityResources(resources[index - 1], resources[index]) >= 0) {
      return false;
    }
  }
  return true;
};

export const parseAuthorizedReadStamp = (
  value: unknown,
  libraryId?: string,
): AuthorizedReadStamp => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "authorization_dependencies",
      "authorization_scope",
      "covered_commit_seq",
      "delivery_address",
      "request_dependencies",
      "stamp_hash",
      "store_epoch",
      "subject",
    ]) ||
    !isIdentity(value.store_epoch) ||
    !isAddress(value.delivery_address) ||
    !isAddress(value.authorization_scope) ||
    deliveryAddressKey(value.delivery_address) !== deliveryAddressKey(value.authorization_scope) ||
    (libraryId !== undefined && value.delivery_address.library_id !== libraryId) ||
    !isAuthorityResource(value.subject) ||
    !Array.isArray(value.request_dependencies) ||
    value.request_dependencies.length < 1 ||
    value.request_dependencies.length > 512 ||
    !value.request_dependencies.every(isAuthorityResource) ||
    !isSortedUniqueResources(value.request_dependencies) ||
    !Array.isArray(value.authorization_dependencies) ||
    value.authorization_dependencies.length < 1 ||
    value.authorization_dependencies.length > 4_096 ||
    !value.authorization_dependencies.every(isAuthorityResource) ||
    !isSortedUniqueResources(value.authorization_dependencies) ||
    !Number.isSafeInteger(value.covered_commit_seq) ||
    (value.covered_commit_seq as number) < 0 ||
    typeof value.stamp_hash !== "string" ||
    !HASH_PATTERN.test(value.stamp_hash)
  ) {
    throw new TypeError("Authorized read stamp is invalid");
  }
  return value as AuthorizedReadStamp;
};

const bytesToHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const authorizedReadStampHash = async (
  stamp: Omit<AuthorizedReadStamp, "stamp_hash">,
): Promise<string> => {
  const encoded = new TextEncoder().encode(
    JSON.stringify({
      hash_version: 1,
      store_epoch: stamp.store_epoch,
      delivery_address: stamp.delivery_address,
      authorization_scope: stamp.authorization_scope,
      subject: stamp.subject,
      request_dependencies: stamp.request_dependencies,
      authorization_dependencies: stamp.authorization_dependencies,
      covered_commit_seq: stamp.covered_commit_seq,
    }),
  );
  return bytesToHex(await globalThis.crypto.subtle.digest("SHA-256", encoded));
};

export const verifyAuthorizedReadStamp = async (
  value: unknown,
  libraryId?: string,
): Promise<AuthorizedReadStamp> => {
  const stamp = parseAuthorizedReadStamp(value, libraryId);
  const { stamp_hash: expected, ...payload } = stamp;
  if ((await authorizedReadStampHash(payload)) !== expected) {
    throw new TypeError("Authorized read stamp hash is invalid");
  }
  return stamp;
};
