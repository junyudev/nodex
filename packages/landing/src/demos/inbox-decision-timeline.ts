import type { Cue } from "./timeline";

export const INBOX_CARD_EXIT_MS = 320;

const FIRST_APPROACH_MS = 360;
const REACTION_MS = 180;
const PRESS_MS = 100;
const OUTCOME_MS = 180;
const CLICK_INTERVAL_MS = 760;
const CLEAR_HOLD_MS = 120;

/** Anticipate the next button's landing position while the previous card is still leaving. */
export function buildInboxDecisionTimeline(
  ids: readonly string[],
  startAt: number,
): { readonly cues: readonly Cue[]; readonly clearAt: number } {
  if (ids.length === 0) return { cues: [], clearAt: startAt };

  const firstPress = startAt + FIRST_APPROACH_MS;
  const cues = ids.flatMap((id, index): Cue[] => {
    const press = firstPress + index * CLICK_INTERVAL_MS;
    const aim = index === 0 ? startAt : press - CLICK_INTERVAL_MS + REACTION_MS;
    const decided = press + PRESS_MS;
    return [
      { id: `aim:${id}`, at: aim },
      { id: `press:${id}`, at: press },
      { id: `decided:${id}`, at: decided },
      { id: `folded:${id}`, at: decided + OUTCOME_MS },
    ];
  });
  const lastPress = firstPress + (ids.length - 1) * CLICK_INTERVAL_MS;
  return {
    cues: cues.sort((a, b) => a.at - b.at),
    clearAt: lastPress + PRESS_MS + OUTCOME_MS + INBOX_CARD_EXIT_MS + CLEAR_HOLD_MS,
  };
}
