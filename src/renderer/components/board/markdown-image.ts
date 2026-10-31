import { useState } from "react";
import { useConversationImageAsset } from "@/features/local-conversation/view/shared/use-conversation-image-asset";
import { resolveAssetSourceToDisplayUrl } from "@/lib/assets";
import { parseAssetSource } from "../../../shared/assets";
import { parseFileSource } from "../../../shared/file-resources";
import { useFilePlacementRuntime, useFileReadSnapshot } from "./editor/file-runtime";

export interface MarkdownImage {
  readonly url: string | null;
  readonly failed: boolean;
  /** Reports that `url` loaded no picture, so the image says it is unavailable instead. */
  readonly onError: () => void;
}

/**
 * Where an image in Nodex Markdown displays from. A Library File reads through the enclosing File
 * runtime. A file path, absolute or a `file:` URL, names a file where the content lives: this
 * computer, or in a chat the chat's host, as in the Agent's replies. Web and data images show as
 * they are, and any other source is unavailable.
 */
export function useMarkdownImage(source: string): MarkdownImage {
  const runtime = useFilePlacementRuntime();
  const isFile = parseFileSource(source) !== null;
  // A managed asset lives in this Profile's cache wherever the content lives.
  const isAsset = parseAssetSource(source) !== null;
  const snapshot = useFileReadSnapshot(runtime, source, { objectUrl: true });
  const image = useConversationImageAsset(isFile || isAsset ? "" : source, {
    shouldLoadFileDataUrl: false,
  });
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const assetUrl = isAsset ? resolveAssetSourceToDisplayUrl(source) : null;
  const resolved = isFile
    ? { url: snapshot.objectUrl, failed: runtime === null || Boolean(snapshot.contentError) }
    : isAsset
      ? { url: assetUrl, failed: assetUrl === null }
      : { url: image.previewSrc, failed: image.isError };
  const failed = resolved.failed || (resolved.url !== null && resolved.url === brokenUrl);
  return {
    url: failed ? null : resolved.url,
    failed,
    onError: () => setBrokenUrl(resolved.url),
  };
}
