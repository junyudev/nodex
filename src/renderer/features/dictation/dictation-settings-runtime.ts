import { invokeRendererQuery } from "@/lib/renderer-command";

/** Captures the hardware Fn key through Main's short-lived native listener. */
export async function captureGlobalDictationFnHotkey(): Promise<string | null> {
  const hotkey = await invokeRendererQuery("global-dictation-capture-fn-hotkey");
  return hotkey === "Fn" ? hotkey : null;
}
