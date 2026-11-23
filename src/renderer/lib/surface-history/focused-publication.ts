import type { SurfaceHistorySnapshot } from "../../../shared/surface-history";
import { areStructurallyEqual } from "../../../shared/structural-equality";
import { readFocusedHistory, subscribeFocusedHistory } from "../focused-history";
import { invokeRendererControl } from "../renderer-command";

/**
 * An attachment fence prevents a disposed renderer publisher from replacing newer focus.
 * Focus moves far more often than the history it reaches (every hovered menu row moves it),
 * so only a changed observation crosses to the native menu.
 */
export function publishFocusedHistory(): () => void {
  let active = true;
  let generation: number | undefined;
  let sequence = 0;
  let published: { readonly snapshot: SurfaceHistorySnapshot | null } | null = null;
  const publish = () => {
    if (generation === undefined) return;
    const snapshot = active ? readFocusedHistory() : null;
    if (published && areStructurallyEqual(published.snapshot, snapshot)) return;
    const publication = { snapshot };
    published = publication;
    void invokeRendererControl("surface-history:publish", {
      generation,
      sequence: ++sequence,
      snapshot,
    }).catch(() => {
      // An undelivered observation is retried by the next focus change.
      if (published === publication) published = null;
    });
  };
  const unsubscribe = subscribeFocusedHistory(publish);
  void invokeRendererControl("surface-history:bind")
    .then((bound) => {
      generation = bound;
      publish();
    })
    .catch(() => undefined);
  return () => {
    active = false;
    unsubscribe();
    publish();
  };
}
