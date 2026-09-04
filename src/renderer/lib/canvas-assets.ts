import type { CanvasSceneFile } from "../../shared/block-documents/canvas-scene";
import { rendererLocalCommitIngress } from "./local-commit-ingress";
import type { LibraryFileReadSource } from "../../shared/library-files";
import {
  importLibraryFile,
  readAuthorizedFile,
  type LibraryFileAuthority,
} from "./library-file-resources";

export interface CanvasBinaryFileData {
  readonly id: string;
  readonly dataURL: string;
  readonly mimeType: string;
  readonly created: number;
  readonly lastRetrieved?: number;
}

export type CanvasBinaryFiles = Readonly<Record<string, CanvasBinaryFileData>>;

export interface CanvasAssetBridgeDependencies {
  readonly materializeImage?: (
    file: File,
  ) => Promise<Pick<CanvasSceneFile, "source" | "fileVersion" | "defaultName" | "mimeType">>;
  readonly readFileDataUrl?: (file: CanvasSceneFile) => Promise<string>;
  readonly now?: () => number;
}

export const collectCanvasReferencedFileIds = (
  elements: readonly unknown[],
): ReadonlySet<string> => {
  const fileIds = new Set<string>();
  for (const element of elements) {
    if (!element || typeof element !== "object") continue;
    const candidate = element as Readonly<Record<string, unknown>>;
    if (
      candidate.type === "image" &&
      candidate.isDeleted !== true &&
      typeof candidate.fileId === "string"
    ) {
      fileIds.add(candidate.fileId);
    }
  }
  return fileIds;
};

const extensionForMimeType = (mimeType: string): string => {
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "image/avif") return ".avif";
  if (mimeType === "image/svg+xml") return ".svg";
  if (mimeType === "image/bmp") return ".bmp";
  return ".png";
};

const dataUrlToFile = async (file: CanvasBinaryFileData): Promise<File> => {
  const response = await fetch(file.dataURL);
  if (!response.ok) throw new Error(`Canvas file ${file.id} is unreadable`);
  const blob = await response.blob();
  return new File([blob], `Canvas image${extensionForMimeType(file.mimeType)}`, {
    type: file.mimeType,
  });
};

/** Upload-first conversion; no scene mutation is enqueued until every file exists. */
export const materializeDurableCanvasFiles = async (input: {
  readonly elementsIncludingDeleted: readonly unknown[];
  readonly binaryFiles: CanvasBinaryFiles;
  readonly current: Readonly<Record<string, CanvasSceneFile>>;
  readonly dependencies?: CanvasAssetBridgeDependencies;
}): Promise<Readonly<Record<string, CanvasSceneFile>>> => {
  const materialize = input.dependencies?.materializeImage;

  const durable: Record<string, CanvasSceneFile> = {};
  for (const fileId of collectCanvasReferencedFileIds(input.elementsIncludingDeleted)) {
    const current = input.current[fileId];
    if (current) {
      durable[fileId] = current;
      continue;
    }
    const binary = input.binaryFiles[fileId];
    if (!binary) {
      throw new Error(`Canvas image ${fileId} has no binary payload`);
    }
    if (!materialize) throw new Error("Canvas File import authority is unavailable");
    const file = await dataUrlToFile(binary);
    const materialized = await materialize(file);
    durable[fileId] = {
      id: fileId,
      ...materialized,
      created: binary.created,
    };
  }
  return durable;
};

interface CanvasBinaryFileCacheEntry {
  readonly identity: string;
  readonly dataUrl: Promise<string>;
}

const canvasFileContentIdentity = (file: CanvasSceneFile): string =>
  JSON.stringify([file.source, file.fileVersion, file.defaultName, file.mimeType]);

/**
 * Surface-scoped resolver for remote scene presentation. Cache identity is the
 * exact File target plus MIME type; each resolve prunes files no longer
 * referenced and shares in-flight reads for unchanged entries.
 */
export class CanvasBinaryFileResolver {
  private readonly dependencies: CanvasAssetBridgeDependencies;
  private readonly cache = new Map<string, CanvasBinaryFileCacheEntry>();
  private destroyed = false;
  private generation = 0;

  constructor(dependencies: CanvasAssetBridgeDependencies = {}) {
    this.dependencies = dependencies;
  }

  resolve = async (
    files: Readonly<Record<string, CanvasSceneFile>>,
  ): Promise<CanvasBinaryFiles> => {
    if (this.destroyed) {
      throw new Error("Canvas binary file resolver is destroyed");
    }
    const generation = this.generation;
    const referencedIds = new Set(Object.keys(files));
    for (const fileId of this.cache.keys()) {
      if (!referencedIds.has(fileId)) this.cache.delete(fileId);
    }
    const resolved = await Promise.all(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(async ([fileId, file]) => {
          const identity = canvasFileContentIdentity(file);
          const entry = this.getOrCreateEntry(fileId, file, identity);
          const dataURL = await entry.dataUrl;
          const now = (this.dependencies.now ?? Date.now)();
          return [
            fileId,
            {
              id: fileId,
              dataURL,
              mimeType: file.mimeType,
              created: file.created ?? now,
              lastRetrieved: now,
            },
          ] as const;
        }),
    );
    if (this.destroyed || generation !== this.generation)
      throw new Error("Canvas File read was invalidated");
    return Object.fromEntries(resolved);
  };

  clear = (): void => {
    this.generation += 1;
    this.cache.clear();
  };

  destroy = (): void => {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clear();
  };

  private getOrCreateEntry(
    fileId: string,
    file: CanvasSceneFile,
    identity: string,
  ): CanvasBinaryFileCacheEntry {
    const current = this.cache.get(fileId);
    if (current?.identity === identity) return current;
    const readFileDataUrl = this.dependencies.readFileDataUrl;
    if (!readFileDataUrl) throw new Error("Canvas File read authority is unavailable");
    const entry: CanvasBinaryFileCacheEntry = {
      identity,
      dataUrl: readFileDataUrl(file),
    };
    this.cache.set(fileId, entry);
    void entry.dataUrl.catch(() => {
      if (this.cache.get(fileId) === entry) this.cache.delete(fileId);
    });
    return entry;
  }
}

/** Resolve ref-only durable files into Excalidraw's disposable BinaryFiles. */
export const resolveCanvasBinaryFiles = async (
  files: Readonly<Record<string, CanvasSceneFile>>,
  dependencies: CanvasAssetBridgeDependencies = {},
): Promise<CanvasBinaryFiles> => {
  const resolver = new CanvasBinaryFileResolver(dependencies);
  try {
    return await resolver.resolve(files);
  } finally {
    resolver.destroy();
  }
};

/** Canvas publication creates independent Files; each reader selects its exact authorized slot. */
export function createCanvasFileBridge(
  authority: LibraryFileAuthority,
  sourceFor: (file: CanvasSceneFile) => LibraryFileReadSource,
): CanvasAssetBridgeDependencies {
  return {
    materializeImage: async (image) => {
      const { file, source } = await importLibraryFile(authority, {
        kind: "browser_file",
        file: image,
      });
      return {
        source,
        fileVersion: file.head_version,
        defaultName: file.default_name,
        mimeType: file.mime_type,
      };
    },
    readFileDataUrl: async (file) => {
      const bytes = await readAuthorizedFile(
        { ...authority, readSource: sourceFor(file), version: file.fileVersion },
        file.source,
      );
      if (bytes.mimeType !== file.mimeType) throw new Error("Canvas File MIME type changed");
      let binary = "";
      for (let offset = 0; offset < bytes.bytes.length; offset += 8_192) {
        binary += String.fromCharCode(...bytes.bytes.subarray(offset, offset + 8_192));
      }
      return `data:${bytes.mimeType};base64,${btoa(binary)}`;
    },
  };
}

/** Canvas presentations depend on their owner, independently of a direct File grant. */
export function subscribeCanvasFileAuthority(
  authority: LibraryFileAuthority,
  owner: { readonly canvasId?: string; readonly documentId: string },
  invalidate: () => void,
): () => void {
  const scope =
    authority.contentAccessContext.kind === "project"
      ? {
          kind: "project" as const,
          libraryId: authority.libraryId,
          projectId: authority.contentAccessContext.projectId,
        }
      : { kind: "library" as const, libraryId: authority.libraryId };
  return rendererLocalCommitIngress.subscribeRevocation(scope, (message) => {
    if (message.kind === "reset") {
      invalidate();
      return;
    }
    const revoked = message.delivery.revocation;
    if (
      revoked.resource_kind === "page" ||
      (revoked.resource_kind === "document" && revoked.resource_id === owner.documentId) ||
      (revoked.resource_kind === "canvas" &&
        (!owner.canvasId || revoked.resource_id === owner.canvasId))
    )
      invalidate();
  });
}
