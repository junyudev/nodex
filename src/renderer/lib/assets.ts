import {
  MAX_MANAGED_IMAGE_BYTES,
  MAX_MANAGED_RESOURCE_BYTES,
  type ManagedCanvasImageMaterializationResult,
  type ManagedAssetPreview,
  type ManagedAssetPreviewInput,
  type ManagedResourceSaveResult,
} from "../../shared/managed-assets";
import { parseAssetSource } from "../../shared/assets";
import { buildAppFilesystemUrl, isAbsoluteAppFilesystemPath } from "../../shared/app-protocol";
import { defineRendererCommand, invokePlainCommand, invokeRendererQuery } from "./renderer-command";

export interface UploadedResourceAssetResponse {
  source: string;
  name: string;
  mimeType: string;
  bytes: number;
}

export type ManagedAssetPathResolver = (source: string) => string | null;

const managedAssetDisplayUrlCache = new Map<string, string>();

const saveImageAssetCommand = defineRendererCommand({
  key: "asset.image.save",
  channel: "asset:image:save",
  authority: "main",
  owner: "ManagedAssets",
  protocol: { kind: "returned_value" },
});

const materializeCanvasImageCommand = defineRendererCommand({
  key: "asset.canvas_image.materialize",
  channel: "asset:canvas-image:materialize",
  authority: "main",
  owner: "ManagedAssets",
  protocol: { kind: "returned_value" },
});

const saveResourceAssetCommand = defineRendererCommand({
  key: "asset.resource.save",
  channel: "asset:resource:save",
  authority: "main",
  owner: "ManagedAssets",
  protocol: { kind: "returned_value" },
});

const materializeResourceAssetCommand = defineRendererCommand({
  key: "asset.resource.materialize",
  channel: "asset:resource:materialize",
  authority: "main",
  owner: "ManagedAssets",
  protocol: { kind: "returned_value" },
});

function resolveManagedAssetPathFromPreload(source: string): string | null {
  if (typeof window === "undefined") return null;
  return window.api?.resolveManagedAssetPath?.(source) ?? null;
}

export function clearManagedAssetDisplayUrlCache(): void {
  managedAssetDisplayUrlCache.clear();
}

export function resolveAssetSourceToDisplayUrl(
  source: string,
  resolveManagedAssetPath: ManagedAssetPathResolver = resolveManagedAssetPathFromPreload,
): string | null {
  if (!parseAssetSource(source)) return source;

  const cached = managedAssetDisplayUrlCache.get(source);
  if (cached) return cached;

  const localPath = resolveManagedAssetPath(source)?.trim() ?? "";
  if (!localPath || !isAbsoluteAppFilesystemPath(localPath)) return null;

  const displayUrl = buildAppFilesystemUrl(localPath);
  managedAssetDisplayUrlCache.set(source, displayUrl);
  return displayUrl;
}

function fileToUploadInput(file: File, bytes: Uint8Array) {
  return {
    name: file.name,
    mimeType: file.type,
    bytes,
  };
}

export async function uploadImageAsset(file: File): Promise<string> {
  if (file.size > MAX_MANAGED_IMAGE_BYTES) {
    throw new Error("Image exceeds 10MB upload limit");
  }
  const result = await invokePlainCommand(
    saveImageAssetCommand,
    fileToUploadInput(file, new Uint8Array(await file.arrayBuffer())),
  );
  return result.source;
}

export async function materializeCanvasImageAsset(
  file: File,
): Promise<ManagedCanvasImageMaterializationResult> {
  if (file.size > MAX_MANAGED_IMAGE_BYTES) {
    throw new Error("Image exceeds 10MB upload limit");
  }
  return await invokePlainCommand(
    materializeCanvasImageCommand,
    fileToUploadInput(file, new Uint8Array(await file.arrayBuffer())),
  );
}

function toUploadedResourceAssetResponse(
  result: ManagedResourceSaveResult,
): UploadedResourceAssetResponse {
  return {
    source: result.source,
    name: result.name,
    mimeType: result.mimeType,
    bytes: result.bytes,
  };
}

export async function uploadResourceAsset(file: File): Promise<UploadedResourceAssetResponse> {
  if (file.size > MAX_MANAGED_RESOURCE_BYTES) {
    throw new Error("Resource exceeds 64MB upload limit");
  }
  return toUploadedResourceAssetResponse(
    await invokePlainCommand(
      saveResourceAssetCommand,
      fileToUploadInput(file, new Uint8Array(await file.arrayBuffer())),
    ),
  );
}

export async function materializeLocalResourceAsset(
  localPath: string,
): Promise<UploadedResourceAssetResponse> {
  return toUploadedResourceAssetResponse(
    await invokePlainCommand(materializeResourceAssetCommand, localPath),
  );
}

export async function readManagedAssetPreview(
  input: ManagedAssetPreviewInput,
): Promise<ManagedAssetPreview> {
  return await invokeRendererQuery("asset:preview:read", input);
}

export async function resolveManagedAssetPath(source: string): Promise<string | null> {
  const resolved = await invokeRendererQuery("asset:resolve-path", source);
  return resolved?.trim() || null;
}

function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Asset read failed"));
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Asset reader returned a non-string result"));
    };
    reader.readAsDataURL(blob);
  });
}

export async function readManagedImageDataUrl(source: string): Promise<string> {
  const result = await invokeRendererQuery("asset:image:read", source);
  return await readBlobAsDataUrl(
    new Blob([new Uint8Array(result.bytes)], { type: result.mimeType }),
  );
}

export async function readManagedImageByteLength(source: string): Promise<number> {
  const result = await invokeRendererQuery("asset:image:read", source);
  return result.bytes.byteLength;
}
