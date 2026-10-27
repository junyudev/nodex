import { queryOptions, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { DEFAULT_CODEX_HOST_ID } from "../../shared/codex-host";
import type { CodexConversationImageAssetResolveResult } from "../../shared/types";
import { invokeRendererQuery as invoke } from "./renderer-command";
import { queryKeys } from "./query-keys";

export const CODEX_IMAGE_ASSET_STALE_TIME_MS = 5 * 60_000;

export interface CodexConversationImageAssetData {
  blob: Blob;
  dataUrl: string;
  objectUrl: string | null;
}

const OBJECT_URL_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/vnd.microsoft.icon",
  "image/webp",
  "image/x-icon",
  "image/x-png",
]);

export class CodexConversationImageAssetError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "CodexConversationImageAssetError";
  }
}

export function isCodexImageAssetPointer(source: string): boolean {
  return /^(?:file-service|sediment):\/\//u.test(source.trim());
}

export function parseAbsoluteImagePath(source: string): string | null {
  const trimmed = source.trim();
  if (trimmed.length === 0) return null;
  if (/^(?:data:|https?:|file:|app:|blob:|nodex:|vscode-remote:)/iu.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("/")) return trimmed;
  if (/^[a-zA-Z]:[\\/]/u.test(trimmed)) return trimmed.replace(/\\/gu, "/");
  if (/^\\\\[^\\]+\\[^\\]+/u.test(trimmed)) return trimmed.replace(/\\/gu, "/");
  return null;
}

function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function materializeAsset(
  result: CodexConversationImageAssetResolveResult,
): Omit<CodexConversationImageAssetData, "objectUrl"> {
  if (!result.ok) throw new CodexConversationImageAssetError(result.message, result.status);

  const mimeType = result.mimeType?.trim() || "image/png";
  return {
    blob: new Blob([decodeBase64(result.dataBase64)], { type: mimeType }),
    dataUrl: `data:${mimeType};base64,${result.dataBase64}`,
  };
}

/** The cached image owns its object URL independently of its mounted consumers. */
function createCachedObjectUrl(
  client: QueryClient,
  queryKey: QueryKey,
  blob: Blob,
  signal: AbortSignal,
): string | null {
  if (!OBJECT_URL_IMAGE_MIME_TYPES.has(blob.type) || typeof URL.createObjectURL !== "function") {
    return null;
  }

  const objectUrl = URL.createObjectURL(blob);
  const cache = client.getQueryCache();
  const query = cache.find({ queryKey, exact: true });
  const unsubscribe = cache.subscribe((event) => {
    if (event.query !== query) return;
    const data = client.getQueryData<CodexConversationImageAssetData>(queryKey);
    if (
      event.type === "removed" ||
      (event.type === "updated" &&
        event.query.state.fetchStatus === "idle" &&
        data?.objectUrl !== objectUrl)
    ) {
      release();
    }
  });
  const release = () => {
    unsubscribe();
    signal.removeEventListener("abort", release);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };
  signal.addEventListener("abort", release, { once: true });
  return objectUrl;
}

export function shouldRetryCodexImageAssetQuery(failureCount: number, error: Error): boolean {
  if (failureCount >= 3) return false;
  if (!(error instanceof CodexConversationImageAssetError) || error.status === null) return true;
  return (
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    (error.status >= 500 && error.status <= 599)
  );
}

export function codexConversationImageAssetQueryOptions(pointer: string) {
  return queryOptions({
    queryKey: queryKeys.codexConversationImageAssets.resolve(pointer),
    queryFn: async ({ client, queryKey, signal }) => {
      const asset = materializeAsset(
        await invoke("codex:conversation-image-asset:resolve", {
          hostId: DEFAULT_CODEX_HOST_ID,
          pointer,
        }),
      );
      signal.throwIfAborted();
      return {
        ...asset,
        objectUrl: createCachedObjectUrl(client, queryKey, asset.blob, signal),
      };
    },
    staleTime: CODEX_IMAGE_ASSET_STALE_TIME_MS,
    gcTime: CODEX_IMAGE_ASSET_STALE_TIME_MS,
    retry: shouldRetryCodexImageAssetQuery,
    retryDelay: (attemptIndex) => Math.min(1_000 * 2 ** attemptIndex, 4_000),
  });
}
