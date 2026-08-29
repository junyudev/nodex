import type { components } from "@nodex/core-protocol";

import { rendererLocalCommitIngress } from "./local-commit-ingress";

type PageFileLibraryEvent = components["schemas"]["LibraryEvent"];
type PageFileInvalidation = components["schemas"]["LibraryPageFileInvalidation"];

export interface PageFileChange {
  readonly manifestRevision: number | null;
  readonly manifestFileIds: readonly string[] | null;
  readonly bodyUsageRevision: number | null;
  readonly contentRevision: number | null;
  readonly contentFileIds: readonly string[] | null;
}

export interface PageFileScopedChange extends PageFileChange {
  readonly pageId: string;
}

interface PageFileRevisionSignal {
  readonly revision: number;
  readonly fileIds: readonly string[] | null;
}

const invalidationSignal = (
  invalidation: PageFileInvalidation | undefined,
): PageFileRevisionSignal | null =>
  invalidation
    ? {
        revision: invalidation.revision,
        fileIds: invalidation.kind === "exact" ? invalidation.file_ids : null,
      }
    : null;

export const pageFileManifestChangeFromLibraryEvent = (
  event: PageFileLibraryEvent,
  pageId: string,
): PageFileRevisionSignal | null =>
  invalidationSignal(event.page_file_manifest_invalidations[pageId]);

export const pageFileContentChangeFromLibraryEvent = (
  event: PageFileLibraryEvent,
  pageId: string,
): PageFileRevisionSignal | null =>
  invalidationSignal(event.page_file_content_invalidations[pageId]);

export const pageFileManifestRevisionFromLibraryEvent = (
  event: PageFileLibraryEvent,
  pageId: string,
): number | null => {
  return pageFileManifestChangeFromLibraryEvent(event, pageId)?.revision ?? null;
};

export const pageFileBodyUsageRevisionFromLibraryEvent = (
  event: PageFileLibraryEvent,
  pageId: string,
): number | null => {
  const revision = event.page_file_body_usage_revisions[pageId];
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
};

export const pageFileContentRevisionFromLibraryEvent = (
  event: PageFileLibraryEvent,
  pageId: string,
): number | null => {
  return pageFileContentChangeFromLibraryEvent(event, pageId)?.revision ?? null;
};

/** Subscribe only to authorized commits that changed this Page's File inventory projection. */
export const subscribeAllPageFileChanges = (
  listener: (change: PageFileScopedChange) => void,
): (() => void) =>
  rendererLocalCommitIngress.subscribeAtoms((_packet, atom) => {
    const payload = atom.payload;
    if (payload.module !== "library") return;
    const pageIds = new Set([
      ...Object.keys(payload.event.page_file_manifest_invalidations),
      ...Object.keys(payload.event.page_file_body_usage_revisions),
      ...Object.keys(payload.event.page_file_content_invalidations),
    ]);
    for (const pageId of pageIds) {
      const manifest = pageFileManifestChangeFromLibraryEvent(payload.event, pageId);
      const bodyUsageRevision = pageFileBodyUsageRevisionFromLibraryEvent(payload.event, pageId);
      const content = pageFileContentChangeFromLibraryEvent(payload.event, pageId);
      const manifestRevision = manifest?.revision ?? null;
      const contentRevision = content?.revision ?? null;
      if (manifestRevision === null && bodyUsageRevision === null && contentRevision === null) {
        continue;
      }
      listener({
        pageId,
        manifestRevision,
        manifestFileIds: manifest?.fileIds ?? null,
        bodyUsageRevision,
        contentRevision,
        contentFileIds: content?.fileIds ?? null,
      });
    }
  });

export const subscribePageFileChanges = (
  pageId: string,
  listener: (change: PageFileChange) => void,
): (() => void) =>
  subscribeAllPageFileChanges((change) => {
    if (change.pageId !== pageId) return;
    listener(change);
  });
