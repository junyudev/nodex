import * as Duration from "effect/Duration";

export const FILE_INDEX_TIMINGS = {
  /** How long a root with no open search stays indexed and watched. */
  idleRelease: Duration.minutes(5),
  /** File changes are applied once they have been quiet this long... */
  changeSettle: Duration.millis(100),
  /** ...or once they have waited this long. */
  changeMaxDelay: Duration.seconds(1),
  watchRetry: Duration.seconds(5),
  publishInterval: Duration.millis(32),
} as const;
