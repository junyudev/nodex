import type { QueryClient } from "@tanstack/react-query";
import { parseAgentHistoryImageSource } from "../../../shared/agent-history-images";
import { parseAgentRuntimeAttachmentSource } from "../../../shared/agent-runtime-attachments";
import { parseAssetSource } from "../../../shared/assets";
import { readManagedImageDataUrl } from "@/lib/assets";
import { queryKeys } from "@/lib/query-keys";
import { workspaceFileBinaryQueryOptions } from "@/lib/query-options";
import {
  buildImageDataUrl,
  classifyImageAssetSource,
} from "@/features/user-attachment-image-editor/adapters/resolved-image-asset";
import type { ConversationImageAssetContextValue } from "./view/conversation-image-asset-context";

export const CONVERSATION_IMAGE_GC_TIME_MS = 5 * 60_000;

const IMAGE_MIME_TYPES: Readonly<Record<string, string>> = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  avif: "image/avif",
};

export function requiresConversationImageRead(source: string): boolean {
  const kind = classifyImageAssetSource(source).kind;
  return (
    kind === "local" ||
    kind === "managed" ||
    parseAgentHistoryImageSource(source) !== null ||
    parseAgentRuntimeAttachmentSource(source) !== null
  );
}

/** The mounted image owns its resolved bytes; the shared read cache has no observers. */
export async function resolveConversationImageRead(
  queryClient: QueryClient,
  rawSource: string,
  context: ConversationImageAssetContextValue,
  force = false,
): Promise<string> {
  let source = rawSource;
  const runtime = parseAgentRuntimeAttachmentSource(source);
  const history = parseAgentHistoryImageSource(source);
  if (runtime) {
    if (!context.resolveRuntimeAttachment) throw new Error("Image attachment is unavailable");
    source = await context.resolveRuntimeAttachment(runtime);
    const kind = classifyImageAssetSource(source).kind;
    if (kind !== "local" && !/^data:image\/(?:png|jpeg|gif|webp);base64,/iu.test(source))
      throw new Error("Invalid image attachment");
  }
  if (history) {
    if (!context.resolveHistoryImage) throw new Error("Image history is unavailable");
    source = await context.resolveHistoryImage(history);
    if (!parseAssetSource(source)) throw new Error("Invalid history image attachment");
  }

  const classified = classifyImageAssetSource(source);
  if (classified.kind === "data") return classified.source;
  if (classified.kind === "managed")
    return queryClient.fetchQuery({
      queryKey: queryKeys.conversationImages.managed(
        context.hostId,
        context.conversationId,
        classified.source,
      ),
      queryFn: () => readManagedImageDataUrl(classified.source),
      retry: false,
      staleTime: force ? 0 : Infinity,
      gcTime: CONVERSATION_IMAGE_GC_TIME_MS,
    });
  if (classified.kind !== "local" || !classified.localPath)
    throw new Error("Image file is unavailable");

  const path = classified.localPath.replaceAll("\\", "/");
  const result = await queryClient.fetchQuery({
    ...workspaceFileBinaryQueryOptions(
      { hostId: context.hostId, path },
      { conversationId: context.conversationId },
    ),
    retry: false,
    staleTime: force ? 0 : Infinity,
    gcTime: CONVERSATION_IMAGE_GC_TIME_MS,
  });
  if (!result.contentsBase64) throw new Error("Image file is unavailable");
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return buildImageDataUrl(
    result.contentsBase64,
    IMAGE_MIME_TYPES[extension] ?? "application/octet-stream",
  );
}
