import { createContext, useContext, type ReactNode } from "react";

import type { PageFileBytes } from "../../../../shared/page-files";
import type { LibraryPageFileSummary } from "../../../../shared/library-module";
import {
  createOwnedPageFile,
  pageFileImageDataUrl,
  readPlacedPageFile,
  readPlacedPageFileMetadata,
  saveOwnedPageFile,
  type PageFileAuthority,
  type PageFileUploadSource,
} from "@/lib/page-file-resources";

export interface PageFilePlacementRuntime {
  readonly authority: PageFileAuthority;
  readonly readAuthorityEpoch: number;
  upload(source: PageFileUploadSource, preferredLogicalPath?: string): Promise<string>;
  read(source: string): Promise<PageFileBytes>;
  metadata(source: string): Promise<LibraryPageFileSummary>;
  readImageDataUrl(source: string): Promise<string>;
  save(source: string, logicalPath: string): Promise<void>;
}

export const createPageFilePlacementRuntime = (
  authority: PageFileAuthority,
  readAuthorityEpoch = 0,
): PageFilePlacementRuntime => ({
  authority,
  readAuthorityEpoch,
  upload: async (source, preferredLogicalPath) =>
    (await createOwnedPageFile(authority, source, preferredLogicalPath)).source,
  read: (source) => readPlacedPageFile(authority, source),
  metadata: (source) => readPlacedPageFileMetadata(authority, source),
  readImageDataUrl: (source) => pageFileImageDataUrl(authority, source),
  save: (source, logicalPath) => saveOwnedPageFile(authority, source, logicalPath),
});

const PageFileRuntimeContext = createContext<PageFilePlacementRuntime | null>(null);

export function PageFileRuntimeProvider({
  value,
  children,
}: {
  readonly value: PageFilePlacementRuntime | null;
  readonly children: ReactNode;
}) {
  return (
    <PageFileRuntimeContext.Provider value={value}>{children}</PageFileRuntimeContext.Provider>
  );
}

export const usePageFilePlacementRuntime = (): PageFilePlacementRuntime | null =>
  useContext(PageFileRuntimeContext);
