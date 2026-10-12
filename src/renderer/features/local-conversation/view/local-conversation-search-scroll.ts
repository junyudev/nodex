/** Give mounted search units two layout frames before resolving their concrete mark. */
export function waitForLocalConversationSearchLayout(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let frame: number | null = null;
    const complete = () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      signal?.removeEventListener("abort", complete);
      resolve();
    };
    signal?.addEventListener("abort", complete, { once: true });
    frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(complete);
    });
  });
}

/** Resolves the exact addressed mark, including a deferred leaf, without falling back to another occurrence. */
export function scrollToLocalConversationSearchMatch(input: {
  readonly readMatch: () => HTMLElement | null;
  readonly scroll: (match: HTMLElement) => void;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<void> {
  if (input.signal?.aborted) return Promise.resolve();
  const current = input.readMatch();
  if (current) {
    input.scroll(current);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let frame: number | null = null;
    let timer: number | null = null;
    const complete = (match?: HTMLElement) => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      if (match && !input.signal?.aborted) input.scroll(match);
      resolve();
    };
    const abort = () => complete();
    const poll = () => {
      if (input.signal?.aborted) {
        complete();
        return;
      }
      const match = input.readMatch();
      if (match) {
        complete(match);
        return;
      }
      frame = window.requestAnimationFrame(poll);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    timer = window.setTimeout(abort, input.timeoutMs ?? 1_500);
    frame = window.requestAnimationFrame(poll);
  });
}
