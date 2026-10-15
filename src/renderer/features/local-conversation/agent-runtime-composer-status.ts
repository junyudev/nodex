import type {
  AgentRuntimeConnectionState,
  AgentRuntimeSessionActivity,
} from "../../../shared/agent-runtime-api";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Explains why a chat with no foreground Run is not finished: live background work, and
 * whether a delegated result will start the Agent again without the user.
 */
export function agentRuntimeBackgroundStatus(
  activity: Pick<
    AgentRuntimeSessionActivity,
    "status" | "activeTaskCount" | "resumesAutomatically"
  > | null,
): string | null {
  if (activity?.status !== "background") return null;
  const resumes = activity.resumesAutomatically ? " · resumes automatically" : "";
  if (activity.activeTaskCount > 0)
    return `Waiting for ${plural(activity.activeTaskCount, "background task")}${resumes}`;
  return activity.resumesAutomatically
    ? "Resumes automatically when background results arrive"
    : "Background work is still running";
}

/** Execution availability, shown only while it differs from ready. */
export function agentRuntimeConnectionStatus(
  state: AgentRuntimeConnectionState,
): { readonly message: string; readonly tone: "neutral" | "danger" } | null {
  switch (state.status) {
    case "idle":
    case "ready":
      return null;
    case "starting":
      return { message: "Starting Agent execution…", tone: "neutral" };
    case "restarting":
      return { message: "Agent execution stopped unexpectedly · restarting…", tone: "neutral" };
    case "failed":
      return { message: `Agent execution is unavailable: ${state.message}`, tone: "danger" };
  }
}
