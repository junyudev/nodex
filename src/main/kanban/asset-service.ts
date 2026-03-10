import * as fs from "fs";
import * as path from "path";

import { getKanbanDir } from "./config";
import {
  getAssetSource,
  isSafeAssetFileName,
} from "../../shared/assets";

export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MAX_RESOURCE_UPLOAD_BYTES = 64 * 1024 * 1024;

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

interface FolderManifestEntry {
  path: string;
  kind: "file" | "folder";
  bytes?: number;
}

interface FolderManifest {
  rootName: string;
  generatedAt: string;
  maxEntries: number;
  maxDepth: number;
  truncated: boolean;
  entries: FolderManifestEntry[];
}

interface CachedAssetPaths {
  pathPrefix: string;
  rootPath: string;
}

let cachedAssetPaths: CachedAssetPaths | null = null;

function getCachedAssetPaths(): CachedAssetPaths {
  if (cachedAssetPaths) {
    return cachedAssetPaths;
  }

  const rootPath = path.resolve(path.join(getKanbanDir(), "assets"));
  cachedAssetPaths = {
    pathPrefix: `${rootPath}${path.sep}`,
    rootPath,
  };
  return cachedAssetPaths;
}

export function resetAssetPathCacheForTests(): void {
  cachedAssetPaths = null;
}

export function isSupportedImageMimeType(mimeType: string): boolean {
  return mimeType in IMAGE_MIME_TO_EXTENSION;
}

export function getAssetsRootPath(): string {
  return getCachedAssetPaths().rootPath;
}

export function getAssetsPathPrefix(): string {
  return getCachedAssetPaths().pathPrefix;
}

function assertAssetPathInsideRoot(targetPath: string): void {
  const { pathPrefix, rootPath } = getCachedAssetPaths();
  if (targetPath === rootPath || targetPath.startsWith(pathPrefix)) {
    return;
  }

  throw new Error("Invalid asset path");
}

function resolveFlatAssetPath(fileName: string): string {
  if (!isSafeAssetFileName(fileName)) {
    throw new Error("Invalid file name");
  }

  const resolvedPath = path.resolve(getAssetsRootPath(), fileName);
  assertAssetPathInsideRoot(resolvedPath);
  return resolvedPath;
}

export function resolveAssetPath(fileName: string): string {
  return resolveFlatAssetPath(fileName);
}

export function getMimeTypeForAssetFile(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return EXTENSION_TO_IMAGE_MIME[extension]
    ?? EXTENSION_TO_TEXT_MIME[extension]
    ?? "application/octet-stream";
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

  const textExtension = Object.entries(EXTENSION_TO_TEXT_MIME)
    .find(([, candidateMimeType]) => candidateMimeType === mimeType)?.[0];
  return textExtension ?? "";
}

function writeAssetBytes(fileName: string, bytes: Buffer): string {
  const absolutePath = resolveFlatAssetPath(fileName);
  fs.mkdirSync(getAssetsRootPath(), { recursive: true });
  fs.writeFileSync(absolutePath, bytes);
  return absolutePath;
}

function inferMimeTypeFromLocalPath(localPath: string): string {
  const extension = path.extname(localPath).toLowerCase();
  return EXTENSION_TO_IMAGE_MIME[extension]
    ?? EXTENSION_TO_TEXT_MIME[extension]
    ?? "application/octet-stream";
}

function normalizeMimeType(mimeType: string): string {
  const normalized = mimeType.trim().split(";")[0]?.trim();
  return normalized && normalized.length > 0
    ? normalized
    : "application/octet-stream";
}

function buildFolderManifest(
  rootPath: string,
  maxEntries = 100,
  maxDepth = 3,
): FolderManifest {
  const entries: FolderManifestEntry[] = [];
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

    const children = fs.readdirSync(currentPath, { withFileTypes: true })
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

export async function saveUploadedImage(file: File): Promise<{ source: string; fileName: string }> {
  if (!isSupportedImageMimeType(file.type)) {
    throw new Error(`Unsupported image type: ${file.type || "unknown"}`);
  }

  if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
    throw new Error("Image exceeds 10MB upload limit");
  }

  const extension = IMAGE_MIME_TO_EXTENSION[file.type] ?? "";
  const fileName = `${crypto.randomUUID()}${extension}`;
  const absolutePath = resolveFlatAssetPath(fileName);

  fs.mkdirSync(getAssetsRootPath(), { recursive: true });

  const fileBytes = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(absolutePath, fileBytes);

  return {
    source: getAssetSource(fileName),
    fileName,
  };
}

export async function saveUploadedResource(
  file: File,
): Promise<{ source: string; fileName: string; name: string; mimeType: string; bytes: number }> {
  if (file.size > MAX_RESOURCE_UPLOAD_BYTES) {
    throw new Error("Resource exceeds 64MB upload limit");
  }

  const normalizedMimeType = normalizeMimeType(file.type || inferMimeTypeFromLocalPath(file.name));
  const extension = resolveStoredExtension(file.name, normalizedMimeType);
  const fileName = `${crypto.randomUUID()}${extension}`;
  const fileBytes = Buffer.from(await file.arrayBuffer());
  writeAssetBytes(fileName, fileBytes);

  return {
    source: getAssetSource(fileName),
    fileName,
    name: file.name || fileName,
    mimeType: normalizedMimeType,
    bytes: fileBytes.byteLength,
  };
}

export function materializeLocalResource(
  localPath: string,
): { source: string; fileName: string; name: string; mimeType: string; bytes: number } {
  const normalizedLocalPath = path.resolve(localPath.trim());
  if (!path.isAbsolute(normalizedLocalPath)) {
    throw new Error("Local resource path must be absolute");
  }
  if (!fs.existsSync(normalizedLocalPath)) {
    throw new Error("Local resource not found");
  }

  const stats = fs.statSync(normalizedLocalPath);
  if (stats.isDirectory()) {
    const manifest = buildFolderManifest(normalizedLocalPath);
    const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2), "utf8");
    const fileName = `${crypto.randomUUID()}.json`;
    writeAssetBytes(fileName, manifestBytes);
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
  writeAssetBytes(fileName, fileBytes);

  return {
    source: getAssetSource(fileName),
    fileName,
    name: path.basename(normalizedLocalPath),
    mimeType,
    bytes: stats.size,
  };
}

export function readAssetFile(fileName: string): { bytes: Buffer; mimeType: string } {
  const absolutePath = resolveFlatAssetPath(fileName);

  if (!fs.existsSync(absolutePath)) {
    throw new Error("Asset not found");
  }

  const bytes = fs.readFileSync(absolutePath);

  return {
    bytes,
    mimeType: getMimeTypeForAssetFile(fileName),
  };
}
