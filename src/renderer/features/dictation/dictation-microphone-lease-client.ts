import type { DictationSurface } from "../../../shared/dictation";

interface DictationMicrophoneLeasePorts {
  readonly acquire: (sessionId: string, surface: DictationSurface) => Promise<boolean>;
  readonly release: (sessionId: string) => Promise<unknown>;
  readonly subscribeRelinquish: (listener: (sessionId: string) => void) => () => void;
}

/** The capture controller releases physical resources before acknowledging Main's handoff. */
export const createDictationMicrophoneLeaseClient = (ports: DictationMicrophoneLeasePorts) => {
  const captures = new Map<string, { readonly unsubscribe: () => void }>();
  const releaseCapture = (sessionId: string): void => {
    const capture = captures.get(sessionId);
    if (!capture) return;
    captures.delete(sessionId);
    capture.unsubscribe();
  };
  return {
    acquire: async (
      sessionId: string,
      surface: DictationSurface,
      relinquish: () => void,
    ): Promise<boolean> => {
      releaseCapture(sessionId);
      let capture: { readonly unsubscribe: () => void };
      const unsubscribe = ports.subscribeRelinquish((requestedSessionId) => {
        if (requestedSessionId !== sessionId || captures.get(sessionId) !== capture) return;
        relinquish();
      });
      capture = { unsubscribe };
      captures.set(sessionId, capture);
      try {
        const acquired = await ports.acquire(sessionId, surface);
        if (!acquired && captures.get(sessionId) === capture) releaseCapture(sessionId);
        return acquired;
      } catch (error) {
        if (captures.get(sessionId) === capture) releaseCapture(sessionId);
        throw error;
      }
    },
    release: async (sessionId: string): Promise<void> => {
      releaseCapture(sessionId);
      await ports.release(sessionId);
    },
  };
};

/** Scoped preloads expose this media command independently of the application bridge. */
export const subscribeDictationMicrophoneRelinquish = (
  listener: (sessionId: string) => void,
): (() => void) => {
  if (window.globalDictation) return window.globalDictation.onMicrophoneRelinquish(listener);
  if (!window.api) return () => undefined;
  return window.api.on("dictation:microphone-relinquish", (value) => {
    if (value === null || typeof value !== "object") return;
    const sessionId = Reflect.get(value, "sessionId");
    if (typeof sessionId === "string") listener(sessionId);
  });
};
