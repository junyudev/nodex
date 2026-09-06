import type { DictationError } from "../../shared/dictation";
import type { GlobalDictationTarget } from "../../shared/global-dictation";
import type { MacDictationNativeHelperClient } from "./mac-dictation-native-helper-client";

export class ClipboardSafePasteError extends Error {
  readonly dictationError: DictationError;

  constructor(kind: "accessibility-denied" | "paste-failed") {
    super(
      kind === "accessibility-denied"
        ? "Accessibility access is required"
        : "Could not paste dictation",
    );
    this.name = "ClipboardSafePasteError";
    this.dictationError = { kind, operation: "paste", retryable: true };
  }
}

/** Delegates the complete pasteboard transaction to one native NSPasteboard authority. */
export class ClipboardSafePasteService {
  readonly #helper: Pick<MacDictationNativeHelperClient, "capabilities" | "safePaste">;

  constructor(options: {
    readonly helper: Pick<MacDictationNativeHelperClient, "capabilities" | "safePaste">;
  }) {
    this.#helper = options.helper;
  }

  async paste(
    transcript: string,
    target: GlobalDictationTarget,
  ): Promise<{ readonly clipboardRestoreMs: number }> {
    const insertedText = `${transcript.trim()} `;
    if (!insertedText.trim()) throw new ClipboardSafePasteError("paste-failed");
    const capabilities = await this.#helper.capabilities(false);
    if (!capabilities.accessibility) throw new ClipboardSafePasteError("accessibility-denied");
    try {
      return await this.#helper.safePaste(insertedText, target);
    } catch {
      throw new ClipboardSafePasteError("paste-failed");
    }
  }
}
