import { resolveAssetSourceToDisplayUrl } from "@/lib/assets";
import { parseFileSource } from "../../../shared/file-resources";
import { useFilePlacementRuntime, useFileReadSnapshot } from "./editor/file-runtime";

/** Where an image source displays from: a Library File through the File runtime, else as is. */
export function useMarkdownImage(source: string): {
  readonly url: string | null;
  readonly failed: boolean;
} {
  const runtime = useFilePlacementRuntime();
  const snapshot = useFileReadSnapshot(runtime, source, { objectUrl: true });
  if (parseFileSource(source) === null) {
    const url = resolveAssetSourceToDisplayUrl(source);
    return { url, failed: url === null };
  }
  return { url: snapshot.objectUrl, failed: runtime === null || Boolean(snapshot.contentError) };
}
