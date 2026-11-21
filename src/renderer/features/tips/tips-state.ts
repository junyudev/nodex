import { useCallback } from "react";
import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";
import { normalizeSettledTips, settleTips, type TipId, type TipsState } from "./tips-model";

// The switch and the tips that have had their turn are written apart, so that settling a tip in
// one window never carries an older reading of the switch with it.
const tipsOnAtom = persistedAtom<boolean>({
  debugLabel: "tips-on",
  storageKey: "nodex:tips-on:v1",
  defaultValue: true,
  hydration: "eager",
  synchronization: "cross-window",
  optimistic: true,
  writeFailure: "retain-and-error",
  decode: (value) => value !== false,
});

const settledTipsAtom = persistedAtom<readonly TipId[]>({
  debugLabel: "tips-settled",
  storageKey: "nodex:tips-settled:v1",
  defaultValue: [],
  hydration: "eager",
  synchronization: "cross-window",
  optimistic: true,
  writeFailure: "retain-and-error",
  decode: normalizeSettledTips,
});

/** Which tips a person has had, and whether they want any; null until read. */
export function useTipsState() {
  const on = usePersistedAtomValue(tipsOnAtom);
  const settled = usePersistedAtomValue(settledTipsAtom);
  const writeOn = useSetPersistedAtom(tipsOnAtom);
  const writeSettled = useSetPersistedAtom(settledTipsAtom);
  // A tip that fails to save has still had its turn in this window, and nothing waits on it.
  const settle = useCallback(
    (...tips: readonly TipId[]) =>
      void writeSettled((current) => settleTips(current, tips)).catch(() => undefined),
    [writeSettled],
  );
  const state: TipsState | null =
    on.status === "loading" || settled.status === "loading"
      ? null
      : { on: on.value, settled: settled.value };
  return { state, settle, setOn: writeOn };
}
