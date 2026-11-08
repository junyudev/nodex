import type { SystemActivitySample } from "../platform/electron/SystemActivity";

/** Nobody has touched this computer for this long: the person has stepped away from it. */
export const DESKTOP_AWAY_AFTER_MILLIS = 5 * 60_000;

/**
 * Whether the person stayed at this computer after something happened at `sinceMillis`.
 *
 * - `returned`: there was input after it, so they were here to be told by the computer.
 * - `away`: the screen is locked, or nobody has touched the computer for the away threshold, so
 *   they left before it could reach them. A system that cannot report input counts as away, so a
 *   guess never silences the phone.
 * - `undecided`: neither is known yet; ask again after `recheckAfterMillis`, the earliest moment
 *   the away threshold can be reached.
 */
export type DesktopAttendance =
  | { readonly type: "returned" }
  | { readonly type: "away" }
  | { readonly type: "undecided"; readonly recheckAfterMillis: number };

export const desktopAttendanceSince = (
  sample: SystemActivitySample,
  sinceMillis: number,
  nowMillis: number,
  awayAfterMillis: number = DESKTOP_AWAY_AFTER_MILLIS,
): DesktopAttendance => {
  if (sample.locked || sample.idleMillis === null) return { type: "away" };
  if (nowMillis - sample.idleMillis > sinceMillis) return { type: "returned" };
  if (sample.idleMillis >= awayAfterMillis) return { type: "away" };
  return { type: "undecided", recheckAfterMillis: awayAfterMillis - sample.idleMillis };
};
