export const AGENT_APPROVAL_TYPING_IDLE_MS = 1500;

export interface AgentApprovalTypingGuard {
  readonly seen: ReadonlySet<string>;
  readonly held: ReadonlySet<string>;
  readonly focused: boolean;
  readonly lastTypedAt: number;
}
export type AgentApprovalTypingEvent =
  | { readonly type: "requests"; readonly ids: readonly string[]; readonly now: number }
  | { readonly type: "type"; readonly now: number }
  | { readonly type: "focus" | "blur" | "send" | "idle" };

export const initialAgentApprovalTypingGuard = (): AgentApprovalTypingGuard => ({
  seen: new Set(),
  held: new Set(),
  focused: false,
  lastTypedAt: -Infinity,
});

/** A newly arriving approval cannot turn recent typing into an accidental answer. */
export function reduceAgentApprovalTypingGuard(
  state: AgentApprovalTypingGuard,
  event: AgentApprovalTypingEvent,
): AgentApprovalTypingGuard {
  if (event.type === "focus") return { ...state, focused: true };
  if (event.type === "type") return { ...state, lastTypedAt: event.now };
  if (event.type !== "requests")
    return {
      ...state,
      held: new Set(),
      lastTypedAt: -Infinity,
      focused: event.type !== "blur" && state.focused,
    };
  const present = new Set(event.ids);
  const seen = new Set(state.seen);
  const held = new Set([...state.held].filter((id) => present.has(id)));
  for (const id of event.ids) {
    if (seen.has(id)) continue;
    if (state.focused && event.now - state.lastTypedAt < AGENT_APPROVAL_TYPING_IDLE_MS)
      held.add(id);
    seen.add(id);
  }
  return { ...state, seen, held };
}
