import type { InboxDecision } from "@nodex/mobile-protocol";

import { useRootNavigation } from "../../navigation/types";
import { decideInbox, undoInbox } from "../../runtime";
import { lightTap } from "../../ui/primitives";
import { showFailure, showSnack } from "../../ui/snackbar";
import { decisionReversal } from "./inbox-presentation";

/**
 * Runs a decision, then offers what it allows next: the chat it started, or undo. A chat a message
 * starts opens through that message, which shows it starting and opens it once its host has.
 */
export const useDecide = () => {
  const navigation = useRootNavigation();
  return async (pageId: string, decision: InboxDecision, done: string): Promise<void> => {
    lightTap();
    try {
      const { undoToken, sessionId } = await decideInbox(pageId, decision);
      if (sessionId) {
        showSnack({
          text: done,
          action: {
            label: "Open",
            run: () =>
              decision.type === "accept" || decision.type === "start_chat"
                ? navigation.navigate("Message", { pageId: entryId, openChat: sessionId })
                : navigation.navigate("Chat", { sessionId }),
          },
        });
        return;
      }
      const reversal = decisionReversal(decision);
      const undo = undoToken
        ? () => undoInbox(undoToken)
        : reversal
          ? () => decideInbox(pageId, reversal)
          : null;
      showSnack({
        text: done,
        ...(undo
          ? {
              action: {
                label: "Undo",
                run: () => {
                  undo().catch((cause: unknown) => showFailure("Could not undo", cause));
                },
              },
            }
          : {}),
      });
    } catch (cause) {
      showFailure("That didn't go through", cause);
    }
  };
};
