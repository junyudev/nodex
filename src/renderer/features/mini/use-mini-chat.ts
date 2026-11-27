import type { ChatState, MobileEventData } from "@nodex/mobile-protocol";
import { useEffect, useState } from "react";
import { createUuidV7 } from "../../../shared/uuid-v7";
import { companion, miniHost } from "./mini-host";

type ChatPatch = MobileEventData<"chat.patch">;

/**
 * Follows one chat's live state (its requests, its current Run) while a card that can act on it is
 * on screen, the way the phone follows a chat it has open.
 */
export function useMiniChatState(sessionId: string, enabled: boolean): ChatState | null {
  const [state, setState] = useState<{
    readonly sessionId: string;
    readonly value: ChatState;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    // Null until the first snapshot; patches that arrive before it wait for it.
    let revision: number | null = null;
    let early: ChatPatch[] = [];
    let reading = false;
    let open = true;
    const show = (value: ChatState) => setState({ sessionId, value });
    const snapshot = (next: number, value: ChatState) => {
      // A snapshot never rolls back what a newer patch showed; one at the same revision resets.
      if (revision !== null && next < revision) return;
      revision = next;
      show(value);
      const waiting = early;
      early = [];
      for (const patch of waiting) apply(patch);
    };
    const read = () => {
      if (reading) return;
      reading = true;
      companion("chat.open", { sessionId })
        .then(
          (opened) => {
            if (open) snapshot(opened.revision, opened.state);
          },
          () => undefined,
        )
        .finally(() => {
          reading = false;
        });
    };
    const apply = (patch: ChatPatch) => {
      if (revision === null) {
        early.push(patch);
        return;
      }
      if (patch.revision <= revision) return;
      // A gap means something was missed; read the chat again rather than guess.
      if (patch.revision !== revision + 1) {
        read();
        return;
      }
      revision = patch.revision;
      for (const op of patch.ops) if (op.op === "state") show(op.state);
    };
    // Listen first, so nothing sent between the read and its answer is missed.
    const release = miniHost.onCompanionEvent((message) => {
      if (message.event === "chat.snapshot" && message.data.sessionId === sessionId)
        snapshot(message.data.revision, message.data.state);
      else if (message.event === "chat.patch" && message.data.sessionId === sessionId)
        apply(message.data);
    });
    read();
    return () => {
      open = false;
      release();
      void companion("chat.close", { sessionId }).catch(() => undefined);
    };
  }, [enabled, sessionId]);
  return state?.sessionId === sessionId ? state.value : null;
}

/** Sends a follow-up to a chat: it waits behind a Run that is working, as the chat's own queue does. */
export const sendToChat = (sessionId: string, text: string) =>
  companion("chat.send", {
    sessionId,
    messageId: createUuidV7(),
    text,
    fileRefs: [],
    delivery: "queue",
  });

/** Stops the chat's current Run. */
export const stopChat = (sessionId: string, runId: string) =>
  companion("chat.stop", { sessionId, runId });
