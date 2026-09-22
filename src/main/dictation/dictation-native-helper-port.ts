import type {
  GlobalDictationPasteFailure,
  GlobalDictationTarget,
} from "../../shared/global-dictation";

export interface DictationNativePasteOptions {
  readonly clipboardFingerprint?: string;
  readonly recordingStoppedAtMs?: number;
  readonly signal?: AbortSignal;
}

export interface DictationNativePasteResult {
  readonly clipboardRestoreMs: number;
  readonly failure?: GlobalDictationPasteFailure;
}

export interface DictationNativePastePort {
  captureClipboardFingerprint(): Promise<string>;
  copy(text: string): Promise<void>;
  safePaste(
    text: string,
    target?: GlobalDictationTarget,
    options?: DictationNativePasteOptions,
  ): Promise<DictationNativePasteResult>;
}

export type DictationNativeHelperEvent =
  | {
      readonly type: "pressed" | "released" | "cancelled";
      readonly bindingId: string;
      readonly mode: "hold" | "toggle";
      readonly configurationGeneration: number;
      readonly processGeneration: number;
      readonly sequence: number;
      readonly target?: GlobalDictationTarget;
    }
  | { readonly type: "escape"; readonly processGeneration: number; readonly sequence: number }
  | {
      readonly type: "crashed";
      readonly processGeneration: number;
      readonly exitCode: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly diagnostic: string | null;
    };

/** Platform bindings stay opaque to the global capture lifecycle. */
export interface DictationNativeHelperPort<Binding> {
  captureBareModifier(signal?: AbortSignal): Promise<string>;
  queryBuiltInMicrophoneName(): Promise<string | null>;
  capabilities(
    prompt?: boolean,
  ): Promise<{ readonly inputMonitoring: boolean; readonly accessibility: boolean }>;
  requestAccessibility(): Promise<boolean>;
  requestInputMonitoring(): Promise<boolean>;
  setEscapeEnabled(enabled: boolean): Promise<void>;
  replaceBindings(input: {
    readonly generation: number;
    readonly bindings: readonly Binding[];
  }): Promise<void>;
  subscribe(listener: (event: DictationNativeHelperEvent) => void): () => void;
}

export class DictationNativeHelperRequestError extends Error {
  constructor(readonly code: string) {
    super(`Dictation helper request failed: ${code}`);
    this.name = "DictationNativeHelperRequestError";
  }
}
