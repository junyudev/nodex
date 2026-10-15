import type { components } from "@nodex/core-protocol";

export type DeliveryResource = components["schemas"]["ResourceKey"];

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

const RESOURCE_KIND_ORDER: Readonly<Record<DeliveryResource["kind"], number>> = {
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

const deliveryResourceId = (resource: DeliveryResource): string => {
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

export const deliveryResourceKey = (resource: DeliveryResource): string => {
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

export const isDeliveryResource = (value: unknown): value is DeliveryResource => {
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

export const compareDeliveryResources = (
  left: DeliveryResource,
  right: DeliveryResource,
): number => {
  const kindDifference = RESOURCE_KIND_ORDER[left.kind] - RESOURCE_KIND_ORDER[right.kind];
  if (kindDifference !== 0) return kindDifference;
  return compareUtf8(deliveryResourceId(left), deliveryResourceId(right));
};

export const canonicalizeDeliveryResources = (
  resources: readonly DeliveryResource[],
): readonly DeliveryResource[] => {
  const byKey = new Map(resources.map((resource) => [deliveryResourceKey(resource), resource]));
  return [...byKey.values()].sort(compareDeliveryResources);
};
