import { parseAssetSource } from "../../../../../shared/assets";
import { useQuery } from "@tanstack/react-query";
import { parseAgentHistoryImageSource } from "../../../../../shared/agent-history-images";
import { parseAgentRuntimeAttachmentSource } from "../../../../../shared/agent-runtime-attachments";
import { parseAbsoluteImagePath } from "@/lib/codex-conversation-image-assets";
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
  const { hostId, conversationId, resolveHistoryImage, resolveRuntimeAttachment } =
    useConversationImageAssetContext();
  const reference = parseAgentHistoryImageSource(rawSource);
  const runtimeReference = parseAgentRuntimeAttachmentSource(rawSource);
  // The path query resolves the exact recorded item only when its image leaf is mounted.
  // eslint-disable-next-line @tanstack/query/exhaustive-deps
  const runtime = useQuery({
    queryKey: ["runtimeAttachmentPath", hostId, conversationId, rawSource],
    enabled: runtimeReference !== null && resolveRuntimeAttachment !== undefined,
    queryFn: async () => {
      if (!runtimeReference || !resolveRuntimeAttachment) throw new Error("Image unavailable");
      const path = await resolveRuntimeAttachment(runtimeReference);
      if (
        !parseAbsoluteImagePath(path) &&
        !/^data:image\/(?:png|jpeg|gif|webp);base64,/iu.test(path)
      )
        throw new Error("Image unavailable");
      return path;
    },
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
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
  const asset = useResolvedImageAsset(
    runtimeReference ? (runtime.data ?? "") : reference ? (native.data ?? "") : rawSource,
    {
      hostId,
      allowLocalPath: true,
      materialize: options.shouldLoadFileDataUrl,
    },
  );

  return {
    dataUrl: asset.dataUrl,
    downloadSrc: asset.downloadSrc,
    isError:
      asset.isError ||
      (reference !== null && (native.isError || !resolveHistoryImage)) ||
      (runtimeReference !== null && (runtime.isError || !resolveRuntimeAttachment)),
    isLoading:
      asset.isLoading ||
      (reference !== null && native.isFetching) ||
      (runtimeReference !== null && runtime.isFetching),
    previewSrc: asset.previewSrc,
    refetch: runtimeReference
      ? async () => {
          await runtime.refetch();
        }
      : reference
        ? async () => {
            await native.refetch();
          }
        : asset.refetch,
  };
}
