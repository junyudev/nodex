import { parseAssetSource } from "../../../../../shared/assets";
import { useQuery } from "@tanstack/react-query";
import { parseAgentHistoryImageSource } from "../../../../../shared/agent-history-images";
import {
  useResolvedImageAsset,
  type ResolvedImageAsset,
} from "@/features/user-attachment-image-editor";
import { useConversationImageAssetContext } from "../conversation-image-asset-context";

export type ConversationImageAssetResolution = Omit<
  ResolvedImageAsset,
  "error" | "localPath" | "materialize"
>;

export function useConversationImageAsset(
  rawSource: string,
  options: { shouldLoadFileDataUrl: boolean },
): ConversationImageAssetResolution {
  const { hostId, conversationId, resolveHistoryImage } = useConversationImageAssetContext();
  const reference = parseAgentHistoryImageSource(rawSource);
  // The owner resolver is fenced by the session/message/index encoded in this source.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const native = useQuery({
    queryKey: ["nativeHistoryImage", hostId, conversationId, rawSource],
    enabled: reference !== null && resolveHistoryImage !== undefined,
    queryFn: async () => {
      if (!reference || !resolveHistoryImage) throw new Error("Image unavailable");
      const source = await resolveHistoryImage(reference);
      if (!parseAssetSource(source)) throw new Error("Image unavailable");
      return source;
    },
    retry: false,
    staleTime: Infinity,
  });
  const asset = useResolvedImageAsset(reference ? (native.data ?? "") : rawSource, {
    hostId,
    allowLocalPath: true,
    materialize: options.shouldLoadFileDataUrl,
  });

  return {
    dataUrl: asset.dataUrl,
    downloadSrc: asset.downloadSrc,
    isError: asset.isError || (reference !== null && (native.isError || !resolveHistoryImage)),
    isLoading: asset.isLoading || (reference !== null && native.isFetching),
    previewSrc: asset.previewSrc,
    refetch: reference
      ? async () => {
          await native.refetch();
        }
      : asset.refetch,
  };
}
