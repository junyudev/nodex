import { createHash } from "node:crypto";

import type {
  DocumentSyncCommandResult,
  DocumentSyncRealtimeEvent,
  DocumentUpdateResourceReadResult,
  DocumentUpdateResourceRef,
} from "../../shared/block-documents/document-sync";
import type { CoreAuthorizedDeliveryPacket } from "./types";

export type AuthorizedDocumentEffect = CoreAuthorizedDeliveryPacket["document_effects"][number];

export type ExactDocumentUpdateFetcher = (
  input: DocumentUpdateResourceRef & { readonly clientSessionId: string },
) => Promise<DocumentSyncCommandResult<DocumentUpdateResourceReadResult>>;

type CommitIdentity = CoreAuthorizedDeliveryPacket["manifest"]["identity"];
type DocumentResyncEvent = Extract<DocumentSyncRealtimeEvent, { readonly kind: "resync-required" }>;

const resyncEvent = (
  effect: AuthorizedDocumentEffect,
  identity: CommitIdentity,
  reason: DocumentResyncEvent["reason"],
  boundary?: { readonly generation: number; readonly headSeq: number },
): DocumentResyncEvent => ({
  kind: "resync-required",
  documentId: effect.reference.document_id,
  storeEpoch: identity.store_epoch,
  generation: boundary?.generation ?? effect.reference.generation,
  headSeq: boundary?.headSeq ?? effect.reference.base_head_seq,
  commitSeq: identity.commit_seq,
  effectSequence: effect.reference.effect_order,
  reason,
});

export const resolveInlineAuthorizedDocumentEffect = (
  effect: AuthorizedDocumentEffect,
  identity: CommitIdentity,
): Extract<
  DocumentSyncRealtimeEvent,
  { readonly kind: "document-update" | "resync-required" }
> | null => {
  if (effect.inline_update === null || effect.inline_update === undefined) {
    return null;
  }
  const reference = effect.reference;
  const update = Uint8Array.from(effect.inline_update);
  const hash = createHash("sha256").update(update).digest("hex");
  if (update.byteLength !== reference.update_byte_length || hash !== reference.update_hash) {
    return resyncEvent(effect, identity, "resource-integrity-failure");
  }
  return {
    kind: "document-update",
    documentId: reference.document_id,
    storeEpoch: identity.store_epoch,
    generation: reference.generation,
    headSeq: reference.result_head_seq,
    commitSeq: identity.commit_seq,
    effectSequence: reference.effect_order,
    updateId: reference.update_id,
    clientSessionId: "core:authorized-delivery",
    ...(effect.history_fence ? { historyFence: effect.history_fence } : {}),
    update,
  };
};

/** Resolves one authorized exact transition without substituting latest state. */
export const resolveAuthorizedDocumentEffect = async (
  effect: AuthorizedDocumentEffect,
  identity: CommitIdentity,
  fetchUpdateResource: ExactDocumentUpdateFetcher,
): Promise<
  Extract<DocumentSyncRealtimeEvent, { readonly kind: "document-update" | "resync-required" }>
> => {
  const reference = effect.reference;
  const inline = resolveInlineAuthorizedDocumentEffect(effect, identity);
  if (inline) return inline;

  let update: Uint8Array;
  {
    const fetched = await fetchUpdateResource({
      documentId: reference.document_id,
      generation: reference.generation,
      updateId: reference.update_id,
      updateHash: reference.update_hash,
      clientSessionId: "core:exact-document-effect",
    });
    if (!fetched.ok) {
      return resyncEvent(
        effect,
        identity,
        fetched.error.code === "unauthorized"
          ? "access-revoked"
          : fetched.error.resetRequired
            ? "resource-integrity-failure"
            : "event-gap",
      );
    }
    if (fetched.value.kind === "resync-required") {
      const unavailable = fetched.value;
      const reason =
        unavailable.reason === "compacted"
          ? "history-compacted"
          : unavailable.reason === "generation_changed"
            ? "identity-boundary-changed"
            : unavailable.reason === "hash_mismatch"
              ? "resource-integrity-failure"
              : "event-gap";
      return resyncEvent(effect, identity, reason, {
        generation: unavailable.currentGeneration,
        headSeq: unavailable.currentHeadSeq,
      });
    }
    const resource = fetched.value;
    if (
      resource.documentId !== reference.document_id ||
      resource.generation !== reference.generation ||
      resource.baseHeadSeq !== reference.base_head_seq ||
      resource.headSeq !== reference.result_head_seq ||
      resource.updateId !== reference.update_id ||
      resource.updateHash !== reference.update_hash ||
      resource.updateByteLength !== reference.update_byte_length
    ) {
      return resyncEvent(effect, identity, "resource-integrity-failure");
    }
    update = resource.update;
  }

  return {
    kind: "document-update",
    documentId: reference.document_id,
    storeEpoch: identity.store_epoch,
    generation: reference.generation,
    headSeq: reference.result_head_seq,
    commitSeq: identity.commit_seq,
    effectSequence: reference.effect_order,
    updateId: reference.update_id,
    clientSessionId: "core:authorized-delivery",
    ...(effect.history_fence ? { historyFence: effect.history_fence } : {}),
    update,
  };
};
