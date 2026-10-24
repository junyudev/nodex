import { useEffect, useEffectEvent, useRef, useState } from "react";
import { getWindowFocusState, subscribeWindowFocusChanges } from "./local-conversation-deps";
import {
  isConversationReadInteraction,
  observeConversationReadState,
  type ConversationReadInteraction,
  type ConversationReadObservation,
  type ConversationReadStateInput,
} from "./conversation-read-state-observer";

export type { ConversationReadActivityToken } from "./conversation-read-state-observer";

export interface UseConversationReadStateInput extends ConversationReadStateInput {
  onMarkRead(): void;
}

/** Native window focus remains authoritative when embedded guests own DOM focus. */
function useConversationWindowFocus(): boolean {
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    let disposed = false;
    let nativeFocus: boolean | null = null;
    let receivedFocusChange = false;
    let fallbackAvailable = false;
    const update = () => {
      if (disposed) return;
      setFocused(
        document.visibilityState !== "hidden" &&
          (nativeFocus ?? (fallbackAvailable && document.hasFocus())),
      );
    };
    const stopFocus = subscribeWindowFocusChanges((value) => {
      receivedFocusChange = true;
      nativeFocus = value;
      update();
    });
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    void Promise.resolve()
      .then(getWindowFocusState)
      .then((value) => {
        if (disposed || receivedFocusChange) return;
        if (typeof value === "boolean") nativeFocus = value;
        else fallbackAvailable = true;
        update();
      })
      .catch(() => {
        if (disposed || receivedFocusChange) return;
        fallbackAvailable = true;
        update();
      });
    return () => {
      disposed = true;
      stopFocus();
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return focused;
}

export function useConversationReadState(input: UseConversationReadStateInput): {
  onReadInteraction(event: ConversationReadInteraction): void;
} {
  const {
    identity,
    active,
    hasConversation,
    hasUnreadTurn,
    hasPersistedUnreadTurn,
    latestRequestId,
    latestTurnId,
    latestTurnStatus,
    activityToken,
    onMarkRead,
  } = input;
  const focused = useConversationWindowFocus();
  const observation = useRef<ConversationReadObservation | null>(null);
  const markRead = useEffectEvent(onMarkRead);
  useEffect(() => {
    const next = observeConversationReadState(observation.current, {
      identity,
      active,
      hasConversation,
      hasUnreadTurn,
      hasPersistedUnreadTurn,
      latestRequestId,
      latestTurnId,
      latestTurnStatus,
      activityToken,
      focused,
    });
    observation.current = next.observation;
    if (next.shouldMarkRead) markRead();
  }, [
    identity,
    active,
    hasConversation,
    hasUnreadTurn,
    hasPersistedUnreadTurn,
    latestRequestId,
    latestTurnId,
    latestTurnStatus,
    activityToken,
    focused,
  ]);
  return {
    onReadInteraction(event) {
      if (!active || identity === null || (!hasUnreadTurn && !hasPersistedUnreadTurn)) return;
      if (!isConversationReadInteraction(event)) return;
      onMarkRead();
    },
  };
}
