import type { LibraryPlacedResourceTarget as AnyLibraryResourceTarget } from "../../../shared/library-module";

export type LibraryResourceTarget = Exclude<AnyLibraryResourceTarget, { readonly kind: "canvas" }>;

export interface LibraryProjectOption {
  readonly id: string;
  readonly name: string;
}

export type OpenLibraryResourceInProject = (
  projectId: string,
  target: LibraryResourceTarget,
  title: string,
) => void | Promise<void>;

export const libraryResourceTargetKey = (target: LibraryResourceTarget): string =>
  target.kind === "page" ? `page:${target.pageId}` : `database:${target.databaseId}`;
