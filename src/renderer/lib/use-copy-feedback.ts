import { useEffect, useRef, useState } from "react";

/**
 * Runs a clipboard write and confirms success for a moment. Presses while a write is running or
 * its confirmation is showing are ignored, and the confirmation never outlives the component.
 */
export function useCopyFeedback(feedbackMs: number): {
  readonly copied: boolean;
  /** Resolves whether the write succeeded; a thrown write counts as a failure. */
  readonly copy: (write: () => Promise<boolean>) => Promise<boolean>;
} {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const copyingRef = useRef(false);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (resetTimerRef.current !== null) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  const copy = async (write: () => Promise<boolean>): Promise<boolean> => {
    if (resetTimerRef.current !== null || copyingRef.current) return false;
    copyingRef.current = true;
    let didCopy: boolean;
    try {
      didCopy = await write();
    } catch {
      didCopy = false;
    } finally {
      copyingRef.current = false;
    }
    if (!didCopy || !mountedRef.current) return didCopy;
    setCopied(true);
    resetTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      resetTimerRef.current = null;
    }, feedbackMs);
    return true;
  };

  return { copied, copy };
}
