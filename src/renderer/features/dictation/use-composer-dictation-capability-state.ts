import { useEffect, useState } from "react";
import { readDictationCapabilityState } from "@/lib/api";
import type { CodexDictationStateSnapshot } from "../../../shared/types";
import { subscribeDictationSettingsUpdates } from "./dictation-settings-runtime";

/** Read Main's shared capability snapshot in a media-capable renderer, including Capture. */
export function useComposerDictationCapabilityState(enabled: boolean) {
  const available = enabled && typeof window !== "undefined" && Boolean(window.api);
  const [state, setState] = useState<CodexDictationStateSnapshot | null>(null);

  useEffect(() => {
    if (!available) return;
    let current = true;
    let generation = 0;
    const refresh = () => {
      generation = generation + 1;
      const requested = generation;
      void readDictationCapabilityState().then(
        (snapshot) => {
          if (current && requested === generation) setState(snapshot);
        },
        () => undefined,
      );
    };
    const unsubscribe = subscribeDictationSettingsUpdates((event) => {
      if (!current) return;
      if (event.type === "account-changed") {
        refresh();
        return;
      }
      generation = generation + 1;
      setState(event.state);
    });
    refresh();
    return () => {
      current = false;
      unsubscribe();
    };
  }, [available]);

  return available ? state : null;
}
