import { useContext, useState } from "react";
import { FileLinkWorkspaceContext } from "@/lib/file-link-workspace";
import { useContentImage, useContentImageScope } from "@/lib/content-image";
import { resolveAssetSourceToDisplayUrl } from "@/lib/assets";
import { parseAssetSource } from "../../../shared/assets";
import { parseFileSource } from "../../../shared/file-resources";
import { classifyImageSource, resolveRelativeImagePath } from "../../../shared/image-source";
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
 * computer, or in a chat the chat's host, as in the Agent's replies; a relative path reads from
 * the content's working folder. Web and data images show as they are, and any other source is
 * unavailable.
 */
export function useMarkdownImage(authored: string): MarkdownImage {
  const runtime = useFilePlacementRuntime();
  const scope = useContentImageScope();
  const workspace = useContext(FileLinkWorkspaceContext);
  const image = classifyImageSource(authored);
  // A relative path reads from the content's working folder, as its relative links do.
  const relative =
    image.kind === "relative"
      ? resolveRelativeImagePath(
          image.path,
          scope.cwd ?? workspace?.cwd ?? workspace?.workspacePath,
        )
      : null;
  // A source that names nothing readable, such as an authored `app:` URL, never loads.
  const unreadable = image.kind === "unsupported" || (image.kind === "relative" && !relative);
  const source = unreadable ? "" : (relative ?? authored);
  const isFile = parseFileSource(source) !== null;
  // A managed asset lives in this Profile's cache wherever the content lives.
  const isAsset = parseAssetSource(source) !== null;
  const snapshot = useFileReadSnapshot(runtime, source, { objectUrl: true });
  const asset = useContentImage(isFile || isAsset ? "" : source, {
    shouldLoadFileDataUrl: false,
  });
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null);
  const assetUrl = isAsset ? resolveAssetSourceToDisplayUrl(source) : null;
  const resolved = unreadable
    ? { url: null, failed: true }
    : isFile
      ? { url: snapshot.objectUrl, failed: runtime === null || Boolean(snapshot.contentError) }
      : isAsset
        ? { url: assetUrl, failed: assetUrl === null }
        : { url: asset.previewSrc, failed: asset.isError };
  const failed = resolved.failed || (resolved.url !== null && resolved.url === brokenUrl);
  return {
    url: failed ? null : resolved.url,
    failed,
    onError: () => setBrokenUrl(resolved.url),
  };
}
