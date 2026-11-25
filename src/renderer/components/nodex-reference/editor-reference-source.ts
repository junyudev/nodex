import { useBlockReferenceHostRuntime } from "@/components/block-documents/block-reference-runtime-context";
import type { NodexReferenceSource } from "@/lib/nodex-reference-router";

/**
 * A Page editor is a reading surface of kind `page`: its host follows a link within the Page's
 * own tab group and content route, and every other gesture goes through the shared router.
 */
export function useEditorReferenceSource(): NodexReferenceSource {
  const host = useBlockReferenceHostRuntime();
  const openPage = host?.openPage;
  if (!host || !openPage) return { surface: "page" };
  return {
    surface: "page",
    openInPlace: (destination, titleSnapshot) =>
      destination.kind === "page"
        ? openPage({
            routingContext: host.contentRoutingContext,
            pageId: destination.pageId,
            ...(titleSnapshot ? { titleSnapshot } : {}),
            ...(destination.blockId ? { sourceBlockId: destination.blockId } : {}),
          })
        : undefined,
  };
}
