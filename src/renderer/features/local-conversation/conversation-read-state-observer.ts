import type { CodexHostMessage } from "../../../shared/types";

export interface ConversationReadActivityToken {
  readonly hostId: string;
  readonly threadId: string;
  readonly activity: Extract<CodexHostMessage, { type: "threadReadActivity" }>["activity"];
}

export interface ConversationReadStateInput {
  identity: string | null;
  active: boolean;
  hasConversation: boolean;
  hasUnreadTurn: boolean;
  hasPersistedUnreadTurn: boolean;
  latestRequestId: string | number | null;
  latestTurnId: string | null;
  latestTurnStatus: string | null;
  /** The caller scopes acknowledged activity to this conversation and execution host. */
  activityToken: ConversationReadActivityToken | null;
}

export interface ConversationReadObservation {
  identity: string;
  latestRequestId: string | number | null;
  latestTurnId: string | null;
  latestTurnStatus: string | null;
  activityToken: ConversationReadActivityToken | null;
}

/** Remember observed activity so a deliberate unread marker survives unchanged activity. */
export function observeConversationReadState(
  previous: ConversationReadObservation | null,
  input: ConversationReadStateInput & { focused: boolean },
): { observation: ConversationReadObservation | null; shouldMarkRead: boolean } {
  if (!input.active || input.identity === null) return { observation: null, shouldMarkRead: false };

  const observation = previous?.identity === input.identity ? previous : null;
  if (!input.focused) return { observation, shouldMarkRead: false };

  const activityMatches =
    input.activityToken?.activity.type === "request" ||
    (input.activityToken?.activity.type === "turn-completed" &&
      input.activityToken.activity.turnId === input.latestTurnId);
  const next: ConversationReadObservation = {
    identity: input.identity,
    latestRequestId: input.latestRequestId,
    latestTurnId: input.latestTurnId,
    latestTurnStatus: input.latestTurnStatus,
    activityToken: activityMatches ? input.activityToken : (observation?.activityToken ?? null),
  };
  // Accepted activity can reach the viewport before its unread projection catches up.
  const unreadActivity =
    input.activityToken !== null &&
    input.activityToken !== observation?.activityToken &&
    activityMatches;
  if (unreadActivity) return { observation: next, shouldMarkRead: true };
  if (!input.hasUnreadTurn && !input.hasPersistedUnreadTurn)
    return {
      observation: input.hasConversation ? next : observation,
      shouldMarkRead: false,
    };

  const shouldMarkRead =
    observation === null ||
    (input.hasPersistedUnreadTurn && !input.hasUnreadTurn) ||
    input.latestRequestId !== observation.latestRequestId ||
    input.latestTurnId !== observation.latestTurnId ||
    input.latestTurnStatus !== observation.latestTurnStatus;
  return { observation: shouldMarkRead ? next : observation, shouldMarkRead };
}

export interface ConversationReadInteraction {
  defaultPrevented: boolean;
  type: string;
  key?: string;
}

export function isConversationReadInteraction(event: ConversationReadInteraction): boolean {
  if (event.defaultPrevented) return false;
  if (event.type !== "keydown") return true;
  return !["Meta", "Control", "Alt", "AltGraph", "Shift"].includes(event.key ?? "");
}
