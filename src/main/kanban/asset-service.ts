import * as fs from "fs";
import * as path from "path";

import { getKanbanDir } from "./config";
import {
  getAssetSource,
  isSafeAssetFileName,
} from "../../shared/assets";

export const MAX_IMAGE_UPLOAD_BYTES = 10 * 1024 * 1024;

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
  return EXTENSION_TO_IMAGE_MIME[extension] ?? "application/octet-stream";
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
