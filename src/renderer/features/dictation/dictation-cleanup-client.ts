import { cancelDictationRequest, cleanupDictationRequest } from "./dictation-command-runtime";

interface DictationCleanupRequest {
  readonly transcript: string;
  readonly surroundingText: string | null;
  readonly requestId: string;
}

/**
 * Runs best-effort semantic cleanup through Main. Cleanup is deliberately fail-open:
 * capture/transcription success must never be turned into a user-visible failure by this pass.
 */
export async function cleanupDictationTranscript(
  transcript: string,
  options?: {
    readonly surroundingText?: string | null;
    readonly signal?: AbortSignal;
    readonly cleanup?: (input: DictationCleanupRequest) => Promise<string>;
    readonly cancel?: (requestId: string) => Promise<boolean>;
  },
): Promise<string> {
  const original = transcript.trim();
  if (!original) return "";
  const signal = options?.signal;
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Dictation was aborted", "AbortError");
  }

  const requestId = crypto.randomUUID();
  const cleanup =
    options?.cleanup ??
    (async (input: DictationCleanupRequest) => await cleanupDictationRequest(input));
  const cancel = options?.cancel ?? (async (id: string) => await cancelDictationRequest(id));
  const abort = (): void => {
    void cancel(requestId).catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    const result = await cleanup({
      transcript: original,
      surroundingText: options?.surroundingText?.trim() || null,
      requestId,
    });
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Dictation was aborted", "AbortError");
    }
    return result.trim() || original;
  } catch (error) {
    if (signal?.aborted) throw error;
    return original;
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
