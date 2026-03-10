import {
  normalizeStoredBoolean,
  writeStoredBoolean,
} from "./storage-boolean";

export const THREAD_PANEL_HIDE_THINKING_WHEN_DONE_STORAGE_KEY =
  "nodex-thread-panel-hide-thinking-when-done-v1";
export const DEFAULT_THREAD_PANEL_HIDE_THINKING_WHEN_DONE = true;

export function normalizeThreadPanelHideThinkingWhenDone(value: unknown): boolean {
  return normalizeStoredBoolean(value, DEFAULT_THREAD_PANEL_HIDE_THINKING_WHEN_DONE);
}

export function readThreadPanelHideThinkingWhenDone(): boolean {
  try {
    const raw = localStorage.getItem(THREAD_PANEL_HIDE_THINKING_WHEN_DONE_STORAGE_KEY);
    return raw !== null
      ? normalizeThreadPanelHideThinkingWhenDone(raw)
      : DEFAULT_THREAD_PANEL_HIDE_THINKING_WHEN_DONE;
  } catch {
    return DEFAULT_THREAD_PANEL_HIDE_THINKING_WHEN_DONE;
  }
}

export function writeThreadPanelHideThinkingWhenDone(value: boolean): boolean {
  return writeStoredBoolean(
    THREAD_PANEL_HIDE_THINKING_WHEN_DONE_STORAGE_KEY,
    value,
    DEFAULT_THREAD_PANEL_HIDE_THINKING_WHEN_DONE,
  );
}
