import { useEffect } from "react";
import { LoadingIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { appScope, useScopeHandle, type ScopeHandle } from "@/lib/maitai";
import { openModal, type ModalCloseProps } from "@/lib/modal-registry";
import { renderMermaidDownload, type MermaidRenderTheme } from "@/lib/mermaid-runtime";
import { useMermaidPreview } from "@/lib/use-mermaid-preview";
import { cn } from "@/lib/utils";

export interface MermaidDiagramModalProps extends ModalCloseProps {
  readonly source: string;
  readonly svg: string;
  readonly theme: MermaidRenderTheme;
}

export function MermaidDiagramModal({ source, svg, theme, onClose }: MermaidDiagramModalProps) {
  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent
        unstyledContent
        className="flex h-[min(82vh,900px)] w-[min(92vw,1200px)] flex-col overflow-hidden rounded-2xl bg-token-main-surface-primary text-token-foreground shadow-2xl ring-[0.5px] ring-token-border"
        closeButtonClassName="top-3 right-3 bg-token-main-surface-primary/80 backdrop-blur hover:bg-token-toolbar-hover-background"
      >
        <NodexDialogTitle className="sr-only">Mermaid diagram</NodexDialogTitle>
        <NodexDialogDescription className="sr-only">
          Fullscreen preview of the Mermaid code block
        </NodexDialogDescription>
        <div
          data-nfm-mermaid-fullscreen
          data-mermaid-theme={theme}
          className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-token-main-surface-primary p-10 [&_svg]:max-h-full [&_svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg }}
        />
        <div className="border-t-[0.5px] border-token-border px-4 py-2 font-mono text-xs text-token-text-tertiary">
          {source.split("\n")[0] || "Mermaid"}
        </div>
      </NodexDialogContent>
    </NodexDialog>
  );
}

function openMermaidDiagramModal(input: {
  readonly appHandle: ScopeHandle;
  readonly source: string;
  readonly svg: string;
  readonly theme: MermaidRenderTheme;
  readonly returnFocusElement?: HTMLElement | null;
}): void {
  openModal(input.appHandle, MermaidDiagramModal, {
    source: input.source,
    svg: input.svg,
    theme: input.theme,
    onClose: () => input.returnFocusElement?.focus(),
  });
}

const OPEN_MERMAID_DIAGRAM_EVENT = "nodex:open-mermaid-diagram";

interface OpenMermaidDiagramDetail {
  readonly source: string;
  readonly svg: string;
  readonly theme: MermaidRenderTheme;
  readonly returnFocusElement?: HTMLElement | null;
}

/** Keeps editor NodeViews independent from the application modal registry. */
export function requestMermaidDiagramFullscreen(detail: OpenMermaidDiagramDetail): void {
  window.dispatchEvent(
    new CustomEvent<OpenMermaidDiagramDetail>(OPEN_MERMAID_DIAGRAM_EVENT, { detail }),
  );
}

/** Application-level bridge between renderer-local diagram surfaces and the shared modal host. */
export function MermaidDiagramModalController() {
  const appHandle = useScopeHandle(appScope);

  useEffect(() => {
    const handleOpen = (event: Event) => {
      const { detail } = event as CustomEvent<OpenMermaidDiagramDetail>;
      openMermaidDiagramModal({ appHandle, ...detail });
    };
    window.addEventListener(OPEN_MERMAID_DIAGRAM_EVENT, handleOpen);
    return () => window.removeEventListener(OPEN_MERMAID_DIAGRAM_EVENT, handleOpen);
  }, [appHandle]);

  return null;
}

function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function downloadMermaidDiagram(input: {
  readonly svg: string;
  readonly theme: MermaidRenderTheme;
}): Promise<void> {
  try {
    const result = await renderMermaidDownload(input);
    triggerBlobDownload(result.blob, `mermaid-diagram.${result.format === "jpeg" ? "jpg" : "svg"}`);
    if (result.format === "svg") toast.info("JPEG export failed, so Nodex downloaded SVG instead");
  } catch (error) {
    toast.danger("Could not download diagram", {
      description: error instanceof Error ? error.message : undefined,
    });
  }
}

/** Returns only an SVG derived from the current source, never a retained stale preview. */
export function readReadyMermaidSvg(surface: ParentNode | null): string | null {
  const preview = surface?.querySelector<HTMLElement>("[data-nfm-mermaid-preview]");
  if (preview?.dataset.nfmMermaidStatus !== "ready") return null;
  return preview.querySelector<HTMLElement>("[data-nfm-mermaid-svg]")?.innerHTML || null;
}

export function MermaidCodePreview({
  source,
  theme,
  className,
}: {
  readonly source: string;
  readonly theme: MermaidRenderTheme;
  readonly className?: string;
}) {
  const preview = useMermaidPreview(source, theme);
  const svg = preview.result?.svg;

  const expand = (trigger: HTMLElement) => {
    if (!svg) return;
    requestMermaidDiagramFullscreen({ source, svg, theme, returnFocusElement: trigger });
  };

  return (
    <div
      data-nfm-mermaid-preview
      data-nfm-mermaid-status={preview.status}
      className={cn(
        "relative flex min-h-32 w-full items-center justify-center overflow-auto px-[22px] py-8",
        className,
      )}
      aria-busy={preview.status === "rendering"}
    >
      {svg ? (
        <button
          type="button"
          aria-label="Click diagram to expand in fullscreen"
          className="flex min-h-12 w-full cursor-zoom-in items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-blue)] [&_svg]:max-w-full"
          onClick={(event) => expand(event.currentTarget)}
        >
          <span
            data-nfm-mermaid-svg
            className="contents"
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </button>
      ) : preview.status === "rendering" ? (
        <div className="flex items-center gap-2 text-sm text-token-text-tertiary">
          <LoadingIcon className="size-4 animate-spin" /> Rendering diagram…
        </div>
      ) : preview.status === "empty" ? (
        <span className="text-sm text-token-text-tertiary">
          Add Mermaid code to create a diagram
        </span>
      ) : null}
      {preview.status === "error" ? (
        <div
          role="alert"
          className={cn(
            "max-w-full rounded-md bg-token-charts-red/8 px-3 py-2 text-left text-xs text-token-charts-red",
            svg && "absolute inset-x-[22px] bottom-2 backdrop-blur-sm",
          )}
        >
          <span className="font-medium">Diagram couldn&apos;t render.</span>{" "}
          <span className="font-mono">{preview.error}</span>
        </div>
      ) : null}
    </div>
  );
}
