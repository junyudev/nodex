import type { QueryClient } from "@tanstack/react-query";
import { parseAgentHistoryImageSource } from "../../../shared/agent-history-images";
import { parseAgentRuntimeAttachmentSource } from "../../../shared/agent-runtime-attachments";
import { parseAssetSource } from "../../../shared/assets";
import { readManagedImageDataUrl } from "../assets";
import { queryKeys } from "../query-keys";
import { workspaceFileBinaryQueryOptions } from "../query-options";
import { conversationMediaDataUrl } from "./media-target";
import { classifyImageAssetSource } from "./image-source";
import { isHostedChat } from "../hosted-chat";
import type { ContentImageScope } from "./content-image-scope";

export const CONTENT_IMAGE_GC_TIME_MS = 5 * 60_000;

export function requiresContentImageRead(source: string): boolean {
  const kind = classifyImageAssetSource(source).kind;
  return (
    kind === "local" ||
    kind === "managed" ||
    parseAgentHistoryImageSource(source) !== null ||
    parseAgentRuntimeAttachmentSource(source) !== null
  );
}

/** A read stops when the content's owner no longer holds its source, before and after it runs. */
function admit(scope: ContentImageScope): void {
  if (!scope.isResourceCurrent()) throw new Error("The image's source has moved on");
}

/**
 * Reads an image's bytes where its content lives. The mounted image owns its resolved bytes; the
 * shared read cache has no observers.
 */
export async function readContentImage(
  queryClient: QueryClient,
  rawSource: string,
  context: ContentImageScope,
  force = false,
): Promise<string> {
  admit(context);
  const image = await readAdmittedContentImage(queryClient, rawSource, context, force);
  admit(context);
  return image;
}

async function readAdmittedContentImage(
  queryClient: QueryClient,
  rawSource: string,
  context: ContentImageScope,
  force: boolean,
): Promise<string> {
  let source = rawSource;
  const runtime = parseAgentRuntimeAttachmentSource(source);
  const history = parseAgentHistoryImageSource(source);
  if (runtime) {
    const resolve = context.resolveRuntimeAttachment;
    if (!resolve) throw new Error("Image attachment is unavailable");
    // A recorded attachment never changes, so a chat resolves it once while it holds the source,
    // whether to a file here or to the picture's own bytes.
    source = await queryClient.fetchQuery({
      queryKey: queryKeys.conversationImages.attachment(
        context.hostId,
        context.conversationId,
        context.sourceIdentity,
        runtime,
      ),
      queryFn: () => resolve(runtime),
      retry: false,
      staleTime: force ? 0 : Infinity,
      gcTime: CONTENT_IMAGE_GC_TIME_MS,
    });
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
      gcTime: CONTENT_IMAGE_GC_TIME_MS,
    });
  if (classified.kind !== "local" || !classified.localPath)
    throw new Error("Image file is unavailable");
  // A hosted chat's file is on its Space's host, read only as one of the chat's attachments.
  if (isHostedChat()) throw new Error("Image file is unavailable");

  const path = classified.localPath.replaceAll("\\", "/");
  const result = await queryClient.fetchQuery({
    ...workspaceFileBinaryQueryOptions(
      { hostId: context.hostId, path },
      { conversationId: context.conversationId, sourceIdentity: context.sourceIdentity },
    ),
    retry: false,
    staleTime: force ? 0 : Infinity,
    gcTime: CONTENT_IMAGE_GC_TIME_MS,
  });
  if (!result.contentsBase64) throw new Error("Image file is unavailable");
  return conversationMediaDataUrl(result.contentsBase64, result.mimeType, path);
}
