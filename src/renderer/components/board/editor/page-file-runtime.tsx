import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  pageFileSource,
  parsePageFileSource,
  type PageFileBytes,
} from "../../../../shared/page-files";
import type { LibraryPageFileSummary } from "../../../../shared/library-module";
import {
  createOwnedPageFile,
  readPlacedPageFile,
  readPlacedPageFileMetadata,
  saveOwnedPageFile,
  type PageFileAuthority,
  type PageFileUploadSource,
} from "@/lib/page-file-resources";
import {
  EMPTY_PAGE_FILE_READ_SNAPSHOT,
  PageFileReadCache,
  type PageFileReadDemand,
  type PageFileReadInvalidation,
  type PageFileReadScope,
  type PageFileReadSnapshot,
} from "@/lib/page-file-read-cache";

export interface PageFilePlacementRuntime {
  readonly authority: PageFileAuthority;
  upload(source: PageFileUploadSource, preferredLogicalPath?: string): Promise<string>;
  read(source: string): Promise<PageFileBytes>;
  metadata(source: string): Promise<LibraryPageFileSummary>;
  readImageDataUrl(source: string): Promise<string>;
  save(source: string, logicalPath: string): Promise<void>;
  preload(source: string, demand: PageFileReadDemand): void;
  snapshot(source: string): PageFileReadSnapshot;
  subscribe(source: string, demand: PageFileReadDemand, listener: () => void): () => void;
  invalidate(invalidation: PageFileReadInvalidation): void;
  release(): void;
}

const fileIdFromSource = (source: string): string => {
  const fileId = parsePageFileSource(source);
  if (!fileId) throw new Error("Page File reference is invalid");
  return fileId;
};

const pageFileDataUrl = async (file: PageFileBytes): Promise<string> => {
  const blob = new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mimeType });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Couldn’t read Page File image")),
      { once: true },
    );
    reader.addEventListener(
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Couldn’t encode Page File image")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
};

export const createRendererPageFileReadCache = (): PageFileReadCache =>
  new PageFileReadCache({
    readMetadata: (authority, fileId) =>
      readPlacedPageFileMetadata(authority, pageFileSource(fileId)),
    readBytes: (authority, fileId) => readPlacedPageFile(authority, pageFileSource(fileId)),
    createObjectUrl: (file) =>
      URL.createObjectURL(
        new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mimeType }),
      ),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  });

export const createPageFilePlacementRuntime = (
  authority: PageFileAuthority,
  cache: PageFileReadCache,
): PageFilePlacementRuntime => {
  let reads: PageFileReadScope | null = null;
  const acquireReads = (): PageFileReadScope => {
    reads ??= cache.acquire(authority);
    return reads;
  };
  const snapshot = (source: string): PageFileReadSnapshot => {
    const fileId = fileIdFromSource(source);
    if (!reads) return EMPTY_PAGE_FILE_READ_SNAPSHOT;
    return reads.snapshot(fileId);
  };
  return {
    authority,
    upload: async (source, preferredLogicalPath) =>
      (await createOwnedPageFile(authority, source, preferredLogicalPath)).source,
    read: (source) => acquireReads().readBytes(fileIdFromSource(source)),
    metadata: (source) => acquireReads().readMetadata(fileIdFromSource(source)),
    readImageDataUrl: async (source) =>
      await pageFileDataUrl(await acquireReads().readBytes(fileIdFromSource(source))),
    save: (source, logicalPath) => saveOwnedPageFile(authority, source, logicalPath),
    preload: (source, demand) => acquireReads().preload(fileIdFromSource(source), demand),
    snapshot,
    subscribe: (source, demand, listener) =>
      acquireReads().subscribe(fileIdFromSource(source), demand, listener),
    invalidate: (invalidation) => reads?.invalidate(invalidation),
    release: () => {
      reads?.release();
      reads = null;
    },
  };
};

const PageFileRuntimeContext = createContext<PageFilePlacementRuntime | null>(null);

export function PageFileRuntimeProvider({
  value,
  children,
}: {
  readonly value: PageFilePlacementRuntime | null;
  readonly children: ReactNode;
}) {
  useEffect(() => () => value?.release(), [value]);
  return (
    <PageFileRuntimeContext.Provider value={value}>{children}</PageFileRuntimeContext.Provider>
  );
}

export const usePageFilePlacementRuntime = (): PageFilePlacementRuntime | null =>
  useContext(PageFileRuntimeContext);

const subscribeToNothing = (): (() => void) => () => undefined;

export function usePageFileReadSnapshot(
  runtime: PageFilePlacementRuntime | null,
  source: string,
  demand: PageFileReadDemand,
): PageFileReadSnapshot {
  const fileId = parsePageFileSource(source);
  const metadata = demand.metadata === true;
  const content = demand.content === true;
  const objectUrl = demand.objectUrl === true;
  const hasDemand = metadata || content || objectUrl;
  const subscribe = useCallback(
    (listener: () => void) =>
      runtime && fileId && hasDemand
        ? runtime.subscribe(source, { metadata, content, objectUrl }, listener)
        : subscribeToNothing(),
    [content, fileId, hasDemand, metadata, objectUrl, runtime, source],
  );
  const getSnapshot = useCallback(
    () =>
      runtime && fileId && hasDemand ? runtime.snapshot(source) : EMPTY_PAGE_FILE_READ_SNAPSHOT,
    [fileId, hasDemand, runtime, source],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!runtime || !fileId || !hasDemand) return;
    runtime.preload(source, { metadata, content, objectUrl });
  }, [content, fileId, hasDemand, metadata, objectUrl, runtime, source]);

  return snapshot;
}
