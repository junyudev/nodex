import type { CodexDynamicToolCallView } from "../../../../../shared/types";

/** The Agent tools that start or address another chat, by what they did. */
const AGENT_SESSION_TOOL_LABELS = {
  create_session: {
    active: "Creating chat",
    completed: "Created chat",
    failed: "Couldn't create chat",
  },
  fork_session: { active: "Forking chat", completed: "Forked chat", failed: "Couldn't fork chat" },
  send_message_to_session: {
    active: "Messaging chat",
    completed: "Messaged chat",
    failed: "Couldn't message chat",
  },
} as const;

export const AGENT_SESSION_TOOLS = Object.keys(AGENT_SESSION_TOOL_LABELS) as Array<
  keyof typeof AGENT_SESSION_TOOL_LABELS
>;

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** The identity a completed create, fork or message call reports, so its row can open the chat. */
export function readAgentSessionToolTarget(
  call: CodexDynamicToolCallView,
): { readonly sessionId: string; readonly threadId: string } | null {
  if (!(call.tool in AGENT_SESSION_TOOL_LABELS) || !call.completed || call.success === false)
    return null;
  const text = call.contentItems?.find((item) => item.type === "inputText")?.text;
  let output: Record<string, unknown> | null = null;
  try {
    output = record(text === undefined ? null : JSON.parse(text));
  } catch {
    return null;
  }
  const sessionId = output?.sessionId;
  const threadId = output?.threadId;
  return typeof sessionId === "string" && sessionId && typeof threadId === "string" && threadId
    ? { sessionId, threadId }
    : null;
}

export function resolveAgentSessionToolLabel(call: CodexDynamicToolCallView): string | null {
  const labels = AGENT_SESSION_TOOL_LABELS[call.tool as keyof typeof AGENT_SESSION_TOOL_LABELS];
  if (!labels) return null;
  const verb = !call.completed
    ? labels.active
    : call.success === false
      ? labels.failed
      : labels.completed;
  const title = record(call.arguments)?.title;
  return typeof title === "string" && title.trim() ? `${verb}: ${title.trim()}` : verb;
}
