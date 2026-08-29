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

export const pageFileReferenceInvalidationForDocument = (
  atom: DeliveryAtom,
  documentId: string,
): PageFileReadInvalidation | null => {
  if (!isPageFileReferenceChangeForDocument(atom, documentId)) return null;
  const payload = atom.payload;
  if (payload.module !== "owned_document") return null;
  const event = payload.event;
  if (event.kind !== "page_file_references_changed") return null;
  const change = event.change;
  return {
    fileIds:
      change.kind === "exact"
        ? [...new Set([...change.added_file_ids, ...change.removed_file_ids])]
        : null,
    metadata: true,
    content: true,
  };
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
        fileIds: mergeExactFileIds([change.manifestFileIds, change.contentFileIds]),
        metadata: true,
        content: false,
      },
      {
        fileIds: change.contentFileIds,
        metadata: false,
        content: true,
      },
    ];
  }
  const invalidations: PageFileReadInvalidation[] = [];
  if (change.manifestRevision !== null) {
    invalidations.push({ fileIds: change.manifestFileIds, metadata: true, content: false });
  }
  if (change.contentRevision !== null) {
    invalidations.push({ fileIds: change.contentFileIds, metadata: true, content: true });
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
    const invalidation = pageFileReferenceInvalidationForDocument(atom, documentId);
    if (invalidation) listener(invalidation);
  });
  return () => {
    releasePageFiles();
    releaseReferences();
  };
};
