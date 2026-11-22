// Ticks are five seconds of Main's own scheduler rather than elapsed time, so a stall of Main or a
// sleeping computer counts as one tick instead of looking like the process's silence. Lag comes
// from the process's watchdog thread, which measures its control loop while that loop is blocked.

/**
 * Ready: what someone waits for is moving normally. Busy: it is moving slowly, as on a computer
 * running many builds; nothing needs the person. Unresponsive: it has stopped moving for long
 * enough that only replacing the process can help.
 */
export type AgentRuntimeLiveness = "ready" | "busy" | "unresponsive";

/** A control loop gap long enough to slow what someone is waiting for. */
export const AGENT_RUNTIME_BUSY_LAG_MS = 2_000;
/** A control loop that has made no progress for a minute is stuck, not busy. */
export const AGENT_RUNTIME_STUCK_LAG_MS = 60_000;
/** About ten seconds without a health report: the process is barely getting to run. */
export const AGENT_RUNTIME_BUSY_SILENT_TICKS = 2;
/** About a minute without one: the process has stopped running. */
export const AGENT_RUNTIME_STUCK_SILENT_TICKS = 12;
/** About ten seconds: a watched read is slower than it should be. */
export const AGENT_RUNTIME_SLOW_READ_TICKS = 2;
/** About two minutes: a read can be stuck while the process keeps making progress. */
export const AGENT_RUNTIME_STALLED_READ_TICKS = 24;

/**
 * Silence counts only while a request waits and only once the process has reported health, so an
 * idle process is never judged and a process without the health channel is never called silent.
 */
export const nextAgentRuntimeSilentTicks = (
  previous: number,
  pending: boolean,
  reported: boolean,
): number => (!pending || reported ? 0 : Math.min(previous + 1, AGENT_RUNTIME_STUCK_SILENT_TICKS));

export interface AgentRuntimeLivenessInput {
  /** A request is waiting for the process. */
  readonly pending: boolean;
  readonly silentTicks: number;
  /** The longest control loop gap in the latest health report, including one still open. */
  readonly lagMs: number;
  /** Age of the oldest read someone is waiting to see, including its admission wait. */
  readonly oldestReadAgeTicks: number;
}

export const classifyAgentRuntimeLiveness = ({
  pending,
  silentTicks,
  lagMs,
  oldestReadAgeTicks,
}: AgentRuntimeLivenessInput): AgentRuntimeLiveness => {
  if (!pending) return "ready";
  if (
    lagMs >= AGENT_RUNTIME_STUCK_LAG_MS ||
    silentTicks >= AGENT_RUNTIME_STUCK_SILENT_TICKS ||
    oldestReadAgeTicks >= AGENT_RUNTIME_STALLED_READ_TICKS
  )
    return "unresponsive";
  if (
    lagMs >= AGENT_RUNTIME_BUSY_LAG_MS ||
    silentTicks >= AGENT_RUNTIME_BUSY_SILENT_TICKS ||
    oldestReadAgeTicks >= AGENT_RUNTIME_SLOW_READ_TICKS
  )
    return "busy";
  return "ready";
};
