import { readFocusedHistory, subscribeFocusedHistory } from "../focused-history";
import { invokeRendererControl } from "../renderer-command";

/** An attachment fence prevents a disposed renderer publisher from replacing newer focus. */
export function publishFocusedHistory(): () => void {
  let active = true;
  let generation: number | undefined;
  let sequence = 0;
  const publish = () => {
    if (generation === undefined) return;
    void invokeRendererControl("surface-history:publish", {
      generation,
      sequence: ++sequence,
      snapshot: active ? readFocusedHistory() : null,
    }).catch(() => undefined);
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
