import { useEffect, useRef, useState } from "react";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { BinaryFiles } from "@excalidraw/excalidraw/types";
import type { LibraryFileReadBinding } from "../../../shared/library-files";
import { parsePortableCanvasScene } from "../../../shared/block-documents/canvas-scene";
import { parseFileSource } from "../../../shared/file-resources";
import type { LibraryFileAuthority } from "@/lib/library-file-resources";
import {
  CanvasBinaryFileResolver,
  createCanvasFileBridge,
  subscribeCanvasFileAuthority,
} from "@/lib/canvas-assets";

export type CanvasPreviewAuthority = LibraryFileAuthority & {
  readonly documentId: string;
} & (
    | { readonly revisionId: string }
    | { readonly bindings: Readonly<Record<string, LibraryFileReadBinding>> }
  );

/** The exported SVG is disposable presentation and is revoked along with its exact File sources. */
export function CanvasFilePreview({
  scene,
  authority,
  label,
}: {
  readonly scene: unknown;
  readonly authority: CanvasPreviewAuthority | null;
  readonly label: string;
}) {
  const [preview, setPreview] = useState<{
    source: unknown;
    scope: string;
    url?: string;
    error?: string;
  } | null>(null);
  const scope = JSON.stringify(authority);
  const authorityRef = useRef({ scope, authority });
  if (authorityRef.current.scope !== scope) authorityRef.current = { scope, authority };
  const exactAuthority = authorityRef.current.authority;
  useEffect(() => {
    let active = true;
    let url: string | undefined;
    const reader = exactAuthority
      ? new CanvasBinaryFileResolver(
          createCanvasFileBridge(exactAuthority, (file) => {
            if ("revisionId" in exactAuthority)
              return {
                kind: "canvas_revision",
                document_id: exactAuthority.documentId,
                revision_id: exactAuthority.revisionId,
                scene_file_id: file.id,
              };
            const binding = exactAuthority.bindings[file.id];
            if (
              !binding ||
              binding.file_id !== parseFileSource(file.source) ||
              binding.version !== file.fileVersion ||
              !["canvas", "canvas_revision", "canvas_recovery"].includes(binding.source.kind)
            )
              throw new Error("This preview has no exact Canvas File binding");
            return binding.source;
          }),
        )
      : null;
    const invalidate = () => {
      active = false;
      reader?.clear();
      if (url) {
        URL.revokeObjectURL(url);
        url = undefined;
      }
      setPreview({
        source: scene,
        scope,
        error: "Canvas preview access changed. Reopen the preview to refresh it.",
      });
    };
    const unsubscribe = exactAuthority
      ? subscribeCanvasFileAuthority(
          exactAuthority,
          { documentId: exactAuthority.documentId },
          invalidate,
        )
      : () => undefined;
    void (async () => {
      const parsed = parsePortableCanvasScene(scene);
      if (!reader && Object.keys(parsed.files).length > 0)
        throw new Error("Canvas File preview authority is unavailable");
      const [{ exportToSvg }, files] = await Promise.all([
        import("@excalidraw/excalidraw"),
        reader?.resolve(parsed.files) ?? Promise.resolve({}),
      ]);
      const svg = await exportToSvg({
        elements: parsed.elements as unknown as readonly ExcalidrawElement[],
        appState: { ...parsed.appState, exportBackground: true },
        files: files as unknown as BinaryFiles,
      });
      if (!active) return;
      url = URL.createObjectURL(new Blob([svg.outerHTML], { type: "image/svg+xml" }));
      setPreview({ source: scene, scope, url });
    })().catch((error: unknown) => {
      if (active)
        setPreview({
          source: scene,
          scope,
          error: error instanceof Error ? error.message : String(error),
        });
    });
    return () => {
      active = false;
      unsubscribe();
      reader?.destroy();
      if (url) URL.revokeObjectURL(url);
    };
  }, [scene, exactAuthority, scope]);
  if (!preview || preview.source !== scene || preview.scope !== scope)
    return <p className="text-sm text-token-description-foreground">Loading Canvas preview…</p>;
  if (preview.error)
    return (
      <p role="alert" className="text-sm text-token-description-foreground">
        {preview.error}
      </p>
    );
  return <img src={preview.url} alt={label} className="max-h-[55vh] w-full object-contain" />;
}
