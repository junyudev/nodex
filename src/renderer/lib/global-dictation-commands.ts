import type { GlobalDictationRendererCommand } from "../../shared/global-dictation";

export function subscribeDictationRecordingNavigation(
  listener: (recordingId: string) => void,
): () => void {
  if (!window.api) return () => undefined;
  return window.api.on("dictation:open-recording", (value) => {
    if (
      !value ||
      typeof value !== "object" ||
      !("recordingId" in value) ||
      typeof value.recordingId !== "string"
    )
      return;
    listener(value.recordingId);
  });
}

type RoutedGlobalDictationCommand = Extract<
  GlobalDictationRendererCommand,
  { readonly sessionId: string }
>;

/** Central renderer boundary for Main-owned global dictation commands. */
export function subscribeGlobalDictationCommands(
  listener: (command: RoutedGlobalDictationCommand) => void,
): () => void {
  if (!window.api) return () => undefined;
  return window.api.on("global-dictation:command", (value) => {
    if (!value || typeof value !== "object" || !("sessionId" in value)) return;
    listener(value as RoutedGlobalDictationCommand);
  });
}
