import { persistedAtom, usePersistedAtomValue, useSetPersistedAtom } from "@/lib/maitai";

/** A conversation's subagents drawn as a map of who delegated what, or listed by status. */
export type SubagentsOverviewView = "map" | "list";

/** One choice for every chat and window: how the Subagents overview presents a work tree. */
const subagentsOverviewViewAtom = persistedAtom<SubagentsOverviewView>({
  debugLabel: "subagents-overview-view",
  storageKey: "nodex:subagents-overview-view:v1",
  defaultValue: "map",
  hydration: "eager",
  decode: (value) => (value === "list" ? "list" : "map"),
});

export function useSubagentsOverviewView() {
  const view = usePersistedAtomValue(subagentsOverviewViewAtom).value;
  const write = useSetPersistedAtom(subagentsOverviewViewAtom);
  const setView = (next: SubagentsOverviewView) => {
    void write(next).catch(() => {
      // The choice stays applied in this window; the next change retries the write.
    });
  };
  return { view, setView };
}
