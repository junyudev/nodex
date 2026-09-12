import { useCallback } from "react";

import { codexTurnFirstResponseTracker } from "./codex-turn-first-response";

export function CodexAfterPaintMarker({ onPaint }: { onPaint: () => void }) {
  const ref = useCallback(
    (element: HTMLSpanElement | null) => {
      if (element === null) return;
      let firstFrame: number | null = null;
      let secondFrame: number | null = null;
      const paint = () => {
        if (document.visibilityState !== "visible" || firstFrame !== null) return;
        firstFrame = window.requestAnimationFrame(() => {
          secondFrame = window.requestAnimationFrame(() => {
            document.removeEventListener("visibilitychange", paint);
            onPaint();
          });
        });
      };
      document.addEventListener("visibilitychange", paint);
      paint();
      return () => {
        document.removeEventListener("visibilitychange", paint);
        if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
        if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      };
    },
    [onPaint],
  );
  return <span ref={ref} className="hidden" />;
}

export function CodexFirstResponseVisibilityMarker({
  clientUserMessageId,
}: {
  clientUserMessageId: string;
}) {
  const ref = useCallback(
    (element: HTMLSpanElement | null) => {
      if (element === null) return;
      let firstFrame: number | null = null;
      let secondFrame: number | null = null;
      let observer: IntersectionObserver | null = null;
      const markVisible = () => {
        if (firstFrame !== null) return;
        observer?.disconnect();
        firstFrame = window.requestAnimationFrame(() => {
          secondFrame = window.requestAnimationFrame(() => {
            codexTurnFirstResponseTracker.markFirstResponseVisible(clientUserMessageId);
          });
        });
      };
      if (typeof IntersectionObserver === "undefined") {
        markVisible();
      } else {
        observer = new IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) markVisible();
        });
        observer.observe(element);
      }
      return () => {
        observer?.disconnect();
        if (firstFrame !== null) window.cancelAnimationFrame(firstFrame);
        if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
      };
    },
    [clientUserMessageId],
  );

  return (
    <span
      ref={ref}
      className="pointer-events-none -mb-px inline-block h-px w-px opacity-0"
      aria-hidden="true"
    />
  );
}
