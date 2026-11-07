import type { Terminal } from "@xterm/xterm";
import type { CodexRendererOs } from "./codex-window-runtime";
import type { TerminalWriteSource } from "./terminal-session-store";

function metaOnly(event: KeyboardEvent, keys: readonly string[]): boolean {
  return (
    event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey && keys.includes(event.key)
  );
}

function ctrlKey(event: KeyboardEvent, key: string, shift = false): boolean {
  return (
    event.ctrlKey &&
    event.shiftKey === shift &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === key
  );
}

function insert(event: KeyboardEvent, ctrl: boolean, shift: boolean): boolean {
  return (
    event.ctrlKey === ctrl &&
    event.shiftKey === shift &&
    !event.altKey &&
    !event.metaKey &&
    event.key.toLowerCase() === "insert"
  );
}

function consume(event: KeyboardEvent): void {
  event.preventDefault();
  event.stopPropagation();
}

export function mapKey(event: KeyboardEvent): string | null {
  if (metaOnly(event, ["ArrowLeft", "ArrowUp"])) return "\x01";
  if (metaOnly(event, ["ArrowRight", "ArrowDown"])) return "\x05";
  if (metaOnly(event, ["Backspace"])) return "\x15";
  if (metaOnly(event, ["Delete"])) return "\x0b";
  return null;
}

export function handleKey({
  event,
  term,
  platform,
  clipboard,
  onNewTerminalTab,
  isBottomPanelToggle,
  onPaste,
  clearSession,
  sendText,
}: {
  event: KeyboardEvent;
  term: Pick<Terminal, "getSelection" | "hasSelection" | "paste">;
  platform: CodexRendererOs;
  clipboard?: Pick<Clipboard, "readText" | "writeText">;
  onNewTerminalTab?: () => void;
  isBottomPanelToggle?: (event: KeyboardEvent) => boolean;
  onPaste: () => boolean;
  clearSession: () => void;
  sendText: (data: string) => void;
}): boolean {
  if (event.type !== "keydown") return true;
  // Left unconsumed, so the application menu's accelerator hides the Terminal that opening focused.
  if (isBottomPanelToggle?.(event)) return false;
  if (onNewTerminalTab && metaOnly(event, ["t"])) {
    consume(event);
    onNewTerminalTab();
    return false;
  }
  const clear =
    event.key.toLowerCase() === "k" &&
    !event.altKey &&
    !event.shiftKey &&
    (platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
  if (clear) {
    consume(event);
    clearSession();
    return false;
  }
  if (clipboard) {
    const copy =
      (term.hasSelection() && ctrlKey(event, "c")) ||
      ctrlKey(event, "c", true) ||
      insert(event, true, false);
    if (copy) {
      consume(event);
      const text = term.getSelection();
      if (text.length > 0) void clipboard.writeText(text).catch(() => undefined);
      return false;
    }
    const paste =
      (platform === "win32" && ctrlKey(event, "v")) ||
      ctrlKey(event, "v", true) ||
      insert(event, false, true);
    if (paste) {
      consume(event);
      void clipboard
        .readText()
        .then((text) => {
          if (text.length > 0 && onPaste()) term.paste(text);
        })
        .catch(() => undefined);
      return false;
    }
  }
  const text = mapKey(event);
  if (text === null) return true;
  consume(event);
  sendText(text);
  return false;
}

/** Attribute xterm input to the DOM interaction that produced it. */
export function bindTerminalInput(
  term: Terminal,
  host: HTMLElement,
  isReplaying: () => boolean,
  send: (data: string, source: TerminalWriteSource) => void,
  recordInteraction?: () => void,
) {
  let active = true;
  let userInteraction = false;
  const markUser = () => {
    if (!active) return false;
    userInteraction = true;
    recordInteraction?.();
    // A canceled or empty DOM input should not mark the next parser reply as user input.
    queueMicrotask(() => {
      userInteraction = false;
    });
    return true;
  };
  const offData = term.onData((data) => {
    const user = userInteraction;
    userInteraction = false;
    if (user || !isReplaying()) send(data, user ? "user" : "terminal-generated");
  });
  const offKey = term.onKey(markUser);
  host.addEventListener("input", markUser, true);
  host.addEventListener("paste", markUser, true);
  return {
    markUser,
    dispose() {
      active = false;
      host.removeEventListener("input", markUser, true);
      host.removeEventListener("paste", markUser, true);
      offData.dispose();
      offKey.dispose();
    },
  };
}
