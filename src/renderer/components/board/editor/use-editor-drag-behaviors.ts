import { useEffect, useEffectEvent, useRef } from "react";
import type { RefObject } from "react";
import { DropCursorExtension, SideMenuExtension } from "@blocknote/core/extensions";
import {
  endLocalBlockDragSession,
  resolveLocalBlockDragOverSession,
  shouldBlockNoteYieldManagedDrag,
} from "../../workbench/block-transfer/cross-surface-drag";
import {
  setupBlockTransferDocumentDrop,
  type BlockTransferDropBoundary,
  type BlockTransferDropEditor,
} from "./block-transfer-drop";
import { finalizeSideMenuBlockDrag } from "./side-menu-drag-lifecycle";
import { setupToggleDrop } from "./toggle-drop";

interface UseEditorDragBehaviorsOptions {
  editor: Parameters<typeof setupToggleDrop>[1] & BlockTransferDropEditor;
  containerRef: RefObject<HTMLElement | null>;
  crossSurface?: {
    readonly surfaceId: string;
    readonly projectId: string;
    readonly documentId: string;
    readonly storeEpoch: string;
    readonly blockTransferDrop: BlockTransferDropBoundary;
  };
}

export function useEditorDragBehaviors({
  editor,
  containerRef,
  crossSurface,
}: UseEditorDragBehaviorsOptions) {
  const latestOptionsRef = useRef({ editor, crossSurface });
  const hasCrossSurface = crossSurface !== undefined;
  const { surfaceId, projectId, documentId, storeEpoch } = crossSurface ?? {};
  const readDropBoundary = useEffectEvent(() => {
    if (!crossSurface) throw new Error("The editor has no Block transfer boundary.");
    return crossSurface.blockTransferDrop;
  });

  useEffect(() => {
    latestOptionsRef.current = { editor, crossSurface };
  }, [editor, crossSurface]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let dropCleanupTimeout: number | undefined;

    const cleanupNativeDrag = () => {
      if (dropCleanupTimeout !== undefined) {
        window.clearTimeout(dropCleanupTimeout);
        dropCleanupTimeout = undefined;
      }

      const hadLocalDragState = el.hasAttribute("data-dragging");
      el.removeAttribute("data-dragging");
      const surfaceId = latestOptionsRef.current.crossSurface?.surfaceId;
      if (surfaceId) endLocalBlockDragSession({ sourceSurfaceId: surfaceId });
      const currentEditor = latestOptionsRef.current.editor;
      if (hadLocalDragState && currentEditor) {
        finalizeSideMenuBlockDrag(currentEditor);
      }
    };

    const onDragStart = (event: DragEvent) => {
      const target = event.target;
      if (target instanceof Element) {
        const deepestEditor = target.closest(".nfm-editor");
        if (deepestEditor && deepestEditor !== el) return;
      }
      el.setAttribute("data-dragging", "");
    };

    const onDragEnd = () => {
      cleanupNativeDrag();
    };

    const scheduleDropCleanup = () => {
      if (!el.hasAttribute("data-dragging")) return;
      if (dropCleanupTimeout !== undefined) {
        window.clearTimeout(dropCleanupTimeout);
      }
      dropCleanupTimeout = window.setTimeout(() => {
        dropCleanupTimeout = undefined;
        cleanupNativeDrag();
      }, 0);
    };

    el.addEventListener("dragstart", onDragStart);
    el.addEventListener("dragend", onDragEnd);
    window.addEventListener("drop", scheduleDropCleanup, true);
    window.addEventListener("dragend", scheduleDropCleanup, true);

    return () => {
      el.removeEventListener("dragstart", onDragStart);
      el.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", scheduleDropCleanup, true);
      window.removeEventListener("dragend", scheduleDropCleanup, true);
      cleanupNativeDrag();
    };
  }, [containerRef]);

  useEffect(() => {
    if (!editor || !hasCrossSurface) return;
    const element = containerRef.current;
    if (!element) return;
    const extensionRuntime = editor as unknown as {
      getExtension: (extension: unknown) => {
        setExternalDragOwnershipResolver: (resolver: (event: DragEvent) => boolean) => () => void;
      };
    };
    const resolveExternalDragOwnership = (event: DragEvent) => {
      const session = resolveLocalBlockDragOverSession(event.dataTransfer);
      return shouldBlockNoteYieldManagedDrag(session);
    };
    const releaseSideMenuOwnership = extensionRuntime
      .getExtension(SideMenuExtension)
      .setExternalDragOwnershipResolver(resolveExternalDragOwnership);
    const releaseDropCursorOwnership = extensionRuntime
      .getExtension(DropCursorExtension)
      .setExternalDragOwnershipResolver(resolveExternalDragOwnership);
    return () => {
      releaseDropCursorOwnership();
      releaseSideMenuOwnership();
    };
  }, [containerRef, hasCrossSurface, editor]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !editor) return;
    if (!hasCrossSurface) return setupToggleDrop(el, editor);
    // Only leaving this semantic surface cancels an in-flight save wait. Ordinary
    // renders refresh callbacks without destroying the native drop owner.
    return setupBlockTransferDocumentDrop(el, editor, readDropBoundary);
  }, [containerRef, hasCrossSurface, editor, surfaceId, projectId, documentId, storeEpoch]);
}
