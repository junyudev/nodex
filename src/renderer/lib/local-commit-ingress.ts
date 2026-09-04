import type { DocumentSyncRealtimeEvent } from "../../shared/block-documents/document-sync";
import {
  projectionMessageFromDelivery,
  projectionScopeCanReceive,
  revocationsFromVisibilityDelta,
  revocationMessageFromDelivery,
  revocationScopeCanReceive,
  type AuthorizedDeliveryPacket,
  type LocalCommitApply,
} from "../../shared/local-commit-delivery";
import {
  projectionScopeKey,
  type ProjectionScope,
  type ProjectionStreamMessage,
} from "../../shared/projection-stream";
import type { ResourceRevocationMessage } from "../../shared/resource-revocation-stream";
import {
  deliveryAddressProjectionScope,
  type AddressReset,
  type DeliveryAddress,
} from "../../shared/recipient-delivery";
import {
  AuthorityFreshnessIndex,
  rendererAuthorityFreshnessIndex,
} from "./authority-freshness-index";
import { mapWithConcurrency } from "./map-with-concurrency";

type ProjectionListener = (message: ProjectionStreamMessage) => void;
type RevocationListener = (message: ResourceRevocationMessage) => void;
type DocumentListener = (event: DocumentSyncRealtimeEvent) => void;
type Atom = AuthorizedDeliveryPacket["atoms"][number];
type AtomListener = (packet: AuthorizedDeliveryPacket, atom: Atom) => void;

export type RendererLocalCommitAdmission =
  | { readonly kind: "no_op" }
  | { readonly kind: "accepted"; readonly commitKey: string }
  | { readonly kind: "duplicate"; readonly commitKey: string }
  | { readonly kind: "enriched"; readonly commitKey: string };

export class LocalCommitIngressCapacityError extends Error {
  constructor() {
    super("Renderer local commit ingress is at capacity");
    this.name = "LocalCommitIngressCapacityError";
  }
}

interface RememberedClaim {
  readonly fingerprint: string;
}

interface RememberedCommit {
  readonly manifestHash: string;
  readonly claims: Map<string, RememberedClaim>;
}

interface PreparedDocumentEvent {
  readonly key: string;
  readonly fingerprint: string;
  readonly event: DocumentSyncRealtimeEvent;
}

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const DEFAULT_MAX_REMEMBERED_COMMITS = 100_000;
const DEFAULT_MAX_IN_FLIGHT_ADMISSIONS = 256;
const DOCUMENT_EVENT_PREPARATION_CONCURRENCY = 8;

const sameValues = <Value>(actual: readonly Value[], expected: readonly Value[]): boolean =>
  actual.length === expected.length && actual.every((value, index) => value === expected[index]);

const bytesToHex = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const copy = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", copy.buffer);
  return bytesToHex(digest);
};

const validatePacket = (packet: AuthorizedDeliveryPacket): void => {
  const identity = packet.manifest.identity;
  if (
    packet.packet_version !== 4 ||
    !identity.store_epoch ||
    identity.store_epoch !== identity.store_epoch.trim() ||
    !Number.isSafeInteger(identity.commit_seq) ||
    identity.commit_seq < 1 ||
    !HASH_PATTERN.test(identity.manifest_hash) ||
    !HASH_PATTERN.test(packet.packet_hash)
  ) {
    throw new TypeError("Authorized local commit packet identity is invalid");
  }
  if (
    !packet.authorization_scope.library_id ||
    packet.authorization_scope.library_id !== packet.authorization_scope.library_id.trim()
  ) {
    throw new TypeError("Authorized local commit packet scope is invalid");
  }
  if (
    authorizationScopeKey(packet.delivery_address) !==
    authorizationScopeKey(packet.authorization_scope)
  ) {
    throw new TypeError("Authorized local commit packet address is invalid");
  }
  const atomIds = packet.atoms.map((atom) => atom.descriptor.atom_id);
  const documentOrders = packet.document_effects.map((effect) => effect.reference.effect_order);
  const inlineDocumentOrders = packet.document_effects
    .filter((effect) => effect.inline_update !== null && effect.inline_update !== undefined)
    .map((effect) => effect.reference.effect_order);
  const projectionScopeKeys = packet.projection_effects.map((effect) => effect.scope.canonical_key);
  if (
    !sameValues(packet.coverage.atom_ids, atomIds) ||
    !sameValues(packet.coverage.document_effect_orders, documentOrders) ||
    !sameValues(packet.coverage.inline_document_effect_orders, inlineDocumentOrders) ||
    !sameValues(packet.coverage.projection_scope_keys, projectionScopeKeys)
  ) {
    throw new TypeError("Authorized local commit packet coverage is invalid");
  }
};

const projectionScopeFromPacket = (packet: AuthorizedDeliveryPacket): ProjectionScope | null =>
  deliveryAddressProjectionScope(packet.delivery_address);

const authorizationScopeKey = (scope: AuthorizedDeliveryPacket["authorization_scope"]): string =>
  scope.kind === "library"
    ? JSON.stringify(["library", scope.library_id])
    : scope.kind === "project"
      ? JSON.stringify(["project", scope.library_id, scope.project_id])
      : JSON.stringify(["document", scope.library_id, scope.project_id ?? null, scope.document_id]);

const documentClaim = (
  _packet: AuthorizedDeliveryPacket,
  effect: AuthorizedDeliveryPacket["document_effects"][number],
): { readonly key: string; readonly fingerprint: string } => {
  const reference = effect.reference;
  return {
    key: JSON.stringify([
      "document",
      reference.document_id,
      reference.generation,
      reference.base_head_seq,
      reference.result_head_seq,
      reference.effect_order,
    ]),
    fingerprint: JSON.stringify([
      reference.update_id,
      reference.update_hash,
      reference.update_byte_length,
    ]),
  };
};

const projectionIntegrityClaim = (
  scopeKey: string,
  resultRevision: number,
  effectHash: string,
): { readonly key: string; readonly fingerprint: string } => ({
  key: JSON.stringify(["projection", scopeKey, resultRevision]),
  fingerprint: effectHash,
});

const projectionDeliveryClaim = (
  scope: ProjectionScope,
  scopeKey: string,
  resultRevision: number,
  effectHash: string,
): { readonly key: string; readonly fingerprint: string } => ({
  key: JSON.stringify([projectionScopeKey(scope), "projection", scopeKey, resultRevision]),
  fingerprint: effectHash,
});

const visibilityClaim = (
  delta: AuthorizedDeliveryPacket["visibility_deltas"][number],
): { readonly key: string; readonly fingerprint: string } => ({
  key: JSON.stringify([
    authorizationScopeKey(delta.authorization_scope),
    "visibility",
    delta.delta_hash,
  ]),
  fingerprint: JSON.stringify([delta.change, delta.roots]),
});

const atomClaim = (
  packet: AuthorizedDeliveryPacket,
  atom: Atom,
): { readonly key: string; readonly fingerprint: string } => ({
  key: JSON.stringify([
    authorizationScopeKey(packet.authorization_scope),
    "atom",
    atom.descriptor.atom_id,
  ]),
  fingerprint: JSON.stringify([atom.descriptor.kind, atom.descriptor.payload_hash]),
});

const documentResyncEvent = (
  packet: AuthorizedDeliveryPacket,
  effect: AuthorizedDeliveryPacket["document_effects"][number],
  reason: Extract<DocumentSyncRealtimeEvent, { readonly kind: "resync-required" }>["reason"],
): DocumentSyncRealtimeEvent => ({
  kind: "resync-required",
  documentId: effect.reference.document_id,
  storeEpoch: packet.manifest.identity.store_epoch,
  generation: effect.reference.generation,
  headSeq: effect.reference.base_head_seq,
  commitSeq: packet.manifest.identity.commit_seq,
  effectSequence: effect.reference.effect_order,
  reason,
});

const prepareDocumentEvent = async (
  packet: AuthorizedDeliveryPacket,
  effect: AuthorizedDeliveryPacket["document_effects"][number],
): Promise<PreparedDocumentEvent> => {
  const claim = documentClaim(packet, effect);
  const inline = effect.inline_update;
  if (inline === null || inline === undefined) {
    return {
      key: claim.key,
      fingerprint: claim.fingerprint,
      event: documentResyncEvent(packet, effect, "event-gap"),
    };
  }
  const update = Uint8Array.from(inline);
  if (
    update.byteLength !== effect.reference.update_byte_length ||
    (await sha256Hex(update)) !== effect.reference.update_hash
  ) {
    return {
      key: claim.key,
      fingerprint: claim.fingerprint,
      event: documentResyncEvent(packet, effect, "resource-integrity-failure"),
    };
  }
  return {
    key: claim.key,
    fingerprint: claim.fingerprint,
    event: {
      kind: "document-update",
      documentId: effect.reference.document_id,
      storeEpoch: packet.manifest.identity.store_epoch,
      generation: effect.reference.generation,
      headSeq: effect.reference.result_head_seq,
      commitSeq: packet.manifest.identity.commit_seq,
      effectSequence: effect.reference.effect_order,
      updateId: effect.reference.update_id,
      clientSessionId: "core:apply-response",
      ...(effect.history_fence ? { historyFence: effect.history_fence } : {}),
      update,
    },
  };
};

/**
 * Process-wide causal admission for apply responses and renderer fanout.
 * Admission completes before a mutation Promise resolves; React rendering is
 * deliberately downstream and never part of the commit ACK.
 */
export class RendererLocalCommitIngress {
  readonly #maxRememberedCommits: number;
  readonly #maxInFlightAdmissions: number;
  readonly #remembered = new Map<string, RememberedCommit>();
  readonly #rememberedAddressResets = new Map<string, string>();
  readonly #projectionListeners = new Map<string, Set<ProjectionListener>>();
  readonly #revocationListeners = new Map<string, Set<RevocationListener>>();
  readonly #documentListeners = new Map<string, Set<DocumentListener>>();
  readonly #atomListeners = new Set<AtomListener>();
  readonly #authorityFreshnessIndex: AuthorityFreshnessIndex | undefined;
  readonly #onListenerError: ((error: unknown) => void) | undefined;
  #inFlightAdmissions = 0;

  constructor(
    input: {
      readonly maxRememberedCommits?: number;
      readonly maxInFlightAdmissions?: number;
      readonly onListenerError?: (error: unknown) => void;
      readonly authorityFreshnessIndex?: AuthorityFreshnessIndex;
    } = {},
  ) {
    this.#maxRememberedCommits = Math.max(
      1,
      Math.floor(input.maxRememberedCommits ?? DEFAULT_MAX_REMEMBERED_COMMITS),
    );
    this.#maxInFlightAdmissions = Math.max(
      1,
      Math.floor(input.maxInFlightAdmissions ?? DEFAULT_MAX_IN_FLIGHT_ADMISSIONS),
    );
    this.#onListenerError = input.onListenerError;
    this.#authorityFreshnessIndex = input.authorityFreshnessIndex;
  }

  async admitApply(apply: LocalCommitApply): Promise<RendererLocalCommitAdmission> {
    if (apply.status === "no_op" || !apply.delivery) return { kind: "no_op" };
    if (
      apply.delivery.manifest.identity.store_epoch !== apply.commit.store_epoch ||
      apply.delivery.manifest.identity.commit_seq !== apply.commit.commit_seq ||
      apply.delivery.manifest.identity.manifest_hash !== apply.commit.manifest_hash
    ) {
      throw new TypeError("Apply response delivery diverges from its commit identity");
    }
    return await this.admitPacket(apply.delivery);
  }

  async admitPacket(packet: AuthorizedDeliveryPacket): Promise<RendererLocalCommitAdmission> {
    validatePacket(packet);
    if (this.#inFlightAdmissions >= this.#maxInFlightAdmissions) {
      throw new LocalCommitIngressCapacityError();
    }
    this.#inFlightAdmissions += 1;
    try {
      return await this.#admitPacket(packet);
    } finally {
      this.#inFlightAdmissions -= 1;
    }
  }

  admitAddressReset(reset: AddressReset): void {
    if (
      !HASH_PATTERN.test(reset.reset_id) ||
      !HASH_PATTERN.test(reset.recipient_lease_id) ||
      !reset.store_epoch ||
      !Number.isSafeInteger(reset.required_commit_seq) ||
      reset.required_commit_seq < 0 ||
      authorizationScopeKey(reset.delivery_address) !==
        authorizationScopeKey(reset.authorization_scope)
    ) {
      throw new TypeError("Recipient address reset is invalid");
    }
    const fingerprint = JSON.stringify([
      reset.recipient_lease_id,
      authorizationScopeKey(reset.delivery_address),
      authorizationScopeKey(reset.authorization_scope),
      reset.store_epoch,
      reset.required_commit_seq,
      reset.reason,
    ]);
    const known = this.#rememberedAddressResets.get(reset.reset_id);
    if (known === fingerprint) {
      this.#touchAddressReset(reset.reset_id, fingerprint);
      return;
    }
    if (known !== undefined) {
      throw new Error(`Recipient address reset identity collision for ${reset.reset_id}`);
    }
    this.#touchAddressReset(reset.reset_id, fingerprint);
    this.#authorityFreshnessIndex?.admitAddressReset({
      deliveryAddress: reset.delivery_address,
      storeEpoch: reset.store_epoch,
      requiredCommitSeq: reset.required_commit_seq,
    });
    this.#resetAddress(
      reset.delivery_address,
      {
        storeEpoch: reset.store_epoch,
        commitSeq: reset.required_commit_seq,
      },
      reset.reason === "store_epoch_replacement"
        ? "store_epoch_changed"
        : "recipient_delivery_failed",
    );
  }

  subscribeProjection(scope: ProjectionScope, listener: ProjectionListener): () => void {
    return this.#subscribe(this.#projectionListeners, projectionScopeKey(scope), listener);
  }

  subscribeRevocation(scope: ProjectionScope, listener: RevocationListener): () => void {
    return this.#subscribe(this.#revocationListeners, projectionScopeKey(scope), listener);
  }

  subscribeDocument(documentId: string, listener: DocumentListener): () => void {
    if (!documentId || documentId !== documentId.trim()) {
      throw new TypeError("Document subscription identity is invalid");
    }
    return this.#subscribe(this.#documentListeners, documentId, listener);
  }

  subscribeAtoms(listener: AtomListener): () => void {
    this.#atomListeners.add(listener);
    return () => this.#atomListeners.delete(listener);
  }

  diagnostics(): {
    readonly rememberedCommits: number;
    readonly rememberedAddressResets: number;
    readonly inFlightAdmissions: number;
  } {
    return {
      rememberedCommits: this.#remembered.size,
      rememberedAddressResets: this.#rememberedAddressResets.size,
      inFlightAdmissions: this.#inFlightAdmissions,
    };
  }

  async #admitPacket(packet: AuthorizedDeliveryPacket): Promise<RendererLocalCommitAdmission> {
    const identity = packet.manifest.identity;
    const commitKey = JSON.stringify([identity.store_epoch, identity.commit_seq]);
    const preparedDocuments = await mapWithConcurrency(
      packet.document_effects,
      DOCUMENT_EVENT_PREPARATION_CONCURRENCY,
      (effect) => prepareDocumentEvent(packet, effect),
    );
    const remembered = this.#remembered.get(commitKey);
    if (remembered && remembered.manifestHash !== identity.manifest_hash) {
      throw new Error(`Local commit identity collision for ${commitKey}`);
    }
    const state: RememberedCommit = {
      manifestHash: identity.manifest_hash,
      claims: new Map(remembered?.claims ?? []),
    };

    // Validate every claim against an isolated draft before publishing any
    // callback. A divergent claim must reject the packet atomically instead
    // of exposing a valid prefix and poisoning later replay.
    const novelVisibilityDeltas = packet.visibility_deltas.filter((delta) =>
      this.#rememberClaim(state, visibilityClaim(delta)),
    );
    const novelDocuments = preparedDocuments.filter((prepared) =>
      this.#rememberClaim(state, prepared),
    );
    const novelProjections = packet.projection_effects.filter((effect) => {
      this.#rememberClaim(
        state,
        projectionIntegrityClaim(
          effect.scope.canonical_key,
          effect.result_revision,
          effect.effect_hash,
        ),
      );
      return this.#rememberClaim(
        state,
        projectionDeliveryClaim(
          projectionScopeFromPacket(packet)!,
          effect.scope.canonical_key,
          effect.result_revision,
          effect.effect_hash,
        ),
      );
    });
    const novelAtoms = packet.atoms.filter((atom) =>
      this.#rememberClaim(state, atomClaim(packet, atom)),
    );
    const admitted =
      novelVisibilityDeltas.length +
      novelDocuments.length +
      novelProjections.length +
      novelAtoms.length;

    this.#remembered.set(commitKey, state);
    this.#touch(commitKey, state);

    for (const delta of novelVisibilityDeltas) {
      this.#authorityFreshnessIndex?.admitVisibility({
        deliveryAddress: packet.delivery_address,
        storeEpoch: identity.store_epoch,
        commitSeq: identity.commit_seq,
        change: delta.change.kind,
        roots: delta.roots,
      });
    }

    const conservativeReset = novelVisibilityDeltas.find(
      (delta) => delta.change.kind === "conservative_reset",
    );
    if (conservativeReset) {
      this.#resetAddress(
        packet.delivery_address,
        {
          storeEpoch: identity.store_epoch,
          commitSeq: identity.commit_seq,
        },
        "recipient_delivery_failed",
      );
      return { kind: remembered ? "enriched" : "accepted", commitKey };
    }

    // Authorization loss is admitted before any post-state content in the
    // same packet, so stale surfaces cannot observe a later content callback.
    for (const delta of novelVisibilityDeltas) {
      const scope =
        delta.authorization_scope.kind === "library"
          ? {
              kind: "library" as const,
              libraryId: delta.authorization_scope.library_id,
            }
          : delta.authorization_scope.kind === "project"
            ? {
                kind: "project" as const,
                libraryId: delta.authorization_scope.library_id,
                projectId: delta.authorization_scope.project_id,
              }
            : null;
      if (!scope) continue;
      for (const revocation of revocationsFromVisibilityDelta(delta)) {
        if (!revocationScopeCanReceive(scope, revocation)) continue;
        this.#publishRevocation(scope, revocationMessageFromDelivery(packet, revocation, scope));
      }
    }
    for (const prepared of novelDocuments) {
      this.#publishDocument(prepared.event.documentId, prepared.event);
    }
    for (const effect of novelProjections) {
      const scope = projectionScopeFromPacket(packet);
      if (!scope) continue;
      if (!projectionScopeCanReceive(scope, effect)) continue;
      this.#publishProjection(scope, projectionMessageFromDelivery(packet, effect, scope));
    }
    for (const atom of novelAtoms) {
      for (const listener of [...this.#atomListeners]) {
        this.#deliver(() => listener(packet, atom));
      }
    }
    if (admitted === 0) return { kind: "duplicate", commitKey };
    return {
      kind: remembered ? "enriched" : "accepted",
      commitKey,
    };
  }

  #rememberClaim(
    state: RememberedCommit,
    claim: { readonly key: string; readonly fingerprint: string },
  ): boolean {
    const known = state.claims.get(claim.key);
    if (!known) {
      state.claims.set(claim.key, { fingerprint: claim.fingerprint });
      return true;
    }
    if (known.fingerprint === claim.fingerprint) return false;
    throw new Error(`Local commit resource identity collision for ${claim.key}`);
  }

  #touch(key: string, state: RememberedCommit): void {
    this.#remembered.delete(key);
    this.#remembered.set(key, state);
    while (this.#remembered.size > this.#maxRememberedCommits) {
      const oldest = this.#remembered.keys().next().value;
      if (oldest === undefined) break;
      this.#remembered.delete(oldest);
    }
  }

  #touchAddressReset(resetId: string, fingerprint: string): void {
    this.#rememberedAddressResets.delete(resetId);
    this.#rememberedAddressResets.set(resetId, fingerprint);
    while (this.#rememberedAddressResets.size > this.#maxRememberedCommits) {
      const oldest = this.#rememberedAddressResets.keys().next().value;
      if (oldest === undefined) return;
      this.#rememberedAddressResets.delete(oldest);
    }
  }

  #publishProjection(scope: ProjectionScope, message: ProjectionStreamMessage): void {
    for (const listener of this.#projectionListeners.get(projectionScopeKey(scope)) ?? []) {
      this.#deliver(() => listener(message));
    }
  }

  #publishRevocation(scope: ProjectionScope, message: ResourceRevocationMessage): void {
    for (const listener of this.#revocationListeners.get(projectionScopeKey(scope)) ?? []) {
      this.#deliver(() => listener(message));
    }
  }

  #publishDocument(documentId: string, event: DocumentSyncRealtimeEvent): void {
    for (const listener of this.#documentListeners.get(documentId) ?? []) {
      this.#deliver(() => listener(event));
    }
  }

  #resetAddress(
    address: DeliveryAddress,
    floor: { readonly storeEpoch: string; readonly commitSeq: number },
    reason: "store_epoch_changed" | "recipient_delivery_failed",
  ): void {
    const scope = deliveryAddressProjectionScope(address);
    if (!scope) return;
    this.#publishProjection(scope, {
      version: 2,
      kind: "reset",
      scope,
      stream: floor,
      reason: reason === "store_epoch_changed" ? "store_epoch_changed" : "event_gap",
    });
    this.#publishRevocation(scope, {
      version: 1,
      kind: "reset",
      scope,
      stream: floor,
      reason,
    });
  }

  #deliver(delivery: () => void): void {
    try {
      delivery();
    } catch (error) {
      this.#onListenerError?.(error);
    }
  }

  #subscribe<Listener>(
    registry: Map<string, Set<Listener>>,
    key: string,
    listener: Listener,
  ): () => void {
    const listeners = registry.get(key) ?? new Set<Listener>();
    listeners.add(listener);
    registry.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) registry.delete(key);
    };
  }
}

export const rendererLocalCommitIngress = new RendererLocalCommitIngress({
  authorityFreshnessIndex: rendererAuthorityFreshnessIndex,
});

export const admitLocalCommitApply = async (
  apply: LocalCommitApply,
): Promise<RendererLocalCommitAdmission> => await rendererLocalCommitIngress.admitApply(apply);
