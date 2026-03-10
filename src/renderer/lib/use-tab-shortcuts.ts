import { useEffect } from "react";
import type { Tab } from "./use-tabs";

export interface TabShortcutActions {
  tabs: Tab[];
  activeTabId: string;
  setActiveTab: (tabId: string) => void;
  closeTab: (tabId: string) => void;
  onRequestAddTab?: () => void;
}

/** Returns `true` if the event target is an editable field (input/textarea/contenteditable). */
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || !el.tagName) return false;
  return (
    el.tagName === "INPUT" ||
    el.tagName === "TEXTAREA" ||
    el.isContentEditable
  );
}

/**
 * Pure handler logic for tab keyboard shortcuts.
 * Returns `true` if the event was handled (caller should preventDefault).
 */
export function handleTabShortcut(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "target">,
  actions: TabShortcutActions,
  isMac: boolean,
): boolean {
  if (isEditableTarget(e.target)) return false;

  const { tabs, activeTabId, setActiveTab, closeTab, onRequestAddTab } = actions;

  // Ctrl+Tab / Ctrl+Shift+Tab: cycle tabs.
  // On Mac this is literally Ctrl (not Cmd), matching Chrome/VS Code.
  if (e.ctrlKey && e.key === "Tab") {
    const currentIndex = tabs.findIndex((t) => t.id === activeTabId);
    if (currentIndex === -1) return false;

    const nextIndex = e.shiftKey
      ? (currentIndex - 1 + tabs.length) % tabs.length
      : (currentIndex + 1) % tabs.length;
    setActiveTab(tabs[nextIndex].id);
    return true;
  }

  const modifier = isMac ? e.metaKey : e.ctrlKey;
  if (!modifier) return false;

  // Cmd+1 through Cmd+9: switch to tab at index
  if (e.key >= "1" && e.key <= "9") {
    const index = parseInt(e.key, 10) - 1;
    if (index < tabs.length) {
      setActiveTab(tabs[index].id);
    }
    return true;
  }

  // Cmd+W: close active tab
  if (e.key === "w" || e.key === "W") {
    if (tabs.length > 1) {
      closeTab(activeTabId);
      return true;
    }
    return false;
  }

  // Cmd+T: open new tab picker
  if ((e.key === "t" || e.key === "T") && onRequestAddTab) {
    onRequestAddTab();
    return true;
  }

  return false;
}

export function useTabShortcuts(actions: TabShortcutActions): void {
  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (handleTabShortcut(e, actions, isMac)) {
        e.preventDefault();
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [actions.tabs, actions.activeTabId, actions.setActiveTab, actions.closeTab, actions.onRequestAddTab]);
}
