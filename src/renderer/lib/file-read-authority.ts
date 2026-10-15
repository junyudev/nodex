import type { FileReadAuthority } from "./library-file-resources";
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

/** Tracks File metadata, bytes and owner presentation lifecycle without eager reads. */
export const subscribeFileReadAuthority = (
  authority: FileReadAuthority,
  documentId: string | null,
  listener: (invalidation: FileReadInvalidation) => void,
): (() => void) => {
  const source = authority.readSource;
  const releasePageFiles =
    source.kind === "page"
      ? subscribePageFileChanges(source.page_id, (change) => {
          // Entries and body occurrences determine presentation metadata.
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
    authority.contentRoutingContext.kind === "project"
      ? {
          kind: "project" as const,
          libraryId: authority.libraryId,
          projectId: authority.contentRoutingContext.projectId,
        }
      : { kind: "library" as const, libraryId: authority.libraryId };
  const releaseResets = rendererLocalCommitIngress.subscribeProjection(scope, (message) => {
    if (message.kind === "reset") listener(revokeAll);
  });
  return () => {
    releasePageFiles();
    releaseReferences();
    releaseResets();
  };
};
