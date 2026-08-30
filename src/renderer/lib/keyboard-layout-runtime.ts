import type { KeyboardLayoutSnapshot } from "../../shared/command-keybindings";
import { invokeRendererControl } from "./renderer-command";

/** Publishes the renderer's current physical-key projection to Main. */
export function publishKeyboardLayout(snapshot: KeyboardLayoutSnapshot) {
  return invokeRendererControl("global-dictation:keyboard-layout:update", snapshot);
}
