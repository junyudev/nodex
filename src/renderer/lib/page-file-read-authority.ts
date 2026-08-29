import type { AuthorizedDeliveryPacket } from "../../shared/local-commit-delivery";
import { rendererLocalCommitIngress } from "./local-commit-ingress";
import { subscribePageFileChanges, type PageFileChange } from "./page-library-changes";
import type { PageFileReadInvalidation } from "./page-file-read-cache";

type DeliveryAtom = AuthorizedDeliveryPacket["atoms"][number];

export const isPageFileReferenceChangeForDocument = (
  atom: DeliveryAtom,
  documentId: string,
): boolean => {
  const payload = atom.payload;
  if (payload.module !== "owned_document") return false;
  return (
    payload.event.kind === "page_file_references_changed" &&
    payload.event.document_id === documentId
  );
};

export const pageFileReferenceInvalidationsForDocument = (
  atom: DeliveryAtom,
  documentId: string,
): readonly PageFileReadInvalidation[] => {
  if (!isPageFileReferenceChangeForDocument(atom, documentId)) return [];
  const payload = atom.payload;
  if (payload.module !== "owned_document") return [];
  const event = payload.event;
  if (event.kind !== "page_file_references_changed") return [];
  const change = event.change;
  if (change.kind === "reset") {
    return [{ mode: "revoke", fileIds: null, metadata: true, content: true }];
  }
  const invalidations: PageFileReadInvalidation[] = [];
  const addedFileIds = [...new Set(change.added_file_ids)];
  const removedFileIds = [...new Set(change.removed_file_ids)];
  if (addedFileIds.length > 0) {
    invalidations.push({
      mode: "refresh",
      fileIds: addedFileIds,
      metadata: true,
      content: true,
    });
  }
  if (removedFileIds.length > 0) {
    invalidations.push({
      mode: "revoke",
      fileIds: removedFileIds,
      metadata: true,
      content: true,
    });
  }
  return invalidations;
};

const mergeExactFileIds = (
  changes: readonly (readonly string[] | null)[],
): readonly string[] | null => {
  if (changes.some((fileIds) => fileIds === null)) return null;
  return [...new Set(changes.flatMap((fileIds) => fileIds ?? []))];
};

export const pageFileReadInvalidationsFromChange = (
  change: PageFileChange,
): readonly PageFileReadInvalidation[] => {
  if (change.manifestRevision !== null && change.contentRevision !== null) {
    return [
      {
        mode: "refresh",
        fileIds: mergeExactFileIds([change.manifestFileIds, change.contentFileIds]),
        metadata: true,
        content: false,
      },
      {
        mode: "refresh",
        fileIds: change.contentFileIds,
        metadata: false,
        content: true,
      },
    ];
  }
  const invalidations: PageFileReadInvalidation[] = [];
  if (change.manifestRevision !== null) {
    invalidations.push({
      mode: "refresh",
      fileIds: change.manifestFileIds,
      metadata: true,
      content: false,
    });
  }
  if (change.contentRevision !== null) {
    invalidations.push({
      mode: "refresh",
      fileIds: change.contentFileIds,
      metadata: true,
      content: true,
    });
  }
  return invalidations;
};

/**
 * Invalidates Page File reads only when their inventory, bytes, or exact
 * Document placement authority may have changed.
 */
export const subscribePageFileReadAuthority = (
  pageId: string,
  documentId: string,
  listener: (invalidation: PageFileReadInvalidation) => void,
): (() => void) => {
  const releasePageFiles = subscribePageFileChanges(pageId, (change) => {
    for (const invalidation of pageFileReadInvalidationsFromChange(change)) {
      listener(invalidation);
    }
  });
  const releaseReferences = rendererLocalCommitIngress.subscribeAtoms((_packet, atom) => {
    for (const invalidation of pageFileReferenceInvalidationsForDocument(atom, documentId)) {
      listener(invalidation);
    }
  });
  return () => {
    releasePageFiles();
    releaseReferences();
  };
};
