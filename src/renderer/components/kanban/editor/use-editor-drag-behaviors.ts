import { useEffect } from "react";
import type { RefObject } from "react";
import type { ExternalDropAdapter } from "./external-block-drag-session";
import {
  type EditorForExternalBlockDrop,
  endExternalEditorDragSession,
  startExternalEditorDragSession,
} from "./external-block-drag-session";
import { finalizeSideMenuBlockDrag } from "./side-menu-drag-lifecycle";
import { setupToggleDrop } from "./toggle-drop";

interface UseEditorDragBehaviorsOptions {
  editor: Parameters<typeof setupToggleDrop>[1];
  containerRef: RefObject<HTMLElement | null>;
  externalDropAdapter?: ExternalDropAdapter | null;
}

function supportsExternalDropEditor(
  editor: UseEditorDragBehaviorsOptions["editor"],
): boolean {
  const candidate = editor as Partial<EditorForExternalBlockDrop>;
  if (!Array.isArray(candidate.document)) return false;
  if (typeof candidate.getBlock !== "function") return false;
  if (typeof candidate.getParentBlock !== "function") return false;
  if (typeof candidate.removeBlocks !== "function") return false;
  return typeof candidate.replaceBlocks === "function";
}

export function useEditorDragBehaviors({
  editor,
  containerRef,
  externalDropAdapter,
}: UseEditorDragBehaviorsOptions) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let dragSessionId: string | undefined;
    let dropCleanupTimeout: number | undefined;

    const cleanupNativeDrag = () => {
      if (dropCleanupTimeout !== undefined) {
        window.clearTimeout(dropCleanupTimeout);
        dropCleanupTimeout = undefined;
      }

      const hadLocalDragState = el.hasAttribute("data-dragging") || Boolean(dragSessionId);
      el.removeAttribute("data-dragging");
      endExternalEditorDragSession(dragSessionId);
      dragSessionId = undefined;
      if (hadLocalDragState && editor) {
        finalizeSideMenuBlockDrag(editor);
      }
    };

    const onDragStart = () => {
      el.setAttribute("data-dragging", "");
      if (!editor || !externalDropAdapter) return;
      if (!supportsExternalDropEditor(editor)) return;
      dragSessionId = startExternalEditorDragSession(
        editor as unknown as EditorForExternalBlockDrop,
        el,
        externalDropAdapter,
      );
    };

    const onDragEnd = () => {
      cleanupNativeDrag();
    };

    const scheduleDropCleanup = () => {
      if (!el.hasAttribute("data-dragging") && !dragSessionId) return;
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
  }, [containerRef, editor, externalDropAdapter]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !editor) return;
    return setupToggleDrop(el, editor);
  }, [containerRef, editor]);
}
