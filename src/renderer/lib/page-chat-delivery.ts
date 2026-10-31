import type { AgentRuntimeSessionActivity } from "../../shared/agent-runtime-api";

/** How a Page send reaches its chat: at once, after the current Turn, or into it. */
export type PageChatDelivery = "send" | "queue" | "steer";

/**
 * A chat in a Turn takes a Page send the way its Composer would: by the Queue or Steer default.
 * Content that must start its own Turn, such as a Prompt with Agent config, always queues.
 */
export function resolvePageChatDelivery(input: {
  readonly status: AgentRuntimeSessionActivity["status"] | null;
  readonly queueFollowUps: boolean;
  readonly startsNewTurn?: boolean;
}): PageChatDelivery {
  const inTurn = input.status === "running" || input.status === "waiting";
  if (!inTurn) return "send";
  return input.queueFollowUps || input.startsNewTurn ? "queue" : "steer";
}

/** The second line of a send control's tooltip; a plain send needs none. */
export function describePageChatDelivery(delivery: PageChatDelivery): string | null {
  if (delivery === "queue") return "Queues after its current turn";
  if (delivery === "steer") return "Steers its current turn";
  return null;
}
