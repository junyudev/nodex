// All of this is counted in scheduler ticks of five seconds rather than elapsed time, so a stall of
// Main or a sleeping computer counts as one tick instead of looking like the process's silence.

/** About 30 seconds: rare enough on a busy computer not to invite a needless Restart. */
export const AGENT_RUNTIME_UNRESPONSIVE_SILENT_TICKS = 6;
/** About two minutes: a read can be stuck while the process still answers every check. */
export const AGENT_RUNTIME_STALLED_READ_TICKS = 24;

export const nextAgentRuntimeSilentTicks = (
  previous: number,
  pending: boolean,
  receivedFrame: boolean,
): number =>
  !pending || receivedFrame ? 0 : Math.min(previous + 1, AGENT_RUNTIME_UNRESPONSIVE_SILENT_TICKS);

export const isAgentRuntimeResponsive = (
  silentTicks: number,
  oldestReadAgeTicks: number,
): boolean =>
  silentTicks < AGENT_RUNTIME_UNRESPONSIVE_SILENT_TICKS &&
  oldestReadAgeTicks < AGENT_RUNTIME_STALLED_READ_TICKS;
