import { useEffect, useState } from "react";
import {
  createCommandKeymapState,
  COMMAND_KEYBINDINGS_CHANGED_CHANNEL,
  type CommandKeymapState,
} from "../../../shared/command-keybindings";
import { invokeRendererQuery } from "@/lib/renderer-command";

/** The Browser forwards only its own current bindings into the isolated guest. */
export function useBrowserAnnotationKeymap(): CommandKeymapState {
  const [state, setState] = useState(() =>
    createCommandKeymapState(
      {},
      navigator.platform.toUpperCase().includes("MAC") ? "macOS" : "linux",
    ),
  );
  useEffect(() => {
    let current = true;
    void invokeRendererQuery("codex-command-keymap-state")
      .then((value) => {
        if (current && value?.entries) setState(value);
      })
      .catch((error) => console.warn("Could not load Browser annotation shortcut", error));
    const stop = window.api?.on(COMMAND_KEYBINDINGS_CHANGED_CHANNEL, (value) => {
      current = false;
      setState(value as CommandKeymapState);
    });
    return () => {
      current = false;
      stop?.();
    };
  }, []);
  return state;
}
