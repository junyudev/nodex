import { CORE_TRANSPORT_BUDGETS, type components } from "@nodex/core-protocol";
import {
  compareAuthorityResources,
  isAuthorityResource,
  type AuthorityResource,
} from "./authorized-read-stamp";

export type AuthorizedDeliveryPacket = components["schemas"]["AuthorizedDeliveryPacket"];

export interface AuthorizedDeliveryPacketConstraints {
  readonly eventVersion?: number;
  readonly libraryId?: string;
  readonly storeEpoch?: string;
  readonly deliveryAddress?: AuthorizedDeliveryPacket["delivery_address"];
}

const MAX_PACKET_ITEMS = 10_000;
const PACKET_VERSION = 4;
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const PROJECTION_SCOPE_KEY_PATTERN = /^v1:[0-9a-f]{64}$/u;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasExactKeys = (
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean => {
  const actual = Object.keys(value).sort();
  const canonicalExpected = [...expected].sort();
  return (
    actual.length === canonicalExpected.length &&
    actual.every((key, index) => key === canonicalExpected[index])
  );
};

const isIdentity = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && value === value.trim();

const isHash = (value: unknown): value is string =>
  typeof value === "string" && HASH_PATTERN.test(value);

const isNonNegativeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const isStrictlyIncreasingIntegers = (value: unknown): value is readonly number[] => {
  if (!Array.isArray(value) || value.length > MAX_PACKET_ITEMS) return false;
  let previous = -1;
  for (const entry of value) {
    if (!isNonNegativeInteger(entry) || entry <= previous) return false;
    previous = entry;
  }
  return true;
};

const isCanonicalIdentities = (value: unknown): value is readonly string[] => {
  if (!Array.isArray(value) || value.length > MAX_PACKET_ITEMS) return false;
  let previous: string | undefined;
  for (const entry of value) {
    if (!isIdentity(entry) || (previous !== undefined && previous >= entry)) {
      return false;
    }
    previous = entry;
  }
  return true;
};

const isUniqueIdentities = (value: unknown): value is readonly string[] => {
  if (!Array.isArray(value) || value.length > MAX_PACKET_ITEMS) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isIdentity(entry) || seen.has(entry)) return false;
    seen.add(entry);
  }
  return true;
};

const isCanonicalResourceKeys = (value: unknown): boolean => {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PACKET_ITEMS) return false;
  let previous: AuthorityResource | undefined;
  for (const resource of value) {
    if (!isAuthorityResource(resource)) return false;
    if (previous && compareAuthorityResources(previous, resource) >= 0) return false;
    previous = resource;
  }
  return true;
};

const atomKinds = new Set([
  "library_navigation_changed",
  "database_changed",
  "owned_document_changed",
  "project_workspace_changed",
  "automation_changed",
  "store_administration_changed",
]);

const isAtomPayload = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !isIdentity(value.library_id) ||
    !isRecord(value.event) ||
    !isIdentity(value.event.kind) ||
    typeof value.module !== "string"
  ) {
    return false;
  }
  const expectedKeys =
    value.module === "automation"
      ? ["event", "library_id", "module", "project_id"]
      : value.module === "owned_document"
        ? ["canvas_id", "event", "library_id", "module"]
        : ["event", "library_id", "module"];
  if (
    ![
      "automation",
      "database",
      "library",
      "owned_document",
      "project_workspace",
      "store_administration",
    ].includes(value.module) ||
    !hasExactKeys(value, expectedKeys)
  ) {
    return false;
  }
  if (value.module === "automation") return isIdentity(value.project_id);
  if (value.module === "owned_document") {
    return value.canvas_id === null || isIdentity(value.canvas_id);
  }
  return true;
};

const isDeliveryAtom = (value: unknown): boolean => {
  if (!isRecord(value) || !hasExactKeys(value, ["descriptor", "payload"])) {
    return false;
  }
  if (!isRecord(value.descriptor) || !isAtomPayload(value.payload)) return false;
  const descriptor = value.descriptor;
  return (
    hasExactKeys(descriptor, [
      "atom_id",
      "atom_order",
      "kind",
      "payload_hash",
      "required_resources",
    ]) &&
    isHash(descriptor.atom_id) &&
    isNonNegativeInteger(descriptor.atom_order) &&
    typeof descriptor.kind === "string" &&
    atomKinds.has(descriptor.kind) &&
    isHash(descriptor.payload_hash) &&
    isCanonicalResourceKeys(descriptor.required_resources)
  );
};

const isByteArray = (value: unknown): value is readonly number[] =>
  Array.isArray(value) &&
  value.length <= CORE_TRANSPORT_BUDGETS.event_frame_bytes &&
  value.every(
    (byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
  );

const isDocumentEffect = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["inline_update", "reference"]) ||
    (value.inline_update !== null && !isByteArray(value.inline_update)) ||
    !isRecord(value.reference)
  ) {
    return false;
  }
  const reference = value.reference;
  if (
    !hasExactKeys(reference, [
      "base_head_seq",
      "document_id",
      "effect_order",
      "generation",
      "page_id",
      "resource_kind",
      "result_head_seq",
      "update_byte_length",
      "update_hash",
      "update_id",
    ]) ||
    !isNonNegativeInteger(reference.base_head_seq) ||
    !isPositiveInteger(reference.result_head_seq) ||
    reference.result_head_seq <= reference.base_head_seq ||
    !isPositiveInteger(reference.generation) ||
    !isNonNegativeInteger(reference.effect_order) ||
    !isIdentity(reference.document_id) ||
    (reference.page_id !== null && !isIdentity(reference.page_id)) ||
    reference.resource_kind !== "document_update" ||
    !isIdentity(reference.update_id) ||
    !isHash(reference.update_hash) ||
    !isNonNegativeInteger(reference.update_byte_length)
  ) {
    return false;
  }
  return (
    value.inline_update === null || value.inline_update.length === reference.update_byte_length
  );
};

const isProjectionEffect = (value: unknown): boolean => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "base_revision",
      "covered_commit_seq",
      "effect_hash",
      "patch",
      "requires_read_at_least",
      "result_revision",
      "scope",
    ]) ||
    !isNonNegativeInteger(value.base_revision) ||
    !isPositiveInteger(value.result_revision) ||
    value.result_revision !== value.base_revision + 1 ||
    !isPositiveInteger(value.covered_commit_seq) ||
    !isHash(value.effect_hash) ||
    typeof value.requires_read_at_least !== "boolean" ||
    (value.patch !== null && !isRecord(value.patch)) ||
    !isRecord(value.scope)
  ) {
    return false;
  }
  return (
    hasExactKeys(value.scope, ["canonical_key", "schema_version", "scope"]) &&
    typeof value.scope.canonical_key === "string" &&
    PROJECTION_SCOPE_KEY_PATTERN.test(value.scope.canonical_key) &&
    value.scope.schema_version === 1 &&
    isRecord(value.scope.scope)
  );
};

const isAuthorizationScope = (value: unknown, expectedLibraryId?: string): boolean => {
  if (!isRecord(value) || !isIdentity(value.library_id)) return false;
  if (expectedLibraryId !== undefined && value.library_id !== expectedLibraryId) {
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
  return (
    value.kind === "document" &&
    hasExactKeys(value, ["document_id", "kind", "library_id", "project_id"]) &&
    isIdentity(value.document_id) &&
    (value.project_id === null || isIdentity(value.project_id))
  );
};

const isDeliveryAddress = (value: unknown, expectedLibraryId?: string): boolean =>
  isAuthorizationScope(value, expectedLibraryId);

const sameAddressAndScope = (address: unknown, scope: unknown): boolean =>
  isRecord(address) && isRecord(scope) && JSON.stringify(address) === JSON.stringify(scope);

const revocationReasons = new Set(["ownership_moved", "access_revoked", "archived", "deleted"]);

const isVisibilityDelta = (
  value: unknown,
  expectedScope: unknown,
  expectedLibraryId?: string,
): boolean => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["authorization_scope", "change", "delta_hash", "roots"]) ||
    !isAuthorizationScope(value.authorization_scope, expectedLibraryId) ||
    !sameAddressAndScope(value.authorization_scope, expectedScope) ||
    !isHash(value.delta_hash) ||
    !isRecord(value.change) ||
    !Array.isArray(value.roots)
  )
    return false;
  if (value.change.kind === "grant") {
    return hasExactKeys(value.change, ["kind"]) && isCanonicalResourceKeys(value.roots);
  }
  if (value.change.kind === "revoke") {
    return (
      hasExactKeys(value.change, ["kind", "reason"]) &&
      typeof value.change.reason === "string" &&
      revocationReasons.has(value.change.reason) &&
      isCanonicalResourceKeys(value.roots)
    );
  }
  return (
    value.change.kind === "conservative_reset" &&
    hasExactKeys(value.change, ["kind", "reason"]) &&
    value.change.reason === "authorization_closure_exceeded" &&
    value.roots.length === 0
  );
};

interface ParsedCoverage {
  readonly atom_ids: readonly string[];
  readonly document_effect_orders: readonly number[];
  readonly inline_document_effect_orders: readonly number[];
  readonly projection_scope_keys: readonly string[];
}

const parseCoverage = (value: unknown): ParsedCoverage | null => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "atom_ids",
      "document_effect_orders",
      "inline_document_effect_orders",
      "projection_scope_keys",
    ]) ||
    !isUniqueIdentities(value.atom_ids) ||
    !isStrictlyIncreasingIntegers(value.document_effect_orders) ||
    !isStrictlyIncreasingIntegers(value.inline_document_effect_orders) ||
    !isCanonicalIdentities(value.projection_scope_keys)
  ) {
    return null;
  }
  return value as unknown as ParsedCoverage;
};

const sameArray = <T>(left: readonly T[], right: readonly T[]): boolean =>
  left.length === right.length && left.every((entry, index) => entry === right[index]);

const invalidPacket = (): never => {
  throw new TypeError("Authorized delivery packet is invalid");
};

/**
 * Parses the one transport-neutral authorized delivery boundary used by apply,
 * exact-live, and durable-stream ingress. Context-specific callers may pin the
 * Store, Library, and event contract without maintaining another packet parser.
 */
export const parseAuthorizedDeliveryPacket = (
  value: unknown,
  constraints: AuthorizedDeliveryPacketConstraints = {},
): AuthorizedDeliveryPacket => {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "atoms",
      "authorization_scope",
      "coverage",
      "delivery_address",
      "document_effects",
      "manifest",
      "packet_hash",
      "packet_version",
      "projection_effects",
      "visibility_deltas",
    ]) ||
    value.packet_version !== PACKET_VERSION ||
    !isHash(value.packet_hash) ||
    !isDeliveryAddress(value.delivery_address, constraints.libraryId) ||
    !isAuthorizationScope(value.authorization_scope, constraints.libraryId) ||
    !sameAddressAndScope(value.delivery_address, value.authorization_scope) ||
    (constraints.deliveryAddress !== undefined &&
      JSON.stringify(value.delivery_address) !== JSON.stringify(constraints.deliveryAddress)) ||
    !isRecord(value.manifest)
  ) {
    return invalidPacket();
  }

  const manifest = value.manifest;
  if (
    !hasExactKeys(manifest, ["committed_at", "event_version", "identity", "operation_id"]) ||
    !isPositiveInteger(manifest.event_version) ||
    (constraints.eventVersion !== undefined &&
      manifest.event_version !== constraints.eventVersion) ||
    !isIdentity(manifest.operation_id) ||
    typeof manifest.committed_at !== "string" ||
    manifest.committed_at.length === 0 ||
    manifest.committed_at.length > 64 ||
    !isRecord(manifest.identity) ||
    !hasExactKeys(manifest.identity, ["commit_seq", "manifest_hash", "store_epoch"]) ||
    !isPositiveInteger(manifest.identity.commit_seq) ||
    !isHash(manifest.identity.manifest_hash) ||
    !isIdentity(manifest.identity.store_epoch) ||
    (constraints.storeEpoch !== undefined &&
      manifest.identity.store_epoch !== constraints.storeEpoch)
  ) {
    return invalidPacket();
  }

  if (
    !Array.isArray(value.atoms) ||
    value.atoms.length > MAX_PACKET_ITEMS ||
    value.atoms.some((atom) => !isDeliveryAtom(atom)) ||
    value.atoms.some((atom, index, atoms) => {
      if (index === 0) return false;
      const previous = atoms[index - 1] as {
        readonly descriptor: { readonly atom_order: number };
      };
      const current = atom as {
        readonly descriptor: { readonly atom_order: number };
      };
      return previous.descriptor.atom_order >= current.descriptor.atom_order;
    }) ||
    !Array.isArray(value.document_effects) ||
    value.document_effects.length > MAX_PACKET_ITEMS ||
    value.document_effects.some((effect) => !isDocumentEffect(effect)) ||
    !Array.isArray(value.projection_effects) ||
    value.projection_effects.length > MAX_PACKET_ITEMS ||
    value.projection_effects.some((effect) => !isProjectionEffect(effect)) ||
    !Array.isArray(value.visibility_deltas) ||
    value.visibility_deltas.length > MAX_PACKET_ITEMS ||
    value.visibility_deltas.some(
      (delta) => !isVisibilityDelta(delta, value.authorization_scope, constraints.libraryId),
    )
  ) {
    return invalidPacket();
  }

  const coverage = parseCoverage(value.coverage);
  if (!coverage) return invalidPacket();
  const atomIds = value.atoms.map(
    (atom) => (atom as { readonly descriptor: { readonly atom_id: string } }).descriptor.atom_id,
  );
  const documentOrders = value.document_effects.map(
    (effect) =>
      (effect as { readonly reference: { readonly effect_order: number } }).reference.effect_order,
  );
  const inlineOrders = value.document_effects
    .filter((effect) => (effect as { readonly inline_update: unknown }).inline_update !== null)
    .map(
      (effect) =>
        (effect as { readonly reference: { readonly effect_order: number } }).reference
          .effect_order,
    );
  const projectionScopes = value.projection_effects.map(
    (effect) =>
      (effect as { readonly scope: { readonly canonical_key: string } }).scope.canonical_key,
  );
  if (
    !sameArray(coverage.atom_ids, atomIds) ||
    !sameArray(coverage.document_effect_orders, documentOrders) ||
    !sameArray(coverage.inline_document_effect_orders, inlineOrders) ||
    !sameArray(coverage.projection_scope_keys, projectionScopes)
  ) {
    return invalidPacket();
  }
  return value as unknown as AuthorizedDeliveryPacket;
};
