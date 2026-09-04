import type { FileReadAuthority } from "./library-file-resources";
import type { ResourceRevocationMessage } from "../../shared/resource-revocation-stream";
import type { AuthorizedDeliveryPacket } from "../../shared/local-commit-delivery";
import { rendererLocalCommitIngress } from "./local-commit-ingress";
import { subscribePageFileChanges, type PageFileChange } from "./page-library-changes";
import type { FileReadInvalidation } from "./file-read-cache";

type DeliveryAtom = AuthorizedDeliveryPacket["atoms"][number];

export const isFileSourceReferenceChangeForDocument = (
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
): readonly FileReadInvalidation[] => {
  if (!isFileSourceReferenceChangeForDocument(atom, documentId)) return [];
  const payload = atom.payload;
  if (payload.module !== "owned_document") return [];
  const event = payload.event;
  if (event.kind !== "page_file_references_changed") return [];
  const change = event.change;
  if (change.kind === "reset") {
    return [{ mode: "revoke", fileIds: null, metadata: true, content: true }];
  }
  const invalidations: FileReadInvalidation[] = [];
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
): readonly FileReadInvalidation[] => {
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
  const invalidations: FileReadInvalidation[] = [];
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

const revokeAll: FileReadInvalidation = {
  mode: "revoke",
  fileIds: null,
  metadata: true,
  content: true,
};

/** Direct File grants and owner-bound read sources have independent revocation dependencies. */
export function fileReadRevocationInvalidations(
  authority: FileReadAuthority,
  documentId: string | null,
  message: ResourceRevocationMessage,
): readonly FileReadInvalidation[] {
  if (message.kind === "reset") return [revokeAll];
  const revoked = message.delivery.revocation;
  const source = authority.readSource;
  if (source.kind === "direct") {
    return revoked.resource_kind === "file"
      ? [{ ...revokeAll, fileIds: [revoked.resource_id] }]
      : [];
  }
  if (revoked.resource_kind === "file") return [];
  if (source.kind === "page") {
    return (revoked.resource_kind === "page" && revoked.resource_id === source.page_id) ||
      (revoked.resource_kind === "document" && revoked.resource_id === documentId)
      ? [revokeAll]
      : [];
  }
  if (source.kind === "canvas") {
    return (revoked.resource_kind === "canvas" && revoked.resource_id === source.canvas_id) ||
      (revoked.resource_kind === "document" && revoked.resource_id === documentId)
      ? [revokeAll]
      : [];
  }
  // A captured Document source does not expose its owner identity. Conservatively
  // clear on an owner revoke; Core reauthorizes the exact captured target on reread.
  return revoked.resource_kind === "page" ||
    revoked.resource_kind === "canvas" ||
    (revoked.resource_kind === "document" && revoked.resource_id === source.document_id)
    ? [revokeAll]
    : [];
}

/** One subscription follows the File read capability, including recipient resets and ACL loss. */
export const subscribeFileReadAuthority = (
  authority: FileReadAuthority,
  documentId: string | null,
  listener: (invalidation: FileReadInvalidation) => void,
): (() => void) => {
  const source = authority.readSource;
  const releasePageFiles =
    source.kind === "page"
      ? subscribePageFileChanges(source.page_id, (change) => {
          // A relation change may remove the read capability; do not retain stale bytes while checking.
          if (change.manifestRevision !== null) {
            listener({
              ...revokeAll,
              fileIds: mergeExactFileIds([
                change.manifestFileIds,
                ...(change.contentRevision === null ? [] : [change.contentFileIds]),
              ]),
            });
            return;
          }
          for (const invalidation of pageFileReadInvalidationsFromChange(change))
            listener(invalidation);
        })
      : () => undefined;
  const releaseReferences = rendererLocalCommitIngress.subscribeAtoms((_packet, atom) => {
    if (atom.payload.library_id !== authority.libraryId) return;
    if (source.kind === "direct" && atom.payload.module === "library") {
      const fileIds = Object.keys(atom.payload.event.file_revisions);
      if (fileIds.length)
        listener({
          mode: "refresh",
          fileIds,
          metadata: true,
          content: authority.version === undefined,
        });
      return;
    }
    if (source.kind !== "page" || !documentId) return;
    for (const invalidation of pageFileReferenceInvalidationsForDocument(atom, documentId))
      listener(invalidation);
  });
  const scope =
    authority.contentAccessContext.kind === "project"
      ? {
          kind: "project" as const,
          libraryId: authority.libraryId,
          projectId: authority.contentAccessContext.projectId,
        }
      : { kind: "library" as const, libraryId: authority.libraryId };
  const releaseRevocations = rendererLocalCommitIngress.subscribeRevocation(scope, (message) => {
    for (const invalidation of fileReadRevocationInvalidations(authority, documentId, message))
      listener(invalidation);
  });
  return () => {
    releasePageFiles();
    releaseReferences();
    releaseRevocations();
  };
};
