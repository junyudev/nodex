export type ThreadPromptSubmitShortcut = "enter" | "mod-enter";

export const THREAD_PROMPT_SUBMIT_SHORTCUT_STORAGE_KEY =
  "nodex-thread-panel-prompt-submit-shortcut-v1";
export const DEFAULT_THREAD_PROMPT_SUBMIT_SHORTCUT: ThreadPromptSubmitShortcut =
  "enter";

interface ThreadPromptSubmitShortcutKeyInput {
  shortcut: ThreadPromptSubmitShortcut;
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing?: boolean;
}

export function normalizeThreadPromptSubmitShortcut(
  value: unknown,
): ThreadPromptSubmitShortcut {
  if (value === "enter" || value === "mod-enter") return value;

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "enter") return "enter";
    if (
      normalized === "mod-enter"
      || normalized === "cmd-enter"
      || normalized === "ctrl-enter"
      || normalized === "cmd+enter"
      || normalized === "ctrl+enter"
    ) {
      return "mod-enter";
    }
  }

  return DEFAULT_THREAD_PROMPT_SUBMIT_SHORTCUT;
}

export function readThreadPromptSubmitShortcut(): ThreadPromptSubmitShortcut {
  try {
    const raw = localStorage.getItem(THREAD_PROMPT_SUBMIT_SHORTCUT_STORAGE_KEY);
    return normalizeThreadPromptSubmitShortcut(raw);
  } catch {
    return DEFAULT_THREAD_PROMPT_SUBMIT_SHORTCUT;
  }
}

export function writeThreadPromptSubmitShortcut(
  value: ThreadPromptSubmitShortcut,
): ThreadPromptSubmitShortcut {
  const normalized = normalizeThreadPromptSubmitShortcut(value);
  try {
    localStorage.setItem(
      THREAD_PROMPT_SUBMIT_SHORTCUT_STORAGE_KEY,
      normalized,
    );
  } catch {
    // localStorage may be unavailable.
  }
  return normalized;
}

export function shouldSubmitThreadPromptFromKeyDown(
  input: ThreadPromptSubmitShortcutKeyInput,
): boolean {
  if (input.isComposing || input.key !== "Enter") return false;

  if (input.shortcut === "enter") {
    if (
      input.ctrlKey
      || input.metaKey
      || input.shiftKey
      || input.altKey
    ) {
      return false;
    }
    return true;
  }

  if (!input.ctrlKey && !input.metaKey) return false;
  if (input.altKey) return false;
  return true;
}
