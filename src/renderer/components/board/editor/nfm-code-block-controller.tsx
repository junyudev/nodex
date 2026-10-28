import { useBlockNoteEditor } from "@blocknote/react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import { writeTextToClipboard } from "@/lib/clipboard";
import {
  getCodeBlockActionBarMode,
  getCodeBlockPlainText,
  type CodeBlockActionBarMode,
} from "@/lib/editor-model/code-block-model";
import { codeLanguagePreference } from "@/lib/editor-model/code-language-preference";
import {
  codeBlockViewState,
  type MermaidCodePreviewMode,
} from "@/lib/editor-model/code-block-view-state";
import { useTheme } from "@/lib/use-theme";
import { normalizeCodeLanguageId } from "../../../../shared/code-languages/code-language-catalog";
import { NfmCodeBlockActionBar } from "./nfm-code-block-action-bar";
import { createNfmSideMenuElementReference } from "./nfm-side-menu-anchor";
import { useNfmSideMenuOpenController } from "./nfm-side-menu";
import {
  downloadMermaidDiagram,
  readReadyMermaidSvg,
  requestMermaidDiagramFullscreen,
} from "./mermaid-code-preview";

interface CodeBlockControllerBlock {
  readonly id: string;
  readonly type: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
}

interface CodeBlockControllerEditor {
  readonly domElement?: HTMLElement | null;
  readonly prosemirrorView?: { readonly dom?: HTMLElement | null };
  getBlock(blockId: string): CodeBlockControllerBlock | undefined;
  transact(callback: () => void): void;
  updateBlock(
    block: CodeBlockControllerBlock | string,
    patch: { readonly props: { readonly language: string } },
  ): void;
}

interface ActiveCodeBlock {
  readonly blockId: string;
  readonly anchor: HTMLElement;
  readonly surface: HTMLElement;
  readonly mode: CodeBlockActionBarMode;
  readonly mermaidPreviewMode: MermaidCodePreviewMode;
  readonly hasValidDiagram: boolean;
}

const CODE_SURFACE_SELECTOR = "[data-nfm-code-block-surface]";
const CODE_ACTION_ANCHOR_SELECTOR = "[data-nfm-code-block-action-anchor]";

function findCodeSurface(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  return target.closest<HTMLElement>(CODE_SURFACE_SELECTOR);
}

function resolveActiveCodeBlock(surface: HTMLElement): ActiveCodeBlock | null {
  const blockId = surface.dataset.blockId;
  const anchor = surface.querySelector<HTMLElement>(CODE_ACTION_ANCHOR_SELECTOR);
  if (!blockId || !anchor) return null;
  const isMermaid = surface.dataset.language === "mermaid";
  const storedPreviewMode = surface.dataset.mermaidPreviewMode;
  const mermaidPreviewMode: MermaidCodePreviewMode =
    storedPreviewMode === "code" || storedPreviewMode === "preview" || storedPreviewMode === "split"
      ? storedPreviewMode
      : "split";
  const width =
    surface.getBoundingClientRect().width ||
    surface.closest<HTMLElement>(".bn-block-content")?.getBoundingClientRect().width ||
    surface.clientWidth;
  return {
    blockId,
    anchor,
    surface,
    mode: getCodeBlockActionBarMode(width, undefined, isMermaid),
    mermaidPreviewMode,
    hasValidDiagram: readReadyMermaidSvg(surface) !== null,
  };
}

function hasSameActiveCodeBlock(current: ActiveCodeBlock | null, next: ActiveCodeBlock): boolean {
  return (
    current?.blockId === next.blockId &&
    current.anchor === next.anchor &&
    current.mode === next.mode &&
    current.mermaidPreviewMode === next.mermaidPreviewMode &&
    current.hasValidDiagram === next.hasValidDiagram
  );
}

function getRenderedMermaidSvg(surface: HTMLElement): string | null {
  return readReadyMermaidSvg(surface);
}

export function NfmCodeBlockController() {
  const blockNoteEditor = useBlockNoteEditor();
  const { resolved: theme } = useTheme();
  const editor = blockNoteEditor as unknown as CodeBlockControllerEditor;
  const sideMenu = useNfmSideMenuOpenController();
  const [active, setActive] = useState<ActiveCodeBlock | null>(null);
  const activeRef = useRef<ActiveCodeBlock | null>(active);
  activeRef.current = active;
  const [coarsePointer, setCoarsePointer] = useState(
    () => window.matchMedia?.("(pointer: coarse)").matches ?? false,
  );
  const interactionOpenRef = useRef(false);
  const hoveredBlockIdRef = useRef<string | null>(null);
  const draggingRef = useRef(false);
  const sideMenuOpenBlockIdRef = useRef<string | null>(sideMenu.openBlockId);
  sideMenuOpenBlockIdRef.current = sideMenu.openBlockId;

  useEffect(() => {
    const media = window.matchMedia?.("(pointer: coarse)");
    const update = () => setCoarsePointer(media?.matches ?? false);
    media?.addEventListener?.("change", update);
    return () => media?.removeEventListener?.("change", update);
  }, []);

  useEffect(() => {
    if (!coarsePointer || active || draggingRef.current) return;
    const root = editor.domElement ?? editor.prosemirrorView?.dom;
    if (!root) return;
    // Shiki may replace the React NodeView once while its grammar resolves. Wait for that
    // initial paint to settle so the coarse-pointer portal is attached to the final anchor.
    const timeout = window.setTimeout(() => {
      const surface = root.querySelector<HTMLElement>(CODE_SURFACE_SELECTOR);
      if (!surface) return;
      setActive(resolveActiveCodeBlock(surface));
    }, 120);
    return () => window.clearTimeout(timeout);
  }, [active, coarsePointer, editor]);

  useEffect(() => {
    let dragging = false;
    const root = editor.domElement ?? editor.prosemirrorView?.dom;
    if (!root) return;
    const ownsSurface = (surface: HTMLElement) => {
      return root.contains(surface);
    };
    const showForSurface = (surface: HTMLElement | null) => {
      if (!surface || dragging || !ownsSurface(surface)) return;
      const next = resolveActiveCodeBlock(surface);
      if (!next) return;
      setActive((current) => (hasSameActiveCodeBlock(current, next) ? current : next));
    };
    const showFirstSurface = () =>
      showForSurface(root.querySelector<HTMLElement>(CODE_SURFACE_SELECTOR));
    const findSurfaceByBlockId = (blockId: string) =>
      [...root.querySelectorAll<HTMLElement>(CODE_SURFACE_SELECTOR)].find(
        (surface) => surface.dataset.blockId === blockId,
      ) ?? null;
    const clearUnlessOwned = (surface: HTMLElement, relatedTarget: EventTarget | null) => {
      if (!ownsSurface(surface) || coarsePointer) return;
      if (relatedTarget instanceof Node && surface.contains(relatedTarget)) return;
      if (interactionOpenRef.current) return;
      if (sideMenuOpenBlockIdRef.current === surface.dataset.blockId) return;
      setActive((current) => (current?.surface === surface ? null : current));
    };
    const handlePointerOver = (event: PointerEvent) => {
      const surface = findCodeSurface(event.target);
      if (surface && ownsSurface(surface))
        hoveredBlockIdRef.current = surface.dataset.blockId ?? null;
      showForSurface(surface);
    };
    const handlePointerOut = (event: PointerEvent) => {
      const surface = findCodeSurface(event.target);
      if (!surface) return;
      if (!(event.relatedTarget instanceof Node && surface.contains(event.relatedTarget))) {
        if (hoveredBlockIdRef.current === surface.dataset.blockId) {
          hoveredBlockIdRef.current = null;
        }
      }
      clearUnlessOwned(surface, event.relatedTarget);
    };
    const handleFocusIn = (event: FocusEvent) => {
      showForSurface(findCodeSurface(event.target));
    };
    const handleFocusOut = (event: FocusEvent) => {
      const surface = findCodeSurface(event.target);
      if (!surface) return;
      queueMicrotask(() => clearUnlessOwned(surface, document.activeElement));
    };
    const handleDragStart = (event: DragEvent) => {
      const surface = findCodeSurface(event.target);
      if (!surface || !ownsSurface(surface)) return;
      dragging = true;
      draggingRef.current = true;
      setActive(null);
    };
    const handleDragEnd = () => {
      dragging = false;
      draggingRef.current = false;
      if (coarsePointer) showFirstSurface();
    };
    const mutationObserver = new MutationObserver(() => {
      const current = activeRef.current;
      if (!current) return;
      if (!current.surface.isConnected) {
        const replacement = findSurfaceByBlockId(current.blockId);
        if (!replacement) {
          setActive(null);
          return;
        }
        showForSurface(replacement);
        return;
      }
      const next = resolveActiveCodeBlock(current.surface);
      if (next)
        setActive((candidate) => (hasSameActiveCodeBlock(candidate, next) ? candidate : next));
    });
    mutationObserver.observe(root, { attributes: true, childList: true, subtree: true });
    root.addEventListener("pointerover", handlePointerOver);
    root.addEventListener("pointerout", handlePointerOut);
    root.addEventListener("focusin", handleFocusIn);
    root.addEventListener("focusout", handleFocusOut);
    root.addEventListener("dragstart", handleDragStart);
    root.addEventListener("dragend", handleDragEnd);

    return () => {
      mutationObserver.disconnect();
      root.removeEventListener("pointerover", handlePointerOver);
      root.removeEventListener("pointerout", handlePointerOut);
      root.removeEventListener("focusin", handleFocusIn);
      root.removeEventListener("focusout", handleFocusOut);
      root.removeEventListener("dragstart", handleDragStart);
      root.removeEventListener("dragend", handleDragEnd);
      draggingRef.current = false;
    };
  }, [coarsePointer, editor]);

  useEffect(() => {
    if (!active) return;
    if (coarsePointer) return;
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const next = resolveActiveCodeBlock(active.surface);
      if (!next) {
        setActive(null);
        return;
      }
      setActive((current) => (hasSameActiveCodeBlock(current, next) ? current : next));
    });
    observer.observe(active.surface);
    return () => observer.disconnect();
  }, [active, coarsePointer]);

  useEffect(() => {
    if (!active) return;
    if (coarsePointer) return;
    if (sideMenu.openBlockId === active.blockId) return;
    if (interactionOpenRef.current) return;
    if (hoveredBlockIdRef.current === active.blockId) return;
    if (active.surface.contains(document.activeElement)) return;
    setActive(null);
  }, [active, coarsePointer, sideMenu.openBlockId]);

  if (!active) return null;
  const block = editor.getBlock(active.blockId);
  if (!block || block.type !== "codeBlock") return null;
  const languageId = normalizeCodeLanguageId(block.props.language);
  const source = getCodeBlockPlainText(block);
  const isMermaid = languageId === "mermaid";
  const renderedSvg = () => getRenderedMermaidSvg(active.surface);

  return createPortal(
    <NfmCodeBlockActionBar
      languageId={languageId}
      mode={active.mode}
      tooltipsDisabled={coarsePointer}
      onInteractionOpenChange={(open) => {
        interactionOpenRef.current = open;
        if (open) return;
        queueMicrotask(() => {
          if (hoveredBlockIdRef.current === active.blockId) return;
          if (active.surface.contains(document.activeElement)) return;
          if (sideMenuOpenBlockIdRef.current === active.blockId) return;
          setActive(null);
        });
      }}
      onLanguageChange={(nextLanguageId) => {
        const nextLanguage = normalizeCodeLanguageId(nextLanguageId);
        editor.transact(() => {
          editor.updateBlock(block, { props: { language: nextLanguage } });
        });
        codeLanguagePreference.set(nextLanguage);
      }}
      onCopy={() => writeTextToClipboard(source)}
      mermaid={
        isMermaid
          ? {
              previewMode: active.mermaidPreviewMode,
              hasValidDiagram: active.hasValidDiagram,
              onPreviewModeChange: (nextMode) => {
                if (nextMode === "preview") window.getSelection()?.removeAllRanges();
                codeBlockViewState.setMermaidPreviewMode(active.blockId, nextMode);
              },
              onExpand: (trigger) => {
                const svg = renderedSvg();
                if (!svg) return;
                requestMermaidDiagramFullscreen({
                  source,
                  svg,
                  theme,
                  returnFocusElement: trigger,
                });
              },
              onDownload: () => {
                const svg = renderedSvg();
                if (svg) void downloadMermaidDiagram({ svg, theme });
              },
            }
          : undefined
      }
      onMore={(anchor) => {
        sideMenu.openForBlock({
          block,
          reference: createNfmSideMenuElementReference(anchor),
          returnFocusElement: anchor,
          outsidePressIgnoreElement: anchor,
        });
      }}
    />,
    active.anchor,
  );
}
