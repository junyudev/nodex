import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "node:crypto";

import { getAssetSource, isSafeAssetFileName, parseAssetSource } from "../../shared/assets";
import {
  MAX_MANAGED_IMAGE_BYTES,
  MAX_MANAGED_PREVIEW_BYTES,
  MAX_MANAGED_RESOURCE_BYTES,
  createManagedTextPreview,
  type ManagedAssetImageBytes,
  type ManagedAssetPreview,
  type ManagedAssetPreviewInput,
  type ManagedAssetUploadInput,
  type ManagedCanvasImageMaterializationResult,
  type ManagedFolderManifest,
  type ManagedFolderManifestEntry,
  type ManagedImageSaveResult,
  type ManagedResourceSaveResult,
} from "../../shared/managed-assets";

export const MAX_IMAGE_UPLOAD_BYTES = MAX_MANAGED_IMAGE_BYTES;
export const MAX_RESOURCE_UPLOAD_BYTES = MAX_MANAGED_RESOURCE_BYTES;

const IMAGE_MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
};

const EXTENSION_TO_IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

const EXTENSION_TO_TEXT_MIME: Record<string, string> = {
  ".c": "text/x-c",
  ".cc": "text/x-c++src",
  ".cpp": "text/x-c++src",
  ".cs": "text/x-csharp",
  ".css": "text/css",
  ".csv": "text/csv",
  ".go": "text/x-go",
  ".h": "text/x-c",
  ".hpp": "text/x-c++hdr",
  ".html": "text/html",
  ".java": "text/x-java-source",
  ".js": "text/javascript",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".mjs": "text/javascript",
  ".py": "text/x-python",
  ".rb": "text/x-ruby",
  ".rs": "text/x-rustsrc",
  ".sh": "text/x-shellscript",
  ".sql": "application/sql",
  ".toml": "application/toml",
  ".ts": "text/typescript",
  ".tsx": "text/tsx",
  ".txt": "text/plain",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zsh": "text/x-shellscript",
};

export function isSupportedImageMimeType(mimeType: string): boolean {
  return mimeType in IMAGE_MIME_TO_EXTENSION;
}

function assertAssetPathInsideRoot(targetPath: string, assetsRootPath: string): void {
  const rootPath = path.resolve(assetsRootPath);
  const pathPrefix = `${rootPath}${path.sep}`;
  if (targetPath === rootPath || targetPath.startsWith(pathPrefix)) {
    return;
  }

  throw new Error("Invalid asset path");
}

export function resolveAssetPathInRoot(assetsRootPath: string, fileName: string): string {
  if (!isSafeAssetFileName(fileName)) {
    throw new Error("Invalid file name");
  }

  const resolvedPath = path.resolve(assetsRootPath, fileName);
  assertAssetPathInsideRoot(resolvedPath, assetsRootPath);
  return resolvedPath;
}

export function getMimeTypeForAssetFile(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return (
    EXTENSION_TO_IMAGE_MIME[extension] ??
    EXTENSION_TO_TEXT_MIME[extension] ??
    "application/octet-stream"
  );
}

export function getImageMimeTypeForAssetFile(fileName: string): string | null {
  const extension = path.extname(fileName).toLowerCase();
  return EXTENSION_TO_IMAGE_MIME[extension] ?? null;
}

function sanitizeExtension(extension: string): string {
  if (!extension) return "";
  return /^[A-Za-z0-9._-]+$/.test(extension) ? extension : "";
}

function resolveStoredExtension(fileName: string, mimeType: string): string {
  const fromName = sanitizeExtension(path.extname(fileName).toLowerCase());
  if (fromName) return fromName;

  const imageExtension = IMAGE_MIME_TO_EXTENSION[mimeType];
  if (imageExtension) return imageExtension;

  const textExtension = Object.entries(EXTENSION_TO_TEXT_MIME).find(
    ([, candidateMimeType]) => candidateMimeType === mimeType,
  )?.[0];
  return textExtension ?? "";
}

function writeAssetBytesAtRoot(assetsRootPath: string, fileName: string, bytes: Buffer): string {
  const absolutePath = resolveAssetPathInRoot(assetsRootPath, fileName);
  const stagingRootPath = `${path.resolve(assetsRootPath)}.staging`;
  fs.mkdirSync(assetsRootPath, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stagingRootPath, { recursive: true, mode: 0o700 });
  const temporaryName = `.${fileName}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = resolveAssetPathInRoot(stagingRootPath, temporaryName);
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fileDescriptor, bytes);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    fs.renameSync(temporaryPath, absolutePath);
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
  return absolutePath;
}

const decodeInlineImageDataUrl = (
  dataUrl: string,
): { readonly bytes: Buffer; readonly mimeType: string } => {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/u.exec(dataUrl);
  if (!match?.[1] || !match[2]) {
    throw new Error("Canvas image must be a base64 data URL");
  }
  const mimeType = normalizeMimeType(match[1]);
  if (!isSupportedImageMimeType(mimeType)) {
    throw new Error(`Unsupported Canvas image type: ${mimeType}`);
  }
  const bytes = Buffer.from(match[2].replace(/\s+/gu, ""), "base64");
  if (bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Canvas image exceeds 10MB upload limit");
  }
  return { bytes, mimeType };
};

const assertContentAddressedAsset = (absolutePath: string, expectedHash: string): void => {
  const stats = fs.lstatSync(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Cached media must be a regular file");
  }
  const actualHash = createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
  if (actualHash === expectedHash) return;
  throw new Error("Cached media content hash does not match");
};

const isAlreadyExistsError = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

export const cacheContentAddressedBytes = (
  assetsRootPath: string,
  fileName: string,
  bytes: Buffer,
  contentHash: string,
): void => {
  const absolutePath = resolveAssetPathInRoot(assetsRootPath, fileName);
  const stagingRootPath = `${path.resolve(assetsRootPath)}.staging`;
  fs.mkdirSync(assetsRootPath, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stagingRootPath, { recursive: true, mode: 0o700 });
  if (fs.existsSync(absolutePath)) {
    assertContentAddressedAsset(absolutePath, contentHash);
    return;
  }

  const temporaryName = `.${fileName}.${process.pid}.${randomUUID()}.tmp`;
  const temporaryPath = resolveAssetPathInRoot(stagingRootPath, temporaryName);
  let fileDescriptor: number | null = null;
  try {
    fileDescriptor = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(fileDescriptor, bytes);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
    try {
      fs.linkSync(temporaryPath, absolutePath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }
    assertContentAddressedAsset(absolutePath, contentHash);
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    try {
      fs.unlinkSync(temporaryPath);
    } catch (error) {
      if (!isAlreadyExistsError(error) && fs.existsSync(temporaryPath)) {
        throw error;
      }
    }
  }
};

const materializeCanvasImageBytesAtRoot = (
  bytes: Buffer,
  mimeType: string,
  assetsRootPath: string,
): ManagedCanvasImageMaterializationResult => {
  if (!isSupportedImageMimeType(mimeType)) {
    throw new Error(`Unsupported Canvas image type: ${mimeType}`);
  }
  if (bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Canvas image exceeds 10MB upload limit");
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const extension = IMAGE_MIME_TO_EXTENSION[mimeType] ?? "";
  const fileName = `canvas-${contentHash}${extension}`;
  cacheContentAddressedBytes(assetsRootPath, fileName, bytes, contentHash);
  return {
    source: getAssetSource(fileName),
    fileName,
    mimeType,
    contentHash,
    byteLength: bytes.byteLength,
  };
};

/** One-way import seam; managed filename is content-addressed and idempotent. */
export function materializeInlineImageAtRoot(
  dataUrl: string,
  options: {
    readonly assetsRootPath: string;
    readonly namespace: "canvas" | "legacy-card";
  },
): { readonly source: string; readonly fileName: string; readonly mimeType: string } {
  const { bytes, mimeType } = decodeInlineImageDataUrl(dataUrl);
  if (options.namespace === "canvas") {
    const result = materializeCanvasImageBytesAtRoot(bytes, mimeType, options.assetsRootPath);
    return {
      source: result.source,
      fileName: result.fileName,
      mimeType: result.mimeType,
    };
  }
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const extension = IMAGE_MIME_TO_EXTENSION[mimeType] ?? "";
  const fileName = `${options.namespace}-${contentHash}${extension}`;
  cacheContentAddressedBytes(options.assetsRootPath, fileName, bytes, contentHash);
  return { source: getAssetSource(fileName), fileName, mimeType };
}

function materializeCanvasImageAtRoot(
  input: ManagedAssetUploadInput,
  assetsRootPath: string,
): ManagedCanvasImageMaterializationResult {
  const upload = normalizeAssetUploadInput(input);
  return materializeCanvasImageBytesAtRoot(upload.bytes, upload.mimeType, assetsRootPath);
}

function inferMimeTypeFromLocalPath(localPath: string): string {
  const extension = path.extname(localPath).toLowerCase();
  return (
    EXTENSION_TO_IMAGE_MIME[extension] ??
    EXTENSION_TO_TEXT_MIME[extension] ??
    "application/octet-stream"
  );
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.trim().split(";")[0]?.trim();
  return normalized && normalized.length > 0 ? normalized : "application/octet-stream";
}

function buildFolderManifest(
  rootPath: string,
  maxEntries = 100,
  maxDepth = 3,
): ManagedFolderManifest {
  const entries: ManagedFolderManifestEntry[] = [];
  const normalizedRootPath = path.resolve(rootPath);
  let truncated = false;

  const visit = (currentPath: string, depth: number): void => {
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    if (depth > maxDepth) {
      truncated = true;
      return;
    }

    const children = fs
      .readdirSync(currentPath, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }

      const absoluteChildPath = path.join(currentPath, child.name);
      const relativeChildPath = path.relative(normalizedRootPath, absoluteChildPath) || child.name;
      if (child.isDirectory()) {
        entries.push({ path: relativeChildPath, kind: "folder" });
        visit(absoluteChildPath, depth + 1);
        continue;
      }

      const stats = fs.statSync(absoluteChildPath);
      entries.push({
        path: relativeChildPath,
        kind: "file",
        bytes: stats.size,
      });
    }
  };

  visit(normalizedRootPath, 1);

  return {
    rootName: path.basename(normalizedRootPath),
    generatedAt: new Date().toISOString(),
    maxEntries,
    maxDepth,
    truncated,
    entries,
  };
}

function normalizeAssetUploadInput(input: ManagedAssetUploadInput): {
  name: string;
  mimeType: string;
  bytes: Buffer;
} {
  if (!input || typeof input !== "object") {
    throw new Error("Asset upload is required");
  }
  if (!(input.bytes instanceof Uint8Array)) {
    throw new Error("Asset upload bytes are invalid");
  }

  const name = input.name
    .replace(/[\u0000-\u001F\u007F]/gu, "")
    .trim()
    .slice(0, 512);
  const mimeType = normalizeMimeType(input.mimeType);
  return {
    name,
    mimeType,
    bytes: Buffer.from(input.bytes),
  };
}

function saveUploadedImageAtRoot(
  input: ManagedAssetUploadInput,
  assetsRootPath: string,
): ManagedImageSaveResult {
  const upload = normalizeAssetUploadInput(input);
  if (!isSupportedImageMimeType(upload.mimeType)) {
    throw new Error(`Unsupported image type: ${upload.mimeType || "unknown"}`);
  }

  if (upload.bytes.byteLength > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Image exceeds 10MB upload limit");
  }

  const extension = IMAGE_MIME_TO_EXTENSION[upload.mimeType] ?? "";
  const fileName = `${crypto.randomUUID()}${extension}`;
  writeAssetBytesAtRoot(assetsRootPath, fileName, upload.bytes);

  return {
    source: getAssetSource(fileName),
    fileName,
  };
}

function saveUploadedResourceAtRoot(
  input: ManagedAssetUploadInput,
  assetsRootPath: string,
): ManagedResourceSaveResult {
  const upload = normalizeAssetUploadInput(input);
  if (upload.bytes.byteLength > MAX_RESOURCE_UPLOAD_BYTES) {
    throw new Error("Resource exceeds 64MB upload limit");
  }

  const normalizedMimeType = normalizeMimeType(
    upload.mimeType === "application/octet-stream" && upload.name
      ? inferMimeTypeFromLocalPath(upload.name)
      : upload.mimeType,
  );
  const extension = resolveStoredExtension(upload.name, normalizedMimeType);
  const fileName = `${crypto.randomUUID()}${extension}`;
  writeAssetBytesAtRoot(assetsRootPath, fileName, upload.bytes);

  return {
    source: getAssetSource(fileName),
    fileName,
    name: upload.name || fileName,
    mimeType: normalizedMimeType,
    bytes: upload.bytes.byteLength,
  };
}

function materializeLocalResourceAtRoot(
  localPath: string,
  assetsRootPath: string,
): ManagedResourceSaveResult {
  const trimmedLocalPath = localPath.trim();
  if (!path.isAbsolute(trimmedLocalPath)) {
    throw new Error("Local resource path must be absolute");
  }
  const normalizedLocalPath = path.resolve(trimmedLocalPath);
  if (!fs.existsSync(normalizedLocalPath)) {
    throw new Error("Local resource not found");
  }

  const stats = fs.statSync(normalizedLocalPath);
  if (stats.isDirectory()) {
    const manifest = buildFolderManifest(normalizedLocalPath);
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    const fileName = `${crypto.randomUUID()}.json`;
    writeAssetBytesAtRoot(assetsRootPath, fileName, manifestBytes);
    return {
      source: getAssetSource(fileName),
      fileName,
      name: path.basename(normalizedLocalPath),
      mimeType: "application/json",
      bytes: manifestBytes.byteLength,
    };
  }

  if (stats.size > MAX_RESOURCE_UPLOAD_BYTES) {
    throw new Error("Resource exceeds 64MB upload limit");
  }

  const mimeType = inferMimeTypeFromLocalPath(normalizedLocalPath);
  const extension = resolveStoredExtension(normalizedLocalPath, mimeType);
  const fileName = `${crypto.randomUUID()}${extension}`;
  const fileBytes = fs.readFileSync(normalizedLocalPath);
  writeAssetBytesAtRoot(assetsRootPath, fileName, fileBytes);

  return {
    source: getAssetSource(fileName),
    fileName,
    name: path.basename(normalizedLocalPath),
    mimeType,
    bytes: stats.size,
  };
}

function readAssetFileBounded(assetsRootPath: string, fileName: string, maxBytes: number): Buffer {
  const absolutePath = resolveAssetPathInRoot(assetsRootPath, fileName);
  if (!fs.existsSync(absolutePath)) {
    throw new Error("Asset not found");
  }
  const stats = fs.lstatSync(absolutePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error("Managed asset must be a regular file");
  }

  const descriptor = fs.openSync(absolutePath, "r");
  try {
    const bytes = Buffer.alloc(Math.min(stats.size, maxBytes + 1));
    const bytesRead = fs.readSync(descriptor, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, bytesRead);
  } finally {
    fs.closeSync(descriptor);
  }
}

function parseManagedAssetFileName(source: string): string {
  const parsed = parseAssetSource(source);
  if (!parsed) throw new Error("Invalid managed asset source");
  return parsed.fileName;
}

function readManagedAssetImageAtRoot(
  source: string,
  assetsRootPath: string,
): ManagedAssetImageBytes {
  const fileName = parseManagedAssetFileName(source);
  const mimeType = getImageMimeTypeForAssetFile(fileName);
  if (!mimeType) throw new Error("Managed asset is not a supported image");

  const bytes = readAssetFileBounded(assetsRootPath, fileName, MAX_MANAGED_IMAGE_BYTES);
  if (bytes.byteLength > MAX_MANAGED_IMAGE_BYTES) {
    throw new Error("Image exceeds 10MB upload limit");
  }
  return { mimeType, bytes };
}

function isManagedFolderManifest(value: unknown): value is ManagedFolderManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const manifest = value as Partial<ManagedFolderManifest>;
  if (
    typeof manifest.rootName !== "string" ||
    typeof manifest.generatedAt !== "string" ||
    typeof manifest.maxEntries !== "number" ||
    typeof manifest.maxDepth !== "number" ||
    typeof manifest.truncated !== "boolean" ||
    !Array.isArray(manifest.entries) ||
    manifest.entries.length > 100
  ) {
    return false;
  }
  return manifest.entries.every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const candidate = entry as Partial<ManagedFolderManifestEntry>;
    return (
      typeof candidate.path === "string" &&
      candidate.path.length <= 4096 &&
      (candidate.kind === "file" || candidate.kind === "folder") &&
      (candidate.bytes === undefined ||
        (typeof candidate.bytes === "number" &&
          Number.isFinite(candidate.bytes) &&
          candidate.bytes >= 0))
    );
  });
}

function isTextPreviewMimeType(mimeType: string): boolean {
  return (
    mimeType.startsWith("text/") ||
    mimeType === "application/json" ||
    mimeType === "application/sql" ||
    mimeType === "application/toml" ||
    mimeType === "application/xml" ||
    mimeType === "application/yaml"
  );
}

function readManagedAssetPreviewAtRoot(
  input: ManagedAssetPreviewInput,
  assetsRootPath: string,
): ManagedAssetPreview {
  const fileName = parseManagedAssetFileName(input.source);
  const mimeType = getMimeTypeForAssetFile(fileName);
  if (input.kind === "text") {
    if (!isTextPreviewMimeType(mimeType)) {
      throw new Error("Managed asset is not text-previewable");
    }
    const bytes = readAssetFileBounded(assetsRootPath, fileName, MAX_MANAGED_PREVIEW_BYTES);
    const text = bytes.toString("utf8");
    const preview = createManagedTextPreview(text);
    return {
      ...preview,
      truncated: preview.truncated || bytes.byteLength > MAX_MANAGED_PREVIEW_BYTES,
    };
  }

  if (mimeType !== "application/json") {
    throw new Error("Managed folder manifest must be JSON");
  }
  const bytes = readAssetFileBounded(assetsRootPath, fileName, MAX_MANAGED_PREVIEW_BYTES);
  if (bytes.byteLength > MAX_MANAGED_PREVIEW_BYTES) {
    throw new Error("Managed folder manifest exceeds preview limit");
  }
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (!isManagedFolderManifest(parsed)) {
    throw new Error("Managed folder manifest is invalid");
  }
  return { kind: "folder", manifest: parsed };
}

export interface TemporaryAssetsService {
  readonly rootPath: string;
  readonly resolveAssetPath: (fileName: string) => string;
  readonly materializeCanvasImage: (
    input: ManagedAssetUploadInput,
  ) => ManagedCanvasImageMaterializationResult;
  readonly saveUploadedImage: (input: ManagedAssetUploadInput) => ManagedImageSaveResult;
  readonly saveUploadedResource: (input: ManagedAssetUploadInput) => ManagedResourceSaveResult;
  readonly materializeLocalResource: (localPath: string) => ManagedResourceSaveResult;
  readonly readManagedAssetImage: (source: string) => ManagedAssetImageBytes;
  readonly readManagedAssetPreview: (input: ManagedAssetPreviewInput) => ManagedAssetPreview;
}

/** Binds all managed-asset operations to one immutable Profile root. */
export function makeTemporaryAssets(input: {
  readonly assetsRootPath: string;
}): TemporaryAssetsService {
  const rootPath = path.resolve(input.assetsRootPath);
  const service: TemporaryAssetsService = {
    rootPath,
    resolveAssetPath: (fileName) => resolveAssetPathInRoot(rootPath, fileName),
    materializeCanvasImage: (upload) => materializeCanvasImageAtRoot(upload, rootPath),
    saveUploadedImage: (upload) => saveUploadedImageAtRoot(upload, rootPath),
    saveUploadedResource: (upload) => saveUploadedResourceAtRoot(upload, rootPath),
    materializeLocalResource: (localPath) => materializeLocalResourceAtRoot(localPath, rootPath),
    readManagedAssetImage: (source) => readManagedAssetImageAtRoot(source, rootPath),
    readManagedAssetPreview: (preview) => readManagedAssetPreviewAtRoot(preview, rootPath),
  };
  return Object.freeze(service);
}
