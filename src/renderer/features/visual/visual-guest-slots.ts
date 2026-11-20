import { VISUAL_LIMITS } from "../../../shared/visual/contract";

const waiting = new Set<() => void>();
let active = 0;

function offerSlot() {
  if (active >= VISUAL_LIMITS.liveGuests) return;
  const next = waiting.values().next().value;
  if (!next) return;
  waiting.delete(next);
  active++;
  next();
}

/** Allocate only to mounted, near-viewport frames. Main independently enforces the cap. */
export function requestVisualGuestSlot(acquire: () => void) {
  waiting.add(acquire);
  offerSlot();
  return () => {
    if (waiting.delete(acquire)) return;
    active--;
    offerSlot();
  };
}
