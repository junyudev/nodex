/** Waits for a visible document, then two frames; cleanup releases frames and the listener. */
export function scheduleAfterPaint(
  callback: () => void,
  options: { readonly requireVisibleAtPaint?: boolean } = {},
): () => void {
  let firstFrame: number | null = null;
  let secondFrame: number | null = null;
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    document.removeEventListener("visibilitychange", paint);
    if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
    if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
  };
  const paint = () => {
    if (disposed || document.visibilityState !== "visible" || firstFrame !== null) return;
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        if (options.requireVisibleAtPaint && document.visibilityState !== "visible") {
          firstFrame = null;
          secondFrame = null;
          return;
        }
        cleanup();
        callback();
      });
    });
  };
  document.addEventListener("visibilitychange", paint);
  paint();
  return cleanup;
}
