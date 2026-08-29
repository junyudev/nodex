import type { AuthorizedDeliveryPacket } from "../../shared/local-commit-delivery";
import { rendererLocalCommitIngress } from "./local-commit-ingress";
import { subscribePageFileChanges } from "./page-library-changes";

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

/**
 * Invalidates Page File reads only when their inventory, bytes, or exact
 * Document placement authority may have changed.
 */
export const subscribePageFileReadAuthority = (
  pageId: string,
  documentId: string,
  listener: () => void,
): (() => void) => {
  const releasePageFiles = subscribePageFileChanges(
    pageId,
    ({ manifestRevision, bodyUsageRevision, contentRevision }) => {
      if (manifestRevision === null && bodyUsageRevision === null && contentRevision === null) {
        return;
      }
      listener();
    },
  );
  const releaseReferences = rendererLocalCommitIngress.subscribeAtoms((_packet, atom) => {
    if (!isPageFileReferenceChangeForDocument(atom, documentId)) return;
    listener();
  });
  return () => {
    releasePageFiles();
    releaseReferences();
  };
};
