import { useQuery } from "@tanstack/react-query";
import { DEFAULT_CODEX_HOST_ID } from "../../../../shared/codex-host";
import { readManagedImageDataUrl } from "../../../lib/assets";
import { codexConversationImageAssetQueryOptions } from "../../../lib/codex-conversation-image-assets";
import { workspaceFileBinaryQueryOptions } from "../../../lib/query-options";
import {
  buildImageDataUrl,
  classifyImageAssetSource,
  fetchImageSourceAsDataUrl,
  resolveImageDisplaySource,
} from "./resolved-image-asset";

export interface ResolvedImageAsset {
  previewSrc: string | null;
  downloadSrc: string | null;
  dataUrl: string | null;
  localPath: string | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch(): Promise<void>;
  materialize(): Promise<string>;
}

export interface UseResolvedImageAssetOptions {
  hostId?: string;
  /**
   * Local-path reads stay opt-in. Conversation transcripts use this only when
   * the trusted local host already owns the attachment; generic renderer URLs
   * never gain filesystem access by passing through this hook.
   */
  allowLocalPath?: boolean;
  materialize?: boolean;
}

function asError(error: unknown): Error | null {
  if (error instanceof Error) return error;
  if (error == null) return null;
  return new Error(String(error));
}

export function useResolvedImageAsset(
  rawSource: string,
  options: UseResolvedImageAssetOptions = {},
): ResolvedImageAsset {
  const source = classifyImageAssetSource(rawSource);
  const isLocalHost = (options.hostId ?? DEFAULT_CODEX_HOST_ID) === DEFAULT_CODEX_HOST_ID;
  const allowLocalPath = options.allowLocalPath === true && isLocalHost;
  const shouldMaterialize = options.materialize === true;

  const pointerQuery = useQuery({
    ...codexConversationImageAssetQueryOptions(source.kind === "pointer" ? source.source : ""),
    enabled: source.kind === "pointer" && isLocalHost,
  });
  const localFileQuery = useQuery({
    ...workspaceFileBinaryQueryOptions({
      hostId: "local",
      path: source.localPath ?? "",
    }),
    enabled: source.kind === "local" && allowLocalPath && shouldMaterialize,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const managedAssetQuery = useQuery({
    queryKey: ["imageAsset", "managed", source.source] as const,
    queryFn: () => readManagedImageDataUrl(source.source),
    enabled: source.kind === "managed" && shouldMaterialize,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const remoteAssetQuery = useQuery({
    queryKey: ["imageAsset", "remote", source.source] as const,
    queryFn: () => fetchImageSourceAsDataUrl(source.source),
    enabled: (source.kind === "remote" || source.kind === "direct") && shouldMaterialize,
    retry: false,
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const localDataUrl = localFileQuery.data?.contentsBase64
    ? buildImageDataUrl(localFileQuery.data.contentsBase64, localFileQuery.data.mimeType)
    : null;
  const directDataUrl = source.kind === "data" ? source.source : null;
  const dataUrl =
    directDataUrl ??
    pointerQuery.data?.dataUrl ??
    localDataUrl ??
    managedAssetQuery.data ??
    remoteAssetQuery.data ??
    null;
  const previewSrc =
    pointerQuery.data?.objectUrl ??
    pointerQuery.data?.dataUrl ??
    localDataUrl ??
    managedAssetQuery.data ??
    remoteAssetQuery.data ??
    resolveImageDisplaySource(source.source, { allowLocalPath });
  const downloadSrc =
    dataUrl ??
    (source.kind === "managed" ? source.source : null) ??
    (source.kind === "remote" || source.kind === "direct" ? source.source : previewSrc);
  const isUnsupportedPointer = source.kind === "pointer" && !isLocalHost;
  const isUnavailableLocal = source.kind === "local" && !allowLocalPath;
  const error = asError(
    pointerQuery.error ?? localFileQuery.error ?? managedAssetQuery.error ?? remoteAssetQuery.error,
  );
  const isLoading =
    (pointerQuery.isPending && pointerQuery.fetchStatus !== "idle") ||
    (localFileQuery.isPending && localFileQuery.fetchStatus !== "idle") ||
    (managedAssetQuery.isPending && managedAssetQuery.fetchStatus !== "idle") ||
    (remoteAssetQuery.isPending && remoteAssetQuery.fetchStatus !== "idle");

  const refetch = async () => {
    if (source.kind === "pointer" && isLocalHost) {
      await pointerQuery.refetch();
      return;
    }
    if (source.kind === "local" && allowLocalPath) {
      await localFileQuery.refetch();
      return;
    }
    if (source.kind === "managed") {
      await managedAssetQuery.refetch();
      return;
    }
    if (source.kind === "remote" || source.kind === "direct") {
      await remoteAssetQuery.refetch();
    }
  };

  const materialize = async (): Promise<string> => {
    if (dataUrl) return dataUrl;
    if (source.kind === "pointer" && isLocalHost) {
      const result = await pointerQuery.refetch();
      if (result.data?.dataUrl) return result.data.dataUrl;
      throw result.error ?? new Error("Image pointer could not be resolved");
    }
    if (source.kind === "local" && allowLocalPath) {
      const result = await localFileQuery.refetch();
      if (result.data?.contentsBase64) {
        return buildImageDataUrl(result.data.contentsBase64, result.data.mimeType);
      }
      throw result.error ?? new Error("Local image could not be read");
    }
    if (source.kind === "managed") {
      const result = await managedAssetQuery.refetch();
      if (result.data) return result.data;
      throw result.error ?? new Error("Managed image could not be read");
    }
    if (source.kind === "remote" || source.kind === "direct") {
      const result = await remoteAssetQuery.refetch();
      if (result.data) return result.data;
      throw result.error ?? new Error("Image could not be downloaded");
    }
    throw new Error("Image data is unavailable");
  };

  return {
    previewSrc,
    downloadSrc,
    dataUrl,
    localPath: allowLocalPath ? source.localPath : null,
    isLoading,
    isError:
      source.kind === "invalid" || isUnsupportedPointer || isUnavailableLocal || error !== null,
    error,
    refetch,
    materialize,
  };
}
