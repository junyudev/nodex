export interface ApplicationMenubarKeyboardState {
  readonly altPending: boolean;
  readonly focused: boolean;
  readonly open: boolean;
}
export type ApplicationMenubarKeyAction =
  | "alt"
  | "toggle"
  | "close"
  | "cancel-alt"
  | { readonly mnemonic: string }
  | null;

/** Only claims the Windows menubar's reserved keys; popup navigation stays with the menu engine. */
export function resolveApplicationMenubarKey(
  event: Pick<
    KeyboardEvent,
    "key" | "repeat" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "isComposing"
  >,
  state: ApplicationMenubarKeyboardState,
  phase: "down" | "up",
): ApplicationMenubarKeyAction {
  if (event.isComposing || event.repeat) return null;
  if (phase === "up") return event.key === "Alt" && state.altPending ? "toggle" : null;
  if (event.key === "Alt")
    return !event.ctrlKey && !event.metaKey && !event.shiftKey ? "alt" : null;
  const unmodified = !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
  if (event.key === "F10" && unmodified) return "toggle";
  if (event.key === "Escape" && (state.focused || state.open)) return "close";
  if (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.shiftKey &&
    (event.altKey || (state.focused && !state.open)) &&
    event.key.length === 1
  ) {
    return { mnemonic: event.key.toLowerCase() };
  }
  return state.altPending ? "cancel-alt" : null;
}

/** Electron accelerator presentation intentionally differs from ordinary shortcut labels. */
export function formatWindowsMenuAccelerator(accelerator: string): string {
  const modifiers = new Set<string>();
  const keys: string[] = [];
  for (const part of accelerator.split("+")) {
    const key = part.toLowerCase();
    if (["commandorcontrol", "cmdorctrl", "control", "ctrl"].includes(key)) modifiers.add("Ctrl");
    else if (["command", "cmd", "super", "meta"].includes(key)) modifiers.add("Win");
    else if (["option", "alt"].includes(key)) modifiers.add("Alt");
    else if (key === "shift") modifiers.add("Shift");
    else if (key === "plus") {
      modifiers.add("Shift");
      keys.push("=");
    } else keys.push(part);
  }
  return [...["Win", "Alt", "Ctrl", "Shift"].filter((key) => modifiers.has(key)), ...keys].join(
    "+",
  );
}
