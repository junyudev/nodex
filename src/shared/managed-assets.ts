export const MAX_MANAGED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_MANAGED_RESOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_MANAGED_PREVIEW_BYTES = 64 * 1024;
export const MAX_MANAGED_PREVIEW_LINES = 200;

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

export type ManagedAssetPreview =
  | {
      readonly kind: "text";
      readonly content: string;
      readonly truncated: boolean;
    }
  | {
      readonly kind: "folder";
      readonly manifest: ManagedFolderManifest;
    };

export interface ManagedAssetPreviewInput {
  readonly source: string;
  readonly kind: ManagedAssetPreview["kind"];
}

function truncateToUtf8Bytes(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maxBytes) return value;

  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    const candidate = value.slice(0, midpoint);
    if (encoder.encode(candidate).byteLength <= maxBytes) {
      lower = midpoint;
      continue;
    }
    upper = midpoint - 1;
  }

  let end = lower;
  if (end > 0 && end < value.length && /[\uD800-\uDBFF]/u.test(value[end - 1] ?? "")) {
    end -= 1;
  }
  return value.slice(0, end);
}

export function createManagedTextPreview(
  value: string,
): Extract<ManagedAssetPreview, { kind: "text" }> {
  const lines = value.split("\n");
  const lineBounded = lines.slice(0, MAX_MANAGED_PREVIEW_LINES).join("\n");
  const content = truncateToUtf8Bytes(lineBounded, MAX_MANAGED_PREVIEW_BYTES);
  return {
    kind: "text",
    content,
    truncated: lines.length > MAX_MANAGED_PREVIEW_LINES || content.length < lineBounded.length,
  };
}
