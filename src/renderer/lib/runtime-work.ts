import {
  createRuntimeWorkLedger,
  type RuntimeWorkLedger,
} from "../../shared/diagnostics/runtime-work";

/** One Performance timeline report per navigation or stream batch, after this much quiet. */
const RUNTIME_WORK_SETTLE_MS = 1_000;
export const RUNTIME_WORK_MARK = "nodex.runtime.work";

let ledger: RuntimeWorkLedger | null = null;
let nextWork = 0;

/**
 * Counts this window's Runtime conversation work while development runtime metrics are on. Each
 * settled work becomes a `nodex.runtime.work` Performance mark; nothing leaves the window.
 */
export function enableRendererRuntimeWork(): void {
  ledger ??= createRuntimeWorkLedger({
    settleMs: RUNTIME_WORK_SETTLE_MS,
    onSettled: (work, metrics) =>
      performance.mark(RUNTIME_WORK_MARK, { detail: { work, metrics } }),
  });
}

/** Null unless enabled, so every counting site costs one check otherwise. */
export const rendererRuntimeWork = (): RuntimeWorkLedger | null => ledger;

/** Replaces the window's ledger, returning the previous one's restore; for tests. */
export function replaceRendererRuntimeWork(next: RuntimeWorkLedger | null): () => void {
  const previous = ledger;
  ledger = next;
  return () => {
    ledger = previous;
  };
}

/** A window-local identity for work outside a navigation; Main qualifies it with the window. */
export const nextRendererRuntimeWorkId = (): string => `read-${++nextWork}`;
