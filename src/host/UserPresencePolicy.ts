/** Whether someone is using a computer, as its operating system reports it. */
export interface ActivitySample {
  /**
   * Time since the last keyboard or pointer input, rounded up to the system's one-second
   * resolution so that input is never placed later than it happened. Null where the system cannot
   * tell, such as some Linux sessions.
   */
  readonly idleMillis: number | null;
  readonly locked: boolean;
}

/** Nobody has touched this computer for this long: the person has stepped away from it. */
export const DESKTOP_AWAY_AFTER_MILLIS = 5 * 60_000;

/**
 * How often a desktop connected to a team Space tells it that its Member is there, and so how
 * soon that Space's host learns they came back. Core forgets a report after three intervals.
 */
export const PRESENCE_REPORT_INTERVAL_MILLIS = 30_000;

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
  sample: ActivitySample,
  sinceMillis: number,
  nowMillis: number,
  awayAfterMillis: number = DESKTOP_AWAY_AFTER_MILLIS,
): DesktopAttendance => {
  if (sample.locked || sample.idleMillis === null) return { type: "away" };
  if (nowMillis - sample.idleMillis > sinceMillis) return { type: "returned" };
  if (sample.idleMillis >= awayAfterMillis) return { type: "away" };
  return { type: "undecided", recheckAfterMillis: awayAfterMillis - sample.idleMillis };
};
