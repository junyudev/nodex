import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { TOAST_DISMISS_MS } from "@/lib/timing";

interface UndoToastProps {
  action: "undo" | "redo" | null;
  description: string | null;
  onDismiss: () => void;
}

export function UndoToast({ action, description, onDismiss }: UndoToastProps) {
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const dismissTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Derive visibility directly from props
  const isVisible = action !== null && description !== null;

  useEffect(() => {
    // Clean up any existing timers
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }

    if (isVisible) {
      // Set timer to auto-dismiss after delay
      timerRef.current = setTimeout(() => {
        onDismiss();
      }, TOAST_DISMISS_MS);
    }

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
      }
    };
  }, [isVisible, onDismiss]);

  if (!isVisible) {
    return null;
  }

  return (
    <div
      className={cn(
        "fixed bottom-6 left-1/2 z-50 -translate-x-1/2",
        "rounded-lg px-4 py-2.5 shadow-lg",
        "border border-(--border-primary) bg-(--background-primary)",
        "text-sm text-(--foreground-primary)",
        "animate-in duration-200 fade-in slide-in-from-bottom-2"
      )}
    >
      <div className="flex items-center gap-2">
        {action === "undo" ? (
          <svg
            className="h-4 w-4 text-(--foreground-secondary)"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
            />
          </svg>
        ) : (
          <svg
            className="h-4 w-4 text-(--foreground-secondary)"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M21 10h-10a8 8 0 00-8 8v2M21 10l-6 6m6-6l-6-6"
            />
          </svg>
        )}
        <span>{description}</span>
      </div>
    </div>
  );
}
