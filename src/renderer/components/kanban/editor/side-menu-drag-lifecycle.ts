import { SideMenuExtension } from "@blocknote/core/extensions";

interface SideMenuDragLifecycle {
  blockDragEnd: () => void;
}

interface SideMenuDragCleanupEditor {
  prosemirrorView?: {
    dragging?: unknown;
    root?: Document | ShadowRoot;
  };
  getExtension?: (extension: unknown) => unknown;
}

function supportsSideMenuDragLifecycle(
  value: unknown,
): value is SideMenuDragLifecycle {
  if (typeof value !== "object" || value === null) return false;
  return typeof (value as { blockDragEnd?: unknown }).blockDragEnd === "function";
}

function removeDanglingDragPreviews(
  rootEl: Document | ShadowRoot | undefined,
): void {
  if (!rootEl) return;
  for (const element of rootEl.querySelectorAll(".bn-drag-preview")) {
    element.remove();
  }
}

function getMountedProseMirrorView(
  editor: SideMenuDragCleanupEditor,
): {
  dragging?: unknown;
  root?: Document | ShadowRoot;
} | undefined {
  try {
    return editor.prosemirrorView;
  } catch {
    return undefined;
  }
}

export function finalizeSideMenuBlockDrag(
  editor: SideMenuDragCleanupEditor,
): void {
  const pmView = getMountedProseMirrorView(editor) as {
    dragging?: unknown;
    root?: Document | ShadowRoot;
  } | undefined;

  if (pmView && "dragging" in pmView) {
    pmView.dragging = null;
  }

  if (typeof editor.getExtension === "function") {
    const sideMenuExtension = editor.getExtension(SideMenuExtension);
    if (pmView?.root && supportsSideMenuDragLifecycle(sideMenuExtension)) {
      sideMenuExtension.blockDragEnd();
    }
  }

  removeDanglingDragPreviews(
    pmView?.root
    ?? (typeof document !== "undefined" ? document : undefined),
  );
}
