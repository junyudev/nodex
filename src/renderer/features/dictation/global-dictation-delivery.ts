import type {
  GlobalDictationRendererCommand,
  GlobalDictationRendererEvent,
} from "../../../shared/global-dictation";

/** The event acknowledgement only accepts the text; completion comes from the native paste transaction. */
export function deliverGlobalDictation(input: {
  sessionId: string;
  transcript: string;
  signal: AbortSignal;
  sendEvent: (event: GlobalDictationRendererEvent) => Promise<boolean>;
  onCommand: (listener: (command: GlobalDictationRendererCommand) => void) => () => void;
}): Promise<{ readonly clipboardRestoreMs: number }> {
  return new Promise((resolve, reject) => {
    if (input.signal.aborted) {
      reject(input.signal.reason);
      return;
    }
    const release = (): void => {
      unsubscribe();
      clearTimeout(timeout);
      input.signal.removeEventListener("abort", abort);
    };
    const fail = (error: unknown): void => {
      release();
      reject(error);
    };
    const abort = (): void => fail(input.signal.reason);
    const unsubscribe = input.onCommand((command) => {
      if (command.type === "idle") {
        fail(new DOMException("Dictation was cancelled", "AbortError"));
        return;
      }
      if (!("sessionId" in command) || command.sessionId !== input.sessionId) return;
      if (command.type === "paste-completed") {
        release();
        resolve({ clipboardRestoreMs: command.clipboardRestoreMs });
      }
      if (command.type === "paste-failed") fail(new Error("Could not paste dictation"));
      if (command.type === "cancel" || command.type === "finish")
        fail(new DOMException("Dictation was cancelled", "AbortError"));
    });
    const timeout = setTimeout(() => fail(new Error("Dictation paste timed out")), 15_000);
    input.signal.addEventListener("abort", abort, { once: true });
    void input
      .sendEvent({ type: "completed", sessionId: input.sessionId, transcript: input.transcript })
      .then((accepted) => {
        if (!accepted) fail(new Error("Dictation paste was not accepted"));
      }, fail);
  });
}
