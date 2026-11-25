import type { AgentRuntimeMethod } from "./Interface.ts";

/**
 * Reads someone is looking at a blank surface for, answered from the execution store alone. They
 * are admitted ahead of other requests on both sides of the process boundary and read on the
 * store's foreground lane. Work that is slow by nature, such as generating text or importing
 * history, is deliberately absent.
 */
export const AGENT_RUNTIME_WATCHED_READS: ReadonlySet<AgentRuntimeMethod> =
  new Set<AgentRuntimeMethod>([
    "thread.read",
    "thread.snapshot",
    "thread.control",
    "thread.history",
    "thread.timeline",
    "thread.queue",
    "thread.queued-preview",
    "thread.run-message",
    "threads.latest-replies",
    "thread.questions.list",
    "thread.prompt-index",
    "thread.item",
    "thread.item.full",
    "thread.item.content",
    "thread.attachment",
    "tasks.overview",
    "tasks.overviews",
    "execution.recent-runs",
    "events.observe",
  ]);

export const isAgentRuntimeWatchedRead = (method: unknown): boolean =>
  typeof method === "string" && AGENT_RUNTIME_WATCHED_READS.has(method as AgentRuntimeMethod);
