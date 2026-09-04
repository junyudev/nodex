import { subscribeFileReadAuthority } from "@/lib/file-read-authority";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { fileSource, parseFileSource, type FileBytes } from "../../../../shared/file-resources";
import type { LibraryFilePresentation } from "../../../../shared/library-files";
import {
  importLibraryFile,
  readAuthorizedFile,
  readFilePresentation,
  saveAuthorizedFile,
  materializeAuthorizedFile,
  type FileReadAuthority,
  type FilePreviewAuthority,
  type FileUploadSource,
} from "@/lib/library-file-resources";
import {
  EMPTY_FILE_READ_SNAPSHOT,
  FileReadCache,
  fileReadAuthorityKey,
  type FileReadDemand,
  type FileReadInvalidation,
  type FileReadScope,
  type FileReadSnapshot,
} from "@/lib/file-read-cache";

export interface FilePlacementRuntime {
  readonly authority: FileReadAuthority | FilePreviewAuthority;
  upload(source: FileUploadSource, preferredLogicalPath?: string): Promise<string>;
  read(source: string): Promise<FileBytes>;
  metadata(source: string): Promise<LibraryFilePresentation>;
  readImageDataUrl(source: string): Promise<string>;
  save(source: string, logicalPath: string): Promise<void>;
  materialize(source: string): Promise<string>;
  preload(source: string, demand: FileReadDemand): void;
  snapshot(source: string): FileReadSnapshot;
  subscribe(source: string, demand: FileReadDemand, listener: () => void): () => void;
  invalidate(invalidation: FileReadInvalidation): void;
  release(): void;
}

const fileIdFromSource = (source: string): string => {
  const fileId = parseFileSource(source);
  if (!fileId) throw new Error("File reference is invalid");
  return fileId;
};

const fileDataUrl = async (file: FileBytes): Promise<string> => {
  const blob = new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mimeType });
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("Couldn’t read File image")),
      { once: true },
    );
    reader.addEventListener(
      "load",
      () =>
        typeof reader.result === "string"
          ? resolve(reader.result)
          : reject(new Error("Couldn’t encode File image")),
      { once: true },
    );
    reader.readAsDataURL(blob);
  });
};

export const createRendererFileReadCache = (): FileReadCache =>
  new FileReadCache({
    readMetadata: (authority, fileId) => readFilePresentation(authority, fileSource(fileId)),
    readBytes: (authority, fileId) => readAuthorizedFile(authority, fileSource(fileId)),
    createObjectUrl: (file) =>
      URL.createObjectURL(
        new Blob([file.bytes.slice().buffer as ArrayBuffer], { type: file.mimeType }),
      ),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  });

export const createFilePlacementRuntime = (
  authority: FileReadAuthority,
  cache: FileReadCache,
  documentId: string | null = null,
): FilePlacementRuntime => {
  let releaseAuthority: (() => void) | null = null;
  let reads: FileReadScope | null = null;
  const acquireReads = (): FileReadScope => {
    if (reads) return reads;
    reads = cache.acquire(authority);
    releaseAuthority = subscribeFileReadAuthority(authority, documentId, (invalidation) =>
      reads?.invalidate(invalidation),
    );
    return reads;
  };
  const snapshot = (source: string): FileReadSnapshot => {
    const fileId = fileIdFromSource(source);
    if (!reads) return EMPTY_FILE_READ_SNAPSHOT;
    return reads.snapshot(fileId);
  };
  return {
    authority,
    upload: async (source, defaultName) => {
      if (
        authority.version !== undefined ||
        !["page", "direct"].includes(authority.readSource.kind)
      ) {
        throw new Error("Historical File previews are read-only");
      }
      return (await importLibraryFile(authority, source, defaultName)).source;
    },
    read: (source) => acquireReads().readBytes(fileIdFromSource(source)),
    metadata: (source) => acquireReads().readMetadata(fileIdFromSource(source)),
    readImageDataUrl: async (source) =>
      await fileDataUrl(await acquireReads().readBytes(fileIdFromSource(source))),
    save: (source, logicalPath) => saveAuthorizedFile(authority, source, logicalPath),
    materialize: (source) => materializeAuthorizedFile(authority, source),
    preload: (source, demand) => acquireReads().preload(fileIdFromSource(source), demand),
    snapshot,
    subscribe: (source, demand, listener) =>
      acquireReads().subscribe(fileIdFromSource(source), demand, listener),
    invalidate: (invalidation) => reads?.invalidate(invalidation),
    release: () => {
      releaseAuthority?.();
      releaseAuthority = null;
      reads?.release();
      reads = null;
    },
  };
};

const FileRuntimeContext = createContext<FilePlacementRuntime | null>(null);

export function FileRuntimeProvider({
  value,
  children,
}: {
  readonly value: FilePlacementRuntime | null;
  readonly children: ReactNode;
}) {
  useEffect(() => () => value?.release(), [value]);
  return <FileRuntimeContext.Provider value={value}>{children}</FileRuntimeContext.Provider>;
}

export const useFilePlacementRuntime = (): FilePlacementRuntime | null =>
  useContext(FileRuntimeContext);

const subscribeToNothing = (): (() => void) => () => undefined;

export function useFileReadSnapshot(
  runtime: FilePlacementRuntime | null,
  source: string,
  demand: FileReadDemand,
): FileReadSnapshot {
  const fileId = parseFileSource(source);
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
    () => (runtime && fileId && hasDemand ? runtime.snapshot(source) : EMPTY_FILE_READ_SNAPSHOT),
    [fileId, hasDemand, runtime, source],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    if (!runtime || !fileId || !hasDemand) return;
    runtime.preload(source, { metadata, content, objectUrl });
  }, [content, fileId, hasDemand, metadata, objectUrl, runtime, source]);

  return snapshot;
}

/** A preview owns its cache lifetime. Changing any capability replaces and releases the scope. */
export function FileReadBoundary({
  authority,
  children,
}: {
  readonly authority?: FileReadAuthority | FilePreviewAuthority | null;
  readonly children: ReactNode;
}) {
  if (!authority) return <FileRuntimeProvider value={null}>{children}</FileRuntimeProvider>;
  return (
    <ScopedFileReadBoundary
      key={
        "bindings" in authority
          ? JSON.stringify([
              authority.libraryId,
              authority.storeEpoch,
              authority.contentAccessContext,
              Object.entries(authority.bindings).sort(([a], [b]) => a.localeCompare(b)),
            ])
          : fileReadAuthorityKey(authority)
      }
      authority={authority}
    >
      {children}
    </ScopedFileReadBoundary>
  );
}

function ScopedFileReadBoundary({
  authority,
  children,
}: {
  readonly authority: FileReadAuthority | FilePreviewAuthority;
  readonly children: ReactNode;
}) {
  const [runtime] = useState(() =>
    "bindings" in authority
      ? createFilePreviewRuntime(authority)
      : createFilePlacementRuntime(authority, createRendererFileReadCache()),
  );
  return <FileRuntimeProvider value={runtime}>{children}</FileRuntimeProvider>;
}

const UNAVAILABLE_PREVIEW_FILE: FileReadSnapshot = Object.freeze({
  ...EMPTY_FILE_READ_SNAPSHOT,
  metadataError: "This preview has no exact File binding",
  contentError: "This preview has no exact File binding",
});

/** A merged recovery preview routes each File to its verified source, with no fallback. */
export function createFilePreviewRuntime(authority: FilePreviewAuthority): FilePlacementRuntime {
  const cache = createRendererFileReadCache();
  const runtimes = new Map<string, FilePlacementRuntime>();
  const runtimeFor = (source: string): FilePlacementRuntime | null => {
    const id = fileIdFromSource(source);
    const binding = authority.bindings[id];
    if (!binding || binding.file_id !== id) return null;
    const existing = runtimes.get(id);
    if (existing) return existing;
    const runtime = createFilePlacementRuntime(
      {
        libraryId: authority.libraryId,
        storeEpoch: authority.storeEpoch,
        contentAccessContext: authority.contentAccessContext,
        readSource: binding.source,
        version: binding.version,
      },
      cache,
    );
    runtimes.set(id, runtime);
    return runtime;
  };
  const requireRuntime = (source: string): FilePlacementRuntime => {
    const runtime = runtimeFor(source);
    if (!runtime) throw new Error(UNAVAILABLE_PREVIEW_FILE.contentError!);
    return runtime;
  };
  return {
    authority,
    upload: async () => {
      throw new Error("Historical File previews are read-only");
    },
    read: async (source) => requireRuntime(source).read(source),
    metadata: async (source) => requireRuntime(source).metadata(source),
    readImageDataUrl: async (source) => requireRuntime(source).readImageDataUrl(source),
    save: async (source, name) => requireRuntime(source).save(source, name),
    materialize: async (source) => requireRuntime(source).materialize(source),
    preload: (source, demand) => runtimeFor(source)?.preload(source, demand),
    snapshot: (source) => runtimeFor(source)?.snapshot(source) ?? UNAVAILABLE_PREVIEW_FILE,
    subscribe: (source, demand, listener) =>
      runtimeFor(source)?.subscribe(source, demand, listener) ?? (() => undefined),
    invalidate: (change) => {
      for (const runtime of runtimes.values()) runtime.invalidate(change);
    },
    release: () => {
      for (const runtime of runtimes.values()) runtime.release();
      runtimes.clear();
    },
  };
}
