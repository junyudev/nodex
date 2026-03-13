import { useEffect } from "react";
import type { StageId } from "./use-workbench-state";

export interface WorkbenchShortcutActions {
  spaces: { projectId: string }[];
  dbProjectId: string;
  focusedStage: StageId;
  focusAdjacentStage: (projectId: string, direction: -1 | 1) => void;
  switchToStageIndex: (projectId: string, index: number) => void;
  switchToProjectIndex: (index: number) => void;
  toggleTerminalPanel: (projectId: string) => void;
  onRequestNewWindow?: () => void;
  onRequestCommandPalette?: () => void;
  onRequestProjectPicker?: () => void;
  onRequestTaskSearch?: (projectId: string) => void;
  onRequestSettingsToggle?: () => void;
}

const EDITOR_SURFACE_SELECTOR = ".nfm-editor, .bn-editor, .bn-container";

interface ShortcutTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => Element | null;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element?.tagName) return false;
  return element.tagName === "INPUT" || element.tagName === "TEXTAREA";
}

function isEditorSurfaceTarget(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element?.closest) return false;
  return Boolean(element.closest(EDITOR_SURFACE_SELECTOR));
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = target as ShortcutTargetLike | null;
  if (!element) return false;
  return Boolean(element.isContentEditable) || isTextInputTarget(target) || isEditorSurfaceTarget(target);
}

export function handleWorkbenchShortcut(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "target">,
  actions: WorkbenchShortcutActions,
  isMac: boolean,
): boolean {
  const modifier = isMac ? e.metaKey : e.ctrlKey;
  const targetIsEditable = isEditableTarget(e.target);
  const targetIsEditorSurface = isEditorSurfaceTarget(e.target);
  if (modifier && !e.altKey && !e.shiftKey && (e.key === "j" || e.key === "J")) {
    actions.toggleTerminalPanel(actions.dbProjectId);
    return true;
  }

  if (modifier && !e.altKey && !e.shiftKey && (e.key === "n" || e.key === "N")) {
    actions.onRequestNewWindow?.();
    return true;
  }

  if (modifier && !e.altKey && !e.shiftKey && (e.key === "k" || e.key === "K" || e.key === "p" || e.key === "P")) {
    actions.onRequestCommandPalette?.();
    return true;
  }

  if (modifier && !e.altKey && !e.shiftKey && e.key === "," && actions.onRequestSettingsToggle) {
    actions.onRequestSettingsToggle();
    return true;
  }

  if (modifier && !e.altKey && !e.shiftKey && (e.key === "h" || e.key === "H" || e.key === "l" || e.key === "L")) {
    if (targetIsEditable && !targetIsEditorSurface) return false;
    actions.focusAdjacentStage(actions.dbProjectId, e.key === "h" || e.key === "H" ? -1 : 1);
    return true;
  }

  if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === "Tab") {
    if (targetIsEditable && !targetIsEditorSurface) return false;
    actions.focusAdjacentStage(actions.dbProjectId, e.shiftKey ? -1 : 1);
    return true;
  }

  if (!modifier) return false;

  if (e.altKey && e.key >= "1" && e.key <= "9") {
    if (targetIsEditable) return false;
    const index = Number.parseInt(e.key, 10) - 1;
    if (index < actions.spaces.length) {
      actions.switchToProjectIndex(index);
    }
    return true;
  }

  if (!e.altKey && e.key >= "1" && e.key <= "4") {
    if (targetIsEditable && !targetIsEditorSurface) return false;
    const index = Number.parseInt(e.key, 10) - 1;
    actions.switchToStageIndex(actions.dbProjectId, index);
    return true;
  }

  if (!e.altKey && (e.key === "P" || e.key === "p") && e.shiftKey && actions.onRequestProjectPicker) {
    if (targetIsEditable && !targetIsEditorSurface) return false;
    actions.onRequestProjectPicker();
    return true;
  }

  if (!e.altKey && !e.shiftKey && (e.key === "F" || e.key === "f") && actions.onRequestTaskSearch) {
    if (targetIsEditable) return false;
    actions.onRequestTaskSearch(actions.dbProjectId);
    return true;
  }

  return false;
}

export function useWorkbenchShortcuts(actions: WorkbenchShortcutActions): void {
  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");

    const onKeyDown = (e: KeyboardEvent) => {
      if (!handleWorkbenchShortcut(e, actions, isMac)) return;
      e.preventDefault();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [actions]);
}
