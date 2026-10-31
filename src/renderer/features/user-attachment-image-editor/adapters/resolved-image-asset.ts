import { buildAppFilesystemUrl } from "../../../../shared/app-protocol";
import { sanitizeNativeSaveFileName } from "../../../../shared/native-file-save";
import { parseAssetSource } from "../../../../shared/assets";
import { parseLocalImagePath, resolveAssetSourceToDisplayUrl } from "../../../lib/assets";
import { readNativeResource } from "../../../lib/native-resource-operations";
import { saveWorkspaceFileData } from "../../../lib/workspace-file-operations";
import { isCodexImageAssetPointer } from "../../../lib/codex-conversation-image-assets";

export type ImageAssetSourceKind =
  | "data"
  | "local"
  | "managed"
  | "pointer"
  | "remote"
  | "direct"
  | "invalid";

export interface ClassifiedImageAssetSource {
  kind: ImageAssetSourceKind;
  localPath: string | null;
  source: string;
}

export interface ImageAssetMaterializationDependencies {
  fetchSource?: (source: string) => Promise<string>;
  readLocalFile?: (path: string) => Promise<string>;
  readManagedAsset?: (source: string) => Promise<string>;
  resolvePointer?: (pointer: string) => Promise<string>;
}

export class ImageAssetResolutionError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "ImageAssetResolutionError";
  }
}

export function buildImageDataUrl(dataBase64: string, mimeType: string | null | undefined): string {
  return `data:${mimeType?.trim() || "application/octet-stream"};base64,${dataBase64}`;
}

export function classifyImageAssetSource(rawSource: string): ClassifiedImageAssetSource {
  const source = rawSource.trim();
  if (!source) return { kind: "invalid", localPath: null, source };
  if (/^data:image\//iu.test(source)) return { kind: "data", localPath: null, source };
  if (isCodexImageAssetPointer(source)) {
    return { kind: "pointer", localPath: null, source };
  }
  if (parseAssetSource(source)) {
    return { kind: "managed", localPath: null, source };
  }

  const localPath = parseLocalImagePath(source);
  if (localPath) return { kind: "local", localPath, source };
  if (/^https?:\/\//iu.test(source)) return { kind: "remote", localPath: null, source };
  if (/^(?:app:|blob:|nodex-display:|vscode-remote:)/iu.test(source)) {
    return { kind: "direct", localPath: null, source };
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(source)) {
    return { kind: "invalid", localPath: null, source };
  }
  return { kind: "direct", localPath: null, source };
}

export function resolveImageDisplaySource(
  rawSource: string,
  options: {
    allowLocalPath: boolean;
    resolveManagedAssetPath?: (source: string) => string | null;
  },
): string | null {
  const classified = classifyImageAssetSource(rawSource);
  switch (classified.kind) {
    case "data":
    case "remote":
    case "direct":
      return classified.source;
    case "managed":
      return resolveAssetSourceToDisplayUrl(classified.source, options.resolveManagedAssetPath);
    case "local":
      return options.allowLocalPath && classified.localPath
        ? buildAppFilesystemUrl(classified.localPath)
        : null;
    case "pointer":
    case "invalid":
      return null;
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return globalThis.btoa(binary);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return buildImageDataUrl(bytesToBase64(bytes), blob.type || null);
}

export async function fetchImageSourceAsDataUrl(
  source: string,
  fetchSource?: typeof fetch,
  options: {
    readonly signal?: AbortSignal;
    readonly image?: HTMLImageElement;
    readonly isCurrent?: () => boolean;
  } = {},
): Promise<string> {
  const assertCurrent = () => {
    options.signal?.throwIfAborted();
    if (options.isCurrent?.() === false)
      throw new DOMException("Image source retired", "AbortError");
  };
  assertCurrent();
  if (source.startsWith("data:")) return source;
  if (!fetchSource && /^https?:/iu.test(source)) {
    const data = await readNativeResource(source);
    assertCurrent();
    return buildImageDataUrl(data.contentsBase64, data.mimeType);
  }
  try {
    const response = await (fetchSource ?? globalThis.fetch)(source, { signal: options.signal });
    if (!response.ok)
      throw new ImageAssetResolutionError(
        `Image request failed with status ${response.status}`,
        response.status,
      );
    assertCurrent();
    const blob = await response.blob();
    assertCurrent();
    return await blobToDataUrl(blob);
  } catch (error) {
    assertCurrent();
    if (!source.startsWith("blob:") || !options.image) throw error;
    const canvas = document.createElement("canvas");
    canvas.width = options.image.naturalWidth;
    canvas.height = options.image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw error;
    context.drawImage(options.image, 0, 0);
    return canvas.toDataURL("image/png");
  }
}

export async function materializeImageSourceAsDataUrl(
  rawSource: string,
  dependencies: ImageAssetMaterializationDependencies = {},
): Promise<string> {
  const source = classifyImageAssetSource(rawSource);
  switch (source.kind) {
    case "data":
      return source.source;
    case "local":
      if (!source.localPath || !dependencies.readLocalFile) {
        throw new ImageAssetResolutionError("Local image data is unavailable");
      }
      return await dependencies.readLocalFile(source.localPath);
    case "managed":
      if (!dependencies.readManagedAsset) {
        throw new ImageAssetResolutionError("Managed image data is unavailable");
      }
      return await dependencies.readManagedAsset(source.source);
    case "pointer":
      if (!dependencies.resolvePointer) {
        throw new ImageAssetResolutionError("Image pointer resolution is unavailable");
      }
      return await dependencies.resolvePointer(source.source);
    case "remote":
    case "direct":
      return await (dependencies.fetchSource?.(source.source) ??
        fetchImageSourceAsDataUrl(source.source));
    case "invalid":
      throw new ImageAssetResolutionError("Image source is empty or unsupported");
  }
}

function parseImageDataUrl(dataUrl: string) {
  const commaIndex = dataUrl.indexOf(",");
  if (!dataUrl.startsWith("data:") || commaIndex < 5) {
    throw new ImageAssetResolutionError("Invalid image data URL");
  }

  const metadata = dataUrl.slice(5, commaIndex);
  const payload = dataUrl.slice(commaIndex + 1);
  const mimeType = metadata.match(/^[^;]+/u)?.[0] || "application/octet-stream";
  try {
    if (/;base64(?:;|$)/iu.test(metadata)) {
      const binary = globalThis.atob(payload);
      return { bytes: Uint8Array.from(binary, (character) => character.charCodeAt(0)), mimeType };
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mimeType };
  } catch (error) {
    throw new ImageAssetResolutionError(
      error instanceof Error ? error.message : "Invalid image data URL",
    );
  }
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const { bytes, mimeType } = parseImageDataUrl(dataUrl);
  return new Blob([bytes], { type: mimeType });
}

function inferImageExtension(source: string): string | null {
  const dataMime = /^data:image\/([^;,]+)/iu.exec(source)?.[1];
  const pathExtension = source.split(/[?#]/u, 1)[0]?.match(/\.([a-z0-9]+)$/iu)?.[1];
  const extension = (dataMime ?? pathExtension)?.toLowerCase();
  if (!extension) return null;
  if (extension === "jpeg") return "jpg";
  if (extension === "svg+xml") return "svg";
  return extension.replace(/[^a-z0-9]/gu, "") || null;
}

export function sanitizeImageDownloadFilename(filename: string): string {
  return sanitizeNativeSaveFileName(filename);
}

export function createImageDownloadFilename(
  source: string,
  suggestedFilename?: string,
  now: Date = new Date(),
): string {
  if (suggestedFilename?.trim()) return sanitizeImageDownloadFilename(suggestedFilename);
  const extension = inferImageExtension(source) ?? "png";
  const formattedDate = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(now);
  return sanitizeImageDownloadFilename(`Nodex Image ${formattedDate}.${extension}`);
}

export async function downloadImageDataUrl(
  dataUrl: string,
  filename: string,
  environment: {
    document?: Document;
    url?: Pick<typeof URL, "createObjectURL" | "revokeObjectURL">;
    setTimeout?: typeof window.setTimeout;
  } = {},
): Promise<void> {
  if (
    Object.keys(environment).length === 0 &&
    typeof window !== "undefined" &&
    window.electronBridge
  ) {
    const { bytes } = parseImageDataUrl(dataUrl);
    await saveWorkspaceFileData({ fileName: filename, contentsBase64: bytesToBase64(bytes) });
    return;
  }
  const documentRef = environment.document ?? globalThis.document;
  const urlApi = environment.url ?? globalThis.URL;
  const schedule = environment.setTimeout ?? globalThis.setTimeout;
  if (!documentRef || typeof urlApi?.createObjectURL !== "function") {
    throw new ImageAssetResolutionError("Image download is unavailable");
  }

  const objectUrl = urlApi.createObjectURL(dataUrlToBlob(dataUrl));
  const anchor = documentRef.createElement("a");
  anchor.href = objectUrl;
  anchor.download = sanitizeImageDownloadFilename(filename);
  anchor.style.display = "none";
  documentRef.body.append(anchor);
  anchor.click();
  anchor.remove();
  schedule(() => urlApi.revokeObjectURL(objectUrl), 0);
}
