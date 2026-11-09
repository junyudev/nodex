export const MAX_MANAGED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MANAGED_RESOURCE_BYTES = 64 * 1024 * 1024;

export interface ManagedAssetUploadInput {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ManagedImageSaveResult {
  readonly source: string;
  readonly fileName: string;
}

export interface ManagedCanvasImageMaterializationResult {
  readonly source: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly contentHash: string;
  readonly byteLength: number;
}

export interface ManagedResourceSaveResult {
  readonly source: string;
  readonly fileName: string;
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: number;
}

export interface ManagedAssetImageBytes {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

export interface ManagedFolderManifestEntry {
  readonly path: string;
  readonly kind: "file" | "folder";
  readonly bytes?: number;
}

export interface ManagedFolderManifest {
  readonly rootName: string;
  readonly generatedAt: string;
  readonly maxEntries: number;
  readonly maxDepth: number;
  readonly truncated: boolean;
  readonly entries: ManagedFolderManifestEntry[];
}
