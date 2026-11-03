import { useEffect } from "react";

/** Returning from native settings can focus Electron without changing document visibility. */
export function useRefetchOnFocus(enabled: boolean, refetch: () => Promise<unknown>): void {
  useEffect(() => {
    if (!enabled) return;
    const refresh = () => {
      void refetch();
    };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [enabled, refetch]);
}
