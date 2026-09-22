import type { DictationError } from "../../shared/dictation";
import type { GlobalDictationTarget } from "../../shared/global-dictation";
import type {
  DictationNativePastePort,
  DictationNativePasteOptions,
  DictationNativePasteResult,
} from "./dictation-native-helper-port";

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

/** Delegates each clipboard transaction to its platform authority. */
export class ClipboardSafePasteService {
  #settled: Promise<void> = Promise.resolve();
  readonly #helper: DictationNativePastePort;

  constructor(options: { readonly helper: DictationNativePastePort }) {
    this.#helper = options.helper;
  }

  async captureClipboardFingerprint(): Promise<string> {
    return await this.#helper.captureClipboardFingerprint();
  }

  async copy(transcript: string): Promise<void> {
    await this.#mutate(() => this.#helper.copy(transcript));
  }

  async paste(
    transcript: string,
    target?: GlobalDictationTarget,
    options: DictationNativePasteOptions = {},
  ): Promise<DictationNativePasteResult> {
    options.signal?.throwIfAborted();
    const insertedText = `${transcript.trim()} `;
    if (!insertedText.trim()) throw new ClipboardSafePasteError("paste-failed");
    try {
      return await this.#mutate(async () => {
        options.signal?.throwIfAborted();
        return await this.#helper.safePaste(insertedText, target, options);
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") throw error;
      throw new ClipboardSafePasteError("paste-failed");
    }
  }

  /** A replacement waits for the cancelled native transaction's restore/grace acknowledgement. */
  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#settled.then(operation);
    this.#settled = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
