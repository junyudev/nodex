import { PortableRichTitle } from "@/components/block-documents/portable-rich-title";
import { canonicalizePortableRichText } from "../../../shared/block-documents/portable-rich-text";
import { useEffect, useState } from "react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type {
  DocumentRecoveryScope,
  RecoveryPreview as Preview,
} from "../../../shared/block-documents/document-recovery";
import { parsePortableCanvasScene } from "../../../shared/block-documents";
import { resolveCanvasBinaryFiles } from "@/lib/canvas-assets";
import { ReadonlyNfmBlockNotePreview } from "@/components/board/editor/readonly-nfm-blocknote-preview";

export function RecoveryPreview({
  value,
  scope,
  documentId,
  draftId,
}: {
  value: Preview | null | undefined;
  scope: DocumentRecoveryScope;
  documentId: string;
  draftId: string;
}) {
  if (!value)
    return (
      <p className="text-sm text-token-description-foreground">
        A complete preview is unavailable. The original draft is still retained.
      </p>
    );
  if (value.kind === "canvas") return <CanvasPreview scene={value.scene} />;
  return (
    <article className="min-w-0">
      <h2 className="mb-5 text-xl font-semibold text-token-text-primary">
        <PortableRichTitle
          value={canonicalizePortableRichText(value.rich_title)}
          fallback={value.title || "Untitled document"}
        />
      </h2>
      <ReadonlyNfmBlockNotePreview
        content={value.nfm}
        projectId={scope.accessContext.kind === "project" ? scope.accessContext.projectId : ""}
        pageId={documentId}
        historyId={draftId}
      />
    </article>
  );
}
function CanvasPreview({ scene }: { scene: unknown }) {
  const [preview, setPreview] = useState<{ source: unknown; url?: string; error?: string } | null>(
    null,
  );
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    void (async () => {
      const parsed = parsePortableCanvasScene(scene);
      const [{ exportToSvg }, files] = await Promise.all([
        import("@excalidraw/excalidraw"),
        resolveCanvasBinaryFiles(parsed.files),
      ]);
      const svg = await exportToSvg({
        elements: parsed.elements as unknown as readonly ExcalidrawElement[],
        appState: { ...parsed.appState, exportBackground: true },
        files: files as unknown as BinaryFiles,
      });
      if (!active) return;
      url = URL.createObjectURL(new Blob([svg.outerHTML], { type: "image/svg+xml" }));
      setPreview({ source: scene, url });
    })().catch((error: unknown) => {
      if (active)
        setPreview({
          source: scene,
          error: error instanceof Error ? error.message : String(error),
        });
    });
    return () => {
      active = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [scene]);
  if (!preview || preview.source !== scene)
    return <p className="text-sm text-token-description-foreground">Loading Canvas preview…</p>;
  if (preview.error)
    return (
      <p role="alert" className="text-sm text-token-description-foreground">
        {preview.error}
      </p>
    );
  return (
    <img
      src={preview.url}
      alt="Retained Canvas scene"
      className="max-h-[55vh] w-full object-contain"
    />
  );
}
