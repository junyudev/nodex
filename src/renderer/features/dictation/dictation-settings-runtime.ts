import { subscribeCodexEvents } from "@/lib/api";
import type { CodexDictationStateSnapshot } from "../../../shared/types";
import { normalizeMacBareModifier } from "../../../shared/command-keybindings";
import {
  defineRendererCommand,
  invokePlainCommand,
  invokeRendererControl,
  invokeRendererQuery,
} from "@/lib/renderer-command";

const updateVoiceLanguageCommand = defineRendererCommand({
  key: "dictation.update_voice_language",
  channel: "codex:dictation:voice-language:update",
  authority: "external",
  owner: "VoiceSettings",
  protocol: { kind: "returned_value" },
});

/** Reads the active ChatGPT account's language preference. */
export function readDictationVoiceLanguage(): Promise<string> {
  return invokeRendererQuery("codex:dictation:voice-language:read");
}

export function updateDictationVoiceLanguage(language: string): Promise<string> {
  return invokePlainCommand(updateVoiceLanguageCommand, language);
}

/** Ends this renderer's native shortcut capture and releases suspended global bindings. */
export function cancelGlobalDictationHotkeyCapture(): Promise<boolean> {
  return invokeRendererControl("global-dictation-hotkey-capture:cancel");
}

/** Suspends global shortcuts until capture ends; bare gesture polling is optional. */
export async function captureGlobalDictationBareModifierHotkey(
  signal: AbortSignal,
  allowsBareModifiers: boolean,
): Promise<string | null> {
  if (signal?.aborted) return null;
  const cancel = (): void => {
    void cancelGlobalDictationHotkeyCapture().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const hotkey = await invokeRendererQuery(
      "global-dictation-capture-bare-modifier-hotkey",
      allowsBareModifiers,
    );
    if (signal?.aborted) return null;
    return !allowsBareModifiers || hotkey === null ? null : normalizeMacBareModifier(hotkey);
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function subscribeDictationSettingsUpdates(
  listener: (
    event:
      | { readonly type: "capabilities"; readonly state: CodexDictationStateSnapshot }
      | { readonly type: "account-changed" },
  ) => void,
): () => void {
  return subscribeCodexEvents((event) => {
    if (event.type === "dictationState") listener({ type: "capabilities", state: event.state });
    if (event.type === "account") listener({ type: "account-changed" });
  });
}
