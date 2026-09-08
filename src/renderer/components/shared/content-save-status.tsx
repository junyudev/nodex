import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReceiptOptimisticActivity } from "@/lib/receipt-fenced-optimistic-journal";

interface ContentSaveStatusSource {
  getActivity(): ReceiptOptimisticActivity;
  subscribe(listener: () => void): () => void;
}

/** Local projection progress stays beside its content without shifting the editor or View. */
export function ContentSaveStatus({ source }: { readonly source: ContentSaveStatusSource }) {
  const phase = useSyncExternalStore(source.subscribe, () => {
    const activity = source.getActivity();
    if (activity.unknown > 0) return "unconfirmed";
    if (activity.pending > 0) return "saving";
    if (activity.acknowledged > 0) return "updating";
    return "idle";
  });
  const active = phase !== "idle";
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    if (!active) {
      setDelayed(false);
      return;
    }
    const timeout = setTimeout(() => setDelayed(true), 1000);
    return () => clearTimeout(timeout);
  }, [active]);
  const label =
    phase === "unconfirmed"
      ? "Save not confirmed"
      : active && delayed
        ? phase === "saving"
          ? "Saving…"
          : "Changes saved. Updating view…"
        : "";
  return (
    <span
      role="status"
      aria-live="polite"
      className="pointer-events-none absolute right-3 bottom-2 z-10 rounded-sm bg-token-main-surface-primary/90 px-1 text-xs text-token-text-secondary empty:hidden"
    >
      {label}
    </span>
  );
}
