import { useEffect, useCallback } from "react";

interface KeyboardShortcutsOptions {
  onUndo: () => void;
  onRedo: () => void;
  enabled?: boolean;
}

type ShortcutAction = "undo" | "redo";

type ShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "shiftKey" | "target"
>;

const EDITOR_SURFACE_SELECTOR = ".nfm-editor, .bn-editor, .bn-container";

interface KeyboardTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => Element | null;
}

function isTextInputTarget(target: EventTarget | null | undefined): boolean {
  const el = target as KeyboardTargetLike | null | undefined;
  if (!el?.tagName) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
}

function isEditorSurfaceTarget(target: EventTarget | null | undefined): boolean {
  const el = target as KeyboardTargetLike | null | undefined;
  if (!el?.closest) return false;
  return Boolean(el.closest(EDITOR_SURFACE_SELECTOR));
}

function isEditableTarget(target: EventTarget | null | undefined): boolean {
  const el = target as KeyboardTargetLike | null | undefined;
  if (!el) return false;
  return Boolean(el.isContentEditable) || isTextInputTarget(target) || isEditorSurfaceTarget(target);
}

/**
 * Returns which history action should run for a key event.
 * Returns `null` when the event should be ignored.
 */
export function resolveHistoryShortcutAction(
  e: ShortcutEvent,
  isMac: boolean,
  activeElement: EventTarget | null,
): ShortcutAction | null {
  if (isEditableTarget(e.target) || isEditableTarget(activeElement)) {
    return null;
  }

  const modifier = isMac ? e.metaKey : e.ctrlKey;
  if (!modifier) return null;

  if (e.key === "z" || e.key === "Z") {
    return e.shiftKey ? "redo" : "undo";
  }

  if (e.key === "y" || e.key === "Y") {
    return "redo";
  }

  return null;
}

export function useKeyboardShortcuts({
  onUndo,
  onRedo,
  enabled = true,
}: KeyboardShortcutsOptions) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!enabled) return;

      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const action = resolveHistoryShortcutAction(e, isMac, document.activeElement);
      if (!action) return;
      e.preventDefault();
      if (action === "undo") {
        onUndo();
        return;
      }
      onRedo();
    },
    [onUndo, onRedo, enabled]
  );

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
